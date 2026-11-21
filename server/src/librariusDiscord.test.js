import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createLibrariusDiscord } from './librariusDiscord.js'
import { Upstream } from './discordRoles.js'
import { attachmentUrl } from './librariusParse.js'

// Invented ids, all in the 400-499 range. None of them is a real guild, channel or message.
const API = 'https://d.test/api'
const TOKEN = 'secret-bot-token'
const GUILD = '200000000000000400'
const FORUM = '200000000000000401'
const THREAD = '200000000000000410'
const THREAD_2 = '200000000000000411'
const MSG = '200000000000000430'
const MSG_2 = '200000000000000431'
const MSG_3 = '200000000000000432'
const AFTER = '200000000000000429'
const EMOJI = '200000000000000460'

const CDN = 'https://cdn.discordapp.com/attachments/200000000000000410/200000000000000440/map.png?ex=6540a0b3&is=653e2bb3&hm=0a1b2c'
const CDN_2 = 'https://cdn.discordapp.com/attachments/200000000000000410/200000000000000441/key.png?ex=6540a0b3&is=653e2bb3&hm=3d4e5f'
const CDN_NEW = `${CDN}&refreshed=1`
const ARCHIVED_AT = '2026-11-02T18:30:00.123000+00:00'

const thread = (id) => ({ id, type: 11, parent_id: FORUM, name: 'invented thread' })
const message = (id) => ({ id, content: 'invented', author: { id: '200000000000000412', username: 'invented' }, attachments: [] })
const GATEWAY = { url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { total: 1000, remaining: 998, reset_after: 14_400_000, max_concurrency: 1 } }

const ok = (body, headers) => ({ status: 200, body, headers })
const bucket = (name, remaining, resetAfter) => ({
  'X-RateLimit-Bucket': name,
  'X-RateLimit-Remaining': String(remaining),
  'X-RateLimit-Reset-After': String(resetAfter),
})

/**
 * A client on a fake clock, fake sleep and a fake fetch answering from a queue of replies. Every call is recorded as
 * it reaches the fetch, with the clock at that moment in `at`.
 *
 * By default `sleep` advances the clock by what it was asked for, as a real sleep would, so a wait shows up in `at`.
 * With `concurrent`, a sleep is a timer instead and the test runs the calls through `drive`, which advances the clock
 * to the next timer only once everything else has settled: an event loop on a clock the test owns. Calls made
 * together can then sleep side by side without their waits adding up.
 */
function rig(replies = [], over = {}, concurrent = false) {
  const clock = { t: 0 }
  const slept = []
  const seen = []
  const timers = []
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal, aborted: init.signal?.aborted, at: clock.t })
    const r = replies.shift()
    if (r instanceof Error) throw r
    if (r === undefined) throw new Error('the test queued no reply for this call')
    return new Response(r.raw !== undefined ? r.raw : JSON.stringify(r.body ?? null), { status: r.status, headers: r.headers })
  }
  const sleep = concurrent
    ? (ms) => {
        slept.push(ms)
        return new Promise((resolve) => timers.push({ due: clock.t + ms, resolve }))
      }
    : async (ms) => {
        slept.push(ms)
        clock.t += ms
      }
  async function drive(promise) {
    let settled = false
    const done = promise.finally(() => {
      settled = true
    })
    done.catch(() => {})
    for (let turns = 0; !settled; turns++) {
      if (turns > 10_000) throw new Error('the calls never finished')
      await new Promise((resolve) => setImmediate(resolve))
      if (settled || timers.length === 0) continue
      timers.sort((a, b) => a.due - b.due)
      const next = timers.shift()
      clock.t = Math.max(clock.t, next.due)
      next.resolve()
    }
    return done
  }
  const discord = createLibrariusDiscord({ fetchImpl, apiBase: API, botToken: TOKEN, guildId: GUILD, sleep, now: () => clock.t, ...over })
  return { discord, slept, seen, clock, drive }
}

// Every call the client makes, with what it sends, a good answer and what it makes of it. `what` is how an Upstream
// message names it. `bad` holds the 200 bodies that are the wrong shape for it.
const OBJECT_BAD = [null, [], 'text', 7, true, false]
const ARRAY_BAD = [null, {}, 'text', 7, true, { threads: [] }, [1], [null], [[]], ['text'], [true]]
const ROWS = [
  {
    name: 'gatewayBot',
    what: 'the gateway',
    call: (d) => d.gatewayBot(),
    method: 'GET',
    path: '/v10/gateway/bot',
    reply: GATEWAY,
    result: { url: 'wss://gateway.discord.gg', remaining: 998, resetAfterMs: 14_400_000 },
    bad: [
      ...OBJECT_BAD,
      {},
      { ...GATEWAY, session_start_limit: undefined },
      { ...GATEWAY, session_start_limit: null },
      { ...GATEWAY, session_start_limit: [] },
      { ...GATEWAY, session_start_limit: 'x' },
      { ...GATEWAY, url: undefined },
      { ...GATEWAY, url: 7 },
      { ...GATEWAY, url: '' },
      { ...GATEWAY, url: 'https://gateway.discord.gg' },
      { ...GATEWAY, url: 'xwss://gateway.discord.gg' },
      { ...GATEWAY, url: ['wss://gateway.discord.gg'] },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, remaining: undefined } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, remaining: null } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, remaining: '5' } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, remaining: -1 } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, remaining: 1.5 } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, remaining: 1e300 } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, reset_after: undefined } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, reset_after: null } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, reset_after: '5' } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, reset_after: -1 } },
      { ...GATEWAY, session_start_limit: { ...GATEWAY.session_start_limit, reset_after: 86_400_001 } },
      { ...GATEWAY, url: 'ws://gateway.discord.gg' },
      { ...GATEWAY, url: 'wss://gateway.test' },
    ],
  },
  {
    name: 'guild',
    what: 'the guild',
    call: (d) => d.guild(),
    method: 'GET',
    path: `/v10/guilds/${GUILD}`,
    reply: { id: GUILD, name: 'invented guild' },
    result: { id: GUILD, name: 'invented guild' },
    bad: OBJECT_BAD,
  },
  {
    name: 'channel',
    what: 'a channel',
    call: (d) => d.channel(FORUM),
    method: 'GET',
    path: `/v10/channels/${FORUM}`,
    reply: { id: FORUM, type: 15, name: 'invented forum' },
    result: { id: FORUM, type: 15, name: 'invented forum' },
    bad: OBJECT_BAD,
  },
  {
    name: 'activeThreads',
    what: 'the active threads',
    call: (d) => d.activeThreads(),
    method: 'GET',
    path: `/v10/guilds/${GUILD}/threads/active`,
    reply: { threads: [thread(THREAD), thread(THREAD_2)], members: [] },
    result: [thread(THREAD), thread(THREAD_2)],
    bad: [...OBJECT_BAD, {}, { threads: null }, { threads: {} }, { threads: 'text' }, { threads: [1] }, { threads: [null] }, { threads: [[]] }, { thread: [] }, { members: [] }],
  },
  {
    name: 'archivedThreads',
    what: 'the archived threads',
    call: (d) => d.archivedThreads(FORUM, null),
    method: 'GET',
    path: `/v10/channels/${FORUM}/threads/archived/public?limit=100`,
    reply: { threads: [thread(THREAD)], members: [], has_more: true },
    result: { threads: [thread(THREAD)], hasMore: true },
    bad: [
      ...OBJECT_BAD,
      {},
      { has_more: false },
      { threads: null, has_more: false },
      { threads: {}, has_more: false },
      { threads: 'text', has_more: false },
      { threads: [1], has_more: false },
      { threads: [null], has_more: false },
      { threads: [[]], has_more: false },
      { threads: [] },
      { threads: [], has_more: null },
      { threads: [], has_more: 'true' },
      { threads: [], has_more: 1 },
      { threads: [], has_more: 0 },
      { threads: [], has_more: {} },
    ],
  },
  {
    name: 'messagesAfter',
    what: 'a page of messages',
    call: (d) => d.messagesAfter(THREAD, AFTER, 100),
    method: 'GET',
    path: `/v10/channels/${THREAD}/messages?limit=100&after=${AFTER}`,
    reply: [message(MSG_2), message(MSG)],
    result: [message(MSG), message(MSG_2)],
    bad: ARRAY_BAD,
  },
  {
    name: 'newest',
    what: 'a page of messages',
    call: (d) => d.newest(THREAD, 100),
    method: 'GET',
    path: `/v10/channels/${THREAD}/messages?limit=100`,
    reply: [message(MSG_2), message(MSG)],
    result: [message(MSG_2), message(MSG)],
    bad: ARRAY_BAD,
  },
  {
    name: 'message',
    what: 'a message',
    call: (d) => d.message(THREAD, MSG),
    method: 'GET',
    path: `/v10/channels/${THREAD}/messages/${MSG}`,
    reply: message(MSG),
    result: message(MSG),
    bad: OBJECT_BAD,
  },
  {
    name: 'thread',
    what: 'a thread',
    call: (d) => d.thread(THREAD),
    method: 'GET',
    path: `/v10/channels/${THREAD}`,
    reply: thread(THREAD),
    result: thread(THREAD),
    bad: OBJECT_BAD,
  },
  {
    name: 'emojis',
    what: 'the emoji',
    call: (d) => d.emojis(),
    method: 'GET',
    path: `/v10/guilds/${GUILD}/emojis`,
    reply: [{ id: EMOJI, name: 'invented', animated: false }],
    result: [{ id: EMOJI, name: 'invented', animated: false }],
    bad: ARRAY_BAD,
  },
  {
    name: 'refreshUrls',
    what: 'an attachment refresh',
    call: (d) => d.refreshUrls([CDN]),
    method: 'POST',
    path: '/v10/attachments/refresh-urls',
    reply: { refreshed_urls: [{ original: CDN, refreshed: CDN_NEW }] },
    result: new Map([[CDN, CDN_NEW]]),
    bad: [
      ...OBJECT_BAD,
      {},
      { refreshed_urls: null },
      { refreshed_urls: {} },
      { refreshed_urls: 'text' },
      { refreshed_urls: [null] },
      { refreshed_urls: [[]] },
      { refreshed_urls: ['text'] },
      { refreshed_urls: [{}] },
      { refreshed_urls: [{ original: CDN }] },
      { refreshed_urls: [{ refreshed: CDN_NEW }] },
      { refreshed_urls: [{ original: 1, refreshed: CDN_NEW }] },
      { refreshed_urls: [{ original: CDN, refreshed: 1 }] },
      { refreshed_urls: [{ original: CDN, refreshed: null }] },
      { refreshed_urls: [{ original: null, refreshed: CDN_NEW }] },
      { refreshed_urls: [{ original: CDN, refreshed: CDN_NEW }, { original: CDN_2 }] },
    ],
  },
]

const leaks = (message) => message.includes('https://') || message.includes('http://') || message.includes(TOKEN) || message.includes('d.test')

