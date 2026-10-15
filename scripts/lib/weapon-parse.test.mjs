import { describe, it, expect } from 'vitest'
import { parse } from 'node-html-parser'
import { normalizeDefence, parseVersions, parsePerks, buildTree, mergeTrees } from './weapon-parse.mjs'

const meleeStats = `
<h3>In-game shown stats</h3>
<table>
  <tr><th>Quality</th><th>Version Name</th><th>Strength</th><th>Speed</th><th>Cleaving Potential</th><th>Defence</th></tr>
  <tr><td>Standard</td><td>Standard-Issue</td><td>5</td><td>4+</td><td>4</td><td>Balance</td></tr>
  <tr><td>Master-Crafted</td><td>Master-Crafted - Beta</td><td>10</td><td>2+</td><td>4</td><td>Block</td></tr>
  <tr><td>Master-Crafted</td><td>Master-Crafted - Gamma</td><td>6</td><td>8+</td><td>2</td><td>Fencing</td></tr>
</table>`

const perkTable = `
<h2>Perk List</h2>
<table>
  <tr><th>Quality</th><th>Perk name</th><th>Description</th></tr>
  <tr><td>Standard</td><td>Brutal Swing</td><td>Heavy attacks deal 10% more damage</td></tr>
</table>`

const doc = (html) => parse(`<div>${html}</div>`)

describe('normalizeDefence', () => {
  it('maps the wiki "Balance" and "Balanced" to Balanced, case-insensitively', () => {
    expect(normalizeDefence('Balance')).toBe('Balanced')
    expect(normalizeDefence('balance')).toBe('Balanced')
    expect(normalizeDefence('BALANCED')).toBe('Balanced')
  })

  it('accepts Block and Fencing', () => {
    expect(normalizeDefence('Block')).toBe('Block')
    expect(normalizeDefence(' fencing ')).toBe('Fencing')
  })

  it('returns null for anything else', () => {
    expect(normalizeDefence('Parry')).toBeNull()
    expect(normalizeDefence('')).toBeNull()
    expect(normalizeDefence('—')).toBeNull()
    expect(normalizeDefence(undefined)).toBeNull()
  })
})

describe('parseVersions', () => {
  it('reads the Defence column into version.defence and keeps it out of the gauges', () => {
    const versions = parseVersions(doc(meleeStats))
    expect(versions.map((v) => v.defence)).toEqual(['Balanced', 'Block', 'Fencing'])
    expect(Object.keys(versions[0].gauges)).toEqual(['Strength', 'Speed', 'Cleaving Potential'])
    expect(versions[0].gauges.Speed.value).toBe(4.5)
  })

  it('leaves ranged versions without a defence key and keeps their figures', () => {
    const ranged = `
      <h3>In-game shown stats</h3>
      <table>
        <tr><th>Quality</th><th>Version Name</th><th>Firepower</th><th>Accuracy</th><th>Magazine Capacity</th></tr>
        <tr><td>Standard</td><td>Standard-Issue</td><td>6</td><td>5+</td><td>30</td></tr>
      </table>`
    const [v] = parseVersions(doc(ranged))
    expect('defence' in v).toBe(false)
    expect(v.figures['Magazine Capacity']).toBe('30')
    expect(Object.keys(v.gauges)).toEqual(['Firepower', 'Accuracy'])
  })

  it.each([['—'], ['']])('gives no defence key for a blank or dash cell (%j)', (cell) => {
    const html = `
      <h3>In-game shown stats</h3>
      <table>
        <tr><th>Quality</th><th>Version Name</th><th>Strength</th><th>Defence</th></tr>
        <tr><td>Standard</td><td>Standard-Issue</td><td>5</td><td>${cell}</td></tr>
      </table>`
    const [v] = parseVersions(doc(html))
    expect('defence' in v).toBe(false)
    expect(v.gauges.Strength.value).toBe(5)
  })

  it('writes dashes in version names as plain hyphens, as the game does', () => {
    const html = `
      <h3>In-game shown stats</h3>
      <table>
        <tr><th>Quality</th><th>Version Name</th><th>Firepower</th></tr>
        <tr><td>Master-Crafted</td><td>Master-Crafted — Alpha</td><td>5</td></tr>
        <tr><td>Master-Crafted</td><td>Master-Crafted – Beta</td><td>5</td></tr>
        <tr><td>Master-Crafted</td><td>Master-Crafted - Gamma</td><td>5</td></tr>
      </table>`
    expect(parseVersions(doc(html)).map((v) => v.name)).toEqual(['Master-Crafted - Alpha', 'Master-Crafted - Beta', 'Master-Crafted - Gamma'])
  })

  it('gives no defence key for an unrecognised value', () => {
    const html = meleeStats.replace('Fencing', 'Parry')
    expect('defence' in parseVersions(doc(html))[2]).toBe(false)
  })
})

