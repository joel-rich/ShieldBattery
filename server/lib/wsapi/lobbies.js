import { List, Map, Record, Set } from 'immutable'
import errors from 'http-errors'
import { Mount, Api, registerApiRoutes } from '../websockets/api-decorators'
import validateBody from '../websockets/validate-body'
import activityRegistry from '../games/gameplay-activity-registry'
import gameLoader from '../games/game-loader'
import * as Lobbies from '../lobbies/lobby'
import * as Slots from '../lobbies/slot'
import { getMapInfo } from '../models/maps'
import createDeferred from '../../../common/async/deferred'
import {
  isValidLobbyName,
  isValidGameType,
  isValidGameSubType,
  validRace,
} from '../../../common/constants'
import {
  isUms,
  getLobbySlots,
  getLobbySlotsWithIndexes,
  getHumanSlots,
  findSlotByName,
  findSlotById,
  hasOpposingSides,
  getObserverTeam,
} from '../../../common/lobbies'
import swallowNonBuiltins from '../../../common/async/swallow-non-builtins'

const REMOVAL_TYPE_NORMAL = 0
const REMOVAL_TYPE_KICK = 1
const REMOVAL_TYPE_BAN = 2

const nonEmptyString = str => typeof str === 'string' && str.length > 0

const Countdown = new Record({
  timer: null,
})

const ListSubscription = new Record({
  onUnsubscribe: null,
  count: 0,
})

function checkSubTypeValidity(gameType, gameSubType = 0, numSlots) {
  if (gameType === 'topVBottom') {
    if (gameSubType < 1 || gameSubType > numSlots - 1) {
      throw new errors.BadRequest('Invalid game sub-type')
    }
  } else if (gameType === 'teamMelee' || gameType === 'teamFfa') {
    if (gameSubType < 2 || gameSubType > Math.min(4, numSlots)) {
      throw new errors.BadRequest('Invalid game sub-type')
    }
  }
}

const MOUNT_BASE = '/lobbies'

@Mount(MOUNT_BASE)
export class LobbyApi {
  constructor(nydus, userSockets, clientSockets) {
    this.nydus = nydus
    this.userSockets = userSockets
    this.clientSockets = clientSockets
    this.lobbies = new Map()
    this.lobbyClients = new Map()
    this.lobbyBannedUsers = new Map()
    this.lobbyCountdowns = new Map()
    this.loadingLobbies = new Map()
    this.subscribedSockets = new Map()
  }

  @Api('/subscribe')
  async subscribe(data, next) {
    const socket = data.get('client')
    if (this.subscribedSockets.has(socket.id)) {
      this.subscribedSockets = this.subscribedSockets.updateIn([socket.id, 'count'], c => c + 1)
      return
    }

    const summary = this.lobbies.valueSeq().map(l => Lobbies.toSummaryJson(l))
    this.nydus.subscribeClient(socket, MOUNT_BASE, { action: 'full', payload: summary })

    const onClose = () => {
      this.nydus.unsubscribeClient(socket, MOUNT_BASE)
      this.subscribedSockets = this.subscribedSockets.delete(socket.id)
    }
    socket.once('close', onClose)
    const subscription = new ListSubscription({
      onUnsubscribe: () => socket.removeListener('close', onClose),
      count: 1,
    })
    this.subscribedSockets = this.subscribedSockets.set(socket.id, subscription)
  }

  @Api('/unsubscribe')
  async unsubscribe(data, next) {
    const socket = data.get('client')
    if (!this.subscribedSockets.has(socket.id)) {
      throw new errors.Conflict('not subscribed')
    }

    const subscription = this.subscribedSockets.get(socket.id)
    if (subscription.count === 1) {
      this.nydus.unsubscribeClient(socket, MOUNT_BASE)
      this.subscribedSockets = this.subscribedSockets.delete(socket.id)
      subscription.onUnsubscribe()
    } else {
      this.subscribedSockets = this.subscribedSockets.updateIn([socket.id, 'count'], c => c - 1)
    }
  }