describe('each call', () => {
  it.each(ROWS)('$name asks Discord for the right url, with the bot token, and answers what it makes of the reply', async (row) => {
    const r = rig([ok(row.reply)])
    expect(await row.call(r.discord)).toEqual(row.result)
    expect(r.seen).toHaveLength(1)
    expect(r.seen[0].url).toBe(`${API}${row.path}`)
    expect(r.seen[0].method).toBe(row.method)
    expect(r.seen[0].headers.Authorization).toBe('Bot secret-bot-token')
    expect(r.seen[0].signal).toBeInstanceOf(AbortSignal)
    expect(r.seen[0].aborted).toBe(false)
  })

  it.each(ROWS.filter((row) => row.method === 'GET'))('$name sends nothing but the token with a GET', async (row) => {
    const r = rig([ok(row.reply)])
    await row.call(r.discord)
    expect(r.seen[0].headers).toEqual({ Authorization: 'Bot secret-bot-token' })
    expect(r.seen[0].body).toBeUndefined()
  })

  it('refreshUrls sends the links as JSON', async () => {
    const r = rig([ok({ refreshed_urls: [] })])
    await r.discord.refreshUrls([CDN, CDN_2])
    expect(r.seen[0].headers).toEqual({ Authorization: 'Bot secret-bot-token', 'Content-Type': 'application/json' })
    expect(JSON.parse(r.seen[0].body)).toEqual({ attachment_urls: [CDN, CDN_2] })
  })

  it('keeps what it learns about Discord to itself: another client starts clean', async () => {
    const a = rig([ok([], bucket('b1', 0, 2)), ok([])])
    await a.discord.newest(THREAD, 1)
    for (let i = 0; i < 4; i++) await a.discord.newest(THREAD, 1).catch(() => {})
    const b = rig([ok([]), ok([]), ok([]), ok([]), ok([]), ok([])])
    for (let i = 0; i < 5; i++) await b.discord.newest(THREAD, 1)
    expect(b.slept).toEqual([])
  })
})

describe('gatewayBot', () => {
  const MOCK = 'http://mock.test/api'
  const reply = (url, limit = { remaining: 3, reset_after: 1000 }) => ok({ url, session_start_limit: limit })
  const unexpected = 'Discord answered 200 for the gateway, but not with what the Librarius expected.'

  it('passes the session start limit through as it is', async () => {
    const r = rig([reply('ws://mock.test:9', { remaining: 0, reset_after: 0 })], { apiBase: MOCK })
    expect(await r.discord.gatewayBot()).toEqual({ url: 'ws://mock.test:9', remaining: 0, resetAfterMs: 0 })
  })

  it('takes a reset time that is not a whole number of milliseconds', async () => {
    const r = rig([reply('wss://gateway.discord.gg', { remaining: 3, reset_after: 1234.5 })])
    expect((await r.discord.gatewayBot()).resetAfterMs).toBe(1234.5)
  })

  // The window the limit resets in is a day, so a reset further off than that is not Discord talking.
  it('takes a reset of exactly a day', async () => {
    const r = rig([reply('wss://gateway.discord.gg', { remaining: 0, reset_after: 86_400_000 })])
    expect(await r.discord.gatewayBot()).toEqual({ url: 'wss://gateway.discord.gg', remaining: 0, resetAfterMs: 86_400_000 })
  })

  it.each([86_400_001, 86_400_000.5, 604_800_000, 1e12, 1e300, Number.MAX_VALUE])('throws Upstream for a reset of %s ms, which is more than a day', async (resetAfter) => {
    const r = rig([reply('wss://gateway.discord.gg', { remaining: 3, reset_after: resetAfter })])
    const err = await r.discord.gatewayBot().catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe(unexpected)
  })

  describe('the address', () => {
    it.each(['https://discord.com/api', 'https://d.test/api', 'https://d.test', 'http', 'ftp://d.test/api'])(
      "is wss:// on Discord's own hosts only, for an apiBase of %s",
      async (apiBase) => {
        const host = apiBase.startsWith('https://') ? new URL(apiBase).host : 'd.test'
        const r = rig([reply('wss://gateway.discord.gg'), reply('ws://gateway.discord.gg'), reply('ws://localhost:9'), reply(`wss://${host}`), reply(`ws://${host}`)], { apiBase })
        expect((await r.discord.gatewayBot()).url).toBe('wss://gateway.discord.gg')
        for (let i = 0; i < 4; i++) {
          const err = await r.discord.gatewayBot().catch((e) => e)
          expect(err).toBeInstanceOf(Upstream)
          expect(err.message).toBe(unexpected)
        }
      },
    )

    // The mock serves its gateway itself, on the host the api asks it for everything else.
    it.each([
      ['http://mock.test/api', 'mock.test'],
      ['http://localhost:3000', 'localhost'],
      ['http://d.test', 'd.test'],
      ['http://discord-mock:4400', 'discord-mock'],
      ['http://[::1]:4400', '[::1]'],
    ])("is ws:// or wss:// on the mock's own host, or wss:// on Discord's, for an apiBase of %s, which is the e2e mock", async (apiBase, host) => {
      const good = [`ws://${host}:9`, `wss://${host}/gateway`, `ws://${host}:4400/gateway`, 'wss://gateway.discord.gg']
      const bad = ['ws://elsewhere.test:9', 'wss://gateway.test', `ws://${host}.evil.test`, `ws://evil.test/${host}`, 'ws://gateway.discord.gg']
      const r = rig([...good, ...bad].map((url) => reply(url)), { apiBase })
      for (const url of good) expect((await r.discord.gatewayBot()).url).toBe(url)
      for (let i = 0; i < bad.length; i++) {
        const err = await r.discord.gatewayBot().catch((e) => e)
        expect(err).toBeInstanceOf(Upstream)
        expect(err.message).toBe(unexpected)
      }
    })

    it.each([
      'wss://discord.gg',
      'wss://gateway.discord.gg',
      'wss://gateway-us-east1-b.discord.gg',
      'wss://gateway-us-east1-b.discord.gg/',
      'wss://a.b-c.discord.gg',
      'wss://gateway.discord.gg:443',
      'wss://GATEWAY.Discord.GG',
    ])('takes %s, which is discord.gg or a subdomain of it', async (url) => {
      for (const apiBase of ['https://d.test/api', MOCK]) {
        const r = rig([reply(url)], { apiBase })
        expect((await r.discord.gatewayBot()).url, apiBase).toBe(url)
      }
    })

    it.each([
      ['another host', 'wss://evil.test'],
      ['a host that only starts with discord.gg', 'wss://discord.gg.evil.test'],
      ['a host that only ends in discord.gg', 'wss://evildiscord.gg'],
      ['a host that ends in -discord.gg', 'wss://evil-discord.gg'],
      ["Discord's api host, which runs no gateway", 'wss://discord.com'],
      ["Discord's host as the user part", 'wss://gateway.discord.gg@evil.test'],
      ["Discord's host and port as the user part", 'wss://discord.gg:443@evil.test'],
      ["Discord's host in the path", 'wss://evil.test/gateway.discord.gg'],
      ["Discord's host in the query", 'wss://evil.test?.discord.gg'],
      ["Discord's host in the fragment", 'wss://evil.test#.discord.gg'],
      ["Discord's host after a backslash", 'wss://evil.test\\.discord.gg'],
      ["Discord's host after an encoded dot", 'wss://gateway.discord.gg%2eevil.test'],
      ['a trailing dot', 'wss://gateway.discord.gg.'],
      ['an empty label', 'wss://.discord.gg'],
      ['an underscore in a label', 'wss://a_b.discord.gg'],
      ['an IPv4 address', 'wss://127.0.0.1'],
      ['an IPv6 address', 'wss://[::1]'],
      ['no host', 'wss://'],
      ['a host it cannot parse', 'wss://gate way.discord.gg'],
    ])('refuses %s, whichever the apiBase is', async (_, url) => {
      for (const apiBase of ['https://d.test/api', MOCK]) {
        const r = rig([reply(url)], { apiBase })
        const err = await r.discord.gatewayBot().catch((e) => e)
        expect(err, apiBase).toBeInstanceOf(Upstream)
        expect(err.message, apiBase).toBe(unexpected)
      }
    })

    it.each([
      ['an https address', 'https://gateway.discord.gg'],
      ['an http address', 'http://gateway.discord.gg'],
      ['a ws address with one slash', 'ws:/gateway.discord.gg'],
      ['a wss address with one slash', 'wss:/gateway.discord.gg'],
      ['a wss in capitals', 'WSS://gateway.discord.gg'],
      ['a scheme that only ends in wss', 'xwss://gateway.discord.gg'],
      ['a scheme that only ends in ws', 'xws://gateway.discord.gg'],
      ['a leading space', ' wss://gateway.discord.gg'],
      ['no scheme', 'gateway.discord.gg'],
      ['nothing', ''],
      ['a list holding a good address', ['wss://gateway.discord.gg']],
      ['a number', 7],
    ])('is neither, for %s, whichever the apiBase is', async (_, url) => {
      for (const apiBase of ['https://d.test/api', MOCK]) {
        const r = rig([reply(url)], { apiBase })
        const err = await r.discord.gatewayBot().catch((e) => e)
        expect(err, apiBase).toBeInstanceOf(Upstream)
        expect(err.message, apiBase).toBe(unexpected)
      }
    })
  })
})

