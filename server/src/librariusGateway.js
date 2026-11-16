/**
 * The Librarius's connection to Discord's gateway, over the WebSocket the runtime gives us: the live feed of what
 * happens in the forum, which the live-event handler turns into changes to the store.
 *
 * createGateway({ discord, botToken, intents, onDispatch, WebSocketImpl, timers, random, log, helloTimeoutMs,
 *   readyTimeoutMs, dispatchTimeoutMs, identifyFloor })
 *   → { start(), stop(), status() → { state, lastReadyAt, lastError } }
 *
 * discord.gatewayBot() says where to connect and how many new sessions are left. onDispatch(t, d) is called, and
 * awaited, for every dispatch (READY and RESUMED included), one at a time and in the order Discord sent them. An
 * onDispatch that throws or rejects is recorded and never stops the connection. A missing or wrong option is a
 * TypeError or RangeError here, since a client that cannot connect would only retry forever.
 *
 * A socket that has not said HELLO within helloTimeoutMs (30 seconds) of being made is taken to be dead, and is dropped
 * like any other; so is one that has not been made ready, by READY or RESUMED, within readyTimeoutMs (30 seconds) of
 * its IDENTIFY or RESUME. A handler that has not settled within dispatchTimeoutMs (15 seconds) is given up on: lastError
 * says so, the next event goes ahead, and whatever the handler does after that is ignored. The three are whole
 * milliseconds from 1 to the longest a timer can hold. identifyFloor is a whole number of 0 or more.
 *
 * What went wrong is worded with describe() and scrub() of librariusText, which take out the token and every link, and
 * a log that throws changes nothing.
 *
 * start() connects, and resolves once the first try has opened a socket or has had to wait to try again; it never
 * rejects. A client that is already started, stopped or failed is left alone. stop() closes the socket for good.
 *
 * state is one of
 *   idle        not started
 *   connecting  asking where to connect, or connected and waiting for READY or RESUMED
 *   ready       READY or RESUMED has come
 *   waiting     between tries: a backoff after a drop, or the wait for the window to reset when few sessions are left
 *   stopped     stop() was called
 *   failed      Discord closed with a code that retrying cannot fix
 * lastReadyAt is when READY or RESUMED last came (an ISO time), or null. lastError is the last thing that went wrong,
 * or null; it stays until the next thing goes wrong. It never holds the token, a link or more than 200 characters.
 *
 * What it does with the gateway:
 * - A new session is asked for with gatewayBot(), and every IDENTIFY follows one such ask. When no more than
 *   identifyFloor (50) new sessions are left, it waits until the window resets, so that a loop of dropped connections
 *   cannot spend the whole day's budget. A session it holds is resumed on the address READY gave, without asking, and
 *   forgotten after three resumes in a row that never reached RESUMED (an error, a close or no HELLO), so that a
 *   session Discord has lost is replaced by a new one.
 * - After HELLO it heartbeats, the first time after a random part of an interval so clients do not all beat together.
 *   A heartbeat is sent only when the one before was acknowledged; otherwise the connection is taken to be dead and is
 *   closed with 4000, to be resumed. It identifies, or resumes when it holds a session.
 * - op 1 gets a heartbeat at once, op 7 and op 9 with d true a close with 4000 and a resume, and op 9 with any other d
 *   drops the session, closes with 4000, and connects again, through gatewayBot(), after one to five seconds or the
 *   backoff, whichever is longer.
 * - A drop is retried after 1, 2, 4 … 60 seconds. The backoff starts again from 1 second only once a connection that
 *   READY or RESUMED made ready has held for a minute, so a connection that is made ready and lost at once, over and
 *   over, backs off further each time. A close with 4007 or 4009 drops the session first. Close codes 4004 and 4010 to
 *   4014 are fatal: the client fails and does not try again.
 * - A HELLO it cannot use, or an error event, is a drop too: the socket is closed with 4000 and tried again.
 * - An event of a socket it has let go of is ignored, so a late close cannot start a second reconnect.
 *
 * The token goes to Discord in IDENTIFY and RESUME and nowhere else: not into a url, a log line or lastError.
 */

import { describe, scrub } from './librariusText.js'