  @Api(
    '/create',
    validateBody({
      name: isValidLobbyName,
      map: nonEmptyString,
      gameType: isValidGameType,
      gameSubType: isValidGameSubType,
    }),
  )
  async create(data, next) {
    const { name, map, gameType, gameSubType } = data.get('body')
    const user = this.getUser(data)
    const client = this.getClient(data)

    if (this.lobbies.has(name)) {
      throw new errors.Conflict('already another lobby with that name')
    }

    const mapInfo = (await getMapInfo([map], user.session.userId))[0]
    if (!mapInfo) {
      throw new errors.BadRequest('invalid map')
    }
    checkSubTypeValidity(gameType, gameSubType, mapInfo.mapData.slots)

    let numSlots
    switch (gameType) {
      case 'oneVOne':
        // 1v1 mode always has 2 player slots
        numSlots = 2
        break
      case 'teamMelee':
      case 'teamFfa':
        // Team Melee and FFA always provide 8 player slots, divided amongst the teams evenly
        numSlots = 8
        break
      default:
        numSlots = mapInfo.mapData.slots
    }

    const lobby = Lobbies.create(
      name,
      mapInfo,
      gameType,
      gameSubType,
      numSlots,
      client.name,
      client.userId,
      undefined /* hostRace */,
      // TODO(#571): pass the allowObservers value from the request body instead
      false /* allowObservers */,
    )
    if (!activityRegistry.registerActiveClient(user.name, client)) {
      throw new errors.Conflict('user is already active in a gameplay activity')
    }

    this.lobbies = this.lobbies.set(name, lobby)
    this.lobbyClients = this.lobbyClients.set(client, name)
    this._subscribeClientToLobby(lobby, user, client)

    this._publishListChange('add', Lobbies.toSummaryJson(lobby))
  }

  @Api(
    '/join',
    validateBody({
      name: isValidLobbyName,
    }),
  )
  async join(data, next) {
    const { name } = data.get('body')
    const user = this.getUser(data)
    const client = this.getClient(data)

    if (!this.lobbies.has(name)) {
      throw new errors.NotFound('no lobby found with that name')
    }
    const lobby = this.lobbies.get(name)
    this.ensureLobbyNotTransient(lobby)

    if (
      this.lobbyBannedUsers.has(lobby.name) &&
      this.lobbyBannedUsers.get(lobby.name).includes(client.name)
    ) {
      throw new errors.Conflict('user has been banned from this lobby')
    }

    const [teamIndex, slotIndex, availableSlot] = Lobbies.findAvailableSlot(lobby)
    if (teamIndex < 0 || slotIndex < 0) {
      throw new errors.Conflict('lobby is full')
    }

    let player
    const [, observerTeam] = getObserverTeam(lobby)
    if (observerTeam && observerTeam.slots.find(s => s.id === availableSlot.id)) {
      player = Slots.createObserver(client.name)
    } else {
      player = isUms(lobby.gameType)
        ? Slots.createHuman(
            client.name,
            client.userId,
            availableSlot.race,
            true,
            availableSlot.playerId,
          )
        : Slots.createHuman(client.name, client.userId)
    }

    let updated = Lobbies.addPlayer(lobby, teamIndex, slotIndex, player)

    if (!activityRegistry.registerActiveClient(user.name, client)) {
      throw new errors.Conflict('user is already active in a gameplay activity')
    }

    // TODO(tec27): Fix map signing URL refreshing in a more general way, see #593
    const mapInfo = (await getMapInfo([lobby.map.id], lobby.host.userId))[0]
    updated = updated.set('map', mapInfo)

    this.lobbies = this.lobbies.set(name, updated)
    this.lobbyClients = this.lobbyClients.set(client, name)

    this._publishLobbyDiff(lobby, updated)
    this._subscribeClientToLobby(lobby, user, client)
  }

  _subscribeClientToLobby(lobby, user, client) {
    const lobbyName = lobby.name
    client.subscribe(
      LobbyApi._getPath(lobby),
      () => {
        const lobby = this.lobbies.get(lobbyName)
        return {
          type: 'init',
          lobby,
        }
      },
      client => this._removeClientFromLobby(this.lobbies.get(lobbyName), user.name),
    )
    user.subscribe(LobbyApi._getUserPath(lobby, user.name), () => {
      return {
        type: 'status',
        lobby: Lobbies.toSummaryJson(lobby),
      }
    })
    client.subscribe(LobbyApi._getClientPath(lobby, client))
  }

