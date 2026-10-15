import { test, expect } from '@playwright/test'

// A visitor who has not signed in. The roster shows leaders by name and every other rank as a count
// (GET /roster/public; see roster-public.spec.js for the endpoint itself).

test('a visitor sees each company head and the ranks as counts, never the ladder', async ({ page }) => {
  await page.goto('/companies')
  const third = page.locator('[data-branch="company-3"]')
  await expect(third.locator('.rs-head')).toContainText('E2E Captain')
  await expect(page.locator('.rs-branch')).toHaveCount(12)
  await expect(page.locator('.rs-high-command')).toBeVisible()

  await third.locator('button.rs-bar-btn').click()
  await expect(third.locator('.rs-shape-row').first()).toBeVisible()
  await expect(third).not.toContainText('E2E Sergeant')
  await expect(third.locator('.rs-ladder')).toHaveCount(0)
})

test('none of the member tools are there for a visitor', async ({ page }) => {
  await page.goto('/companies')
  await expect(page.locator('.rs-branch')).toHaveCount(12)
  await expect(page.locator('.rs-status')).toHaveCount(0)
  await expect(page.locator('#muster')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Infirmary' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Find me' })).toHaveCount(0)
})

test('nothing that identifies an account is in the page', async ({ page }) => {
  await page.goto('/companies')
  await expect(page.locator('.rs-branch')).toHaveCount(12)
  const html = await page.locator('.companies').innerHTML()
  expect(html).not.toMatch(/data-id="\d{17,20}"/)
  expect(html).not.toContain('cdn.discordapp.com')
  expect(html).not.toContain('E2E Sergeant')
})

test('an opened bar offers the sign-in', async ({ page }) => {
  await page.goto('/companies')
  const third = page.locator('[data-branch="company-3"]')
  await third.locator('button.rs-bar-btn').click()
  await expect(third.getByRole('button', { name: 'Sign in with Discord' })).toBeVisible()
})

test('the story is there whether or not the roster is', async ({ page }) => {
  await page.route('**/roster/public', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"The roster is not available yet. Try again."}' }))
  await page.goto('/companies')
  await expect(page.locator('article.company')).toHaveCount(12)
  await expect(page.locator('.rs-branch')).toHaveCount(0)
})

test('the old /roster link redirects to Companies', async ({ page }) => {
  await page.goto('/roster#forge')
  await expect(page).toHaveURL(/\/companies#armoury$/)
})
