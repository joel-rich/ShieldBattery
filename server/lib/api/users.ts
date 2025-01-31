import Router, { RouterContext } from '@koa/router'
import bcrypt from 'bcrypt'
import cuid from 'cuid'
import httpErrors from 'http-errors'
import { NydusServer } from 'nydus'
import { container } from 'tsyringe'
import { isValidEmail, isValidPassword, isValidUsername } from '../../../common/constants'
import { SelfUserInfo } from '../../../common/users/user-info'
import { UNIQUE_VIOLATION } from '../db/pg-error-codes'
import transact from '../db/transaction'
import sendMail from '../mail/mailer'
import {
  addEmailVerificationCode,
  consumeEmailVerificationCode,
  getEmailVerificationsCount,
} from '../models/email-verifications'
import { usePasswordResetCode } from '../models/password-resets'
import { checkAnyPermission } from '../permissions/check-permissions'
import ensureLoggedIn from '../session/ensure-logged-in'
import initSession from '../session/init'
import updateAllSessions from '../session/update-all-sessions'
import createThrottle from '../throttle/create-throttle'
import throttleMiddleware from '../throttle/middleware'
import {
  attemptLogin,
  createUser as dbCreateUser,
  findSelfById,
  findUserById,
  findUserByName,
  updateUser as dbUpdateUser,
  UserUpdatables,
} from '../users/user-model'

const accountCreationThrottle = createThrottle('accountcreation', {
  rate: 1,
  burst: 4,
  window: 60000,
})

const accountUpdateThrottle = createThrottle('accountupdate', {
  rate: 10,
  burst: 20,
  window: 60000,
})

const emailVerificationThrottle = createThrottle('emailverification', {
  rate: 10,
  burst: 20,
  window: 12 * 60 * 60 * 1000,
})

const sendVerificationThrottle = createThrottle('sendverification', {
  rate: 4,
  burst: 4,
  window: 12 * 60 * 60 * 1000,
})

export default function (router: Router) {
  router
    .post(
      '/',
      throttleMiddleware(accountCreationThrottle, ctx => ctx.ip),
      createUser,
    )
    .get('/:searchTerm', checkAnyPermission('banUsers', 'editPermissions'), find)
    .patch(
      '/:id',
      ensureLoggedIn,
      throttleMiddleware(accountUpdateThrottle, ctx => String(ctx.session!.userId)),
      updateUser,
    )
    .post('/:username/password', resetPassword)
    .post(
      '/emailVerification',
      ensureLoggedIn,
      throttleMiddleware(emailVerificationThrottle, ctx => String(ctx.session!.userId)),
      verifyEmail,
    )
    .post(
      '/sendVerification',
      ensureLoggedIn,
      throttleMiddleware(sendVerificationThrottle, ctx => String(ctx.session!.userId)),
      sendVerificationEmail,
    )
}

async function find(ctx: RouterContext) {
  const searchTerm = ctx.params.searchTerm

  try {
    // TODO(tec27): Admins might want more info than just this, maybe we should make a function to
    // retrieve that specially?
    const user = await findUserByName(searchTerm)
    ctx.body = user ? [user] : []
  } catch (err) {
    throw err
  }
}

function hashPass(password: string): Promise<string> {
  return bcrypt.hash(password, 10 /* saltRounds */)
}

async function createUser(ctx: RouterContext) {
  const { username, password } = ctx.request.body
  const email = ctx.request.body.email.trim()

  if (!isValidUsername(username) || !isValidEmail(email) || !isValidPassword(password)) {
    throw new httpErrors.BadRequest('Invalid parameters')
  }

  const hashedPassword = await hashPass(password)

  let result: SelfUserInfo
  try {
    result = await dbCreateUser({ name: username, email, hashedPassword, ipAddress: ctx.ip })
  } catch (err) {
    if (err.code && err.code === UNIQUE_VIOLATION) {
      throw new httpErrors.Conflict('A user with that name already exists')
    }
    throw err
  }

  // regenerate the session to ensure that logged in sessions and anonymous sessions don't
  // share a session ID
  await ctx.regenerateSession()
  initSession(ctx, result.user, result.permissions)

  const code = cuid()
  await addEmailVerificationCode(result.user.id, email, code, ctx.ip)
  // No need to await for this
  sendMail({
    to: email,
    subject: 'ShieldBattery Email Verification',
    templateName: 'email-verification',
    templateData: { token: code },
  }).catch(err => ctx.log.error({ err, req: ctx.req }, 'Error sending email verification email'))

  ctx.body = result
}

