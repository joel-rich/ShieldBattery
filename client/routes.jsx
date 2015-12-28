import React from 'react'
import { Route } from 'react-router'
import AppNotFound from './app-not-found.jsx'
import ChatChannel from './chat/channel.jsx'
import MainLayout from './main-layout.jsx'
import Home from './home.jsx'
import LoginRequired from './auth/login-required.jsx'
import LoginLayout from './auth/login-layout.jsx'
import Login from './auth/login.jsx'
import Signup from './auth/signup.jsx'

const routes = <Route>
  <Route component={LoginRequired}>
    <Route component={MainLayout}>
      <Route path='/' component={Home} />
      <Route path='/chat/:channel' component={ChatChannel} />
    </Route>
  </Route>
  <Route component={LoginLayout}>
    <Route path='/login' component={Login} />
    <Route path='/signup' component={Signup} />
  </Route>
  <Route path='*' component={AppNotFound} />
</Route>

export default routes
