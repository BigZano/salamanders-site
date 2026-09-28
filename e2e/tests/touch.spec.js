import { test, expect } from '@playwright/test'

// iOS Safari has no hover for a held finger, so the perk popout (with the
// creator's reason) opens on press-and-hold. This replays Safari's event
// order for a hold: touch pointerdown, a pause, pointerup, then the click.
test('holding a picked perk on a touch screen shows its reason without unpicking it', async ({ page }) => {
  await page.goto('/planner')
  const perk = page.locator('.perk').first()
  await perk.click()
  await page.getByLabel('Why this pick?').fill('Keeps the squad alive')
  await page.getByLabel('Why this pick?').blur()
  await page.mouse.move(0, 0)
  await expect(page.locator('.perk-popout')).toHaveCount(0)

  await perk.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true })
  await page.waitForTimeout(600)
  await perk.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true })
  await perk.dispatchEvent('click')

  const popout = page.locator('.perk-popout')
  await expect(popout).toContainText('Why the creator picked it')
  await expect(popout).toContainText('Keeps the squad alive')
  await expect(perk).toHaveClass(/selected/)

  // The next touch anywhere closes it; a plain tap still toggles the pick.
  await page.locator('body').dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true })
  await expect(popout).toHaveCount(0)
  await perk.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true })
  await perk.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true })
  await perk.dispatchEvent('click')
  await expect(perk).not.toHaveClass(/selected/)
})
