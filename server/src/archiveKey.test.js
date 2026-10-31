import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createArchiveKeyHandler } from './archiveKey'
import { Upstream } from './discordRoles'
import { deriveKeys, keyFromBase64 } from '../../src/lib/archive/crypto'

// Invented ids only: real member and role ids never enter the repo.
const ME = '300000000000000001'
const KEY = Buffer.alloc(32, 7).toString('base64')
const TOKEN = 'good.token-value_1'

const req = (token = TOKEN) =>
  new Request('https://api.test/archive/key', { headers: token === null ? {} : { Authorization: `Bearer ${token}` } })

// A fake membership seam. `check` is whatever the test scripts: it resolves a
// value or throws (so a test can make Discord "fail" with anything).
const fake = (check) => ({ check: async (request) => check(request) })
const answers = (value) => fake(() => value)
const fails = (thrown) =>
  fake(() => {
    throw thrown
  })
// Reaching the membership check at all is the failure being tested.
const NEVER_ASKED = fake(() => {
  throw new Error('membership was asked although the archive key is not usable')
})

async function askWithKey(membership, archiveKey, request = req()) {
  const res = await createArchiveKeyHandler({ membership, archiveKey })(request)
  return { res, text: await res.text() }
}
const ask = (membership, request) => askWithKey(membership, KEY, request)
const body = ({ text }) => JSON.parse(text)

const SIGN_IN = { error: 'Sign in with Discord.' }
const LEGION_ONLY = { error: 'Restricted to the XVIIIth Legion.' }
const UNREACHABLE = { error: 'Discord could not be reached. Try again.' }
const UNAVAILABLE = { error: 'Archive unavailable.' }

function expectAnswer(r, status, expected) {
  expect(r.res.status).toBe(status)
  expect(r.res.headers.get('Content-Type')).toBe('application/json')
  expect(r.res.headers.get('Cache-Control')).toBe('no-store')
  expect(body(r)).toStrictEqual(expected)
}
function expectNoKey(r) {
  expect(r.text).not.toContain(KEY)
  for (const [, v] of r.res.headers) expect(v).not.toContain(KEY)
}

describe('GET /archive/key — a member gets the key', () => {
  it('a member gets the key and the kid of that key', async () => {
    // Decided by the caller's own request, so a handler that forgets to pass it on is caught.
    const m = fake((request) =>
      request.headers.get('Authorization') === `Bearer ${TOKEN}` ? { id: ME, member: true } : null,
    )
    const r = await ask(m)
    expectAnswer(r, 200, { key: KEY, kid: (await deriveKeys(keyFromBase64(KEY))).kid })
  })

  it('the same fake refuses a request that is not the member’s (the answer follows the request)', async () => {
    const m = fake((request) =>
      request.headers.get('Authorization') === `Bearer ${TOKEN}` ? { id: ME, member: true } : null,
    )
    expectAnswer(await ask(m, req('someone-else')), 401, SIGN_IN)
    expectAnswer(await ask(m, req(null)), 401, SIGN_IN)
  })

  it('a key with + and / in it is accepted (all of the base64 alphabet is)', async () => {
    const k = Buffer.alloc(32, 0xfb).toString('base64')
    expect(k).toContain('+')
    expect(k).toContain('/')
    expectAnswer(await askWithKey(answers({ id: ME, member: true }), k), 200, {
      key: k,
      kid: (await deriveKeys(keyFromBase64(k))).kid,
    })
  })

  it('extra fields on a membership answer do not matter, and are not echoed', async () => {
    const r = await ask(answers({ id: ME, member: true, roles: ['x'], token: TOKEN }))
    expect(Object.keys(body(r)).sort()).toStrictEqual(['key', 'kid'])
    expect(r.text).not.toContain(TOKEN)
  })
})

describe('GET /archive/key — every other answer withholds the key', () => {
  const denials = [
    ['no token', answers(null), 401, SIGN_IN],
    ['not a member', answers({ id: ME, member: false }), 403, LEGION_ONLY],
    ['Upstream', fails(new Upstream('Discord is unreachable.')), 503, UNREACHABLE],
    ['plain Error', fails(new Error('boom')), 503, UNREACHABLE],
    ['an Error that carries the key in its message', fails(new Error(`boom ${KEY}`)), 503, UNREACHABLE],
    ['a rejection that is a string', fails('boom'), 503, UNREACHABLE],
    ['a rejection that is undefined', fails(undefined), 503, UNREACHABLE],
    ['a rejection that is null', fails(null), 503, UNREACHABLE],
    ['a membership answer that is undefined', answers(undefined), 403, LEGION_ONLY],
    ['a membership answer that is a string', answers('member'), 403, LEGION_ONLY],
    ['a membership answer that is a number', answers(1), 403, LEGION_ONLY],
    ['a membership answer with no member field', answers({ id: ME }), 403, LEGION_ONLY],
    ['member: "true"', answers({ id: ME, member: 'true' }), 403, LEGION_ONLY],
    ['member: 1', answers({ id: ME, member: 1 }), 403, LEGION_ONLY],
    ['member: {}', answers({ id: ME, member: {} }), 403, LEGION_ONLY],
    ['member: []', answers({ id: ME, member: [] }), 403, LEGION_ONLY],
    ['member: null', answers({ id: ME, member: null }), 403, LEGION_ONLY],
    ['member: Boolean object', answers({ id: ME, member: new Boolean(true) }), 403, LEGION_ONLY],
  ]
  it.each(denials)('%s → %i, key never leaked', async (_, membership, status, expected) => {
    const r = await ask(membership)
    expectAnswer(r, status, expected)
    expectNoKey(r)
  })

  it('whatever the membership check resolves, the key is only for member: true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.anything().filter((v) => v !== null && v?.member !== true),
        async (resolved) => {
          const r = await ask(answers(resolved))
          expectAnswer(r, 403, LEGION_ONLY)
          expectNoKey(r)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('whatever the member field holds, only the boolean true is a member', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.anything().filter((v) => v !== true),
        async (member) => {
          const r = await ask(answers({ id: ME, member }))
          expectAnswer(r, 403, LEGION_ONLY)
          expectNoKey(r)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('whatever the membership check rejects with, the answer is 503 and says nothing of it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (thrown) => {
        const r = await ask(fails(thrown))
        expectAnswer(r, 503, UNREACHABLE)
        expectNoKey(r)
      }),
      { numRuns: 200 },
    )
  })
})

