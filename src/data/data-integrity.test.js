/**
 * Whole-dataset invariants for the baked game data. These read the JSON files
 * directly, so a bad re-bake (a duplicated perk, a weapon missing from the
 * bake, a held value that moved) fails here rather than in the Armoury.
 */
import { describe, it, expect } from 'vitest'
import weaponList from './weapons.json'
import classes from './classes.json'
import trees from './weapon-trees.json'
import details from './perk-details.json'
import overrides from './patch-overrides.json'

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

  // Tactical Reserve swaps the Secondary for a Primary Bolt Rifle. Anything else
  // in the wrong slot is a data error, so this list is exact, not a floor.
  const OFF_SLOT = ['Tactical secondary: Bolt Rifle']
  const offSlot = () => {
    const found = []
    for (const [cls, c] of Object.entries(classes)) {
      for (const [slot, names] of Object.entries(c.weapons)) {
        for (const n of names) if (!weaponList.fallbackWeapons[slot].includes(n)) found.push(`${cls} ${slot}: ${n}`)
      }
    }
    return found
  }

  it('only gives a class weapons that exist for that slot, bar the Bolt Rifle Tactical Reserve allows', () => {
    expect(offSlot()).toEqual(OFF_SLOT)
  })

  it('only places a weapon in the wrong slot when another slot lists it', () => {
    const everyWeapon = Object.values(weaponList.fallbackWeapons).flat()
    for (const entry of offSlot()) expect(everyWeapon, entry).toContain(entry.split(': ')[1])
  })

  it('lists no weapon in more than one slot', () => {
    const seen = new Map()
    const twice = []
    for (const [slot, names] of Object.entries(weaponList.fallbackWeapons)) {
      for (const n of names) {
        if (seen.has(n)) twice.push(`${n}: ${seen.get(n)} and ${slot}`)
        seen.set(n, slot)
      }
    }
    expect(twice).toEqual([])
  })

  it('lets Tactical take the Bolt Rifle as a Secondary as well as a Primary, and no other primary', () => {
    expect(classes.Tactical.weapons.primary).toContain('Bolt Rifle')
    expect(classes.Tactical.weapons.secondary).toContain('Bolt Rifle')
    const otherPrimaries = classes.Tactical.weapons.primary.filter((n) => n !== 'Bolt Rifle')
    for (const n of otherPrimaries) expect(classes.Tactical.weapons.secondary, n).not.toContain(n)
  })

  it('lists each version of a weapon once', () => {
    for (const [name, t] of Object.entries(baked)) {
      const names = t.versions.map((v) => v.name)
      expect(names.filter((n, i) => names.indexOf(n) !== i), name).toEqual([])
    }
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

  it("bakes the One-Handed Thunder Hammer with ten versions and the perk tree from Bret's in-game list", () => {
    const t = baked['One-Handed Thunder Hammer']
    expect('perksPending' in t).toBe(false)
    expect(t.versions).toHaveLength(10)
    const count = (q) => t.perks.filter((p) => p.quality === q).length
    expect(['Standard', 'Master-Crafted', 'Artificer', 'Relic'].map(count)).toEqual([2, 6, 8, 4])
    expect(t.perks).toHaveLength(20)
    for (const p of t.perks) expect(p.description, p.name).toBeTruthy()
    const at = (q, n) => t.perks.find((p) => p.quality === q && p.name === n)?.description
    expect(at('Master-Crafted', 'Charge Overflow')).toBe('Reaching the Maximum Power Charge stack increases Damage by 10% for 20 seconds')
    expect(at('Relic', 'Capacity Increase')).toBe('Maximum number of Power Charges increases to 4')
  })

  it('lists each One-Handed Thunder Hammer perk once per quality', () => {
    const keys = baked['One-Handed Thunder Hammer'].perks.map((p) => `${p.quality}|${p.name}`)
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })

  it('takes the wiki weapon perk text, which matches the game data (Fast Reload)', () => {
    const fast = baked['Auto Bolt Rifle'].perks.find((p) => p.name === 'Fast Reload' && p.quality === 'Master-Crafted')
    expect(fast.description).toBe('This Weapon reloads 10% faster')
  })

  it('has the Hotfix 15.1 Melta Rifle ammo (magazine 6, ammo pool 12 on the default versions)', () => {
    const std = version('Melta Rifle', 'Standard-Issue')
    expect(std.figures['Magazine Capacity']).toBe('6')
    expect(std.figures['Ammo Reserve']).toContain('12')
    expect(version('Melta Rifle', 'Master-Crafted - Alpha').figures).toMatchObject({ 'Magazine Capacity': '6', 'Ammo Reserve': '12' })
  })

  it('lists the twelve Bolt Carbine versions the game has, with no leftover PvP row', () => {
    const names = baked['Bolt Carbine'].versions.map((v) => v.name)
    expect(names).toHaveLength(12)
    expect(names).not.toContain('Marksman Bolt Carbine (PVP)')
    expect(names.filter((n) => n === 'Master-Crafted Marksman')).toHaveLength(1)
  })

  it('updates the class melee lists for Patch 15.0', () => {
    expect(classes.Tactical.weapons.melee).toEqual(expect.arrayContaining(['Power Sword', 'Power Axe', 'One-Handed Thunder Hammer']))
    expect(classes.Assault.weapons.melee).toContain('One-Handed Thunder Hammer')
    expect(classes.Bulwark.weapons.melee).toContain('One-Handed Thunder Hammer')
    expect(classes.Techmarine.weapons.melee).toEqual(expect.arrayContaining(['Thunder Hammer', 'One-Handed Thunder Hammer']))
    for (const c of ['Vanguard', 'Sniper', 'Heavy']) expect(classes[c].weapons.melee).not.toContain('One-Handed Thunder Hammer')
  })
})

