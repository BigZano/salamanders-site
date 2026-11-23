import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parse, parseInline, plainText, walk } from './markdown'
import { parse as parseBefore } from './markdown-22b6793.fixture'

// A spoiler that runs over lines: a `||` the line it is on leaves open, closed by a `||` on a later line.
const E = '123456789012345678'
const t = (value) => ({ type: 'text', value })
const line = (...children) => ({ type: 'line', children })
const quote = (...children) => ({ type: 'quote', children })
const spoiler = (...children) => ({ type: 'spoiler', children })
// One that closes at the message's last bar, because no later line leaves a bar open.
const last = (...children) => ({ type: 'spoiler', children, lastBar: true })
const list = (...texts) => ({ type: 'list', ordered: false, items: texts.map((text) => ({ marker: '-', children: [line(t(text))] })) })
const blank = { type: 'blank' }
const WORD = /w\d+/g

/** → { hidden, shown }: the words (w0, w1, …) the nodes hold, by whether a spoiler holds them. */
function exposure(nodes) {
  const hidden = []
  const shown = []
  const visit = (list, inside) => {
    for (const n of list) {
      const within = inside || n.type === 'spoiler'
      for (const word of [n.value, n.text].join(' ').match(WORD) ?? []) (within ? hidden : shown).push(word)
      if (n.children) visit(n.children, within)
      if (n.items) for (const item of n.items) visit(item.children, within)
    }
  }
  visit(nodes, false)
  return { hidden, shown }
}

/** Numbers each `W` in the text, in order: w0, w1, … */
function numbered(text) {
  let n = 0
  return text.replace(/W/g, () => `w${n++}`)
}

const spansLines = (nodes) => nodes.some((n) => n.type === 'spoiler')

