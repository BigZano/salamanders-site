import { describe, it, expect } from 'vitest'
import { createArchiveKeyHandler } from './archiveKey'
import { deriveKeys, keyFromBase64 } from '../../src/lib/archive/crypto'

const KEY = Buffer.alloc(32, 7).toString('base64')
const ROLE = '1377787723976409211'
const GUILD = '1322056087792521269'
const USER = '75633559351595008'
const TOKEN = 'good.token-value_1'

function discord({ me = { status: 200, body: { id: USER, username: 'u' } }, member = { status: 200, body: { roles: [ROLE] } }, throws } = {}) {
  return async (url, init) => {
    if (throws) throw throws
    const r = url.endsWith('/users/@me') ? me : member
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status })
    return new Response(JSON.stringify(r.body), { status: r.status })
  }
}
const cfg = (over = {}) => ({
  fetchImpl: discord(), discordApiBase: 'https://d.test/api', guildId: GUILD, roleId: ROLE, botToken: 'bot', archiveKey: KEY, ...over,
})
const NONE = Symbol('no Authorization header')
const DEFAULT = `Bearer ${TOKEN}`
const req = (auth) => new Request('https://api.test/archive/key', { headers: auth === NONE ? {} : { Authorization: auth } })

async function call(config, auth = DEFAULT) {
  const res = await createArchiveKeyHandler(config)(req(auth))
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
  it('role holder gets the key and the kid of that key', async () => {
    const r = await call(cfg())
    expect(r.status).toBe(200)
    const body = JSON.parse(r.text)
    expect(body.key).toBe(KEY)
    expect(body.kid).toBe((await deriveKeys(keyFromBase64(KEY))).kid)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })

  // (CR/LF injection can't be tested here: the Fetch Headers class itself
  // rejects such values before any handler runs — Bun's included.)
  const denials = [
    ['no Authorization header', cfg(), NONE, 401],
    ['empty Authorization', cfg(), '', 401],
    ['Basic scheme', cfg(), 'Basic abc', 401],
    ['Bearer with no token', cfg(), 'Bearer ', 401],
    ['token with a space (header smuggling)', cfg(), 'Bearer a b', 401],
    ['token with a tab', cfg(), 'Bearer a\tb', 401],
    ['token with a quote', cfg(), 'Bearer a"b', 401],
    ['oversized token', cfg(), `Bearer ${'a'.repeat(600)}`, 401],
    ['Discord rejects token (401)', cfg({ fetchImpl: discord({ me: { status: 401, body: {} } }) }), DEFAULT, 401],
    ['Discord forbids token (403)', cfg({ fetchImpl: discord({ me: { status: 403, body: {} } }) }), DEFAULT, 401],
    ['identify rate-limited (429)', cfg({ fetchImpl: discord({ me: { status: 429, body: {} } }) }), DEFAULT, 503],
    ['identify 5xx', cfg({ fetchImpl: discord({ me: { status: 502, body: {} } }) }), DEFAULT, 503],
    ['identify 5xx that still carries an id', cfg({ fetchImpl: discord({ me: { status: 500, body: { id: USER } } }) }), DEFAULT, 503],
    ['identify 202 with an id (not a clean 200)', cfg({ fetchImpl: discord({ me: { status: 202, body: { id: USER } } }) }), DEFAULT, 503],
    ['identify non-JSON', cfg({ fetchImpl: discord({ me: { status: 200, raw: '<html>' } }) }), DEFAULT, 503],
    ['identify body missing id', cfg({ fetchImpl: discord({ me: { status: 200, body: { username: 'x' } } }) }), DEFAULT, 503],
    ['identify id not a snowflake', cfg({ fetchImpl: discord({ me: { status: 200, body: { id: '../x' } } }) }), DEFAULT, 503],
    ['not in guild (404)', cfg({ fetchImpl: discord({ member: { status: 404, body: {} } }) }), DEFAULT, 403],
    ['in guild without role', cfg({ fetchImpl: discord({ member: { status: 200, body: { roles: ['1'] } } }) }), DEFAULT, 403],
    ['roles not an array', cfg({ fetchImpl: discord({ member: { status: 200, body: { roles: ROLE } } }) }), DEFAULT, 503],
    ['member lookup rate-limited (429)', cfg({ fetchImpl: discord({ member: { status: 429, body: {} } }) }), DEFAULT, 503],
    ['member lookup 5xx', cfg({ fetchImpl: discord({ member: { status: 500, body: {} } }) }), DEFAULT, 503],
    ['member lookup 5xx that still lists the role', cfg({ fetchImpl: discord({ member: { status: 500, body: { roles: [ROLE] } } }) }), DEFAULT, 503],
    ['archive key that only stringifies to base64', cfg({ archiveKey: { toString: () => KEY } }), DEFAULT, 503],
    ['member lookup non-JSON', cfg({ fetchImpl: discord({ member: { status: 200, raw: 'nope' } }) }), DEFAULT, 503],
    ['network error', cfg({ fetchImpl: discord({ throws: new TypeError('fetch failed') }) }), DEFAULT, 503],
    ['missing ARCHIVE_KEY', cfg({ archiveKey: '' }), DEFAULT, 503],
    ['malformed ARCHIVE_KEY', cfg({ archiveKey: 'short' }), DEFAULT, 503],
    ['missing role id', cfg({ roleId: undefined }), DEFAULT, 503],
    ['missing bot token', cfg({ botToken: '' }), DEFAULT, 503],
    ['missing guild', cfg({ guildId: null }), DEFAULT, 503],
    ['missing api base', cfg({ discordApiBase: '' }), DEFAULT, 503],
  ]
  it.each(denials)('%s → %i, key never leaked', async (_, config, auth, status) => {
    const r = await call(config, auth)
    expect(r.status).toBe(status)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('Content-Type')).toBe('application/json')
    expect(MESSAGES[status]).toContain(JSON.parse(r.text).error)
    assertNoKey(r)
  })

  it('does not ask Discord anything when no token is present', async () => {
    let asked = false
    const r = await call(cfg({ fetchImpl: async () => ((asked = true), new Response('{}')) }), '')
    expect(r.status).toBe(401)
    expect(asked).toBe(false)
  })

  it('times out a hung Discord call as 503', async () => {
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const r = await call(cfg({ fetchImpl: hang, timeoutMs: 20 }))
    expect(r.status).toBe(503)
  })

  it('checks the role against the configured guild and the caller id, using the bot token', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push([url, init.headers.Authorization])
      return new Response(JSON.stringify(url.endsWith('@me') ? { id: USER } : { roles: [ROLE] }))
    }
    await call(cfg({ fetchImpl }))
    expect(seen).toEqual([
      ['https://d.test/api/users/@me', `Bearer ${TOKEN}`],
      [`https://d.test/api/v10/guilds/${GUILD}/members/${USER}`, 'Bot bot'],
    ])
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
