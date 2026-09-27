import { describe, it, expect } from 'vitest'
import baked from '../data/weapon-trees.json'
import overrides from '../data/weapon-perk-overrides.json'
import { applyPerkOverrides, resolveWeapon } from './weapons'

const tier = (w, q) => w.perks.filter((p) => p.quality === q).map((p) => p.name)

describe('applyPerkOverrides', () => {
  const tree = {
    perks: [
      { name: 'A', quality: 'Standard', description: 'a' },
      { name: 'B', quality: 'Standard', description: 'b' },
      { name: 'B', quality: 'Relic', description: 'b' },
      { name: 'B', quality: 'Relic', description: 'b2' },
    ],
    budget: 5,
  }

  it('removes named perks only from the given quality, one per listing', () => {
    const out = applyPerkOverrides('X', tree, {
      X: { Relic: { remove: ['B'], add: [{ name: 'C', description: 'c' }] } },
    })
    expect(tier(out, 'Standard')).toEqual(['A', 'B'])
    expect(out.perks.filter((p) => p.quality === 'Relic')).toEqual([
      { name: 'B', quality: 'Relic', description: 'b2' },
      { name: 'C', quality: 'Relic', description: 'c' },
    ])
    expect(out.budget).toBe(5)
  })

  it('leaves the input untouched and passes weapons without overrides through', () => {
    const before = JSON.stringify(tree)
    applyPerkOverrides('X', tree, { X: { Standard: { remove: ['A'] } } })
    expect(JSON.stringify(tree)).toBe(before)
    expect(applyPerkOverrides('Y', tree, {})).toBe(tree)
  })
})

describe('shipped overrides', () => {
  // A removal that no longer matches means the wiki changed under us: the entry
  // is probably fixed upstream and should be dropped from the overrides file.
  it('every removal still names a perk in the baked tree', () => {
    for (const [weapon, tiers] of Object.entries(overrides.weapons)) {
      expect(baked.weapons[weapon], weapon).toBeTruthy()
      for (const [quality, { remove = [] }] of Object.entries(tiers)) {
        const pool = tier(baked.weapons[weapon], quality)
        for (const name of remove) {
          const i = pool.indexOf(name)
          expect(i, `${weapon} / ${quality} / ${name}`).toBeGreaterThanOrEqual(0)
          pool.splice(i, 1)
        }
      }
    }
  })

  it('resolveWeapon serves the corrected Occulus Bolt Carbine', async () => {
    const w = await resolveWeapon('Occulus Bolt Carbine')
    expect(tier(w, 'Standard')).toEqual(['Great Might', 'Remote Threat'])
    expect(tier(w, 'Relic')).not.toContain('Tyranid Eliminator')
    expect(tier(w, 'Relic')).toContain('Able Damage')
    expect(w.source).toBe('baked')
  })
})
