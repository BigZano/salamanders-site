import { describe, it, expect } from 'vitest'
import { lore } from './lore'
import { LORE_TEXTS } from './loreTexts'

const plain = (segs) => segs.map((s) => s.t).join('')

describe('LORE_TEXTS', () => {
  it('holds every Fortress Lore text the page shows, as text, with no link or id', () => {
    expect(Object.keys(LORE_TEXTS)).toEqual(['lo_s', 'lo_e', 'lo1', 'lo2', 'lo3', 'lo4', 'lo5', 'lo6'])
    for (const [k, v] of Object.entries(LORE_TEXTS)) expect(typeof v === 'string' && v.trim().length > 0, k).toBe(true)
    expect(Object.values(LORE_TEXTS).join('\n')).not.toMatch(/https?:|\d{17,20}/)
  })
})

describe('lore', () => {
  it("reads the old site's six chapters, numbered, each with its title", () => {
    const l = lore()
    expect(l.chapters.map((c) => c.n)).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI'])
    expect(plain(l.chapters[0].title)).toBe('The Shadow Over Nocturne')
    expect(plain(l.sub)).toBe('The Last Bastion of the Eternal Flame')
  })

  it('groups speech lines into one speech, cries into one block, and keeps a lone proclamation', () => {
    const c = lore({ lo1: 'Title\nFirst.\n*"One."*\n*"Two."*\nBetween.\n**ALONE.**\nAfter.\n**A!**\n**B!**\n**C!**' }).chapters[0]
    expect(c.blocks.map((b) => [b.kind, b.lines.map(plain)])).toEqual([
      ['p', ['First.']],
      ['q', ['"One."', '"Two."']],
      ['p', ['Between.']],
      ['x', ['ALONE.']],
      ['p', ['After.']],
      ['cry', ['A!', 'B!', 'C!']],
    ])
  })

  it('takes what the data holds, and drops a chapter it blanks', () => {
    const l = lore({ lo2: '', lo_s: 'Ours' })
    expect(l.chapters.map((c) => c.n)).toEqual(['I', 'III', 'IV', 'V', 'VI'])
    expect(plain(l.sub)).toBe('Ours')
    expect(lore('nonsense').chapters).toHaveLength(6)
  })

  it('keeps a line with two marks a paragraph, not a speech or a proclamation', () => {
    const c = lore({ lo1: 'Title\n*a* and *b*\n**A** and **B**' }).chapters[0]
    expect(c.blocks.map((b) => b.kind)).toEqual(['p', 'p'])
    expect(c.blocks[0].lines[0]).toEqual([{ k: 'i', t: 'a' }, { k: '', t: ' and ' }, { k: 'i', t: 'b' }])
  })
})
