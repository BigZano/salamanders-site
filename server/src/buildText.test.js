import { describe, it, expect } from 'vitest'
import { validateBuildText } from './buildText'

const b = (over = {}) => ({ title: 'Melta Bulwark', role: 'Tank', notes: 'Solid pick', className: 'Devastator', ...over })

describe('validateBuildText', () => {
  it('strips zero-width characters from the title', () => {
    const out = validateBuildText(b({ title: 'Mel​ta Bulwark' }))
    expect(out.title).toBe('Melta Bulwark')
  })

  it('keeps single newlines in notes', () => {
    const out = validateBuildText(b({ notes: 'Line one\nLine two' }))
    expect(out.notes).toBe('Line one\nLine two')
  })

  it('rejects an over-limit title with its message', () => {
    expect(validateBuildText(b({ title: 'x'.repeat(201) }))).toBe('Title is too long (200 characters max).')
  })

  it('rejects an over-limit role with its message', () => {
    expect(validateBuildText(b({ role: 'x'.repeat(201) }))).toBe('Role is too long (200 characters max).')
  })

  it('rejects over-limit notes with its message', () => {
    expect(validateBuildText(b({ notes: 'x'.repeat(2001) }))).toBe('Notes are too long (2000 characters max).')
  })

  it('rejects an empty title after sanitizing', () => {
    expect(validateBuildText(b({ title: '   ' }))).toBe('Give the build a title.')
  })

  it('returns clean title, role and notes for valid input', () => {
    expect(validateBuildText(b())).toMatchObject({ title: 'Melta Bulwark', role: 'Tank', notes: 'Solid pick', justifications: {} })
  })

  it('strips zero-width characters inside a justification', () => {
    const out = validateBuildText(b({ justifications: { p1: 'Mel​ta' } }))
    expect(out.justifications).toEqual({ p1: 'Melta' })
  })

  it('drops a justification that is empty after sanitizing', () => {
    const out = validateBuildText(b({ justifications: { p1: '   ', p2: 'Kept' } }))
    expect(out.justifications).toEqual({ p2: 'Kept' })
  })

  it('rejects an over-limit justification with its message', () => {
    expect(validateBuildText(b({ justifications: { p1: 'x'.repeat(1001) } }))).toBe(
      'A perk justification is too long (1000 characters max).',
    )
  })

  it('treats a non-object justifications as empty', () => {
    expect(validateBuildText(b({ justifications: 'nope' })).justifications).toEqual({})
    expect(validateBuildText(b({ justifications: null })).justifications).toEqual({})
    expect(validateBuildText(b({ justifications: undefined })).justifications).toEqual({})
  })

  it('a __proto__ key from JSON.parse does not pollute Object.prototype', () => {
    const parsed = JSON.parse('{"__proto__":{"x":"y"}}')
    const out = validateBuildText(b({ justifications: parsed }))
    expect(out.justifications).toEqual({})
    expect(out.justifications.x).toBeUndefined()
    expect(({}).x).toBeUndefined()
    expect(Object.prototype.x).toBeUndefined()
  })
})

// Mirrors planner.buildSnapshot (src/stores/planner.js) for a fully-kitted
// build: every column picked, all four prestige ranks, three weapons each
// with a large tree selected.
const treeOf = (w, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`master-crafted-${w.toLowerCase().replace(/ /g, '-')}-perk-${i}-c${1000 + i}`, true]))
const MAXIMAL = {
  title: 'Everything',
  role: 'All of it',
  notes: 'n',
  className: 'Techmarine',
  level: 25,
  prestige: 4,
  prestigePicks: ['Prestige One', 'Prestige Two', 'Prestige Three', 'Prestige Four'],
  perks: ['Adrenaline Rush', 'Bolter Drill', 'Clear Mind', 'Squad Cohesion', 'Ammo Reserves', 'Grenadier', 'Close Quarters', "Emperor's Wrath"],
  perkIds: Object.fromEntries(Array.from({ length: 8 }, (_, c) => [String(c), `Perk ${c}`])),
  justifications: Object.fromEntries(Array.from({ length: 8 }, (_, c) => [String(c), `Why pick ${c}.`])),
  weapons: { primary: 'Heavy Bolt Rifle', secondary: 'Bolt Pistol', melee: 'Power Sword' },
  weaponPerks: { 'Heavy Bolt Rifle': treeOf('Heavy Bolt Rifle', 40), 'Bolt Pistol': treeOf('Bolt Pistol', 23), 'Power Sword': treeOf('Power Sword', 23) },
}