  @Api(
    '/sendChat',
    validateBody({
      text: nonEmptyString,
    }),
  )
  async sendChat(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    const time = Date.now()
    let { text } = data.get('body')

    if (text.length > 500) {
      text = text.slice(0, 500)
    }

    this._publishTo(lobby, {
      type: 'chat',
      time,
      from: client.name,
      text,
    })
  }

  @Api(
    '/addComputer',
    validateBody({
      slotId: nonEmptyString,
    }),
  )
  async addComputer(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    const [, , player] = findSlotByName(lobby, client.name)
    this.ensureIsLobbyHost(lobby, player)
    this.ensureLobbyNotTransient(lobby)

    if (isUms(lobby.gameType)) {
      throw new errors.BadRequest('invalid game type: ' + lobby.gameType)
    }

    const { slotId } = data.get('body')
    const [teamIndex, slotIndex, slotToAddComputer] = findSlotById(lobby, slotId)
    if (!slotToAddComputer) {
      throw new errors.BadRequest('invalid id')
    }
    if (slotToAddComputer.type !== 'open' && slotToAddComputer.type !== 'closed') {
      throw new errors.BadRequest('invalid slot type')
    }

    const computer = Slots.createComputer()
    const updated = Lobbies.addPlayer(lobby, teamIndex, slotIndex, computer)
    this.lobbies = this.lobbies.set(lobby.name, updated)
    this._publishLobbyDiff(lobby, updated)
  }

  @Api(
    '/changeSlot',
    validateBody({
      slotId: nonEmptyString,
    }),
  )
  async changeSlot(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    this.ensureLobbyNotTransient(lobby)
    const [sourceTeamIndex, sourceSlotIndex, sourceSlot] = findSlotByName(lobby, client.name)

    const { slotId } = data.get('body')
    const [destTeamIndex, destSlotIndex, destSlot] = findSlotById(lobby, slotId)
    if (!destSlot) {
      throw new errors.BadRequest('invalid id')
    }
    if (destSlot.type !== 'open' && destSlot.type !== 'controlledOpen') {
      throw new errors.BadRequest('invalid destination slot type')
    }
    if (sourceSlot === destSlot) {
      throw new errors.Conflict('already in that slot')
    }

    let updated
    try {
      updated = Lobbies.movePlayerToSlot(
        lobby,
        sourceTeamIndex,
        sourceSlotIndex,
        destTeamIndex,
        destSlotIndex,
      )
    } catch (err) {
      throw new errors.BadRequest(err.message)
    }
    this.lobbies = this.lobbies.set(lobby.name, updated)
    this._publishLobbyDiff(lobby, updated)
  }

  @Api(
    '/setRace',
    validateBody({
      id: nonEmptyString,
      race: validRace,
    }),
  )
  async setRace(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    this.ensureLobbyNotLoading(lobby)
    const [, , player] = findSlotByName(lobby, client.name)

    const { id, race } = data.get('body')
    const [teamIndex, slotIndex, slotToSetRace] = findSlotById(lobby, id)
    if (!slotToSetRace) {
      throw new errors.BadRequest('invalid id')
    }
    if (
      slotToSetRace.type !== 'computer' &&
      slotToSetRace.type !== 'human' &&
      slotToSetRace.type !== 'controlledOpen' &&
      slotToSetRace.type !== 'controlledClosed'
    ) {
      throw new errors.BadRequest('invalid slot type')
    }

    if (slotToSetRace.type === 'computer') {
      this.ensureIsLobbyHost(lobby, player)
    } else if (slotToSetRace.controlledBy) {
      if (slotToSetRace.controlledBy !== player.id) {
        throw new errors.Forbidden('must control a slot to set its race')
      }
    } else if (slotToSetRace.id !== player.id) {
      throw new errors.Forbidden("cannot set other user's races")
    } else if (slotToSetRace.hasForcedRace) {
      throw new errors.Forbidden('this slot has a forced race and cannot be changed')
    }

    const updatedLobby = Lobbies.setRace(lobby, teamIndex, slotIndex, race)
    this.lobbies = this.lobbies.set(lobby.name, updatedLobby)
    this._publishLobbyDiff(lobby, updatedLobby)
  }

