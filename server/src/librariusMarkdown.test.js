import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parse, parseInline, plainText, walk } from './librariusMarkdown.js'

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
    // vitest's own 5 s default would otherwise cut the instrumented run short of the 20 s budget above.
  }, 30_000)
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

// ---------------------------------------------------------------------------------------------------------------------
// One parser for the site and the server: dialects, the extended markdown, and spoilers that run over lines.
// ---------------------------------------------------------------------------------------------------------------------
const t = (value) => ({ type: 'text', value })
const line = (...children) => ({ type: 'line', children })
const BR = { type: 'br' }
const EXT = { dialect: 'extended' }
const cell = (s) => [t(s)]
const typesOf = (nodes) => nodes.map((n) => n.type)
const nodeTypes = (nodes) => {
  const seen = []
  walk(nodes, (n) => seen.push(n.type))
  return seen
}
// A table of `cols` columns and `rows` body rows, each cell one letter.
const grid = (cols, rows) =>
  [
    '|' + Array(cols).fill(' h ').join('|') + '|',
    '|' + Array(cols).fill('-').join('|') + '|',
    ...Array.from({ length: rows }, () => '|' + Array(cols).fill(' x ').join('|') + '|'),
  ].join('\n')
const EXTENDED_ONLY = ['table', 'divider', 'image', 'footnoteRef', 'footnotes']

describe('dialect option', () => {
  it('is discord by default', () => {
    expect(parse('#### four\n---', {})).toEqual(parse('#### four\n---', { dialect: 'discord' }))
    expect(parse('#### four\n---')).toEqual([line(t('#### four')), line(t('---'))])
  })
  it.each(['Discord', 'EXTENDED', 'extended ', '', null, 7, {}, ['extended']])('%j is no dialect: a RangeError', (dialect) => {
    expect(() => parse('x', { dialect })).toThrow(new RangeError('markdown dialect must be "discord" or "extended"'))
    expect(() => parseInline('x', { dialect })).toThrow(new RangeError('markdown dialect must be "discord" or "extended"'))
  })
  it('options that are no object are a TypeError, and so is a source that is no string, in either dialect', () => {
    expect(() => parse('x', null)).toThrow(TypeError)
    expect(() => parse(null, EXT)).toThrow(new TypeError('markdown source must be a string'))
    expect(() => parse(['a'], EXT)).toThrow(new TypeError('markdown source must be a string'))
  })
  it('extended agrees with discord on everything Discord has (no table, divider, image, footnote or 4-6 hashes)', () => {
    const tok = fc.constantFrom('**', '*', '_', '__', '~~', '||', '`', '```', '\n', '> ', '>>> ', '# ', '## ', '### ', '-# ', '- ', '* ',
      '  ', '1. ', '[', '](', ')', '<', '>', '\\', `<:e:${E}>`, `<@&${E}>`, `<#${E}>`, 'https://a.io/x', '[x](https://a.io)', 'word', '9', 'é')
    fc.assert(fc.property(fc.array(tok, { maxLength: 60 }), (parts) => {
      const s = parts.join('')
      expect(parse(s, EXT)).toEqual(parse(s))
    }), { numRuns: 3000 })
  })
  it('discord never makes a table, divider, image, footnote or a heading past level 3', () => {
    const tok = fc.constantFrom('| a | b |', '|-|-|', '---', '#### ', '###### ', '![a](upload:1)', '[^a]', '[^a]: x', '\n', '\n', ' ', 'x', '||')
    fc.assert(fc.property(fc.array(tok, { maxLength: 40 }), (parts) => {
      const nodes = parse(parts.join(''))
      expect(nodeTypes(nodes).filter((type) => EXTENDED_ONLY.includes(type))).toEqual([])
      const levels = []
      walk(nodes, (n) => n.type === 'heading' && levels.push(n.level))
      expect(Math.max(0, ...levels)).toBeLessThanOrEqual(3)
    }), { numRuns: 2000 })
  })
})

describe('extended: headings 4 to 6', () => {
  it.each([1, 2, 3, 4, 5, 6])('%i hashes make a heading of that level', (n) => {
    expect(parse(`${'#'.repeat(n)} title`, EXT)).toEqual([{ type: 'heading', level: n, children: [t('title')] }])
  })
  it.each(['####### seven', '####x', '#### ', '####', 'a #### b', '#####\tx'])('%j is an ordinary line', (s) => {
    expect(parse(s, EXT)).toEqual([line(t(s))])
  })
  it('leading white space, formatting, a list item and a quote all take them', () => {
    expect(parse('  ##### **b**', EXT)).toEqual([{ type: 'heading', level: 5, children: [{ type: 'strong', children: [t('b')] }] }])
    expect(parse('- #### in a list', EXT)[0].items[0].children[0]).toEqual({ type: 'heading', level: 4, children: [t('in a list')] })
    expect(parse('> ###### in a quote', EXT)[0].children).toEqual([{ type: 'heading', level: 6, children: [t('in a quote')] }])
  })
  it('discord still has only three', () => {
    expect(parse('#### four', { dialect: 'discord' })).toEqual([line(t('#### four'))])
  })
})