describe('a spoiler that runs over lines', () => {
  it.each([
    ['two lines', '||ALPHA\nBRAVO||', [spoiler(line(t('ALPHA')), line(t('BRAVO')))]],
    ['a blank line between', '||ALPHA\n\nBRAVO||', [spoiler(line(t('ALPHA')), blank, line(t('BRAVO')))]],
    ['a quote between (read alone, it hides to the last bar)', '||ALPHA\n> quote\nBRAVO||', [last(line(t('ALPHA')), quote(line(t('quote'))), line(t('BRAVO')))]],
    ['a list between (the same)', '||ALPHA\n- item\nBRAVO||', [last(line(t('ALPHA')), list('item'), line(t('BRAVO')))]],
    ['a heading between (the same)', '||ALPHA\n## Head\nBRAVO||', [last(line(t('ALPHA')), { type: 'heading', level: 2, children: [t('Head')] }, line(t('BRAVO')))]],
    ['a whole fence between, bars and all', '||a\n```\nx || y\n```\nb||', [last(line(t('a')), { type: 'codeblock', lang: '', text: 'x || y' }, line(t('b')))]],
  ])('is one spoiler node: %s', (_, src, nodes) => {
    expect(parse(src)).toEqual(nodes)
  })

  it('keeps the words before the opener and after the closer outside it, on lines of their own', () => {
    expect(parse('before ||ALPHA\nBRAVO|| after')).toEqual([line(t('before ')), spoiler(line(t('ALPHA')), line(t('BRAVO'))), line(t(' after'))])
    expect(parse('||ALPHA\nBRAVO||\nCHARLIE')).toEqual([spoiler(line(t('ALPHA')), line(t('BRAVO'))), line(t('CHARLIE'))])
    expect(parse('x\n||a\nb||')).toEqual([line(t('x')), spoiler(line(t('a')), line(t('b')))])
  })

  it('hides to the last bar when the closing line holds more bars before its closer', () => {
    // Discord may read "b" closing the first and "||c||" as a second spoiler, with the space shown; this hides it all.
    expect(parse('||a\nb|| ||c||')).toEqual([last(line(t('a')), line(t('b'), spoiler(t(' ')), t('c')))])
    expect(parse('||a\nb|| ||c\nd||')).toEqual([last(line(t('a')), line(t('b'), spoiler(t(' ')), t('c')), line(t('d')))])
  })

  it('hides to the last bar when the closer sits in a span (the span may be read first)', () => {
    expect(parse('||a\n**b||** ||c||')).toEqual([last(line(t('a')), line({ type: 'strong', children: [t('b||')] }, t(' ||c')))])
    expect(parse('||a\n**b||** ||c\nd||')).toEqual([last(line(t('a')), line({ type: 'strong', children: [t('b||')] }, t(' ||c')), line(t('d')))])
  })

  it('keeps one-line spoilers before the opener as they were', () => {
    expect(parse('||x|| ||a\nb||')).toEqual([line(spoiler(t('x')), t(' ')), spoiler(line(t('a')), line(t('b')))])
  })

  it('hides to the last bar over one-line spoilers on the lines between, which sit inside it (nesting)', () => {
    // Nesting is unclear in Discord: two spoilers with "b" shown, or one with "b" inside. Both are hidden.
    expect(parse('||a\n||b||\nc||')).toEqual([last(line(t('a')), line(spoiler(t('b'))), line(t('c')))])
    expect(parse('||a\nx ||b|| y ||c||\nd||')).toEqual([last(line(t('a')), line(t('x '), spoiler(t('b')), t(' y '), spoiler(t('c'))), line(t('d')))])
  })

  it('hides to the last bar when a bar in inline code or a fence lies between (a closer inside code)', () => {
    expect(parse('||a\n`b||`\nc||')).toEqual([last(line(t('a')), line({ type: 'code', text: 'b||' }), line(t('c')))])
    expect(parse('||a\n`b||`')).toEqual([last(line(t('a')), line(t('`b'))), line(t('`'))])
    expect(parse('||a\n```\nx||\n```')).toEqual([last(line(t('a')), line(t('```')), line(t('x'))), line(t('```'))])
  })

  it('takes the last bar of the message when no later line leaves one open', () => {
    expect(parse('||a\nx ||b|| y')).toEqual([last(line(t('a')), line(t('x ||b'))), line(t(' y'))])
    expect(parse('||a\nb\n||c||\nd\n||e||\nf')).toEqual([
      last(line(t('a')), line(t('b')), line(spoiler(t('c'))), line(t('d')), line(t('||e'))),
      line(t('f')),
    ])
  })

  it('never opens at bars inside inline code or a fence (code is read first)', () => {
    for (const src of ['`||`\nb||', '```\n||a\n```\nb||', '> ```\n> ||a\n> ```\nb||', '`x ||` y\nz||']) {
      expect(parse(src), src).toEqual(parseBefore(src))
    }
  })

  it('cuts a quote at the opener and keeps the quote on both sides (an opener on a quote line)', () => {
    expect(parse('> a ||b\n> c||\n> d')).toEqual([quote(line(t('a '))), spoiler(quote(line(t('b')), line(t('c')))), quote(line(t('d')))])
    expect(parse('> ||a\n> b||\n> c')).toEqual([spoiler(quote(line(t('a')), line(t('b')))), quote(line(t('c')))])
    expect(parse('> ||a\n> b||')).toEqual([spoiler(quote(line(t('a')), line(t('b'))))])
  })

  it("hides to the last bar from an opener on a quote's last line (Discord may end the spoiler with the quote)", () => {
    expect(parse('> a ||b\nc||')).toEqual([quote(line(t('a '))), last(quote(line(t('b'))), line(t('c')))])
    expect(parse('> ||a\nb||')).toEqual([last(quote(line(t('a'))), line(t('b')))])
    expect(parse('a ||b\n> c||\nd')).toEqual([line(t('a ')), last(line(t('b')), quote(line(t('c')))), line(t('d'))])
  })

  it('keeps a >>> quote around what comes after the closer', () => {
    expect(parse('>>> a ||b\nc||\nd')).toEqual([quote(line(t('a '))), spoiler(quote(line(t('b')), line(t('c')))), quote(line(t('d')))])
    expect(parse('>>> a\nb ||c\nd||\ne')).toEqual([quote(line(t('a')), line(t('b '))), spoiler(quote(line(t('c')), line(t('d')))), quote(line(t('e')))])
    expect(parse('>>> a\n||b\nc||')).toEqual([quote(line(t('a'))), spoiler(quote(line(t('b')), line(t('c'))))])
    expect(parse('||a\n>>> b|| c\nd')).toEqual([last(line(t('a')), quote(line(t('b')))), quote(line(t(' c')), line(t('d')))])
  })

  it('leaves out a quote that the cut leaves empty', () => {
    expect(parse('||a\n> b||')).toEqual([last(line(t('a')), quote(line(t('b'))))])
    expect(parse('||a\n>>> b||')).toEqual([last(line(t('a')), quote(line(t('b'))))])
  })

  it('reads the markers alone before an opener as words in it, and keeps a list item or heading with words before it (read alone, it hides to the last bar)', () => {
    expect(parse('- ||a\nb||')).toEqual([last(line(t('- a')), line(t('b')))])
    expect(parse('# ||a\nb||')).toEqual([last(line(t('# a')), line(t('b')))])
    expect(parse('1. ||a\nb||')).toEqual([last(line(t('1. a')), line(t('b')))])
    expect(parse('  ||a\nb||')).toEqual([spoiler(line(t('  a')), line(t('b')))])
    expect(parse('> - ||a\n> b||')).toEqual([last(quote(line(t('- a')), line(t('b'))))])
    expect(parse('- one ||a\n- two||')).toEqual([list('one '), last(line(t('a')), list('two'))])
    expect(parse('# Title ||a\nb||')).toEqual([{ type: 'heading', level: 1, children: [t('Title ')] }, last(line(t('a')), line(t('b')))])
    expect(parse('-# small ||a\nb||')).toEqual([{ type: 'subtext', children: [t('small ')] }, last(line(t('a')), line(t('b')))])
  })

  it('drops a closing line that is blank before its closer, and keeps one with markers', () => {
    expect(parse('||a\n  ||')).toEqual([spoiler(line(t('a')))])
    expect(parse('||a\n> ||\nb')).toEqual([last(line(t('a'))), line(t('b'))])
    expect(parse('||a\n1. ||')).toEqual([last(line(t('a')), { type: 'list', ordered: true, items: [{ marker: '1.', children: [line()] }] })])
  })

  it('reads the piece after an opener or a closer as words, never as a block', () => {
    expect(parse('||- a\nb||')).toEqual([spoiler(line(t('- a')), line(t('b')))])
    expect(parse('||a\nb|| # c')).toEqual([spoiler(line(t('a')), line(t('b'))), line(t(' # c'))])
    expect(parse('||a\nb||> c\nd')).toEqual([spoiler(line(t('a')), line(t('b'))), line(t('> c')), line(t('d'))])
    expect(parse('||a\nb||```\nc\n```')).toEqual([spoiler(line(t('a')), line(t('b'))), line(t('```')), line(t('c')), line(t('```'))])
  })
})