  @Api(
    '/openSlot',
    validateBody({
      slotId: nonEmptyString,
    }),
  )
  async openSlot(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    const [, , player] = findSlotByName(lobby, client.name)
    this.ensureIsLobbyHost(lobby, player)
    this.ensureLobbyNotTransient(lobby)

    const { slotId } = data.get('body')
    const [teamIndex, slotIndex, slotToOpen] = findSlotById(lobby, slotId)
    if (!slotToOpen) {
      throw new errors.BadRequest('invalid slot id')
    }
    if (
      slotToOpen.type === 'open' ||
      slotToOpen.type === 'controlledOpen' ||
      slotToOpen.type === 'umsComputer'
    ) {
      throw new errors.BadRequest('invalid slot type')
    }

    let updated
    try {
      updated = Lobbies.openSlot(lobby, teamIndex, slotIndex)
    } catch (err) {
      throw new errors.BadRequest(err.message)
    }

    this.lobbies = this.lobbies.set(lobby.name, updated)
    this._publishLobbyDiff(lobby, updated)
  }

  @Api(
    '/closeSlot',
    validateBody({
      slotId: nonEmptyString,
    }),
  )
  async closeSlot(data, next) {
    const user = this.getUser(data)
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    const [, , player] = findSlotByName(lobby, client.name)
    this.ensureIsLobbyHost(lobby, player)
    this.ensureLobbyNotTransient(lobby)

    const { slotId } = data.get('body')
    const [teamIndex, slotIndex, slotToClose] = findSlotById(lobby, slotId)
    if (!slotToClose) {
      throw new errors.BadRequest('invalid slot id')
    }

    if (
      slotToClose.type === 'closed' ||
      slotToClose.type === 'controlledClosed' ||
      slotToClose.type === 'umsComputer'
    ) {
      throw new errors.BadRequest('invalid slot type')
    }

    if (
      slotToClose.type === 'human' ||
      slotToClose.type === 'computer' ||
      slotToClose.type === 'observer'
    ) {
      this._kickPlayerFromLobby(lobby, user, teamIndex, slotIndex, slotToClose)
    }
    const afterKick = this.lobbies.get(lobby.name)

    let updated
    try {
      updated = Lobbies.closeSlot(afterKick, teamIndex, slotIndex)
    } catch (err) {
      throw new errors.BadRequest(err.message)
    }
    this.lobbies = this.lobbies.set(lobby.name, updated)
    this._publishLobbyDiff(afterKick, updated)
  }

  @Api('/kickPlayer')
  async kickPlayer(data, next) {
    const user = this.getUser(data)
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    const [, , player] = findSlotByName(lobby, client.name)
    this.ensureIsLobbyHost(lobby, player)
    this.ensureLobbyNotTransient(lobby)

    const { slotId } = data.get('body')
    const [teamIndex, slotIndex, playerToKick] = findSlotById(lobby, slotId)
    if (!playerToKick) {
      throw new errors.BadRequest('invalid slot id')
    }
    if (
      playerToKick.type !== 'human' &&
      playerToKick.type !== 'computer' &&
      playerToKick.type !== 'observer'
    ) {
      throw new errors.BadRequest('invalid slot type')
    }

    this._kickPlayerFromLobby(lobby, user, teamIndex, slotIndex, playerToKick)
  }

  _kickPlayerFromLobby(lobby, user, teamIndex, slotIndex, playerToKick) {
    if (playerToKick.type === 'computer') {
      const updated = Lobbies.removePlayer(lobby, teamIndex, slotIndex, playerToKick)
      this.lobbies = this.lobbies.set(lobby.name, updated)
      this._publishLobbyDiff(lobby, updated)
    } else if (playerToKick.type === 'human' || playerToKick.type === 'observer') {
      this._removeClientFromLobby(lobby, playerToKick.name, REMOVAL_TYPE_KICK)
    }
  }

  @Api('/banPlayer')
  async banPlayer(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    const [, , player] = findSlotByName(lobby, client.name)
    this.ensureIsLobbyHost(lobby, player)
    this.ensureLobbyNotTransient(lobby)

    const { slotId } = data.get('body')
    const [, , playerToBan] = findSlotById(lobby, slotId)
    if (!playerToBan) {
      throw new errors.BadRequest('invalid slot id')
    }
    if (playerToBan.type !== 'human') {
      throw new errors.BadRequest('invalid slot type')
    }

    this.lobbyBannedUsers = this.lobbyBannedUsers.update(lobby.name, new List(), val =>
      val.push(playerToBan.name),
    )

    this._removeClientFromLobby(lobby, playerToBan.name, REMOVAL_TYPE_BAN)
  }

