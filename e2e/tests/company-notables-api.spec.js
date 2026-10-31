import { test, expect } from '@playwright/test'

// GET /company-notables against the e2e stack (api + postgres + discord-mock): who may ask, and that the query
// runs against the real table. Nothing is seeded here (the stack starts empty and real members' names never enter
// the repo), so a member gets an empty answer; the route's behaviour with stored entries is pinned by the unit
// tests. Callers are named by their invented test tokens (e2e/discord-mock/server.js), never by id.
const API = process.env.API_URL || 'http://api:8787'

const MEMBER = 'test-member-token'
const NONMEMBER = 'test-nonmember-token'
const NOROLE = 'test-norole-token'

const as = (token) => ({ headers: { Authorization: `Bearer ${token}` } })
const get = (request, token) => request.get(`${API}/company-notables`, token ? as(token) : undefined)

test.describe('GET /company-notables', () => {
  test('a member gets the stored notables: an empty set on a fresh stack', async ({ request }) => {
    const res = await get(request, MEMBER)
    expect(res.status()).toBe(200)
    expect(await res.json()).toStrictEqual({ companies: {} })
  })

  test('a signed-in caller who is not a member is refused', async ({ request }) => {
    for (const token of [NONMEMBER, NOROLE]) {
      const res = await get(request, token)
      expect(res.status(), token).toBe(403)
      expect(await res.json(), token).not.toHaveProperty('companies')
    }
  })

  test('a missing or unknown token is 401', async ({ request }) => {
    expect((await get(request)).status()).toBe(401)
    expect((await get(request, 'garbage')).status()).toBe(401)
  })

  test('every answer is private and not cached, and none carries an id', async ({ request }) => {
    const answers = [await get(request, MEMBER), await get(request, NONMEMBER), await get(request), await get(request, 'garbage')]
    for (const res of answers) {
      expect(res.headers()['cache-control']).toBe('private, no-store')
      expect(await res.json()).not.toHaveProperty('id')
    }
  })
})