describe('hostile input', () => {
  it.each([
    ['`||` at the end of a line and the start of the next', 'a ||\nb\n|| c', [line(t('a ')), spoiler(line(t('b'))), line(t(' c'))]],
    ['`||` on a line of its own, twice', '||\n||', [spoiler()]],
    ['`|||` on both lines', '|||a\nb|||', [spoiler(line(t('|a')), line(t('b'))), line(t('|'))]],
    ['`||||` opens at its first bar', '||||\nx||', [spoiler(line(t('||')), line(t('x')))]],
    ['a closer escaped by half', '||a\nb\\||', [last(line(t('a')), line(t('b\\')))]],
    ['CRLF', '||a\r\nb||', [spoiler(line(t('a')), line(t('b')))]],
    ['a lone CR', '||a\rb||', [spoiler(line(t('a')), line(t('b')))]],
    ['ZWSP inside the bars', '||\u200ba\nb\u200b||', [spoiler(line(t('\u200ba')), line(t('b\u200b')))]],
    ['an opener at EOF after a closed one', '||a\nb||\n||', [spoiler(line(t('a')), line(t('b'))), line(t('||'))]],
    ['bars in inline code inside it', '||a `x`\n`||` b||', [last(line(t('a '), { type: 'code', text: 'x' }), line({ type: 'code', text: '||' }, t(' b')))]],
  ])('%s', (_, src, nodes) => {
    expect(parse(src)).toEqual(nodes)
  })

  it.each([
    ['an opener nothing closes', '||a\nb'],
    ['an opener at EOF', 'a\n||'],
    ['an opener with only blank lines after it', 'a ||b\n\nc'],
    ['escaped bars', '\\|\\|a\nb||'],
    ['escaped bars at the close', '||a\nb\\|\\|'],
    ['half an escaped opener', '\\||a\nb||'],
    ['ZWSP between the bars', '|\u200b|a\nb||'],
    ['one-line spoilers on each line', '||a|| b\nc ||d||'],
    ['`||||` alone', '||||'],
  ])('%s stays as it was', (_, src) => {
    expect(parse(src)).toEqual(parseBefore(src))
  })

  it.each([
    ['100k lines of openers and closers', Array.from({ length: 100_000 }, (_, i) => (i % 2 ? 'close w|| tail' : '||open w')).join('\n')],
    ['100k lines of `||` alone', Array.from({ length: 100_000 }, () => '||').join('\n')],
    ['an opener, then 100k lines of one-line spoilers', '||open\n' + Array.from({ length: 100_000 }, () => '||x|| y').join('\n')],
    ['100k mixed lines', Array.from({ length: 100_000 }, (_, i) => ['||a', '> b ||c||', '- d||', '```', 'x || y', '```', '`||` e', '>>> f ||'][i % 8]).join('\n')],
    ['100k lines that open and never close', Array.from({ length: 100_000 }, () => 'a ||b').join('\n') + '\nz'],
  ])('%s parse in bounded time', (_, s) => {
    const budget = globalThis.__stryker__ ? 60_000 : 6000
    const at = performance.now()
    expect(() => parse(s)).not.toThrow()
    expect(performance.now() - at).toBeLessThan(budget)
  }, 120_000)
})

