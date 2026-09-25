import { describe, it, expect } from 'vitest'
import { createArchiveKeyHandler } from './archiveKey'
import { deriveKeys, keyFromBase64 } from '../../src/lib/archive/crypto'

const KEY = Buffer.alloc(32, 7).toString('base64')
const ROLE = '1377787723976409211'
const GUILD = '1322056087792521269'
const USER = '75633559351595008'
const OTHER = '87082170719408128'
const TOKEN = 'good.token-value_1'
const MEMBERS_URL = 'https://raw.test/discord-members.json'
const LIST = { fetched: '2026-09-25T00:00:00.000Z', guildId: GUILD, roleId: ROLE, memberIds: [USER] }

// Stand-in for Discord's /users/@me and the baked member list (the same
// discord-members.json that ranks builds). raw → non-JSON body.
function upstream({ me = { status: 200, body: { id: USER, username: 'u' } }, list = { status: 200, body: LIST }, throws, seen } = {}) {
  return async (url, init) => {
    seen?.push([url, init?.headers?.Authorization])
    if (throws) throw throws
    const r = url === MEMBERS_URL ? list : me
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status })
    return new Response(JSON.stringify(r.body), { status: r.status })
  }
}
const cfg = (over = {}) => ({
  fetchImpl: upstream(), discordApiBase: 'https://d.test/api', guildId: GUILD, roleId: ROLE, membersUrl: MEMBERS_URL, archiveKey: KEY, ...over,
})
const NONE = Symbol('no Authorization header')
const DEFAULT = `Bearer ${TOKEN}`
const req = (auth) => new Request('https://api.test/archive/key', { headers: auth === NONE ? {} : { Authorization: auth } })

async function call(configOrHandler, auth = DEFAULT) {
  const handle = typeof configOrHandler === 'function' ? configOrHandler : createArchiveKeyHandler(configOrHandler)
  const res = await handle(req(auth))
  const text = await res.text()
  return { status: res.status, text, headers: res.headers }
}
const MESSAGES = {
  401: ['Sign in with Discord.'],
  403: ['Restricted to the XVIIIth Legion.'],
  503: ['Archive unavailable.', 'Discord could not be reached. Try again.'],
}
function assertNoKey({ text, headers }) {
  expect(text).not.toContain(KEY)
  for (const [, v] of headers) expect(v).not.toContain(KEY)
}