describe('GET /archive/key — an unusable ARCHIVE_KEY', () => {
  // Valid shape: 43 base64 characters and one "=" (32 bytes).
  const bad = [
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['a number', 42],
    ['an object that only stringifies to a valid key', { toString: () => KEY }],
    ['an array holding a valid key', [KEY]],
    ['42 base64 characters', KEY.slice(0, 42)],
    ['43 characters with no padding', KEY.slice(0, 43)],
    ['padding twice', `${KEY}=`],
    ['44 base64 characters', 'A'.repeat(44)],
    ['two padding characters', `${KEY.slice(0, 42)}==`],
    ['a leading space', ` ${KEY}`],
    ['a trailing space', `${KEY} `],
    ['a trailing newline', `${KEY}\n`],
    ['a leading newline', `\n${KEY}`],
    ['a trailing character after the padding', `${KEY}A`],
    ['a leading character before a full key', `A${KEY}`],
    ['two keys', `${KEY}${KEY}`],
    ['the url-safe alphabet', Buffer.alloc(32, 0xfb).toString('base64url') + '='],
    ['a non-base64 character at the start', `!${KEY.slice(1)}`],
    ['a non-base64 character in the middle', `${KEY.slice(0, 20)}!${KEY.slice(21)}`],
    ['a non-base64 character before the padding', `${KEY.slice(0, 42)}!=`],
    ['a non-ASCII digit', `${KEY.slice(0, 20)}٣${KEY.slice(21)}`],
  ]
  it.each(bad)('%s → 503 Archive unavailable, and asks nobody', async (_, archiveKey) => {
    const r = await askWithKey(NEVER_ASKED, archiveKey)
    expectAnswer(r, 503, UNAVAILABLE)
  })

  it('is unavailable to a member too: the key check comes first', async () => {
    expectAnswer(await askWithKey(answers({ id: ME, member: true }), 'short'), 503, UNAVAILABLE)
  })

  it('for any string that is not exactly 43 base64 characters and "=", asks nobody', async () => {
    const shaped = /^[A-Za-z0-9+/]{43}=$/
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 60 }).filter((s) => !shaped.test(s)),
        async (archiveKey) => {
          expectAnswer(await askWithKey(NEVER_ASKED, archiveKey), 503, UNAVAILABLE)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('GET /archive/key — every answer is no-store', () => {
  const member = answers({ id: ME, member: true })
  const answersOf = [
    ['200', () => ask(member), 200],
    ['401', () => ask(answers(null)), 401],
    ['403', () => ask(answers({ id: ME, member: false })), 403],
    ['503 from Discord', () => ask(fails(new Upstream())), 503],
    ['503 from the archive key', () => askWithKey(NEVER_ASKED, 'short'), 503],
  ]
  it.each(answersOf)('%s', async (_, run, status) => {
    const r = await run()
    expect(r.res.status).toBe(status)
    expect(r.res.headers.get('Cache-Control')).toBe('no-store')
    expect(r.res.headers.get('Content-Type')).toBe('application/json')
  })
})

describe('kid', () => {
  const member = answers({ id: ME, member: true })

  it('matches the client crypto module for many keys (hex zero-padding included)', async () => {
    for (let i = 0; i < 32; i++) {
      const k = Buffer.alloc(32, i).toString('base64')
      const r = await askWithKey(member, k)
      expect(body(r).kid).toBe((await deriveKeys(keyFromBase64(k))).kid)
    }
  })

  it('matches the client crypto module for any 32 bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async (bytes) => {
        const k = Buffer.from(bytes).toString('base64')
        const r = await askWithKey(member, k)
        expectAnswer(r, 200, { key: k, kid: (await deriveKeys(keyFromBase64(k))).kid })
      }),
      { numRuns: 100 },
    )
  })
})
