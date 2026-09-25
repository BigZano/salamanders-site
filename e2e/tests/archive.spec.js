import { test, expect } from '@playwright/test'

const SENTINEL = 'FIXTURE-PLAINTEXT-SENTINEL'
const A_TOC = '100000000000000001'
const R_TOC = '200000000000000001'
const R_MSG = '200000000000000011'

async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name')).toBeVisible()
}

// Every response body in the flow must be free of fixture plaintext:
// decrypted content may only exist in the DOM.
function watchResponses(page) {
  const leaks = []
  page.on('response', async (res) => {
    try {
      const body = await res.body()
      if (body.toString('latin1').includes(SENTINEL)) leaks.push(res.url())
    } catch {}
  })
  return leaks
}

test('role holder reads both collections and follows links between them', async ({ page }) => {
  const leaks = watchResponses(page)
  await signIn(page, 'test-member-token')
  await page.locator('.nav-links').getByRole('link', { name: 'Accolades' }).click()
  await expect(page).toHaveURL(/\/accolades$/)
  await expect(page.locator('.arch-thread')).toContainText(`${SENTINEL}-accolades`)
  // Scoped to the content: the nav bar also has a "Ranks" link.
  await page.locator('.arch-thread').getByRole('link', { name: 'Ranks', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/ranks/${R_TOC}#m-${R_MSG}$`))
  await expect(page.locator(`#m-${R_MSG}`)).toBeInViewport()
  await page.locator('.arch-thread').getByRole('link', { name: 'Back' }).click()
  await expect(page).toHaveURL(new RegExp(`/accolades/${A_TOC}#m-`))
  const hrefs = await page.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') || ''))
  expect(hrefs.filter((h) => /discord(app)?\.com|discord\.gg/.test(h) && !h.startsWith('https://discord.gg/salamanders'))).toEqual([])
  expect(leaks).toEqual([])
})

test('signed-in member without the role is refused and never receives the key', async ({ page }) => {
  const leaks = watchResponses(page)
  const keyResponses = []
  page.on('response', (r) => r.url().endsWith('/archive/key') && keyResponses.push(r.status()))
  await signIn(page, 'test-norole-token')
  await page.goto('/accolades')
  await expect(page.getByRole('alert')).toContainText("doesn't currently hold the role")
  await expect(page.locator('.arch-thread')).toHaveCount(0)
  expect(keyResponses).toEqual([403])
  expect(leaks).toEqual([])
})

test('signed out: prompt, no content; deep-link anchor survives sign-in', async ({ page }) => {
  const leaks = watchResponses(page)
  await page.goto(`/ranks/${R_TOC}#m-${R_MSG}`)
  const gateButton = page.locator('.gate').getByRole('button', { name: 'Sign in with Discord' })
  await expect(gateButton).toBeVisible()
  await expect(page.locator('.arch-thread')).toHaveCount(0)
  // Simulate the Discord round-trip. Aborting the navigation to Discord keeps
  // us on the page after the click has stashed the return path and anchor;
  // Discord would then send the browser to the site root with a token.
  await page.route('https://discord.com/**', (r) => r.abort())
  await gateButton.click()
  await page.goto('/#access_token=test-member-token&expires_in=3600')
  await expect(page).toHaveURL(new RegExp(`/ranks/${R_TOC}#m-${R_MSG}$`))
  await expect(page.locator(`#m-${R_MSG}`)).toBeInViewport()
  expect(leaks).toEqual([])
})

test('signing out while reading removes the content immediately', async ({ page }) => {
  await signIn(page, 'test-member-token')
  await page.goto('/accolades')
  await expect(page.locator('.arch-thread')).toBeVisible()
  await page.locator('.nav-bar').getByRole('button', { name: 'Sign out' }).click()
  await expect(page.locator('.arch-thread')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in with Discord' })).toBeVisible()
})