describe('isGatewayUrl', () => {
  // The rule gatewayBot() holds Discord's answer to, which the gateway client holds READY's resume address to as well.
  const label = fc.stringMatching(/^[a-z0-9-]{1,12}$/).filter((l) => !l.startsWith('xn--'))

  it('holds an address to the rule gatewayBot holds the answer to, and asks Discord nothing', () => {
    const live = rig()
    expect(live.discord.isGatewayUrl('wss://gateway-us-east1-b.discord.gg')).toBe(true)
    expect(live.discord.isGatewayUrl('ws://gateway.discord.gg')).toBe(false)
    expect(live.discord.isGatewayUrl('wss://evil.test')).toBe(false)
    const mock = rig([], { apiBase: 'http://discord-mock:4400' })
    expect(mock.discord.isGatewayUrl('ws://discord-mock:4400/gateway')).toBe(true)
    expect(mock.discord.isGatewayUrl('wss://gateway.discord.gg')).toBe(true)
    expect(mock.discord.isGatewayUrl('ws://elsewhere:4400/gateway')).toBe(false)
    expect(live.seen).toEqual([])
    expect(mock.seen).toEqual([])
  })

  it('is the same on the client withMaxWait gives', () => {
    const mock = rig([], { apiBase: 'http://discord-mock:4400' }).discord.withMaxWait(60_000)
    expect(mock.isGatewayUrl('ws://discord-mock:4400/gateway')).toBe(true)
    expect(mock.isGatewayUrl('ws://elsewhere:4400/gateway')).toBe(false)
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a number', 7],
    ['a list holding a good address', ['wss://gateway.discord.gg']],
    ['an object with a good href', { href: 'wss://gateway.discord.gg', toString: () => 'wss://gateway.discord.gg' }],
  ])('refuses %s, which is not text', (_, url) => {
    expect(rig().discord.isGatewayUrl(url)).toBe(false)
    expect(rig([], { apiBase: 'http://mock.test' }).discord.isGatewayUrl(url)).toBe(false)
  })

  it.each([
    ['no apiBase', undefined],
    ['an empty apiBase', ''],
    ['an apiBase that is not text', 7],
    ['an apiBase of http:// with no host', 'http://'],
  ])("holds a client with %s to Discord's own hosts over wss://", (_, apiBase) => {
    const discord = createLibrariusDiscord({ fetchImpl: async () => new Response(null), apiBase, botToken: TOKEN, guildId: GUILD })
    expect(discord.isGatewayUrl('wss://gateway.discord.gg')).toBe(true)
    for (const url of ['ws://gateway.discord.gg', 'ws://localhost:9', 'wss://localhost', 'ws://']) expect(discord.isGatewayUrl(url), url).toBe(false)
  })

  it('takes every wss:// address on discord.gg or a subdomain of it', () => {
    const { discord } = rig()
    fc.assert(
      fc.property(fc.array(label, { maxLength: 4 }), fc.option(fc.integer({ min: 1, max: 65_535 })), fc.constantFrom('', '/', '/gateway'), (labels, port, path) => {
        const url = `wss://${[...labels, 'discord', 'gg'].join('.')}${port === null ? '' : `:${port}`}${path}`
        expect(discord.isGatewayUrl(url)).toBe(true)
      }),
    )
  })

  it('takes no address that a WebSocket would open on another host, or over anything but wss://', () => {
    const { discord } = rig()
    const scheme = fc.constantFrom('wss://', 'ws://', 'wss:/', 'wss:', 'WSS://', ' wss://', 'https://', 'xwss://', '')
    const before = fc.constantFrom('', 'gateway.', 'a.b.', 'evil.test@', 'discord.gg@', 'discord.gg:443@', '.')
    const host = fc.constantFrom('discord.gg', 'discord.gg.evil.test', 'evil.test', 'xdiscord.gg', 'discord.gg.', 'discord.g', 'discord.com', '127.0.0.1', '[::1]')
    const after = fc.constantFrom('', '/', ':443', '?.discord.gg', '#.discord.gg', '\\.discord.gg', '%2eevil.test', '/../evil.test', '@evil.test', '\t.discord.gg')
    const built = fc.tuple(scheme, before, host, after).map((parts) => parts.join(''))
    const webUrl = fc.tuple(fc.constantFrom('ws', 'wss'), fc.webUrl({ withQueryParameters: true, withFragments: true })).map(([s, u]) => u.replace(/^https?/, s))
    fc.assert(
      fc.property(fc.oneof(built, webUrl, fc.string()), (url) => {
        if (!discord.isGatewayUrl(url)) return
        // What it took, as the WebSocket constructor reads it.
        const parsed = new URL(url)
        expect(parsed.protocol).toBe('wss:')
        expect(parsed.hostname === 'discord.gg' || parsed.hostname.endsWith('.discord.gg')).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })
})

describe('messagesAfter and newest', () => {
  it('messagesAfter answers oldest first, whatever the order Discord used', async () => {
    const r = rig([ok([message(MSG_3), message(MSG_2), message(MSG)])])
    expect((await r.discord.messagesAfter(THREAD, AFTER, 3)).map((m) => m.id)).toEqual([MSG, MSG_2, MSG_3])
  })

  it('newest answers newest first, as Discord gives them', async () => {
    const r = rig([ok([message(MSG_3), message(MSG_2), message(MSG)])])
    expect((await r.discord.newest(THREAD, 3)).map((m) => m.id)).toEqual([MSG_3, MSG_2, MSG])
  })

  it('both answer an empty page as an empty list', async () => {
    const r = rig([ok([]), ok([])])
    expect(await r.discord.messagesAfter(THREAD, AFTER, 10)).toEqual([])
    expect(await r.discord.newest(THREAD, 10)).toEqual([])
  })

  it('both ask for 100 messages when no limit is given', async () => {
    const r = rig([ok([]), ok([])])
    await r.discord.messagesAfter(THREAD, '0')
    await r.discord.newest(THREAD)
    expect(r.seen.map((s) => s.url)).toEqual([`${API}/v10/channels/${THREAD}/messages?limit=100&after=0`, `${API}/v10/channels/${THREAD}/messages?limit=100`])
  })

  it('messagesAfter sorts a shuffled page by id, and does not trust the order Discord used', async () => {
    const r = rig([ok([message(MSG_2), message(MSG_3), message(MSG)])])
    expect((await r.discord.messagesAfter(THREAD, AFTER, 3)).map((m) => m.id)).toEqual([MSG, MSG_2, MSG_3])
  })

  it('messagesAfter compares ids as numbers, so an id of more digits is newer whatever it spells', async () => {
    const wide = '1000000000000000000'
    const r = rig([ok([message(wide), message('999999999999999999'), message('99999999999999999')])])
    expect((await r.discord.messagesAfter(THREAD, AFTER, 3)).map((m) => m.id)).toEqual(['99999999999999999', '999999999999999999', wide])
  })

  it('messagesAfter keeps messages of one id in the order Discord gave them', async () => {
    const r = rig([ok([{ ...message(MSG_2), content: 'first' }, { ...message(MSG), content: 'only' }, { ...message(MSG_2), content: 'second' }])])
    expect((await r.discord.messagesAfter(THREAD, AFTER, 3)).map((m) => m.content)).toEqual(['only', 'first', 'second'])
  })

  it('messagesAfter answers any page sorted by id, with nothing lost and nothing added', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ id: fc.stringMatching(/^[0-9]{17,20}$/), content: fc.string() }), { maxLength: 100 }), async (page) => {
        const r = rig([ok(page)])
        const sorted = await r.discord.messagesAfter(THREAD, AFTER, 100)
        expect(sorted).toHaveLength(page.length)
        for (let i = 1; i < sorted.length; i++) expect(BigInt(sorted[i - 1].id) <= BigInt(sorted[i].id)).toBe(true)
        // The same messages, whole: sorting moves them and changes none.
        const key = (m) => `${m.id} ${m.content}`
        expect(sorted.map(key).sort()).toEqual(page.map(key).sort())
        // Equal ids keep the order they came in.
        const byId = (list) => Object.groupBy(list, (m) => BigInt(m.id).toString())
        for (const [id, group] of Object.entries(byId(page))) expect(byId(sorted)[id]).toEqual(group)
      }),
    )
  })

  // A message with no id Discord would send cannot be put in order, and a page that might be out of order is not read. Nor
  // can a page be taken for what Discord holds when an entry of it is missing: the catch-up would delete what it did not
  // find on the page, so a page that is not whole in this way is not read either, wherever the entry lies.
  describe.each([
    ['messagesAfter', (d) => d.messagesAfter(THREAD, AFTER, 100)],
    ['newest', (d) => d.newest(THREAD, 100)],
  ])('%s', (name, call) => {
    it.each([
      ['no id', {}],
      ['a number for an id', { id: 200000000000000430 }],
      ['null for an id', { id: null }],
      ['an id of 16 digits', { id: '2000000000000004' }],
      ['an id of 21 digits', { id: '200000000000000430000' }],
      ['an id with a letter', { id: '20000000000000043a' }],
      ['an id with a sign', { id: '-200000000000000430' }],
      ['an empty id', { id: '' }],
      ['a list for an id', { id: [MSG] }],
      ['text that only looks like an id', { id: 'abc' }],
    ])('throws Upstream for a page that holds a message with %s, first, in the middle or last', async (_, odd) => {
      for (const page of [[odd], [message(MSG_2), message(MSG), odd], [odd, message(MSG)], [message(MSG_3), odd, message(MSG)], [message(MSG), odd, message(MSG_2), message(MSG_3)]]) {
        const r = rig([ok(page)])
        const err = await call(r.discord).catch((e) => e)
        expect(err, `${name} ${JSON.stringify(page)}`).toBeInstanceOf(Upstream)
        expect(err.message).toBe('Discord answered 200 for a page of messages, but not with what the Librarius expected.')
      }
    })
  })

  it('newest hands back any list of messages in the order it came', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ id: fc.stringMatching(/^[0-9]{18}$/), content: fc.string() }), { maxLength: 100 }), async (page) => {
        const r = rig([ok(page)])
        expect(await r.discord.newest(THREAD, 100)).toEqual(page)
      }),
    )
  })
})

describe('archivedThreads', () => {
  it('says whether there are more, from has_more', async () => {
    const r = rig([ok({ threads: [], has_more: true }), ok({ threads: [thread(THREAD)], has_more: false })])
    expect(await r.discord.archivedThreads(FORUM, null)).toEqual({ threads: [], hasMore: true })
    expect(await r.discord.archivedThreads(FORUM, null)).toEqual({ threads: [thread(THREAD)], hasMore: false })
  })

  it('leaves out before when it is null', async () => {
    const r = rig([ok({ threads: [], has_more: false })])
    await r.discord.archivedThreads(FORUM, null)
    expect(r.seen[0].url).toBe(`${API}/v10/channels/${FORUM}/threads/archived/public?limit=100`)
  })

  it('adds before, with its characters escaped so the + of a UTC offset stays a plus', async () => {
    const r = rig([ok({ threads: [], has_more: false }), ok({ threads: [], has_more: false })])
    await r.discord.archivedThreads(FORUM, ARCHIVED_AT)
    await r.discord.archivedThreads(FORUM, '2026-11-02T18:30:00.000Z')
    expect(r.seen[0].url).toBe(`${API}/v10/channels/${FORUM}/threads/archived/public?limit=100&before=2026-11-02T18%3A30%3A00.123000%2B00%3A00`)
    expect(r.seen[1].url).toBe(`${API}/v10/channels/${FORUM}/threads/archived/public?limit=100&before=2026-11-02T18%3A30%3A00.000Z`)
  })

  it('escapes any timestamp the same way', async () => {
    await fc.assert(
      fc.asyncProperty(fc.date({ min: new Date('2016-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true }), async (when) => {
        const iso = when.toISOString()
        const r = rig([ok({ threads: [], has_more: false })])
        await r.discord.archivedThreads(FORUM, iso)
        expect(r.seen[0].url).toBe(`${API}/v10/channels/${FORUM}/threads/archived/public?limit=100&before=${encodeURIComponent(iso)}`)
      }),
    )
  })

  // A missing cursor must not read as "from the newest", or a paging loop would never end.
  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['text that is not a time', 'yesterday'],
    ['a number', 1_700_000_000_000],
    ['a Date', new Date()],
    ['an object', {}],
    ['a list', [ARCHIVED_AT]],
    ['a time with a second parameter on the end', `${ARCHIVED_AT}&limit=1`],
    ['a url', 'https://evil.test/2026-11-02T18:30:00.000Z'],
  ])('throws TypeError, without asking Discord, when before is %s', async (_, before) => {
    const r = rig()
    const err = await r.discord.archivedThreads(FORUM, before).catch((e) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err.message).toBe('before must be a time, or null.')
    expect(r.seen).toEqual([])
  })
})

describe('message', () => {
  it('answers null for a 404 whose code is 10008 (Unknown Message)', async () => {
    const r = rig([{ status: 404, body: { code: 10008, message: 'Unknown Message' } }])
    expect(await r.discord.message(THREAD, MSG)).toBeNull()
    expect(r.seen[0].url).toBe(`${API}/v10/channels/${THREAD}/messages/${MSG}`)
  })

  // Only a gone message is "gone": a gone or unreadable channel must not read as every message deleted.
  it.each([
    ['a 404 Unknown Channel (10003)', { status: 404, body: { code: 10003, message: 'Unknown Channel' } }],
    ['a 404 whose code is the text 10008', { status: 404, body: { code: '10008' } }],
    ['a 404 with a nested 10008', { status: 404, body: { error: { code: 10008 } } }],
    ['a 404 with no code', { status: 404, body: {} }],
    ['a 404 with a null body', { status: 404, body: null }],
    ['a 404 with a list body', { status: 404, body: [10008] }],
    ['a 404 with no JSON', { status: 404, raw: 'Not Found' }],
    ['a 404 with an empty body', { status: 404, raw: '' }],
    ['a 403 whose body carries the code 10008', { status: 403, body: { code: 10008 } }],
    ['a 500 whose body carries the code 10008', { status: 500, body: { code: 10008 } }],
  ])('throws Upstream, not null, on %s', async (_, reply) => {
    const r = rig([reply])
    const err = await r.discord.message(THREAD, MSG).catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toContain(String(reply.status))
  })

  it('answers a 200 as the message, whatever code its body carries', async () => {
    const r = rig([ok({ id: MSG, code: 10008 })])
    expect(await r.discord.message(THREAD, MSG)).toEqual({ id: MSG, code: 10008 })
  })
})

