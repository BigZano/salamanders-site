import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parse, walk } from './markdown'
import { dropDeadLines, tocOnly, liveRefs } from './prune'

// Synthetic classifier: hrefs containing "live" are live, "ext" is external
// (also live), anything else is dead (renders as plain text).
const classify = (href) => (/live/.test(href) ? 'route' : /ext/.test(href) ? 'external' : 'text')
const L = (n) => `[L${n}](https://discord.com/live${n})`
const D = (n) => `[D${n}](https://discord.com/dead${n})`
const E = '<:e:123456789012345678>'
const types = (nodes) => nodes.map((n) => n.type)
const texts = (nodes) => {
  const out = []
  walk(nodes, (n) => n.type === 'text' && out.push(n.value))
  return out.join('')
}

describe('dropDeadLines', () => {
  it('drops a line that is only a dead link (with emoji/punctuation/formatting around it)', () => {
    expect(dropDeadLines(parse(`a\n${D(1)}\n-# ${E} **${D(2)}** — ${E}\nb`), classify).map((n) => texts([n]))).toEqual(['a', 'b'])
  })
  it('keeps a sentence that mentions a dead link; the link stays for plain-text rendering', () => {
    const out = dropDeadLines(parse(`Submit proof in ${D(1)} please`), classify)
    expect(out).toHaveLength(1)
    expect(texts(out)).toBe('Submit proof in D1 please')
  })
  it('keeps any line that also has a live link', () => {
    expect(dropDeadLines(parse(`${D(1)} ${L(1)}`), classify)).toHaveLength(1)
  })
  it('channel mentions count as links; user/role mentions count as content', () => {
    const dead = '<#555555555555555555>'
    expect(dropDeadLines(parse(dead), classify)).toEqual([])
    expect(dropDeadLines(parse(`${dead} <@&123456789012345678>`), classify)).toHaveLength(1)
  })
  it('lines without links are untouched, including blanks and code blocks', () => {
    const src = 'x\n\n```\nq\n```\n# H'
    expect(dropDeadLines(parse(src), classify)).toEqual(parse(src))
  })
  it('inside quotes and lists: drops dead items/lines, removes containers left empty', () => {
    const out = dropDeadLines(parse(`> ${D(1)}\n> keep\n- ${D(2)}\n- ok\n> ${D(3)}\n\n- ${D(4)}`), classify)
    expect(types(out)).toEqual(['quote', 'list', 'blank'])
    expect(texts(out[0].children)).toBe('keep')
    expect(out[1].items).toHaveLength(1)
  })
  it('a dead list item keeps live sub-items under it', () => {
    const [list] = dropDeadLines(parse(`- ${D(1)}\n  - ${L(1)}`), classify)
    expect(list.items).toHaveLength(1)
    expect(types(list.items[0].children)).toEqual(['list'])
    expect(liveRefs([list], classify)).toEqual(['https://discord.com/live1'])
  })
  it('a heading that is only a dead link goes too', () => {
    expect(dropDeadLines(parse(`## ${E} ${D(1)} ${E}`), classify)).toEqual([])
  })
  it('bare URLs are links too: a dead one alone on a line goes, a live one stays', () => {
    expect(dropDeadLines(parse('https://discord.com/dead9'), classify)).toEqual([])
    expect(liveRefs(parse('see https://discord.com/live9'), classify)).toEqual(['https://discord.com/live9'])
  })
  it('a user mention next to a dead link is content', () => {
    expect(dropDeadLines(parse(`<#555555555555555555> <@123456789012345678>`), classify)).toHaveLength(1)
  })
  it('an emoji-only live link keeps its line even beside a dead link', () => {
    expect(dropDeadLines(parse(`${D(1)} [${E}](https://discord.com/live)`), classify)).toHaveLength(1)
  })
  it('emoji-only lines without any link are kept (nothing dead to remove)', () => {
    expect(dropDeadLines(parse(`${E} ${E}`), classify)).toHaveLength(1)
  })
  it('a quote left holding only blank lines is removed', () => {
    expect(dropDeadLines(parse(`> ${D(1)}\n>`), classify)).toEqual([])
  })
  it('code and inline code are content', () => {
    expect(dropDeadLines(parse(`${D(1)} \`x\``), classify)).toHaveLength(1)
  })
  it('a dead link whose label is itself content-less still counts as dead', () => {
    expect(dropDeadLines(parse(`[${E}](https://discord.com/dead)`), classify)).toEqual([])
  })
})