async function updateUser(ctx: RouterContext) {
  const { id: idString } = ctx.params
  const { currentPassword, newPassword, newEmail } = ctx.request.body

  const id = Number(idString)
  if (!id || isNaN(id)) {
    throw new httpErrors.BadRequest('Invalid parameters')
  } else if (ctx.session!.userId !== id) {
    throw new httpErrors.Unauthorized("Can't change another user's account")
  } else if (newPassword && !isValidPassword(newPassword)) {
    throw new httpErrors.BadRequest('Invalid parameters')
  } else if (newEmail && !isValidEmail(newEmail)) {
    throw new httpErrors.BadRequest('Invalid parameters')
  }

  // TODO(tec27): Updating certain things (e.g. title) might not need to require confirming the
  // current password, but maybe that should just be a different API
  if (!newPassword && !newEmail) {
    ctx.status = 204
    return
  }

  if (!isValidPassword(currentPassword)) {
    throw new httpErrors.BadRequest('Invalid parameters')
  }

  const userInfo = await findUserById(id)
  if (!userInfo) {
    throw new httpErrors.Unauthorized('Incorrect user ID or password')
  }

  const oldUser = await attemptLogin(userInfo.name, currentPassword)
  if (!oldUser) {
    throw new httpErrors.Unauthorized('Incorrect user ID or password')
  }

  const oldEmail = oldUser.email

  const updates: Partial<UserUpdatables> = {}

  if (newPassword) {
    updates.password = await hashPass(newPassword)
  }
  if (newEmail) {
    updates.email = newEmail
    updates.emailVerified = false
  }
  const user = await dbUpdateUser(oldUser.id, updates)
  if (!user) {
    // NOTE(tec27): We want this to be a 5xx because this is a very unusual case, since we just
    // looked this user up above
    throw new Error("User couldn't be found")
  }

  // No need to await this before sending response to the user
  if (newPassword) {
    sendMail({
      to: user.email,
      subject: 'ShieldBattery Password Changed',
      templateName: 'password-change',
      templateData: { username: user.name },
    }).catch(err => ctx.log.error({ err, req: ctx.req }, 'Error sending password changed email'))
  }
  if (newEmail) {
    sendMail({
      to: oldEmail,
      subject: 'ShieldBattery Email Changed',
      templateName: 'email-change',
      templateData: { username: user.name },
    }).catch(err => ctx.log.error({ err, req: ctx.req }, 'Error sending email changed email'))

    const emailVerificationCode = cuid()
    await addEmailVerificationCode(user.id, user.email, emailVerificationCode, ctx.ip)
    await updateAllSessions(ctx, { emailVerified: false })

    sendMail({
      to: user.email,
      subject: 'ShieldBattery Email Verification',
      templateName: 'email-verification',
      templateData: { token: emailVerificationCode },
    }).catch(err => ctx.log.error({ err }, 'Error sending email verification email'))
  }

  ctx.body = user
}

async function resetPassword(ctx: RouterContext) {
  // TODO(tec27): This request should probably be for a user ID
  const { username } = ctx.params
  const { code } = ctx.query
  const { password } = ctx.request.body

  if (!code || !isValidUsername(username) || !isValidPassword(password)) {
    throw new httpErrors.BadRequest('Invalid parameters')
  }

  await transact(async client => {
    try {
      await usePasswordResetCode(client, username, code)
    } catch (err) {
      throw new httpErrors.BadRequest('Password reset code is invalid')
    }

    const user = await findUserByName(username)
    if (!user) {
      throw new httpErrors.Conflict('User not found')
    }

    await dbUpdateUser(user.id, { password: await hashPass(password) })
    ctx.status = 204
  })
}

async function verifyEmail(ctx: RouterContext) {
  const { code } = ctx.query

  if (!code) {
    throw new httpErrors.BadRequest('Invalid parameters')
  }

  const user = await findSelfById(ctx.session!.userId)
  if (!user) {
    throw new httpErrors.BadRequest('User not found')
  }

  const emailVerified = await consumeEmailVerificationCode(user.id, user.email, code)
  if (!emailVerified) {
    throw new httpErrors.BadRequest('Email verification code is invalid')
  }

  // Update all of the user's sessions to indicate that their email is now indeed verified.
  await updateAllSessions(ctx, { emailVerified: true })

  // Last thing to do is to notify all of the user's opened sockets that their email is now verified
  // NOTE(2Pac): With the way the things are currently set up on client (their socket is not
  // connected when they open the email verification page), the client making the request won't
  // actually get this event. Thankfully, that's easy to deal with on the client-side.
  const nydus = container.resolve(NydusServer)
  nydus.publish('/userProfiles/' + ctx.session!.userId, { action: 'emailVerified' })
  // TODO(tec27): get the above path from UserSocketsGroup instead of just concat'ing things
  // together here

  ctx.status = 204
}

async function sendVerificationEmail(ctx: RouterContext) {
  const user = await findSelfById(ctx.session!.userId)
  if (!user) {
    throw new httpErrors.BadRequest('User not found')
  }

  const emailVerificationsCount = await getEmailVerificationsCount(user.id, user.email)
  if (emailVerificationsCount > 10) {
    throw new httpErrors.Conflict('Email is over verification limit')
  }

  const code = cuid()
  await addEmailVerificationCode(user.id, user.email, code, ctx.ip)
  // No need to await for this
  sendMail({
    to: user.email,
    subject: 'ShieldBattery Email Verification',
    templateName: 'email-verification',
    templateData: { token: code },
  }).catch(err => ctx.log.error({ err }, 'Error sending email verification email'))

  ctx.status = 204
}