describe('thread', () => {
  it('answers null for a 404 whose code is 10003 (Unknown Channel)', async () => {
    const r = rig([{ status: 404, body: { code: 10003, message: 'Unknown Channel' } }])
    expect(await r.discord.thread(THREAD)).toBeNull()
    expect(r.seen[0].url).toBe(`${API}/v10/channels/${THREAD}`)
  })

  // Only a gone thread is "gone": one the bot cannot see, or a failure of Discord's, must not read as a thread deleted.
  it.each([
    ['a 404 Unknown Message (10008)', { status: 404, body: { code: 10008, message: 'Unknown Message' } }],
    ['a 404 whose code is the text 10003', { status: 404, body: { code: '10003' } }],
    ['a 404 with a nested 10003', { status: 404, body: { error: { code: 10003 } } }],
    ['a 404 with no code', { status: 404, body: {} }],
    ['a 404 with a null body', { status: 404, body: null }],
    ['a 404 with a list body', { status: 404, body: [10003] }],
    ['a 404 with no JSON', { status: 404, raw: 'Not Found' }],
    ['a 404 with an empty body', { status: 404, raw: '' }],
    ['a 403 Missing Access (50001)', { status: 403, body: { code: 50001 } }],
    ['a 403 whose body carries the code 10003', { status: 403, body: { code: 10003 } }],
    ['a 500 whose body carries the code 10003', { status: 500, body: { code: 10003 } }],
    ['a 410 whose body carries the code 10003', { status: 410, body: { code: 10003 } }],
  ])('throws Upstream, not null, on %s', async (_, reply) => {
    const r = rig([reply])
    const err = await r.discord.thread(THREAD).catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe(`Discord answered ${reply.status} for a thread.`)
  })

  it('answers a 200 as the thread, whatever code its body carries', async () => {
    const r = rig([ok({ id: THREAD, code: 10003 })])
    expect(await r.discord.thread(THREAD)).toEqual({ id: THREAD, code: 10003 })
  })

  it('treats a 429 as a retry, whose 404 is an answer', async () => {
    const r = rig([{ status: 429, headers: { 'Retry-After': '1' } }, { status: 404, body: { code: 10003 } }])
    expect(await r.discord.thread(THREAD)).toBeNull()
    expect(r.slept).toEqual([1000])
  })
})

describe('refreshUrls', () => {
  it('answers a Map from each link to its refreshed one', async () => {
    const r = rig([ok({ refreshed_urls: [{ original: CDN, refreshed: CDN_NEW }, { original: CDN_2, refreshed: `${CDN_2}&refreshed=1` }] })])
    const out = await r.discord.refreshUrls([CDN, CDN_2])
    expect(out).toBeInstanceOf(Map)
    expect([...out]).toEqual([
      [CDN, CDN_NEW],
      [CDN_2, `${CDN_2}&refreshed=1`],
    ])
  })

  it('answers only what Discord refreshed', async () => {
    const r = rig([ok({ refreshed_urls: [{ original: CDN, refreshed: CDN_NEW }] })])
    const out = await r.discord.refreshUrls([CDN, CDN_2])
    expect(out.has(CDN_2)).toBe(false)
    expect(out.size).toBe(1)
  })

  it('answers an empty Map for nothing to refresh, without asking Discord', async () => {
    const r = rig()
    const out = await r.discord.refreshUrls([])
    expect(out).toBeInstanceOf(Map)
    expect(out.size).toBe(0)
    expect(r.seen).toEqual([])
  })

  it('takes exactly 50 links at once', async () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://cdn.discordapp.com/attachments/1/2/${i}.png`)
    const r = rig([ok({ refreshed_urls: urls.map((u) => ({ original: u, refreshed: `${u}?ex=6540a0b3&hm=new` })) })])
    const out = await r.discord.refreshUrls(urls)
    expect(out.size).toBe(50)
    expect(JSON.parse(r.seen[0].body).attachment_urls).toEqual(urls)
  })

  it('throws RangeError for more than 50, without asking Discord and without naming a link', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 51, max: 200 }), async (n) => {
        const r = rig()
        const err = await r.discord.refreshUrls(Array.from({ length: n }, (_, i) => `https://cdn.discordapp.com/attachments/1/2/secret${i}.png`)).catch((e) => e)
        expect(err).toBeInstanceOf(RangeError)
        expect(err.message).toBe('At most 50 links can be refreshed at once.')
        expect(r.seen).toEqual([])
      }),
    )
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', CDN],
    ['an object', { 0: CDN, length: 1 }],
    ['a Set', new Set([CDN])],
    ['a list holding a number', [CDN, 1]],
    ['a list holding null', [null]],
    ['a list holding undefined', [undefined]],
    ['a list holding a list', [[CDN]]],
    ['a list holding an object', [{ url: CDN }]],
  ])('throws TypeError, without asking Discord, for %s', async (_, urls) => {
    const r = rig()
    const err = await r.discord.refreshUrls(urls).catch((e) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err.message).toBe('urls must be a list of strings.')
    expect(r.seen).toEqual([])
  })

  it('maps any answer Discord can give: the same links, in the same order', async () => {
    const cdn = fc.tuple(fc.nat(), fc.nat(), fc.stringMatching(/^[0-9a-f]{1,16}$/)).map(([a, b, hm]) => `https://cdn.discordapp.com/attachments/${a}/${b}/f.png?ex=${hm}&hm=${hm}`)
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.tuple(fc.webUrl(), cdn), { selector: ([original]) => original, maxLength: 50 }), async (pairs) => {
        const r = rig([ok({ refreshed_urls: pairs.map(([original, refreshed]) => ({ original, refreshed })) })])
        const out = await r.discord.refreshUrls(pairs.map(([original]) => original).concat(['https://cdn.test/asked-but-not-answered']).slice(0, 50))
        expect([...out]).toEqual(pairs)
      }),
    )
  })

  // A refreshed link is stored and handed to a browser, so it has to pass the check an attachment link passes when
  // a message is parsed. One that does not is left out, and the link the caller holds stays.
  describe('a refreshed link that is not on the Discord CDN attachments path', () => {
    const OFF = [
      'https://evil.test/attachments/1/2/a.png',
      'https://cdn.discordapp.com.evil.test/attachments/1/2/a.png',
      'https://xcdn.discordapp.com/attachments/1/2/a.png',
      'https://cdn.discordapp.com@evil.test/attachments/1/2/a.png',
      'https://cdn.discordapp.com:8443/attachments/1/2/a.png',
      'https://user:pw@cdn.discordapp.com/attachments/1/2/a.png',
      'http://cdn.discordapp.com/attachments/1/2/a.png',
      'https://media.discordapp.net/attachments/1/2/a.png',
      'https://cdn.discordapp.com/avatars/1/2.png',
      'https://cdn.discordapp.com/attachments',
      'https://cdn.discordapp.com/ephemeral-attachments/1/2/a.png',
      'https://cdn.discordapp.com/attachments/../avatars/1/2.png',
      'https://cdn.discordapp.com/attachments/%2e%2e/avatars/1/2.png',
      'HTTPS://CDN.DISCORDAPP.COM/attachments/1/2/a.png',
      ' https://cdn.discordapp.com/attachments/1/2/a.png',
      '//cdn.discordapp.com/attachments/1/2/a.png',
      'javascript:alert(1)//https://cdn.discordapp.com/attachments/',
      '',
      'not a url',
    ]

    it.each(OFF)('is absent from the Map, with the link next to it kept: %j', async (off) => {
      const r = rig([ok({ refreshed_urls: [{ original: CDN, refreshed: off }, { original: CDN_2, refreshed: CDN_NEW }] })])
      const out = await r.discord.refreshUrls([CDN, CDN_2])
      expect(out.has(CDN)).toBe(false)
      expect([...out]).toEqual([[CDN_2, CDN_NEW]])
    })

    it('leaves an empty Map, and no error, when none of them is on it', async () => {
      const r = rig([ok({ refreshed_urls: OFF.map((refreshed, i) => ({ original: `${CDN}&n=${i}`, refreshed })) })])
      const out = await r.discord.refreshUrls([CDN])
      expect(out).toBeInstanceOf(Map)
      expect(out.size).toBe(0)
    })

    it('does not look at the original: only the link that would be stored', async () => {
      const r = rig([ok({ refreshed_urls: [{ original: 'https://evil.test/anything', refreshed: CDN_NEW }] })])
      expect([...(await r.discord.refreshUrls([CDN]))]).toEqual([['https://evil.test/anything', CDN_NEW]])
    })
  })

  it('answers the link as the parser would normalise it, so that what is checked is what is stored', async () => {
    const r = rig([ok({ refreshed_urls: [{ original: CDN, refreshed: 'https://cdn.discordapp.com/attachments/1/2/a\t.png?ex=6540a0b3' }] })])
    expect([...(await r.discord.refreshUrls([CDN]))]).toEqual([[CDN, 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=6540a0b3']])
  })

  it('keeps exactly the links the attachment check accepts, as it normalises them', async () => {
    const links = fc.oneof(
      fc.string(),
      fc.string().map((tail) => `https://cdn.discordapp.com/attachments/${tail}`),
      fc.string().map((tail) => `https://cdn.discordapp.com/${tail}`),
      fc.constantFrom(CDN_NEW, 'https://cdn.discordapp.com/attachments/', 'https://cdn.discordapp.com/attachments/../x'),
    )
    await fc.assert(
      fc.asyncProperty(fc.array(links, { maxLength: 20 }), async (refreshed) => {
        const entries = refreshed.map((link, i) => ({ original: `${CDN}&n=${i}`, refreshed: link }))
        const r = rig([ok({ refreshed_urls: entries })])
        const out = await r.discord.refreshUrls([CDN])
        const expected = entries.flatMap((e) => (attachmentUrl(e.refreshed) === null ? [] : [[e.original, attachmentUrl(e.refreshed)]]))
        expect([...out]).toEqual(expected)
      }),
    )
  })
})

describe('arguments', () => {
  const BAD_IDS = [
    ['an empty string', ''],
    ['a space', ' '],
    ['letters', 'abc'],
    ['16 digits', '2000000000000004'],
    ['21 digits', '200000000000000401234'],
    ['a letter among the digits', '20000000000000040a'],
    ['a path', `${FORUM}/../${GUILD}`],
    ['a query', `${FORUM}?limit=1`],
    ['a fragment', `${FORUM}#x`],
    ['a trailing space', `${FORUM} `],
    ['a leading space', ` ${FORUM}`],
    ['a trailing newline', `${FORUM}\n`],
    ['a sign', `-${FORUM}`],
    ['a decimal point', '2000000000000004.01'],
    ['full-width digits', '２００００００００００００００４０１'],
    ['a url with the token', `https://evil.test/${TOKEN}`],
    ['a number', 200000000000000401],
    ['a bigint', 200000000000000401n],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['a list holding the id', [FORUM]],
    ['an object that prints as an id', { toString: () => FORUM }],
  ]

  const WITH_CHANNEL = [
    ['channel', (d, id) => d.channel(id), { id: 'x' }, 'channelId must be a Discord id.'],
    ['messagesAfter', (d, id) => d.messagesAfter(id, AFTER, 100), [], 'channelId must be a Discord id.'],
    ['newest', (d, id) => d.newest(id, 100), [], 'channelId must be a Discord id.'],
    ['archivedThreads', (d, id) => d.archivedThreads(id, null), { threads: [], has_more: false }, 'forumId must be a Discord id.'],
    ['thread', (d, id) => d.thread(id), { id: 'x' }, 'threadId must be a Discord id.'],
    ['message (channel)', (d, id) => d.message(id, MSG), { id: 'x' }, 'channelId must be a Discord id.'],
    ['message (id)', (d, id) => d.message(THREAD, id), { id: 'x' }, 'messageId must be a Discord id.'],
  ]

  describe.each(WITH_CHANNEL)('%s', (_, call, good, message) => {
    it.each(BAD_IDS)('throws TypeError, without asking Discord, for an id that is %s', async (__, id) => {
      const r = rig()
      const err = await call(r.discord, id).catch((e) => e)
      expect(err).toBeInstanceOf(TypeError)
      expect(err.message).toBe(message)
      expect(r.seen).toEqual([])
    })

    it.each(['200000000000000401', '12345678901234567', '12345678901234567890', '00000000000000000'])('takes %s', async (id) => {
      const r = rig([ok(good)])
      await call(r.discord, id)
      expect(r.seen).toHaveLength(1)
      expect(r.seen[0].url).toContain(id)
    })
  })

  it('takes any string of 17 to 20 digits as an id, and puts it in the url as it is', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[0-9]{17,20}$/), async (id) => {
        const r = rig([ok({ id }), ok([])])
        await r.discord.channel(id)
        await r.discord.newest(id, 1)
        expect(r.seen.map((s) => s.url)).toEqual([`${API}/v10/channels/${id}`, `${API}/v10/channels/${id}/messages?limit=1`])
      }),
    )
  })

  it('throws TypeError for anything else that is not a string of 17 to 20 digits', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.stringMatching(/^[0-9]{0,16}$/), fc.stringMatching(/^[0-9]{21,30}$/), fc.anything()), async (id) => {
        fc.pre(!(typeof id === 'string' && /^\d{17,20}$/.test(id)))
        const r = rig()
        const errs = await Promise.all([r.discord.channel(id), r.discord.thread(id), r.discord.newest(id, 1), r.discord.message(id, MSG), r.discord.message(THREAD, id)].map((p) => p.catch((e) => e)))
        for (const err of errs) expect(err).toBeInstanceOf(TypeError)
        expect(r.seen).toEqual([])
      }),
    )
  })

  describe('afterId', () => {
    it.each(['0', '1', '200000000000000429', '99999999999999999999', '000'])('takes %s', async (after) => {
      const r = rig([ok([])])
      await r.discord.messagesAfter(THREAD, after, 5)
      expect(r.seen[0].url).toBe(`${API}/v10/channels/${THREAD}/messages?limit=5&after=${after}`)
    })

    it.each([
      ['an empty string', ''],
      ['null', null],
      ['undefined', undefined],
      ['a number', 0],
      ['a bigint', 5n],
      ['21 digits', '123456789012345678901'],
      ['letters', 'latest'],
      ['a parameter on the end', '0&limit=1'],
      ['a sign', '-1'],
      ['a decimal point', '1.5'],
      ['a space', '1 '],
      ['a trailing newline', '1\n'],
      ['a list', ['1']],
    ])('throws TypeError, without asking Discord, for an after that is %s', async (_, after) => {
      const r = rig()
      const err = await r.discord.messagesAfter(THREAD, after, 5).catch((e) => e)
      expect(err).toBeInstanceOf(TypeError)
      expect(err.message).toBe('afterId must be a message id, or 0.')
      expect(r.seen).toEqual([])
    })
  })

  describe('limit', () => {
    const CALLS = [
      ['messagesAfter', (d, limit) => d.messagesAfter(THREAD, AFTER, limit), (limit) => `?limit=${limit}&after=${AFTER}`],
      ['newest', (d, limit) => d.newest(THREAD, limit), (limit) => `?limit=${limit}`],
    ]

    describe.each(CALLS)('%s', (_, call, query) => {
      it.each([1, 2, 50, 99, 100])('takes %i', async (limit) => {
        const r = rig([ok([])])
        await call(r.discord, limit)
        expect(r.seen[0].url).toBe(`${API}/v10/channels/${THREAD}/messages${query(limit)}`)
      })

      it('takes every whole number from 1 to 100', async () => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (limit) => {
            const r = rig([ok([])])
            await call(r.discord, limit)
            expect(r.seen[0].url).toBe(`${API}/v10/channels/${THREAD}/messages${query(limit)}`)
          }),
        )
      })

      it.each([
        ['0', 0],
        ['-1', -1],
        ['101', 101],
        ['1.5', 1.5],
        ['0.5', 0.5],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['a huge number', 1e21],
        ['the text 5', '5'],
        ['the text 100', '100'],
        ['null', null],
        ['true', true],
        ['a list', [5]],
        ['an object', {}],
        ['a bigint', 5n],
      ])('throws RangeError, without asking Discord, for %s', async (__, limit) => {
        const r = rig()
        const err = await call(r.discord, limit).catch((e) => e)
        expect(err).toBeInstanceOf(RangeError)
        expect(err.message).toBe('limit must be a whole number from 1 to 100.')
        expect(r.seen).toEqual([])
      })

      it('throws RangeError for every other number', async () => {
        await fc.assert(
          fc.asyncProperty(fc.oneof(fc.double(), fc.integer(), fc.integer({ min: 101, max: 1_000_000 }), fc.integer({ min: -1_000_000, max: 0 })), async (limit) => {
            fc.pre(!(Number.isInteger(limit) && limit >= 1 && limit <= 100))
            const r = rig()
            const err = await call(r.discord, limit).catch((e) => e)
            expect(err).toBeInstanceOf(RangeError)
            expect(r.seen).toEqual([])
          }),
        )
      })
    })
  })
})

