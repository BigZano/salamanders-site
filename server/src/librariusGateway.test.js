import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fc from 'fast-check'
import { createGateway, INTENTS, FATAL_CLOSE } from './librariusGateway.js'

// Every id and name here is invented. The token is not a real one either.
const TOKEN = 'secret-bot-token'
const GATEWAY = 'wss://gateway.test'
const RESUME = 'wss://resume.test'
const FRESH = 'wss://fresh.test'
const QUERY = '/?v=10&encoding=json'
const SESSION = 'invented-session-1'
const OTHER_SESSION = 'invented-session-2'
// random() is 0.5 in most tests, so the first heartbeat is half an interval in. 40960 halves and quarters to whole
// milliseconds, which fake timers (they cut a delay to a whole number) need to be exact.
const INTERVAL = 40_960
const FIRST_BEAT = INTERVAL / 2
const FATAL = [4004, 4010, 4011, 4012, 4013, 4014]
const NOON = '2026-11-15T12:00:00.000Z'
const MAX_TIMER_MS = 2 ** 31 - 1
const HELLO_TIMEOUT = 30_000
const DISPATCH_TIMEOUT = 15_000
const READY_TIMEOUT = 30_000
const HELD = 60_000

/** A WebSocket that records what it was given and lets the test play the server. close() does not close by itself. */
class FakeSocket {
  constructor(url) {
    this.url = url
    this.sent = []
    this.raw = []
    this.closed = []
    this.opened = false
  }
  send(text) {
    if (!this.opened) throw new Error('InvalidStateError: the socket is not open yet')
    this.raw.push(text)
    this.sent.push(JSON.parse(text))
  }
  close(code) {
    this.closed.push(code)
  }
  open() {
    this.opened = true
    this.onopen?.()
  }
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  receiveRaw(data) {
    this.onmessage?.({ data })
  }
  drop(code) {
    this.onclose?.({ code })
  }
  fail() {
    this.onerror?.({ type: 'error' })
  }
}

const tick = (ms) => vi.advanceTimersByTimeAsync(ms)
const heartbeats = (sock) => sock.sent.filter((m) => m.op === 1)
const identifies = (sock) => sock.sent.filter((m) => m.op === 2)
const resumes = (sock) => sock.sent.filter((m) => m.op === 6)

/**
 * A gateway on fake timers, with fake sockets and a fake `discord`. `plan` queues what gatewayBot() does next: an Error
 * is thrown, a function is called (for a promise the test settles itself), anything else is returned. With nothing
 * queued it answers GATEWAY with sessions left. `failures` queues what the next socket constructors throw.
 */
function rig(over = {}) {
  const sockets = []
  const failures = []
  const plan = []
  const dispatched = []
  const logged = []
  let gatewayCalls = 0
  class Sock extends FakeSocket {
    constructor(url) {
      if (failures.length) throw failures.shift()
      super(url)
      sockets.push(this)
    }
  }
  const discord = {
    async gatewayBot() {
      gatewayCalls += 1
      const next = plan.length ? plan.shift() : { url: GATEWAY, remaining: 1000, resetAfterMs: 0 }
      if (next instanceof Error) throw next
      if (typeof next === 'function') return next()
      return next
    },
  }
  const gateway = createGateway({
    discord,
    botToken: TOKEN,
    onDispatch: async (t, d) => {
      dispatched.push([t, d])
    },
    WebSocketImpl: Sock,
    random: () => 0.5,
    log: (line) => logged.push(String(line)),
    // Most tests are about something else than being made ready in time, and leave a socket that has had its HELLO
    // sitting for minutes. A test of readiness passes `readyTimeoutMs: undefined` for the default.
    readyTimeoutMs: MAX_TIMER_MS,
    ...over,
  })
  return { gateway, sockets, plan, failures, dispatched, logged, calls: () => gatewayCalls }
}

/** Starts the gateway, opens its socket, plays HELLO and READY. Returns the socket. */
async function ready(r, { url = RESUME, session = SESSION, s = 1, interval = INTERVAL } = {}) {
  await r.gateway.start()
  const sock = r.sockets.at(-1)
  sock.open()
  sock.receive({ op: 10, d: { heartbeat_interval: interval } })
  sock.receive({ op: 0, t: 'READY', s, d: { session_id: session, resume_gateway_url: url } })
  await tick(0)
  return sock
}

/** Starts the gateway and opens its socket, with no HELLO yet. */
async function opened(r) {
  await r.gateway.start()
  const sock = r.sockets.at(-1)
  sock.open()
  return sock
}

const hello = (sock, interval = INTERVAL) => sock.receive({ op: 10, d: { heartbeat_interval: interval } })
const READY_MESSAGE = { op: 0, t: 'READY', s: 1, d: { session_id: SESSION, resume_gateway_url: RESUME } }

/** Moves the clock on until the gateway has made one more socket than `count`. */
async function untilSocket(r, count) {
  for (let i = 0; i < 400 && r.sockets.length <= count; i++) await tick(500)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOON))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the constants', () => {
  it('asks for guilds, emoji, messages, reactions, message content and AutoMod configuration, and nothing else', () => {
    expect(INTENTS).toBe(1082889)
    expect(INTENTS).toBe(1 + 8 + 512 + 1024 + 32768 + 1048576)
  })

  it('asks for no privileged intent but message content: neither members nor presences', () => {
    const GUILD_MEMBERS = 1 << 1
    const GUILD_PRESENCES = 1 << 8
    expect(INTENTS & (GUILD_MEMBERS | GUILD_PRESENCES)).toBe(0)
  })

  it('treats exactly the codes that retrying cannot fix as fatal', () => {
    expect([...FATAL_CLOSE].sort()).toEqual(FATAL)
  })
})

describe('createGateway: the boundary', () => {
  const good = () => ({ discord: { gatewayBot: async () => ({}) }, botToken: TOKEN, onDispatch: () => {}, WebSocketImpl: FakeSocket })

  it.each([
    ['no discord', { discord: undefined }, TypeError, 'discord must have a gatewayBot function.'],
    ['a discord without gatewayBot', { discord: {} }, TypeError, 'discord must have a gatewayBot function.'],
    ['a gatewayBot that is not a function', { discord: { gatewayBot: 'gatewayBot' } }, TypeError, 'discord must have a gatewayBot function.'],
    ['no token', { botToken: undefined }, TypeError, 'botToken must be a non-empty string.'],
    ['an empty token', { botToken: '' }, TypeError, 'botToken must be a non-empty string.'],
    ['a token that is not a string', { botToken: 12345 }, TypeError, 'botToken must be a non-empty string.'],
    ['no onDispatch', { onDispatch: undefined }, TypeError, 'onDispatch must be a function.'],
    ['an onDispatch that is not a function', { onDispatch: 'onDispatch' }, TypeError, 'onDispatch must be a function.'],
    ['a null WebSocketImpl', { WebSocketImpl: null }, TypeError, 'WebSocketImpl must be a WebSocket constructor.'],
    ['a WebSocketImpl that is not a function', { WebSocketImpl: 'WebSocket' }, TypeError, 'WebSocketImpl must be a WebSocket constructor.'],
    ['intents that are not a number', { intents: '1' }, RangeError, 'intents must be a whole number of 0 or more.'],
    ['null intents', { intents: null }, RangeError, 'intents must be a whole number of 0 or more.'],
    ['fractional intents', { intents: 1.5 }, RangeError, 'intents must be a whole number of 0 or more.'],
    ['negative intents', { intents: -1 }, RangeError, 'intents must be a whole number of 0 or more.'],
    ['NaN intents', { intents: Number.NaN }, RangeError, 'intents must be a whole number of 0 or more.'],
    ['infinite intents', { intents: Infinity }, RangeError, 'intents must be a whole number of 0 or more.'],
    ['intents past the safe integers', { intents: 2 ** 53 }, RangeError, 'intents must be a whole number of 0 or more.'],
    ...[
      ['a string', '50'],
      ['null', null],
      ['a fraction', 1.5],
      ['a negative number', -1],
      ['NaN', Number.NaN],
      ['Infinity', Infinity],
      ['past the safe integers', 2 ** 53],
    ].map(([what, value]) => [`identifyFloor of ${what}`, { identifyFloor: value }, RangeError, 'identifyFloor must be a whole number of 0 or more.']),
    ...['helloTimeoutMs', 'dispatchTimeoutMs', 'readyTimeoutMs'].flatMap((name) =>
      [
        ['0', 0],
        ['a negative number', -1],
        ['a fraction', 1.5],
        ['a string', '30000'],
        ['null', null],
        ['NaN', Number.NaN],
        ['Infinity', Infinity],
        ['one more than the longest timer', 2 ** 31],
      ].map(([what, value]) => [
        `${name} of ${what}`,
        { [name]: value },
        RangeError,
        `${name} must be a whole number of milliseconds from 1 to 2147483647.`,
      ]),
    ),
  ])('refuses %s', (_name, over, error, message) => {
    expect(() => createGateway({ ...good(), ...over })).toThrow(error)
    expect(() => createGateway({ ...good(), ...over })).toThrow(message)
  })

  it('takes zero intents, the shortest and longest timeouts a timer can hold, and a client with only the required options', () => {
    expect(() => createGateway({ ...good(), intents: 0 })).not.toThrow()
    expect(() => createGateway({ ...good(), identifyFloor: 0 })).not.toThrow()
    expect(() => createGateway({ ...good(), helloTimeoutMs: 1, dispatchTimeoutMs: 1, readyTimeoutMs: 1 })).not.toThrow()
    expect(() =>
      createGateway({ ...good(), helloTimeoutMs: MAX_TIMER_MS, dispatchTimeoutMs: MAX_TIMER_MS, readyTimeoutMs: MAX_TIMER_MS }),
    ).not.toThrow()
    expect(() => createGateway(good())).not.toThrow()
  })

  it('starts idle, with nothing connected and nothing wrong', () => {
    const r = rig()
    expect(r.gateway.status()).toEqual({ state: 'idle', lastReadyAt: null, lastError: null })
    expect(r.sockets).toHaveLength(0)
  })
})