// The gateway intents the Librarius needs: guilds, guild emoji, guild messages, guild message reactions and message
// content. Nothing else is asked for, so Discord sends nothing else.
const GUILDS = 1 << 0
const GUILD_EMOJIS_AND_STICKERS = 1 << 3
const GUILD_MESSAGES = 1 << 9
const GUILD_MESSAGE_REACTIONS = 1 << 10
const MESSAGE_CONTENT = 1 << 15
export const INTENTS = GUILDS | GUILD_EMOJIS_AND_STICKERS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | MESSAGE_CONTENT

// Close codes after which connecting again cannot work: a bad token, bad shard or version, or intents Discord refuses.
export const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014])

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

const CLOSE_NORMAL = 1000
const CLOSE_RECONNECT = 4000 // any code but 1000 and 1001 keeps the session alive for a resume
const CLOSE_INVALID_SEQUENCE = 4007
const CLOSE_SESSION_TIMED_OUT = 4009

const QUERY = '/?v=10&encoding=json'
const WS_URL = /^wss?:\/\//
const BACKOFF_START_MS = 1000
const BACKOFF_MAX_MS = 60_000
const REIDENTIFY_MIN_MS = 1000
const REIDENTIFY_SPREAD_MS = 4000
const MAX_TIMER_MS = 2 ** 31 - 1 // a longer delay makes a timer fire at once
// How long a connection that has become ready has to hold before its earlier failures are forgiven.
const STABLE_MS = 60_000
const MAX_RESUMES = 3

// What a handler that ran out of time is rejected with. It is compared by identity, which cannot fail, and nothing a
// handler throws can be taken for it.
const TIMED_OUT = Symbol('timed out')

