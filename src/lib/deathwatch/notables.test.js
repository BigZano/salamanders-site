import { describe, it, expect } from 'vitest'
import { anyone, inline, notables, whole } from './notables'

// Invented names only: the real ones live in the server's data. The shape is the old site's, 1:1.
const TX = {
  nm_i: '*Within the walls the names of its warriors are remembered.*',
  nm_ck: 'Watch Commander of Ebonhold · Sworn in *spring*',
  nm_c: 'Watch Commander Varn\n**Known for:** the **Long Vigil**.\n\nKeeps the ||watch||.',
  nm_hi: '*The names of those who held command.*',
  nm_h: [
    '## Watch Commanders',
    '- **Watch Commander Varn:** [March 1st](https://example.com/a) — *present*',
    '- **Watch Commander Ilo:** ||*Records lost*|| — [March 1st](https://example.com/a)',
    '## Watch Captains',
    '- **Watch Captain Quell:** ||///*CLASSIFIED*///||',
  ].join('\n'),
  nm_vi: '*Before the fortress stood, these warriors forged it.*',
  nm_vk: 'Former Watch Command',
  nm_v: 'Sergeant Ilo — The Steady Hand\n- Led from the front.\n\nBrother Quell — ///Classified/// [sealed]\nWhat he did stays sealed.\n\nBrother Oren\nNo epithet here.',
  nm_e: '*Not every warrior is worthy.*\n\n**ONLY THE ELITE.**\n\n**SUFFER NOT THE ALIEN TO LIVE!**',
}

describe('inline', () => {
  it('splits bold, italic, spoiler and link marks into segments', () => {
    expect(inline('a **b** *c* ||d|| [e](https://example.com/x) f')).toEqual([
      { k: '', t: 'a ' },
      { k: 'b', t: 'b' },
      { k: '', t: ' ' },
      { k: 'i', t: 'c' },
      { k: '', t: ' ' },
      { k: 's', t: 'd' },
      { k: '', t: ' ' },
      { k: 'a', t: 'e', href: 'https://example.com/x', segs: [{ k: '', t: 'e' }] },
      { k: '', t: ' f' },
    ])
  })

  it('drops the marks inside a spoiler, and leaves a link that is not https as it is', () => {
    expect(inline('||*lost*||')).toEqual([{ k: 's', t: 'lost' }])
    expect(inline('[x](javascript:alert(1))')).toEqual([{ k: '', t: '[x](javascript:alert(1))' }])
    expect(inline('')).toEqual([])
    expect(inline('[**Sergeant**](https://example.com/x) rank')).toEqual([
      { k: 'a', t: 'Sergeant', href: 'https://example.com/x', segs: [{ k: 'b', t: 'Sergeant' }] },
      { k: '', t: ' rank' },
    ])
    expect(inline('[x](http://example.com/y)')).toEqual([{ k: '', t: '[x](http://example.com/y)' }])
  })

  it('takes a link to a page of the area, and nothing else that is not https', () => {
    expect(inline('[Requirements](/deathwatch/recruitment/requirements)')).toEqual([
      { k: 'a', t: 'Requirements', href: '/deathwatch/recruitment/requirements', segs: [{ k: '', t: 'Requirements' }] },
    ])
    for (const text of ['[x](/companies)', '[x](//evil.example)', '[x](/deathwatch/../x)', '[x](deathwatch/x)', '[x](/deathwatch/a b)']) {
      expect(inline(text).some((s) => s.k === 'a'), text).toBe(false)
    }
  })
})