describe('connecting', () => {
  it('connects to the address gatewayBot gave, with the version and encoding asked for', async () => {
    const r = rig()
    r.plan.push({ url: 'wss://one.test', remaining: 1000, resetAfterMs: 0 })
    const started = r.gateway.start()
    expect(r.gateway.status().state).toBe('connecting')
    await started
    expect(r.sockets.map((s) => s.url)).toEqual([`wss://one.test${QUERY}`])
    expect(r.gateway.status().state).toBe('connecting')
  })

  it.each([
    ['wss://one.test/', `wss://one.test${QUERY}`],
    ['wss://one.test//', `wss://one.test${QUERY}`],
    ['wss://one.test/path', `wss://one.test/path${QUERY}`],
    ['ws://one.test:8080', `ws://one.test:8080${QUERY}`],
  ])('builds the address from %s', async (url, expected) => {
    const r = rig()
    r.plan.push({ url, remaining: 1000, resetAfterMs: 0 })
    await r.gateway.start()
    expect(r.sockets.map((s) => s.url)).toEqual([expected])
  })

  it('connects at once when more than 50 sessions remain, and waits for the window to reset when 50 or fewer do', async () => {
    const more = rig()
    more.plan.push({ url: GATEWAY, remaining: 51, resetAfterMs: 99_999 })
    await more.gateway.start()
    expect(more.sockets).toHaveLength(1)

    const edge = rig()
    edge.plan.push({ url: GATEWAY, remaining: 50, resetAfterMs: 99_999 })
    await edge.gateway.start()
    expect(edge.sockets).toHaveLength(0)
    expect(edge.gateway.status().state).toBe('waiting')
    await tick(99_998)
    expect(edge.sockets).toHaveLength(0)
    await tick(1)
    expect(edge.sockets).toHaveLength(1)
  })

  it('waits for the window to reset when no more than identifyFloor sessions remain, and not otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 120 }), fc.integer({ min: 0, max: 200 }), async (floor, remaining) => {
        const r = rig({ identifyFloor: floor })
        r.plan.push({ url: 'wss://one.test', remaining, resetAfterMs: 5000 })
        await r.gateway.start()
        if (remaining <= floor) {
          expect(r.sockets).toHaveLength(0)
          expect(r.gateway.status().state).toBe('waiting')
          await tick(4999)
          expect(r.sockets).toHaveLength(0)
          await tick(1)
        }
        expect(r.sockets.map((s) => s.url)).toEqual([`wss://one.test${QUERY}`])
        r.gateway.stop()
      }),
      { numRuns: 40 },
    )
  })

  it('waits resetAfterMs, no more and no less, when no sessions remain', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 200_000 }), async (wait) => {
        const r = rig()
        r.plan.push({ url: 'wss://one.test', remaining: 0, resetAfterMs: wait })
        await r.gateway.start()
        expect(r.gateway.status().state).toBe('waiting')
        await tick(wait - 1)
        expect(r.sockets).toHaveLength(0)
        expect(r.gateway.status().state).toBe('waiting')
        await tick(1)
        expect(r.sockets.map((s) => s.url)).toEqual([`wss://one.test${QUERY}`])
        expect(r.gateway.status().state).toBe('connecting')
        r.gateway.stop()
      }),
      { numRuns: 25 },
    )
  })

  it('is idempotent: starting a running client does not open a second socket', async () => {
    const r = rig()
    await r.gateway.start()
    await r.gateway.start()
    expect(r.sockets).toHaveLength(1)
  })

  it('does not start after a stop', async () => {
    const r = rig()
    r.gateway.stop()
    await r.gateway.start()
    expect(r.sockets).toHaveLength(0)
    expect(r.gateway.status().state).toBe('stopped')
  })
})

describe('gatewayBot and the socket constructor failing', () => {
  it('does not stop for good: it waits 1, 2, then 4 seconds and tries again', async () => {
    const r = rig()
    r.plan.push(new Error('Discord answered 503 for the gateway.'), new Error('Discord is unreachable.'), new Error('again'))
    await expect(r.gateway.start()).resolves.not.toThrow()
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toMatch(/503/)
    for (const wait of [1000, 2000, 4000]) {
      await tick(wait - 1)
      expect(r.sockets).toHaveLength(0)
      expect(r.gateway.status().state).toBe('waiting')
      await tick(1)
    }
    expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`])
    expect(r.gateway.status().state).toBe('connecting')
  })

  it.each([
    ['null', null],
    ['an object with no url', {}],
    ['a url that is not a string', { url: 5, remaining: 1000, resetAfterMs: 0 }],
  ])('treats an answer of %s as a failure and tries again', async (_name, answer) => {
    const r = rig()
    r.plan.push(answer)
    await r.gateway.start()
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toEqual(expect.any(String))
    await tick(1000)
    expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`])
  })

  it('treats a socket constructor that throws as a failure and tries again with the same backoff', async () => {
    const r = rig()
    r.failures.push(new Error('no route'), new Error('no route either'))
    await r.gateway.start()
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toMatch(/no route/)
    await tick(999)
    expect(r.sockets).toHaveLength(0)
    await tick(1)
    expect(r.gateway.status().state).toBe('waiting')
    await tick(1999)
    expect(r.sockets).toHaveLength(0)
    await tick(1)
    expect(r.sockets).toHaveLength(1)
  })

  it('keeps retrying a failing gatewayBot at no more than 60 seconds apart', async () => {
    const r = rig()
    for (let i = 0; i < 9; i++) r.plan.push(new Error('down'))
    await r.gateway.start()
    for (const wait of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      await tick(wait)
      expect(r.sockets).toHaveLength(0)
      expect(r.gateway.status().state).toBe('waiting')
    }
    await tick(60_000)
    expect(r.sockets).toHaveLength(1)
  })

  it('describes a failure without the token, a link or more than 200 characters', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300 }), fc.string({ maxLength: 300 }), async (before, after) => {
        const r = rig()
        r.plan.push(new Error(`${before}${TOKEN}${after} https://cdn.test/a?sig=${TOKEN} wss://x.test/y`))
        await r.gateway.start()
        const { lastError } = r.gateway.status()
        expect(lastError).toEqual(expect.any(String))
        expect(lastError).not.toContain(TOKEN)
        expect(lastError).not.toContain('://')
        expect(lastError.length).toBeLessThanOrEqual(200)
        expect(r.logged.join('\n')).not.toContain(TOKEN)
        r.gateway.stop()
      }),
      { numRuns: 40 },
    )
  })

  it('replaces the token and every kind of link in a failure with a marker', async () => {
    const r = rig()
    r.plan.push(
      new Error(
        `bad ${TOKEN} at http://a.test/p?x=1 and https://b.test/q and ws://c.test/r and wss://d.test/s and HTTPS://E.test/u and cdn.discordapp.com/attachments/1/2/x.png?ex=1 end`,
      ),
    )
    await r.gateway.start()
    expect(r.gateway.status().lastError).toContain('bad [token] at [link] and [link] and [link] and [link] and [link] and [link] end')
  })

  it('cuts a long failure to 200 characters', async () => {
    const r = rig()
    r.plan.push(new Error('x'.repeat(5000)))
    await r.gateway.start()
    const { lastError } = r.gateway.status()
    expect(lastError).toHaveLength(200)
    expect(lastError.endsWith('x'.repeat(100))).toBe(true)
  })

  it('names what was thrown, and copes with a throw that is not an Error', async () => {
    const r = rig()
    class Refused extends Error {
      name = 'Refused'
    }
    r.plan.push(new Refused('go away'))
    await r.gateway.start()
    expect(r.gateway.status().lastError).toContain('Refused: go away')

    for (const thrown of [null, undefined, 'a plain string', 42]) {
      const q = rig({
        discord: {
          gatewayBot: async () => {
            throw thrown
          },
        },
      })
      await q.gateway.start()
      expect(q.gateway.status().lastError).toMatch(/Error: $/)
      q.gateway.stop()
    }
  })

  it('does not retry a gatewayBot that fails after a stop, nor report its failure', async () => {
    const r = rig()
    let fail
    r.plan.push(() => new Promise((_, reject) => (fail = reject)))
    const started = r.gateway.start()
    r.gateway.stop()
    fail(new Error('too late'))
    await started
    await tick(600_000)
    expect(r.sockets).toHaveLength(0)
    expect(r.gateway.status()).toEqual({ state: 'stopped', lastReadyAt: null, lastError: null })
  })

  it('does not open a socket for a gatewayBot that answers after a stop', async () => {
    const r = rig()
    let answer
    r.plan.push(() => new Promise((resolve) => (answer = resolve)))
    const started = r.gateway.start()
    r.gateway.stop()
    answer({ url: GATEWAY, remaining: 1000, resetAfterMs: 0 })
    await started
    await tick(600_000)
    expect(r.sockets).toHaveLength(0)
    expect(r.gateway.status().state).toBe('stopped')
  })
})