describe('GET /archive/key', () => {
  it('a listed role holder gets the key and the kid of that key', async () => {
    const r = await call(cfg())
    expect(r.status).toBe(200)
    const body = JSON.parse(r.text)
    expect(body.key).toBe(KEY)
    expect(body.kid).toBe((await deriveKeys(keyFromBase64(KEY))).kid)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })

  const list = (body, status = 200) => upstream({ list: { status, body } })
  const denials = [
    ['no Authorization header', cfg(), NONE, 401],
    ['empty Authorization', cfg(), '', 401],
    ['Basic scheme', cfg(), 'Basic abc', 401],
    ['Bearer with no token', cfg(), 'Bearer ', 401],
    ['token with a space (header smuggling)', cfg(), 'Bearer a b', 401],
    ['token with a tab', cfg(), 'Bearer a\tb', 401],
    ['token with a quote', cfg(), 'Bearer a"b', 401],
    ['oversized token', cfg(), `Bearer ${'a'.repeat(600)}`, 401],
    ['Discord rejects token (401)', cfg({ fetchImpl: upstream({ me: { status: 401, body: {} } }) }), DEFAULT, 401],
    ['Discord forbids token (403)', cfg({ fetchImpl: upstream({ me: { status: 403, body: {} } }) }), DEFAULT, 401],
    ['identify rate-limited (429)', cfg({ fetchImpl: upstream({ me: { status: 429, body: {} } }) }), DEFAULT, 503],
    ['identify 5xx', cfg({ fetchImpl: upstream({ me: { status: 502, body: {} } }) }), DEFAULT, 503],
    ['identify 5xx that still carries an id', cfg({ fetchImpl: upstream({ me: { status: 500, body: { id: USER } } }) }), DEFAULT, 503],
    ['identify 202 with an id (not a clean 200)', cfg({ fetchImpl: upstream({ me: { status: 202, body: { id: USER } } }) }), DEFAULT, 503],
    ['identify non-JSON', cfg({ fetchImpl: upstream({ me: { status: 200, raw: '<html>' } }) }), DEFAULT, 503],
    ['identify body missing id', cfg({ fetchImpl: upstream({ me: { status: 200, body: { username: 'x' } } }) }), DEFAULT, 503],
    ['identify id not a snowflake', cfg({ fetchImpl: upstream({ me: { status: 200, body: { id: '../x' } } }) }), DEFAULT, 503],
    ['not on the member list', cfg({ fetchImpl: list({ ...LIST, memberIds: [OTHER] }) }), DEFAULT, 403],
    ['empty member list', cfg({ fetchImpl: list({ ...LIST, memberIds: [] }) }), DEFAULT, 403],
    ['list is for another role', cfg({ fetchImpl: list({ ...LIST, roleId: '1' }) }), DEFAULT, 503],
    ['list is for another guild', cfg({ fetchImpl: list({ ...LIST, guildId: '1' }) }), DEFAULT, 503],
    ['list memberIds not an array', cfg({ fetchImpl: list({ ...LIST, memberIds: USER }) }), DEFAULT, 503],
    ['list fetch 404', cfg({ fetchImpl: list(LIST, 404) }), DEFAULT, 503],
    ['list fetch 5xx', cfg({ fetchImpl: list(LIST, 500) }), DEFAULT, 503],
    ['list not JSON', cfg({ fetchImpl: upstream({ list: { status: 200, raw: 'nope' } }) }), DEFAULT, 503],
    ['network error', cfg({ fetchImpl: upstream({ throws: new TypeError('fetch failed') }) }), DEFAULT, 503],
    ['missing ARCHIVE_KEY', cfg({ archiveKey: '' }), DEFAULT, 503],
    ['malformed ARCHIVE_KEY', cfg({ archiveKey: 'short' }), DEFAULT, 503],
    ['archive key that only stringifies to base64', cfg({ archiveKey: { toString: () => KEY } }), DEFAULT, 503],
    ['missing role id', cfg({ roleId: undefined }), DEFAULT, 503],
    ['missing members url', cfg({ membersUrl: '' }), DEFAULT, 503],
    ['missing guild', cfg({ guildId: null }), DEFAULT, 503],
    ['missing api base', cfg({ discordApiBase: '' }), DEFAULT, 503],
    ['api base that only stringifies to a URL', cfg({ discordApiBase: { toString: () => 'https://d.test/api' } }), DEFAULT, 503],
  ]
  it.each(denials)('%s → %i, key never leaked', async (_, config, auth, status) => {
    const r = await call(config, auth)
    expect(r.status).toBe(status)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('Content-Type')).toBe('application/json')
    expect(MESSAGES[status]).toContain(JSON.parse(r.text).error)
    assertNoKey(r)
  })

  it('a member id given as a number in the list does not match (ids are strings)', async () => {
    const r = await call(cfg({ fetchImpl: upstream({ list: { status: 200, body: { ...LIST, memberIds: [Number(USER)] } } }) }))
    expect(r.status).toBe(403)
  })

  it('does not ask anyone anything when no token is present', async () => {
    const seen = []
    const r = await call(cfg({ fetchImpl: upstream({ seen }) }), '')
    expect(r.status).toBe(401)
    expect(seen).toEqual([])
  })

  it('never fetches the member list for a token Discord rejects', async () => {
    const seen = []
    await call(cfg({ fetchImpl: upstream({ me: { status: 401, body: {} }, seen }) }))
    expect(seen.map(([u]) => u)).toEqual(['https://d.test/api/users/@me'])
  })

  it('times out a hung upstream as 503', async () => {
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const r = await call(cfg({ fetchImpl: hang, timeoutMs: 20 }))
    expect(r.status).toBe(503)
  })

  it("identifies the caller with the caller's own token, and fetches the list without credentials", async () => {
    const seen = []
    await call(cfg({ fetchImpl: upstream({ seen }) }))
    expect(seen).toEqual([
      ['https://d.test/api/users/@me', `Bearer ${TOKEN}`],
      [MEMBERS_URL, undefined],
    ])
  })
})

describe('member list cache', () => {
  function counting(bodies) {
    let listFetches = 0
    const fetchImpl = async (url) => {
      if (url !== MEMBERS_URL) return new Response(JSON.stringify({ id: USER }))
      const b = bodies[Math.min(listFetches++, bodies.length - 1)]
      return b instanceof Response ? b : new Response(JSON.stringify(b))
    }
    return { fetchImpl, count: () => listFetches }
  }

  it('reuses the list for cacheMs, then refetches (role changes land within one window)', async () => {
    let t = 1_000_000
    const c = counting([LIST, { ...LIST, memberIds: [] }])
    const handle = createArchiveKeyHandler(cfg({ fetchImpl: c.fetchImpl, cacheMs: 60_000, now: () => t }))
    expect((await call(handle)).status).toBe(200)
    t += 59_999
    expect((await call(handle)).status).toBe(200)
    expect(c.count()).toBe(1)
    t += 1
    expect((await call(handle)).status).toBe(403)
    expect(c.count()).toBe(2)
  })

  it('a failed refresh is not cached: the next request tries again', async () => {
    const c = counting([new Response('down', { status: 500 }), LIST])
    const handle = createArchiveKeyHandler(cfg({ fetchImpl: c.fetchImpl }))
    expect((await call(handle)).status).toBe(503)
    expect((await call(handle)).status).toBe(200)
    expect(c.count()).toBe(2)
  })

  it('defaults to a 5 minute cache', async () => {
    let t = 0
    const c = counting([LIST])
    const handle = createArchiveKeyHandler(cfg({ fetchImpl: c.fetchImpl, now: () => t }))
    await call(handle)
    t = 299_999
    await call(handle)
    expect(c.count()).toBe(1)
    t = 300_000
    await call(handle)
    expect(c.count()).toBe(2)
  })
})

describe('kid', () => {
  it('matches the client crypto module for many keys (hex zero-padding included)', async () => {
    for (let i = 0; i < 32; i++) {
      const k = Buffer.alloc(32, i).toString('base64')
      const r = await call(cfg({ archiveKey: k }))
      expect(JSON.parse(r.text).kid).toBe((await deriveKeys(keyFromBase64(k))).kid)
    }
  })
})
