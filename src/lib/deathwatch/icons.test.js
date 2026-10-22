import { describe, it, expect } from 'vitest'
import { AREAS } from './areas'
import { iconFor } from './icons'

describe('iconFor', () => {
  it('has an icon for every tab of every area', () => {
    for (const { tabs } of Object.values(AREAS)) {
      for (const { slug } of tabs) expect(iconFor(slug).length, slug).toBeGreaterThan(0)
    }
  })

  it('has the icon for the way back to the hub', () => {
    expect(iconFor('menu').length).toBeGreaterThan(0)
  })

  it('draws the standings icon as the original did', () => {
    expect(iconFor('standings')).toEqual([['path', { d: 'M3 21h18M6 21V11h4v10M10 21V5h4v16M14 21v-7h4v7' }]])
  })

  it('gives nothing for an unknown slug, or one that names something on Object.prototype', () => {
    for (const slug of ['nope', '', '__proto__', 'constructor', 'toString', 7, null, undefined, ['standings'], { toString: () => 'standings' }]) {
      expect(iconFor(slug), String(slug)).toEqual([])
    }
  })

  it('is only paths, circles and rects, with plain string or number attributes', () => {
    for (const { tabs } of Object.values(AREAS)) {
      for (const { slug } of tabs) {
        for (const [tag, attrs] of iconFor(slug)) {
          expect(['path', 'circle', 'rect'], `${slug} ${tag}`).toContain(tag)
          for (const value of Object.values(attrs)) expect(['string', 'number']).toContain(typeof value)
        }
      }
    }
  })
})