describe('HELLO and the heartbeat', () => {
  it('sends nothing until HELLO', async () => {
    const r = rig()
    const sock = await opened(r)
    await tick(10 * INTERVAL)
    expect(sock.sent).toEqual([])
  })

  it('sends the first heartbeat after interval times random(), then one every interval', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1023 }), fc.integer({ min: 1, max: 40 }), async (j, mult) => {
        // A dyadic random() and an interval that is a multiple of 1024 keep the product a whole number of ms.
        const interval = 1024 * mult
        const delay = j * mult
        const r = rig({ random: () => j / 1024 })
        const sock = await opened(r)
        hello(sock, interval)
        await tick(delay - 1)
        expect(heartbeats(sock)).toHaveLength(0)
        await tick(1)
        expect(heartbeats(sock)).toHaveLength(1)
        sock.receive({ op: 11 })
        await tick(interval - 1)
        expect(heartbeats(sock)).toHaveLength(1)
        await tick(1)
        expect(heartbeats(sock)).toHaveLength(2)
        sock.receive({ op: 11 })
        await tick(interval)
        expect(heartbeats(sock)).toHaveLength(3)
        r.gateway.stop()
      }),
      { numRuns: 25 },
    )
  })

  it('sends the first heartbeat at once when random() is 0', async () => {
    const r = rig({ random: () => 0 })
    const sock = await opened(r)
    hello(sock)
    await tick(0)
    expect(heartbeats(sock)).toHaveLength(1)
  })

  it('heartbeats with the sequence number of the last dispatch, null before any', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    await tick(FIRST_BEAT)
    expect(heartbeats(sock).at(-1)).toEqual({ op: 1, d: null })
    sock.receive({ op: 11 })
    sock.receive({ op: 0, t: 'THING', s: 41, d: {} })
    await tick(INTERVAL)
    expect(heartbeats(sock).at(-1)).toEqual({ op: 1, d: 41 })
    sock.receive({ op: 11 })
    sock.receive({ op: 0, t: 'THING', s: 42, d: {} })
    await tick(INTERVAL)
    expect(heartbeats(sock).at(-1)).toEqual({ op: 1, d: 42 })
  })

  it('keeps the sequence number when a dispatch brings none that is a whole number', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    sock.receive({ op: 0, t: 'THING', s: 7, d: {} })
    for (const s of ['8', 8.5, null, undefined, [9], {}, true]) sock.receive({ op: 0, t: 'THING', s, d: {} })
    await tick(FIRST_BEAT)
    expect(heartbeats(sock).at(-1)).toEqual({ op: 1, d: 7 })
  })

  it('ignores a second HELLO on the same socket', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    hello(sock, 1000)
    expect(identifies(sock)).toHaveLength(1)
    await tick(FIRST_BEAT)
    expect(heartbeats(sock)).toHaveLength(1)
    sock.receive({ op: 11 })
    await tick(INTERVAL)
    expect(heartbeats(sock)).toHaveLength(2)
  })

  it('answers op 1 with a heartbeat at once, and leaves the schedule and the acknowledgement check alone', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    sock.receive({ op: 0, t: 'THING', s: 3, d: {} })
    sock.receive({ op: 1, d: null })
    expect(heartbeats(sock)).toEqual([{ op: 1, d: 3 }])
    await tick(FIRST_BEAT - 1)
    expect(heartbeats(sock)).toHaveLength(1)
    await tick(1)
    expect(heartbeats(sock)).toHaveLength(2)
    expect(sock.closed).toEqual([])
    sock.receive({ op: 11 })
    await tick(INTERVAL)
    expect(heartbeats(sock)).toHaveLength(3)
    expect(sock.closed).toEqual([])
  })

  it('keeps beating for many intervals while each is acknowledged', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    sock.receive({ op: 11 })
    await tick(FIRST_BEAT)
    for (let i = 0; i < 10; i++) {
      sock.receive({ op: 11 })
      await tick(INTERVAL)
    }
    expect(heartbeats(sock)).toHaveLength(11)
    expect(sock.closed).toEqual([])
  })

  it('accepts an acknowledgement that comes just before the next heartbeat is due', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    await tick(FIRST_BEAT)
    await tick(INTERVAL - 1)
    sock.receive({ op: 11 })
    await tick(1)
    expect(heartbeats(sock)).toHaveLength(2)
    expect(sock.closed).toEqual([])
  })

  it('closes with 4000 when a heartbeat was never acknowledged, instead of sending the next one', async () => {
    const r = rig()
    const sock = await ready(r)
    await tick(FIRST_BEAT)
    expect(heartbeats(sock)).toHaveLength(1)
    await tick(INTERVAL - 1)
    expect(sock.closed).toEqual([])
    await tick(1)
    expect(sock.closed).toEqual([4000])
    expect(heartbeats(sock)).toHaveLength(1)
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toMatch(/acknowledg/i)
    await tick(10 * INTERVAL)
    expect(heartbeats(sock)).toHaveLength(1)
  })

  it('resumes, on a socket of its own, after a heartbeat went unacknowledged', async () => {
    const r = rig()
    const sock = await ready(r, { s: 12 })
    await tick(FIRST_BEAT + INTERVAL)
    expect(sock.closed).toEqual([4000])
    await tick(999)
    expect(r.sockets).toHaveLength(1)
    await tick(1)
    expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`, `${RESUME}${QUERY}`])
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(next.sent).toEqual([{ op: 6, d: { token: TOKEN, session_id: SESSION, seq: 12 } }])
  })

  it('starts the acknowledgement check afresh on a new socket', async () => {
    const r = rig()
    const sock = await ready(r)
    await tick(FIRST_BEAT + INTERVAL)
    expect(sock.closed).toEqual([4000])
    await tick(1000)
    const next = r.sockets[1]
    next.open()
    hello(next)
    await tick(FIRST_BEAT)
    expect(heartbeats(next)).toHaveLength(1)
    expect(next.closed).toEqual([])
  })

  it.each([
    ['no data', { op: 10 }],
    ['null data', { op: 10, d: null }],
    ['empty data', { op: 10, d: {} }],
    ['an interval of 0', { op: 10, d: { heartbeat_interval: 0 } }],
    ['a negative interval', { op: 10, d: { heartbeat_interval: -41250 } }],
    ['an interval that is a string', { op: 10, d: { heartbeat_interval: '41250' } }],
    ['a null interval', { op: 10, d: { heartbeat_interval: null } }],
    ['an interval that is a list', { op: 10, d: { heartbeat_interval: [41250] } }],
    ['an interval one past the longest timer', { op: 10, d: { heartbeat_interval: MAX_TIMER_MS + 1 } }],
    ['data that is a number', { op: 10, d: 41250 }],
  ])('closes with 4000 and tries again after a HELLO with %s, without identifying', async (_name, message) => {
    const r = rig()
    const sock = await opened(r)
    sock.receive(message)
    expect(sock.closed).toEqual([4000])
    expect(sock.sent).toEqual([])
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toMatch(/HELLO/)
    await tick(999)
    expect(r.sockets).toHaveLength(1)
    await tick(1)
    expect(r.sockets).toHaveLength(2)
  })

  it('closes after a HELLO whose interval is too large to be a number at all', async () => {
    const r = rig()
    const sock = await opened(r)
    sock.receiveRaw('{"op":10,"d":{"heartbeat_interval":1e999}}')
    expect(sock.closed).toEqual([4000])
    expect(sock.sent).toEqual([])
  })

  it('accepts the longest interval a timer can hold', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock, MAX_TIMER_MS)
    expect(sock.closed).toEqual([])
    expect(identifies(sock)).toHaveLength(1)
  })
})

describe('identifying and resuming', () => {
  it('identifies at HELLO with the token, the intents and the client properties', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    expect(sock.sent).toEqual([
      {
        op: 2,
        d: {
          token: TOKEN,
          intents: 1082889,
          properties: { os: 'linux', browser: 'salamanders-site', device: 'salamanders-site' },
        },
      },
    ])
  })

  it('identifies with the intents it was given, including none at all', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 ** 31 }), async (intents) => {
        const r = rig({ intents })
        const sock = await opened(r)
        hello(sock)
        expect(identifies(sock).map((m) => m.d.intents)).toEqual([intents])
        r.gateway.stop()
      }),
      { numRuns: 25 },
    )
  })

  it('resumes with the session and the last sequence number once READY has given a session', async () => {
    const r = rig()
    const sock = await ready(r, { s: 5 })
    sock.receive({ op: 0, t: 'THING', s: 6, d: {} })
    sock.receive({ op: 0, t: 'THING', s: 7, d: {} })
    sock.drop(1006)
    await tick(1000)
    expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`, `${RESUME}${QUERY}`])
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(next.sent).toEqual([{ op: 6, d: { token: TOKEN, session_id: SESSION, seq: 7 } }])
  })

  it('resumes the newest session when READY comes again', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.receive({ op: 0, t: 'READY', s: 2, d: { session_id: OTHER_SESSION, resume_gateway_url: 'wss://other.test' } })
    sock.drop(1006)
    await tick(1000)
    const next = r.sockets[1]
    expect(next.url).toBe(`wss://other.test${QUERY}`)
    next.open()
    hello(next)
    expect(resumes(next)).toEqual([{ op: 6, d: { token: TOKEN, session_id: OTHER_SESSION, seq: 2 } }])
  })

  it.each([
    ['no data', undefined],
    ['null data', null],
    ['data that is a string', 'READY'],
    ['no session', { resume_gateway_url: RESUME }],
    ['an empty session', { session_id: '', resume_gateway_url: RESUME }],
    ['a session that is a number', { session_id: 12, resume_gateway_url: RESUME }],
    ['no resume address', { session_id: SESSION }],
    ['a resume address that is a number', { session_id: SESSION, resume_gateway_url: 12 }],
    ['a resume address that is a list holding an address', { session_id: SESSION, resume_gateway_url: [RESUME] }],
    ['an https resume address', { session_id: SESSION, resume_gateway_url: 'https://resume.test' }],
    ['a resume address with a space before it', { session_id: SESSION, resume_gateway_url: ' wss://resume.test' }],
    ['a resume address with something before the scheme', { session_id: SESSION, resume_gateway_url: 'xwss://resume.test' }],
    ['a resume address that is only a scheme word', { session_id: SESSION, resume_gateway_url: 'wss' }],
  ])('stays ready but cannot resume after a READY with %s', async (_name, d) => {
    const r = rig()
    r.plan.push({ url: FRESH, remaining: 1000, resetAfterMs: 0 })
    await r.gateway.start()
    const sock = r.sockets[0]
    sock.open()
    hello(sock)
    sock.receive({ op: 0, t: 'READY', s: 4, d })
    expect(r.gateway.status().state).toBe('ready')
    sock.drop(1006)
    await tick(1000)
    expect(r.sockets.map((s) => s.url)).toEqual([`${FRESH}${QUERY}`, `${GATEWAY}${QUERY}`])
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(resumes(next)).toEqual([])
    expect(identifies(next)).toHaveLength(1)
  })

  it('takes a ws:// resume address as well as a wss:// one', async () => {
    const r = rig()
    const sock = await ready(r, { url: 'ws://resume.test:9000' })
    sock.drop(1006)
    await tick(1000)
    expect(r.sockets[1].url).toBe(`ws://resume.test:9000${QUERY}`)
  })

  it('does not ask gatewayBot where to connect when it holds a session to resume', async () => {
    const r = rig()
    const sock = await ready(r)
    r.plan.push(new Error('gatewayBot must not be needed'))
    sock.drop(1006)
    await tick(1000)
    expect(r.sockets).toHaveLength(2)
    expect(r.gateway.status().lastError).not.toMatch(/gatewayBot must not be needed/)
  })

  it('starts the sequence over when it identifies for a new session', async () => {
    const r = rig()
    const sock = await ready(r, { s: 30 })
    sock.drop(4009)
    await tick(1000)
    const next = r.sockets[1]
    next.open()
    hello(next)
    await tick(FIRST_BEAT)
    expect(heartbeats(next)).toEqual([{ op: 1, d: null }])
  })
})

