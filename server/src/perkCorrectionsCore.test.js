import { describe, it, expect } from 'vitest'
import { applyWeaponCorrections, applyClassCorrections, hasWeaponPerk, toDocument, flattenDocument } from './perkCorrectionsCore'

const tree = {
  budget: 7,
  perks: [
    { name: 'A', quality: 'Standard', description: 'a' },
    { name: 'B', quality: 'Standard', description: 'b' },
    { name: 'C', quality: 'Relic', description: 'c' },
  ],
}
const e = (id, op, quality, perkName, description = null) => ({ id, op, quality, perkName, description, createdAt: `t${id}` })

describe('applyWeaponCorrections', () => {
  it('keys every bake perk by its bake index, even with no corrections', () => {
    expect(applyWeaponCorrections(tree, []).perks.map((p) => p.key)).toEqual([0, 1, 2])
  })

  it('removing a perk leaves the others on their bake keys', () => {
    const out = applyWeaponCorrections(tree, [e(1, 'remove', 'Standard', 'A')])
    expect(out.perks.map((p) => [p.name, p.key])).toEqual([['B', 1], ['C', 2]])
  })

  it('adds, edits and marks what it touched', () => {
    const out = applyWeaponCorrections(tree, [e(1, 'add', 'Relic', 'D', 'd'), e(2, 'edit', 'Standard', 'B', 'b2')])
    expect(out.perks.find((p) => p.name === 'D')).toMatchObject({ quality: 'Relic', description: 'd', key: 'c1', corrected: { id: 1, createdAt: 't1' } })
    expect(out.perks.find((p) => p.name === 'B')).toMatchObject({ description: 'b2', key: 1, corrected: { id: 2 } })
    expect(out.perks.find((p) => p.name === 'A').corrected).toBeUndefined()
    expect(out.budget).toBe(7)
  })

  it('only touches the named quality and one perk per correction', () => {
    const dup = { perks: [...tree.perks, { name: 'C', quality: 'Relic', description: 'c2' }, { name: 'C', quality: 'Standard', description: 'cs' }] }
    const out = applyWeaponCorrections(dup, [e(1, 'remove', 'Relic', 'C')])
    expect(out.perks.filter((p) => p.name === 'C').map((p) => [p.quality, p.description])).toEqual([['Relic', 'c2'], ['Standard', 'cs']])
  })

  it('skips an edit or remove whose perk is gone (e.g. its add was reverted)', () => {
    const out = applyWeaponCorrections(tree, [e(1, 'edit', 'Relic', 'Ghost', 'x'), e(2, 'remove', 'Relic', 'Ghost')])
    expect(out.perks.map((p) => p.name)).toEqual(['A', 'B', 'C'])
  })

  it('never mutates its input', () => {
    const before = JSON.stringify(tree)
    applyWeaponCorrections(tree, [e(1, 'remove', 'Standard', 'A'), e(2, 'edit', 'Standard', 'B', 'z')])
    expect(JSON.stringify(tree)).toBe(before)
  })

  it('hasWeaponPerk sees corrections once applied', () => {
    const out = applyWeaponCorrections(tree, [e(1, 'add', 'Relic', 'D', 'd')])
    expect(hasWeaponPerk(out, 'Relic', 'D')).toBe(true)
    expect(hasWeaponPerk(out, 'Standard', 'D')).toBe(false)
  })
})

describe('applyClassCorrections', () => {
  const perks = { Stim: { level: 2, description: 'old' }, Other: { level: 3, description: 'o' } }
  it('edits text by name and ignores unknown perks and non-edits', () => {
    const out = applyClassCorrections(perks, [e(1, 'edit', null, 'Stim', 'new'), e(2, 'edit', null, 'Nope', 'x'), e(3, 'remove', null, 'Other')])
    expect(out.Stim).toEqual({ level: 2, description: 'new', corrected: { id: 1, createdAt: 't1' } })
    expect(out.Other).toEqual({ level: 3, description: 'o' })
    expect(out.Nope).toBeUndefined()
    expect(perks.Stim.description).toBe('old')
  })
})

describe('toDocument / flattenDocument', () => {
  const rows = [
    { id: 1, kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'remove', perkName: 'X', description: null, note: 'n', active: true, author: { id: '9', username: 'u' }, createdAt: 't1' },
    { id: 2, kind: 'class', target: 'Tactical', quality: null, op: 'edit', perkName: 'Y', description: 'y', note: null, active: true, author: { id: '9', username: 'u' }, createdAt: 't2' },
  ]
  it('groups by kind and target in input order, with no author or note', () => {
    const doc = toDocument(rows, 'v1')
    expect(doc).toEqual({
      version: 'v1',
      weapons: { 'Las Fusil': [{ id: 1, op: 'remove', quality: 'Relic', perkName: 'X', description: null, createdAt: 't1' }] },
      classes: { Tactical: [{ id: 2, op: 'edit', quality: null, perkName: 'Y', description: 'y', createdAt: 't2' }] },
    })
  })
  it('flattens back to seedable corrections', () => {
    expect(flattenDocument(toDocument(rows, 'v1'))).toEqual([
      { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'remove', perkName: 'X', description: null },
      { kind: 'class', target: 'Tactical', quality: null, op: 'edit', perkName: 'Y', description: 'y' },
    ])
  })

  it('groups a prototype-key target correctly instead of throwing', () => {
    const poisoned = [
      { id: 3, kind: 'weapon', target: 'constructor', quality: 'Relic', op: 'add', perkName: 'Z', description: 'z', note: null, active: true, author: { id: '9', username: 'u' }, createdAt: 't3' },
    ]
    let doc
    expect(() => {
      doc = toDocument(poisoned, 'v1')
    }).not.toThrow()
    expect(doc.weapons.constructor).toEqual([{ id: 3, op: 'add', quality: 'Relic', perkName: 'Z', description: 'z', createdAt: 't3' }])
  })
})