describe('a reply that is not what Discord sends', () => {
  const STATUSES = [201, 204, 301, 302, 400, 401, 403, 404, 405, 408, 410, 415, 500, 502, 503, 504]

  it.each(ROWS)('$name throws Upstream for any other status, even with a good body, and tries once', async (row) => {
    for (const status of STATUSES) {
      const r = rig([{ status, raw: status === 204 ? null : JSON.stringify(row.reply) }])
      const err = await row.call(r.discord).catch((e) => e)
      expect(err, `status ${status}`).toBeInstanceOf(Upstream)
      expect(err.message, `status ${status}`).toBe(`Discord answered ${status} for ${row.what}.`)
      expect(r.seen, `status ${status}`).toHaveLength(1)
    }
  })

  it.each(ROWS)('$name throws Upstream, naming nothing from the reply, when a 200 is the wrong shape', async (row) => {
    for (const body of row.bad) {
      const r = rig([ok(body)])
      const err = await row.call(r.discord).catch((e) => e)
      expect(err, JSON.stringify(body)).toBeInstanceOf(Upstream)
      expect(err.message, JSON.stringify(body)).toBe(`Discord answered 200 for ${row.what}, but not with what the Librarius expected.`)
    }
  })

  it.each(ROWS)('$name throws Upstream when a 200 is not JSON at all', async (row) => {
    for (const raw of ['not json', '', '{"threads":', '<html>https://cdn.discordapp.com/x</html>', null]) {
      const r = rig([{ status: 200, raw }])
      const err = await row.call(r.discord).catch((e) => e)
      expect(err, String(raw)).toBeInstanceOf(Upstream)
      expect(err.message, String(raw)).toBe(`Discord answered 200 for ${row.what}, but not with what the Librarius expected.`)
    }
  })

  it.each(ROWS)('$name never repeats what the reply said', async (row) => {
    const echo = `${CDN} ${TOKEN} Bot ${TOKEN}`
    for (const reply of [{ status: 500, raw: echo }, { status: 200, raw: echo }, { status: 403, body: { message: echo } }]) {
      const r = rig([reply])
      const err = await row.call(r.discord).catch((e) => e)
      expect(err).toBeInstanceOf(Upstream)
      expect(err.message).not.toContain('hm=0a1b2c')
      expect(err.message).not.toContain('cdn.discordapp.com')
      expect(leaks(err.message)).toBe(false)
    }
  })
})

describe('Discord being unreachable', () => {
  it.each(ROWS)('$name throws Upstream without the original message, which can carry the url or the token', async (row) => {
    const r = rig([new TypeError(`fetch failed for ${API}/${TOKEN}`)])
    const err = await row.call(r.discord).catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe('Discord is unreachable.')
    expect(err.cause).toBeUndefined()
  })

  it('throws Upstream when the fetch itself throws before answering', async () => {
    const r = rig([], {
      fetchImpl: () => {
        throw new Error(`boom ${TOKEN}`)
      },
    })
    const err = await r.discord.guild().catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe('Discord is unreachable.')
  })

  it('gives up on a call that takes longer than timeoutMs', async () => {
    const r = rig([], {
      timeoutMs: 20,
      fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    })
    const err = await r.discord.guild().catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe('Discord is unreachable.')
  })

  it('starts the timeout when the call is sent, not while it waits its turn', async () => {
    // perSecond 1 makes the second call wait for the first one's second; this sleep really takes longer than timeoutMs.
    const clock = { t: 0 }
    const r = rig([ok({ id: GUILD }), ok({ id: GUILD })], {
      timeoutMs: 30,
      perSecond: 1,
      now: () => clock.t,
      sleep: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        clock.t += ms
      },
    })
    await r.discord.guild()
    await r.discord.guild()
    expect(r.seen.map((s) => s.aborted)).toEqual([false, false])
  })

  it('gives each try its own timeout, so a retry after a long wait is not already out of time', async () => {
    const r = rig([{ status: 429, headers: { 'Retry-After': '1' } }, ok({ id: GUILD })], { timeoutMs: 30 })
    await r.discord.guild()
    expect(r.seen[1].signal).not.toBe(r.seen[0].signal)
    expect(r.seen[1].signal).toBeInstanceOf(AbortSignal)
  })
})

describe('not configured', () => {
  const FIELDS = ['apiBase', 'botToken', 'guildId']
  const BAD = [
    ['empty', ''],
    ['missing', undefined],
    ['null', null],
    ['a number', 123],
    ['a list', ['x']],
  ]

  it.each(FIELDS.flatMap((field) => BAD.map(([how, value]) => [field, how, value])))('%s %s: every call throws Upstream, without asking Discord', async (field, _, value) => {
    for (const row of ROWS) {
      const r = rig([], { [field]: value })
      const err = await row.call(r.discord).catch((e) => e)
      expect(err, row.name).toBeInstanceOf(Upstream)
      expect(err.message, row.name).toBe('Librarius reads are not configured.')
      expect(r.seen, row.name).toEqual([])
      expect(r.slept, row.name).toEqual([])
    }
  })

  // The guild id goes into the url, so one that is not an id is as good as missing. A number or a list that prints as
  // an id is not one either.
  it.each([
    ['a number', 200000000000000400],
    ['a bigint', 200000000000000400n],
    ['a list holding the id', [GUILD]],
    ['an object that prints as the id', { toString: () => GUILD }],
  ])('a guild id that is %s throws Upstream, without asking Discord', async (_, guildId) => {
    for (const row of ROWS) {
      const r = rig([], { guildId })
      const err = await row.call(r.discord).catch((e) => e)
      expect(err, row.name).toBeInstanceOf(Upstream)
      expect(err.message, row.name).toBe('Librarius reads are not configured.')
      expect(r.seen, row.name).toEqual([])
    }
  })


  it.each(['guild', '12345', `${GUILD}/../x`, `${GUILD}?a=1`, `${GUILD}\n`, ' ', '123456789012345678901'])('a guild id of %j throws Upstream, without asking Discord', async (guildId) => {
    for (const row of ROWS) {
      const r = rig([], { guildId })
      const err = await row.call(r.discord).catch((e) => e)
      expect(err, row.name).toBeInstanceOf(Upstream)
      expect(err.message, row.name).toBe('Librarius reads are not configured.')
      expect(r.seen, row.name).toEqual([])
    }
  })

  it('does not ask until it is called', async () => {
    const r = rig([ok({ id: GUILD })])
    expect(r.seen).toEqual([])
  })
})