describe('op 7, op 9 and READY', () => {
  it('closes with 4000 on op 7, and resumes after the backoff', async () => {
    const r = rig()
    const sock = await ready(r, { s: 9 })
    sock.receive({ op: 7, d: null })
    expect(sock.closed).toEqual([4000])
    expect(r.gateway.status().state).toBe('waiting')
    await tick(999)
    expect(r.sockets).toHaveLength(1)
    await tick(1)
    expect(r.sockets[1].url).toBe(`${RESUME}${QUERY}`)
    r.sockets[1].open()
    hello(r.sockets[1])
    expect(resumes(r.sockets[1])).toEqual([{ op: 6, d: { token: TOKEN, session_id: SESSION, seq: 9 } }])
  })

  it('does not take op 7 for an error', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.receive({ op: 7, d: null })
    expect(r.gateway.status().lastError).toBeNull()
  })

  it('closes with 4000 on op 9 with d true, and resumes', async () => {
    const r = rig()
    const sock = await ready(r, { s: 3 })
    sock.receive({ op: 9, d: true })
    expect(sock.closed).toEqual([4000])
    await tick(1000)
    expect(r.sockets[1].url).toBe(`${RESUME}${QUERY}`)
    r.sockets[1].open()
    hello(r.sockets[1])
    expect(resumes(r.sockets[1])).toHaveLength(1)
  })

  it.each([
    ['false', false],
    ['null', null],
    ['a string', 'true'],
    ['1', 1],
    ['missing', undefined],
  ])('drops the session on op 9 with d %s, closes with 4000 and comes back through gatewayBot', async (_name, d) => {
    const r = rig()
    const sock = await ready(r, { s: 3 })
    r.plan.push({ url: FRESH, remaining: 1000, resetAfterMs: 0 })
    sock.receive({ op: 9, d })
    expect(sock.closed).toEqual([4000])
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toBeNull()
    await tick(2999)
    expect(r.sockets).toHaveLength(1)
    await tick(1)
    expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`, `${FRESH}${QUERY}`])
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(next.sent).toEqual([
      {
        op: 2,
        d: {
          token: TOKEN,
          intents: 1082889,
          properties: { os: 'linux', browser: 'salamanders-site', device: 'salamanders-site' },
        },
      },
    ])
  })

  it('waits between 1 and 5 seconds, by random(), before it connects again after op 9', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 7 }), async (eighths) => {
        const r = rig({ random: () => eighths / 8 })
        const sock = await opened(r)
        hello(sock, 1_000_000)
        sock.receive(READY_MESSAGE)
        sock.receive({ op: 9, d: false })
        const wait = 1000 + eighths * 500
        await tick(wait - 1)
        expect(r.sockets).toHaveLength(1)
        await tick(1)
        expect(r.sockets).toHaveLength(2)
        r.gateway.stop()
      }),
      { numRuns: 20 },
    )
  })

  it('reconnects once even when op 9 comes twice', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.receive({ op: 9, d: false })
    sock.receive({ op: 9, d: false })
    await tick(3000)
    sock.receive({ op: 9, d: false })
    await tick(HELLO_TIMEOUT - 3001)
    expect(sock.closed).toEqual([4000])
    expect(r.sockets).toHaveLength(2)
  })

  it('does not resume after op 9 with d false, even when the old socket reports a close', async () => {
    const r = rig()
    const sock = await ready(r)
    r.plan.push({ url: FRESH, remaining: 1000, resetAfterMs: 0 })
    sock.receive({ op: 9, d: false })
    sock.drop(1006)
    await tick(3000)
    const next = r.sockets[1]
    expect(next.url).toBe(`${FRESH}${QUERY}`)
    next.open()
    hello(next)
    expect(resumes(next)).toEqual([])
    expect(identifies(next)).toHaveLength(1)
  })

  it('is ready on READY, remembers when, and has nothing wrong yet', async () => {
    const r = rig()
    await r.gateway.start()
    const sock = r.sockets[0]
    sock.open()
    hello(sock)
    expect(r.gateway.status().lastReadyAt).toBeNull()
    await tick(1234)
    sock.receive({ op: 0, t: 'READY', s: 1, d: { session_id: SESSION, resume_gateway_url: RESUME } })
    expect(r.gateway.status()).toEqual({ state: 'ready', lastReadyAt: '2026-11-15T12:00:01.234Z', lastError: null })
  })

  it('is ready again on RESUMED, with a new time', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.drop(1006)
    expect(r.gateway.status().state).toBe('waiting')
    await tick(1000)
    const next = r.sockets[1]
    next.open()
    hello(next)
    await tick(500)
    expect(r.gateway.status().state).toBe('connecting')
    next.receive({ op: 0, t: 'RESUMED', s: 2, d: {} })
    expect(r.gateway.status().state).toBe('ready')
    expect(r.gateway.status().lastReadyAt).toBe('2026-11-15T12:00:01.500Z')
  })

  it('goes back to waiting when a ready connection drops', async () => {
    const r = rig()
    const sock = await ready(r)
    expect(r.gateway.status().state).toBe('ready')
    sock.drop(1006)
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastReadyAt).toBe(NOON)
  })
})

describe('dispatches', () => {
  it('hands onDispatch each event as (t, d), READY included, in the order they came', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.receive({ op: 0, t: 'FIRST_THING', s: 2, d: { n: 1 } })
    sock.receive({ op: 0, t: 'SECOND_THING', s: 3, d: [2] })
    sock.receive({ op: 0, t: 'THIRD_THING', s: 4, d: null })
    await tick(0)
    expect(r.dispatched).toEqual([
      ['READY', { session_id: SESSION, resume_gateway_url: RESUME }],
      ['FIRST_THING', { n: 1 }],
      ['SECOND_THING', [2]],
      ['THIRD_THING', null],
    ])
  })

  it('hands over RESUMED too', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.drop(1006)
    await tick(1000)
    r.sockets[1].open()
    hello(r.sockets[1])
    r.sockets[1].receive({ op: 0, t: 'RESUMED', s: 2, d: {} })
    await tick(0)
    expect(r.dispatched.map(([t]) => t)).toEqual(['READY', 'RESUMED'])
  })

  it('waits for one event to be handled before it hands over the next', async () => {
    const order = []
    const finish = []
    const r = rig({
      onDispatch: (t) =>
        new Promise((resolve) => {
          order.push(`${t} begins`)
          finish.push(() => {
            order.push(`${t} ends`)
            resolve()
          })
        }),
    })
    const sock = await ready(r)
    sock.receive({ op: 0, t: 'A_THING', s: 2, d: {} })
    sock.receive({ op: 0, t: 'B_THING', s: 3, d: {} })
    await tick(0)
    expect(order).toEqual(['READY begins'])
    finish[0]()
    await tick(0)
    expect(order).toEqual(['READY begins', 'READY ends', 'A_THING begins'])
    finish[1]()
    await tick(0)
    finish[2]()
    await tick(0)
    expect(order).toEqual(['READY begins', 'READY ends', 'A_THING begins', 'A_THING ends', 'B_THING begins', 'B_THING ends'])
  })

  it('is not ready for an event that is neither READY nor RESUMED', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    sock.receive({ op: 0, t: 'A_THING', s: 1, d: {} })
    await tick(0)
    expect(r.gateway.status()).toEqual({ state: 'connecting', lastReadyAt: null, lastError: null })
    expect(r.dispatched.map(([t]) => t)).toEqual(['A_THING'])
  })

  it('is ready as soon as READY comes, whether or not READY has been handled', async () => {
    const r = rig({ onDispatch: () => new Promise(() => {}) })
    const sock = await opened(r)
    hello(sock)
    sock.receive({ op: 0, t: 'READY', s: 1, d: { session_id: SESSION, resume_gateway_url: RESUME } })
    expect(r.gateway.status().state).toBe('ready')
  })

  it.each([
    ['throws', () => {
      throw new Error('handler broke')
    }],
    ['rejects', () => Promise.reject(new Error('handler broke'))],
    ['throws something that is not an Error', () => {
      throw null // eslint-disable-line no-throw-literal
    }],
    ['rejects with a string', () => Promise.reject('handler broke')],
  ])('stays ready, and keeps handing over events, when onDispatch %s', async (_name, boom) => {
    const seen = []
    const r = rig({
      onDispatch: (t) => {
        seen.push(t)
        if (t === 'BAD_THING') return boom()
      },
    })
    const sock = await ready(r)
    sock.receive({ op: 0, t: 'BAD_THING', s: 2, d: {} })
    sock.receive({ op: 0, t: 'GOOD_THING', s: 3, d: {} })
    await tick(0)
    expect(r.gateway.status().state).toBe('ready')
    expect(sock.closed).toEqual([])
    expect(seen).toEqual(['READY', 'BAD_THING', 'GOOD_THING'])
    expect(r.gateway.status().lastError).toMatch(/BAD_THING/)
    sock.receive({ op: 0, t: 'LATER_THING', s: 4, d: {} })
    await tick(0)
    expect(seen).toEqual(['READY', 'BAD_THING', 'GOOD_THING', 'LATER_THING'])
  })

  it('records a failing handler without the token, a link or more than 200 characters', async () => {
    const r = rig({
      onDispatch: (t) => {
        if (t === 'BAD_THING') throw new Error(`${'y'.repeat(150)}${TOKEN} https://cdn.test/f?sig=${TOKEN} ${'z'.repeat(500)}`)
      },
    })
    const sock = await ready(r)
    sock.receive({ op: 0, t: 'BAD_THING', s: 2, d: {} })
    await tick(0)
    const { lastError } = r.gateway.status()
    expect(lastError).toMatch(/BAD_THING/)
    expect(lastError).not.toContain(TOKEN)
    expect(lastError).not.toContain('://')
    expect(lastError.length).toBeLessThanOrEqual(200)
    expect(r.logged.join('\n')).not.toContain(TOKEN)
  })

  it('still handles an event that came in before a stop', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.receive({ op: 0, t: 'LAST_THING', s: 2, d: {} })
    r.gateway.stop()
    await tick(0)
    expect(r.dispatched.map(([t]) => t)).toEqual(['READY', 'LAST_THING'])
  })

  it.each([
    ['no type', { op: 0, s: 5, d: {} }],
    ['a null type', { op: 0, t: null, s: 5, d: {} }],
    ['a type that is a number', { op: 0, t: 5, s: 5, d: {} }],
    ['a type that is a list', { op: 0, t: ['A_THING'], s: 5, d: {} }],
  ])('ignores a dispatch with %s, sequence number and all', async (_name, message) => {
    const r = rig()
    const sock = await ready(r)
    sock.receive({ op: 0, t: 'A_THING', s: 2, d: {} })
    sock.receive(message)
    await tick(FIRST_BEAT)
    expect(r.dispatched.map(([t]) => t)).toEqual(['READY', 'A_THING'])
    expect(heartbeats(sock).at(-1)).toEqual({ op: 1, d: 2 })
  })

  it.each([
    ['READY', { op: 0, t: 'READY', s: 1, d: { session_id: SESSION, resume_gateway_url: RESUME } }],
    ['RESUMED', { op: 0, t: 'RESUMED', s: 2, d: {} }],
  ])('forgives the earlier failures only once the connection %s brought has held for 60 seconds', async (_name, message) => {
    // Three drops in a row, so that the next wait is 8 seconds.
    const wearOut = async (r) => {
      await r.gateway.start()
      for (const wait of [1000, 2000, 4000]) {
        r.sockets.at(-1).drop(1006)
        await tick(wait)
      }
      expect(r.sockets).toHaveLength(4)
      const sock = r.sockets[3]
      sock.open()
      hello(sock)
      sock.receive(message)
      return sock
    }

    const early = rig()
    const quick = await wearOut(early)
    await tick(HELD - 1)
    quick.drop(1006)
    await tick(7999)
    expect(early.sockets).toHaveLength(4)
    await tick(1)
    expect(early.sockets).toHaveLength(5)

    const held = rig()
    const steady = await wearOut(held)
    await tick(HELD)
    steady.drop(1006)
    await tick(999)
    expect(held.sockets).toHaveLength(4)
    await tick(1)
    expect(held.sockets).toHaveLength(5)
  })

  it('counts from the latest READY, and stops counting once the connection is gone', async () => {
    const r = rig()
    const first = await ready(r)
    await tick(30_000)
    first.receive(READY_MESSAGE)
    await tick(10_000)
    first.drop(1006)
    // Drops in a row until past the first READY's minute and short of the second's: no wait may be forgiven.
    for (const wait of [1000, 2000, 4000, 8000, 16_000]) {
      await tick(wait)
      r.sockets.at(-1).drop(1006)
    }
    expect(r.sockets).toHaveLength(6)
    // Every wait so far has doubled; the sixth drop waits 32 seconds, whatever either READY's timer would say.
    await tick(31_999)
    expect(r.sockets).toHaveLength(6)
    await tick(1)
    expect(r.sockets).toHaveLength(7)
    r.sockets.at(-1).drop(1006)
    await tick(59_999)
    expect(r.sockets).toHaveLength(7)
    await tick(1)
    expect(r.sockets).toHaveLength(8)
  })
})

