import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => console.log('[pageerror]', err.message))
})

// Sign-in in this suite skips Discord's real OAuth redirect entirely: it
// lands directly on the callback shape Discord would produce (an
// access_token in the URL fragment), which src/lib/discordAuth.js's
// scrubCallbackHash()/finishSignIn() already handle on any page load. The
// token is then identified against e2e/discord-mock instead of the real
// Discord API (see DISCORD_API_BASE / VITE_DISCORD_API_BASE in
// e2e/docker-compose.yml).
async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name')).toBeVisible()
}

async function createAndSaveBuild(page, title) {
  await page.locator('.nav-links').getByRole('link', { name: 'Perk Builder' }).click()
  await expect(page).toHaveURL(/\/planner$/)
  await page.locator('.perk').first().click()
  await page.getByLabel('Build name').fill(title)
  await page.getByRole('button', { name: 'Save to library' }).click()
  await expect(page.locator('.toast')).toContainText('Saved')
}

async function goToBuilds(page) {
  await page.locator('.nav-links').getByRole('link', { name: 'Builds' }).click()
  await expect(page).toHaveURL(/\/builds$/)
}

test.describe('create + save a build', () => {
  test("a verified member's build is badged and lands in Verified Members", async ({ page }) => {
    await signIn(page, 'test-member-token')
    const title = `E2E Member Build ${Date.now()}`
    await createAndSaveBuild(page, title)
    await goToBuilds(page)

    const memberSection = page.locator('.b-section', { hasText: 'Verified Members' })
    const card = memberSection.locator('.b-card', { hasText: title })
    await expect(card).toBeVisible()
    await expect(card.locator('.b-member-badge')).toBeVisible()
  })

  test("a non-member's build is unbadged and lands in Community Builds, not Verified Members", async ({
    page,
  }) => {
    await signIn(page, 'test-nonmember-token')
    const title = `E2E Nonmember Build ${Date.now()}`
    await createAndSaveBuild(page, title)
    await goToBuilds(page)

    const communitySection = page.locator('.b-section', { hasText: 'Community Builds' })
    const card = communitySection.locator('.b-card', { hasText: title })
    await expect(card).toBeVisible()
    await expect(card.locator('.b-member-badge')).toHaveCount(0)

    const memberSection = page.locator('.b-section', { hasText: 'Verified Members' })
    await expect(memberSection.locator('.b-card', { hasText: title })).toHaveCount(0)
  })

  test('a signed-out visitor triggers Discord sign-in rather than saving silently', async ({ page }) => {
    // The real gate calls beginSignIn(), which navigates the whole page to
    // Discord's authorize URL — even aborted (route below), that navigation
    // attempt tears down the current document before any later assertion
    // could run, so the proof here is the outgoing request itself, not a
    // post-click DOM state.
    await page.route('https://discord.com/**', (route) => route.abort())

    await page.goto('/planner')
    await expect(page.locator('.auth-signin')).toBeVisible()

    await page.locator('.perk').first().click()
    await page.getByLabel('Build name').fill('Should not save')

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().startsWith('https://discord.com/oauth2/authorize')),
      page.getByRole('button', { name: 'Save to library' }).click(),
    ])
    const authorizeUrl = new URL(request.url())
    expect(authorizeUrl.searchParams.get('response_type')).toBe('token')
    expect(authorizeUrl.searchParams.get('scope')).toBe('identify')
  })
})