describe('a 429', () => {
  it.each(ROWS)('$name waits Retry-After seconds once, then asks again the same way', async (row) => {
    const r = rig([{ status: 429, headers: { 'Retry-After': '2' } }, ok(row.reply)])
    expect(await row.call(r.discord)).toEqual(row.result)
    expect(r.slept).toEqual([2000])
    expect(r.seen).toHaveLength(2)
    expect(r.seen[1].url).toBe(r.seen[0].url)
    expect(r.seen[1].method).toBe(r.seen[0].method)
    expect(r.seen[1].body).toBe(r.seen[0].body)
    expect(r.seen[1].headers).toEqual(r.seen[0].headers)
    expect(r.seen[1].at).toBe(2000)
  })

  it.each(ROWS)('$name throws Upstream on a second 429, having waited once and asked twice', async (row) => {
    const r = rig([
      { status: 429, headers: { 'Retry-After': '1' } },
      { status: 429, headers: { 'Retry-After': '1' } },
    ])
    const err = await row.call(r.discord).catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe('Discord is rate limiting the Librarius.')
    expect(r.slept).toEqual([1000])
    expect(r.seen).toHaveLength(2)
  })

  it('does not ask a third time after a 429 and a 500: the 500 is the answer', async () => {
    const r = rig([{ status: 429 }, { status: 500, raw: 'oops' }, ok({ id: GUILD })])
    const err = await r.discord.guild().catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toContain('500')
    expect(r.seen).toHaveLength(2)
  })

  it('treats a 429 as a retry even for message(), whose 404 is an answer', async () => {
    const r = rig([{ status: 429, headers: { 'Retry-After': '1' } }, { status: 404, body: { code: 10008 } }])
    expect(await r.discord.message(THREAD, MSG)).toBeNull()
    expect(r.slept).toEqual([1000])
  })

  it.each([
    ['0', 0],
    ['0.25', 250],
    ['0.001', 1],
    ['1', 1000],
    ['2', 2000],
    ['2.5', 2500],
    ['29.9', 29_900],
    ['30', 30_000],
    ['30.5', 30_000],
    ['31', 30_000],
    ['3600', 30_000],
    ['1e9', 30_000],
    ['1e1', 10_000],
    ['  4  ', 4000],
    ['3 seconds', 3000],
  ])('waits for a Retry-After of %j for %i ms', async (header, ms) => {
    const r = rig([{ status: 429, headers: { 'Retry-After': header } }, ok({ id: GUILD })])
    await r.discord.guild()
    expect(r.slept).toEqual([ms])
  })

  it.each([
    ['missing', {}],
    ['empty', { 'Retry-After': '' }],
    ['not a number', { 'Retry-After': 'soon' }],
    ['a date', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }],
    ['negative', { 'Retry-After': '-5' }],
    ['negative zero point five', { 'Retry-After': '-0.5' }],
    ['infinite', { 'Retry-After': 'Infinity' }],
    ['negative infinite', { 'Retry-After': '-Infinity' }],
    ['NaN', { 'Retry-After': 'NaN' }],
  ])('waits a second when Retry-After is %s', async (_, headers) => {
    const r = rig([{ status: 429, headers }, ok({ id: GUILD })])
    await r.discord.guild()
    expect(r.slept).toEqual([1000])
  })

  it('waits Retry-After seconds, up to 30, whatever it is', async () => {
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 0, max: 1e7, noNaN: true }), async (seconds) => {
        const r = rig([{ status: 429, headers: { 'Retry-After': String(seconds) } }, ok({ id: GUILD })])
        await r.discord.guild()
        expect(r.slept).toEqual([Math.min(seconds, 30) * 1000])
      }),
    )
  })

  it('lets go of the body of a 429 it retries', async () => {
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('slow down'))
      },
      cancel() {
        cancelled = true
      },
    })
    const r = rig([{ status: 429, raw: body, headers: { 'Retry-After': '1' } }, ok({ id: GUILD })])
    await r.discord.guild()
    expect(cancelled).toBe(true)
  })

  it('copes with a 429 that has no body at all', async () => {
    const r = rig([{ status: 429, raw: null, headers: { 'Retry-After': '1' } }, ok({ id: GUILD })])
    expect(await r.discord.guild()).toEqual({ id: GUILD })
  })

  it('counts the retry toward the calls a second', async () => {
    const r = rig([{ status: 429, headers: { 'Retry-After': '0.25' } }, ok({ id: GUILD })], { perSecond: 1 })
    await r.discord.guild()
    // The first try at 0, the Retry-After wait to 250, then the rest of the second, to 1000.
    expect(r.slept).toEqual([250, 750])
    expect(r.seen.map((s) => s.at)).toEqual([0, 1000])
  })

  it('waits out the bucket too, when the 429 names one that is empty for longer', async () => {
    const r = rig([{ status: 429, headers: { 'Retry-After': '1', ...bucket('b1', 0, 5) } }, ok({ id: GUILD })])
    await r.discord.guild()
    expect(r.slept).toEqual([1000, 4000])
    expect(r.seen.map((s) => s.at)).toEqual([0, 5000])
  })
})

describe('buckets', () => {
  const page = (headers) => ok([], headers)

  it('sleeps Reset-After seconds before the next call to a bucket that has none left', async () => {
    const r = rig([page(bucket('b1', 0, 2.5)), page()])
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([])
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([2500])
    expect(r.seen.map((s) => s.at)).toEqual([0, 2500])
  })

  it('does not sleep before a call to a bucket that has some left', async () => {
    const r = rig([page(bucket('b1', 1, 2.5)), page(bucket('b1', 4, 2.5)), page()])
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([])
  })

  it('does not sleep before another bucket, or before a route it has not seen', async () => {
    const r = rig([page(bucket('b1', 0, 2)), ok({ id: GUILD }, bucket('b2', 3, 1)), ok({ id: GUILD }), ok({ id: THREAD })])
    await r.discord.newest(THREAD, 1)
    // The guild has a bucket of its own, with some left, and the channel has none that Discord has named yet.
    await r.discord.guild()
    await r.discord.guild()
    await r.discord.channel(THREAD)
    expect(r.slept).toEqual([])
  })

  it('does not know a route is in a bucket until it has seen it answer', async () => {
    const r = rig([page(bucket('b1', 0, 2)), ok(message(MSG))])
    await r.discord.newest(THREAD, 1)
    await r.discord.message(THREAD, MSG)
    expect(r.slept).toEqual([])
  })

  it('shares what it learns between a list and a page of the same channel, which are one route', async () => {
    const r = rig([page(bucket('b1', 0, 2)), page(), page()])
    await r.discord.newest(THREAD, 5)
    await r.discord.messagesAfter(THREAD, AFTER, 5)
    expect(r.slept).toEqual([2000])
  })

  it('treats every message of a channel as one route', async () => {
    const r = rig([ok(message(MSG), bucket('b1', 0, 2)), ok(message(MSG_2), bucket('b1', 0, 3)), ok(message(MSG_3))])
    await r.discord.message(THREAD, MSG)
    await r.discord.message(THREAD, MSG_2)
    await r.discord.message(THREAD, MSG_3)
    expect(r.slept).toEqual([2000, 3000])
  })

  it('keeps one channel apart from another, though they carry the same bucket name', async () => {
    const r = rig([page(bucket('b1', 3, 2)), page(bucket('b1', 0, 2)), page(), page()])
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD_2, 1)
    // THREAD_2 has none left. THREAD, which Discord counts apart, has three.
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([])
    await r.discord.newest(THREAD_2, 1)
    expect(r.slept).toEqual([2000])
  })

  it('keeps a guild apart from a channel, though they carry the same bucket name', async () => {
    const r = rig([ok([], bucket('b1', 0, 2)), page(bucket('b1', 3, 2)), page(), ok([])])
    await r.discord.emojis()
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([])
    await r.discord.emojis()
    expect(r.slept).toEqual([2000])
  })

  it('shares a bucket between two routes of one channel that Discord counts together', async () => {
    const r = rig([ok(message(MSG), bucket('b1', 4, 2)), page(bucket('b1', 0, 2)), ok(message(MSG_2))])
    await r.discord.message(THREAD, MSG)
    await r.discord.newest(THREAD, 1)
    await r.discord.message(THREAD, MSG_2)
    expect(r.slept).toEqual([2000])
  })

  it('keeps two routes of one channel apart when Discord names different buckets', async () => {
    const r = rig([ok(message(MSG), bucket('b1', 4, 2)), page(bucket('b2', 0, 2)), ok(message(MSG_2))])
    await r.discord.message(THREAD, MSG)
    await r.discord.newest(THREAD, 1)
    await r.discord.message(THREAD, MSG_2)
    expect(r.slept).toEqual([])
  })

  it('sleeps only what is left of Reset-After', async () => {
    const r = rig([page(bucket('b1', 0, 2)), page(), page(), page()])
    await r.discord.newest(THREAD, 1)
    r.clock.t = 1500
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([500])
    // The sleep brought the clock to the moment the bucket reopens: the next call has nothing to wait for.
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([500])
  })

  it('does not sleep once Reset-After has passed, to the millisecond', async () => {
    const r = rig([page(bucket('b1', 0, 2)), page()])
    await r.discord.newest(THREAD, 1)
    r.clock.t = 2000
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([])
  })

  it('sleeps a millisecond when one is left', async () => {
    const r = rig([page(bucket('b1', 0, 2)), page()])
    await r.discord.newest(THREAD, 1)
    r.clock.t = 1999
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([1])
  })

  it('counts Reset-After from the clock it is given', async () => {
    const clock = { t: 100 }
    const r = rig([page(bucket('b1', 0, 2)), page()], { now: () => clock.t })
    await r.discord.newest(THREAD, 1)
    clock.t = 1000
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([1100])
  })

  it('does not wait for a bucket that is empty without a name', async () => {
    const r = rig([page({ 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '2' }), page()])
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([])
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a number', 'none'],
    ['more than none', '1'],
    ['a fraction', '0.5'],
  ])('does not wait when Remaining is %s', async (_, remaining) => {
    const headers = { 'X-RateLimit-Bucket': 'b1', 'X-RateLimit-Reset-After': '2' }
    if (remaining !== undefined) headers['X-RateLimit-Remaining'] = remaining
    const r = rig([page(headers), page()])
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([])
  })

  it.each([
    ['0', 2000],
    ['0.0', 2000],
    ['00', 2000],
  ])('waits when Remaining is %s', async (remaining, ms) => {
    const r = rig([page({ 'X-RateLimit-Bucket': 'b1', 'X-RateLimit-Remaining': remaining, 'X-RateLimit-Reset-After': '2' }), page()])
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([ms])
  })

  it.each([
    ['0', 0],
    ['0.512', 512],
    ['1', 1000],
    ['2.5', 2500],
    ['30', 30_000],
    ['31', 30_000],
    ['3600', 30_000],
    ['1e9', 30_000],
  ])('waits for a Reset-After of %j for %i ms', async (header, ms) => {
    const r = rig([page(bucket('b1', 0, header)), page()])
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual(ms === 0 ? [] : [ms])
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a number', 'soon'],
    ['negative', '-3'],
    ['infinite', 'Infinity'],
  ])('waits a second when Reset-After is %s, and the bucket is empty', async (_, reset) => {
    const headers = { 'X-RateLimit-Bucket': 'b1', 'X-RateLimit-Remaining': '0' }
    if (reset !== undefined) headers['X-RateLimit-Reset-After'] = reset
    const r = rig([page(headers), page()])
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([1000])
  })

  it('waits Reset-After seconds, up to 30, whatever it is', async () => {
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 0.001, max: 1e7, noNaN: true }), async (seconds) => {
        const r = rig([page(bucket('b1', 0, seconds)), page()])
        await r.discord.newest(THREAD, 1)
        await r.discord.newest(THREAD, 1)
        expect(r.slept).toEqual([Math.min(seconds, 30) * 1000])
      }),
    )
  })

  it('learns again from every answer: a bucket that has reopened is not held', async () => {
    const r = rig([page(bucket('b1', 0, 1)), page(bucket('b1', 0, 3)), page()])
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([1000, 3000])
  })

  it('moves a route to the bucket Discord last named for it', async () => {
    const r = rig([page(bucket('b1', 0, 2)), page(bucket('b2', 3, 2)), page()])
    await r.discord.newest(THREAD, 1)
    // Waits for b1, which the route is still in, and learns that the route is now in b2.
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([2000])
    // b1 is still empty, but this route has moved to b2, which has some left.
    r.clock.t = 0
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([2000])
  })

  it('learns from a refused call too', async () => {
    const r = rig([{ status: 403, body: {}, headers: bucket('b1', 0, 2) }, page()])
    await r.discord.newest(THREAD, 1).catch(() => {})
    await r.discord.newest(THREAD, 1)
    expect(r.slept).toEqual([2000])
  })

  it('waits before a POST that has none left, but not before a GET', async () => {
    const r = rig([ok({ refreshed_urls: [] }, bucket('b1', 0, 2)), ok({ id: GUILD }), ok({ refreshed_urls: [] })])
    await r.discord.refreshUrls([CDN])
    await r.discord.guild()
    expect(r.slept).toEqual([])
    await r.discord.refreshUrls([CDN])
    expect(r.slept).toEqual([2000])
  })
})

