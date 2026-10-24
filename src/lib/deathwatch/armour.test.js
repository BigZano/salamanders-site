import { describe, expect, it } from 'vitest'
import { PAINT, SPECIALIST, STANDARD, UNIFORMS, WATCH_COMMAND, hotspot, itemSlug, noteParts, uniformFor } from './armour'

describe('the uniforms', () => {
  it('has the old site’s uniforms on each tab, with the old addresses', () => {
    expect(STANDARD.map(itemSlug)).toEqual(['watchbrother', 'companyheraldry'])
    expect(SPECIALIST.map(itemSlug)).toEqual(['apothecarion', 'librarium', 'mechanicus', 'reclusiarc'])
    expect(WATCH_COMMAND.map(itemSlug)).toEqual(['watchsergeant', 'watchspecialist'])
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
    expect(SPECIALIST.map((u) => helm(u).Primary)).toEqual(['White Scar', 'Alaitoc Blue', 'Mephiston Red', 'Wraithbone'])
    expect(SPECIALIST[3].R[0][1][2]).toEqual(['Backpack primary', 'Abaddon Black'])
  })
})

describe('uniformFor', () => {
  it('finds the uniform an address names, and falls back to the tab’s first', () => {
    expect(uniformFor('specialist', 'mechanicus').name).toBe('Mechanicus')
    expect(uniformFor('specialist', '').name).toBe('Apothecarion')
    expect(uniformFor('specialist', 'nope').name).toBe('Apothecarion')
    expect(uniformFor('watch-command', 'watchspecialist').specialistOnly).toBe(true)
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
    expect(noteParts('///CLASSIFIED///')).toBeNull()
  })
})
