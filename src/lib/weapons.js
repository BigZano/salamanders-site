import baked from '../data/weapon-trees.json'
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

export async function resolveWeapon(name) {
  const hit = baked.weapons[name]
  if (hit) return { ...hit, source: 'baked' }

  try {
    const live = await fetchWeapon(name)
    return { ...live, source: 'wiki' }
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
