import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parse, parseInline, plainText, walk } from './markdown'

const alnum = (s) => s.replace(/[^\p{L}\p{N}]/gu, '')
const E = '123456789012345678'

describe('blocks', () => {
  it('headings 1-3, bold inside', () => {
    expect(parse('# **A**\n## B\n### C')).toEqual([
      { type: 'heading', level: 1, children: [{ type: 'strong', children: [{ type: 'text', value: 'A' }] }] },
      { type: 'heading', level: 2, children: [{ type: 'text', value: 'B' }] },
      { type: 'heading', level: 3, children: [{ type: 'text', value: 'C' }] },
    ])
  })
  it.each(['#### four', '#nospace', '# ', 'a # mid-line', 'a -# mid-line'])('%j is a plain line, not a heading or subtext', (s) => {
    expect(['heading', 'subtext']).not.toContain(parse(s)[0].type)
  })
  it('-# subtext', () => {
    expect(parse('-# small')).toEqual([{ type: 'subtext', children: [{ type: 'text', value: 'small' }] }])
  })
  // Deliberately kinder than Discord, which shows these literally: stray leading whitespace
  // (often from a quote written as ">  ") shouldn't turn an author's heading into "## text".
  it.each([[' ## b', 'heading'], ['\t# b', 'heading'], ['   ### b', 'heading'], [' -# b', 'subtext'], ['\t-# b', 'subtext']])('%j with leading whitespace is still a %s', (s, type) => {
    expect(parse(s)).toEqual([{ type, ...(type === 'heading' ? { level: s.trim().indexOf(' ') } : {}), children: [{ type: 'text', value: 'b' }] }])
  })
  it('a quote line with extra spaces after ">" keeps its subtext', () => {
    expect(parse('>   -# small')[0].children).toEqual([{ type: 'subtext', children: [{ type: 'text', value: 'small' }] }])
  })
  it('a list item can be subtext or a heading, and nests like any other item', () => {
    const [list] = parse('- -# small\n- ## big\n- plain\n  * -# deeper')
    expect(list.items.map((it) => it.children[0])).toEqual([
      { type: 'subtext', children: [{ type: 'text', value: 'small' }] },
      { type: 'heading', level: 2, children: [{ type: 'text', value: 'big' }] },
      { type: 'line', children: [{ type: 'text', value: 'plain' }] },
    ])
    expect(list.items[2].children[1].items[0].children[0]).toEqual({ type: 'subtext', children: [{ type: 'text', value: 'deeper' }] })
  })
  it('a trailing U+2028 (pasted from Discord) does not stop a heading, subtext or list item', () => {
    expect(parse('## b\u2028')[0]).toEqual({ type: 'heading', level: 2, children: [{ type: 'text', value: 'b\u2028' }] })
    expect(parse('-# b\u2028')[0].type).toBe('subtext')
    expect(parse('- b\u2028')[0]).toMatchObject({ type: 'list', items: [{ children: [{ type: 'line' }] }] })
  })
  it('a list item that only looks like one ("-#x", "#x") stays a line', () => {
    const [list] = parse('- -#x\n- #x')
    expect(list.items.map((it) => it.children[0].type)).toEqual(['line', 'line'])
  })
  it('> quotes group consecutive lines and may contain headings and nested lists', () => {
    const [q] = parse('> ### H\n> * a\n>   * b\n>\n> tail')
    expect(q.type).toBe('quote')
    expect(q.children.map((n) => n.type)).toEqual(['heading', 'list', 'blank', 'line'])
    expect(q.children[1].items[0].children[1]).toMatchObject({ type: 'list', items: [{ marker: '*' }] })
  })
  it('>>> quotes the rest of the message', () => {
    const [q] = parse('>>> a\nb\nc')
    expect(q.type).toBe('quote')
    expect(plainText(q.children)).toBe('a\nb\nc\n')
  })
  it('quotes do not nest (Discord renders an inner > literally)', () => {
    const [q] = parse('> > x')
    expect(plainText(q.children)).toBe('> x\n')
  })
  it('lists: -, *, ordered with marker kept, nesting by indent, dedent returns to parent', () => {
    const [l] = parse('- a\n  - b\n    - c\n- d')
    expect(l.ordered).toBe(false)
    expect(l.items.map((i) => plainText(i.children.slice(0, 1)))).toEqual(['a\n', 'd\n'])
    expect(l.items[0].children[1].items[0].children[1].items[0].marker).toBe('-')
    const [o] = parse('1. x\n2. y')
    expect(o).toMatchObject({ ordered: true, items: [{ marker: '1.' }, { marker: '2.' }] })
  })
  it('extra spaces after a list marker are not content', () => {
    const [l] = parse('*  **x**')
    expect(l.items[0].children[0].children[0]).toMatchObject({ type: 'strong' })
  })
  it('a list that starts deeper than a later item splits into sibling lists', () => {
    expect(parse('  - a\n- b').map((n) => n.type)).toEqual(['list', 'list'])
  })
  it('blank lines are preserved, CRLF normalised', () => {
    expect(parse('a\r\n\r\nb').map((n) => n.type)).toEqual(['line', 'blank', 'line'])
  })
  it('fenced code block with language', () => {
    expect(parse('```js\nconst a = 1 **no**\n```')).toEqual([{ type: 'codeblock', lang: 'js', text: 'const a = 1 **no**' }])
  })
  it('unterminated fence is ordinary text', () => {
    expect(parse('```js\nx').map((n) => n.type)).toEqual(['line', 'line'])
  })
  it('throws a clear TypeError on non-string input', () => {
    expect(() => parse(null)).toThrow(new TypeError('markdown source must be a string'))
    expect(() => parse(42)).toThrow(new TypeError('markdown source must be a string'))
  })
  it('a lone CR is a line break too', () => {
    expect(parse('a\rb').map((n) => n.type)).toEqual(['line', 'line'])
  })
  it('bare ``` fences: search starts after the opener; multi-line text joined with newlines', () => {
    expect(parse('```\na\nb\n```')).toEqual([{ type: 'codeblock', lang: '', text: 'a\nb' }])
  })
  it('fence closer is searched after the opener, not from the end', () => {
    expect(parse('```\na\n```\nafter').map((n) => n.type)).toEqual(['codeblock', 'line'])
  })
  it('a quote may start with a bare > line', () => {
    const [q, ...rest] = parse('>\n> a')
    expect(rest).toEqual([])
    expect(q.children.map((n) => n.type)).toEqual(['blank', 'line'])
  })
  it('whitespace-only lines are blank', () => {
    expect(parse('a\n   \nb').map((n) => n.type)).toEqual(['line', 'blank', 'line'])
  })
  it('>>> contents never become a nested quote', () => {
    const [q] = parse('>>> a\n> b')
    expect(q.children.map((n) => n.type)).toEqual(['line', 'line'])
    expect(plainText(q.children)).toBe('a\n> b\n')
  })
  it('a tab of indent counts as two spaces for list nesting', () => {
    const [l] = parse('- a\n\t- b')
    expect(l.items).toHaveLength(1)
    expect(l.items[0].children[1]).toMatchObject({ type: 'list', items: [{ marker: '-' }] })
  })
  it('list nesting is capped at 16 levels below the top list; deeper items become siblings', () => {
    const src = Array.from({ length: 20 }, (_, i) => ' '.repeat(i) + '- x' + i).join('\n')
    let depth = 0
    let list = parse(src)[0]
    while (list) {
      depth++
      const last = list.items[list.items.length - 1]
      list = last.children.find((c) => c.type === 'list')
    }
    expect(depth).toBe(17)
  })
})

