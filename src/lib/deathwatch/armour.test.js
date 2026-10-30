import { describe, expect, it } from 'vitest'
import { PAINT, SPECIALIST, STANDARD, UNIFORMS, WATCH_COMMAND, hotspot, itemSlug, noteParts, uniformFor } from './armour'
import { AREAS } from './areas'

describe('the uniforms', () => {
  it('has the old site’s uniforms on each tab, with the old addresses', () => {
    expect(STANDARD.map(itemSlug)).toEqual(['watchbrother', 'companyheraldry'])
    expect(SPECIALIST.map(itemSlug)).toEqual(['reclusiarc', 'librarium', 'apothecarion', 'mechanicus'])
    expect(WATCH_COMMAND.map(itemSlug)).toEqual(['watchsergeant', 'watchchaplain', 'watchlibrarian', 'watchapothecary', 'watchtechmarine'])
  })

  it('names only paints it has a colour for, and only tiles its sprite has', () => {
    for (const u of Object.values(UNIFORMS).flat().filter((x) => !x.heraldry)) {
      for (const [title, rows, , tiles, spot] of [...u.L, ...u.R]) {
        for (const [, paint] of rows) expect(PAINT[paint], `${u.name} ${title} ${paint}`).toBeTruthy()
        for (const t of tiles) expect(t >= 0 && t < 11, `${u.name} ${title}`).toBe(true)
        expect(spot).toHaveLength(2)
      }
    }
  })

  it('dresses each specialist in its own colour', () => {
    const helm = (u) => Object.fromEntries(u.L[0][1])
    expect(SPECIALIST.map((u) => helm(u).Primary)).toEqual(['Wraithbone', 'Alaitoc Blue', 'White Scar', 'Red'])
    expect(SPECIALIST[0].R[0][1][2]).toEqual(['Backpack primary', 'Abaddon Black'])
  })
})

describe('uniformFor', () => {
  it('finds the uniform an address names, and falls back to the tab’s first', () => {
    expect(uniformFor('specialist', 'mechanicus').name).toBe('Mechanicus')
    expect(uniformFor('specialist', '').name).toBe('Reclusiarc')
    expect(uniformFor('specialist', 'nope').name).toBe('Reclusiarc')
  })

  it('the Watch Command specialists: the Sergeant’s armour and greaves, their role’s helm, backpack and gauntlet as their Specialist uniform', () => {
    const sergeant = uniformFor('watch-command', 'watchsergeant')
    for (const [slug, primary, onSpecialist, secondary = 'Khorne Red'] of [
      ['watchapothecary', 'White Scar', 'apothecarion'],
      ['watchlibrarian', 'Alaitoc Blue', 'librarium'],
      ['watchchaplain', 'Wraithbone', 'reclusiarc'],
      ['watchtechmarine', 'Red', 'mechanicus', 'White Scar'],
    ]) {
      const u = uniformFor('watch-command', slug)
      expect(u.command).toBe(true)
      expect(u.onSpecialist).toBe(onSpecialist)
      expect(u.L[0][1]).toEqual([['Primary', primary], ['Secondary', secondary], ['Tertiary', 'Liberator Gold'], ['Lenses', 'Liberator Gold']])
      expect(u.L[2][3]).toEqual([3])
      const own = `in the colours of your [Specialist Uniform](/deathwatch/armouringhall/specialist/${onSpecialist}).`
      expect(u.R[0][1]).toEqual([['Chest primary', 'Abaddon Black'], ['Chest tertiary', 'Liberator Gold']])
      expect(u.R[0][2]).toEqual([`Backpack: ${own}`])
      expect(u.R[1][1]).toEqual([])
      expect(u.R[1][2]).toEqual([`Right: ${own}`, 'Left: the Deathwatch Gauntlet.'])
      expect(u.R[2]).toBe(sergeant.R[2])
      expect(u.img).not.toBe(sergeant.img)
    }
  })

  it('has nothing for a tab without uniforms', () => {
    expect(uniformFor('restricted-wargear', '')).toBeUndefined()
    expect(uniformFor('__proto__', '')).toBeUndefined()
  })
})

describe('the helpers', () => {
  it('maps a hotspot onto a full figure', () => {
    expect(hotspot({ hm: [1, 2, 3, 4] }, [10, 20])).toEqual([12, 64])
    expect(hotspot({}, [10, 20])).toEqual([10, 20])
  })

  it('splits a note into its lead word and text', () => {
    expect(noteParts('Left: the Deathwatch Pauldron.')).toEqual(['Left', 'the Deathwatch Pauldron.'])
    expect(noteParts('Both greave icon slots: follow')).toEqual(['Both greave icon slots', 'follow'])
    expect(noteParts('Backpack: in the colours')).toEqual(['Backpack', 'in the colours'])
    expect(noteParts('///CLASSIFIED///')).toBeNull()
  })
})

describe('the Armouring Hall tabs', () => {
  it('list the items of their uniforms, in order, and only the tabs with uniforms have any', () => {
    for (const { slug, items } of AREAS.armouringhall.tabs) {
      expect(items, slug).toEqual(Object.hasOwn(UNIFORMS, slug) ? UNIFORMS[slug].map(itemSlug) : undefined)
    }
  })

  // Two uniforms of one tab with the same slug would share an address, and uniformFor would only ever find the first.
  it('give every uniform of a tab its own slug', () => {
    for (const [tab, list] of Object.entries(UNIFORMS)) {
      const slugs = list.map(itemSlug)
      expect(new Set(slugs).size, tab).toBe(slugs.length)
    }
  })

  // Why the check above is needed: names that differ only in case, spaces or punctuation share a slug, and then
  // the address can only ever reach the first of them.
  it('reaches only the first of two uniforms that share a slug', () => {
    const first = { name: 'Watch-Brother' }
    const second = { name: 'watch brother' }
    expect(itemSlug(first)).toBe('watchbrother')
    expect(itemSlug(second)).toBe('watchbrother')
    UNIFORMS.duplicate = [first, second]
    try {
      expect(uniformFor('duplicate', 'watchbrother')).toBe(first)
      expect(uniformFor('duplicate', 'nope')).toBe(first)
    } finally {
      delete UNIFORMS.duplicate
    }
  })

  it('show the first uniform for any sub-slug that is not one of theirs', () => {
    for (const sub of ['nope', '', 123, null, undefined, ['watchbrother'], '__proto__']) {
      expect(uniformFor('standard', sub), String(sub)).toBe(STANDARD[0])
    }
    expect(uniformFor('restricted-wargear', 'watchbrother')).toBeUndefined()
  })
})