describe('extended: dividers', () => {
  it.each(['---', '-----------', '   ---', '---   ', '\t---\t'])('%j is a divider', (s) => {
    expect(parse(s, EXT)).toEqual([{ type: 'divider' }])
  })
  it.each(['--', '-- -', '---a', 'a---', '----a', '***', '___', '—-', '- - -', '--- ---', '---|'])('%j is not a divider', (s) => {
    expect(typesOf(parse(s, EXT))).not.toContain('divider')
  })
  it('sits between lines with no blank line, in a quote, and after a list; two in a row are two', () => {
    expect(parse('a\n---\nb', EXT)).toEqual([line(t('a')), { type: 'divider' }, line(t('b'))])
    expect(parse('> ---', EXT)).toEqual([{ type: 'quote', children: [{ type: 'divider' }] }])
    expect(typesOf(parse('- a\n---', EXT))).toEqual(['list', 'divider'])
    expect(parse('---\n---', EXT)).toEqual([{ type: 'divider' }, { type: 'divider' }])
  })
  it('in a code block it is code', () => {
    expect(parse('```\n---\n```', EXT)).toEqual([{ type: 'codeblock', lang: '', text: '---' }])
  })
  it('in discord it is a line', () => {
    expect(parse('---')).toEqual([line(t('---'))])
  })
})

