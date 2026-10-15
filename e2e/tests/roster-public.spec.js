import { test, expect } from '@playwright/test'

// The API container, reached from the Playwright container the same way roster.spec.js
// reaches discord-mock. No sign-in anywhere in this file.
const API = process.env.API_URL || 'http://api:8787'
// The page's origin, as docker-compose.yml hands it to the api container (ALLOWED_ORIGIN).
const SITE = 'http://localhost:5173'

test('GET /roster/public answers without signing in, naming leaders only', async ({ request }) => {
  const res = await request.get(`${API}/roster/public`)
  expect(res.status()).toBe(200)
  expect(res.headers()['cache-control']).toBe('public, max-age=60')

  const body = await res.json()
  expect(body.branches.length).toBeGreaterThan(0)
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

test('CORS: the one configured origin is allowed, whoever asks, never reflected or a wildcard', async ({ request }) => {
  for (const origin of [SITE, 'https://evil.example', 'null']) {
    const res = await request.get(`${API}/roster/public`, { headers: { Origin: origin } })
    expect(res.status()).toBe(200)
    expect(res.headers()['access-control-allow-origin']).toBe(SITE)
  }
  expect((await request.get(`${API}/roster/public`)).headers()['access-control-allow-origin']).toBe(SITE)
})

test('CORS: a preflight for the public route is answered', async ({ request }) => {
  const res = await request.fetch(`${API}/roster/public`, {
    method: 'OPTIONS',
    headers: { Origin: SITE, 'Access-Control-Request-Method': 'GET' },
  })
  expect(res.status()).toBe(204)
  expect(res.headers()['access-control-allow-origin']).toBe(SITE)
  expect(res.headers()['access-control-allow-methods']).toContain('GET')
})

test('CORS: a browser on the site can read the public roster across origins', async ({ page }) => {
  await page.goto('/')
  const seen = await page.evaluate(async (url) => {
    const res = await fetch(url) // a browser rejects this unless the CORS headers allow the page's origin
    const body = await res.json()
    return { status: res.status, branches: body.branches.length }
  }, `${API}/roster/public`)
  expect(seen.status).toBe(200)
  expect(seen.branches).toBeGreaterThan(0)
})
