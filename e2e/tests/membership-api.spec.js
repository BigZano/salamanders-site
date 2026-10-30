import { test, expect } from '@playwright/test'

// Membership against the e2e stack (api + postgres + discord-mock), with no page in the way: GET /membership,
// the member flag on GET /builds, and GET /archive/key all ask the same live membership check. Callers are
// named by their invented test tokens (e2e/discord-mock/server.js), never by id.
const API = process.env.API_URL || 'http://api:8787'

const MEMBER = 'test-member-token'
const NONMEMBER = 'test-nonmember-token'
const NOROLE = 'test-norole-token'

const as = (token) => ({ headers: { Authorization: `Bearer ${token}` } })
const get = (request, path, token) => request.get(`${API}${path}`, token ? as(token) : undefined)
const postBuild = (request, token, title) =>
  request.post(`${API}/builds`, { ...as(token), data: { title, className: 'Bulwark', role: '', notes: '' } })

test.describe('GET /membership', () => {
  test('says whether the caller is a member, and nothing else', async ({ request }) => {
    const member = await get(request, '/membership', MEMBER)
    expect(member.status()).toBe(200)
    expect(await member.json()).toStrictEqual({ member: true })

    for (const token of [NONMEMBER, NOROLE]) {
      const res = await get(request, '/membership', token)
      expect(res.status(), token).toBe(200)
      expect(await res.json(), token).toStrictEqual({ member: false })
    }
  })

  test('a missing or unknown token is 401', async ({ request }) => {
    expect((await get(request, '/membership')).status()).toBe(401)
    expect((await get(request, '/membership', 'garbage')).status()).toBe(401)
  })

  test('every answer is no-store and carries no id', async ({ request }) => {
    const answers = [
      await get(request, '/membership', MEMBER),
      await get(request, '/membership', NONMEMBER),
      await get(request, '/membership', NOROLE),
      await get(request, '/membership'),
      await get(request, '/membership', 'garbage'),
    ]
    for (const res of answers) {
      expect(res.headers()['cache-control']).toBe('no-store')
      expect(await res.json()).not.toHaveProperty('id')
    }
  })
})

test.describe('GET /builds flags members, for signed-in viewers only', () => {
  test.describe.configure({ mode: 'serial' })

  const stamp = Date.now()
  const memberTitle = `Membership API member build ${stamp}`
  const nonmemberTitle = `Membership API nonmember build ${stamp}`
  const authorOf = (builds, title) => builds.find((b) => b.title === title)?.author

  test.beforeAll(async ({ request }) => {
    expect((await postBuild(request, MEMBER, memberTitle)).status()).toBe(201)
    expect((await postBuild(request, NONMEMBER, nonmemberTitle)).status()).toBe(201)
  })

  test('without a token no author has a member key, and the answer varies on Authorization', async ({ request }) => {
    const res = await get(request, '/builds')
    expect(res.status()).toBe(200)
    expect(res.headers()['vary']).toContain('Authorization')
    // Nothing marks it private: this one is what a shared cache may keep, and it says nothing about membership.
    expect(res.headers()['cache-control'] ?? '').not.toContain('no-store')
    const builds = await res.json()
    expect(authorOf(builds, memberTitle)).toBeDefined()
    for (const b of builds) expect('member' in b.author, b.title).toBe(false)
  })

  test('with a member token each author is flagged, and the answer is private', async ({ request }) => {
    const res = await get(request, '/builds', MEMBER)
    expect(res.status()).toBe(200)
    expect(res.headers()['cache-control']).toBe('private, no-store')
    expect(res.headers()['vary']).toContain('Authorization')
    const builds = await res.json()
    expect(authorOf(builds, memberTitle).member).toBe(true)
    expect(authorOf(builds, nonmemberTitle).member).toBe(false)
    for (const b of builds) expect(typeof b.author.member, b.title).toBe('boolean')
  })

  test('the flag does not depend on who is asking: a non-member sees the same flags', async ({ request }) => {
    const res = await get(request, '/builds', NONMEMBER)
    expect(res.status()).toBe(200)
    expect(res.headers()['cache-control']).toBe('private, no-store')
    const builds = await res.json()
    expect(authorOf(builds, memberTitle).member).toBe(true)
    expect(authorOf(builds, nonmemberTitle).member).toBe(false)
  })

  test('an unknown token is not an error: the list comes back, unflagged', async ({ request }) => {
    const res = await get(request, '/builds', 'garbage')
    expect(res.status()).toBe(200)
    expect(res.headers()['vary']).toContain('Authorization')
    expect(res.headers()['cache-control'] ?? '').not.toContain('private')
    const builds = await res.json()
    expect(authorOf(builds, memberTitle)).toBeDefined()
    for (const b of builds) expect('member' in b.author, b.title).toBe(false)
  })
})

test.describe('GET /archive/key', () => {
  test('a member gets the key; everyone else is refused', async ({ request }) => {
    const member = await get(request, '/archive/key', MEMBER)
    expect(member.status()).toBe(200)
    expect(typeof (await member.json()).key).toBe('string')

    expect((await get(request, '/archive/key', NOROLE)).status()).toBe(403)
    expect((await get(request, '/archive/key', NONMEMBER)).status()).toBe(403)
    expect((await get(request, '/archive/key')).status()).toBe(401)
  })
})