describe('calls a second', () => {
  const guild = (r) => r.discord.guild()
  const goods = (n) => Array.from({ length: n }, () => ok({ id: GUILD }))

  it('lets five calls go out in one second without waiting', async () => {
    const r = rig(goods(5))
    for (let i = 0; i < 5; i++) await guild(r)
    expect(r.slept).toEqual([])
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 0, 0, 0])
  })

  it('makes the sixth call wait out the second', async () => {
    const r = rig(goods(6))
    for (let i = 0; i < 6; i++) await guild(r)
    expect(r.slept).toEqual([1000])
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 0, 0, 0, 1000])
  })

  it('makes the sixth call wait only for what is left of the second', async () => {
    const r = rig(goods(6))
    for (let i = 0; i < 5; i++) {
      await guild(r)
      r.clock.t += 100
    }
    await guild(r)
    expect(r.slept).toEqual([500])
    expect(r.seen.map((s) => s.at)).toEqual([0, 100, 200, 300, 400, 1000])
  })

  it('counts the second from the oldest of the last five, not the newest', async () => {
    const r = rig(goods(7))
    for (let i = 0; i < 5; i++) await guild(r)
    r.clock.t = 900
    await guild(r)
    // The sixth went at 1000, when the first of the five was a second old. So was the second of them: the seventh goes too.
    await guild(r)
    expect(r.slept).toEqual([100])
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 0, 0, 0, 1000, 1000])
  })

  it('does not wait when the oldest of the last five is exactly a second old', async () => {
    const r = rig(goods(6))
    for (let i = 0; i < 5; i++) await guild(r)
    r.clock.t = 1000
    await guild(r)
    expect(r.slept).toEqual([])
  })

  it('waits one millisecond when the oldest is 999 ms old', async () => {
    const r = rig(goods(6))
    for (let i = 0; i < 5; i++) await guild(r)
    r.clock.t = 999
    await guild(r)
    expect(r.slept).toEqual([1])
  })

  it('holds back the eleventh call a second more', async () => {
    const r = rig(goods(11))
    for (let i = 0; i < 11; i++) await guild(r)
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 2000])
  })

  it('takes the number of calls a second from perSecond', async () => {
    const r = rig(goods(5), { perSecond: 2 })
    for (let i = 0; i < 5; i++) await guild(r)
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 1000, 1000, 2000])
  })

  it('takes a perSecond of one', async () => {
    const r = rig(goods(3), { perSecond: 1 })
    for (let i = 0; i < 3; i++) await guild(r)
    expect(r.seen.map((s) => s.at)).toEqual([0, 1000, 2000])
  })

  it('takes a large perSecond', async () => {
    const r = rig(goods(40), { perSecond: 40 })
    for (let i = 0; i < 40; i++) await guild(r)
    expect(r.slept).toEqual([])
  })

  it('counts every kind of call', async () => {
    const r = rig([ok({ id: GUILD }), ok([]), ok([]), ok({ id: FORUM }), ok({ refreshed_urls: [] }), ok({ id: GUILD })])
    await r.discord.guild()
    await r.discord.emojis()
    await r.discord.newest(THREAD, 1)
    await r.discord.channel(FORUM)
    await r.discord.refreshUrls([CDN])
    await r.discord.guild()
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 0, 0, 0, 1000])
  })

  it('counts a call that failed', async () => {
    const r = rig([new TypeError('down'), { status: 500, raw: 'x' }, new TypeError('down'), { status: 403, raw: 'x' }, new TypeError('down'), ok({ id: GUILD })])
    for (let i = 0; i < 6; i++) await guild(r).catch(() => {})
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 0, 0, 0, 1000])
  })

  it('does not count a call it refused before sending', async () => {
    const r = rig(goods(5))
    for (let i = 0; i < 5; i++) await r.discord.newest('nope', 1).catch(() => {})
    for (let i = 0; i < 5; i++) await guild(r)
    expect(r.slept).toEqual([])
  })

  it('counts calls that are made together, and spaces them out', async () => {
    const r = rig(goods(12), {}, true)
    await r.drive(Promise.all(Array.from({ length: 12 }, () => guild(r))))
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 2000, 2000])
    expect(r.slept).toEqual([1000, 1000, 1000, 1000, 1000, 2000, 2000])
  })

  it('never sends more than perSecond calls in any second, and never waits more than it must', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.array(fc.integer({ min: 0, max: 700 }), { minLength: 1, maxLength: 30 }), async (perSecond, gaps) => {
        const r = rig(goods(gaps.length), { perSecond })
        // The model: a call goes at once, unless the call perSecond before it went less than a second ago.
        const goes = []
        let t = 0
        for (const [i, gap] of gaps.entries()) {
          r.clock.t += gap
          t += gap
          t = i < perSecond ? t : Math.max(t, goes[i - perSecond] + 1000)
          goes.push(t)
          await guild(r)
          expect(r.clock.t).toBe(t)
        }
        const at = r.seen.map((s) => s.at)
        expect(at).toEqual(goes)
        for (let i = perSecond; i < at.length; i++) expect(at[i] - at[i - perSecond]).toBeGreaterThanOrEqual(1000)
      }),
    )
  })

  it('keeps to perSecond when calls are made together, too', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 25 }), async (perSecond, n) => {
        const r = rig(goods(n), { perSecond, maxWaitMs: 100_000 }, true)
        await r.drive(Promise.all(Array.from({ length: n }, () => guild(r))))
        const at = r.seen.map((s) => s.at)
        expect(at).toHaveLength(n)
        for (let i = perSecond; i < n; i++) expect(at[i] - at[i - perSecond]).toBeGreaterThanOrEqual(1000)
        expect(at[n - 1]).toBe(Math.floor((n - 1) / perSecond) * 1000)
      }),
    )
  })

  it('five calls a second is the default', async () => {
    const r = rig(goods(11))
    for (let i = 0; i < 11; i++) await guild(r)
    expect(r.seen.map((s) => s.at)).toEqual([0, 0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 2000])
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 1.5],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['text', '5'],
    ['null', null],
    ['a list', [5]],
    ['too large to count', 2 ** 53],
  ])('throws RangeError when perSecond is %s', (_, perSecond) => {
    expect(() => rig([], { perSecond })).toThrow(RangeError)
  })

  it('names nothing in the RangeError', () => {
    let err
    try {
      rig([], { perSecond: 0 })
    } catch (e) {
      err = e
    }
    expect(err.message).toBe('perSecond must be a whole number of at least 1.')
  })
})

