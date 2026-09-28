import { describe, it, expect } from 'vitest'
import { resolveWeapon, perkSuggestions } from './weapons'

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