describe('unchanged where no spoiler runs over lines', () => {
  const tokens = ['**', '*', '_', '__', '~~', '||', '|', '`', '```', '> ', '>>> ', '# ', '-# ', '- ', '1. ', '[', '](', ')', '<', '>', '\\',
    `<:e:${E}>`, `<@&${E}>`, 'https://a.io/x', 'word', ' ', '\\|', '\u200b']
  it('parses every text with no line break exactly as before', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...tokens), { maxLength: 60 }), (parts) => {
      const s = parts.join('')
      expect(parse(s)).toEqual(parseBefore(s))
    }), { numRuns: 3000 })
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (raw) => {
      const s = raw.replace(/[\r\n]/g, ' ')
      expect(parse(s)).toEqual(parseBefore(s))
    }), { numRuns: 2000 })
  })
  it('parses every text whose bars are all on one line exactly as before', () => {
    const quiet = fc.array(fc.constantFrom(...tokens.filter((tok) => !tok.includes('|'))), { maxLength: 12 }).map((p) => p.join(''))
    const loud = fc.array(fc.constantFrom(...tokens), { maxLength: 20 }).map((p) => p.join(''))
    fc.assert(fc.property(fc.array(quiet, { maxLength: 8 }), loud, fc.nat(), (lines, bars, at) => {
      const all = [...lines]
      all.splice(at % (lines.length + 1), 0, bars)
      const s = all.join('\n')
      expect(parse(s)).toEqual(parseBefore(s))
    }), { numRuns: 3000 })
  })
  it('parses every text exactly as before when it finds no spoiler that runs over lines', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...tokens, '\n', '\n', '\r\n'), { maxLength: 60 }), (parts) => {
      const s = parts.join('')
      const now = parse(s)
      if (!spansLines(now)) expect(now).toEqual(parseBefore(s))
    }), { numRuns: 4000 })
  })
})

