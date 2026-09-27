import baked from '../data/weapon-trees.json'
import overrides from '../data/weapon-perk-overrides.json'
import { fetchWeapon } from './wiki'
import { fallbackWeaponData } from '../data/weapon-fallbacks'

/**
 * Resolve a weapon's perk tree, best source first:
 *
 *   1. baked   — scripts/fetch-wiki-weapons.mjs output, shipped with the build.
 *                Instant and works offline. Refreshed each deploy and by the
 *                weekly data-check workflow.
 *   2. wiki    — live Fandom fetch, for weapons added since the last bake.
 *   3. offline — the two hand-verified trees carried over from the original planner.
 *
 * Every result carries `source` so the UI can say where the numbers came from.
 */
export const BAKED_AT = baked.fetched

/**
 * Layer in-game corrections over a wiki tree. The wiki lags the game, so
 * weapon-perk-overrides.json lists, per quality, perks to drop (one per name
 * listed) and perks to add. Returns a new tree; the input is not touched.
 */
export function applyPerkOverrides(name, tree, table = overrides.weapons) {
  const fix = table[name]
  if (!fix) return tree
  const perks = [...tree.perks]
  for (const [quality, { remove = [], add = [] }] of Object.entries(fix)) {
    for (const drop of remove) {
      const i = perks.findIndex((p) => p.quality === quality && p.name === drop)
      if (i >= 0) perks.splice(i, 1)
    }
    for (const p of add) perks.push({ name: p.name, quality, description: p.description })
  }
  return { ...tree, perks }
}

export async function resolveWeapon(name) {
  const hit = baked.weapons[name]
  if (hit) return { ...applyPerkOverrides(name, hit), source: 'baked' }

  try {
    const live = await fetchWeapon(name)
    return { ...applyPerkOverrides(name, live), source: 'wiki' }
  } catch {
    const fb = fallbackWeaponData(name)
    return fb ? { ...fb, source: 'offline' } : null
  }
}

export const SOURCE_LABEL = {
  baked: 'Synced data',
  wiki: 'Live · wiki',
  offline: 'Offline data',
}

/** The baseline version of a weapon — the plain Standard one where it exists. */
export function baseVersion(weapon) {
  const vs = weapon?.versions || []
  return vs.find((v) => v.quality === 'Standard') || vs[0] || null
}

/**
 * Mean gauge values across every baked weapon in a slot, using each weapon's
 * baseline version. A bar on its own says nothing; against the slot average it
 * tells you whether this weapon is actually fast, or just feels fast.
 */
export function slotAverages(slotWeapons) {
  const totals = {}
  for (const name of slotWeapons) {
    const v = baseVersion(baked.weapons[name])
    if (!v) continue
    for (const [gauge, { value }] of Object.entries(v.gauges || {})) {
      if (typeof value !== 'number') continue
      totals[gauge] ??= { sum: 0, n: 0 }
      totals[gauge].sum += value
      totals[gauge].n++
    }
  }
  return Object.fromEntries(
    Object.entries(totals).map(([g, { sum, n }]) => [g, sum / n]),
  )
}

/** Gauges are drawn on a 0-10 scale, matching the in-game bars. */
export const GAUGE_MAX = 10