  @Api('/makeObserver')
  async makeObserver(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    const [, , player] = findSlotByName(lobby, client.name)
    this.ensureIsLobbyHost(lobby, player)
    this.ensureLobbyNotTransient(lobby)

    const { slotId } = data.get('body')
    const [teamIndex, slotIndex, slot] = findSlotById(lobby, slotId)
    if (!slot) {
      throw new errors.BadRequest('invalid slot id')
    }

    let updated
    try {
      updated = Lobbies.makeObserver(lobby, teamIndex, slotIndex)
    } catch (err) {
      throw new errors.BadRequest(err.message)
    }
    this.lobbies = this.lobbies.set(lobby.name, updated)
    this._publishLobbyDiff(lobby, updated, undefined, undefined, slotIndex)
  }

  @Api('/removeObserver')
  async removeObserver(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    const [, , player] = findSlotByName(lobby, client.name)
    this.ensureIsLobbyHost(lobby, player)
    this.ensureLobbyNotTransient(lobby)

    const { slotId } = data.get('body')
    const [teamIndex, slotIndex, slot] = findSlotById(lobby, slotId)
    if (!slot) {
      throw new errors.BadRequest('invalid slot id')
    }
    if (!lobby.teams.get(teamIndex).isObserver) {
      throw new errors.BadRequest('Slot is not in the observer team')
    }

    let updated
    try {
      updated = Lobbies.removeObserver(lobby, slotIndex)
    } catch (err) {
      throw new errors.BadRequest(err.message)
    }
    this.lobbies = this.lobbies.set(lobby.name, updated)
    this._publishLobbyDiff(lobby, updated, undefined, undefined, slotIndex)
  }

  @Api('/leave')
  async leave(data, next) {
    const user = this.getUser(data)
    const client = this.getActiveClientForUser(user.name)
    const lobby = this.getLobbyForClient(client)
    this._removeClientFromLobby(lobby, user.name)
  }

  _removeClientFromLobby(lobby, userName, removalType = REMOVAL_TYPE_NORMAL) {
    const user = this.getUserByName(userName)
    const client = this.getActiveClientForUser(userName)

    const [teamIndex, slotIndex, player] = findSlotByName(lobby, userName)
    const updatedLobby = Lobbies.removePlayer(lobby, teamIndex, slotIndex, player)

    if (!updatedLobby) {
      // Ensure the client's local state gets updated to confirm the leave
      this._publishTo(lobby, {
        type: 'leave',
        player,
      })
      this.lobbies = this.lobbies.delete(lobby.name)
      this.lobbyBannedUsers = this.lobbyBannedUsers.delete(lobby.name)
      this._publishListChange('delete', lobby.name)
    } else {
      this.lobbies = this.lobbies.set(lobby.name, updatedLobby)
      this._publishLobbyDiff(
        lobby,
        updatedLobby,
        removalType === REMOVAL_TYPE_KICK ? userName : null,
        removalType === REMOVAL_TYPE_BAN ? userName : null,
      )
    }
    this.lobbyClients = this.lobbyClients.delete(client)
    activityRegistry.unregisterClientForUser(userName)

    this._publishToUser(lobby, userName, {
      type: 'status',
      lobby: null,
    })

    this._maybeCancelCountdown(lobby)
    // Send the leaving user a message to cancel the loading, before we unsubscribe them from the
    // lobby routes.
    if (this.loadingLobbies.has(lobby.name)) {
      this._publishToUser(lobby, userName, {
        type: 'cancelLoading',
      })
    }

    user.unsubscribe(LobbyApi._getUserPath(lobby, userName))
    client.unsubscribe(LobbyApi._getClientPath(lobby, client))
    client.unsubscribe(LobbyApi._getPath(lobby))
  }

