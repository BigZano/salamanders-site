import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { perkStateKey } from './perkStateKey'
import weaponList from '../data/weapons.json'
import classes from '../data/classes.json'

const LISTS = weaponList.fallbackWeapons
const SLOTS = Object.keys(LISTS)
const CAPITALISED = { primary: 'Primary', secondary: 'Secondary', melee: 'Melee' }
const EVERY_WEAPON = Object.values(LISTS).flat()

describe('perkStateKey', () => {
  it('is the plain weapon name for a weapon in its own slot', () => {
    for (const slot of SLOTS) {
      for (const w of LISTS[slot]) expect(perkStateKey(slot, w), `${slot}: ${w}`).toBe(w)
    }
  })

  it('qualifies a weapon that sits in a slot it does not belong to', () => {
    expect(perkStateKey('secondary', 'Bolt Rifle')).toBe('Bolt Rifle (Secondary)')
    expect(perkStateKey('primary', 'Chainsword')).toBe('Chainsword (Primary)')
    expect(perkStateKey('melee', 'Bolt Pistol')).toBe('Bolt Pistol (Melee)')
  })

  it('qualifies every weapon in every slot that is not its own, with that slot capitalised', () => {
    for (const slot of SLOTS) {
      for (const other of SLOTS.filter((s) => s !== slot)) {
        for (const w of LISTS[other]) {
          expect(perkStateKey(slot, w), `${slot}: ${w}`).toBe(`${w} (${CAPITALISED[slot]})`)
        }
      }
    }
  })

  it('gives a Bolt Rifle in the Primary and one in the Secondary different keys', () => {
    expect(perkStateKey('primary', 'Bolt Rifle')).toBe('Bolt Rifle')
    expect(perkStateKey('secondary', 'Bolt Rifle')).toBe('Bolt Rifle (Secondary)')
  })

  it('is empty for a blank or non-string weapon', () => {
    for (const bad of ['', null, undefined, 0, 5, true, {}, [], ['Bolt Rifle']]) {
      expect(perkStateKey('secondary', bad), String(bad)).toBe('')
    }
  })

  it('leaves the weapon alone when the slot is unknown, wrong-cased, empty or not a string', () => {
    const slots = ['tertiary', 'Secondary', 'SECONDARY', '', ' secondary', undefined, null, 7, {}, ['secondary']]
    for (const slot of slots) expect(perkStateKey(slot, 'Bolt Rifle'), String(slot)).toBe('Bolt Rifle')
  })

  it('does not treat object prototype names as slots', () => {
    for (const slot of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(perkStateKey(slot, 'Bolt Rifle'), slot).toBe('Bolt Rifle')
    }
  })

  it('leaves a weapon no slot lists alone, however it is spelled', () => {
    for (const w of ['Unreleased Cannon', 'bolt rifle', 'Bolt Rifle ', '__proto__', 'constructor', 'toString']) {
      for (const slot of SLOTS) expect(perkStateKey(slot, w), `${slot}: ${w}`).toBe(w)
    }
  })

  it('never changes a weapon no slot lists, for any text', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SLOTS), fc.string(), (slot, w) => {
        fc.pre(!EVERY_WEAPON.includes(w))
        expect(perkStateKey(slot, w)).toBe(w)
      }),
    )
  })

  it('never throws, for any slot and weapon of any type', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (slot, w) => {
        expect(() => perkStateKey(slot, w)).not.toThrow()
      }),
    )
  })

  it('gives the weapons of any one loadout distinct keys, for every class', () => {
    for (const [cls, c] of Object.entries(classes)) {
      for (const p of ['', ...c.weapons.primary]) {
        for (const s of ['', ...c.weapons.secondary]) {
          for (const m of ['', ...c.weapons.melee]) {
            const keys = [perkStateKey('primary', p), perkStateKey('secondary', s), perkStateKey('melee', m)].filter(Boolean)
            expect(new Set(keys).size, `${cls}: ${p} / ${s} / ${m}`).toBe(keys.length)
          }
        }
      }
    }
  })
})