describe('class perks', () => {
  const tactical = classes.Tactical
  const tacticalPerks = details.classes.Tactical.perks
  const tacticalOverrides = overrides.classes.Tactical
  const at = (level) => tactical.rows[Math.floor((level - 2) / 8)][(level - 2) % 8]

  it('never repeats a perk within a class grid', () => {
    for (const [cls, c] of Object.entries(classes)) {
      const names = c.rows.flat()
      expect(names.filter((n, i) => names.indexOf(n) !== i), cls).toEqual([])
    }
  })

  it('describes every perk in every class grid', () => {
    for (const [cls, c] of Object.entries(classes)) {
      for (const n of c.rows.flat()) expect(details.classes[cls].perks[n]?.description, `${cls} / ${n}`).toBeTruthy()
    }
  })

  it('lays the Tactical grid out as Patch 15.0 changed it', () => {
    expect([6, 8, 9, 12, 14, 15, 16, 18, 22, 23, 24, 25].map(at)).toEqual([
      'Improved Efficiency',
      'Vital Data',
      'Tactical Reserve',
      'Focused Strike',
      'Pulse Auspex',
      "Marksman's Mandate",
      'Strongpoint',
      'Armour Reinforcement',
      'Mobile Auspex',
      "Bladesman's Mandate",
      'Prime Target',
      'Marked for Death',
    ])
  })

  it('replaces the Tactical prestige perk and starting text from the overrides', () => {
    const names = details.classes.Tactical.prestige.map((p) => p.name)
    expect(names).toContain('Passive Chambering')
    expect(names).not.toContain('Exigency Charge')
    const pc = details.classes.Tactical.prestige.find((p) => p.name === 'Passive Chambering')
    expect(pc.description).toBe(tacticalOverrides.prestige[0].description)
    expect(tactical.starting).toBe(tacticalOverrides.starting.text)
  })

  it('takes the wiki text for the four perks that were pinned before the game-data cross-check', () => {
    // Pins held the old wording against wiki edits the patch notes did not mention; the
    // game data agreed with the wiki on all four, so the pins were removed.
    expect(tacticalOverrides.pins ?? []).toEqual([])
    expect(tacticalPerks['Balanced Distribution'].description).toContain('15% more Damage')
    expect(tacticalPerks['Heightened Vigour'].description).toContain('Parry, Block, or Dodge')
    expect(tacticalPerks['Plasma Boost'].description).toContain('Plasma Weapons')
    expect(tacticalPerks['Relentless Pursuit'].description).toContain('10 seconds')
  })

  it('accepts the wiki edits that follow from Tactical Reserve and the rest of the corroborated wording', () => {
    expect(tacticalPerks["Emperor's Judgement"].description).toContain('Ranged Weapons')
    expect(tacticalPerks.Versatility.description).toContain('Primary Weapon is equipped in the Secondary Weapon slot')
    expect(tacticalPerks['Secure Stockpile'].description).toContain('90 seconds')
  })

  it('names a source on every override entry, in every class', () => {
    const entries = Object.values(overrides.classes).flatMap((o) => [
      ...(o.grid ?? []),
      ...(o.prestige ?? []),
      ...(o.pins ?? []),
      ...(o.starting ? [o.starting] : []),
    ])
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(Array.isArray(e.sources) && e.sources.length > 0 && e.sources.every(Boolean), JSON.stringify(e).slice(0, 60)).toBe(true)
    }
  })

  it('moves Assault level 14 to Furious Strikes, as the wiki and the game data have it', () => {
    expect(classes.Assault.rows[1][4]).toBe('Furious Strikes')
    expect(details.classes.Assault.perks['Furious Strikes'].description).toContain('Jump Pack Dash')
    expect(Object.keys(details.classes.Assault.perks)).not.toContain('Strong Strikes')
  })

  it('keeps the Heavy prestige perk Honed Precision by override: the wiki swapped it for Restorative Capacity, the game data has not', () => {
    const names = details.classes.Heavy.prestige.map((p) => p.name)
    const why = 'src/data/patch-overrides.json Heavy.prestige: delete the override and update this test once the wiki and the game agree'
    expect(names, why).toContain('Honed Precision')
    expect(names, why).not.toContain('Restorative Capacity')
    expect(overrides.classes.Heavy.prestige[0].sources.length).toBeGreaterThan(0)
  })
})