describe('extended: tables', () => {
  it('a header, a rule and rows; the rule may align', () => {
    expect(parse('| a | b |\n| --- | :---: |\n| 1 | 2 |\n| 3 | 4 |', EXT)).toEqual([
      { type: 'table', head: [cell('a'), cell('b')], rows: [[cell('1'), cell('2')], [cell('3'), cell('4')]] },
    ])
  })
  it.each([[':--'], ['--:'], [':-:'], ['-'], ['------']])('%s is a rule cell', (rule) => {
    expect(parse(`| a |\n| ${rule} |`, EXT)).toEqual([{ type: 'table', head: [cell('a')], rows: [] }])
  })
  it.each([['--- -'], ['x'], ['::'], [':'], [''], ['- -'], ['---x'], ['x---'], ['\\-']])('%j is not a rule cell, so no table', (rule) => {
    expect(typesOf(parse(`| a |\n| ${rule} |`, EXT))).toEqual(['line', 'line'])
  })
  it('every cell of the rule row must be a rule, not just one', () => {
    expect(typesOf(parse('| a | b |\n| --- | x |', EXT))).toEqual(['line', 'line'])
    expect(typesOf(parse('| a | b |\n| x | --- |', EXT))).toEqual(['line', 'line'])
    expect(typesOf(parse('| a | b |\n| --- | --- |', EXT))).toEqual(['table'])
  })
  it('cells with characters outside the basic plane, and a backslash that escapes nothing', () => {
    expect(parse('| \u{1F600} | b\\c |\n|-|-|\n| \u{1F600}\u{1F600} | \\x |', EXT)).toEqual([
      { type: 'table', head: [cell('\u{1F600}'), cell('b\\c')], rows: [[cell('\u{1F600}\u{1F600}'), cell('\\x')]] },
    ])
  })
  it('needs no outer pipes', () => {
    expect(parse('a | b\n-|-\n1 | 2', EXT)).toEqual([{ type: 'table', head: [cell('a'), cell('b')], rows: [[cell('1'), cell('2')]] }])
    expect(parse('a |\n-|\n1 |', EXT)).toEqual([{ type: 'table', head: [cell('a')], rows: [[cell('1')]] }])
  })
  it('with the header and the rule alone, it has no rows', () => {
    expect(parse('| a | b |\n|-|-|', EXT)).toEqual([{ type: 'table', head: [cell('a'), cell('b')], rows: [] }])
  })
  it('a header with no rule under it, or one of another width, is two lines', () => {
    expect(typesOf(parse('| a | b |\n| x | y |', EXT))).toEqual(['line', 'line'])
    expect(typesOf(parse('| a | b |\n| - |\n| 1 | 2 |', EXT))).toEqual(['line', 'line', 'line'])
    expect(typesOf(parse('| a |', EXT))).toEqual(['line'])
    expect(typesOf(parse('a\n|-|', EXT))).toEqual(['line', 'line'])
  })
  it('a lone pipe, or a header of no cells, is no table', () => {
    expect(typesOf(parse('|\n|-|', EXT))).toEqual(['line', 'line'])
    expect(typesOf(parse('|\n|', EXT))).toEqual(['line', 'line'])
    expect(typesOf(parse('| a |\n|', EXT))).toEqual(['line', 'line'])
    expect(parse('||\n|-|', EXT)).toEqual([{ type: 'table', head: [[]], rows: [] }])
  })
  it('a short row is filled out with empty cells; a long one makes the whole table literal text', () => {
    expect(parse('| a | b |\n|-|-|\n| 1 |', EXT)).toEqual([{ type: 'table', head: [cell('a'), cell('b')], rows: [[cell('1'), []]] }])
    const nodes = parse('| a |\n|-|\n| 1 | 2 |', EXT)
    expect(typesOf(nodes)).toEqual(['line', 'line', 'line'])
    expect(plainText(nodes, { raw: true })).toBe('| a |\n|-|\n| 1 | 2 |\n')
  })
  it('the table ends at the first line with no pipe in it: a blank line, or any other', () => {
    expect(typesOf(parse('| a |\n|-|\n| 1 |\ntext\n| 2 |', EXT))).toEqual(['table', 'line', 'line'])
    expect(typesOf(parse('| a |\n|-|\n| 1 |\n\n| 2 |', EXT))).toEqual(['table', 'blank', 'line'])
    expect(typesOf(parse('before\n| a |\n|-|\n| 1 |\nafter', EXT))).toEqual(['line', 'table', 'line'])
  })
  it('cells are inline text; \\| is a pipe in a cell and \\\\ before a pipe is a backslash and a divider', () => {
    expect(parse('| **a** | `x` |\n|-|-|\n| [l](https://a.io) | <@' + E + '> |', EXT)).toEqual([
      {
        type: 'table',
        head: [[{ type: 'strong', children: [t('a')] }], [{ type: 'code', text: 'x' }]],
        rows: [[[{ type: 'link', href: 'https://a.io', children: [t('l')] }], [{ type: 'mention', kind: 'user', id: E, raw: `<@${E}>` }]]],
      },
    ])
    expect(parse('| a\\|b | c |\n|-|-|', EXT)[0].head).toEqual([cell('a|b'), cell('c')])
    expect(parse('| a\\\\| b |\n|-|-|', EXT)[0].head).toEqual([cell('a\\'), cell('b')])
  })
  it('white space round a row, or in front of it, is not a cell', () => {
    expect(parse('  | a |  \n\t|-| \n | 1 | \t', EXT)).toEqual([{ type: 'table', head: [cell('a')], rows: [[cell('1')]] }])
    expect(parse('a |  \n-| \n1 | ', EXT)).toEqual([{ type: 'table', head: [cell('a')], rows: [[cell('1')]] }])
  })
  it('empty cells are empty', () => {
    expect(parse('| | b |\n|-|-|\n| 1 | |', EXT)).toEqual([{ type: 'table', head: [[], cell('b')], rows: [[cell('1'), []]] }])
  })
  it('a heading or a list item is not a header, whatever follows it', () => {
    expect(typesOf(parse('# a | b\n|-|-|', EXT))).toEqual(['heading', 'line'])
    expect(typesOf(parse('- a | b\n|-|-|', EXT))).toEqual(['list', 'line'])
  })
  it('works inside a quote, and not in discord', () => {
    expect(parse('> | a |\n> |-|\n> | 1 |', EXT)).toEqual([{ type: 'quote', children: [{ type: 'table', head: [cell('a')], rows: [[cell('1')]] }] }])
    expect(typesOf(parse('| a |\n|-|\n| 1 |'))).toEqual(['line', 'line', 'line'])
  })
  it('10 columns and 50 rows are a table', () => {
    const [table, ...rest] = parse(grid(10, 50), EXT)
    expect(rest).toEqual([])
    expect(table.type).toBe('table')
    expect(table.head).toEqual(Array(10).fill(cell('h')))
    expect(table.rows).toHaveLength(50)
    expect(table.rows.every((row) => row.length === 10)).toBe(true)
  })
  it('11 columns, or 51 rows, leave the whole table as literal lines', () => {
    for (const src of [grid(11, 1), grid(10, 51), grid(11, 51)]) {
      const nodes = parse(src, EXT)
      expect(nodes).toHaveLength(src.split('\n').length)
      expect(new Set(typesOf(nodes))).toEqual(new Set(['line']))
      expect(plainText(nodes, { raw: true }).replace(/\s/g, '')).toBe(src.replace(/\s/g, ''))
    }
  })
  it('a table that is too much is literal to its last row, and no row of it starts a table of its own', () => {
    const crafted = parse(['| a |', ...Array(60).fill('| - |')].join('\n'), EXT)
    expect(crafted).toHaveLength(61)
    expect(new Set(typesOf(crafted))).toEqual(new Set(['line']))
    const wide = parse('| a |\n|-|\n| 1 |\n| 2 | 3 |\n| - |\n| 4 |', EXT)
    expect(typesOf(wide)).toEqual(Array(6).fill('line'))
    expect(typesOf(parse(`${grid(10, 51)}\n\n${grid(2, 1)}`, EXT).slice(-2))).toEqual(['blank', 'table'])
    expect(typesOf(parse('| a |\n|-|\n| 1 | 2 |\ntext', EXT))).toEqual(['line', 'line', 'line', 'line'])
  })
  it('a table of 10 columns still takes outer pipes and a cell on each side of them', () => {
    expect(parse(grid(10, 0), EXT)[0].head).toHaveLength(10)
    expect(parse('a|b|c|d|e|f|g|h|i|j\n-|-|-|-|-|-|-|-|-|-', EXT)[0].head).toHaveLength(10)
    expect(typesOf(parse('a|b|c|d|e|f|g|h|i|j|k\n-|-|-|-|-|-|-|-|-|-|-', EXT))).toEqual(['line', 'line'])
  })
  it('10,000 pipes: no table, and the line stays', () => {
    const src = '|'.repeat(10_000)
    expect(typesOf(parse(src, EXT))).toEqual(['line'])
    expect(plainText(parse(src, EXT), { raw: true })).toBe(src + '\n')
    const wide = parse(grid(10_000, 1), EXT)
    expect(new Set(typesOf(wide))).toEqual(new Set(['line']))
    expect(wide).toHaveLength(3)
  })
})