describe('tocOnly', () => {
  it('keeps live-link lines as authored and the headings above them; drops everything else', () => {
    const src = [
      `# ${E} **All Accolades** ${E}`,
      `## [**Group A**](https://discord.com/live1)`,
      '> * **Some Accolade**',
      '>   * description',
      `## ${E} **Company-Specific** ${E}`,
      `* ${E} ${L(2)}`,
      `* ${L(3)} `,
      '# Unused heading',
      'plain text',
      '',
      `-# ${D(9)}`,
    ].join('\n')
    const out = tocOnly(parse(src), classify)
    expect(types(out)).toEqual(['heading', 'heading', 'heading', 'list'])
    expect(texts([out[0]])).toContain('All Accolades')
    expect(texts([out[2]])).toContain('Company-Specific')
    expect(out[3].items).toHaveLength(2)
    expect(out[3].items[0].children[0].children.some((n) => n.type === 'emoji')).toBe(true)
  })
  it('a deeper heading is dropped when a same-or-higher heading replaces it before any link', () => {
    const out = tocOnly(parse(`# A\n## B\n## C\n${L(1)}`), classify)
    expect(out.map((n) => texts([n]))).toEqual(['A', 'C', 'L1'])
  })
  it('headings are emitted once, not repeated for each link under them', () => {
    const out = tocOnly(parse(`# A\n${L(1)}\n${L(2)}`), classify)
    expect(types(out)).toEqual(['heading', 'line', 'line'])
  })
  it('a live heading still pulls in the higher pending heading above it', () => {
    const out = tocOnly(parse(`# Top\n## Mid\n## [x](https://discord.com/live)`), classify)
    expect(out.map((n) => texts([n]))).toEqual(['Top', 'x'])
  })
  it('list labels survive only when they have live links under them', () => {
    const [list] = tocOnly(parse(`* Label\n  * ${L(1)}\n  * text\n* Other\n  * text`), classify)
    expect(list.items).toHaveLength(1)
    expect(texts([list.items[0].children[0]])).toBe('Label')
    expect(list.items[0].children[1].items).toHaveLength(1)
  })
  it('quotes are kept only for their live content, with headings inside them', () => {
    const [q, ...rest] = tocOnly(parse(`> ### Sub\n> desc\n> ${L(1)}\n> other`), classify)
    expect(rest).toEqual([])
    expect(types(q.children)).toEqual(['heading', 'line'])
  })
  it('a quote holding nothing live disappears', () => {
    expect(tocOnly(parse(`> ### Sub\n> desc`), classify)).toEqual([])
  })
  it('external links count as live', () => {
    expect(tocOnly(parse('[w](https://ext.example/w)'), classify)).toHaveLength(1)
  })
  it('code blocks and blanks are dropped', () => {
    expect(tocOnly(parse('```\nx\n```\n\n'), classify)).toEqual([])
  })
})

describe('properties', () => {
  const tok = fc.constantFrom(L(1), L(2), D(1), D(2), '[w](https://ext.io/a)', '<#555555555555555555>', E, 'word', ' ', '\n', '> ', '# ', '## ', '-# ', '- ', '  - ', '* ', '**', '||', '1. ', '')
  const docs = fc.array(tok, { maxLength: 50 }).map((p) => parse(p.join('')))
  it('pruning never loses, duplicates, or reorders a live link', () => {
    fc.assert(fc.property(docs, (ast) => {
      const want = liveRefs(ast, classify)
      expect(liveRefs(dropDeadLines(ast, classify), classify)).toEqual(want)
      expect(liveRefs(tocOnly(ast, classify), classify)).toEqual(want)
    }), { numRuns: 3000 })
  })
  it('pruning is pure: the input AST is not mutated', () => {
    fc.assert(fc.property(docs, (ast) => {
      const before = JSON.stringify(ast)
      dropDeadLines(ast, classify)
      tocOnly(ast, classify)
      expect(JSON.stringify(ast)).toBe(before)
    }), { numRuns: 500 })
  })
  it('after tocOnly, every line-level block holds a live link (headings and labels excepted)', () => {
    fc.assert(fc.property(docs, (ast) => {
      const check = (blocks) => {
        for (const b of blocks) {
          if (b.type === 'quote') check(b.children)
          else if (b.type === 'list') for (const it of b.items) {
            const [own, ...subs] = it.children
            if (!subs.length) expect(liveRefs([own], classify).length).toBeGreaterThan(0)
            check(subs)
          } else if (b.type !== 'heading') expect(liveRefs([b], classify).length).toBeGreaterThan(0)
        }
      }
      check(tocOnly(ast, classify))
    }), { numRuns: 2000 })
  })
})