  @Api('/startCountdown')
  async startCountdown(data, next) {
    const client = this.getClient(data)
    const lobby = this.getLobbyForClient(client)
    if (!hasOpposingSides(lobby)) {
      throw new errors.BadRequest('must have at least 2 opposing sides')
    }

    const [, , player] = findSlotByName(lobby, client.name)
    this.ensureIsLobbyHost(lobby, player)
    this.ensureLobbyNotTransient(lobby)

    const lobbyName = lobby.name
    const countdownTimer = createDeferred()
    countdownTimer.catch(swallowNonBuiltins)

    let countdownTimerId = setTimeout(() => countdownTimer.resolve(), 5000)
    this.lobbyCountdowns = this.lobbyCountdowns.set(
      lobbyName,
      new Countdown({ timer: countdownTimer }),
    )

    this._publishTo(lobby, { type: 'startCountdown' })
    this._publishListChange('delete', lobby.name)

    const gameConfig = {
      gameType: lobby.gameType,
      gameSubType: lobby.gameSubType,
      teams: lobby.teams
        .map(team =>
          team.slots
            .filter(s => s.type === 'human' || s.type === 'computer' || s.type === 'umsComputer')
            .map(s => ({
              name: s.name,
              race: s.race,
              isComputer: s.type === 'computer' || s.type === 'umsComputer',
            }))
            .toArray(),
        )
        .toArray(),
    }

    let allowStartTimerId
    try {
      let gameId
      const gameLoaded = gameLoader.loadGame({
        players: getHumanSlots(lobby),
        mapId: lobby.map.id,
        gameSource: 'LOBBY',
        gameConfig,
        onGameSetup: (setup, resultCodes) => {
          gameId = setup.gameId
          this._onGameSetup(lobby, setup, resultCodes)
        },
        onRoutesSet: (playerName, routes, forGameId) => {
          gameId = forGameId
          this._onRoutesSet(lobby, playerName, routes, forGameId)
        },
      })

      countdownTimer
        .then(() => {
          // Have some leeway after the countdown finishes and before allowing the game to start so
          // we can, for example, show the loading screen for some minimum amount of time
          allowStartTimerId = setTimeout(() => {
            this._publishTo(lobby, {
              type: 'allowStart',
              gameId,
            })
          }, 2000)
          this.lobbyCountdowns = this.lobbyCountdowns.delete(lobbyName)
        })
        .catch(swallowNonBuiltins)

      await Promise.all([countdownTimer, gameLoaded])
      this._onGameLoaded(lobby)
    } catch (err) {
      // TODO(tec27): Ideally we'd log this error somewhere if it's not something we're expecting
      this._maybeCancelCountdown(lobby)
      this._onLoadingCanceled(lobby)
    } finally {
      if (countdownTimerId) {
        clearTimeout(countdownTimerId)
        countdownTimerId = null
      }
      if (allowStartTimerId) {
        clearTimeout(allowStartTimerId)
        allowStartTimerId = null
      }
    }
  }

  _onGameSetup(lobby, setup = {}, resultCodes) {
    this.loadingLobbies = this.loadingLobbies.set(lobby.name, setup.gameId)
    const players = getHumanSlots(lobby).map(s => s.name)
    for (const player of players) {
      this._publishToClient(lobby, player, {
        type: 'setupGame',
        setup,
        resultCode: resultCodes.get(player),
      })
    }
  }

  _onRoutesSet(lobby, playerName, routes, gameId) {
    this._publishToClient(lobby, playerName, {
      type: 'setRoutes',
      routes,
      gameId,
    })
  }

  _onLoadingCanceled(lobby) {
    this.loadingLobbies = this.loadingLobbies.delete(lobby.name)
    this._publishTo(lobby, {
      type: 'cancelLoading',
    })
    this._publishListChange('add', Lobbies.toSummaryJson(lobby))
  }

  _onGameLoaded(lobby) {
    this._publishTo(lobby, { type: 'gameStarted' })

    getHumanSlots(lobby)
      .map(p => activityRegistry.getClientForUser(p.name))
      .forEach(client => {
        const user = this.getUserByName(client.name)
        this._publishToUser(lobby, user.name, {
          type: 'status',
          lobby: null,
        })
        user.unsubscribe(LobbyApi._getUserPath(lobby, user.name))
        client.unsubscribe(LobbyApi._getPath(lobby))
        client.unsubscribe(LobbyApi._getClientPath(lobby, client))
        this.lobbyClients = this.lobbyClients.delete(client)
        activityRegistry.unregisterClientForUser(user.name)
      })
    this.lobbies = this.lobbies.delete(lobby.name)
    this.loadingLobbies = this.loadingLobbies.delete(lobby.name)
  }