describe('extended: pictures', () => {
  it.each([1, 2, 9, 10])('![pic](upload:%i) is picture %i', (n) => {
    expect(parse(`![pic](upload:${n})`, EXT)).toEqual([line({ type: 'image', alt: 'pic', ref: n })])
  })
  it.each(['upload:0', 'upload:11', 'upload:1.5', 'upload:01', 'upload:-1', 'upload:+1', 'upload: 1', 'upload:1 ', 'upload:', 'upload:100',
    'upload:1e1', 'upload:0x1', 'UPLOAD:1', 'Upload:1', 'upload:\u0661', 'upload:1/', 'upload:1#', 'upload:1?x', 'upload::1', ' upload:1'])(
    '![x](%s) stays literal text',
    (ref) => {
      expect(parse(`![x](${ref})`, EXT)).toEqual([line(t(`![x](${ref})`))])
    },
  )
  it('an address of any other kind makes no picture: an https one stays the link Discord shows, the rest is text', () => {
    expect(parse('![x](https://a.io/p.png)', EXT)).toEqual([line(t('!'), { type: 'link', href: 'https://a.io/p.png', children: [t('x')] })])
    expect(parse('![x](http://a.io/p.png)', EXT)).toEqual([line(t('!'), { type: 'link', href: 'http://a.io/p.png', children: [t('x')] })])
    for (const src of ['![x](javascript:alert(1))', '![x](data:image/png;base64,AAAA)', '![x](//a.io/p.png)', '![x](/p.png)', '![x](file:///etc/passwd)', '![x](<upload:1>)', '![x](upload:1']) {
      expect(parse(src, EXT)).toEqual([line(t(src))])
    }
  })
  it('the words in the brackets are the alt text, as written', () => {
    expect(parse('![](upload:3)', EXT)).toEqual([line({ type: 'image', alt: '', ref: 3 })])
    expect(parse('![**a** <b> `c`](upload:3)', EXT)).toEqual([line({ type: 'image', alt: '**a** <b> `c`', ref: 3 })])
    expect(parse('![a[b](upload:3)', EXT)).toEqual([line(t('![a[b](upload:3)'))])
    expect(parse('![a]b](upload:3)', EXT)).toEqual([line(t('![a]b](upload:3)'))])
  })
  it('sits in the line of text, in formatting, a spoiler, a list, a heading and a table', () => {
    const pic = { type: 'image', alt: 'p', ref: 2 }
    expect(parse('a ![p](upload:2) b![p](upload:2)![p](upload:2)', EXT)).toEqual([line(t('a '), pic, t(' b'), pic, pic)])
    expect(parse('**![p](upload:2)**', EXT)).toEqual([line({ type: 'strong', children: [pic] })])
    expect(parse('||![p](upload:2)||', EXT)).toEqual([line({ type: 'spoiler', children: [pic] })])
    expect(parse('- ![p](upload:2)', EXT)[0].items[0].children).toEqual([line(pic)])
    expect(parse('# ![p](upload:2)', EXT)).toEqual([{ type: 'heading', level: 1, children: [pic] }])
    expect(parse('| ![p](upload:2) |\n|-|\n| ![p](upload:2) |', EXT)).toEqual([{ type: 'table', head: [[pic]], rows: [[[pic]]] }])
  })
  it('never spans a line, even to parseInline', () => {
    expect(parseInline('![a\nb](upload:1)', EXT)).toEqual([t('![a\nb](upload:1)')])
  })
  it('is only for extended; code and an escaped bracket stay text', () => {
    expect(parse('![p](upload:2)')).toEqual([line(t('![p](upload:2)'))])
    expect(parse('`![p](upload:2)`', EXT)).toEqual([line({ type: 'code', text: '![p](upload:2)' })])
    expect(parse('!\\[p](upload:2)', EXT)).toEqual([line(t('![p](upload:2)'))])
  })
  it('an empty-looking or hostile alt text never makes a link or a script', () => {
    const nodes = parse('![x](upload:1) ![](upload:2) ![x](javascript:alert(1)) <script>![](upload:3)</script>', EXT)
    const hrefs = []
    walk(nodes, (n) => n.href && hrefs.push(n.href))
    expect(hrefs).toEqual([])
  })
})

