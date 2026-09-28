import { describe, it, expect } from 'vitest'
import { applyWeaponCorrections, applyClassCorrections, hasWeaponPerk, toDocument, flattenDocument, withBefore, sanitizeText, PERK_NAME } from './perkCorrectionsCore'

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

describe('sanitizeText', () => {
  it('turns non-strings into an empty string', () => {
    expect(sanitizeText(null)).toBe('')
    expect(sanitizeText(undefined)).toBe('')
    expect(sanitizeText(42)).toBe('')
    expect(sanitizeText({})).toBe('')
  })

  it('normalizes to NFC so composed and decomposed forms match', () => {
    const decomposed = 'e\u0301clair' // e + combining acute accent
    const composed = '\u00e9clair' // e-acute, precomposed
    expect(sanitizeText(decomposed)).toBe(sanitizeText(composed))
    expect(sanitizeText(decomposed)).toBe('éclair')
  })

  it('re-normalizes to NFC after stripping invisible characters (stripping can newly make a base+combining-mark sequence adjacent)', () => {
    const probe = 'e\u200B\u0301clair' // e, ZWSP, combining acute accent, clair
    expect(sanitizeText(probe)).toBe('éclair')
    expect(PERK_NAME.test(sanitizeText(probe))).toBe(true)
  })

  it('strips C0 and C1 control characters', () => {
    expect(sanitizeText('a\u0000\u0007\u001Fb')).toBe('ab')
    expect(sanitizeText('a\u007F\u0090\u009Fb')).toBe('ab')
  })

  it('strips zero-width, soft hyphen and bidi override/isolate characters', () => {
    expect(sanitizeText('a\u200B\u200C\u200D\u2060\uFEFFb')).toBe('ab')
    expect(sanitizeText('soft\u00ADhyphen')).toBe('softhyphen')
    expect(sanitizeText('a\u202A\u202B\u202C\u202D\u202Eb')).toBe('ab')
    expect(sanitizeText('a\u2066\u2067\u2068\u2069b')).toBe('ab')
  })

  it('strips LRM/RLM/ALM, invisible-times, and the Hangul filler characters (\\p{Cf} plus fillers)', () => {
    expect(sanitizeText('a\u200Eb\u200Fc\u061Cd')).toBe('abcd')
    expect(sanitizeText('a\u2062b')).toBe('ab')
    expect(sanitizeText('Head\u3164Hunter')).toBe('HeadHunter')
  })

  it('collapses tabs, NBSP and runs of spaces to one space', () => {
    expect(sanitizeText('a\t\tb')).toBe('a b')
    expect(sanitizeText('a\u00A0\u00A0b')).toBe('a b')
    expect(sanitizeText('a    b')).toBe('a b')
  })

  it('single-line (default): newlines become a space, then collapse with neighboring whitespace', () => {
    expect(sanitizeText('a\nb')).toBe('a b')
    expect(sanitizeText('a\n\n\nb')).toBe('a b')
    expect(sanitizeText('a \n b')).toBe('a b')
  })

  it('multiline: trims spaces around newlines and collapses 3+ newlines to 2', () => {
    expect(sanitizeText('a \n b', { multiline: true })).toBe('a\nb')
    expect(sanitizeText('a\n\n\n\nb', { multiline: true })).toBe('a\n\nb')
    expect(sanitizeText('a   b\nc   d', { multiline: true })).toBe('a b\nc d')
  })

  it('treats \\r\\n and lone \\r as a newline before applying line rules', () => {
    expect(sanitizeText('a\r\nb', { multiline: true })).toBe('a\nb')
    expect(sanitizeText('a\rb')).toBe('a b')
  })

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeText('  padded  ')).toBe('padded')
    expect(sanitizeText('  padded  ', { multiline: true })).toBe('padded')
  })
})

describe('PERK_NAME', () => {
  it('accepts letters, numbers, spaces and basic punctuation', () => {
    expect(PERK_NAME.test('Head Hunter')).toBe(true)
    expect(PERK_NAME.test("Marksman's Eye")).toBe(true)
    expect(PERK_NAME.test('Perpetual Velocity (II)')).toBe(true)
    expect(PERK_NAME.test('+10% Damage')).toBe(true)
    expect(PERK_NAME.test('A&B: C, D/E')).toBe(true)
  })

  it('rejects markup and other symbols, and the empty string', () => {
    expect(PERK_NAME.test('<script>')).toBe(false)
    expect(PERK_NAME.test('a@b')).toBe(false)
    expect(PERK_NAME.test('')).toBe(false)
  })
})

describe('withBefore (seeding)', () => {
  const bake = {
    weapons: { Gun: tree },
    classes: { Tactical: { perks: { Stim: { description: 's' } } } },
  }
  const w = (op, quality, perkName, description = null) => ({ kind: 'weapon', target: 'Gun', quality, op, perkName, description })

  it('records the bake perk each edit/remove replaces; adds have none', () => {
    const out = withBefore([w('edit', 'Standard', 'A', 'a2'), w('remove', 'Relic', 'C'), w('add', 'Relic', 'D', 'd')], bake)
    expect(out.map((c) => c.before)).toEqual([{ name: 'A', description: 'a' }, { name: 'C', description: 'c' }, null])
    expect(out[0]).toMatchObject(w('edit', 'Standard', 'A', 'a2'))
  })

  it('applies earlier corrections first, so a later one sees their result', () => {
    const out = withBefore(
      [w('add', 'Relic', 'D', 'd'), w('edit', 'Relic', 'D', 'd2'), w('edit', 'Relic', 'D', 'd3'), w('remove', 'Relic', 'D')],
      bake,
    )
    expect(out.map((c) => c.before)).toEqual([null, { name: 'D', description: 'd' }, { name: 'D', description: 'd2' }, { name: 'D', description: 'd3' }])
  })

  it('class edits see the bake text and earlier class edits', () => {
    const c = (description) => ({ kind: 'class', target: 'Tactical', quality: null, op: 'edit', perkName: 'Stim', description })
    expect(withBefore([c('s2'), c('s3')], bake).map((x) => x.before)).toEqual([
      { name: 'Stim', description: 's' },
      { name: 'Stim', description: 's2' },
    ])
  })

  it('an unknown target or perk gets before: null instead of failing', () => {
    const out = withBefore([{ ...w('edit', 'Standard', 'A', 'x'), target: 'Nope' }, w('remove', 'Heroic', 'Z')], bake)
    expect(out.map((c) => c.before)).toEqual([null, null])
  })

  it('leaves the input list untouched', () => {
    const list = [w('edit', 'Standard', 'A', 'a2')]
    withBefore(list, bake)
    expect(list[0]).not.toHaveProperty('before')
  })
})