describe('the identify budget', () => {
  const identifiesOf = (r) => r.sockets.reduce((n, sock) => n + identifies(sock).length, 0)

  it('never identifies without asking gatewayBot first, and backs off further each time a new session is thrown away', async () => {
    const r = rig()
    await r.gateway.start()
    let wait
    for (wait of [3000, 3000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      const sock = r.sockets.at(-1)
      const count = r.sockets.length
      sock.open()
      hello(sock)
      sock.receive(READY_MESSAGE)
      sock.receive({ op: 9, d: false })
      await tick(wait - 1)
      expect(r.sockets).toHaveLength(count)
      await tick(1)
      expect(r.sockets).toHaveLength(count + 1)
    }
    expect(r.sockets.every((sock) => resumes(sock).length === 0)).toBe(true)
    expect(identifiesOf(r)).toBeLessThanOrEqual(r.calls())
    expect(r.calls()).toBe(r.sockets.length)
  })

  it('does the same when a drop and a resume come in between', async () => {
    const r = rig()
    const waits = [1000, 3000, 4000, 8000]
    const first = await ready(r)
    first.drop(1006)
    await tick(waits[0])
    // The resume is refused: a new session, through gatewayBot, after the longer of 1 to 5 seconds and the backoff.
    const second = r.sockets[1]
    expect(second.url).toBe(`${RESUME}${QUERY}`)
    second.open()
    hello(second)
    expect(resumes(second)).toHaveLength(1)
    second.receive({ op: 9, d: false })
    await tick(waits[1] - 1)
    expect(r.sockets).toHaveLength(2)
    await tick(1)
    const third = r.sockets[2]
    expect(third.url).toBe(`${GATEWAY}${QUERY}`)
    third.open()
    hello(third)
    third.receive(READY_MESSAGE)
    third.drop(1006)
    await tick(waits[2])
    const fourth = r.sockets[3]
    expect(fourth.url).toBe(`${RESUME}${QUERY}`)
    fourth.open()
    hello(fourth)
    fourth.receive({ op: 9, d: false })
    await tick(waits[3] - 1)
    expect(r.sockets).toHaveLength(4)
    await tick(1)
    expect(r.sockets).toHaveLength(5)
    expect(identifiesOf(r)).toBeLessThanOrEqual(r.calls())
    expect(r.calls()).toBe(3)
  })
})

describe('a session that cannot be resumed', () => {
  const fails = [
    ['a close', async (r) => r.sockets.at(-1).drop(1006)],
    ['an error event', async (r) => r.sockets.at(-1).fail()],
    ['no HELLO', async () => tick(HELLO_TIMEOUT)],
    ['op 9 with d true', async (r) => {
      r.sockets.at(-1).open()
      hello(r.sockets.at(-1))
      r.sockets.at(-1).receive({ op: 9, d: true })
    }],
  ]

  it.each(fails)('is forgotten after three resumes that ended in %s, and the next connect identifies', async (_name, fail) => {
    const r = rig()
    const first = await ready(r, { s: 20 })
    first.drop(1006)
    for (let attempt = 1; attempt <= 3; attempt++) {
      await untilSocket(r, attempt)
      expect(r.sockets[attempt].url).toBe(`${RESUME}${QUERY}`)
      await fail(r)
    }
    expect(r.sockets).toHaveLength(4)
    r.plan.push({ url: FRESH, remaining: 1000, resetAfterMs: 0 })
    await untilSocket(r, 4)
    const next = r.sockets[4]
    expect(next.url).toBe(`${FRESH}${QUERY}`)
    next.open()
    hello(next)
    expect(resumes(next)).toEqual([])
    expect(identifies(next)).toHaveLength(1)
    await tick(FIRST_BEAT)
    expect(heartbeats(next)).toEqual([{ op: 1, d: null }])
  })

  it('is forgotten after three resumes that could not even make a socket', async () => {
    const r = rig()
    const first = await ready(r)
    r.failures.push(new Error('no route'), new Error('no route'), new Error('no route'))
    first.drop(1006)
    await tick(1000 + 2000 + 4000)
    expect(r.sockets).toHaveLength(1)
    expect(r.gateway.status().state).toBe('waiting')
    r.plan.push({ url: FRESH, remaining: 1000, resetAfterMs: 0 })
    await tick(8000)
    expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`, `${FRESH}${QUERY}`])
  })

  it('keeps resuming while the attempts are not three in a row, a RESUMED starting the count again', async () => {
    const r = rig()
    const first = await ready(r)
    first.drop(1006)
    // Two failed resumes, then one that works.
    await untilSocket(r, 1)
    r.sockets[1].drop(1006)
    await untilSocket(r, 2)
    r.sockets[2].drop(1006)
    await untilSocket(r, 3)
    const good = r.sockets[3]
    expect(good.url).toBe(`${RESUME}${QUERY}`)
    good.open()
    hello(good)
    good.receive({ op: 0, t: 'RESUMED', s: 2, d: {} })
    good.drop(1006)
    // Three more failed resumes before a new session is asked for.
    for (let attempt = 4; attempt <= 6; attempt++) {
      await untilSocket(r, attempt)
      expect(r.sockets[attempt].url).toBe(`${RESUME}${QUERY}`)
      r.sockets[attempt].drop(1006)
    }
    r.plan.push({ url: FRESH, remaining: 1000, resetAfterMs: 0 })
    await untilSocket(r, 7)
    expect(r.sockets[7].url).toBe(`${FRESH}${QUERY}`)
  })

  it('starts the count again with each READY, so a new session is resumed three times too', async () => {
    const r = rig()
    const first = await ready(r)
    first.drop(1006)
    for (let attempt = 1; attempt <= 3; attempt++) {
      await untilSocket(r, attempt)
      r.sockets[attempt].drop(1006)
    }
    r.plan.push({ url: FRESH, remaining: 1000, resetAfterMs: 0 })
    await untilSocket(r, 4)
    const fresh = r.sockets[4]
    fresh.open()
    hello(fresh)
    fresh.receive({ op: 0, t: 'READY', s: 1, d: { session_id: OTHER_SESSION, resume_gateway_url: RESUME } })
    fresh.drop(1006)
    for (let attempt = 5; attempt <= 7; attempt++) {
      await untilSocket(r, attempt)
      expect(r.sockets[attempt].url).toBe(`${RESUME}${QUERY}`)
      r.sockets[attempt].drop(1006)
    }
  })
})

describe('a connection that never becomes ready', () => {
  it('is closed with 4000 30 seconds after IDENTIFY, and tried again', async () => {
    const r = rig({ readyTimeoutMs: undefined })
    const sock = await opened(r)
    await tick(5000)
    hello(sock, 1_000_000)
    await tick(READY_TIMEOUT - 1)
    expect(sock.closed).toEqual([])
    expect(r.gateway.status().state).toBe('connecting')
    await tick(1)
    expect(sock.closed).toEqual([4000])
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toMatch(/ready/i)
    await tick(999)
    expect(r.sockets).toHaveLength(1)
    await tick(1)
    expect(r.sockets).toHaveLength(2)
  })

  it('is closed 30 seconds after RESUME too', async () => {
    const r = rig({ readyTimeoutMs: undefined })
    const first = await ready(r)
    first.drop(1006)
    await tick(1000)
    const sock = r.sockets[1]
    sock.open()
    hello(sock, 1_000_000)
    expect(resumes(sock)).toHaveLength(1)
    await tick(READY_TIMEOUT - 1)
    expect(sock.closed).toEqual([])
    await tick(1)
    expect(sock.closed).toEqual([4000])
  })

  it('waits as long as readyTimeoutMs says, no more and no less', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 200_000 }), async (wait) => {
        const r = rig({ readyTimeoutMs: wait })
        const sock = await opened(r)
        hello(sock, 1_000_000)
        await tick(wait - 1)
        expect(sock.closed).toEqual([])
        await tick(1)
        expect(sock.closed).toEqual([4000])
        r.gateway.stop()
      }),
      { numRuns: 25 },
    )
  })

  it.each([
    ['READY', { op: 0, t: 'READY', s: 1, d: { session_id: SESSION, resume_gateway_url: RESUME } }],
    ['RESUMED', { op: 0, t: 'RESUMED', s: 1, d: {} }],
  ])('is not closed once %s has come', async (_name, message) => {
    const r = rig({ readyTimeoutMs: undefined })
    const sock = await opened(r)
    hello(sock, 1_000_000)
    sock.receive(message)
    await tick(2 * READY_TIMEOUT)
    expect(sock.closed).toEqual([])
    expect(r.sockets).toHaveLength(1)
  })

  it('is not made ready by an event that is neither', async () => {
    const r = rig({ readyTimeoutMs: undefined })
    const sock = await opened(r)
    hello(sock, 1_000_000)
    sock.receive({ op: 0, t: 'A_THING', s: 1, d: {} })
    await tick(READY_TIMEOUT)
    expect(sock.closed).toEqual([4000])
  })

  it('does not hold a socket that dropped before READY to account for the one that replaced it', async () => {
    const r = rig({ readyTimeoutMs: undefined })
    const first = await opened(r)
    hello(first, 1_000_000)
    first.drop(1006)
    await tick(1000)
    const second = r.sockets[1]
    second.open()
    hello(second, 1_000_000)
    await tick(READY_TIMEOUT - 1000)
    expect(second.closed).toEqual([])
    await tick(1000)
    expect(second.closed).toEqual([4000])
  })

  it('leaves a socket alone that failed for good, or that was stopped, before READY', async () => {
    const r = rig({ readyTimeoutMs: undefined })
    const failed = await opened(r)
    hello(failed, 1_000_000)
    failed.drop(4004)
    await tick(2 * READY_TIMEOUT)
    expect(failed.closed).toEqual([])
    expect(r.gateway.status().state).toBe('failed')

    const q = rig({ readyTimeoutMs: undefined })
    const stopped = await opened(q)
    hello(stopped, 1_000_000)
    q.gateway.stop()
    await tick(2 * READY_TIMEOUT)
    expect(stopped.closed).toEqual([1000])
    expect(q.sockets).toHaveLength(1)
  })
})

describe('a failure that cannot be reported', () => {
  it('does not stop the handlers: a handler that fails with an error that cannot even be read, or a log that throws', async () => {
    const hostile = {
      get name() {
        throw new Error('no name')
      },
      get message() {
        return Symbol('no message')
      },
    }
    const seen = []
    const r = rig({
      onDispatch: (t) => {
        seen.push(t)
        if (t === 'BAD_THING') throw hostile
        if (t === 'WORSE_THING') return Promise.reject(Symbol('worse'))
      },
      log: () => {
        throw new Error('the log is down')
      },
    })
    const sock = await ready(r)
    for (const [i, t] of ['BAD_THING', 'WORSE_THING', 'GOOD_THING'].entries()) sock.receive({ op: 0, t, s: 2 + i, d: {} })
    await tick(0)
    expect(seen).toEqual(['READY', 'BAD_THING', 'WORSE_THING', 'GOOD_THING'])
    expect(r.gateway.status().state).toBe('ready')
    expect(r.gateway.status().lastError).toMatch(/WORSE_THING/)
    sock.receive({ op: 0, t: 'LATER_THING', s: 9, d: {} })
    await tick(0)
    expect(seen.at(-1)).toBe('LATER_THING')
  })

  it('does not stop a drop being tried again when the log throws', async () => {
    const r = rig({
      log: () => {
        throw new Error('the log is down')
      },
    })
    const sock = await ready(r)
    sock.drop(1006)
    expect(r.gateway.status().lastError).toContain('1006')
    await tick(1000)
    expect(r.sockets).toHaveLength(2)
  })

  it('words a failure that cannot be read, from gatewayBot, as an error with no text', async () => {
    const r = rig({
      discord: {
        gatewayBot: async () => {
          throw {
            get name() {
              throw new Error('no name')
            },
          }
        },
      },
    })
    await expect(r.gateway.start()).resolves.not.toThrow()
    expect(r.gateway.status().lastError).toMatch(/Error: $/)
    expect(r.gateway.status().state).toBe('waiting')
  })
})

describe('closes and the backoff', () => {
  it.each(FATAL)('fails for good on close code %i, and says which', async (code) => {
    const r = rig()
    const sock = await ready(r)
    sock.drop(code)
    expect(r.gateway.status().state).toBe('failed')
    expect(r.gateway.status().lastError).toContain(String(code))
    await tick(600_000)
    expect(r.sockets).toHaveLength(1)
    expect(r.gateway.status().state).toBe('failed')
  })

  it('fails for good on a fatal close before any READY, too', async () => {
    const r = rig()
    const sock = await opened(r)
    sock.drop(4004)
    await tick(600_000)
    expect(r.sockets).toHaveLength(1)
    expect(r.gateway.status().state).toBe('failed')
  })

  it('stops its timers when it fails', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.drop(4014)
    await tick(10 * INTERVAL)
    expect(heartbeats(sock)).toEqual([])
    expect(sock.closed).toEqual([])
  })

  it('reconnects after any other close code, resuming when it holds a session', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4999 }).filter((c) => !FATAL.includes(c) && c !== 4007 && c !== 4009),
        async (code) => {
          const r = rig()
          const sock = await ready(r)
          sock.drop(code)
          expect(r.gateway.status().state).toBe('waiting')
          expect(r.gateway.status().lastError).toContain(String(code))
          await tick(999)
          expect(r.sockets).toHaveLength(1)
          await tick(1)
          expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`, `${RESUME}${QUERY}`])
          r.gateway.stop()
        },
      ),
      { numRuns: 40 },
    )
  })

  it('reconnects after a close that carries no code', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.onclose({})
    await tick(1000)
    expect(r.sockets).toHaveLength(2)
  })

  it.each([4007, 4009])('drops the session on close code %i and identifies again', async (code) => {
    const r = rig()
    const sock = await ready(r, { s: 8 })
    r.plan.push({ url: FRESH, remaining: 1000, resetAfterMs: 0 })
    sock.drop(code)
    expect(r.gateway.status().state).toBe('waiting')
    await tick(999)
    expect(r.sockets).toHaveLength(1)
    await tick(1)
    expect(r.sockets[1].url).toBe(`${FRESH}${QUERY}`)
    r.sockets[1].open()
    hello(r.sockets[1])
    expect(resumes(r.sockets[1])).toEqual([])
    expect(identifies(r.sockets[1])).toHaveLength(1)
  })

  it('backs off 1, 2, 4, 8, 16, 32 seconds and then 60 at the longest, while sockets keep dropping', async () => {
    const r = rig()
    await r.gateway.start()
    for (const wait of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]) {
      const count = r.sockets.length
      r.sockets.at(-1).drop(1006)
      await tick(wait - 1)
      expect(r.sockets).toHaveLength(count)
      await tick(1)
      expect(r.sockets).toHaveLength(count + 1)
    }
  })

  it('backs off the same way through the 4007 and 4009 closes', async () => {
    const r = rig()
    await r.gateway.start()
    for (const [wait, code] of [[1000, 4007], [2000, 4009], [4000, 4007]]) {
      const count = r.sockets.length
      r.sockets.at(-1).drop(code)
      await tick(wait - 1)
      expect(r.sockets).toHaveLength(count)
      await tick(1)
      expect(r.sockets).toHaveLength(count + 1)
    }
  })

  it('waits when it has to for sessions again, before it identifies on a new socket', async () => {
    const r = rig()
    const sock = await ready(r)
    r.plan.push({ url: FRESH, remaining: 0, resetAfterMs: 5000 })
    sock.drop(4009)
    await tick(1000)
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.sockets).toHaveLength(1)
    await tick(4999)
    expect(r.sockets).toHaveLength(1)
    await tick(1)
    expect(r.sockets[1].url).toBe(`${FRESH}${QUERY}`)
  })

  it('does not take the close that follows a fatal close for another reason to reconnect', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.drop(4004)
    sock.drop(1006)
    await tick(600_000)
    expect(r.sockets).toHaveLength(1)
  })

  it('treats an error event as a drop, and reconnects once even when a close follows', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.fail()
    expect(sock.closed).toEqual([4000])
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toMatch(/failed/)
    sock.drop(1006)
    await tick(1000)
    expect(r.sockets).toHaveLength(2)
    // The new socket's own silence is 30 seconds away; nothing else would make another.
    await tick(HELLO_TIMEOUT - 2000)
    expect(r.sockets).toHaveLength(2)
  })
})