describe('validateBuildText: every picked perk needs a justification', () => {
  const picks = { perks: ['Adrenaline Rush', null, 'Clear Mind', null, null, null, null, null] }

  it('rejects a picked perk with no justification, naming it', () => {
    expect(validateBuildText(b({ ...picks, justifications: { 0: 'Opens fights.' } }))).toBe(
      'Explain why you picked Clear Mind (every picked perk needs a reason).',
    )
  })

  it('treats a whitespace or invisible-only reason as missing', () => {
    expect(validateBuildText(b({ ...picks, justifications: { 0: 'Opens fights.', 2: ' ​ ' } }))).toMatch(/Clear Mind/)
  })

  it('accepts a build where every picked perk is justified; empty slots need nothing', () => {
    const out = validateBuildText(b({ ...picks, justifications: { 0: 'Opens fights.', 2: 'Keeps me calm.' } }))
    expect(out.justifications).toEqual({ 0: 'Opens fights.', 2: 'Keeps me calm.' })
  })
})

describe('validateBuildText: the build body', () => {
  it('accepts a realistic maximal build unchanged', () => {
    const out = validateBuildText(MAXIMAL)
    expect(typeof out).toBe('object')
    for (const k of ['className', 'prestigePicks', 'perks', 'perkIds', 'weapons', 'weaponPerks']) expect(out[k]).toEqual(MAXIMAL[k])
  })

  it('keeps empty slots in place (perks and prestige picks are positional)', () => {
    const out = validateBuildText(b({ perks: ['A', null, 'C'], prestigePicks: [null, 'P', null, null], justifications: { 0: 'a', 2: 'c' } }))
    expect(out.perks).toEqual(['A', null, 'C'])
    expect(out.prestigePicks).toEqual([null, 'P', null, null])
  })

  it('defaults missing fields to empty', () => {
    expect(validateBuildText(b())).toMatchObject({ className: 'Devastator', perks: [], prestigePicks: [], perkIds: {}, weapons: {}, weaponPerks: {} })
  })

  it.each([
    [{ className: 'x'.repeat(41) }, /Class/],
    [{ className: '<script>' }, /Class/],
    [{ className: '' }, /Class/],
    [{ perks: Array(25).fill('A') }, 'Build has too many perks.'],
    [{ perks: ['x'.repeat(81)] }, /perk name is too long/i],
    [{ prestigePicks: Array(5).fill('P') }, 'Build has too many prestige picks.'],
    [{ prestigePicks: ['x'.repeat(81)] }, /prestige pick is too long/i],
    [{ weapons: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`s${i}`, 'W'])) }, 'Build has too many weapons.'],
    [{ weapons: { primary: 'x'.repeat(81) } }, /weapon name is too long/i],
    [{ weaponPerks: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`W${i}`, {}])) }, 'Build has too many weapon perk trees.'],
    [{ weaponPerks: { W: treeOf('W', 41) } }, 'A weapon has too many perks selected.'],
    [{ weaponPerks: { ['x'.repeat(81)]: {} } }, /weapon name is too long/i],
    [{ weaponPerks: { W: { ['x'.repeat(121)]: true } } }, /perk id is too long/i],
    [{ perkIds: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [String(i), 'P'])) }, 'Build has too many perk picks.'],
    [{ perkIds: { 0: 'x'.repeat(121) } }, /perk pick is too long/i],
    [{ weapons: { primary: '__proto__' } }, /weapon name is not valid/i],
    [{ weapons: { primary: '<b>Gun</b>' } }, /weapon name is not valid/i],
    [{ weaponPerks: { '<script>': {} } }, /weapon name is not valid/i],
    [{ weaponPerks: JSON.parse('{"__proto__":{"a":true}}') }, /weapon name is not valid/i],
  ])('rejects %j', (over, msg) => {
    const out = validateBuildText(b(over))
    expect(typeof out).toBe('string')
    expect(out).toMatch(msg)
  })

  it('drops non-string junk and sanitizes what it keeps', () => {
    const out = validateBuildText(
      b({
        perks: ['Bolter​ Drill', 5, { x: 1 }],
        prestigePicks: ['P', 7],
        weapons: { primary: 'Bolt‮ Rifle', secondary: 3, melee: { a: 1 } },
        weaponPerks: { 'Bolt Rifle': { a: true, b: 'yes', c: 1 }, Junk: 'nope' },
        perkIds: { 0: 'P', 1: 3, 2: true, 3: { nested: 1 }, 4: null },
        justifications: { 0: 'why' },
      }),
    )
    expect(out.perks).toEqual(['Bolter Drill', null, null])
    expect(out.prestigePicks).toEqual(['P', null])
    expect(out.weapons).toEqual({ primary: 'Bolt Rifle' })
    expect(out.weaponPerks).toEqual({ 'Bolt Rifle': { a: true } })
    expect(out.perkIds).toEqual({ 0: 'P', 1: 3, 2: true })
  })

  it('non-array / non-object shapes become empty', () => {
    const out = validateBuildText(b({ perks: 'A', prestigePicks: {}, weapons: ['x'], weaponPerks: 'x', perkIds: ['a'] }))
    expect(out).toMatchObject({ perks: [], prestigePicks: [], weapons: {}, weaponPerks: {}, perkIds: {} })
  })

  it('a __proto__ key in weapons, weaponPerks or perkIds does not pollute', () => {
    const out = validateBuildText(
      b({
        weapons: JSON.parse('{"__proto__":"W"}'),
        weaponPerks: JSON.parse('{"W":{"__proto__":true}}'),
        perkIds: JSON.parse('{"__proto__":"P"}'),
      }),
    )
    expect(Object.getPrototypeOf(out.weapons)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(out.perkIds)).toBe(Object.prototype)
    expect(({}).a).toBeUndefined()
    expect(Object.prototype.a).toBeUndefined()
  })

  it('keeps only the primary, secondary and melee weapon slots', () => {
    const out = validateBuildText(b({ weapons: { primary: 'Bolt Rifle', sidearm: 'Pistol', __proto__x: 'W', melee: 'Power Sword' } }))
    expect(out.weapons).toEqual({ primary: 'Bolt Rifle', melee: 'Power Sword' })
  })

  it('drops perkIds keys over 40 characters after sanitizing, keeps exactly 40-char keys', () => {
    const out = validateBuildText(b({ perkIds: { ['a'.repeat(41)]: 'too long', ['b'.repeat(40)]: 'just right', short: 'also good', '​': 'empty' } }))
    expect(out.perkIds).toEqual({ ['b'.repeat(40)]: 'just right', short: 'also good' })
  })

  it('drops justification keys over 40 characters after sanitizing, keeps exactly 40-char keys and at most 8', () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), `why ${i}`]))
    expect(Object.keys(validateBuildText(b({ justifications: many })).justifications)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7'])
    const out = validateBuildText(b({ justifications: { ['a'.repeat(41)]: 'over limit', ['b'.repeat(40)]: 'exact', '​': 'empty key', '1​': 'one' } }))
    expect(out.justifications).toEqual({ ['b'.repeat(40)]: 'exact', 1: 'one' })
  })
})

describe('validateBuildText: level and prestige', () => {
  it.each([
    [undefined, undefined, 1, 0],
    [25, 4, 25, 4],
    [12.9, 2.7, 12, 2],
    ['7', '3', 7, 3],
    [0, -1, 1, 0],
    [99, 9, 25, 4],
    ['abc', null, 1, 0],
    [Infinity, NaN, 1, 0],
  ])('level %j / prestige %j → %i / %i', (level, prestige, wantLevel, wantPrestige) => {
    const out = validateBuildText(b({ level, prestige }))
    expect(out.level).toBe(wantLevel)
    expect(out.prestige).toBe(wantPrestige)
  })
})