const needDelay = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}.`)
  }
}

// Stryker disable next-line BlockStatement: a message that is not JSON reads as null, or as undefined; the reader takes both for a message with no op
const parse = (data) => { try { return JSON.parse(data) } catch { return null } }

export function createGateway({
  discord,
  botToken,
  intents = INTENTS,
  onDispatch,
  WebSocketImpl = globalThis.WebSocket,
  timers = { setTimeout, clearTimeout },
  random = Math.random,
  log = console.error,
  helloTimeoutMs = 30_000,
  readyTimeoutMs = 30_000,
  dispatchTimeoutMs = 15_000,
  identifyFloor = 50,
}) {
  if (typeof discord?.gatewayBot !== 'function') throw new TypeError('discord must have a gatewayBot function.')
  if (typeof botToken !== 'string' || botToken === '') throw new TypeError('botToken must be a non-empty string.')
  if (typeof onDispatch !== 'function') throw new TypeError('onDispatch must be a function.')
  if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocketImpl must be a WebSocket constructor.')
  if (!Number.isSafeInteger(intents) || intents < 0) throw new RangeError('intents must be a whole number of 0 or more.')
  if (!Number.isSafeInteger(identifyFloor) || identifyFloor < 0) throw new RangeError('identifyFloor must be a whole number of 0 or more.')
  needDelay(helloTimeoutMs, 'helloTimeoutMs')
  needDelay(readyTimeoutMs, 'readyTimeoutMs')
  needDelay(dispatchTimeoutMs, 'dispatchTimeoutMs')

  let state = 'idle'
  let lastReadyAt = null
  let lastError = null
  // The live socket. Each handler below answers only for the socket it was made for, so one that has been let go of
  // (socket is null or another socket) can no longer do anything.
  let socket = null
  let sessionId = null
  let resumeUrl = null
  let seq = null
  let greeted // this socket has had its HELLO
  let acked // the last heartbeat of this socket was acknowledged
  let attempts = 0 // drops since a connection last held for STABLE_MS, which sets the backoff
  let resumesTried = 0 // resumes since the last READY or RESUMED
  let helloTimer
  let readyTimer
  let stableTimer
  let heartbeatTimer
  let waitTimer
  let handling = Promise.resolve()

  // Stryker disable next-line ObjectLiteral: fault() takes the token out of the whole line again, and cuts it shorter than this does, so the secret is replaced either way; it is given here so that what describe() says is clean by itself
  const words = (err) => describe(err, { secret: botToken })

  // Records what went wrong, and logs it. A log that throws must not take the gateway with it: this is called from
  // timers and socket events, and from the chain every dispatch goes through.
  function fault(message) {
    lastError = scrub(message, { secret: botToken })
    // Stryker disable next-line BlockStatement: what the log is given is not asserted; only that a log which throws changes nothing
    try {
      log(lastError)
    } catch {
      // Nowhere left to say so.
    }
  }

  function send(message) {
    socket.send(JSON.stringify(message))
  }

  // Tries again after the backoff, or after `atLeastMs` when that is longer.
  function scheduleReconnect(atLeastMs = 0) {
    state = 'waiting'
    const wait = Math.max(Math.min(BACKOFF_START_MS * 2 ** attempts, BACKOFF_MAX_MS), atLeastMs)
    attempts += 1
    waitTimer = timers.setTimeout(connect, wait)
  }

  // Lets go of the live socket without closing it: its close has come, or the caller closes it.
  function letGo() {
    socket = null
    timers.clearTimeout(helloTimer)
    timers.clearTimeout(readyTimer)
    timers.clearTimeout(stableTimer)
    timers.clearTimeout(heartbeatTimer)
  }

  function closeWith(code) {
    const old = socket
    letGo()
    old.close(code)
  }

  // Gives the socket up, to try again after the backoff (or `atLeastMs`, when that is longer).
  function abandon(atLeastMs) {
    closeWith(CLOSE_RECONNECT)
    scheduleReconnect(atLeastMs)
  }

  function couldNotConnect(err) {
    fault(`The Librarius gateway could not connect: ${words(err)}`)
    scheduleReconnect()
  }

  async function connect() {
    state = 'connecting'
    try {
      if (sessionId) {
        if (resumesTried < MAX_RESUMES) {
          resumesTried += 1
          return open(resumeUrl)
        }
        // Three resumes in a row came to nothing: Discord no longer has this session.
        forgetSession()
      }
      const info = await discord.gatewayBot()
      if (state === 'stopped') return
      const url = info.url
      if (info.remaining <= identifyFloor) {
        state = 'waiting'
        waitTimer = timers.setTimeout(() => open(url), info.resetAfterMs)
        return
      }
      open(url)
    } catch (err) {
      if (state !== 'stopped') couldNotConnect(err)
    }
  }

  function open(base) {
    state = 'connecting'
    let ws
    try {
      ws = new WebSocketImpl(`${base.replace(/\/+$/, '')}${QUERY}`)
    } catch (err) {
      couldNotConnect(err)
      return
    }
    socket = ws
    greeted = false
    acked = true
    helloTimer = timers.setTimeout(() => {
      fault('The Librarius gateway got no HELLO.')
      abandon()
    }, helloTimeoutMs)
    ws.onmessage = (event) => {
      if (ws === socket) receive(event.data)
    }
    ws.onclose = (event) => {
      if (ws === socket) closed(event.code)
    }
    ws.onerror = () => {
      if (ws === socket) {
        fault('The Librarius gateway connection failed.')
        abandon()
      }
    }
  }

  function closed(code) {
    letGo()
    fault(`The Librarius gateway closed with code ${code}.`)
    if (FATAL_CLOSE.has(code)) {
      state = 'failed'
      return
    }
    if (code === CLOSE_INVALID_SEQUENCE || code === CLOSE_SESSION_TIMED_OUT) forgetSession()
    scheduleReconnect()
  }

  function forgetSession() {
    sessionId = null
    resumeUrl = null
  }

  function receive(data) {
    const message = parse(data)
    switch (message?.op) {
      case OP_DISPATCH:
        return dispatch(message)
      case OP_HEARTBEAT:
        return heartbeat()
      case OP_RECONNECT:
        return abandon()
      case OP_INVALID_SESSION:
        return invalidSession(message.d)
      case OP_HELLO:
        return hello(message.d)
      case OP_HEARTBEAT_ACK:
        acked = true
    }
  }

  function heartbeat() {
    send({ op: OP_HEARTBEAT, d: seq })
  }

  function beat(interval) {
    if (!acked) {
      fault('The Librarius gateway got no acknowledgement of a heartbeat.')
      abandon()
      return
    }
    acked = false
    heartbeat()
    heartbeatTimer = timers.setTimeout(() => beat(interval), interval)
  }

  function hello(data) {
    if (greeted) return
    const interval = data?.heartbeat_interval
    if (typeof interval !== 'number' || interval <= 0 || interval > MAX_TIMER_MS) {
      fault('The Librarius gateway got a HELLO it could not use.')
      abandon()
      return
    }
    greeted = true
    timers.clearTimeout(helloTimer)
    heartbeatTimer = timers.setTimeout(() => beat(interval), interval * random())
    authenticate()
  }

  function authenticate() {
    if (sessionId) {
      send({ op: OP_RESUME, d: { token: botToken, session_id: sessionId, seq } })
    } else {
      seq = null
      send({
        op: OP_IDENTIFY,
        d: { token: botToken, intents, properties: { os: 'linux', browser: 'salamanders-site', device: 'salamanders-site' } },
      })
    }
    readyTimer = timers.setTimeout(() => {
      fault('The Librarius gateway was not made ready in time.')
      abandon()
    }, readyTimeoutMs)
  }

  // The session is gone, so the socket goes too: the way back is the same as for any drop, through gatewayBot(), which
  // Discord's advice of waiting one to five seconds before an IDENTIFY and the backoff both hold up.
  function invalidSession(resumable) {
    if (resumable === true) {
      abandon()
      return
    }
    forgetSession()
    abandon(REIDENTIFY_MIN_MS + random() * REIDENTIFY_SPREAD_MS)
  }

  function becameReady() {
    state = 'ready'
    lastReadyAt = new Date().toISOString()
    resumesTried = 0
    timers.clearTimeout(readyTimer)
    // A connection that is made ready and lost at once must not make the next one wait less: the backoff is forgiven
    // only when this one has held.
    timers.clearTimeout(stableTimer)
    stableTimer = timers.setTimeout(() => {
      attempts = 0
    }, STABLE_MS)
  }

  function dispatch({ t, s, d }) {
    if (typeof t !== 'string') return
    if (Number.isInteger(s)) seq = s
    if (t === 'READY') {
      // A READY that cannot be resumed from still serves events; a later drop identifies afresh.
      // An empty session id is no session: every use of it asks only whether there is one.
      const resumable = typeof d?.session_id === 'string' && typeof d.resume_gateway_url === 'string' && WS_URL.test(d.resume_gateway_url)
      sessionId = resumable ? d.session_id : null
      resumeUrl = resumable ? d.resume_gateway_url : null
      becameReady()
    } else if (t === 'RESUMED') {
      becameReady()
    }
    // One at a time, in order: a later event can depend on an earlier one, and the sequence number has moved on already.
    // Nothing may break the chain, or no later event would be handled: what handle() cannot deal with is recorded here.
    handling = handling
      .then(() => handle(t, d))
      .catch((err) => fault(`The Librarius gateway could not finish handling ${t}: ${words(err)}`))
  }

  // Waits for onDispatch, for as long as dispatchTimeoutMs allows. Whatever the handler does is recorded, not thrown. Once
  // the race is lost, the handler's promise is still being watched by it, so a late failure is not left unhandled, and is
  // ignored.
  async function handle(t, d) {
    let timer
    const tooLong = new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(TIMED_OUT), dispatchTimeoutMs)
    })
    try {
      await Promise.race([new Promise((resolve) => resolve(onDispatch(t, d))), tooLong])
    } catch (err) {
      fault(
        err === TIMED_OUT
          ? `A Librarius gateway handler took too long on ${t}.`
          : `The Librarius gateway could not handle ${t}: ${words(err)}`,
      )
    } finally {
      timers.clearTimeout(timer)
    }
  }

  return {
    start() {
      if (state !== 'idle') return Promise.resolve()
      return connect()
    },

    stop() {
      state = 'stopped'
      timers.clearTimeout(waitTimer)
      if (socket) closeWith(CLOSE_NORMAL)
    },

    status: () => ({ state, lastReadyAt, lastError }),
  }
}