  // Cancels the countdown if one was occurring (no-op if it was not)
  _maybeCancelCountdown(lobby) {
    if (!this.lobbyCountdowns.has(lobby.name)) {
      return
    }

    const countdown = this.lobbyCountdowns.get(lobby.name)
    countdown.timer.reject(new Error('Countdown cancelled'))
    this.lobbyCountdowns = this.lobbyCountdowns.delete(lobby.name)
    this._publishTo(lobby, {
      type: 'cancelCountdown',
    })
    this._publishListChange('add', Lobbies.toSummaryJson(lobby))
  }

  @Api(
    '/getLobbyState',
    validateBody({
      lobbyName: nonEmptyString,
    }),
  )
  async getLobbyState(data, next) {
    this.getClient(data)
    const { lobbyName } = data.get('body')

    let lobbyState
    if (!this.lobbies.has(lobbyName)) {
      lobbyState = 'nonexistent'
    } else {
      lobbyState = 'exists'
      if (this.lobbyCountdowns.has(lobbyName)) {
        lobbyState = 'countingDown'
      } else if (this.loadingLobbies.has(lobbyName)) {
        lobbyState = 'hasStarted'
      }
    }

    return { lobbyName, lobbyState }
  }

  getUser(data) {
    const user = this.userSockets.getBySocket(data.get('client'))
    if (!user) throw new errors.Unauthorized('authorization required')
    return user
  }

  getUserByName(name) {
    const user = this.userSockets.getByName(name)
    if (!user) throw new errors.BadRequest('user not online')
    return user
  }

  getActiveClientForUser(name) {
    const client = activityRegistry.getClientForUser(name)
    if (!client) throw new errors.BadRequest('no active client for user')
    return client
  }

  getClient(data) {
    const client = this.clientSockets.getCurrentClient(data.get('client'))
    if (!client) throw new errors.Unauthorized('authorization required')
    return client
  }

  getLobbyForClient(client) {
    if (!this.lobbyClients.has(client)) {
      throw new errors.BadRequest('must be in a lobby')
    }
    return this.lobbies.get(this.lobbyClients.get(client))
  }

  ensureIsLobbyHost(lobby, player) {
    if (player.id !== lobby.host.id) {
      throw new errors.Unauthorized('must be a lobby host')
    }
  }

  ensureLobbyNotLoading(lobby) {
    if (this.loadingLobbies.has(lobby.name)) {
      throw new errors.Conflict('lobby has already started')
    }
  }

  // Ensures that the lobby is not in a 'transient' state, that is, a state between being a lobby
  // and being an active game (counting down, loading, etc.). Transient states can be rolled back
  // (bringing the lobby back to a non-transient state)
  ensureLobbyNotTransient(lobby) {
    if (this.lobbyCountdowns.has(lobby.name)) {
      throw new errors.Conflict('lobby is counting down')
    }
    if (this.loadingLobbies.has(lobby.name)) {
      throw new errors.Conflict('lobby has already started')
    }
  }

  _publishListChange(action, summary) {
    this.nydus.publish(MOUNT_BASE, { action, payload: summary })
  }

  _publishTo(lobby, data) {
    this.nydus.publish(LobbyApi._getPath(lobby), data)
  }

  _publishToUser(lobby, username, data) {
    this.nydus.publish(LobbyApi._getUserPath(lobby, username), data)
  }

  _publishToClient(lobby, username, data) {
    const client = this.getActiveClientForUser(username)
    this.nydus.publish(LobbyApi._getClientPath(lobby, client), data)
  }

