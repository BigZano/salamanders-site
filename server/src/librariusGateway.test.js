import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fc from 'fast-check'
import { createGateway, INTENTS, FATAL_CLOSE } from './librariusGateway.js'
import { createCommand } from './librariusCommand.js'
import { alongside } from './librariusDispatch.js'
import { createLibrariusDiscord } from './librariusDiscord.js'

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

// A stand-in for the client's isGatewayUrl that takes any ws:// or wss:// address: most tests here are about something other
// than where the gateway may connect, and use invented hosts. Where that is the point, the real rule is used (realRule).
const ANY_WS = (url) => /^wss?:\/\//.test(url)
// The client's own rule, for the Discord api or for the e2e mock at `apiBase`. It is not asked to reach Discord.
const realRule = (apiBase = 'https://discord.com/api') =>
  createLibrariusDiscord({ apiBase, botToken: TOKEN, guildId: '200000000000000400', fetchImpl: async () => new Response(null, { status: 599 }) }).isGatewayUrl

const tick = (ms) => vi.advanceTimersByTimeAsync(ms)
const heartbeats = (sock) => sock.sent.filter((m) => m.op === 1)
const identifies = (sock) => sock.sent.filter((m) => m.op === 2)
const resumes = (sock) => sock.sent.filter((m) => m.op === 6)

/**
 * A gateway on fake timers, with fake sockets and a fake `discord`. `plan` queues what gatewayBot() does next: an Error
 * is thrown, a function is called (for a promise the test settles itself), anything else is returned. With nothing
 * queued it answers GATEWAY with sessions left. `failures` queues what the next socket constructors throw. The fake's
 * isGatewayUrl is ANY_WS, or `over.isGatewayUrl`.
 */
