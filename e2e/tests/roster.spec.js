import { test, expect } from '@playwright/test'

// Same fragment-callback sign-in as reports.spec.js, against e2e/discord-mock.
async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name')).toBeVisible()
}

// The roster lives on /companies now (docs/superpowers/specs/2026-10-14-companies-roster-merge-design.md).
// The member's toolbar (.rs-status) is the sign that the full roster has loaded.
async function openCompanies(page) {
  await page.goto('/companies')
  await expect(page.getByRole('heading', { name: 'Companies & Sections' })).toBeVisible()
}
const rosterLoaded = (page) => expect(page.locator('.rs-status')).toBeVisible()

test('a Legion member sees the order of battle, without the Infirmary', async ({ page }) => {
  await signIn(page, 'test-member-token')
  await openCompanies(page)
  await rosterLoaded(page)

  const third = page.locator('[data-branch="company-3"]')
  await expect(third.locator('.rs-head')).toContainText('E2E Captain')
  await expect(third).toContainText('E2E Sergeant')
  await expect(page.locator('[data-branch="company-2"] .rs-head')).toContainText('Vacant')
  await expect(page.locator('#muster .rs-servitors')).toContainText('E2E Servitor')
  // Infirmary holders are not on the main roster, and a plain member has no Infirmary button.
  await expect(page.locator('.companies')).not.toContainText('E2E Convalescent')
  await expect(page.getByRole('button', { name: 'Infirmary' })).toHaveCount(0)
})

test('company command sees the Infirmary, with who still holds the Legion role', async ({ page }) => {
  await signIn(page, 'test-captain-token')
  await openCompanies(page)
  await page.getByRole('button', { name: 'Infirmary' }).click()

  const list = page.locator('.rs-infirmary')
  await expect(list).toContainText('E2E Convalescent')
  await expect(list).toContainText('E2E Recruit On Leave')
  await expect(list.locator('[data-id="100000000000000022"]')).toContainText('Still holds the Legion role')
  await expect(list.locator('[data-id="100000000000000023"]')).not.toContainText('Still holds the Legion role')
})

test('a signed-in account without the Legion role sees the public view, not the ladders', async ({ page }) => {
  await signIn(page, 'test-norole-token')
  await openCompanies(page)
  // the full roster refuses them (403); the page falls back to what the public sees
  await expect(page.locator('[data-branch="company-3"] .rs-head')).toContainText('E2E Captain')
  await expect(page.locator('.rs-branch')).toHaveCount(12)
  await expect(page.locator('.rs-ladder')).toHaveCount(0)
  await expect(page.locator('.rs-status')).toHaveCount(0)
  await expect(page.locator('#muster')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Expand all' })).toHaveCount(0)
})

test('a member who leaves the guild drops off the roster at the next refresh', async ({ page, request }) => {
  await signIn(page, 'test-member-token')
  await openCompanies(page)
  await rosterLoaded(page)
  await expect(page.locator('.companies')).toContainText('E2E Leaver')

  await request.post('http://discord-mock:4400/__test/leave/100000000000000024')
  await expect
    .poll(
      async () => {
        await page.reload()
        await page.getByRole('heading', { name: 'Companies & Sections' }).waitFor()
        await page.locator('.rs-status').waitFor() // the roster has loaded, so a zero below means gone, not "not yet"
        return page.locator('.companies').getByText('E2E Leaver').count()
      },
      { timeout: 30_000, intervals: [2_500] },
    )
    .toBe(0)
})

// The design pass (docs/superpowers/specs/2026-10-13-roster-design-pass-design.md).
// test-captain-token is member 100000000000000020, Captain of the 3rd Company in the Discord mock.
test("Find me opens the viewer's own branch", async ({ page }) => {
  await signIn(page, 'test-captain-token')
  await openCompanies(page)
  await page.getByRole('button', { name: 'Find me' }).click()
  await expect(page.locator('[data-branch="company-3"]')).toHaveAttribute('data-open', '')
  await expect(page.locator('.rs-me')).toBeVisible()
})

test('Expand all opens every bar that has ranks, and Collapse all closes them', async ({ page }) => {
  await signIn(page, 'test-member-token')
  await openCompanies(page)
  await rosterLoaded(page)
  await expect(page.locator('[data-open]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(page.locator('[data-branch="company-3"]')).toHaveAttribute('data-open', '')
  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(page.locator('[data-open]')).toHaveCount(0)
})

test('a /companies#third link scrolls to that company and opens its bar', async ({ page }) => {
  await signIn(page, 'test-member-token')
  await page.goto('/companies#third')
  await expect(page.locator('[data-branch="company-3"]')).toHaveAttribute('data-open', '')
  await expect(page.locator('#third')).toBeInViewport()
})

test('an old /roster#company-3 link lands on the same company', async ({ page }) => {
  await signIn(page, 'test-member-token')
  await page.goto('/roster#company-3')
  await expect(page).toHaveURL(/\/companies#third$/)
  await expect(page.locator('[data-branch="company-3"]')).toHaveAttribute('data-open', '')
})
