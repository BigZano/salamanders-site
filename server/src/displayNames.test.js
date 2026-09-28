import { describe, it, expect } from 'vitest'
import { createDisplayNames, nameOf, COMMUNITY_MEMBER } from './displayNames'

const GUILD = '1322056087792521269'
const BASE = 'https://d.test/api'
const A = '75633559351595008'
const B = '87082170719408128'
const C = '100000000000000002'
const member = (id, { nick = null, global_name = null, username = `user${id.slice(-3)}` } = {}) => ({
  nick,
  user: { id, username, global_name },
})
const page = (n, start = 100000000000000000n) =>
  Array.from({ length: n }, (_, i) => member(String(start + BigInt(i)), { nick: `n${i}` }))

// A Discord stand-in: `answers` is a queue; each call takes the next answer
// (the last one repeats). An answer is an array of members, {status, body},
// a thrown Error, or a promise of one of those (to hold a request open).
function discord(...answers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    let a = answers.length > 1 ? answers.shift() : answers[0]
    a = await a
    if (a instanceof Error) throw a
    if (Array.isArray(a)) return new Response(JSON.stringify(a), { status: 200 })
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status })
  }
  return { fetchImpl, calls }
}
function clock(t = 1_000_000) {
  const c = { t, now: () => c.t }
  return c
}
const make = (d, over = {}) => {
  const c = over.clock || clock()
  const names = createDisplayNames({ fetchImpl: d.fetchImpl, apiBase: BASE, guildId: GUILD, botToken: 'bot', now: c.now, ...over })
  return { names, c }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('nameOf', () => {
  it('prefers the server nickname, then the global display name, then the username', () => {
    expect(nameOf(member(A, { nick: 'Vulkan', global_name: 'Glob', username: 'u' }))).toBe('Vulkan')
    expect(nameOf(member(A, { global_name: 'Glob', username: 'u' }))).toBe('Glob')
    expect(nameOf(member(A, { username: 'u' }))).toBe('u')
  })

  it('strips invisible and bidi characters and collapses whitespace', () => {
    expect(nameOf(member(A, { nick: '‮Vul​kan⁦  Forge\n' }))).toBe('Vulkan Forge')
  })

  it('skips a name that cleans to nothing or runs over 32 characters', () => {
    expect(nameOf(member(A, { nick: '​​', global_name: 'Glob' }))).toBe('Glob')
    expect(nameOf(member(A, { nick: 'x'.repeat(33), global_name: 'Glob' }))).toBe('Glob')
    expect(nameOf(member(A, { nick: 'x'.repeat(32), global_name: 'Glob' }))).toBe('x'.repeat(32))
  })

  it.each([null, undefined, {}, { user: null }, { nick: 5, user: { global_name: [], username: {} } }])(
    'returns null when there is no usable name (%j)',
    (m) => expect(nameOf(m)).toBe(null),
  )
})

describe('createDisplayNames', () => {
  it('maps guild members to display names and anyone else to Community Member', async () => {
    const d = discord([member(A, { nick: 'Vulkan' }), member(B, { global_name: 'Tu’Shan' })])
    const { names } = make(d)
    const nameFor = await names.resolver()
    expect(nameFor(A)).toBe('Vulkan')
    expect(nameFor(B)).toBe('Tu’Shan')
    expect(nameFor(C)).toBe(COMMUNITY_MEMBER)
    expect(nameFor(undefined)).toBe(COMMUNITY_MEMBER)
    expect(COMMUNITY_MEMBER).toBe('Community Member')
  })

  it('asks Discord with the bot token, 1000 per page, with a timeout', async () => {
    const d = discord([])
    const { names } = make(d)
    await names.resolver()
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0].url).toBe(`${BASE}/v10/guilds/${GUILD}/members?limit=1000&after=0`)
    expect(d.calls[0].init.headers).toEqual({ Authorization: 'Bot bot' })
    expect(d.calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('follows pages after the last member id until a short page', async () => {
    const first = page(1000)
    const d = discord(first, [member(C, { nick: 'Last' })])
    const { names } = make(d)
    const nameFor = await names.resolver()
    expect(d.calls).toHaveLength(2)
    expect(d.calls[1].url).toBe(`${BASE}/v10/guilds/${GUILD}/members?limit=1000&after=${first[999].user.id}`)
    expect(nameFor(first[0].user.id)).toBe('n0')
    expect(nameFor(first[999].user.id)).toBe('n999')
    expect(nameFor(C)).toBe('Last')
  })

  it('skips malformed member entries but keeps the rest', async () => {
    const d = discord([null, {}, { user: { id: 'abc', username: 'x' } }, { user: { id: 12, username: 'y' } }, member(A, { nick: '​' , global_name: null, username: '' }), member(B, { nick: 'Ok' })])
    const { names } = make(d)
    const nameFor = await names.resolver()
    expect(nameFor(B)).toBe('Ok')
    expect(nameFor(A)).toBe(COMMUNITY_MEMBER)
    expect(nameFor('abc')).toBe(COMMUNITY_MEMBER)
    expect(nameFor('12')).toBe(COMMUNITY_MEMBER)
    expect(nameFor(null)).toBe(COMMUNITY_MEMBER)
  })

  it('does not ask Discord again inside the refresh window', async () => {
    const d = discord([member(A, { nick: 'Vulkan' })])
    const { names, c } = make(d)
    await names.resolver()
    c.t += 15 * 60_000 - 1
    await names.resolver()
    await settle()
    expect(d.calls).toHaveLength(1)
  })

  it('once stale, answers with the old names at once and swaps in the refresh when it lands', async () => {
    let release
    const held = new Promise((r) => (release = r))
    const d = discord([member(A, { nick: 'Old' })], held)
    const { names, c } = make(d)
    await names.resolver()
    c.t += 15 * 60_000
    const stale = await names.resolver()
    expect(stale(A)).toBe('Old')
    expect(d.calls).toHaveLength(2)
    release([member(A, { nick: 'New' })])
    await settle()
    expect((await names.resolver())(A)).toBe('New')
    expect(d.calls).toHaveLength(2)
  })

  it('drops members who left at the next refresh', async () => {
    const d = discord([member(A, { nick: 'Vulkan' })], [])
    const { names, c } = make(d)
    await names.resolver()
    c.t += 15 * 60_000
    await names.resolver()
    await settle()
    expect((await names.resolver())(A)).toBe(COMMUNITY_MEMBER)
  })

  it('shares one Discord request between concurrent first callers', async () => {
    const d = discord([member(A, { nick: 'Vulkan' })])
    const { names } = make(d)
    const [x, y] = await Promise.all([names.resolver(), names.resolver()])
    expect(d.calls).toHaveLength(1)
    expect(x(A)).toBe('Vulkan')
    expect(y(A)).toBe('Vulkan')
  })

  it.each([
    ['a network error', new Error('down')],
    ['a non-200', { status: 429, body: { retry_after: 5 } }],
    ['a 500', { status: 500, body: [] }],
    ['a non-array body', { status: 200, body: { members: [] } }],
    ['a JSON string body', { status: 200, body: '"abc"' }],
    ['unparseable JSON', { status: 200, body: 'not json' }],
  ])('keeps the last good names through %s', async (_, bad) => {
    const d = discord([member(A, { nick: 'Vulkan' })], bad)
    const { names, c } = make(d)
    await names.resolver()
    c.t += 15 * 60_000
    await names.resolver()
    await settle()
    expect((await names.resolver())(A)).toBe('Vulkan')
  })

  it('a partial refresh (later page fails) keeps the whole old directory', async () => {
    const d = discord([member(A, { nick: 'Vulkan' })], page(1000), new Error('down'))
    const { names, c } = make(d)
    await names.resolver()
    c.t += 15 * 60_000
    await names.resolver()
    await settle()
    const nameFor = await names.resolver()
    expect(nameFor(A)).toBe('Vulkan')
    expect(nameFor(page(1)[0].user.id)).toBe(COMMUNITY_MEMBER)
  })

  it('a full page whose last entry has no valid id is a failure, not an endless loop', async () => {
    const bad = page(1000)
    bad[999] = { nick: 'x', user: { id: 'nope' } }
    const d = discord(bad)
    const { names } = make(d)
    expect((await names.resolver())(bad[0].user.id)).toBe(COMMUNITY_MEMBER)
    expect(d.calls).toHaveLength(1)
  })

  it('gives up past maxPages rather than paging forever', async () => {
    let n = 0
    const d = { calls: [], fetchImpl: async (url) => { d.calls.push(url); return new Response(JSON.stringify(page(1000, 100000000000000000n + BigInt(1000 * n++))), { status: 200 }) } }
    const { names } = make(d, { maxPages: 3 })
    expect((await names.resolver())(page(1)[0].user.id)).toBe(COMMUNITY_MEMBER)
    expect(d.calls).toHaveLength(3)
  })

  it('with no directory yet, a failure answers Community Member and waits retryMs before asking again', async () => {
    const d = discord(new Error('down'), [member(A, { nick: 'Vulkan' })])
    const { names, c } = make(d)
    expect((await names.resolver())(A)).toBe(COMMUNITY_MEMBER)
    c.t += 60_000 - 1
    expect((await names.resolver())(A)).toBe(COMMUNITY_MEMBER)
    expect(d.calls).toHaveLength(1)
    c.t += 1
    expect((await names.resolver())(A)).toBe('Vulkan')
    expect(d.calls).toHaveLength(2)
  })

  it('after a failed refresh, retries after retryMs, not a full ttl', async () => {
    const d = discord([member(A, { nick: 'Old' })], new Error('down'), [member(A, { nick: 'New' })])
    const { names, c } = make(d)
    await names.resolver()
    c.t += 15 * 60_000
    await names.resolver()
    await settle()
    c.t += 60_000 - 1
    await names.resolver()
    await settle()
    expect(d.calls).toHaveLength(2)
    c.t += 1
    await names.resolver()
    await settle()
    expect(d.calls).toHaveLength(3)
    expect((await names.resolver())(A)).toBe('New')
  })

  it('honours custom ttlMs and retryMs', async () => {
    const d = discord([member(A, { nick: 'Old' })], new Error('down'), [member(A, { nick: 'New' })])
    const { names, c } = make(d, { ttlMs: 10, retryMs: 5 })
    await names.resolver()
    c.t += 10
    await names.resolver()
    await settle()
    c.t += 5
    await names.resolver()
    await settle()
    expect((await names.resolver())(A)).toBe('New')
  })

  it.each([
    ['apiBase', { apiBase: '' }],
    ['guildId', { guildId: undefined }],
    ['botToken', { botToken: '' }],
  ])('without %s, never calls Discord and names everyone Community Member', async (_, over) => {
    const d = discord([member(A, { nick: 'Vulkan' })])
    const { names } = make(d, over)
    expect((await names.resolver())(A)).toBe(COMMUNITY_MEMBER)
    expect(d.calls).toHaveLength(0)
  })

  it.each(['ttlMs', 'retryMs', 'timeoutMs', 'maxPages'])('rejects a bad %s', (key) => {
    for (const bad of [0, -1, NaN, Infinity, '5', null]) {
      expect(() => make(discord([]), { [key]: bad })).toThrow(new RangeError(`${key} must be a positive number`))
    }
  })

  it('uses Date.now and the real fetch by default', () => {
    expect(() => createDisplayNames({ apiBase: BASE, guildId: GUILD, botToken: 'bot' })).not.toThrow()
  })
})
