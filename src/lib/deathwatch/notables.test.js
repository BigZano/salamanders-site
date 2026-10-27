import { describe, it, expect } from 'vitest'
import { anyone, inline, notables } from './notables'

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
  it('splits bold, italic, spoiler and link marks into segments, a link keeping only its text', () => {
    expect(inline('a **b** *c* ||d|| [e](https://example.com/x) f')).toEqual([
      { k: '', t: 'a ' },
      { k: 'b', t: 'b' },
      { k: '', t: ' ' },
      { k: 'i', t: 'c' },
      { k: '', t: ' ' },
      { k: 's', t: 'd' },
      { k: '', t: ' ' },
      { k: '', t: 'e' },
      { k: '', t: ' f' },
    ])
  })

  it('drops the marks inside a spoiler, and leaves a link that is not https as it is', () => {
    expect(inline('||*lost*||')).toEqual([{ k: 's', t: 'lost' }])
    expect(inline('[x](javascript:alert(1))')).toEqual([{ k: '', t: '[x](javascript:alert(1))' }])
    expect(inline('')).toEqual([])
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
      { k: '', t: 'March 1st' },
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
