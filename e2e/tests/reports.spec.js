import { test, expect } from '@playwright/test'

// Same fragment-callback sign-in as builds.spec.js, against e2e/discord-mock.
async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name')).toBeVisible()
}

test('a member files a report and a Reclusiarch claims and resolves it', async ({ browser }) => {
  const who = `E2E Brother ${Date.now()}`

  const member = await (await browser.newContext()).newPage()
  await signIn(member, 'test-member-token')
  await member.goto('/reports')
  await member.getByLabel('Member being reported').fill(who)
  await member.getByLabel('Where did it happen?').selectOption('voice')
  await member.getByLabel('What happened?').fill('Broke the code in voice.')
  await member.getByRole('button', { name: 'File report' }).click()
  await expect(member.locator('.r-sent')).toContainText('filed')
  await expect(member.locator('.r-row', { hasText: who })).toContainText('Received')
  // A plain member has no review queue.
  await expect(member.getByRole('link', { name: /review queue/ })).toHaveCount(0)

  const recl = await (await browser.newContext()).newPage()
  await signIn(recl, 'test-reclusiarch-token')
  await recl.goto('/reports/review')
  await recl.locator('.rv-item', { hasText: who }).click()
  await recl.getByRole('button', { name: 'Claim' }).click()
  await recl.locator('.rv-actions textarea').first().fill('Spoke with him.')
  await recl.getByRole('button', { name: 'Resolve' }).click()
  await expect(recl.locator('.rv-detail')).toContainText('Resolved')
  await expect(recl.locator('.rv-events')).toContainText('reclusiarch-tester resolved')

  await member.reload()
  await expect(member.locator('.r-row', { hasText: who })).toContainText('Resolved')
})

test('the Reclusiarch bypass links to the official form and files nothing', async ({ page }) => {
  await signIn(page, 'test-member-token')
  await page.goto('/reports')
  await page.getByLabel('Member being reported').fill('A Reclusiarch')
  await page.getByLabel('This involves a Reclusiarch').check()
  await expect(page.getByRole('button', { name: 'File report' })).toHaveCount(0)
  const href = await page.getByRole('link', { name: 'Open the official form' }).getAttribute('href')
  expect(href).toContain('docs.google.com/forms')
  expect(new URL(href).searchParams.get('entry.1659452298')).toBe('A Reclusiarch')
})

test('a signed-in non-member is turned away', async ({ page }) => {
  await signIn(page, 'test-nonmember-token')
  await page.goto('/reports')
  await expect(page.getByText('Reports are open to XVIIIth Legion members.')).toBeVisible()
})