describe('parsePerks', () => {
  it('reads the perk table', () => {
    expect(parsePerks(doc(perkTable))).toEqual([
      { name: 'Brutal Swing', quality: 'Standard', description: 'Heavy attacks deal 10% more damage' },
    ])
  })
})

describe('buildTree', () => {
  it('has no perksPending when the perk table is present', () => {
    const tree = buildTree(doc(meleeStats + perkTable))
    expect(tree.perks).toHaveLength(1)
    expect('perksPending' in tree).toBe(false)
    expect(tree.versions).toHaveLength(3)
  })

  it('marks a weapon with versions but no perk table as perksPending', () => {
    const tree = buildTree(doc(meleeStats))
    expect(tree.perks).toEqual([])
    expect(tree.perksPending).toBe(true)
    expect(tree.versions).toHaveLength(3)
  })

  it('throws when there are neither perks nor versions', () => {
    expect(() => buildTree(doc('<p>nothing here</p>'))).toThrow(/no readable perk table or versions/)
  })
})

describe('mergeTrees', () => {
  const tree = (over = {}) => ({
    perks: [{ name: 'Old Perk', quality: 'Standard', description: 'old 5' }],
    budget: 10,
    intro: ['old intro'],
    meta: { slot: 'Melee' },
    versions: [{ quality: 'Standard', name: 'Standard-Issue', gauges: {}, figures: {} }],
    ...over,
  })
  const fresh = (over = {}) =>
    tree({
      perks: [{ name: 'New Perk', quality: 'Standard', description: 'new 6' }],
      budget: 12,
      intro: ['new intro'],
      versions: [{ quality: 'Standard', name: 'Standard-Issue', gauges: {}, figures: {}, defence: 'Balanced' }],
      ...over,
    })

  it('keepPerks keeps previous perks and budget but takes fresh versions, meta and intro', () => {
    const out = mergeTrees({ A: tree() }, { A: fresh() }, { keepPerks: true })
    expect(out.A.perks).toEqual(tree().perks)
    expect(out.A.budget).toBe(10)
    expect(out.A.versions[0].defence).toBe('Balanced')
    expect(out.A.intro).toEqual(['new intro'])
  })

  const ver = (name, strength, extra = {}) => ({
    quality: 'Standard',
    name,
    gauges: { Strength: { value: strength, raw: String(strength) } },
    figures: {},
    ...extra,
  })

  it('keepPerks holds an existing version\'s stats and takes only its defence from fresh', () => {
    const prev = tree({ versions: [ver('Standard-Issue', 5)] })
    const next = fresh({ versions: [ver('Standard-Issue', 6, { defence: 'Block' })] })
    const out = mergeTrees({ A: prev }, { A: next }, { keepPerks: true })
    expect(out.A.versions).toEqual([ver('Standard-Issue', 5, { defence: 'Block' })])
  })

  it('keepPerks takes a version that is new on the wiki, whole', () => {
    const prev = tree({ versions: [ver('Standard-Issue', 5)] })
    const next = fresh({ versions: [ver('Standard-Issue', 5), ver('Frost Axe', 16, { defence: 'Balanced' })] })
    const out = mergeTrees({ A: prev }, { A: next }, { keepPerks: true })
    expect(out.A.versions.map((v) => v.name)).toEqual(['Standard-Issue', 'Frost Axe'])
    expect(out.A.versions[1].gauges.Strength.value).toBe(16)
  })

  it('keepPerks keeps a version the wiki has dropped', () => {
    const prev = tree({ versions: [ver('Standard-Issue', 5), ver('Marksman (PVP)', 7)] })
    const next = fresh({ versions: [ver('Standard-Issue', 5)] })
    const out = mergeTrees({ A: prev }, { A: next }, { keepPerks: true })
    expect(out.A.versions.map((v) => v.name)).toEqual(['Standard-Issue', 'Marksman (PVP)'])
  })

  it('keepPerks holds the baked version when the wiki lists one name twice, instead of copying it twice', () => {
    const prev = tree({
      versions: [ver('Standard-Issue', 5), ver('Marksman (PVP)', 7), ver('Master-Crafted', 6), ver('MC Marksman', 9)],
    })
    // The wiki relabelled the PvP row as a second "MC Marksman".
    const next = fresh({
      versions: [ver('Standard-Issue', 5), ver('MC Marksman', 7), ver('Master-Crafted', 6), ver('MC Marksman', 9)],
    })
    const out = mergeTrees({ A: prev }, { A: next }, { keepPerks: true })
    expect(out.A.versions.map((v) => v.name)).toEqual(['Standard-Issue', 'Master-Crafted', 'MC Marksman', 'Marksman (PVP)'])
    expect(out.A.versions[2].gauges.Strength.value).toBe(9)
  })

  it('keepPerks keeps only the last row when a duplicated name has no baked version', () => {
    const prev = tree({ versions: [ver('Standard-Issue', 5)] })
    const next = fresh({ versions: [ver('Standard-Issue', 5), ver('New', 1), ver('New', 2)] })
    const out = mergeTrees({ A: prev }, { A: next }, { keepPerks: true })
    expect(out.A.versions.map((v) => [v.name, v.gauges.Strength.value])).toEqual([['Standard-Issue', 5], ['New', 2]])
  })

  it('without keepPerks a name the wiki lists twice is kept once, at its last row', () => {
    const prev = tree({ versions: [ver('Standard-Issue', 5)] })
    const next = fresh({ versions: [ver('Standard-Issue', 5), ver('MC Marksman', 7), ver('Master-Crafted', 6), ver('MC Marksman', 9)] })
    const out = mergeTrees({ A: prev }, { A: next }, { keepPerks: false })
    expect(out.A.versions.map((v) => [v.name, v.gauges.Strength.value])).toEqual([
      ['Standard-Issue', 5],
      ['Master-Crafted', 6],
      ['MC Marksman', 9],
    ])
  })

  it('a weapon only in fresh is taken with a duplicated version name kept once', () => {
    const next = fresh({ versions: [ver('New', 1), ver('New', 2)] })
    for (const keepPerks of [true, false]) {
      const out = mergeTrees({}, { B: next }, { keepPerks })
      expect(out.B.versions.map((v) => [v.name, v.gauges.Strength.value])).toEqual([['New', 2]])
    }
  })

  it('without keepPerks the fresh versions win wholesale', () => {
    const prev = tree({ versions: [ver('Standard-Issue', 5), ver('Marksman (PVP)', 7)] })
    const next = fresh({ versions: [ver('Standard-Issue', 6)] })
    expect(mergeTrees({ A: prev }, { A: next }, { keepPerks: false }).A.versions).toEqual(next.versions)
  })

  it('keepPerks takes a weapon that is only in fresh, whole', () => {
    const out = mergeTrees({}, { B: fresh() }, { keepPerks: true })
    expect(out.B).toEqual(fresh())
  })

  it('keepPerks takes fresh perks for a previous perksPending weapon once the wiki has them', () => {
    const prev = tree({ perks: [], perksPending: true })
    const out = mergeTrees({ A: prev }, { A: fresh() }, { keepPerks: true })
    expect(out.A.perks).toEqual(fresh().perks)
    expect('perksPending' in out.A).toBe(false)
  })

  it('keepPerks never carries perksPending onto previous perks', () => {
    const out = mergeTrees({ A: tree() }, { A: fresh({ perks: [], perksPending: true }) }, { keepPerks: true })
    expect(out.A.perks).toEqual(tree().perks)
    expect('perksPending' in out.A).toBe(false)
  })

  it('keeps a previous-only weapon (failed fetch) either way', () => {
    expect(mergeTrees({ Z: tree() }, {}, { keepPerks: true }).Z).toEqual(tree())
    expect(mergeTrees({ Z: tree() }, {}, { keepPerks: false }).Z).toEqual(tree())
  })

  it('without keepPerks fresh wins', () => {
    const out = mergeTrees({ A: tree() }, { A: fresh() }, { keepPerks: false })
    expect(out.A).toEqual(fresh())
  })

  it('never lets a fresh tree with no perk table wipe a previous tree that has perks', () => {
    const out = mergeTrees({ A: tree() }, { A: fresh({ perks: [], perksPending: true }) }, { keepPerks: false })
    expect(out.A.perks).toEqual(tree().perks)
    expect('perksPending' in out.A).toBe(false)
    expect(out.A.versions[0].defence).toBe('Balanced')
  })
})