describe('extended: footnotes', () => {
  it('a reference, and the definition that comes after it', () => {
    expect(parse('Claim[^a].\n[^a]: Because.', EXT)).toEqual([
      line(t('Claim'), { type: 'footnoteRef', label: 'a' }, t('.')),
      { type: 'footnotes', items: [{ label: 'a', children: [line(t('Because.'))] }] },
    ])
  })
  it('a definition that comes first, in the middle, or last gives the same nodes, with the notes last', () => {
    const body = line(t('x'), { type: 'footnoteRef', label: 'a' })
    const notes = { type: 'footnotes', items: [{ label: 'a', children: [line(t('n'))] }] }
    expect(parse('[^a]: n\nx[^a]', EXT)).toEqual([body, notes])
    expect(parse('x[^a]\n[^a]: n\ny', EXT)).toEqual([body, line(t('y')), notes])
  })
  it('notes keep the order of their definitions; a reference may repeat; a note may go uncited', () => {
    const [first, second, notes, none] = parse('x[^b][^b]\n[^b]: 1\ny[^a]\n[^a]: 2\n[^c]: 3', EXT)
    expect(first.children.map((n) => n.type)).toEqual(['text', 'footnoteRef', 'footnoteRef'])
    expect(second.type).toBe('line')
    expect(none).toBeUndefined()
    expect(notes.items.map((i) => i.label)).toEqual(['b', 'a', 'c'])
  })
  it('a reference with no definition stays literal text, next to one that has one', () => {
    expect(parse('x[^b]', EXT)).toEqual([line(t('x[^b]'))])
    expect(parse('x[^b] [^a]\n[^a]: y', EXT)[0]).toEqual(line(t('x[^b] '), { type: 'footnoteRef', label: 'a' }))
  })
  it('a label is 1 to 20 word characters', () => {
    const word = 'a'.repeat(20)
    expect(parse(`r[^${word}]\n[^${word}]: n`, EXT)[0].children[1]).toEqual({ type: 'footnoteRef', label: word })
    expect(parse('r[^A_9]\n[^A_9]: n', EXT)[0].children[1]).toEqual({ type: 'footnoteRef', label: 'A_9' })
    const long = `${word}a`
    expect(parse(`r[^${long}]\n[^${long}]: n`, EXT).map((n) => n.type)).toEqual(['line', 'line'])
    for (const label of ['', 'a b', 'a-b', 'é', 'a.b', '^a', 'a]']) {
      expect(typesOf(parse(`r[^${label}]\n[^${label}]: n`, EXT))).not.toContain('footnotes')
    }
  })
  it('a definition needs its text, after a space or tab, and starts the line', () => {
    for (const src of ['[^a]:', '[^a]:x', '[^a]:   ', '[^a]: \t', ' [^a]: x', '\t[^a]: x', '[^a] : x', '[^a]- x', '[^a]']) {
      expect(typesOf(parse(`r[^a]\n${src}`, EXT))).not.toContain('footnotes')
    }
    expect(parse('r[^a]\n[^a]:\tx', EXT)[1].items[0].children).toEqual([line(t('x'))])
    expect(parse('r[^a]\n[^a]:  x', EXT)[1].items[0].children).toEqual([line(t('x'))])
  })
  it('the text of a note is inline, and references inside it stay literal (so no note cites itself)', () => {
    expect(parse('[^a]: **bold** and [^a]', EXT)).toEqual([
      { type: 'footnotes', items: [{ label: 'a', children: [line({ type: 'strong', children: [t('bold')] }, t(' and [^a]'))] }] },
    ])
    expect(parse('[^a]: see [^b]\n[^b]: see [^a]', EXT)).toEqual([
      { type: 'footnotes', items: [
        { label: 'a', children: [line(t('see [^b]'))] },
        { label: 'b', children: [line(t('see [^a]'))] },
      ] },
    ])
    const nodes = parse('x[^a]\n[^a]: [^a][^a][^a]', EXT)
    expect(nodeTypes(nodes).filter((type) => type === 'footnoteRef')).toHaveLength(1)
  })
  it('at most 20 notes: the 21st definition stays an ordinary line, and its label is no label', () => {
    const defs = (n) => Array.from({ length: n }, (_, i) => `[^n${i}]: note ${i}`)
    const twenty = parse(defs(20).join('\n'), EXT)
    expect(twenty).toHaveLength(1)
    expect(twenty[0].items).toHaveLength(20)
    const more = parse(`r[^n20] r[^n19]\n${defs(21).join('\n')}`, EXT)
    expect(typesOf(more)).toEqual(['line', 'line', 'footnotes'])
    expect(more[0].children.map((n) => n.type)).toEqual(['text', 'footnoteRef'])
    expect(more[1]).toEqual(line(t('[^n20]: note 20')))
    expect(more[2].items).toHaveLength(20)
    expect(more[2].items[19]).toEqual({ label: 'n19', children: [line(t('note 19'))] })
  })
  it('the first definition of a label is the note; a later one is an ordinary line', () => {
    const nodes = parse('r[^a]\n[^a]: one\n[^a]: two', EXT)
    expect(typesOf(nodes)).toEqual(['line', 'line', 'footnotes'])
    expect(nodes[2].items).toEqual([{ label: 'a', children: [line(t('one'))] }])
    expect(plainText(nodes[1].children, { raw: true })).toBe('[^a]: two')
  })
  it('a definition in a code block, a quote or a list item is no definition', () => {
    for (const src of ['```\n[^a]: x\n```\nr[^a]', '> [^a]: x\nr[^a]', '- [^a]: x\nr[^a]']) {
      const nodes = parse(src, EXT)
      expect(nodeTypes(nodes)).not.toContain('footnotes')
      expect(nodeTypes(nodes)).not.toContain('footnoteRef')
    }
  })
  it('references work in a heading, a list, a quote, a table cell and formatting', () => {
    const nodes = parse('# H[^a]\n- i[^a]\n> q[^a]\n**b[^a]**\n| c[^a] |\n|-|\n| d[^a] |\n[^a]: n', EXT)
    expect(nodeTypes(nodes).filter((type) => type === 'footnoteRef')).toHaveLength(6)
  })
  it('only [^label] is a reference: [label] and ^label are not', () => {
    expect(parse('r[a] ^a [ ^a] [^ a] [^a\n[^a]: n', EXT)[0]).toEqual(line(t('r[a] ^a [ ^a] [^ a] [^a')))
    expect(parse('r[a]\n[^a]: n', EXT)[0]).toEqual(line(t('r[a]')))
  })
  it('a masked link wins over a reference; an escaped or coded bracket is no reference', () => {
    expect(parse('[^a](https://x.io)\n[^a]: n', EXT)[0]).toEqual(line({ type: 'link', href: 'https://x.io', children: [t('^a')] }))
    expect(parse('\\[^a]\n[^a]: n', EXT)[0]).toEqual(line(t('[^a]')))
    expect(parse('`[^a]`\n[^a]: n', EXT)[0]).toEqual(line({ type: 'code', text: '[^a]' }))
  })
  it('is for extended only', () => {
    expect(parse('x[^a]\n[^a]: y')).toEqual([line(t('x[^a]')), line(t('[^a]: y'))])
  })
  it('a note is read in the same dialect: a picture in one is a picture', () => {
    expect(parse('[^a]: ![p](upload:2) x', EXT)[0].items[0].children).toEqual([line({ type: 'image', alt: 'p', ref: 2 }, t(' x'))])
  })
  it('the notes come after a quote too, and never inside one', () => {
    const notes = { type: 'footnotes', items: [{ label: 'a', children: [line(t('n'))] }] }
    const ref = { type: 'footnoteRef', label: 'a' }
    expect(parse('[^a]: n\n> q[^a]', EXT)).toEqual([{ type: 'quote', children: [line(t('q'), ref)] }, notes])
    expect(parse('[^a]: n\n>>> q[^a]\nr', EXT)).toEqual([{ type: 'quote', children: [line(t('q'), ref), line(t('r'))] }, notes])
    expect(parse('> q[^a]\n[^a]: n', EXT)).toEqual([{ type: 'quote', children: [line(t('q'), ref)] }, notes])
  })
  it('a note needs no reference, and a document may be nothing but notes', () => {
    expect(parse('[^a]: x', EXT)).toEqual([{ type: 'footnotes', items: [{ label: 'a', children: [line(t('x'))] }] }])
  })
  it('a footnote reference the parser is not told of is text (parseInline has no notes to point at)', () => {
    expect(parseInline('x[^a]', EXT)).toEqual([t('x[^a]')])
  })
})

