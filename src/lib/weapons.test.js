import { describe, it, expect } from 'vitest'
import { resolveWeapon, perkSuggestions, weaponLabel, versionLabel, DISPLAY_NAME } from './weapons'

describe('weapons', () => {
  it('resolveWeapon returns the raw bake; corrections are applied by the store', async () => {
    const w = await resolveWeapon('Occulus Bolt Carbine')
    expect(w.source).toBe('baked')
    expect(w.perks.some((p) => p.name === 'Tyranid Eliminator')).toBe(true)
  })

  it('perkSuggestions lists each perk name once, sorted', () => {
    const s = perkSuggestions()
    const names = s.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
    expect(s.find((p) => p.name === 'Divine Might').description).toBe('Damage increases by 10%')
  })
})

describe('weapon labels', () => {
  it('shows the two-handed Thunder Hammer under its in-game name, and leaves other names alone', () => {
    expect(weaponLabel('Thunder Hammer')).toBe('Two-Handed Thunder Hammer')
    expect(weaponLabel('Power Axe')).toBe('Power Axe')
    expect(weaponLabel('One-Handed Thunder Hammer')).toBe('One-Handed Thunder Hammer')
    expect(DISPLAY_NAME['Thunder Hammer']).toBe('Two-Handed Thunder Hammer')
  })

  it('does not treat object prototype names as aliases', () => {
    expect(weaponLabel('constructor')).toBe('constructor')
    expect(weaponLabel('toString')).toBe('toString')
  })

  it('labels a version with its quality and defence type', () => {
    expect(versionLabel({ name: 'Master-Crafted - Beta', quality: 'Master-Crafted', defence: 'Fencing' })).toBe(
      'Master-Crafted - Beta — Master-Crafted · Fencing',
    )
  })

  it('leaves out the middle dot when there is no defence', () => {
    expect(versionLabel({ name: 'Standard-Issue', quality: 'Standard' })).toBe('Standard-Issue — Standard')
  })

  it('leaves out the dash when there is no quality', () => {
    expect(versionLabel({ name: 'Power Maul', defence: 'Balanced' })).toBe('Power Maul · Balanced')
    expect(versionLabel({ name: 'Power Maul' })).toBe('Power Maul')
  })
})