describe('a spoiler after one over lines, where the readings of Discord pair the bars differently', () => {
  // Each row: words a reading of Discord hides after the first spoiler, and that reading. The site hides them all.
  it.each([
    ['an opener in bold (a span is read first, so `||w2` opens)', '**w0 ||w1**\n||w2\nw3||', ['w1', 'w2', 'w3'], ['w0']],
    ['an opener on a quote line (a quote is read alone)', '> ||w0\n||w1\nw2||', ['w0', 'w1', 'w2'], []],
    ['an opener in a heading', '# w0 ||w1\n||w2\nw3||', ['w1', 'w2', 'w3'], ['w0']],
    ['an opener in a subtext', '-# w0 ||w1\n||w2\nw3||', ['w1', 'w2', 'w3'], ['w0']],
    ['an opener in a list item', '- w0 ||w1\n||w2\nw3||', ['w1', 'w2', 'w3'], ['w0']],
    ['a bar in inline code between (it may close, and `||w2` open)', '||w0\n`w1||` ||w2\nw3|| w4', ['w0', 'w1', 'w2', 'w3'], ['w4']],
    ['a bar in a fence between', '||w0\n```\nw1||\n```\n||w2\nw3||', ['w0', 'w1', 'w2', 'w3'], []],
    ['a half-escaped bar between', '||w0\nw1 \\|| w2 ||w3\nw4||', ['w0', 'w1', 'w2', 'w3', 'w4'], []],
    ['a bar in code, then words after the closer', '||w0\n`w1||w2`\nw3|| w4\n||w5\nw6||', ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6'], []],
    ['a bar in a link label between', '||w0\n[w1 ||w2](https://a.io) w3||\n||w4\nw5|| w6', ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'], ['w6']],
  ])('%s', (_, src, hidden, shown) => {
    const seen = exposure(parse(src))
    expect(seen.hidden.sort()).toEqual(hidden)
    expect(seen.shown.sort()).toEqual(shown)
  })

  it('still shows what follows a closer every reading agrees on', () => {
    expect(exposure(parse('||w0\nw1|| w2\n||w3\nw4|| w5'))).toEqual({ hidden: ['w0', 'w1', 'w3', 'w4'], shown: ['w2', 'w5'] })
    expect(exposure(parse('||w0\n||w1||\n> ||w2||\nw3|| w4'))).toEqual({ hidden: ['w0', 'w1', 'w2', 'w3'], shown: ['w4'] })
    expect(exposure(parse('> ||w0\n> w1|| w2\n> w3'))).toEqual({ hidden: ['w0', 'w1'], shown: ['w2', 'w3'] })
    expect(exposure(parse('>>> ||w0\nw1|| w2'))).toEqual({ hidden: ['w0', 'w1'], shown: ['w2'] })
  })

  it('hides to the last bar when a > quote it opens in ends before its closer', () => {
    expect(exposure(parse('> ||w0\n> w1\nw2\n> w3|| w4\n||w5|| w6'))).toEqual({ hidden: ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'], shown: ['w6'] })
  })
})

describe('what a line leaves, as parseInline tells it', () => {
  it('gives where each open bar, one-line spoiler, code span and escape starts, spans included', () => {
    const s = 'a ||b|| `c||` \\| **d ||e** [f ||g](https://a.io) *h ||i* ***j ||k*** ~~l ||m~~ __n ||o__ ||p'
    const seen = { open: [], pairs: [], code: [], escaped: [] }
    parseInline(s, seen)
    expect(seen).toEqual({
      open: [
        { at: 21, top: false }, { at: 30, top: false }, { at: 52, top: false }, { at: 62, top: false },
        { at: 73, top: false }, { at: 83, top: false }, { at: 89, top: true },
      ],
      pairs: [{ from: 2, to: 5, top: true }],
      code: [[8, 13]],
      escaped: [15],
    })
    expect(seen.open.map(({ at }) => s.slice(at, at + 3))).toEqual(['||e', '||g', '||i', '||k', '||m', '||o', '||p'])
    const inner = { open: [], pairs: [], code: [], escaped: [] }
    parseInline('**||a|| ||b**', inner)
    expect(inner).toEqual({ open: [{ at: 8, top: false }], pairs: [{ from: 2, to: 5, top: false }], code: [], escaped: [] })
  })
})

describe('fail closed', () => {
  /**
   * The plausible readings of Discord, each run on its own. While no spoiler over lines is open, each reads a line as the
   * site's one-line parser does (the one-line readings are frozen as they were at 22b6793). They differ in which `||` a
   * line leaves open may open one, and which later `||` closes it, and each reads the rest of the closing line again:
   *   opener: any the line leaves open | only one no span holds | only on a line that is no heading, subtext or list item
   *   closer: the first a later line leaves open | the first `||` of all | the first outside code and not escaped |
   *           the first no span holds | (blocks read alone) the first a later line of the same block leaves open, with
   *           the lines around a block one block, or each run of them apart.
   * → [start, end) of every stretch any of them hides. `code` says which lines a fence holds.
   */
  function hiddenByAnyReading(lines, code) {
    const starts = []
    lines.reduce((at, line) => (starts.push(at), at + line.length + 1), 0)
    const seenOf = (text) => {
      const seen = { open: [], pairs: [], code: [], escaped: [] }
      parseInline(text, seen)
      return seen
    }
    let deep = false
    let group = -1
    const block = lines.map((line, k) => {
      const start = !deep && !code[k] && line.startsWith('>>> ')
      deep ||= start
      const quoted = !deep && (line.startsWith('> ') || line === '>')
      group = quoted ? (group === -1 ? k : group) : -1
      const own = start ? line.slice(4) : quoted ? line.slice(2) : line
      if (code[k]) return 'code'
      if (/^[ \t]*(?:#{1,3} +\S|-# +\S|(?:[-*]|\d{1,9}\.) +)/.test(own)) return `alone${k}`
      return deep ? 'deep' : quoted ? `quote${group}` : 'plain'
    })
    // The same, with the lines around a block read apart: a run of lines of one block, broken by any other.
    let run = 0
    const runs = block.map((b, k) => (k > 0 && b === block[k - 1] && b !== 'code' && !b.startsWith('alone') ? run : ++run))
    const later = (i, find) => {
      for (let j = i + 1; j < lines.length; j++) {
        const at = find(j)
        if (at !== undefined && at !== -1) return [j, at]
      }
      return null
    }
    const firstOpen = (j) => (code[j] ? undefined : seenOf(lines[j]).open[0]?.at)
    const closers = {
      open: (i) => later(i, firstOpen),
      raw: (i) => later(i, (j) => lines[j].indexOf('||')),
      outside: (i) => later(i, (j) => {
        if (code[j]) return undefined
        const seen = seenOf(lines[j])
        for (let at = lines[j].indexOf('||'); at !== -1; at = lines[j].indexOf('||', at + 1)) {
          if (!seen.escaped.includes(at) && !seen.code.some(([a, b]) => at >= a && at < b)) return at
        }
        return undefined
      }),
      top: (i) => later(i, (j) => (code[j] ? undefined : seenOf(lines[j]).open.find((b) => b.top)?.at)),
      alone: (i) => later(i, (j) => (block[j] === block[i] ? firstOpen(j) : undefined)),
      apart: (i) => later(i, (j) => (runs[j] === runs[i] ? firstOpen(j) : undefined)),
    }
    const openers = { any: () => true, top: (bar) => bar.top, shared: (_, i) => !block[i].startsWith('alone') }
    const readings = [
      ['any', 'open'], ['any', 'raw'], ['any', 'outside'], ['any', 'top'],
      ['top', 'open'], ['top', 'raw'], ['top', 'outside'], ['top', 'top'],
      ['shared', 'alone'], ['shared', 'apart'],
    ]
    const hidden = []
    for (const [opens, closes] of readings) {
      for (let i = 0, from = 0; i < lines.length; ) {
        if (code[i] && from === 0) {
          i++
          continue
        }
        const seen = seenOf(lines[i].slice(from))
        for (const pair of seen.pairs) hidden.push([starts[i] + from + pair.from, starts[i] + from + pair.to + 2])
        const bar = seen.open.find((b) => openers[opens](b, i))
        const end = bar && closers[closes](i)
        if (!end) {
          i++
          from = 0
          continue
        }
        hidden.push([starts[i] + from + bar.at, starts[end[0]] + end[1] + 2])
        i = end[0]
        from = end[1] + 2
      }
    }
    return hidden
  }

  it('hides every word any reading of Discord hides, with bars in and out of code, fences, escapes, spans, quotes and headings', () => {
    const tok = fc.constantFrom('W', 'W', '||', '||', '||W||', '`W||W`', '`W`', '\\||', '\\|\\|', '**W ||W**', '*W ||W*', '[W ||W](https://a.io)', '**W**')
    const text = fc.tuple(fc.constantFrom('', '', '> ', '>>> ', '- ', '1. ', '# ', '-# '), fc.array(tok, { maxLength: 5 }))
      .map(([prefix, parts]) => ({ lines: [prefix + parts.join(' ')], code: [false] }))
    const fence = fc.tuple(fc.boolean(), fc.array(tok, { minLength: 1, maxLength: 4 })).map(([quoted, parts]) => ({ quoted, body: parts.join(' ') }))
    const blank = fc.constant({ lines: [''], code: [false] })
    fc.assert(fc.property(fc.array(fc.oneof(text, text, fence, blank), { minLength: 1, maxLength: 8 }), (blocks) => {
      // Inside a >>> quote a fence in a > quote is no fence, so after one it is a plain fence.
      let deep = false
      const all = blocks.map((b) => {
        if (b.body === undefined) {
          deep ||= b.lines[0].startsWith('>>> ')
          return b
        }
        const q = b.quoted && !deep ? '> ' : ''
        return { lines: [`${q}\`\`\``, q + b.body, `${q}\`\`\``], code: [true, true, true] }
      })
      const s = numbered(all.flatMap((b) => b.lines).join('\n'))
      const stretches = hiddenByAnyReading(s.split('\n'), all.flatMap((b) => b.code))
      const { hidden, shown } = exposure(parse(s))
      const first = s.indexOf('||')
      const last = s.lastIndexOf('||')
      for (const m of s.matchAll(WORD)) {
        if (stretches.some(([a, b]) => m.index >= a && m.index < b)) expect(hidden, `${m[0]} in ${JSON.stringify(s)}`).toContain(m[0])
        if (first === -1 || m.index < first || m.index > last) expect(shown, `${m[0]} in ${JSON.stringify(s)}`).toContain(m[0])
      }
    }), { numRuns: 3000 })
  })

  it('hides exactly the words between each pair of bars when every reading agrees on them, and shows the rest', () => {
    // A piece is text and, for each W in it, whether a spoiler on its own line hides it.
    const piece = (text, ...hide) => ({ text, hide })
    const quietTokens = fc.array(fc.constantFrom(piece('W', false), piece('||W||', true), piece('`W`', false), piece('\\|\\|'), piece('**W**', false)), { minLength: 1, maxLength: 3 })
    const loudTokens = fc.array(fc.constantFrom(piece('W', false), piece('||W||', true), piece('`W||W`', false, false), piece('\\|\\|'), piece('**W**', false)), { minLength: 1, maxLength: 3 })
    const plainTokens = fc.array(fc.constantFrom(piece('W', false), piece('\\|\\|'), piece('**W**', false)), { maxLength: 3 })
    const join = (pieces, prefix = '') => ({ lines: [prefix + pieces.map((p) => p.text).join(' ')], hide: pieces.flatMap((p) => p.hide) })
    const prefix = fc.constantFrom('', '', '> ', '- ', '1. ', '# ')
    const fence = (tokens) => fc.tuple(tokens, fc.boolean()).map(([pieces, quoted]) => {
      const q = quoted ? '> ' : ''
      return { lines: [`${q}\`\`\``, q + pieces.map((p) => p.text).join(' '), `${q}\`\`\``], hide: pieces.flatMap((p) => p.hide.map(() => false)) }
    })
    const blank = fc.constant({ lines: [''], hide: [] })
    const calm = fc.array(fc.constantFrom(piece('W', false), piece('`W`', false), piece('\\|\\|'), piece('**W**', false)), { minLength: 1, maxLength: 3 })
    // Between the bars: plain lines of words, inline code and escaped bars, and blank lines; no bar, no other block.
    const quiet = fc.oneof(calm.map((pieces) => join(pieces)), blank)
    // Outside them, bars in code and fences too.
    const loud = fc.oneof(fc.tuple(loudTokens, prefix).map(([pieces, pre]) => join(pieces, pre)), fence(loudTokens), blank)
    const region = fc.tuple(fc.option(quietTokens), plainTokens, fc.array(quiet, { maxLength: 3 }), fc.option(calm), plainTokens)
      .map(([before, after, inner, closeBefore, tail]) => {
        const head = before ? before.map((p) => p.text).join(' ') + ' ' : ''
        const closing = closeBefore ? closeBefore.map((p) => p.text).join(' ') + ' ' : ''
        return {
          lines: [`${head}||${after.map((p) => p.text).join(' ')}`, ...inner.flatMap((b) => b.lines), `${closing}W||${tail.map((p) => p.text).join(' ')}`],
          hide: [...(before ?? []).flatMap((p) => p.hide), ...after.flatMap((p) => p.hide.map(() => true)), ...inner.flatMap((b) => b.hide.map(() => true)), ...(closeBefore ?? []).flatMap((p) => p.hide.map(() => true)), true, ...tail.flatMap((p) => p.hide)],
        }
      })
    fc.assert(fc.property(fc.array(fc.oneof(loud, region, region), { minLength: 1, maxLength: 5 }), (blocks) => {
      const s = numbered(blocks.flatMap((b) => b.lines).join('\n'))
      const expected = { hidden: [], shown: [] }
      blocks.flatMap((b) => b.hide).forEach((h, i) => (h ? expected.hidden : expected.shown).push(`w${i}`))
      const { hidden, shown } = exposure(parse(s))
      expect({ hidden: hidden.sort(), shown: shown.sort() }, JSON.stringify(s)).toEqual({ hidden: expected.hidden.sort(), shown: expected.shown.sort() })
    }), { numRuns: 2000 })
  })
})

describe('the nodes inside it', () => {
  it('walk visits them in document order', () => {
    const seen = []
    walk(parse(`||[x](https://a.io)\n- <@${E}>\n> <:e:${E}>||`), (n) => seen.push(n.type))
    expect(seen).toEqual(['spoiler', 'line', 'link', 'text', 'list', 'line', 'mention', 'quote', 'line', 'emoji'])
  })
  it('plainText reads them line by line', () => {
    expect(plainText(parse('a ||b\nc|| d'))).toBe('a \nb\nc\n d\n')
    expect(plainText(parse('||a\n```js\nx\n```\nb||'), { raw: true })).toBe('a\njsx\nb\n')
  })
})