/** Lets everything that can run without a timer run: the calls in flight get as far as sleeping or finishing. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('a queue of calls that is too long', () => {
  const goods = (n) => Array.from({ length: n }, () => ok({ id: GUILD }))
  const TOO_MANY = 'Too many Librarius calls are waiting to reach Discord.'

  it('turns away the calls that would wait more than 5 seconds, by default, and sends only the rest', async () => {
    const r = rig(goods(50), {}, true)
    const results = await r.drive(Promise.allSettled(Array.from({ length: 50 }, () => r.discord.guild())))
    // Five calls a second, from 0 to 5000 inclusive: 30 turns. The calls after those are turned away.
    expect(results.slice(0, 30).map((x) => x.status)).toEqual(Array(30).fill('fulfilled'))
    for (const turnedAway of results.slice(30)) {
      expect(turnedAway.status).toBe('rejected')
      expect(turnedAway.reason).toBeInstanceOf(Upstream)
      expect(turnedAway.reason.message).toBe(TOO_MANY)
    }
    expect(r.seen.map((x) => x.at)).toEqual([0, 1000, 2000, 3000, 4000, 5000].flatMap((t) => Array(5).fill(t)))
    expect(r.slept).toEqual([1000, 2000, 3000, 4000, 5000].flatMap((t) => Array(5).fill(t)))
  })

  it('does not hold a place in the queue for a call it turned away', async () => {
    const r = rig(goods(51), {}, true)
    await r.drive(Promise.allSettled(Array.from({ length: 50 }, () => r.discord.guild())))
    expect(r.clock.t).toBe(5000)
    // The next turn is the one after the last call that was sent, at 6000, not after the 20 that were turned away.
    await r.drive(r.discord.guild())
    expect(r.seen.at(-1).at).toBe(6000)
    expect(r.seen).toHaveLength(31)
  })

  it('lets a call wait exactly maxWaitMs, and turns away one that would wait a millisecond more', async () => {
    const r = rig(goods(4), { perSecond: 1, maxWaitMs: 999 })
    await r.discord.guild()
    const err = await r.discord.guild().catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe(TOO_MANY)
    expect(r.slept).toEqual([])
    expect(r.seen).toHaveLength(1)
    // A millisecond later its turn is 999 ms away, which is allowed, and no place was held for the call before it.
    r.clock.t = 1
    await r.discord.guild()
    expect(r.slept).toEqual([999])
    expect(r.seen.map((x) => x.at)).toEqual([0, 1000])
  })

  it('takes a maxWaitMs of 0, which turns away any call that would have to wait', async () => {
    const r = rig(goods(4), { perSecond: 2, maxWaitMs: 0 })
    await r.discord.guild()
    await r.discord.guild()
    const err = await r.discord.guild().catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe(TOO_MANY)
    r.clock.t = 1000
    await r.discord.guild()
    expect(r.slept).toEqual([])
    expect(r.seen.map((x) => x.at)).toEqual([0, 0, 1000])
  })

  it('takes maxWaitMs from the option', async () => {
    const r = rig(goods(50), { maxWaitMs: 60_000 }, true)
    const results = await r.drive(Promise.allSettled(Array.from({ length: 50 }, () => r.discord.guild())))
    expect(results.every((x) => x.status === 'fulfilled')).toBe(true)
    expect(r.seen.at(-1).at).toBe(9000)
  })

  it('applies to the retry of a 429 too', async () => {
    const r = rig([{ status: 429, headers: { 'Retry-After': '0.01' } }, ok({ id: GUILD })], { perSecond: 1, maxWaitMs: 100 })
    const err = await r.discord.guild().catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).toBe(TOO_MANY)
    expect(r.seen).toHaveLength(1)
  })

  it('does not count a wait for a bucket or a 429 against it: those have caps of their own', async () => {
    const r = rig([ok([], bucket('b1', 0, 20)), ok([]), { status: 429, headers: { 'Retry-After': '20' } }, ok([])], { maxWaitMs: 100 })
    await r.discord.newest(THREAD, 1)
    await r.discord.newest(THREAD, 1)
    await r.discord.guild().catch(() => {})
    expect(r.slept).toEqual([20_000, 20_000])
  })

  it('sends no more than perSecond calls in any second, and turns away exactly what does not fit in maxWaitMs, whatever the load', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 8000 }), fc.integer({ min: 1, max: 60 }), async (perSecond, maxWaitMs, n) => {
        const r = rig(goods(n), { perSecond, maxWaitMs }, true)
        const results = await r.drive(Promise.allSettled(Array.from({ length: n }, () => r.discord.guild())))
        const room = perSecond * (Math.floor(maxWaitMs / 1000) + 1)
        const sent = Math.min(n, room)
        expect(results.map((x) => x.status)).toEqual([...Array(sent).fill('fulfilled'), ...Array(n - sent).fill('rejected')])
        expect(r.seen).toHaveLength(sent)
        const at = r.seen.map((x) => x.at)
        for (let i = perSecond; i < at.length; i++) expect(at[i] - at[i - perSecond]).toBeGreaterThanOrEqual(1000)
        expect(Math.max(0, ...at)).toBeLessThanOrEqual(maxWaitMs)
      }),
    )
  })

  it.each([
    ['negative', -1],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['negative infinite', -Infinity],
    ['text', '5000'],
    ['null', null],
    ['a list', [5000]],
    ['a bigint', 5n],
  ])('throws RangeError when maxWaitMs is %s', (_, maxWaitMs) => {
    expect(() => rig([], { maxWaitMs })).toThrow(new RangeError('maxWaitMs must be a number of at least 0.'))
  })

  describe('withMaxWait: the same client, for a caller that will wait longer', () => {
    it('has every call of the client, and itself', () => {
      const r = rig()
      const view = r.discord.withMaxWait(60_000)
      expect(Object.keys(view).sort()).toEqual(Object.keys(r.discord).sort())
      expect(Object.keys(view)).toContain('withMaxWait')
    })

    it('waits for a turn the client itself would turn away, and the client still turns it away', async () => {
      const r = rig(goods(31), {}, true)
      const queued = Array.from({ length: 30 }, () => r.discord.guild())
      const turnedAway = r.discord.guild().catch((e) => e)
      const patient = r.discord.withMaxWait(60_000).guild()
      const turnedAwayAgain = r.discord.guild().catch((e) => e)
      await r.drive(Promise.all([...queued, patient]))
      expect((await turnedAway).message).toBe(TOO_MANY)
      expect((await turnedAwayAgain).message).toBe(TOO_MANY)
      expect(r.seen).toHaveLength(31)
      expect(r.seen.at(-1).at).toBe(6000)
    })

    it('shares the calls a second with the client, not a second allowance', async () => {
      const r = rig(goods(6))
      const view = r.discord.withMaxWait(1000)
      for (let i = 0; i < 3; i++) await r.discord.guild()
      for (let i = 0; i < 3; i++) await view.guild()
      expect(r.seen.map((x) => x.at)).toEqual([0, 0, 0, 0, 0, 1000])
    })

    it('shares what it learns about the buckets', async () => {
      const r = rig([ok([], bucket('b1', 0, 2)), ok([]), ok([])])
      await r.discord.newest(THREAD, 1)
      await r.discord.withMaxWait(60_000).newest(THREAD, 1)
      expect(r.slept).toEqual([2000])
    })

    it('shares a pause for a global 429', async () => {
      const r = rig([{ status: 429, headers: { 'Retry-After': '3', 'X-RateLimit-Global': 'true' } }, ok({ id: GUILD }), ok([])], {}, true)
      const first = r.discord.guild()
      await settle()
      const second = r.discord.withMaxWait(60_000).emojis()
      await r.drive(Promise.all([first, second]))
      expect(r.seen.at(-1).at).toBe(3000)
    })

    it('can be narrowed as well as widened', async () => {
      const r = rig(goods(8), { perSecond: 1 }, true)
      const strict = r.discord.withMaxWait(60_000).withMaxWait(0)
      await r.drive(strict.guild())
      const err = await r.drive(strict.guild().catch((e) => e))
      expect(err.message).toBe(TOO_MANY)
    })

    it('uses the same token, address and guild as the client', async () => {
      const r = rig([ok({ id: GUILD })])
      await r.discord.withMaxWait(1).guild()
      expect(r.seen[0].url).toBe(`${API}/v10/guilds/${GUILD}`)
      expect(r.seen[0].headers.Authorization).toBe('Bot secret-bot-token')
    })

    it.each([
      ['negative', -1],
      ['NaN', NaN],
      ['infinite', Infinity],
      ['text', '5000'],
      ['null', null],
      ['undefined', undefined],
    ])('throws RangeError when the wait is %s, and does not change the client', async (_, ms) => {
      const r = rig(goods(1))
      expect(() => r.discord.withMaxWait(ms)).toThrow(new RangeError('maxWaitMs must be a number of at least 0.'))
      await r.discord.guild()
      expect(r.seen).toHaveLength(1)
    })
  })
})

describe('a global 429', () => {
  const global = (retryAfter) => ({ status: 429, headers: { ...(retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }), 'X-RateLimit-Global': 'true' } })
  const atOf = (r, path) => r.seen.filter((x) => x.url === `${API}${path}`).map((x) => x.at)

  it('holds back a call to another route, made after it, until Retry-After is over', async () => {
    const r = rig([global(3), ok({ id: GUILD }), ok([])], {}, true)
    const first = r.discord.guild()
    await settle()
    const second = r.discord.emojis()
    await r.drive(Promise.all([first, second]))
    expect(atOf(r, `/v10/guilds/${GUILD}`)).toEqual([0, 3000])
    expect(atOf(r, `/v10/guilds/${GUILD}/emojis`)).toEqual([3000])
    expect(r.slept.sort((a, b) => a - b)).toEqual([3000, 3000])
  })

  it('holds back a call to a channel, to a guild and to the gateway alike', async () => {
    const r = rig([global(2), ok({ id: GUILD }), ok([]), ok([]), ok(GATEWAY)], {}, true)
    const first = r.discord.guild()
    await settle()
    const others = [r.discord.newest(THREAD, 1), r.discord.emojis(), r.discord.gatewayBot()]
    await r.drive(Promise.all([first, ...others]))
    expect(r.seen.slice(1).map((x) => x.at)).toEqual([2000, 2000, 2000, 2000])
  })

  it('does not hold back a call to another route when the 429 is not global', async () => {
    // The emoji call goes out at once, ahead of the retry of the guild call, so it takes the next reply.
    const r = rig([{ status: 429, headers: { 'Retry-After': '3' } }, ok([]), ok({ id: GUILD })], {}, true)
    const first = r.discord.guild()
    await settle()
    const second = r.discord.emojis()
    await r.drive(Promise.all([first, second]))
    expect(atOf(r, `/v10/guilds/${GUILD}/emojis`)).toEqual([0])
    expect(r.slept).toEqual([3000])
  })

  it.each([['false'], ['False'], ['True'], ['TRUE'], ['1'], ['yes'], ['']])('does not take X-RateLimit-Global: %j for global', async (value) => {
    const r = rig([{ status: 429, headers: { 'Retry-After': '3', 'X-RateLimit-Global': value } }, ok([]), ok({ id: GUILD })], {}, true)
    const first = r.discord.guild()
    await settle()
    const second = r.discord.emojis()
    await r.drive(Promise.all([first, second]))
    expect(atOf(r, `/v10/guilds/${GUILD}/emojis`)).toEqual([0])
  })

  it('does not take the header on an answer that is not a 429', async () => {
    const r = rig([ok({ id: GUILD }, { 'Retry-After': '3', 'X-RateLimit-Global': 'true' }), ok([])])
    await r.discord.guild()
    await r.discord.emojis()
    expect(r.slept).toEqual([])
  })

  it('does not make the call that was refused wait twice', async () => {
    const r = rig([global(3), ok({ id: GUILD })])
    await r.discord.guild()
    expect(r.slept).toEqual([3000])
    expect(r.seen.map((x) => x.at)).toEqual([0, 3000])
  })

  it('lets calls through again once it is over, with nothing left to wait for', async () => {
    const r = rig([global(3), ok({ id: GUILD }), ok([])], {}, true)
    await r.drive(r.discord.guild())
    await r.drive(r.discord.emojis())
    expect(r.slept).toEqual([3000])
    expect(atOf(r, `/v10/guilds/${GUILD}/emojis`)).toEqual([3000])
  })

  it('waits Retry-After, at most 30 seconds, and a second when it is missing or odd', async () => {
    for (const [header, ms] of [['3600', 30_000], ['30', 30_000], ['0.5', 500], [undefined, 1000], ['soon', 1000], ['-2', 1000]]) {
      const r = rig([{ status: 429, headers: { ...(header === undefined ? {} : { 'Retry-After': header }), 'X-RateLimit-Global': 'true' } }, ok({ id: GUILD }), ok([])], {}, true)
      const first = r.discord.guild()
      await settle()
      const second = r.discord.emojis()
      await r.drive(Promise.all([first, second]))
      expect(atOf(r, `/v10/guilds/${GUILD}/emojis`), String(header)).toEqual([ms])
    }
  })

  it('does not wait when Retry-After is 0', async () => {
    const r = rig([global(0), ok([]), ok({ id: GUILD })], {}, true)
    const first = r.discord.guild()
    await settle()
    const second = r.discord.emojis()
    await r.drive(Promise.all([first, second]))
    expect(r.seen.map((x) => x.at)).toEqual([0, 0, 0])
  })

  it('keeps the longest pause when a shorter one arrives after it', async () => {
    const r = rig([global(10), global(1), ok({ id: GUILD }), ok([]), ok({ id: GUILD })], {}, true)
    const a = r.discord.guild()
    const b = r.discord.guild()
    await settle()
    const c = r.discord.emojis()
    await r.drive(Promise.all([a, b, c]))
    // Both were answered with a 429 at 0. The pause is the 10 seconds of the first, and the retry of the second, which
    // waited its own second, then waits the rest of it.
    expect(r.seen.map((x) => x.at)).toEqual([0, 0, 10_000, 10_000, 10_000])
  })

  it('holds back a call to another route even after the call that was refused has retried and finished', async () => {
    const r = rig([global(5), global(5), ok([])])
    const err = await r.discord.guild().catch((e) => e)
    expect(err.message).toBe('Discord is rate limiting the Librarius.')
    // The second 429 was global too: the client is paused to 10 seconds, and the next call, at 5 seconds, waits for it.
    await r.discord.emojis()
    expect(r.slept).toEqual([5000, 5000])
    expect(r.seen.at(-1).at).toBe(10_000)
  })
})

describe('on the real clock', () => {
  it('sleeps and reads the time for real when it is given neither', async () => {
    const seen = []
    const fetchImpl = async (url) => {
      seen.push(url)
      return seen.length === 2 ? new Response(null, { status: 429, headers: { 'Retry-After': '0.2' } }) : new Response(JSON.stringify({ id: GUILD }), { status: 200 })
    }
    const discord = createLibrariusDiscord({ fetchImpl, apiBase: API, botToken: TOKEN, guildId: GUILD })
    // The first call warms everything up, so the time the second one takes is the wait and not a cold start.
    await discord.guild()
    const before = Date.now()
    expect(await discord.guild()).toEqual({ id: GUILD })
    expect(Date.now() - before).toBeGreaterThanOrEqual(190)
    expect(seen).toHaveLength(3)
  })

  it('uses the global fetch when it is given none', async () => {
    const real = globalThis.fetch
    const seen = []
    globalThis.fetch = async (url) => {
      seen.push(url)
      return new Response(JSON.stringify({ id: GUILD }), { status: 200 })
    }
    try {
      const discord = createLibrariusDiscord({ apiBase: API, botToken: TOKEN, guildId: GUILD })
      expect(await discord.guild()).toEqual({ id: GUILD })
      expect(seen).toEqual([`${API}/v10/guilds/${GUILD}`])
    } finally {
      globalThis.fetch = real
    }
  })
})
