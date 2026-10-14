/**
 * Whole-dataset invariants for the baked game data. These read the JSON files
 * directly, so a bad re-bake (a duplicated perk, a weapon missing from the
 * bake, a held value that moved) fails here rather than in the Armoury.
 */
import { describe, it, expect } from 'vitest'
import weaponList from './weapons.json'
import classes from './classes.json'
import trees from './weapon-trees.json'

const baked = trees.weapons
const MELEE = ['Chainsword', 'Combat Knife', 'Power Fist', 'Power Sword', 'Thunder Hammer', 'Power Axe', 'Omnissiah Axe', 'One-Handed Thunder Hammer']
const DEFENCES = ['Block', 'Balanced', 'Fencing']
const version = (weapon, name) => baked[weapon].versions.find((v) => v.name === name)

describe('weapons', () => {
  it('bakes every listed weapon except Heavy Firearms Melee', () => {
    const missing = Object.values(weaponList.fallbackWeapons)
      .flat()
      .filter((n) => n !== 'Heavy Firearms Melee' && !baked[n])
    expect(missing).toEqual([])
  })

  it('only gives a class weapons that exist for that slot', () => {
    const bad = []
    for (const [cls, c] of Object.entries(classes)) {
      for (const [slot, names] of Object.entries(c.weapons)) {
        for (const n of names) if (!weaponList.fallbackWeapons[slot].includes(n)) bad.push(`${cls} ${slot}: ${n}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('records the defence type per melee version', () => {
    expect(version('Thunder Hammer', 'Standard-Issue').defence).toBe('Balanced')
    expect(version('Thunder Hammer', 'Master-Crafted - Beta').defence).toBe('Fencing')
    expect(version('Thunder Hammer', 'Master-Crafted - Gamma').defence).toBe('Block')
    expect(version('Power Axe', 'Frost Axe').defence).toBe('Balanced')
    expect(version('One-Handed Thunder Hammer', 'Power Maul').defence).toBe('Balanced')
  })

  it('gives every melee version a defence and no primary or secondary version one', () => {
    for (const w of MELEE) {
      for (const v of baked[w].versions) expect(DEFENCES, `${w} / ${v.name}`).toContain(v.defence)
    }
    const ranged = [...weaponList.fallbackWeapons.primary, ...weaponList.fallbackWeapons.secondary]
    for (const w of ranged) {
      for (const v of baked[w].versions) expect('defence' in v, `${w} / ${v.name}`).toBe(false)
    }
  })

  it('bakes the One-Handed Thunder Hammer with ten versions and no perk tree yet', () => {
    const t = baked['One-Handed Thunder Hammer']
    expect(t.perksPending).toBe(true)
    expect(t.perks).toEqual([])
    expect(t.versions).toHaveLength(10)
  })

  it('holds weapon perk text at the previous bake (Fast Reload)', () => {
    const fast = baked['Auto Bolt Rifle'].perks.find((p) => p.name === 'Fast Reload' && p.quality === 'Master-Crafted')
    expect(fast.description).toBe('Reload all Weapons 10% faster')
  })

  it('updates the class melee lists for Patch 15.0', () => {
    expect(classes.Tactical.weapons.melee).toEqual(expect.arrayContaining(['Power Sword', 'Power Axe', 'One-Handed Thunder Hammer']))
    expect(classes.Assault.weapons.melee).toContain('One-Handed Thunder Hammer')
    expect(classes.Bulwark.weapons.melee).toContain('One-Handed Thunder Hammer')
    expect(classes.Techmarine.weapons.melee).toEqual(expect.arrayContaining(['Thunder Hammer', 'One-Handed Thunder Hammer']))
    for (const c of ['Vanguard', 'Sniper', 'Heavy']) expect(classes[c].weapons.melee).not.toContain('One-Handed Thunder Hammer')
  })
})