describe('notables', () => {
  const n = notables(TX)

  it('reads the introductions as quotes, without their marks', () => {
    expect(n.intro).toEqual([[{ k: '', t: 'Within the walls the names of its warriors are remembered.' }]])
    expect(n.chronicles.intro).toEqual([[{ k: '', t: 'The names of those who held command.' }]])
    expect(n.veterans.intro).toEqual([[{ k: '', t: 'Before the fortress stood, these warriors forged it.' }]])
  })

  it('reads the Watch Commander: the line above, the name, and each paragraph', () => {
    expect(n.commander).toEqual({
      kicker: 'Watch Commander of Ebonhold · Sworn in spring',
      name: 'Watch Commander Varn',
      lines: [
        [{ k: 'b', t: 'Known for:' }, { k: '', t: ' the ' }, { k: 'b', t: 'Long Vigil' }, { k: '', t: '.' }],
        [{ k: '', t: 'Keeps the ' }, { k: 's', t: 'watch' }, { k: '', t: '.' }],
      ],
    })
  })

  it('reads the Chronicles of Command as groups of one line per commander', () => {
    expect(n.chronicles.groups.map((g) => [g.h, g.items.length])).toEqual([
      ['Watch Commanders', 2],
      ['Watch Captains', 1],
    ])
    expect(n.chronicles.groups[0].items[1]).toEqual([
      { k: 'b', t: 'Watch Commander Ilo:' },
      { k: '', t: ' ' },
      { k: 's', t: 'Records lost' },
      { k: '', t: ' — ' },
      { k: 'a', t: 'March 1st', href: 'https://example.com/a', segs: [{ k: '', t: 'March 1st' }] },
    ])
    expect(notables({ nm_h: '- **A:** one\n## Empty\n## B\n- two' }).chronicles.groups.map((g) => g.h)).toEqual(['', 'B'])
  })

  it('reads one Honored Veteran per block, with the badge every card carries, and keeps a sealed record out', () => {
    expect(n.veterans.badge).toBe('Former Watch Command')
    expect(n.veterans.list).toEqual([
      { name: 'Sergeant Ilo', epithet: 'The Steady Hand', text: [{ k: '', t: 'Led from the front.' }], sealed: false },
      { name: 'Brother Quell', epithet: '///Classified///', text: [], sealed: true },
      { name: 'Brother Oren', epithet: '', text: [{ k: '', t: 'No epithet here.' }], sealed: false },
    ])
    expect(JSON.stringify(n)).not.toContain('stays sealed')
  })

  it('reads the closing: a quote, then battle cries', () => {
    expect(n.closing).toEqual([
      { kind: 'quote', t: 'Not every warrior is worthy.' },
      { kind: 'cry', t: 'ONLY THE ELITE.' },
      { kind: 'cry', t: 'SUFFER NOT THE ALIEN TO LIVE!' },
    ])
    expect(notables({ nm_e: 'plain *words*' }).closing).toEqual([{ kind: 'p', segs: [{ k: '', t: 'plain ' }, { k: 'i', t: 'words' }] }])
  })

  it('names nobody, with the default labels, when the texts are missing or not text', () => {
    for (const tx of [undefined, null, {}, 'nm_c', { nm_c: 42, nm_v: ['x'], nm_h: {}, nm_ck: {}, nm_vk: null }, { nm_c: '\n\nlater', nm_v: '\n\n \n', nm_h: '## Only a heading' }]) {
      const e = notables(tx)
      expect(anyone(e), JSON.stringify(tx)).toBe(false)
      expect(e.commander).toBeNull()
      expect(e.veterans.badge).toBe('Honored Veteran')
    }
    expect(anyone(notables({ nm_c: 'A' }))).toBe(true)
    expect(anyone(notables({ nm_v: 'A' }))).toBe(true)
    expect(anyone(notables({ nm_h: '- A' }))).toBe(true)
    expect(notables({ nm_c: 'A' }).commander.kicker).toBe('Watch Commander')
  })
})

// Two marks on one line are two marks, not one with the text between them marked (the Watch Commander writes these).
describe('two marks on one line', () => {
  it('reads each mark, and only a mark from end to end counts as whole', () => {
    expect(inline('**A** and **B**')).toEqual([{ k: 'b', t: 'A' }, { k: '', t: ' and ' }, { k: 'b', t: 'B' }])
    expect(whole('**A** and **B**', 'b')).toBe(false)
    expect(whole('*a* and *b*', 'i')).toBe(false)
    expect(whole('**ALL OF IT**', 'b')).toBe(true)
    expect(whole('*all of it*', 'i')).toBe(true)
  })

  it('keeps a closing line with two marks a paragraph, and an introduction with two marks unquoted', () => {
    const n = notables({ nm_c: 'A', nm_e: '**A** and **B**\n\n*a* and *b*', nm_i: '*a* and *b*' })
    expect(n.closing.map((c) => c.kind)).toEqual(['p', 'p'])
    expect(n.closing[0].segs).toEqual([{ k: 'b', t: 'A' }, { k: '', t: ' and ' }, { k: 'b', t: 'B' }])
    expect(n.intro[0]).toEqual([{ k: 'i', t: 'a' }, { k: '', t: ' and ' }, { k: 'i', t: 'b' }])
  })
})

// A text may be up to 1 MB: a long run of one character must not cost more than its length.
describe('long runs', () => {
  it('reads 40,000 of "[", "*" or "||" quickly', () => {
    for (const s of ['['.repeat(40000), '*'.repeat(40000), '||'.repeat(20000), '[x](https://'.repeat(4000)]) {
      const t0 = performance.now()
      inline(s)
      expect(performance.now() - t0, s.slice(0, 12)).toBeLessThan(250)
    }
  })

  it('keeps a mark on its line and bounded in length', () => {
    expect(inline('**a\nb**').some((x) => x.k === 'b')).toBe(false)
    expect(inline('*' + 'x'.repeat(401) + '*').some((x) => x.k === 'i')).toBe(false)
  })
})