describe('inline', () => {
  const one = (s) => parseInline(s)
  it.each([
    ['**b**', 'strong'], ['*i*', 'em'], ['_i_', 'em'], ['__u__', 'underline'], ['~~s~~', 'strike'], ['||sp||', 'spoiler'],
  ])('%s → %s', (s, type) => expect(one(s)).toEqual([{ type, children: [{ type: 'text', value: s.replace(/[*_~|]/g, '') }] }]))
  it('***x*** is strong(em)', () => {
    expect(one('***x***')).toEqual([{ type: 'strong', children: [{ type: 'em', children: [{ type: 'text', value: 'x' }] }] }])
  })
  it('snake_case_words are not italic', () => {
    expect(one('snake_case_word')).toEqual([{ type: 'text', value: 'snake_case_word' }])
  })
  it('a lone * with a space after it is literal', () => {
    expect(one('a * b * c')).toEqual([{ type: 'text', value: 'a * b * c' }])
  })
  it('unclosed delimiters are literal text', () => {
    expect(plainText(one('**a __b ||c ~~d `e'))).toBe('**a __b ||c ~~d `e')
  })
  it('empty pairs stay literal', () => {
    expect(plainText(one('****'))).toBe('****')
    expect(one('````')).toEqual([{ type: 'text', value: '````' }])
    expect(one('******')).toEqual([{ type: 'text', value: '******' }])
  })
  it('several spans of the same kind on one line all format', () => {
    expect(one('**a** and **b**').map((n) => n.type)).toEqual(['strong', 'text', 'strong'])
    expect(one('||a|| ||b||').map((n) => n.type)).toEqual(['spoiler', 'text', 'spoiler'])
  })
  it('* italics work inside words; _ italics do not', () => {
    expect(one('x*a*y').map((n) => n.type)).toEqual(['text', 'em', 'text'])
    expect(one('x_a_ y')).toEqual([{ type: 'text', value: 'x_a_ y' }])
    expect(one('a _b_c')).toEqual([{ type: 'text', value: 'a _b_c' }])
    expect(one('(_a_)').map((n) => n.type)).toEqual(['text', 'em', 'text'])
  })
  it('an unpaired ** does not become empty emphasis', () => {
    expect(one('**a*')).toEqual([{ type: 'text', value: '*' }, { type: 'em', children: [{ type: 'text', value: 'a' }] }])
  })
  it('emphasis needs non-space just inside both markers', () => {
    expect(one('* a*')).toEqual([{ type: 'text', value: '* a*' }])
    expect(one('*a *')).toEqual([{ type: 'text', value: '*a *' }])
    expect(one('_a _')).toEqual([{ type: 'text', value: '_a _' }])
    expect(one('a*')).toEqual([{ type: 'text', value: 'a*' }])
  })
  it('a trailing backslash is literal', () => {
    expect(one('a\\')).toEqual([{ type: 'text', value: 'a\\' }])
  })
  it('backslash escapes', () => {
    expect(one('\\*not\\*')).toEqual([{ type: 'text', value: '*not*' }])
  })
  it('inline code is verbatim', () => {
    expect(one('`**x**`')).toEqual([{ type: 'code', text: '**x**' }])
    expect(one('``a`b``')).toEqual([{ type: 'code', text: 'a`b' }])
  })
  it('masked links, with angle-bracketed and bold text', () => {
    expect(one('[**T**](<https://discord.com/channels/1/2>)')).toEqual([
      { type: 'link', href: 'https://discord.com/channels/1/2', children: [{ type: 'strong', children: [{ type: 'text', value: 'T' }] }] },
    ])
  })
  it('bare and suppressed urls; trailing punctuation excluded', () => {
    expect(one('see https://x.io/a. and <https://y.io/b>')).toEqual([
      { type: 'text', value: 'see ' }, { type: 'url', href: 'https://x.io/a' }, { type: 'text', value: '. and ' },
      { type: 'url', href: 'https://y.io/b' },
    ])
  })
  it('custom emoji, animated emoji, mentions', () => {
    expect(one(`<:Leg_1:${E}><a:Fire:${E}><@${E}><@!${E}><@&${E}><#${E}>`)).toEqual([
      { type: 'emoji', name: 'Leg_1', id: E, animated: false, raw: `<:Leg_1:${E}>` },
      { type: 'emoji', name: 'Fire', id: E, animated: true, raw: `<a:Fire:${E}>` },
      { type: 'mention', kind: 'user', id: E, raw: `<@${E}>` },
      { type: 'mention', kind: 'user', id: E, raw: `<@!${E}>` },
      { type: 'mention', kind: 'role', id: E, raw: `<@&${E}>` },
      { type: 'mention', kind: 'channel', id: E, raw: `<#${E}>` },
    ])
  })
  it('an unresolved :shortcode: stays literal', () => {
    expect(one(':FixtureShortcode:')).toEqual([{ type: 'text', value: ':FixtureShortcode:' }])
  })
  it('javascript: and data: are never links', () => {
    const nodes = one('[x](javascript:alert(1)) <javascript:alert(1)> data:text/html,hi')
    const hrefs = []
    walk(nodes, (n) => n.href && hrefs.push(n.href))
    expect(hrefs).toEqual([])
  })
})