describe('stop', () => {
  it('closes the socket with 1000 and never reconnects', async () => {
    const r = rig()
    const sock = await ready(r)
    r.gateway.stop()
    expect(sock.closed).toEqual([1000])
    expect(r.gateway.status().state).toBe('stopped')
    sock.drop(1000)
    await tick(600_000)
    expect(r.sockets).toHaveLength(1)
    expect(r.gateway.status().state).toBe('stopped')
  })

  it('stops the heartbeat', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    r.gateway.stop()
    await tick(10 * INTERVAL)
    expect(heartbeats(sock)).toEqual([])
  })

  it('stops a heartbeat that is already running', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock)
    await tick(FIRST_BEAT)
    expect(heartbeats(sock)).toHaveLength(1)
    r.gateway.stop()
    await tick(10 * INTERVAL)
    expect(heartbeats(sock)).toHaveLength(1)
    expect(sock.closed).toEqual([1000])
  })

  it('cancels a reconnect that is waiting', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.drop(1006)
    r.gateway.stop()
    await tick(600_000)
    expect(r.sockets).toHaveLength(1)
  })

  it('cancels a wait for sessions to come back', async () => {
    const r = rig()
    r.plan.push({ url: GATEWAY, remaining: 0, resetAfterMs: 5000 })
    await r.gateway.start()
    r.gateway.stop()
    await tick(600_000)
    expect(r.sockets).toHaveLength(0)
    expect(r.gateway.status().state).toBe('stopped')
  })

  it('cancels the reconnect that is waiting after op 9', async () => {
    const r = rig()
    const sock = await ready(r)
    sock.receive({ op: 9, d: false })
    r.gateway.stop()
    await tick(600_000)
    expect(r.sockets).toHaveLength(1)
    expect(r.gateway.status().state).toBe('stopped')
  })

  it('can be called before start, twice, and after a failure', async () => {
    const r = rig()
    r.gateway.stop()
    r.gateway.stop()
    expect(r.gateway.status().state).toBe('stopped')

    const q = rig()
    const sock = await ready(q)
    sock.drop(4004)
    expect(q.gateway.status().state).toBe('failed')
    q.gateway.stop()
    expect(q.gateway.status().state).toBe('stopped')
    expect(q.gateway.status().lastError).toContain('4004')
  })

  it('closes a socket that has not said HELLO yet', async () => {
    const r = rig()
    const sock = await opened(r)
    r.gateway.stop()
    expect(sock.closed).toEqual([1000])
  })
})

