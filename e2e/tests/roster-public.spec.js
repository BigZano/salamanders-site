import { test, expect } from '@playwright/test'

// The API container, reached from the Playwright container the same way roster.spec.js
// reaches discord-mock. No sign-in anywhere in this file.
const API = 'http://api:8787'

test('GET /roster/public answers without signing in, naming leaders only', async ({ request }) => {
  const res = await request.get(`${API}/roster/public`)
  expect(res.status()).toBe(200)
  expect(res.headers()['cache-control']).toBe('public, max-age=60')

  const body = await res.json()
  expect(body.branches).toHaveLength(12)
  const third = body.branches.find((b) => b.key === 'company-3')
  expect(third.head.members.map((m) => m.name)).toContain('E2E Captain')
  expect(body.branches.find((b) => b.key === 'company-2').head.vacant).toBe(true)

  // Below the head it is counts, never names; nothing that identifies an account leaves the server.
  const text = JSON.stringify(body)
  for (const hidden of ['E2E Sergeant', 'E2E Servitor', 'E2E Convalescent', 'E2E Leaver']) expect(text).not.toContain(hidden)
  expect(text).not.toMatch(/\d{17,20}/)
  expect(text).not.toContain('cdn.discordapp.com')
})

test('the full roster still needs a sign-in', async ({ request }) => {
  expect((await request.get(`${API}/roster`)).status()).toBe(401)
  expect((await request.get(`${API}/roster/infirmary`)).status()).toBe(401)
})
