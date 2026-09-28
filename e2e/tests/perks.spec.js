import { test, expect } from '@playwright/test'

// Las Fusil / Standard / Increased Capacity: in the bundled bake and not
// touched by src/data/perk-corrections.json.
const WEAPON = 'Las Fusil'
const PERK = 'Increased Capacity'

async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name').first()).toBeVisible()
}

// Full navigation to the Armoury (Primary is the default category), then
// inspect the perk. Resolves with the caller's /privileges/me body so absence
// checks run only once the nav and edit panel know what the caller may do.
async function openLasFusil(page) {
  const privileges = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith('/privileges/me'))
  await page.goto('/armoury')
  await page.locator('button.w-item', { hasText: WEAPON }).first().click()
  // First match is the Standard tier (tiers render in quality order).
  await page.locator('.wnode', { hasText: PERK }).first().hover()
  await expect(page.locator('.wdetail-name')).toHaveText(PERK)
  return (await privileges).json()
}

test('a Techmarine corrects a perk, members see it, the Forge revokes the Techmarine', async ({ browser }) => {
  const text = `E2E corrected text ${Date.now()}`

  const tm = await (await browser.newContext()).newPage()
  await signIn(tm, 'test-techmarine-token')
  await openLasFusil(tm)
  await tm.getByRole('button', { name: 'Edit text', exact: true }).click()
  await tm.getByLabel('Perk text').fill(text)
  await tm.getByLabel('Note').fill('e2e check')
  await tm.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(tm.locator('.wdetail-desc')).toHaveText(text)
  await expect(tm.locator('.corrected-tag')).toContainText('Corrected in game')
  await expect(tm.getByRole('link', { name: 'Version History' }).first()).toBeVisible()

  const member = await (await browser.newContext()).newPage()
  await signIn(member, 'test-member-token')
  const memberPrivileges = await openLasFusil(member)
  expect(memberPrivileges.editor).toBe(false)
  await expect(member.locator('.wdetail-desc')).toHaveText(text)
  await expect(member.locator('.corrected-tag')).toContainText('Corrected in game')
  await expect(member.getByRole('button', { name: 'Edit text' })).toHaveCount(0)
  await expect(member.getByRole('link', { name: 'Version History' })).toHaveCount(0)

  const forge = await (await browser.newContext()).newPage()
  await signIn(forge, 'test-forge-token')
  await forge.goto('/history')
  const entry = forge.locator('.hist-item', { hasText: `techmarine-tester edited ${PERK} — ${WEAPON} / Standard` }).first()
  await entry.locator('.hist-line').click()
  await entry.getByRole('button', { name: 'Revoke techmarine-tester' }).click()
  await entry.getByLabel('Reason (required)').fill('e2e revoke')
  await entry.getByRole('button', { name: 'Confirm revoke' }).click()
  await expect(forge.locator('.hist-revoked')).toContainText('techmarine-tester')

  const tmPrivileges = await openLasFusil(tm)
  expect(tmPrivileges).toMatchObject({ editor: false, revoked: true })
  await expect(tm.locator('.wdetail-desc')).toHaveText(text)
  await expect(tm.getByRole('button', { name: 'Edit text' })).toHaveCount(0)
  await expect(tm.getByRole('link', { name: 'Version History' })).toHaveCount(0)

  await forge.locator('.hist-revoked').getByRole('button', { name: 'Reinstate' }).click()
  await expect(forge.locator('.hist-revoked')).toHaveCount(0)
})
