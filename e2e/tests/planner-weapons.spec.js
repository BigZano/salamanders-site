import { test, expect } from '@playwright/test'

// Tactical is the Planner's default class, and the only one that may take the
// Bolt Rifle as a Secondary (Tactical Reserve).
const slot = (page, label) => page.locator('.slot', { has: page.getByLabel(label) })

async function pick(page, label, count) {
  const s = slot(page, label)
  await s.locator('.slot-toggle').click()
  const nodes = s.locator('.wnode')
  for (let i = 0; i < count; i++) await nodes.nth(i).click()
}

test('Tactical can field the Bolt Rifle as Primary and Secondary, each with its own perks', async ({ page }) => {
  await page.goto('/planner')

  await page.getByLabel('Primary Weapon').selectOption('Bolt Rifle')
  await page.getByLabel('Secondary Weapon').selectOption('Bolt Rifle')

  await pick(page, 'Primary Weapon', 2)
  await pick(page, 'Secondary Weapon', 1)

  await expect(slot(page, 'Primary Weapon').locator('.slot-pts')).toHaveText('2 perks')
  await expect(slot(page, 'Secondary Weapon').locator('.slot-pts')).toHaveText('1 perk')

  await page.reload()
  await expect(page.getByLabel('Secondary Weapon')).toHaveValue('Bolt Rifle')
  await expect(slot(page, 'Primary Weapon').locator('.slot-pts')).toHaveText('2 perks')
  await expect(slot(page, 'Secondary Weapon').locator('.slot-pts')).toHaveText('1 perk')
})

test('the Secondary list for Tactical offers the Bolt Rifle but not the other primaries', async ({ page }) => {
  await page.goto('/planner')
  const secondary = page.getByLabel('Secondary Weapon')
  // The Bolt Rifle count retries until the page has rendered, so the absences below are real.
  await expect(secondary.locator('option[value="Bolt Rifle"]')).toHaveCount(1)
  await expect(secondary.locator('option[value="Heavy Bolt Rifle"]')).toHaveCount(0)
  await expect(secondary.locator('option[value="Auto Bolt Rifle"]')).toHaveCount(0)
})