describe('fidelity properties', () => {
  it('parse never drops or invents a letter or digit (raw plain text) — arbitrary strings', () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
      expect(alnum(plainText(parse(s), { raw: true }))).toBe(alnum(s))
    }), { numRuns: 2000 })
  })
  it('same property over markdown-shaped strings', () => {
    const tok = fc.constantFrom('**', '*', '_', '__', '~~', '||', '`', '```', '\n', '> ', '>>> ', '# ', '## ', '-# ', '- ', '* ',
      '  ', '1. ', '[', '](', ')', '<', '>', '\\', `<:e:${E}>`, `<a:e:${E}>`, `<@&${E}>`, `<#${E}>`, 'https://a.io/x', 'word', '9', 'é')
    fc.assert(fc.property(fc.array(tok, { maxLength: 60 }), (parts) => {
      const s = parts.join('')
      expect(alnum(plainText(parse(s), { raw: true }))).toBe(alnum(s))
    }), { numRuns: 3000 })
  })
})

describe('hostile input', () => {
  it.each([
    ['1 MB of unclosed spoilers', '||a'.repeat(350_000)],
    ['1 MB of asterisks', '*'.repeat(1_000_000)],
    ['1 MB of open brackets', '[a'.repeat(500_000)],
    ['deep nesting', '**__~~||'.repeat(5_000) + 'x' + '||~~__**'.repeat(5_000)],
    ['2k nested list levels', Array.from({ length: 2_000 }, (_, i) => ' '.repeat(i) + '- x').join('\n')],
    ['zero-width and RTL', '\u200b**\u202ex\u200d**'],
  ])('%s parses in < 2s without throwing', (_, s) => {
    // Uninstrumented these take ~250ms max; Stryker's instrumentation is ~10x
    // slower, and its own per-mutant timeout catches runaway mutants anyway.
    const budget = globalThis.__stryker__ ? 20_000 : 2000
    const t = performance.now()
    expect(() => parse(s)).not.toThrow()
    expect(performance.now() - t).toBeLessThan(budget)
  })
})