function rig({ isGatewayUrl = ANY_WS, ...over } = {}) {
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
    isGatewayUrl,
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
  const good = () => ({ discord: { gatewayBot: async () => ({}), isGatewayUrl: ANY_WS }, botToken: TOKEN, onDispatch: () => {}, WebSocketImpl: FakeSocket })

  it.each([
    ['no discord', { discord: undefined }, TypeError, 'discord must have a gatewayBot function.'],
    ['a discord without gatewayBot', { discord: { isGatewayUrl: ANY_WS } }, TypeError, 'discord must have a gatewayBot function.'],
    ['a gatewayBot that is not a function', { discord: { gatewayBot: 'gatewayBot', isGatewayUrl: ANY_WS } }, TypeError, 'discord must have a gatewayBot function.'],
    ['a discord without isGatewayUrl', { discord: { gatewayBot: async () => ({}) } }, TypeError, 'discord must have an isGatewayUrl function.'],
    ['an isGatewayUrl that is not a function', { discord: { gatewayBot: async () => ({}), isGatewayUrl: true } }, TypeError, 'discord must have an isGatewayUrl function.'],
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
          isGatewayUrl: ANY_WS,
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

describe("the addresses it connects to: Discord's own gateways only", () => {
  const LIVE = 'wss://gateway.discord.gg'
  const RESUME_LIVE = 'wss://gateway-us-east1-b.discord.gg'
  // Addresses on another host, every one of which a WebSocket would open somewhere other than Discord.
  const ELSEWHERE = [
    'wss://evil.test',
    'wss://discord.gg.evil.test',
    'wss://evildiscord.gg',
    'wss://gateway.discord.gg@evil.test',
    'wss://evil.test/gateway.discord.gg',
    'wss://evil.test?.discord.gg',
    'wss://evil.test#.discord.gg',
    'wss://evil.test\\.discord.gg',
    'wss://127.0.0.1',
    'ws://gateway.discord.gg',
  ]
  const tokenTo = (sockets) => sockets.filter((s) => s.raw.some((text) => text.includes(TOKEN))).map((s) => s.url)

  it('identifies on the address gatewayBot gave, and resumes on the one READY gave, when they are on discord.gg', async () => {
    const r = rig({ isGatewayUrl: realRule() })
    r.plan.push({ url: LIVE, remaining: 1000, resetAfterMs: 0 })
    const sock = await ready(r, { url: RESUME_LIVE })
    expect(identifies(sock)).toHaveLength(1)
    sock.drop(1006)
    await tick(1000)
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(r.sockets.map((s) => s.url)).toEqual([`${LIVE}${QUERY}`, `${RESUME_LIVE}${QUERY}`])
    expect(resumes(next)).toEqual([{ op: 6, d: { token: TOKEN, session_id: SESSION, seq: 1 } }])
  })

  it.each(ELSEWHERE)('keeps no session to resume on %s, which READY gave, and identifies afresh through gatewayBot', async (url) => {
    const r = rig({ isGatewayUrl: realRule() })
    r.plan.push({ url: LIVE, remaining: 1000, resetAfterMs: 0 }, { url: LIVE, remaining: 1000, resetAfterMs: 0 })
    const sock = await ready(r, { url })
    expect(r.gateway.status().state).toBe('ready')
    sock.drop(1006)
    await tick(1000)
    expect(r.calls()).toBe(2)
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(r.sockets.map((s) => s.url)).toEqual([`${LIVE}${QUERY}`, `${LIVE}${QUERY}`])
    expect(resumes(next)).toEqual([])
    expect(identifies(next)).toHaveLength(1)
    expect(tokenTo(r.sockets)).toEqual([`${LIVE}${QUERY}`, `${LIVE}${QUERY}`])
  })

  it.each(ELSEWHERE)('opens no socket to %s, which gatewayBot gave, and asks again after the backoff', async (url) => {
    const r = rig({ isGatewayUrl: realRule() })
    r.plan.push({ url, remaining: 1000, resetAfterMs: 0 }, { url, remaining: 1000, resetAfterMs: 0 }, { url: LIVE, remaining: 1000, resetAfterMs: 0 })
    await r.gateway.start()
    expect(r.sockets).toEqual([])
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toBe("The Librarius gateway could not connect: Error: Discord named a gateway that is not one of Discord's own.")
    await tick(1000)
    expect(r.calls()).toBe(2)
    expect(r.sockets).toEqual([])
    await tick(2000)
    expect(r.calls()).toBe(3)
    expect(r.sockets.map((s) => s.url)).toEqual([`${LIVE}${QUERY}`])
  })

  it('does not wait out the session window for an address it would not open', async () => {
    const r = rig({ isGatewayUrl: realRule() })
    r.plan.push({ url: 'wss://evil.test', remaining: 0, resetAfterMs: 5000 })
    await r.gateway.start()
    await tick(5000)
    expect(r.sockets).toEqual([])
    expect(r.gateway.status().lastError).toMatch(/not one of Discord's own/)
  })

  it("connects to and resumes on the e2e mock's own host over ws://, by the rule for a mock apiBase", async () => {
    const r = rig({ isGatewayUrl: realRule('http://discord-mock:4400') })
    r.plan.push({ url: 'ws://discord-mock:4400/gateway', remaining: 1000, resetAfterMs: 0 })
    const sock = await ready(r, { url: 'ws://discord-mock:4400/gateway' })
    sock.drop(1006)
    await tick(1000)
    expect(r.sockets.map((s) => s.url)).toEqual([`ws://discord-mock:4400/gateway${QUERY}`, `ws://discord-mock:4400/gateway${QUERY}`])
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(resumes(next)).toHaveLength(1)
  })

  it("keeps no session to resume on another host than the e2e mock's", async () => {
    const r = rig({ isGatewayUrl: realRule('http://discord-mock:4400') })
    r.plan.push({ url: 'ws://discord-mock:4400/gateway', remaining: 1000, resetAfterMs: 0 }, { url: 'ws://discord-mock:4400/gateway', remaining: 1000, resetAfterMs: 0 })
    const sock = await ready(r, { url: 'ws://elsewhere:4400/gateway' })
    sock.drop(1006)
    await tick(1000)
    expect(r.sockets.map((s) => s.url)).toEqual([`ws://discord-mock:4400/gateway${QUERY}`, `ws://discord-mock:4400/gateway${QUERY}`])
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(identifies(next)).toHaveLength(1)
  })

  it("holds every address it opens to the client's rule, whatever the rule is", async () => {
    // A rule that takes only the second address: the first, from gatewayBot, is never opened, and the one READY gives
    // is never resumed on.
    const r = rig({ isGatewayUrl: (url) => url === 'wss://two.test' })
    r.plan.push({ url: 'wss://one.test', remaining: 1000, resetAfterMs: 0 }, { url: 'wss://two.test', remaining: 1000, resetAfterMs: 0 })
    r.plan.push({ url: 'wss://two.test', remaining: 1000, resetAfterMs: 0 })
    await r.gateway.start()
    expect(r.sockets).toEqual([])
    await tick(1000)
    const sock = r.sockets[0]
    sock.open()
    hello(sock)
    sock.receive({ op: 0, t: 'READY', s: 1, d: { session_id: SESSION, resume_gateway_url: 'wss://one.test' } })
    sock.drop(1006)
    await tick(2000)
    expect(r.sockets.map((s) => s.url)).toEqual([`wss://two.test${QUERY}`, `wss://two.test${QUERY}`])
  })
})

describe('the address a socket is opened on: built from the parsed, URL-encoded parts of the one Discord sent', () => {
  // The address as it was built before: the text Discord sent, its trailing slashes cut off, and the query after it.
  // Every ordinary address still comes out exactly so.
  const before = (base) => `${base.replace(/\/+$/, '')}${QUERY}`
  // A rule that takes anything, so that what is tested here is how the gateway builds an address that a client's rule
  // has let through. The rule itself is tested above, and in librariusDiscord.
  const ANYTHING = () => true
  // What encodeURIComponent leaves as it is.
  const PLAIN = /^[A-Za-z0-9_.!~*'()-]*$/
  const DISCORD_HOST = /^(?:[a-z\d-]+\.)*discord\.gg$/
  const refusal = (why) => `The Librarius gateway could not connect: TypeError: A gateway address must be ${why}`

  /** A gateway under a rule that takes anything, started on `url` as gatewayBot gives it. */
  async function startedOn(url) {
    const r = rig({ isGatewayUrl: ANYTHING })
    r.plan.push({ url, remaining: 1000, resetAfterMs: 0 })
    await r.gateway.start()
    return r
  }

  /** A gateway under a rule that takes anything, made ready with `url` as READY's resume address, then dropped. */
  async function resumingOn(url) {
    const r = rig({ isGatewayUrl: ANYTHING })
    const sock = await ready(r, { url })
    sock.drop(1006)
    await tick(1000)
    return r
  }

  // A host of DNS labels in lower case, a port that is not the scheme's own, and a path of segments of characters that
  // neither the URL parser nor encodeURIComponent changes (and no `.` or `..` segment, which the parser resolves).
  const ordinaryAddress = () => {
    const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/).filter((l) => !l.startsWith('xn--'))
    const segment = fc.string({ unit: fc.constantFrom(...("ABCXYZabcxyz0189-_.!~*'()")), maxLength: 8 }).filter((s) => s !== '.' && s !== '..')
    return fc
      .record({
        scheme: fc.constantFrom('ws', 'wss'),
        labels: fc.array(label, { minLength: 1, maxLength: 4 }),
        port: fc.option(fc.integer({ min: 0, max: 65535 }), { nil: null }),
        segments: fc.array(segment, { maxLength: 4 }),
        trailing: fc.nat(3),
      })
      .filter(({ scheme, port }) => port !== (scheme === 'wss' ? 443 : 80))
      .map(({ scheme, labels, port, segments, trailing }) =>
        `${scheme}://${labels.join('.')}${port === null ? '' : `:${port}`}${segments.map((s) => `/${s}`).join('')}${'/'.repeat(trailing)}`,
      )
  }

  // Any text at all, and text after a scheme made of the pieces an address that smuggles a host would be made of.
  const anyAddress = () => {
    const pieces = [
      'a', 'b', 'Z', '0', '9', '.', '-', '_', '~', '@', ':', '/', '\\', '?', '#', '[', ']', '%', '%2e', '%2E', '%40', '%5B', '%3A',
      '%2F', '%00', ' ', '\t', '\n', '\r', '\u0000', '$', '&', '+', ',', ';', '=', '"', '{', '}', '`', "'", '(', ')', '*', '!',
      '|', '^', '<', '>', '．', '。', 'ı', 'ß', 'і', 'á', '­', '​', '�', '\ud800',
      'discord.gg', 'evil.test', '443', '65536', 'xn--', '::1',
    ]
    const schemes = ['wss://', 'ws://', 'WSS://', 'wss:', 'wss:/', 'wss:\\\\', 'wss:///', ' wss://', 'https://', 'http://', 'blob:wss://', '']
    return fc.oneof(
      fc.string({ unit: 'grapheme', maxLength: 40 }),
      fc.tuple(fc.constantFrom(...schemes), fc.string({ unit: fc.constantFrom(...pieces), maxLength: 30 })).map(([scheme, rest]) => scheme + rest),
    )
  }

  it('opens every ordinary address exactly as it was opened before: scheme, host, port and path, without trailing slashes', async () => {
    await fc.assert(
      fc.asyncProperty(ordinaryAddress(), async (base) => {
        const r = await startedOn(base)
        expect(r.sockets.map((s) => s.url)).toEqual([before(base)])
        r.gateway.stop()
      }),
      { numRuns: 300 },
    )
  })

  it('resumes on every ordinary address exactly as it resumed before', async () => {
    await fc.assert(
      fc.asyncProperty(ordinaryAddress(), async (base) => {
        const r = await resumingOn(base)
        expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`, before(base)])
        r.gateway.stop()
      }),
      { numRuns: 100 },
    )
  })

  it("names, for any text, the very host the text names and no other, with no user part or fragment and only the gateway's query", async () => {
    await fc.assert(
      fc.asyncProperty(anyAddress(), async (raw) => {
        const r = await startedOn(raw)
        const parsed = URL.canParse(raw) ? new URL(raw) : null
        if (parsed === null || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')) {
          // Text that is not a ws:// or wss:// address opens nothing: the try fails, and is tried again after the backoff.
          expect(r.sockets).toEqual([])
          expect(r.gateway.status().state).toBe('waiting')
          expect(r.gateway.status().lastError).toBe(refusal(parsed === null ? 'a URL.' : 'of the ws or wss scheme.'))
          r.gateway.stop()
          return
        }
        expect(r.sockets).toHaveLength(1)
        const address = r.sockets[0].url
        // Printable ASCII only: nothing a WebSocket would strip out of it, or read as the end of it.
        expect(address).toMatch(/^[!-~]+$/)
        expect(address.startsWith(`${parsed.protocol}//`)).toBe(true)
        expect(address.endsWith(QUERY)).toBe(true)
        const { hostname } = parsed
        const port = parsed.port === '' ? '' : `:${parsed.port}`
        if (hostname.startsWith('[')) {
          // An IPv6 literal. A socket is made, but on an address that holds the host percent-encoded (its brackets and
          // colons are written out), which does not parse: a WebSocket refuses it, and nothing is ever sent.
          expect(address.startsWith(`${parsed.protocol}//${hostname}`)).toBe(false)
          expect(URL.canParse(address)).toBe(false)
          r.gateway.stop()
          return
        }
        if (PLAIN.test(hostname)) {
          // The host is written as the parser read it, and the port and a slash come straight after it.
          expect(address.startsWith(`${parsed.protocol}//${hostname}${port}/`)).toBe(true)
        } else {
          // The host holds characters a host may hold but encodeURIComponent writes out ($, &, +, a comma, ;, =, ", {, },
          // `). A socket is made, and the host in its address differs from the input's: it is percent-encoded.
          expect(address.startsWith(`${parsed.protocol}//${hostname}`)).toBe(false)
        }
        // Read back, the address names the very host and port the text did (the parser decodes what was encoded), and
        // nothing else: no user part, no fragment, and the gateway's query only.
        const back = new URL(address)
        expect(back.protocol).toBe(parsed.protocol)
        expect(back.hostname).toBe(hostname)
        expect(back.port).toBe(parsed.port)
        expect(back.username).toBe('')
        expect(back.password).toBe('')
        expect(back.hash).toBe('')
        expect(back.search).toBe('?v=10&encoding=json')
        r.gateway.stop()
      }),
      { numRuns: 600 },
    )
  })

  it("sends the token, under the client's real rule, only to Discord's hosts, whatever READY gives as the resume address", async () => {
    const around = ['', '@', '#', '?', '/', '\\', '.', ':443', '%2e', '%40', '\t', '\r', ' ', 'evil.test', 'gateway.', '．', '[::1]']
    const address = fc
      .tuple(
        fc.constantFrom('wss://', 'ws://', 'WSS://', 'wss:', 'wss:///'),
        fc.array(fc.constantFrom(...around), { maxLength: 4 }),
        fc.constantFrom('discord.gg', 'gateway.discord.gg', 'gateway-us-east1-b.discord.gg', 'evil.test'),
        fc.array(fc.constantFrom(...around), { maxLength: 4 }),
      )
      .map(([scheme, lead, host, tail]) => `${scheme}${lead.join('')}${host}${tail.join('')}`)
    await fc.assert(
      fc.asyncProperty(address, async (url) => {
        const r = rig({ isGatewayUrl: realRule() })
        const LIVE = { url: 'wss://gateway.discord.gg', remaining: 1000, resetAfterMs: 0 }
        r.plan.push(LIVE, LIVE)
        const sock = await ready(r, { url })
        sock.drop(1006)
        await tick(1000)
        const next = r.sockets.at(-1)
        next.open()
        hello(next)
        expect(r.sockets).toHaveLength(2)
        for (const s of r.sockets.filter((s) => s.raw.some((text) => text.includes(TOKEN)))) {
          const { protocol, hostname } = new URL(s.url)
          expect(protocol).toBe('wss:')
          expect(hostname).toMatch(DISCORD_HOST)
        }
        // A resume address the rule took is resumed on, on the host it names.
        if (resumes(next).length) expect(new URL(next.url).hostname).toBe(new URL(url).hostname)
        r.gateway.stop()
      }),
      { numRuns: 300 },
    )
  })

  // [what it holds, the address Discord sent, the address a socket is opened on, or null for none]
  const hostile = [
    ['a user part that names Discord before another host', 'wss://gateway.discord.gg@evil.test', `wss://evil.test${QUERY}`],
    ['a user and a password', 'wss://member:secret@one.test:9000/gateway', `wss://one.test:9000/gateway${QUERY}`],
    ['an empty user part', 'wss://@one.test', `wss://one.test${QUERY}`],
    ['a backslash before an @', 'wss://evil.test\\@gateway.discord.gg', `wss://evil.test/%40gateway.discord.gg${QUERY}`],
    ['a fragment that names another host', 'wss://gateway.discord.gg#@evil.test', `wss://gateway.discord.gg${QUERY}`],
    ['a query that names another host', 'wss://gateway.discord.gg?x=@evil.test', `wss://gateway.discord.gg${QUERY}`],
    ['a query of its own', 'wss://one.test/?v=6&encoding=etf', `wss://one.test${QUERY}`],
    ['a path that names another host', 'wss://gateway.discord.gg/@evil.test', `wss://gateway.discord.gg/%40evil.test${QUERY}`],
    ['a colon and an @ in the path', 'wss://one.test/a:b@c', `wss://one.test/a%3Ab%40c${QUERY}`],
    ['percent-encoded dots in the host', 'wss://gateway%2Ediscord%2egg', `wss://gateway.discord.gg${QUERY}`],
    ['a percent-encoded @ in the host', 'wss://gateway.discord.gg%40evil.test', null],
    ['a percent-encoded colon in the host', 'wss://one.test%3A9000', null],
    ['a percent-encoded slash in the host', 'wss://evil.test%2F.discord.gg', null],
    ['fullwidth letters', 'wss://ｇａｔｅｗａｙ.discord.gg', `wss://gateway.discord.gg${QUERY}`],
    ['a fullwidth full stop', 'wss://evil.test．discord.gg', `wss://evil.test.discord.gg${QUERY}`],
    ['an ideographic full stop', 'wss://gateway。discord.gg', `wss://gateway.discord.gg${QUERY}`],
    ['a Cyrillic letter that looks like a Latin one', 'wss://gateway.dіscord.gg', `wss://gateway.xn--dscord-pvf.gg${QUERY}`],
    ['an accented letter', 'wss://gáteway.discord.gg', `wss://xn--gteway-pta.discord.gg${QUERY}`],
    ['an IDNA host in punycode', 'wss://xn--gteway-pta.discord.gg', `wss://xn--gteway-pta.discord.gg${QUERY}`],
    ['a soft hyphen, which IDNA drops', 'wss://gate­way.discord.gg', `wss://gateway.discord.gg${QUERY}`],
    ['a host in upper case', 'wss://Gateway.Discord.GG', `wss://gateway.discord.gg${QUERY}`],
    ['a scheme in upper case', 'WSS://one.test', `wss://one.test${QUERY}`],
    ['no slashes after the scheme', 'wss:one.test', `wss://one.test${QUERY}`],
    ['backslashes after the scheme', 'ws:\\\\one.test', `ws://one.test${QUERY}`],
    ['no host', 'wss://', null],
    ['three slashes before the host', 'wss:///x', `wss://x${QUERY}`],
    ['a port and no host', 'wss://:443', null],
    ['a user part and no host', 'wss://member@', null],
    ['port 0', 'wss://one.test:0', `wss://one.test:0${QUERY}`],
    ['port 65535', 'wss://one.test:65535', `wss://one.test:65535${QUERY}`],
    ['port 65536', 'wss://one.test:65536', null],
    ['a port of letters', 'wss://one.test:abc', null],
    ['a port with a letter after it', 'wss://one.test:12a', null],
    ['a negative port', 'wss://one.test:-1', null],
    ['a port with a leading zero', 'wss://one.test:08080', `wss://one.test:8080${QUERY}`],
    ["wss's own port, which goes without saying", 'wss://one.test:443', `wss://one.test${QUERY}`],
    ["ws's own port, which goes without saying", 'ws://one.test:80', `ws://one.test${QUERY}`],
    ["wss's port on ws", 'ws://one.test:443', `ws://one.test:443${QUERY}`],
    ['a tab in the host', 'wss://gate\tway.discord.gg', `wss://gateway.discord.gg${QUERY}`],
    ['a newline in the host', 'wss://gate\nway.discord.gg', `wss://gateway.discord.gg${QUERY}`],
    ['a carriage return before an @', 'wss://gateway.discord.gg\r@evil.test', `wss://evil.test${QUERY}`],
    ['a space in the host', 'wss://gate way.discord.gg', null],
    ['a NUL in the host', 'wss://gate\u0000way.discord.gg', null],
    ['a NUL before an @', 'wss://gateway.discord.gg\u0000@evil.test', `wss://evil.test${QUERY}`],
    ['spaces around it', '  wss://one.test  ', `wss://one.test${QUERY}`],
    ['a space in the path, which the parser escapes and the escape is encoded', 'wss://one.test/a b', `wss://one.test/a%2520b${QUERY}`],
    ['an IPv4 address', 'wss://127.0.0.1:9000', `wss://127.0.0.1:9000${QUERY}`],
    ['an IPv4 address in hex', 'wss://0x7f.1', `wss://127.0.0.1${QUERY}`],
    ['dot segments in the path', 'wss://one.test/a/../../b/./c', `wss://one.test/b/c${QUERY}`],
    ["the e2e mock's address with a slash after it", 'ws://discord-mock:4400/gateway/', `ws://discord-mock:4400/gateway${QUERY}`],
    ['an https address', 'https://one.test', null],
    ['an http address', 'http://one.test', null],
    ['a file address', 'file:///etc/passwd', null],
    ['a javascript address', 'javascript:alert(1)', null],
    ['a blob of a wss address', 'blob:wss://one.test', null],
    ['an empty string', '', null],
    ['a scheme word alone', 'wss', null],
  ]
  const why = (url) => (URL.canParse(url) ? 'of the ws or wss scheme.' : 'a URL.')

  it.each(hostile)('opens, for an address with %s, only the parsed host, or nothing', async (_what, url, expected) => {
    const r = await startedOn(url)
    if (expected === null) {
      expect(r.sockets).toEqual([])
      expect(r.gateway.status().state).toBe('waiting')
      expect(r.gateway.status().lastError).toBe(refusal(why(url)))
      // It is a failure like any other: the next try asks gatewayBot again, after the backoff.
      await tick(1000)
      expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`])
      return
    }
    expect(r.sockets.map((s) => s.url)).toEqual([expected])
    expect(new URL(expected).hostname).toBe(new URL(url).hostname)
    const sock = r.sockets[0]
    sock.open()
    hello(sock)
    expect(identifies(sock)).toHaveLength(1)
  })

  it.each(hostile)('resumes, on a resume address with %s, on the parsed host only, or not at all', async (_what, url, expected) => {
    const r = await resumingOn(url)
    if (expected === null) {
      expect(r.sockets).toHaveLength(1)
      expect(r.gateway.status().state).toBe('waiting')
      expect(r.gateway.status().lastError).toBe(refusal(why(url)))
      expect(resumes(r.sockets[0])).toEqual([])
      return
    }
    expect(r.sockets.map((s) => s.url)).toEqual([`${GATEWAY}${QUERY}`, expected])
    const next = r.sockets[1]
    next.open()
    hello(next)
    expect(resumes(next)).toEqual([{ op: 6, d: { token: TOKEN, session_id: SESSION, seq: 1 } }])
  })

  it.each([
    ['a number', () => 5],
    ['null', () => null],
    ['nothing', () => undefined],
    ['a list holding an address', () => ['wss://one.test']],
    ['an object that prints as an address', () => ({ toString: () => 'wss://one.test' })],
    ['a String object', () => new String('wss://one.test')],
    ['a URL object', () => new URL('wss://one.test')],
  ])('opens nothing for an address that is %s, even when the rule takes it', async (_what, make) => {
    const r = await startedOn(make())
    expect(r.sockets).toEqual([])
    expect(r.gateway.status().state).toBe('waiting')
    expect(r.gateway.status().lastError).toBe(refusal('text.'))
  })

  it('keeps the host of a very long address, and only that host', async () => {
    const long = `wss://${`${'a'.repeat(63)}.`.repeat(4)}test${'/x'.repeat(50_000)}`
    const label = `wss://${'b'.repeat(100_000)}.test:9000`
    const users = `wss://${'gateway.discord.gg@'.repeat(10_000)}evil.test`
    const r = await startedOn(long)
    expect(r.sockets.map((s) => s.url)).toEqual([before(long)])
    const s = await startedOn(label)
    expect(s.sockets.map((sock) => sock.url)).toEqual([before(label)])
    const t = await startedOn(users)
    expect(t.sockets.map((sock) => sock.url)).toEqual([`wss://evil.test${QUERY}`])
  })

  it('fails closed on an IPv6 literal: its brackets are encoded, so the address does not parse and a WebSocket refuses it', async () => {
    const r = await startedOn('wss://[::1]:9000/gateway')
    expect(r.sockets.map((s) => s.url)).toEqual([`wss://%5B%3A%3A1%5D:9000/gateway${QUERY}`])
    expect(URL.canParse(r.sockets[0].url)).toBe(false)

    // A socket that, like a real WebSocket, throws a SyntaxError for an address it cannot parse.
    const made = []
    class Parsing extends FakeSocket {
      constructor(url) {
        if (!URL.canParse(url)) throw new SyntaxError('The address cannot be parsed.')
        super(url)
        made.push(this)
      }
    }
    const p = rig({ isGatewayUrl: ANYTHING, WebSocketImpl: Parsing })
    p.plan.push({ url: 'wss://[::1]', remaining: 1000, resetAfterMs: 0 })
    await p.gateway.start()
    expect(made).toEqual([])
    expect(p.gateway.status().state).toBe('waiting')
    expect(p.gateway.status().lastError).toBe('The Librarius gateway could not connect: SyntaxError: The address cannot be parsed.')
    await tick(1000)
    expect(made.map((sock) => sock.url)).toEqual([`${GATEWAY}${QUERY}`])
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

  it("takes a ws:// resume address as well as a wss:// one, when the client's rule does", async () => {
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
        isGatewayUrl: ANY_WS,
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

describe('INTERACTION_CREATE: handed over at once, outside the queue of the other events', () => {
  // A client whose onDispatch holds HANG_THING until the test settles it, and answers everything else at once. It records when each event began.
  function slow(over = {}) {
    const began = []
    const calls = []
    const r = rig({
      onDispatch: (t, d) => {
        began.push([t, Date.now()])
        if (t === 'HANG_THING') return new Promise((resolve, reject) => calls.push({ resolve, reject }))
        if (t === 'HANG_INTERACTION') return new Promise((resolve, reject) => calls.push({ resolve, reject }))
        if (t === 'INTERACTION_CREATE' && d?.fail) throw new Error('the command broke')
      },
      ...over,
    })
    return { r, began, calls }
  }
  const event = (sock, t, s, d = {}) => sock.receive({ op: 0, t, s, d })
  const names = (began) => began.map(([t]) => t)

  it('begins at once, with (t, d) as any event, while an earlier event is still being handled', async () => {
    const { r, began } = slow()
    const sock = await ready(r)
    event(sock, 'HANG_THING', 2)
    await tick(0)
    event(sock, 'INTERACTION_CREATE', 3, { id: 'invented', type: 2 })
    await tick(0)
    expect(names(began)).toEqual(['READY', 'HANG_THING', 'INTERACTION_CREATE'])
  })

  it('begins at once behind a whole backlog: events that are each given up on only after 15 seconds', async () => {
    const { r, began } = slow()
    const sock = await ready(r)
    event(sock, 'HANG_THING', 2)
    event(sock, 'HANG_THING', 3)
    event(sock, 'HANG_THING', 4)
    await tick(5_000)
    const at = Date.now()
    event(sock, 'INTERACTION_CREATE', 5, {})
    await tick(0)
    const [, when] = began.find(([t]) => t === 'INTERACTION_CREATE')
    expect(when).toBe(at)
    // The queue itself is still where it was: the first hung event is the only one begun.
    expect(names(began).filter((t) => t === 'HANG_THING')).toHaveLength(1)
  })

  it('does not hold up the events behind it, nor wait for them, and leaves the others in their order', async () => {
    const order = []
    const done = {}
    const r = rig({
      onDispatch: (t) =>
        new Promise((resolve) => {
          order.push(`${t} begins`)
          done[t] = () => {
            order.push(`${t} ends`)
            resolve()
          }
        }),
    })
    const sock = await ready(r)
    done.READY()
    await tick(0)
    event(sock, 'A_THING', 2)
    event(sock, 'INTERACTION_CREATE', 3)
    event(sock, 'B_THING', 4)
    await tick(0)
    // The interaction begins the moment it comes, and A_THING is begun and waited for; B_THING waits for A_THING, not for the interaction.
    expect(order.slice(0, 2)).toEqual(['READY begins', 'READY ends'])
    expect(order.slice(2).sort()).toEqual(['A_THING begins', 'INTERACTION_CREATE begins'])
    done.A_THING()
    await tick(0)
    expect(order.slice(4)).toEqual(['A_THING ends', 'B_THING begins'])
    done.INTERACTION_CREATE()
    done.B_THING()
    await tick(0)
    expect(order.slice(6)).toEqual(['INTERACTION_CREATE ends', 'B_THING ends'])
  })

  it('begins each one at once, however many come together', async () => {
    const { r, began } = slow()
    const sock = await ready(r)
    for (let i = 0; i < 5; i++) event(sock, 'INTERACTION_CREATE', 2 + i, { n: i })
    await tick(0)
    expect(names(began)).toEqual(['READY', ...Array(5).fill('INTERACTION_CREATE')])
  })

  it('is given up on after 15 seconds like any handler, which is recorded, and a hung event in the line does not stop it', async () => {
    const { r, began } = slow()
    const sock = await ready(r)
    event(sock, 'HANG_THING', 2)
    event(sock, 'INTERACTION_CREATE', 3, {})
    await tick(DISPATCH_TIMEOUT - 1)
    expect(r.gateway.status().lastError).toBeNull()
    await tick(1)
    expect(r.gateway.status().lastError).toMatch(/took too long on HANG_THING/)
    expect(names(began).sort()).toEqual(['HANG_THING', 'INTERACTION_CREATE', 'READY'])
  })

  it('has its own 15 seconds, counted from when it begins, and says which event it is that took too long', async () => {
    const r = rig({ onDispatch: (t) => (t === 'INTERACTION_CREATE' ? new Promise(() => {}) : undefined) })
    const sock = await ready(r)
    await tick(3_000)
    event(sock, 'INTERACTION_CREATE', 2, {})
    await tick(DISPATCH_TIMEOUT - 1)
    expect(r.gateway.status().lastError).toBeNull()
    await tick(1)
    expect(r.gateway.status().lastError).toMatch(/took too long on INTERACTION_CREATE/)
    expect(r.gateway.status().state).toBe('ready')
  })

  it('is recorded when its handler fails, and the events after it are handled all the same', async () => {
    const { r, began } = slow()
    const sock = await ready(r)
    event(sock, 'INTERACTION_CREATE', 2, { fail: true })
    event(sock, 'NEXT_THING', 3)
    await tick(0)
    expect(r.gateway.status().lastError).toMatch(/could not handle INTERACTION_CREATE: Error: the command broke/)
    expect(names(began)).toEqual(['READY', 'INTERACTION_CREATE', 'NEXT_THING'])
    expect(r.gateway.status().state).toBe('ready')
  })

  it('is recorded, without crashing, when the timers fail while its handler is waited for', async () => {
    const jobs = []
    const timers = {
      setTimeout: (fn, ms) => jobs.push({ fn, ms }) - 1,
      clearTimeout: (id) => {
        if (jobs[id]?.ms === DISPATCH_TIMEOUT) throw new Error('the timer is broken')
      },
    }
    const seen = []
    const r = rig({ timers, onDispatch: (t) => seen.push(t) })
    const sock = await opened(r)
    hello(sock)
    event(sock, 'INTERACTION_CREATE', 1)
    await tick(0)
    expect(seen).toEqual(['INTERACTION_CREATE'])
    expect(r.gateway.status().lastError).toMatch(/could not finish handling INTERACTION_CREATE: Error: the timer is broken/)
    expect(r.gateway.status().state).toBe('connecting')
  })

  it('moves the sequence number on like any event', async () => {
    const r = rig({ onDispatch: () => new Promise(() => {}) })
    const sock = await ready(r)
    event(sock, 'INTERACTION_CREATE', 7)
    await tick(FIRST_BEAT)
    expect(heartbeats(sock).at(-1)).toEqual({ op: 1, d: 7 })
  })

  it('is handled after a stop when it came before it, as any event is', async () => {
    const r = rig()
    const sock = await ready(r)
    event(sock, 'INTERACTION_CREATE', 2)
    r.gateway.stop()
    await tick(0)
    expect(r.dispatched.map(([t]) => t)).toEqual(['READY', 'INTERACTION_CREATE'])
  })

  it('is the only type that does not wait: a type that only looks like it stands in the queue', async () => {
    const { r, began } = slow()
    const sock = await ready(r)
    event(sock, 'HANG_THING', 2)
    for (const [i, t] of ['INTERACTION_CREATE ', 'interaction_create', 'INTERACTION_UPDATE', 'MESSAGE_CREATE'].entries()) event(sock, t, 3 + i)
    await tick(0)
    expect(names(began)).toEqual(['READY', 'HANG_THING'])
  })
})

describe('"Delete on site" is answered within its budget however busy the gateway and the client are', () => {
  // The whole path: the gateway, the dispatch that runs the command beside the live feed, the command, and the real client of Discord's
  // REST API, all on fake timers. Every id here is invented.
  const APP_GUILD = '200000000000000400'
  const POST = '200000000000000410'
  const MSG = '200000000000000430'
  const ME = '300000000000000101'
  const SITE = 'https://sm2salamanders.site'
  const interaction = () => ({
    id: '200000000000000490',
    application_id: '200000000000000480',
    type: 2,
    token: 'aW50ZXJhY3Rpb246_Invented-token.0123456789',
    guild_id: APP_GUILD,
    channel_id: POST,
    member: { user: { id: ME } },
    data: { id: '200000000000000481', name: 'Delete on site', type: 3, target_id: MSG, resolved: { messages: { [MSG]: { id: MSG, channel_id: POST } } } },
  })

  function wired({ store, ingest } = {}) {
    const fetched = []
    const fetchImpl = async (url, init) => {
      const callback = String(url).includes('/callback')
      fetched.push({ url: String(url), at: Date.now(), headers: init.headers, body: init.body })
      return new Response(callback ? null : '{}', { status: callback ? 204 : 200 })
    }
    const discord = createLibrariusDiscord({ fetchImpl, apiBase: 'https://d.test/api', botToken: 'secret-bot-token', guildId: APP_GUILD, perSecond: 1 })
    const command = createCommand({ discord, store: store ?? { messageOfPart: async (id) => id, outboxMessage: () => new Promise(() => {}) }, guildId: APP_GUILD, repliesOn: () => true })
    const r = rig({ onDispatch: alongside(ingest ?? (() => undefined), command.dispatch, () => {}) })
    // Saturate the client: 30 calls that may each wait up to two minutes for its turn, one a second, are queued ahead of the callback.
    const busy = discord.withMaxWait(120_000)
    for (let i = 0; i < 30; i++) busy.guild().catch(() => {})
    return { r, fetched }
  }
  const callbacks = (fetched) => fetched.filter((f) => f.url.includes('/callback'))
  const FALLBACK = `Couldn't check right now; open it on the site: ${SITE}/reliquarium/librarius/${POST}#m-${MSG}`

  it('answers at 1.5 seconds with what it could not check and the link, with the store slow, the client saturated and the queue behind a backlog', async () => {
    const { r, fetched } = wired({ ingest: (t) => (t === 'HANG_THING' ? new Promise(() => {}) : undefined) })
    const sock = await ready(r)
    for (let i = 0; i < 4; i++) sock.receive({ op: 0, t: 'HANG_THING', s: 2 + i, d: {} })
    await tick(2_000)
    const came = Date.now()
    sock.receive({ op: 0, t: 'INTERACTION_CREATE', s: 6, d: interaction() })
    await tick(1_499)
    expect(callbacks(fetched)).toEqual([])
    await tick(1)
    const [answer] = callbacks(fetched)
    expect(callbacks(fetched)).toHaveLength(1)
    expect(answer.at - came).toBe(1_500)
    expect(JSON.parse(answer.body)).toEqual({ type: 4, data: { content: FALLBACK, flags: 64, allowed_mentions: { parse: [] } } })
    expect(answer.url).toBe('https://d.test/api/v10/interactions/200000000000000490/aW50ZXJhY3Rpb246_Invented-token.0123456789/callback')
    expect(JSON.stringify(answer.headers)).not.toContain('secret-bot-token')
    r.gateway.stop()
  })

  it('answers at once, with the answer the store has, when the store is quick, whatever the queue and the client are doing', async () => {
    const { r, fetched } = wired({
      store: { messageOfPart: async (id) => id, outboxMessage: async () => ({ id: MSG, postId: POST, authorId: ME, origin: 'site' }) },
      ingest: (t) => (t === 'HANG_THING' ? new Promise(() => {}) : undefined),
    })
    const sock = await ready(r)
    sock.receive({ op: 0, t: 'HANG_THING', s: 2, d: {} })
    await tick(5_000)
    const came = Date.now()
    sock.receive({ op: 0, t: 'INTERACTION_CREATE', s: 3, d: interaction() })
    await tick(0)
    const [answer] = callbacks(fetched)
    expect(answer.at).toBe(came)
    expect(JSON.parse(answer.body).data.content).toBe(`This was written on the site. Delete it there: ${SITE}/reliquarium/librarius/${POST}#m-${MSG}`)
    r.gateway.stop()
  })
})

describe('"Delete on site" with the replies on and with them off, through the gateway and the dispatch (Ruling B12)', () => {
  // The gateway, the dispatch that runs the command beside the live feed, the command and the real client of Discord's REST API, on
  // fake timers. Every id here is invented.
  const APP_GUILD = '200000000000000400'
  const APP = '200000000000000480'
  const POST = '200000000000000410'
  const MSG = '200000000000000430'
  const ME = '300000000000000101'
  const OTHER = '300000000000000102'
  const SITE = 'https://sm2salamanders.site'
  const OFF = 'Deleting from the site is switched off right now. A moderator can delete this in Discord.'
  const DISCORD = "Written in Discord: use Discord's own Delete."
  const interaction = (n = 0) => ({
    id: `20000000000000049${n}`,
    application_id: APP,
    type: 2,
    token: `aW50ZXJhY3Rpb246_Invented-token.${n}`,
    guild_id: APP_GUILD,
    channel_id: POST,
    member: { user: { id: ME } },
    data: { id: '200000000000000481', name: 'Delete on site', type: 3, target_id: MSG, resolved: { messages: { [MSG]: { id: MSG, channel_id: POST } } } },
  })
  const message = (over) => ({ id: MSG, postId: POST, authorId: ME, origin: 'site', ...over })

  /**
   * The whole path, with the store holding `held` (or never answering) and the guild holding `commands`. The replies are `repliesOn`
   * when the command is made, and `flag.on` after that, as the outbox would say.
   */
  function wired({ repliesOn, held = message(), commands = [] }) {
    const flag = { on: repliesOn }
    const fetched = []
    const fetchImpl = async (url, init) => {
      const address = String(url)
      const method = init.method ?? 'GET'
      fetched.push({ address, method, at: Date.now(), body: init.body })
      if (address.includes('/callback')) return new Response(null, { status: 204 })
      if (method === 'POST') return Response.json({ id: '200000000000000481', name: 'Delete on site', type: 3 }, { status: 201 })
      return Response.json(address.endsWith('/commands') ? commands : {})
    }
    const discord = createLibrariusDiscord({ fetchImpl, apiBase: 'https://d.test/api', botToken: 'secret-bot-token', guildId: APP_GUILD })
    const store = { messageOfPart: async (id) => id, outboxMessage: held === 'never' ? () => new Promise(() => {}) : async (id) => (id === MSG ? held : null) }
    const fed = []
    const command = createCommand({ discord, store, guildId: APP_GUILD, repliesOn: () => flag.on })
    const r = rig({ onDispatch: alongside(async (t) => void fed.push(t), command.dispatch, () => {}) })
    return { r, fetched, fed, flag }
  }
  const COMMANDS = `https://d.test/api/v10/applications/${APP}/guilds/${APP_GUILD}/commands`
  const commandCalls = (fetched) => fetched.filter((f) => f.address === COMMANDS).map((f) => [f.method, f.body === undefined ? null : JSON.parse(f.body)])
  const answers = (fetched) => fetched.filter((f) => f.address.includes('/callback')).map((f) => JSON.parse(f.body))

  /** Opens the socket and plays HELLO and a READY that names the application, as Discord's does. */
  async function readyWithApplication(r) {
    await r.gateway.start()
    const sock = r.sockets.at(-1)
    sock.open()
    sock.receive({ op: 10, d: { heartbeat_interval: INTERVAL } })
    sock.receive({ op: 0, t: 'READY', s: 1, d: { session_id: SESSION, resume_gateway_url: RESUME, application: { id: APP } } })
    await tick(1_000)
    return sock
  }

  it('with the replies on, makes the command at READY when the guild has none, and sends a member to the site to delete their own reply', async () => {
    const { r, fetched, fed } = wired({ repliesOn: true })
    const sock = await readyWithApplication(r)
    expect(commandCalls(fetched)).toEqual([['GET', null], ['POST', { name: 'Delete on site', type: 3 }]])
    sock.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: interaction() })
    await tick(0)
    expect(answers(fetched)).toEqual([
      { type: 4, data: { content: `This was written on the site. Delete it there: ${SITE}/reliquarium/librarius/${POST}#m-${MSG}`, flags: 64, allowed_mentions: { parse: [] } } },
    ])
    expect(fed).toEqual(['READY', 'INTERACTION_CREATE'])
    r.gateway.stop()
  })

  it('with the replies off, asks Discord nothing about the command at READY, and the live feed has READY all the same', async () => {
    const { r, fetched, fed } = wired({ repliesOn: false })
    await readyWithApplication(r)
    await tick(5_000)
    expect(commandCalls(fetched)).toEqual([])
    expect(fetched.filter((f) => f.address.includes('/applications/'))).toEqual([])
    expect(fed).toEqual(['READY'])
    r.gateway.stop()
  })

  it('with the replies off, answers at once that deleting from the site is off, for the author of a reply of the site and for anyone else', async () => {
    for (const authorId of [ME, OTHER]) {
      const { r, fetched } = wired({ repliesOn: false, held: message({ authorId }) })
      const sock = await readyWithApplication(r)
      const came = Date.now()
      sock.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: interaction() })
      await tick(0)
      expect(answers(fetched), authorId).toEqual([{ type: 4, data: { content: OFF, flags: 64, allowed_mentions: { parse: [] } } }])
      expect(fetched.find((f) => f.address.includes('/callback')).at).toBe(came)
      r.gateway.stop()
    }
  })

  it('with the replies on at READY and the webhook refused since, tells the author at once that deleting from the site is off (rB11 M2)', async () => {
    const { r, fetched, flag } = wired({ repliesOn: true })
    const sock = await readyWithApplication(r)
    expect(commandCalls(fetched)).toEqual([['GET', null], ['POST', { name: 'Delete on site', type: 3 }]])
    flag.on = false
    const came = Date.now()
    sock.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: interaction() })
    await tick(0)
    expect(answers(fetched)).toEqual([{ type: 4, data: { content: OFF, flags: 64, allowed_mentions: { parse: [] } } }])
    expect(fetched.find((f) => f.address.includes('/callback')).at).toBe(came)
    r.gateway.stop()
  })

  it('with the replies off, still tells anyone that a message written in Discord is for Discord\'s own Delete', async () => {
    const { r, fetched } = wired({ repliesOn: false, held: message({ origin: 'discord', authorId: OTHER }) })
    const sock = await readyWithApplication(r)
    sock.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: interaction() })
    await tick(0)
    expect(answers(fetched).map((a) => a.data.content)).toEqual([DISCORD])
    r.gateway.stop()
  })

  it('in both states, answers at 1.5 seconds with what it could not check and the link when the store does not answer, behind a feed that hangs', async () => {
    for (const repliesOn of [true, false]) {
      const { r, fetched } = wired({ repliesOn, held: 'never' })
      const sock = await readyWithApplication(r)
      const came = Date.now()
      sock.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: interaction() })
      await tick(1_499)
      expect(answers(fetched), String(repliesOn)).toEqual([])
      await tick(1)
      const [callback] = fetched.filter((f) => f.address.includes('/callback'))
      expect(callback.at - came, String(repliesOn)).toBe(1_500)
      expect(answers(fetched).map((a) => a.data.content), String(repliesOn)).toEqual([`Couldn't check right now; open it on the site: ${SITE}/reliquarium/librarius/${POST}#m-${MSG}`])
      r.gateway.stop()
    }
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
        isGatewayUrl: ANY_WS,
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
