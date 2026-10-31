import { describe, it, expect } from 'vitest'
import { createDisplayNames, nameOf, COMMUNITY_MEMBER } from './displayNames'

const GUILD = '1322056087792521269'
const BASE = 'https://d.test/api'
const A = '300000000000000001'
const B = '300000000000000002'
const C = '100000000000000002'
const ROLE = '400000000000000001'
const member = (id, { nick = null, global_name = null, username = `user${id.slice(-3)}`, roles = [] } = {}) => ({
  nick,
  user: { id, username, global_name },
  roles,
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

describe('memberResolver', () => {
  const H = '300000000000000050' // a real holder, so a hostile entry that breaks the load shows up as a missing holder

  it('is true only for holders of memberRoleId', async () => {
    const d = discord([member(A, { roles: [ROLE] }), member(B, { roles: ['other'] })])
    const { names } = make(d, { memberRoleId: ROLE })
    const is = await names.memberResolver()
    expect(is(A)).toBe(true)
    expect(is(B)).toBe(false)
    expect(is('300000000000000099')).toBe(false)
  })

  it('finds the role among several and only by exact match', async () => {
    const d = discord([
      member(A, { roles: ['x', ROLE, 'y'] }),
      member(B, { roles: [ROLE + '0', '0' + ROLE, ROLE.slice(1)] }),
    ])
    const { names } = make(d, { memberRoleId: ROLE })
    const is = await names.memberResolver()
    expect(is(A)).toBe(true)
    expect(is(B)).toBe(false)
  })

  it('does not change what resolver() says about names', async () => {
    const d = discord([member(A, { nick: 'Vulkan', roles: [ROLE] }), member(B, { nick: 'Tu’Shan' })])
    const { names } = make(d, { memberRoleId: ROLE })
    const nameFor = await names.resolver()
    expect(nameFor(A)).toBe('Vulkan')
    expect(nameFor(B)).toBe('Tu’Shan')
    expect(nameFor(C)).toBe(COMMUNITY_MEMBER)
  })

  it.each([
    ['absent', {}, ROLE],
    ['undefined', { memberRoleId: undefined }, ROLE],
    ['empty', { memberRoleId: '' }, ''],
    ['null', { memberRoleId: null }, null],
    ['a number', { memberRoleId: 5 }, 5],
    ['true', { memberRoleId: true }, true],
  ])('with memberRoleId %s nobody is a member', async (_, over, heldByEveryone) => {
    const d = discord([
      member(A, { roles: [ROLE, 'other', heldByEveryone] }),
      member(B, { roles: [heldByEveryone] }),
      member(C, { roles: [] }),
    ])
    const { names } = make(d, over)
    const is = await names.memberResolver()
    for (const id of [A, B, C, '300000000000000099', undefined, null, '']) expect(is(id)).toBe(false)
    expect((await names.resolver())(A)).toBe('user001') // the directory itself still loaded
  })

  it.each([
    ['a string equal to the role id', ROLE],
    ['a string that contains the role id', 'x' + ROLE + 'y'],
    ['the role id inside an object', { id: ROLE, includes: ROLE }],
    ['null', null],
    ['a number', 5],
    ['absent', undefined],
  ])('roles that are not an array never count (%s)', async (_, roles) => {
    const bad = member(A)
    if (roles === undefined) delete bad.roles
    else bad.roles = roles
    const d = discord([bad, member(H, { roles: [ROLE] })])
    const { names } = make(d, { memberRoleId: ROLE })
    const is = await names.memberResolver()
    expect(is(A)).toBe(false)
    expect(is(H)).toBe(true) // one hostile entry must not take the rest of the directory down
  })

  it('a numeric role id in the array does not match the configured string id', async () => {
    const d = discord([member(A, { roles: [Number(ROLE)] }), member(H, { roles: [ROLE] })])
    const { names } = make(d, { memberRoleId: ROLE })
    const is = await names.memberResolver()
    expect(is(A)).toBe(false)
    expect(is(H)).toBe(true)
  })

  it('a malformed entry that carries the role is never a member', async () => {
    const d = discord([
      null,
      { roles: [ROLE] },
      { user: null, roles: [ROLE] },
      { user: { id: 'abc', username: 'x' }, roles: [ROLE] },
      { user: { id: 12, username: 'y' }, roles: [ROLE] },
      { user: { username: 'z' }, roles: [ROLE] },
      member(H, { roles: [ROLE] }),
    ])
    const { names } = make(d, { memberRoleId: ROLE })
    const is = await names.memberResolver()
    expect(is(H)).toBe(true)
    for (const id of ['abc', '12', 12, 'z', 'undefined', 'null', undefined, null]) expect(is(id)).toBe(false)
  })

  it('a holder past the first page is still found', async () => {
    const first = page(1000)
    const d = discord(first, [member(C, { roles: [ROLE] })])
    const { names } = make(d, { memberRoleId: ROLE })
    const is = await names.memberResolver()
    expect(is(C)).toBe(true)
    expect(is(first[0].user.id)).toBe(false)
    expect(is(first[999].user.id)).toBe(false)
  })

  it('names and holders come from one directory request', async () => {
    const d = discord([member(A, { nick: 'Vulkan', roles: [ROLE] })])
    const { names } = make(d, { memberRoleId: ROLE })
    const nameFor = await names.resolver()
    const is = await names.memberResolver()
    expect(d.calls).toHaveLength(1)
    expect(nameFor(A)).toBe('Vulkan')
    expect(is(A)).toBe(true)
  })

  it('concurrent first callers of memberResolver share one request', async () => {
    const d = discord([member(A, { roles: [ROLE] })])
    const { names } = make(d, { memberRoleId: ROLE })
    const [x, y, z] = await Promise.all([names.memberResolver(), names.memberResolver(), names.resolver()])
    expect(d.calls).toHaveLength(1)
    expect(x(A)).toBe(true)
    expect(y(A)).toBe(true)
    expect(z(A)).toBe('user001')
  })

  it('a holder who lost the role drops out at the next refresh', async () => {
    const d = discord([member(A, { roles: [ROLE] }), member(B, { roles: [ROLE] })], [member(A, { roles: ['other'] }), member(B, { roles: [ROLE] })])
    const { names, c } = make(d, { memberRoleId: ROLE })
    expect((await names.memberResolver())(A)).toBe(true)
    c.t += 15 * 60_000
    await names.memberResolver()
    await settle()
    const is = await names.memberResolver()
    expect(is(A)).toBe(false)
    expect(is(B)).toBe(true)
    expect(d.calls).toHaveLength(2)
  })

  it('a member who left drops out at the next refresh, and a newly granted one comes in', async () => {
    const d = discord([member(A, { roles: [ROLE] })], [member(B, { roles: [ROLE] })])
    const { names, c } = make(d, { memberRoleId: ROLE })
    expect((await names.memberResolver())(A)).toBe(true)
    c.t += 15 * 60_000
    await names.memberResolver()
    await settle()
    const is = await names.memberResolver()
    expect(is(A)).toBe(false)
    expect(is(B)).toBe(true)
  })

  it('once stale, answers with the old holders at once and swaps in the refresh when it lands', async () => {
    let release
    const held = new Promise((r) => (release = r))
    const d = discord([member(A, { roles: [ROLE] })], held)
    const { names, c } = make(d, { memberRoleId: ROLE })
    await names.memberResolver()
    c.t += 15 * 60_000
    const stale = await names.memberResolver() // would hang here if it waited for the held refresh
    expect(stale(A)).toBe(true)
    expect(d.calls).toHaveLength(2)
    release([member(A, { roles: [] })])
    await settle()
    expect((await names.memberResolver())(A)).toBe(false)
    expect(stale(A)).toBe(true) // an answer already handed out is a snapshot
    expect(d.calls).toHaveLength(2)
  })

  it.each([
    ['a network error', new Error('down')],
    ['a non-200', { status: 429, body: { retry_after: 5 } }],
    ['a non-array body', { status: 200, body: { members: [] } }],
    ['unparseable JSON', { status: 200, body: 'not json' }],
  ])('a failed refresh (%s) keeps the old holders', async (_, bad) => {
    const d = discord([member(A, { roles: [ROLE] })], bad)
    const { names, c } = make(d, { memberRoleId: ROLE })
    await names.memberResolver()
    c.t += 15 * 60_000
    await names.memberResolver()
    await settle()
    expect((await names.memberResolver())(A)).toBe(true)
    expect(d.calls).toHaveLength(2)
  })

  it('a partial refresh (later page fails) keeps the whole old holder set', async () => {
    const d = discord([member(A, { roles: [ROLE] })], page(1000), new Error('down'))
    const { names, c } = make(d, { memberRoleId: ROLE })
    await names.memberResolver()
    c.t += 15 * 60_000
    await names.memberResolver()
    await settle()
    const is = await names.memberResolver()
    expect(is(A)).toBe(true)
    expect(is(page(1)[0].user.id)).toBe(false)
  })

  it('with no directory yet, a failure answers false for everyone and retries after retryMs', async () => {
    const d = discord(new Error('down'), [member(A, { roles: [ROLE] })])
    const { names, c } = make(d, { memberRoleId: ROLE })
    expect((await names.memberResolver())(A)).toBe(false)
    c.t += 60_000 - 1
    expect((await names.memberResolver())(A)).toBe(false)
    expect(d.calls).toHaveLength(1)
    c.t += 1
    expect((await names.memberResolver())(A)).toBe(true)
    expect(d.calls).toHaveLength(2)
  })

  it('a first-load failure that was a non-200 also fails closed', async () => {
    const d = discord({ status: 500, body: [] })
    const { names } = make(d, { memberRoleId: ROLE })
    const is = await names.memberResolver()
    expect(is(A)).toBe(false)
    expect(is(undefined)).toBe(false)
  })

  it.each([
    ['apiBase', { apiBase: '' }],
    ['guildId', { guildId: undefined }],
    ['botToken', { botToken: '' }],
  ])('without %s, never calls Discord and nobody is a member', async (_, over) => {
    const d = discord([member(A, { roles: [ROLE] })])
    const { names } = make(d, { memberRoleId: ROLE, ...over })
    expect((await names.memberResolver())(A)).toBe(false)
    expect(d.calls).toHaveLength(0)
  })

  it('does not ask Discord again inside the refresh window', async () => {
    const d = discord([member(A, { roles: [ROLE] })])
    const { names, c } = make(d, { memberRoleId: ROLE })
    await names.memberResolver()
    c.t += 15 * 60_000 - 1
    await names.memberResolver()
    await settle()
    expect(d.calls).toHaveLength(1)
  })
})