describe('a socket that has been replaced', () => {
  // Each way the client gives up a socket of its own accord. The socket's own close event comes after, as a real one does.
  const ways = [
    ['an unacknowledged heartbeat', async (r, sock) => {
      await tick(FIRST_BEAT + INTERVAL)
      return sock
    }],
    ['op 7', async (r, sock) => sock.receive({ op: 7, d: null })],
    ['op 9 with d true', async (r, sock) => sock.receive({ op: 9, d: true })],
    ['an error event', async (r, sock) => sock.fail()],
  ]

  it.each(ways)('ignores everything the old socket does after %s', async (_name, give) => {
    const r = rig()
    const old = await ready(r)
    await give(r, old)
    expect(old.closed).toEqual([4000])
    await tick(1000)
    expect(r.sockets).toHaveLength(2)
    const current = r.sockets[1]
    current.open()
    hello(current)
    current.receive({ op: 0, t: 'RESUMED', s: 2, d: {} })
    await tick(0)

    const sentBefore = old.sent.length
    old.drop(4000)
    old.drop(1006)
    old.drop(4004)
    old.receive({ op: 0, t: 'LATE_THING', s: 99, d: {} })
    old.receive({ op: 10, d: { heartbeat_interval: 1000 } })
    old.receive({ op: 9, d: false })
    old.receive({ op: 7, d: null })
    old.receive({ op: 1, d: null })
    old.fail()
    // Long enough for the 1 and 2 second backoffs a second reconnect would wait out, short of the current socket's own
    // heartbeats going unanswered.
    await tick(FIRST_BEAT - 1)

    expect(r.sockets).toHaveLength(2)
    expect(current.closed).toEqual([])
    expect(r.gateway.status().state).not.toBe('failed')
    expect(old.sent).toHaveLength(sentBefore)
    expect(r.dispatched.map(([t]) => t)).not.toContain('LATE_THING')
  })

  it('does not let the old socket move the sequence number', async () => {
    const r = rig()
    const old = await ready(r)
    old.receive({ op: 7, d: null })
    await tick(1000)
    const current = r.sockets[1]
    current.open()
    hello(current)
    old.receive({ op: 0, t: 'LATE_THING', s: 99, d: {} })
    await tick(FIRST_BEAT)
    expect(heartbeats(current)).toEqual([{ op: 1, d: 1 }])
  })

  it('ignores the late close of a socket that went wrong at HELLO', async () => {
    const r = rig()
    const old = await opened(r)
    old.receive({ op: 10, d: {} })
    expect(old.closed).toEqual([4000])
    await tick(1000)
    old.drop(1006)
    old.drop(4004)
    await tick(HELLO_TIMEOUT - 2000)
    expect(r.sockets).toHaveLength(2)
  })
})

describe('a socket that never says HELLO', () => {
  it('is closed with 4000 after 30 seconds, counted from when the socket was made, and tried again', async () => {
    const r = rig()
    await r.gateway.start()
    const sock = r.sockets[0]
    await tick(10_000)
    sock.open()
    await tick(HELLO_TIMEOUT - 10_000 - 1)
    expect(sock.closed).toEqual([])
    expect(r.gateway.status().state).toBe('connecting')
    await tick(1)
    expect(sock.closed).toEqual([4000])
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toMatch(/HELLO/)
    await tick(999)
    expect(r.sockets).toHaveLength(1)
    await tick(1)
    expect(r.sockets).toHaveLength(2)
  })

  it('is closed even when the socket never opens', async () => {
    const r = rig()
    await r.gateway.start()
    await tick(HELLO_TIMEOUT)
    expect(r.sockets[0].closed).toEqual([4000])
  })

  it('backs off like any other drop while the silence goes on', async () => {
    const r = rig()
    await r.gateway.start()
    for (const wait of [1000, 2000, 4000, 8000]) {
      const count = r.sockets.length
      await tick(HELLO_TIMEOUT)
      expect(r.sockets.at(-1).closed).toEqual([4000])
      await tick(wait - 1)
      expect(r.sockets).toHaveLength(count)
      await tick(1)
      expect(r.sockets).toHaveLength(count + 1)
    }
  })

  it('waits as long as helloTimeoutMs says, no more and no less', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 200_000 }), async (wait) => {
        const r = rig({ helloTimeoutMs: wait })
        await r.gateway.start()
        await tick(wait - 1)
        expect(r.sockets[0].closed).toEqual([])
        await tick(1)
        expect(r.sockets[0].closed).toEqual([4000])
        r.gateway.stop()
      }),
      { numRuns: 25 },
    )
  })

  it('is not closed once HELLO has come', async () => {
    const r = rig()
    const sock = await opened(r)
    hello(sock, 1_000_000)
    await tick(2 * HELLO_TIMEOUT)
    expect(sock.closed).toEqual([])
    expect(r.sockets).toHaveLength(1)
  })

  it('closes once, not twice, a socket whose HELLO was no use', async () => {
    const r = rig()
    const sock = await opened(r)
    sock.receive({ op: 10, d: {} })
    await tick(2 * HELLO_TIMEOUT)
    expect(sock.closed).toEqual([4000])
  })

  it('does not hold a socket that dropped before HELLO to account for the one that replaced it', async () => {
    const r = rig()
    const first = await opened(r)
    first.drop(1006)
    await tick(1000)
    const second = r.sockets[1]
    await tick(HELLO_TIMEOUT - 1000)
    expect(second.closed).toEqual([])
    expect(r.gateway.status().state).toBe('connecting')
    await tick(1000)
    expect(second.closed).toEqual([4000])
  })

  it('does not touch a socket that failed for good before HELLO', async () => {
    const r = rig()
    const sock = await opened(r)
    sock.drop(4004)
    await tick(2 * HELLO_TIMEOUT)
    expect(sock.closed).toEqual([])
    expect(r.sockets).toHaveLength(1)
    expect(r.gateway.status().state).toBe('failed')
  })

  it('does not reconnect after a stop', async () => {
    const r = rig()
    const sock = await opened(r)
    r.gateway.stop()
    await tick(2 * HELLO_TIMEOUT)
    expect(sock.closed).toEqual([1000])
    expect(r.sockets).toHaveLength(1)
    expect(r.gateway.status().state).toBe('stopped')
  })
})

describe('a handler that takes too long', () => {
  /** A client whose onDispatch holds HANG_THING until the test settles it, and answers everything else at once. */
  function hung(over = {}) {
    const seen = []
    const calls = []
    const r = rig({
      onDispatch: (t) => {
        seen.push(t)
        if (t === 'HANG_THING') return new Promise((resolve, reject) => calls.push({ resolve, reject }))
      },
      ...over,
    })
    return { r, seen, calls }
  }
  const event = (sock, t, s) => sock.receive({ op: 0, t, s, d: {} })

  it('is given up on after 15 seconds: recorded, and the next event goes ahead', async () => {
    const { r, seen } = hung()
    const sock = await ready(r)
    event(sock, 'HANG_THING', 2)
    event(sock, 'NEXT_THING', 3)
    await tick(DISPATCH_TIMEOUT - 1)
    expect(seen).toEqual(['READY', 'HANG_THING'])
    expect(r.gateway.status().lastError).toBeNull()
    await tick(1)
    expect(seen).toEqual(['READY', 'HANG_THING', 'NEXT_THING'])
    expect(r.gateway.status().lastError).toMatch(/took too long/)
    expect(r.gateway.status().lastError).toMatch(/HANG_THING/)
    expect(r.gateway.status().state).toBe('ready')
    expect(sock.closed).toEqual([])
  })

  it('counts the 15 seconds from when the handler starts, not from when the event came', async () => {
    const r = rig({
      onDispatch: (t) => {
        if (t === 'SLOW_THING') return new Promise((resolve) => setTimeout(resolve, 10_000))
        if (t === 'HANG_THING') return new Promise(() => {})
      },
    })
    const sock = await ready(r)
    event(sock, 'SLOW_THING', 2)
    event(sock, 'HANG_THING', 3)
    await tick(10_000 + DISPATCH_TIMEOUT - 1)
    expect(r.gateway.status().lastError).toBeNull()
    await tick(1)
    expect(r.gateway.status().lastError).toMatch(/HANG_THING/)
  })

  it('waits as long as dispatchTimeoutMs says, no more and no less', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 15_000 }), async (wait) => {
        const { r, seen } = hung({ dispatchTimeoutMs: wait })
        const sock = await ready(r)
        event(sock, 'HANG_THING', 2)
        event(sock, 'NEXT_THING', 3)
        await tick(wait - 1)
        expect(seen).toEqual(['READY', 'HANG_THING'])
        await tick(1)
        expect(seen).toEqual(['READY', 'HANG_THING', 'NEXT_THING'])
        r.gateway.stop()
      }),
      { numRuns: 25 },
    )
  })

  it.each([
    ['settles', (call) => call.resolve()],
    ['fails', (call) => call.reject(new Error('too late to matter'))],
  ])('does not mind a handler that %s after it was given up on', async (_name, settle) => {
    const { r, seen, calls } = hung()
    const sock = await ready(r)
    event(sock, 'HANG_THING', 2)
    event(sock, 'NEXT_THING', 3)
    await tick(DISPATCH_TIMEOUT)
    const timedOut = r.gateway.status().lastError
    expect(timedOut).toMatch(/took too long/)
    settle(calls[0])
    await tick(0)
    event(sock, 'LAST_THING', 4)
    await tick(0)
    expect(seen).toEqual(['READY', 'HANG_THING', 'NEXT_THING', 'LAST_THING'])
    expect(r.gateway.status().lastError).toBe(timedOut)
    expect(r.gateway.status().state).toBe('ready')
  })

  it('goes on to the next event at once when a handler settles before its time is up', async () => {
    const { r, seen, calls } = hung()
    const sock = await ready(r)
    event(sock, 'HANG_THING', 2)
    event(sock, 'NEXT_THING', 3)
    await tick(DISPATCH_TIMEOUT - 1)
    calls[0].resolve()
    await tick(0)
    expect(seen).toEqual(['READY', 'HANG_THING', 'NEXT_THING'])
    await tick(DISPATCH_TIMEOUT)
    expect(r.gateway.status().lastError).toBeNull()
  })

  it('stops its timer when a handler is done', async () => {
    const jobs = []
    const timers = {
      setTimeout: (fn, ms) => jobs.push({ fn, ms, cleared: false }) - 1,
      clearTimeout: (id) => {
        if (jobs[id]) jobs[id].cleared = true
      },
    }
    const r = rig({ timers })
    const sock = await opened(r)
    hello(sock)
    event(sock, 'A_THING', 1)
    await tick(0)
    const timeouts = jobs.filter((j) => j.ms === DISPATCH_TIMEOUT)
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0].cleared).toBe(true)
  })

  it('records a handler that failed without the token or a link, whatever the event is called', async () => {
    const r = rig({
      onDispatch: () => {
        throw new Error('broke')
      },
    })
    const sock = await ready(r)
    sock.receive({ op: 0, t: `EVIL ${TOKEN} https://cdn.test/x?sig=${TOKEN}`, s: 2, d: {} })
    await tick(0)
    const { lastError } = r.gateway.status()
    expect(lastError).toMatch(/EVIL \[token\] \[link\]/)
    expect(lastError).not.toContain(TOKEN)
    expect(r.logged.join('\n')).not.toContain(TOKEN)
  })

  it('records it without the token or a link, whatever the event is called', async () => {
    const r = rig({ onDispatch: () => new Promise(() => {}) })
    const sock = await ready(r)
    await tick(DISPATCH_TIMEOUT)
    sock.receive({ op: 0, t: `EVIL ${TOKEN} ${'A'.repeat(150)} https://cdn.test/x?sig=${TOKEN}`, s: 2, d: {} })
    await tick(DISPATCH_TIMEOUT)
    const { lastError } = r.gateway.status()
    expect(lastError).toMatch(/took too long/)
    expect(lastError).not.toContain(TOKEN)
    expect(lastError).not.toContain('://')
    expect(lastError.length).toBeLessThanOrEqual(200)
    expect(r.logged.join('\n')).not.toContain(TOKEN)
  })

  /** A value that blows up at any touch: a revoked Proxy, one whose traps throw, and a Proxy whose target is a function. */
  const untouchable = () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const trapped = new Proxy(
      {},
      {
        get() {
          throw new Error('get trap')
        },
        has() {
          throw new Error('has trap')
        },
        getPrototypeOf() {
          throw new Error('getPrototypeOf trap')
        },
      },
    )
    return [revoked.proxy, trapped]
  }

  it.each([
    ['rejects with', (value) => Promise.reject(value)],
    ['throws', (value) => {
      throw value
    }],
  ])('goes on to the next events when a handler %s something that cannot be touched', async (_name, fail) => {
    for (const value of untouchable()) {
      const seen = []
      const r = rig({
        onDispatch: (t) => {
          seen.push(t)
          if (t === 'BAD_THING') return fail(value)
        },
      })
      const sock = await ready(r)
      for (const [i, t] of ['BAD_THING', 'SECOND_THING', 'THIRD_THING'].entries()) sock.receive({ op: 0, t, s: 2 + i, d: {} })
      await tick(0)
      expect(seen).toEqual(['READY', 'BAD_THING', 'SECOND_THING', 'THIRD_THING'])
      expect(r.gateway.status().state).toBe('ready')
      expect(r.gateway.status().lastError).toMatch(/could not handle BAD_THING/)
      expect(r.gateway.status().lastError).not.toMatch(/too long/)
      expect(sock.closed).toEqual([])
      r.gateway.stop()
    }
  })

  it('goes on to the next events when a handler fails with something that cannot be touched, after it timed out', async () => {
    const [value] = untouchable()
    const calls = []
    const seen = []
    const r = rig({
      onDispatch: (t) => {
        seen.push(t)
        if (t === 'HANG_THING') return new Promise((_, reject) => calls.push(reject))
      },
    })
    const sock = await ready(r)
    for (const [i, t] of ['HANG_THING', 'NEXT_THING'].entries()) sock.receive({ op: 0, t, s: 2 + i, d: {} })
    await tick(DISPATCH_TIMEOUT)
    calls[0](value)
    await tick(0)
    sock.receive({ op: 0, t: 'LAST_THING', s: 4, d: {} })
    await tick(0)
    expect(seen).toEqual(['READY', 'HANG_THING', 'NEXT_THING', 'LAST_THING'])
    expect(r.gateway.status().lastError).toMatch(/took too long on HANG_THING/)
  })

  it('goes on to the next events when the timers fail while a handler is waited for', async () => {
    const jobs = []
    const timers = {
      setTimeout: (fn, ms) => jobs.push({ fn, ms }) - 1,
      clearTimeout: (id) => {
        if (jobs[id]?.ms === DISPATCH_TIMEOUT) throw new Error('the timer is broken')
      },
    }
    const seen = []
    const r = rig({
      timers,
      onDispatch: (t) => {
        seen.push(t)
      },
    })
    const sock = await opened(r)
    hello(sock)
    for (const [i, t] of ['FIRST_THING', 'SECOND_THING', 'THIRD_THING'].entries()) sock.receive({ op: 0, t, s: 1 + i, d: {} })
    await tick(0)
    expect(seen).toEqual(['FIRST_THING', 'SECOND_THING', 'THIRD_THING'])
    expect(r.gateway.status().lastError).toMatch(/THIRD_THING.*the timer is broken/)
    expect(r.gateway.status().state).toBe('connecting')
  })
})