describe('plainText', () => {
  it('display form: emoji as :name:, mentions empty, link text only', () => {
    expect(plainText(parseInline(`[t](https://a.io) <:x:${E}> <@&${E}>`))).toBe('t :x: ')
  })
})

describe('plainText raw/display forms per block', () => {
  it('codeblock: raw keeps the language, display does not', () => {
    const nodes = parse('```js\nx = 1\n```')
    expect(plainText(nodes, { raw: true })).toBe('jsx = 1\n')
    expect(plainText(nodes)).toBe('x = 1\n')
  })
  it('masked link: raw appends the href, display is label only', () => {
    const nodes = parseInline('[go](https://a.io/p)')
    expect(plainText(nodes, { raw: true })).toBe('gohttps://a.io/p')
    expect(plainText(nodes)).toBe('go')
  })
  it('ordered list: raw keeps markers, display does not', () => {
    const nodes = parse('1. a\n2. b')
    expect(plainText(nodes, { raw: true })).toBe('1.a\n2.b\n')
    expect(plainText(nodes)).toBe('a\nb\n')
  })
  it('mention: raw token vs empty display; emoji: raw token vs :name:', () => {
    const nodes = parseInline(`<@&${E}><:x:${E}>`)
    expect(plainText(nodes, { raw: true })).toBe(`<@&${E}><:x:${E}>`)
    expect(plainText(nodes)).toBe(':x:')
  })
})

describe('walk', () => {
  it('visits every node, including inside quotes, list items, and inline children, in document order', () => {
    const seen = []
    walk(parse('> # **a**\n- [b](https://x.io)\n  - <#' + E + '>'), (n) => seen.push(n.type))
    expect(seen).toEqual(['quote', 'heading', 'strong', 'text', 'list', 'line', 'link', 'text', 'list', 'line', 'mention'])
  })
})

describe('inline nesting is structurally bounded', () => {
  const depth = (nodes) => Math.max(0, ...nodes.map((n) => (n.children ? 1 + depth(n.children) : 0)))
  it('no input nests inline formatting deeper than 8 (each delimiter kind appears once per chain)', () => {
    const tok = fc.constantFrom('**', '*', '_', '__', '~~', '||', '***', '[', '](https://a.io)', ' ', 'a')
    fc.assert(fc.property(fc.array(tok, { maxLength: 80 }), (parts) => {
      expect(depth(parseInline(parts.join('')))).toBeLessThanOrEqual(8)
    }), { numRuns: 3000 })
  })
  it('the deepest real chain nests every kind once', () => {
    const nodes = parseInline('||**__~~_*[x](https://a.io)*_~~__**||')
    expect(depth(nodes)).toBe(7)
  })
})

describe('plainText line endings', () => {
  it('headings, subtext and blank lines each end with a newline in display form', () => {
    expect(plainText(parse('# a\n-# b\n\nc'))).toBe('a\nb\n\nc\n')
  })
})