describe.each([['discord', {}], ['extended', EXT]])('spoilers over lines (%s)', (_name, opts) => {
  const spoiler = (...children) => ({ type: 'spoiler', children })
  it('a || opened on one line closes on a later line of the same paragraph', () => {
    expect(parse('||a\nb||', opts)).toEqual([line(spoiler(t('a'), BR, t('b')))])
    expect(parse('||a\nb\nc||', opts)).toEqual([line(spoiler(t('a'), BR, t('b'), BR, t('c')))])
    expect(parse('||a\r\nb||', opts)).toEqual([line(spoiler(t('a'), BR, t('b')))])
  })
  it('words before it and after it share its line; the lines around it stay lines', () => {
    expect(parse('x ||a\nb|| y', opts)).toEqual([line(t('x '), spoiler(t('a'), BR, t('b')), t(' y'))])
    expect(parse('p\n||a\nb||\nq', opts)).toEqual([line(t('p')), line(spoiler(t('a'), BR, t('b'))), line(t('q'))])
  })
  it('several in a paragraph, one closing where the next opens', () => {
    expect(parse('||a\nb|| and ||c\nd||', opts)).toEqual([line(spoiler(t('a'), BR, t('b')), t(' and '), spoiler(t('c'), BR, t('d')))])
    expect(parse('||a\nb|| ||c\nd||', opts)).toEqual([line(spoiler(t('a'), BR, t('b')), t(' '), spoiler(t('c'), BR, t('d')))])
    expect(parse('||a|| ||b\nc|| ||d||', opts)).toEqual([line(spoiler(t('a')), t(' '), spoiler(t('b'), BR, t('c')), t(' '), spoiler(t('d')))])
    expect(parse('||a\nb||\n||c\nd||', opts)).toEqual([line(spoiler(t('a'), BR, t('b'))), line(spoiler(t('c'), BR, t('d')))])
  })
  it('each line inside is read on its own: a mark open on one line does not close on the next', () => {
    expect(parse('||**a**\n*b*||', opts)).toEqual([line(spoiler({ type: 'strong', children: [t('a')] }, BR, { type: 'em', children: [t('b')] }))])
    expect(parse('||**a\nb**||', opts)).toEqual([line(spoiler(t('**a'), BR, t('b**')))])
  })
  it('a closer at the start of the next line, an opener at the end of one', () => {
    expect(parse('||a\n||', opts)).toEqual([line(spoiler(t('a'), BR))])
    expect(parse('a ||\nb||', opts)).toEqual([line(t('a '), spoiler(BR, t('b')))])
    expect(parse('||\n||', opts)).toEqual([line(spoiler(BR))])
  })
  it('one that nothing closes stays literal, with the lines as they were', () => {
    expect(parse('||a\nb', opts)).toEqual([line(t('||a')), line(t('b'))])
    expect(parse('||a\nb|| c ||d', opts)).toEqual([line(spoiler(t('a'), BR, t('b')), t(' c ||d'))])
    expect(parse('||a\n||||', opts)).toEqual([line(spoiler(t('a'), BR), t('||'))])
  })
  it('another mark left open on a line is not a spoiler to close on the next, and a || left open inside a mark is text', () => {
    expect(parse('**a\nb||c||', opts)).toEqual([line(t('**a')), line(t('b'), spoiler(t('c')))])
    expect(parse('~~a\n||b||', opts)).toEqual([line(t('~~a')), line(spoiler(t('b')))])
    expect(parse('__a\nb||c||', opts)).toEqual([line(t('__a')), line(t('b'), spoiler(t('c')))])
    expect(parse('**x ||y**\nz||', opts)).toEqual([line({ type: 'strong', children: [t('x ||y')] }), line(t('z||'))])
  })
  it('an empty pair is text, and a bar after it can still open one', () => {
    expect(parse('||||\nx||', opts)).toEqual([line(t('|'), spoiler(t('|'), BR, t('x')))])
  })
  it('a blank line, a heading, a list, a quote, a code block or subtext between the lines ends the paragraph', () => {
    for (const middle of ['', '   ', '# h', '-# s', '- x', '1. x', '> q', '```\nc\n```']) {
      const nodes = parse(`||a\n${middle}\nb||`, opts)
      expect(nodeTypes(nodes)).not.toContain('spoiler')
      expect(nodes[0]).toEqual(line(t('||a')))
      expect(nodes.at(-1)).toEqual(line(t('b||')))
    }
  })
  it('an escaped || does not open one, and a || inside an address is not a closer', () => {
    expect(parse('\\||a\nb||', opts)).toEqual([line(t('||a')), line(t('b||'))])
    expect(parse('https://a.io/x||y\nz||', opts)).toEqual([line({ type: 'url', href: 'https://a.io/x||y' }), line(t('z||'))])
    expect(parse('||a\nhttps://a.io/x||y', opts)[0].children[0].type).toBe('spoiler')
  })
  it('works in a quote, in >>> and in the lines under a quote, but not between a list item and the line under it', () => {
    expect(parse('> ||a\n> b||', opts)).toEqual([{ type: 'quote', children: [line(spoiler(t('a'), BR, t('b')))] }])
    expect(parse('>>> ||a\nb||\nc', opts)).toEqual([{ type: 'quote', children: [line(spoiler(t('a'), BR, t('b'))), line(t('c'))] }])
    expect(parse('> ||a\nb||', opts).map((n) => n.type)).toEqual(['quote', 'line'])
    expect(nodeTypes(parse('- ||a\n  b||', opts))).not.toContain('spoiler')
    expect(nodeTypes(parse('# ||a\nb||', opts))).not.toContain('spoiler')
  })
  it('plainText keeps the line break', () => {
    expect(plainText(parse('||a\nb||', opts))).toBe('a\nb\n')
    expect(plainText(parse('||a\nb||', opts), { raw: true })).toBe('a\nb\n')
  })
  it('walk visits the break', () => {
    expect(nodeTypes(parse('||a\nb||', opts))).toEqual(['line', 'spoiler', 'text', 'br', 'text'])
  })
  it('a paragraph with no || is read line by line, as ever', () => {
    const lineText = fc.stringMatching(/^[a-z*_~` ]{0,12}$/).map((s) => 'x' + s)
    fc.assert(fc.property(fc.array(lineText, { minLength: 1, maxLength: 8 }), (lines) => {
      expect(parse(lines.join('\n'), opts)).toEqual(lines.flatMap((l) => parse(l, opts)))
    }), { numRuns: 1000 })
  })
  it('pairs the bars the way a reader would: the nearest closer, in the same paragraph, a blank line breaks it', () => {
    // The model: a paragraph is a run of lines that are not empty. The first || opens a spoiler that the next || closes, whatever line
    // it is on; a || that is the opening half of an empty pair (||||), or has no closer after it, is text.
    const hidden = (src) => {
      const found = []
      for (const para of src.split(/\n\n+/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter(Boolean)) {
        let i = 0
        while (i < para.length) {
          const at = para.startsWith('||', i) ? para.indexOf('||', i + 2) : -1
          if (at > i + 2) {
            found.push(para.slice(i + 2, at))
            i = at + 2
          } else i++
        }
      }
      return found
    }
    fc.assert(fc.property(fc.array(fc.constantFrom('a', '|', '||', '\n', '\n', '\n\n'), { maxLength: 40 }), (parts) => {
      const src = parts.join('')
      const seen = []
      walk(parse(src, opts), (n) => n.type === 'spoiler' && seen.push(plainText(n.children)))
      expect(seen).toEqual(hidden(src))
    }), { numRuns: 4000 })
  })
})

describe('plainText and walk for the extended nodes', () => {
  it('a table is its cells a row to a line; the same raw or not', () => {
    const nodes = parse('| a | **b** |\n|-|-|\n| 1 | 2 |', EXT)
    expect(plainText(nodes)).toBe('a b\n1 2\n')
    expect(plainText(nodes, { raw: true })).toBe('a b\n1 2\n')
  })
  it('walk visits the cells of a table, the head first, then each row, in order', () => {
    expect(nodeTypes(parse('| **a** | b |\n|-|-|\n| c | _d_ |', EXT))).toEqual(['table', 'strong', 'text', 'text', 'text', 'em', 'text'])
  })
  it('a divider is a break in the text', () => {
    expect(plainText(parse('a\n---\nb', EXT))).toBe('a\n\nb\n')
  })
  it('a picture is its alt text, and raw its address too, as a link is', () => {
    const nodes = parseInline('![pic](upload:3)', EXT)
    expect(plainText(nodes)).toBe('pic')
    expect(plainText(nodes, { raw: true })).toBe('picupload:3')
  })
  it('a footnote reference is nothing, and raw its mark; the notes are their texts, raw with their labels', () => {
    const [body, notes] = parse('x[^a]\n[^a]: n', EXT)
    expect(plainText(body.children)).toBe('x')
    expect(plainText(body.children, { raw: true })).toBe('x[^a]')
    expect(plainText([notes])).toBe('n\n')
    expect(plainText([notes], { raw: true })).toBe('an\n')
  })
  it('walk visits a reference, then the notes with what is in them', () => {
    expect(nodeTypes(parse('x[^a]\n[^a]: **n**', EXT))).toEqual(['line', 'text', 'footnoteRef', 'footnotes', 'line', 'strong', 'text'])
  })
  it('extended text keeps every letter and digit (the notes may move to the end, so the order is not compared)', () => {
    const tok = fc.constantFrom('**', '*', '_', '||', '`', '\n', '> ', '# ', '#### ', '###### ', '- ', '---', '| a | b |', '|-|-|', '| 1 | 2 |', '|', '| ',
      '![x](upload:3)', '![y](upload:11)', '![z](https://a.io/p.png)', '[^a]', '[^b]', '[^a]: n', '[^b]: m', '[^a]: ', 'word', '9', 'é', ' ')
    fc.assert(fc.property(fc.array(tok, { maxLength: 60 }), (parts) => {
      const s = parts.join('')
      const key = (text) => [...alnum(text)].sort().join('')
      expect(key(plainText(parse(s, EXT), { raw: true }))).toBe(key(s))
    }), { numRuns: 3000 })
  })
})

describe('both dialects: no input throws, and none is slow', () => {
  const budget = globalThis.__stryker__ ? 5000 : 200
  const TOKENS = ['**', '*', '_', '__', '~~', '||', '`', '```', '\n', '\n\n', '> ', '>>> ', '# ', '#### ', '###### ', '-# ', '- ', '* ', '1. ', '---', ' ', '\t',
    '[', ']', '](', ')', '<', '>', '\\', '!', '|', '| a | b |', '|-|-|', '|:-:|', '| 1 | 2 |', '![x](upload:3)', '![x](upload:0)', '![](https://a.io/p.png)',
    '[^a]', '[^b]', '[^a]: n', '[^b]: [^a]', `<:e:${E}>`, `<@&${E}>`, 'https://a.io/x', 'word', '9', 'é', '\u2028', '\u200b']
  it.each([['discord', {}], ['extended', EXT]])('parse of any string, and of markdown-shaped ones, never throws (%s)', (_name, opts) => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
      expect(Array.isArray(parse(s, opts))).toBe(true)
    }), { numRuns: 1500 })
    fc.assert(fc.property(fc.array(fc.constantFrom(...TOKENS), { maxLength: 80 }), (parts) => {
      const nodes = parse(parts.join(''), opts)
      expect(Array.isArray(nodes)).toBe(true)
      walk(nodes, () => {})
      plainText(nodes, { raw: true })
      plainText(nodes)
    }), { numRuns: 3000 })
  })
  it.each([['discord', {}], ['extended', EXT]])('parseInline of any string never throws (%s)', (_name, opts) => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...TOKENS), { maxLength: 60 }), (parts) => {
      expect(Array.isArray(parseInline(parts.join(''), opts))).toBe(true)
    }), { numRuns: 2000 })
  })
  const families = () => ({
    'pipes': '|'.repeat(50_000),
    'pipe and letter': '|a'.repeat(25_000),
    'tables stacked': '| a | b |\n|-|-|\n'.repeat(3_000),
    'rule rows': '| - |\n'.repeat(8_000),
    'a header and 9,000 rule rows': '| a |\n' + '| - |\n'.repeat(9_000),
    'a table of 10,000 columns': grid(10_000, 2),
    'a table of 1,000 rows': grid(3, 1_000),
    'footnote definitions': '[^a]: x\n'.repeat(6_000),
    'distinct footnote definitions': Array.from({ length: 4_000 }, (_, i) => `[^n${i}]: x`).join('\n'),
    'footnote references': '[^a]'.repeat(12_000) + '\n[^a]: x',
    'unclosed references': '[^a'.repeat(16_000),
    'pictures': '![a](upload:1)'.repeat(3_500),
    'broken pictures': '![a'.repeat(16_000),
    'one long alt text': '![' + 'a'.repeat(50_000),
    'dividers': '---\n'.repeat(12_000),
    'an opener on every line': '||a\n'.repeat(12_000),
    'an opener on every line, a closer after': '||a\n'.repeat(12_000) + '||',
    'an opener, then lines with no bar': '||a\n' + 'b\n'.repeat(20_000),
    'a closer on every other line': '||a\nb||\n'.repeat(6_000),
    'bars at the ends of lines': 'a ||\n'.repeat(10_000),
    'only bars': '||\n'.repeat(15_000),
    'openers in quotes': '> ||a\n'.repeat(10_000),
    'fence openers': '```a\n'.repeat(10_000),
    'headings': '###### a\n'.repeat(5_000),
    'a long unclosed spoiler': '||' + 'word '.repeat(10_000),
  })
  it.each([['discord', {}], ['extended', EXT]])('a 50,000 character input of any of these shapes parses in under 200 ms (%s)', (_name, opts) => {
    for (const [name, src] of Object.entries(families())) {
      const start = performance.now()
      expect(() => parse(src, opts), name).not.toThrow()
      expect(performance.now() - start, name).toBeLessThan(budget)
    }
  }, 60_000)
  it.each([['discord', {}], ['extended', EXT]])('100,000 fence openers, and as many lines in a paragraph of spoilers, take no more than 2 s (%s)', (_name, opts) => {
    // The first is the shape that made the old scan for a closing fence quadratic: each opener looked to the end of the text.
    for (const src of ['```a\n'.repeat(100_000), '||a\n'.repeat(100_000), 'a\n'.repeat(100_000) + '||b']) {
      const start = performance.now()
      parse(src, opts)
      expect(performance.now() - start).toBeLessThan(globalThis.__stryker__ ? 20_000 : 2000)
    }
  }, 60_000)
})