describe('hostile messages', () => {
  it.each([
    ['not JSON', 'not json'],
    ['half a JSON object', '{"op":10'],
    ['nothing', ''],
    ['null', 'null'],
    ['a string', '"op"'],
    ['a number', '42'],
    ['true', 'true'],
    ['a list', '[10]'],
    ['an object with no op', '{"t":"A_THING","s":1,"d":{}}'],
    ['an op that is a string', '{"op":"10","d":{"heartbeat_interval":1000}}'],
    ['an op that is null', '{"op":null}'],
    ['an op nobody defined', '{"op":99,"d":{}}'],
    ['a negative op', '{"op":-1}'],
    ['an op that is a list', '{"op":[10]}'],
  ])('lets %s pass without a change', async (_name, raw) => {
    const r = rig()
    const sock = await opened(r)
    sock.receiveRaw(raw)
    expect(sock.sent).toEqual([])
    expect(sock.closed).toEqual([])
    expect(r.gateway.status()).toEqual({ state: 'connecting', lastReadyAt: null, lastError: null })
    await tick(HELLO_TIMEOUT - 1)
    expect(r.sockets).toHaveLength(1)
    expect(r.dispatched).toEqual([])
  })

  it('lets data that is not text pass without a change', async () => {
    const r = rig()
    const sock = await opened(r)
    for (const data of [new ArrayBuffer(8), undefined, new Uint8Array([1, 2, 3]), { op: 10 }]) sock.receiveRaw(data)
    expect(sock.sent).toEqual([])
    expect(sock.closed).toEqual([])
    expect(r.gateway.status().state).toBe('connecting')
  })

  it('survives any text at all, and still works after it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string(), { maxLength: 20 }), async (junk) => {
        const r = rig()
        const sock = await opened(r)
        for (const text of junk) sock.receiveRaw(text)
        hello(sock)
        expect(identifies(sock)).toHaveLength(1)
        r.gateway.stop()
      }),
      { numRuns: 30 },
    )
  })

  it('survives any JSON at all', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.jsonValue(), { maxLength: 20 }), async (junk) => {
        const r = rig()
        const sock = await opened(r)
        for (const value of junk) sock.receive(value)
        expect(() => r.gateway.status()).not.toThrow()
        r.gateway.stop()
      }),
      { numRuns: 30 },
    )
  })

  it('ignores an ACK before any heartbeat and an event with no data', async () => {
    const r = rig()
    const sock = await opened(r)
    sock.receive({ op: 11 })
    hello(sock)
    sock.receive({ op: 0, t: 'A_THING', s: 1 })
    await tick(0)
    expect(r.dispatched).toEqual([['A_THING', undefined]])
  })
})

describe('the token', () => {
  it('goes to Discord in IDENTIFY and RESUME, and nowhere else', async () => {
    const r = rig()
    const sock = await ready(r)
    await tick(FIRST_BEAT)
    sock.receive({ op: 11 })
    sock.receive({ op: 0, t: 'A_THING', s: 2, d: {} })
    sock.receive({ op: 9, d: false })
    await tick(5000)
    sock.drop(1006)
    await tick(1000)
    const next = r.sockets[1]
    next.open()
    hello(next)
    for (const s of [sock, next]) {
      for (const message of s.sent) {
        const carriesToken = JSON.stringify(message).includes(TOKEN)
        expect(carriesToken).toBe(message.op === 2 || message.op === 6)
      }
    }
    for (const s of r.sockets) expect(s.url).not.toContain(TOKEN)
  })

  it('never shows in the status or the log, whatever goes wrong', async () => {
    const leak = `leaked ${TOKEN} https://cdn.test/x?sig=${TOKEN}`
    const r = rig({
      onDispatch: (t) => {
        if (t === 'BAD_THING') throw new Error(leak)
      },
    })
    r.plan.push(new Error(leak))
    r.failures.push(new Error(leak))
    const statuses = []
    const note = () => statuses.push(r.gateway.status().lastError)
    await r.gateway.start()
    note()
    await tick(1000)
    note()
    await tick(2000)
    const sock = r.sockets[0]
    sock.open()
    hello(sock, 1000)
    sock.receive({ op: 0, t: 'READY', s: 1, d: { session_id: SESSION, resume_gateway_url: RESUME } })
    sock.receive({ op: 0, t: 'BAD_THING', s: 2, d: {} })
    await tick(0)
    note()
    await tick(3000)
    note()
    sock.fail()
    note()
    await untilSocket(r, 1)
    r.sockets[1].open()
    hello(r.sockets[1], 1000)
    r.sockets[1].drop(4004)
    note()
    for (const lastError of statuses) {
      expect(lastError).toEqual(expect.any(String))
      expect(lastError).not.toContain(TOKEN)
    }
    expect(r.logged.join('\n')).not.toContain(TOKEN)
  })
})

describe('the options it is given, and the ones it defaults', () => {
  it('uses the timers it is given instead of the global ones', async () => {
    const jobs = []
    const timers = {
      setTimeout: (fn, ms) => jobs.push({ fn, ms, over: false }) - 1,
      clearTimeout: (id) => {
        if (jobs[id]) jobs[id].over = true
      },
    }
    const r = rig({ timers, readyTimeoutMs: undefined })
    const sock = await opened(r)
    hello(sock)
    expect(jobs.map((j) => j.ms)).toEqual([HELLO_TIMEOUT, FIRST_BEAT, READY_TIMEOUT])
    expect(jobs[0].over).toBe(true)
    jobs[1].over = true
    jobs[1].fn()
    expect(heartbeats(sock)).toHaveLength(1)
    expect(jobs.map((j) => j.ms)).toEqual([HELLO_TIMEOUT, FIRST_BEAT, READY_TIMEOUT, INTERVAL])
    r.gateway.stop()
    for (const job of jobs.filter((j) => !j.over)) job.fn()
    expect(heartbeats(sock)).toHaveLength(1)
  })

  it('defaults to the global WebSocket, timers, Math.random and console.error', async () => {
    const sockets = []
    class Sock extends FakeSocket {
      constructor(url) {
        super(url)
        sockets.push(this)
      }
    }
    vi.stubGlobal('WebSocket', Sock)
    vi.spyOn(Math, 'random').mockReturnValue(0.25)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let bot = 0
    const gateway = createGateway({
      discord: {
        async gatewayBot() {
          bot += 1
          if (bot === 1) throw new Error(`down: ${TOKEN}`)
          return { url: GATEWAY, remaining: 1000, resetAfterMs: 0 }
        },
      },
      botToken: TOKEN,
      onDispatch: () => {},
    })
    await gateway.start()
    expect(gateway.status().lastError).toMatch(/down/)
    await tick(1000)
    expect(sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`])
    sockets[0].open()
    hello(sockets[0])
    expect(identifies(sockets[0])[0].d.intents).toBe(1082889)
    await tick(INTERVAL / 4 - 1)
    expect(heartbeats(sockets[0])).toHaveLength(0)
    await tick(1)
    expect(heartbeats(sockets[0])).toHaveLength(1)
    expect(errors.mock.calls.flat().join('\n')).not.toContain(TOKEN)
    gateway.stop()
  })
})
