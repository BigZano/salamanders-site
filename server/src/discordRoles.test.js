import { describe, it, expect } from 'vitest'
import { createDiscordRoles, Upstream } from './discordRoles'

const GUILD = '1322056087792521269'
const USER = '75633559351595008'
const ADMIN_ROLE = '111111111111111111'
const PLAIN_ROLE = '222222222222222222'

function discord(routes) {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.Authorization])
    const r = routes[url.replace('https://d.test/api', '')] || { status: 404, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status })
  }
  return { fetchImpl, seen }
}
const make = (routes, over = {}) => {
  const d = discord(routes)
  return { d, roles: createDiscordRoles({ fetchImpl: d.fetchImpl, apiBase: 'https://d.test/api', guildId: GUILD, botToken: 'bot', ...over }) }
}
const req = (auth) => new Request('https://x.test', { headers: auth ? { Authorization: auth } : {} })
const guild = (over = {}) => ({
  status: 200,
  body: { owner_id: '9', roles: [{ id: GUILD, permissions: '0' }, { id: ADMIN_ROLE, permissions: String(0x8 | 0x20) }, { id: PLAIN_ROLE, permissions: '2048' }], ...over },
})

describe('identify', () => {
  it('returns the Discord user for a good token', async () => {
    const { roles, d } = make({ '/users/@me': { status: 200, body: { id: USER, username: 'u' } } })
    expect(await roles.identify(req('Bearer tok'))).toEqual({ id: USER, username: 'u' })
    expect(d.seen[0][1]).toBe('Bearer tok')
  })

  it('is null without a token or when Discord rejects it', async () => {
    const { roles } = make({ '/users/@me': { status: 401, body: {} } })
    expect(await roles.identify(req())).toBeNull()
    expect(await roles.identify(req('Basic x'))).toBeNull()
    expect(await roles.identify(req('Bearer tok'))).toBeNull()
  })

  it('throws Upstream on odd answers and when unconfigured', async () => {
    await expect(make({ '/users/@me': { status: 500, body: {} } }).roles.identify(req('Bearer t'))).rejects.toBeInstanceOf(Upstream)
    await expect(make({ '/users/@me': { status: 200, body: { id: 'x' } } }).roles.identify(req('Bearer t'))).rejects.toBeInstanceOf(Upstream)
    await expect(make({}, { botToken: '' }).roles.identify(req('Bearer t'))).rejects.toBeInstanceOf(Upstream)
  })
})

describe('rolesOf', () => {
  it('returns roles with the bot token, null when not in the guild', async () => {
    const { roles, d } = make({ [`/v10/guilds/${GUILD}/members/${USER}`]: { status: 200, body: { roles: [PLAIN_ROLE] } } })
    expect(await roles.rolesOf(USER)).toEqual([PLAIN_ROLE])
    expect(d.seen[0][1]).toBe('Bot bot')
    expect(await roles.rolesOf('1')).toBeNull()
  })
})

describe('isAdmin', () => {
  const route = (g) => ({ [`/v10/guilds/${GUILD}`]: g })
  it('is true for an Administrator role or the owner', async () => {
    expect(await make(route(guild())).roles.isAdmin(USER, [ADMIN_ROLE])).toBe(true)
    expect(await make(route(guild({ owner_id: USER }))).roles.isAdmin(USER, [])).toBe(true)
  })

  it('is false for roles without the bit, and honours @everyone', async () => {
    expect(await make(route(guild())).roles.isAdmin(USER, [PLAIN_ROLE])).toBe(false)
    const everyoneAdmin = guild({ roles: [{ id: GUILD, permissions: '8' }] })
    expect(await make(route(everyoneAdmin)).roles.isAdmin(USER, [])).toBe(true)
  })

  it('treats malformed permissions as none and a failed guild fetch as Upstream', async () => {
    expect(await make(route(guild({ roles: [{ id: ADMIN_ROLE, permissions: '8x' }] }))).roles.isAdmin(USER, [ADMIN_ROLE])).toBe(false)
    await expect(make({}).roles.isAdmin(USER, [])).rejects.toBeInstanceOf(Upstream)
  })
})

describe('Discord unreachable', () => {
  const unreachable = (fetchImpl, over = {}) =>
    createDiscordRoles({ fetchImpl, apiBase: 'https://d.test/api', guildId: GUILD, botToken: 'bot', ...over })
  const hang = (_url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))

  it.each([
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['an abort', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('throws Upstream, not the raw error, on %s', async (_, fetchImpl) => {
    const roles = unreachable(fetchImpl)
    await expect(roles.identify(req('Bearer tok'))).rejects.toBeInstanceOf(Upstream)
    await expect(roles.rolesOf(USER)).rejects.toBeInstanceOf(Upstream)
    await expect(roles.isAdmin(USER, [])).rejects.toBeInstanceOf(Upstream)
  })

  it('throws Upstream when Discord never answers within the timeout', async () => {
    await expect(unreachable(hang, { timeoutMs: 20 }).rolesOf(USER)).rejects.toBeInstanceOf(Upstream)
  })

  it('does not carry the request url, and so the user id, into the error', async () => {
    const fetchImpl = () => Promise.reject(new TypeError(`fetch failed: https://d.test/api/v10/guilds/${GUILD}/members/${USER}`))
    const err = await unreachable(fetchImpl).rolesOf(USER).catch((e) => e)
    expect(err).toBeInstanceOf(Upstream)
    expect(err.message).not.toContain(USER)
  })

  it('throws Upstream when the body stream fails mid-read', async () => {
    const broken = new Response(new ReadableStream({ start: (c) => c.error(new Error('reset')) }), { status: 200 })
    // an unreadable body is a null body, so a good status with no roles is the odd answer Upstream already covers
    await expect(unreachable(async () => broken).rolesOf(USER)).rejects.toBeInstanceOf(Upstream)
  })
})
