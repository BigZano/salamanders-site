import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parse, plainText, walk } from './markdown'
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
    ['a quote between', '||ALPHA\n> quote\nBRAVO||', [spoiler(line(t('ALPHA')), quote(line(t('quote'))), line(t('BRAVO')))]],
    ['a list between', '||ALPHA\n- item\nBRAVO||', [spoiler(line(t('ALPHA')), list('item'), line(t('BRAVO')))]],
    ['a heading between', '||ALPHA\n## Head\nBRAVO||', [spoiler(line(t('ALPHA')), { type: 'heading', level: 2, children: [t('Head')] }, line(t('BRAVO')))]],
    ['a whole fence between, bars and all', '||a\n```\nx || y\n```\nb||', [spoiler(line(t('a')), { type: 'codeblock', lang: '', text: 'x || y' }, line(t('b')))]],
  ])('is one spoiler node: %s', (_, src, nodes) => {
    expect(parse(src)).toEqual(nodes)
  })

  it('keeps the words before the opener and after the closer outside it, on lines of their own', () => {
    expect(parse('before ||ALPHA\nBRAVO|| after')).toEqual([line(t('before ')), spoiler(line(t('ALPHA')), line(t('BRAVO'))), line(t(' after'))])
    expect(parse('||ALPHA\nBRAVO||\nCHARLIE')).toEqual([spoiler(line(t('ALPHA')), line(t('BRAVO'))), line(t('CHARLIE'))])
    expect(parse('x\n||a\nb||')).toEqual([line(t('x')), spoiler(line(t('a')), line(t('b')))])
  })

  it('closes at the bar the closing line leaves open, so a one-line spoiler the closer seems to start sits inside it', () => {
    // Discord may read "b" closing the first and "||c||" as a second spoiler, with the space shown; this hides it all.
    expect(parse('||a\nb|| ||c||')).toEqual([spoiler(line(t('a')), line(t('b'), spoiler(t(' ')), t('c')))])
    expect(parse('||a\nb|| ||c\nd||')).toEqual([spoiler(line(t('a')), line(t('b'), spoiler(t(' ')), t('c')), line(t('d')))])
  })

  it('reads the rest of the closing line again, so a spoiler after the closer is one too', () => {
    expect(parse('||a\n**b||** ||c||')).toEqual([spoiler(line(t('a')), line(t('**b'))), line(t('** '), spoiler(t('c')))])
    expect(parse('||a\n**b||** ||c\nd||')).toEqual([spoiler(line(t('a')), line(t('**b'))), line(t('** ')), spoiler(line(t('c')), line(t('d')))])
  })

  it('keeps one-line spoilers before the opener as they were', () => {
    expect(parse('||x|| ||a\nb||')).toEqual([line(spoiler(t('x')), t(' ')), spoiler(line(t('a')), line(t('b')))])
  })

  it('closes at the first `||` a later line leaves open, so one-line spoilers on the lines between sit inside it (nesting)', () => {
    // Nesting is unclear in Discord: two spoilers with "b" shown, or one with "b" inside. One hides more.
    expect(parse('||a\n||b||\nc||')).toEqual([spoiler(line(t('a')), line(spoiler(t('b'))), line(t('c')))])
    expect(parse('||a\nx ||b|| y ||c||\nd||')).toEqual([spoiler(line(t('a')), line(t('x '), spoiler(t('b')), t(' y '), spoiler(t('c'))), line(t('d')))])
  })

  it('takes bars in inline code or a fence as a closer only when no bar outside code follows (a closer inside code)', () => {
    expect(parse('||a\n`b||`\nc||')).toEqual([spoiler(line(t('a')), line({ type: 'code', text: 'b||' }), line(t('c')))])
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

  it("hides to the closer from an opener on a quote's last line (Discord may end the spoiler with the quote)", () => {
    expect(parse('> a ||b\nc||')).toEqual([quote(line(t('a '))), spoiler(quote(line(t('b'))), line(t('c')))])
    expect(parse('> ||a\nb||')).toEqual([spoiler(quote(line(t('a'))), line(t('b')))])
    expect(parse('a ||b\n> c||\nd')).toEqual([line(t('a ')), spoiler(line(t('b')), quote(line(t('c')))), line(t('d'))])
  })

  it('keeps a >>> quote around what comes after the closer', () => {
    expect(parse('>>> a ||b\nc||\nd')).toEqual([quote(line(t('a '))), spoiler(quote(line(t('b')), line(t('c')))), quote(line(t('d')))])
    expect(parse('>>> a\nb ||c\nd||\ne')).toEqual([quote(line(t('a')), line(t('b '))), spoiler(quote(line(t('c')), line(t('d')))), quote(line(t('e')))])
    expect(parse('>>> a\n||b\nc||')).toEqual([quote(line(t('a'))), spoiler(quote(line(t('b')), line(t('c'))))])
    expect(parse('||a\n>>> b|| c\nd')).toEqual([spoiler(line(t('a')), quote(line(t('b')))), quote(line(t(' c')), line(t('d')))])
  })

  it('leaves out a quote that the cut leaves empty', () => {
    expect(parse('||a\n> b||')).toEqual([spoiler(line(t('a')), quote(line(t('b'))))])
    expect(parse('||a\n>>> b||')).toEqual([spoiler(line(t('a')), quote(line(t('b'))))])
  })

  it('reads the markers alone before an opener as words in it, and keeps a list item or heading with words before it', () => {
    expect(parse('- ||a\nb||')).toEqual([spoiler(line(t('- a')), line(t('b')))])
    expect(parse('# ||a\nb||')).toEqual([spoiler(line(t('# a')), line(t('b')))])
    expect(parse('1. ||a\nb||')).toEqual([spoiler(line(t('1. a')), line(t('b')))])
    expect(parse('  ||a\nb||')).toEqual([spoiler(line(t('  a')), line(t('b')))])
    expect(parse('> - ||a\n> b||')).toEqual([spoiler(quote(line(t('- a')), line(t('b'))))])
    expect(parse('||a\n**b||** ||c\nd||')).toEqual([spoiler(line(t('a')), line(t('**b'))), line(t('** ')), spoiler(line(t('c')), line(t('d')))])
    expect(parse('- one ||a\n- two||')).toEqual([list('one '), spoiler(line(t('a')), list('two'))])
    expect(parse('# Title ||a\nb||')).toEqual([{ type: 'heading', level: 1, children: [t('Title ')] }, spoiler(line(t('a')), line(t('b')))])
    expect(parse('-# small ||a\nb||')).toEqual([{ type: 'subtext', children: [t('small ')] }, spoiler(line(t('a')), line(t('b')))])
  })

  it('drops a closing line that is blank before its closer, and keeps one with markers', () => {
    expect(parse('||a\n  ||')).toEqual([spoiler(line(t('a')))])
    expect(parse('||a\n> ||\nb')).toEqual([spoiler(line(t('a'))), line(t('b'))])
    expect(parse('||a\n1. ||')).toEqual([spoiler(line(t('a')), { type: 'list', ordered: true, items: [{ marker: '1.', children: [line()] }] })])
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
    ['bars in inline code inside it', '||a `x`\n`||` b||', [spoiler(line(t('a '), { type: 'code', text: 'x' }), line({ type: 'code', text: '||' }, t(' b')))]],
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

describe('fail closed', () => {
  /** → the words Discord's spoiler rule hides if it pairs bars as text, each with the nearest `||` after it. */
  function lazyHidden(s) {
    const hidden = new Set()
    let at = s.indexOf('||')
    while (at !== -1) {
      const close = s.indexOf('||', at + 3)
      if (close === -1) break
      for (const word of s.slice(at + 2, close).match(WORD) ?? []) hidden.add(word)
      at = s.indexOf('||', close + 2)
    }
    return hidden
  }

  it('hides every word that bars read as text pair around, over any lines, quotes, lists and headings', () => {
    const token = fc.constantFrom('W', 'W', '||', '||', '\\|\\|')
    const lineOf = fc.tuple(fc.constantFrom('', '', '> ', '>>> ', '- ', '1. ', '# ', '-# '), fc.array(token, { maxLength: 5 }))
      .map(([prefix, parts]) => prefix + parts.join(' '))
    fc.assert(fc.property(fc.array(lineOf, { minLength: 1, maxLength: 10 }), (lines) => {
      const s = numbered(lines.join('\n'))
      const { hidden, shown } = exposure(parse(s))
      for (const word of lazyHidden(s)) expect(hidden, `${word} in ${JSON.stringify(s)}`).toContain(word)
      const first = s.indexOf('||')
      const last = s.lastIndexOf('||')
      for (const word of s.match(WORD) ?? []) {
        const at = s.search(new RegExp(`${word}(?!\\d)`))
        if (first === -1 || at < first || at > last) expect(shown, `${word} in ${JSON.stringify(s)}`).toContain(word)
      }
    }), { numRuns: 3000 })
  })

  it('hides exactly the words between each pair of bars, with code, fences, escapes and quotes around them', () => {
    // A piece is text and, for each W in it, whether a spoiler on its own line hides it.
    const piece = (text, ...hide) => ({ text, hide })
    const quietTokens = fc.array(fc.constantFrom(piece('W', false), piece('||W||', true), piece('`W||W`', false, false), piece('\\|\\|'), piece('**W**', false)), { minLength: 1, maxLength: 3 })
    const plainTokens = fc.array(fc.constantFrom(piece('W', false), piece('\\|\\|'), piece('**W**', false)), { maxLength: 3 })
    const join = (pieces, prefix = '') => ({ lines: [prefix + pieces.map((p) => p.text).join(' ')], hide: pieces.flatMap((p) => p.hide) })
    const prefix = fc.constantFrom('', '', '> ', '- ', '1. ', '# ')
    const quietLine = fc.tuple(quietTokens, prefix).map(([pieces, pre]) => join(pieces, pre))
    const fence = fc.tuple(quietTokens, fc.boolean()).map(([pieces, quoted]) => {
      const q = quoted ? '> ' : ''
      return { lines: [`${q}\`\`\``, q + pieces.map((p) => p.text).join(' '), `${q}\`\`\``], hide: pieces.flatMap((p) => p.hide.map(() => false)), quoted }
    })
    const block = fc.oneof(quietLine, fence, fc.constant({ lines: [''], hide: [] }))
    const region = fc.tuple(prefix, fc.option(quietTokens), plainTokens, fc.array(block, { maxLength: 3 }), prefix, fc.option(quietTokens), plainTokens)
      .map(([pre, before, after, inner, closePre, closeBefore, tail]) => {
        const head = before ? before.map((p) => p.text).join(' ') + ' ' : ''
        const closing = closeBefore ? closeBefore.map((p) => p.text).join(' ') + ' ' : ''
        const quoted = inner.some((b) => b.quoted)
        return {
          lines: [`${pre}${head}||${after.map((p) => p.text).join(' ')}`, ...inner.flatMap((b) => b.lines), `${closePre}${closing}W||${tail.map((p) => p.text).join(' ')}`],
          hide: [...(before ?? []).flatMap((p) => p.hide), ...after.flatMap((p) => p.hide.map(() => true)), ...inner.flatMap((b) => b.hide.map(() => true)), ...(closeBefore ?? []).flatMap((p) => p.hide.map(() => true)), true, ...tail.flatMap((p) => p.hide)],
          quoted,
        }
      })
    const any = fc.oneof(block, region, region)
    // Inside a >>> quote a quoted fence is no fence, so the deep part has none.
    const deep = fc.array(any, { maxLength: 3 }).filter((blocks) => !blocks.some((b) => b.quoted))
    fc.assert(fc.property(fc.array(any, { minLength: 1, maxLength: 5 }), fc.option(deep), (blocks, rest) => {
      const all = rest ? [...blocks, { lines: ['>>> W'], hide: [false] }, ...rest] : blocks
      const s = numbered(all.flatMap((b) => b.lines).join('\n'))
      const hide = all.flatMap((b) => b.hide)
      const { hidden, shown } = exposure(parse(s))
      const expected = { hidden: [], shown: [] }
      hide.forEach((h, i) => (h ? expected.hidden : expected.shown).push(`w${i}`))
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