  _publishLobbyDiff(oldLobby, newLobby, kickedUser = null, bannedUser = null, deletedSlotIndex) {
    if (oldLobby === newLobby) return

    const diffEvents = []
    if (newLobby.host.id !== oldLobby.host.id) {
      diffEvents.push({
        type: 'hostChange',
        host: newLobby.host,
      })
    }

    const oldSlots = new Set(getLobbySlots(oldLobby).map(oldSlot => oldSlot.id))
    const newSlots = new Set(getLobbySlots(newLobby).map(newSlot => newSlot.id))
    const oldHumans = new Set(getHumanSlots(oldLobby).map(oldHuman => oldHuman.id))
    const same = oldSlots.intersect(newSlots)
    const left = oldHumans.subtract(same)
    const created = newSlots.subtract(same)

    const oldIdSlots = new Map(
      getLobbySlotsWithIndexes(oldLobby).map(([teamIndex, slotIndex, slot]) => [
        slot.id,
        [teamIndex, slotIndex, slot],
      ]),
    )
    const newIdSlots = new Map(
      getLobbySlotsWithIndexes(newLobby).map(([teamIndex, slotIndex, slot]) => [
        slot.id,
        [teamIndex, slotIndex, slot],
      ]),
    )

    for (const id of left.values()) {
      // These are the human slots that have left the lobby or were removed. Note that every `leave`
      // operation also triggers a `slotCreate` operation, which means that we don't have to set
      // slots on the client-side in response to this operation (since they'll be overriden in the
      // `slotCreate` operation below anyways). This also means we only care about `human` slots
      // leaving just so we can display appropriate message in the lobby.
      const [, , player] = oldIdSlots.get(id)
      if (kickedUser === player.name) {
        diffEvents.push({
          type: 'kick',
          player,
        })
      } else if (bannedUser === player.name) {
        diffEvents.push({
          type: 'ban',
          player,
        })
      } else {
        diffEvents.push({
          type: 'leave',
          player,
        })
      }
    }

    // Check for deleted slots caused by obs slot creation/removal.
    // In order for things on client to work properly, we need to tell them exactly *which* slot was
    // deleted, which seems to be impossible to figure out just by comparing lobby diffs. So in a
    // similar fashion as we do when determining if the user was kicked/banned, we pass the slot
    // index of a deleted slot from the method that knows which slot it is
    for (let teamIndex = 0; teamIndex < oldLobby.teams.size; teamIndex += 1) {
      const oldTeam = oldLobby.teams.get(teamIndex)
      const newTeam = newLobby.teams.get(teamIndex)
      if (oldTeam.slots.size > newTeam.slots.size) {
        diffEvents.push({
          type: 'slotDeleted',
          teamIndex,
          slotIndex: deletedSlotIndex,
        })
      }
    }

    for (const id of created.values()) {
      // These are all of the slots that were created in the new lobby compared to the old one. This
      // includes the slots that were created as a result of players leaving the lobby, moving to a
      // different slot, open/closing a slot, etc.
      const [teamIndex, slotIndex, slot] = newIdSlots.get(id)
      diffEvents.push({
        type: 'slotCreate',
        teamIndex,
        slotIndex,
        slot,
      })
    }

    for (const id of same.values()) {
      const [oldTeamIndex, oldSlotIndex, oldSlot] = oldIdSlots.get(id)
      const [newTeamIndex, newSlotIndex, newSlot] = newIdSlots.get(id)

      const samePlace = oldTeamIndex === newTeamIndex && oldSlotIndex === newSlotIndex
      if (samePlace && oldSlot === newSlot) continue

      if (!samePlace && oldSlot.id === newSlot.id) {
        diffEvents.push({
          type: 'slotChange',
          teamIndex: newTeamIndex,
          slotIndex: newSlotIndex,
          player: newSlot,
        })
      }
      if (samePlace && oldSlot.race !== newSlot.race) {
        diffEvents.push({
          type: 'raceChange',
          teamIndex: newTeamIndex,
          slotIndex: newSlotIndex,
          newRace: newSlot.race,
        })
      }
    }

    if (diffEvents.length) {
      this._publishTo(newLobby, {
        type: 'diff',
        diffEvents,
      })
    }

    this._publishListChange('update', Lobbies.toSummaryJson(newLobby))
  }

  static _getPath(lobby) {
    return `${MOUNT_BASE}/${encodeURIComponent(lobby.name)}`
  }

  static _getUserPath(lobby, username) {
    return `${MOUNT_BASE}/${encodeURIComponent(lobby.name)}/${encodeURIComponent(username)}`
  }

  static _getClientPath(lobby, client) {
    return `${MOUNT_BASE}/${encodeURIComponent(lobby.name)}/${client.userId}/${client.clientId}`
  }
}

export default function registerApi(nydus, userSockets, clientSockets) {
  const api = new LobbyApi(nydus, userSockets, clientSockets)
  registerApiRoutes(api, nydus)
  return api
}
