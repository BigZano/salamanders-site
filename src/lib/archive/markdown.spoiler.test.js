import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { maskSpoilers, parse, parseInline, plainText, SPOILER_MASK, walk } from './markdown'
import { parse as parseBefore } from './markdown-22b6793.fixture'
import { parse as parseBatch2, parseInline as parseInlineBatch2 } from './markdown-8a17c63.fixture'

// A spoiler that runs over lines, read so that it fails closed (the default), and the Legion Archive's one-line reading.
const E = '123456789012345678'
const ONE = { oneLine: true }
const EXT = { dialect: 'extended' }
const LS = String.fromCharCode(0x2028)
const ZWSP = String.fromCharCode(0x200b)
const t = (value) => ({ type: 'text', value })
const line = (...children) => ({ type: 'line', children })
const quote = (...children) => ({ type: 'quote', children })
const spoiler = (...children) => ({ type: 'spoiler', children })
// The one spoiler over lines: from the first bar of the first uncertain line to the last bar of the message.
const unit = (...children) => ({ type: 'spoiler', children, lastBar: true })
const list = (...texts) => ({ type: 'list', ordered: false, items: texts.map((text) => ({ marker: '-', children: [line(t(text))] })) })
const blank = { type: 'blank' }
const code = (text) => ({ type: 'code', text })
const WORD = /w\d+/g

/** → { hidden, shown }: the words (w0, w1, …) the nodes hold, by whether a spoiler holds them, each sorted. */
function exposure(nodes) {
  const hidden = []
  const shown = []
  const visit = (list, inside) => {
    for (const n of list) {
      const within = inside || n.type === 'spoiler'
      // A bare address shows its href; a masked link shows only its label.
      for (const word of [n.value, n.text, n.type === 'url' ? n.href : ''].join(' ').match(WORD) ?? []) (within ? hidden : shown).push(word)
      if (n.children) visit(n.children, within)
      if (n.items) for (const item of n.items) visit(item.children, within)
    }
  }
  visit(nodes, false)
  const order = (a, b) => Number(a.slice(1)) - Number(b.slice(1))
  return { hidden: hidden.sort(order), shown: shown.sort(order) }
}

/** Numbers each `W` in the text, in order: w0, w1, … */
function numbered(text) {
  let n = 0
  return text.replace(/W/g, () => `w${n++}`)
}

const words = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => `w${from + k}`)

describe('the two readings', () => {
  it('fails closed by default, and reads each line alone, as at 22b6793, with { oneLine: true }', () => {
    expect(parse('||a\nb||')).toEqual([unit(line(t('a')), line(t('b')))])
    expect(parse('||a\nb||', {})).toEqual(parse('||a\nb||'))
    expect(parse('||a\nb||', { oneLine: false })).toEqual(parse('||a\nb||'))
    expect(parse('||a\nb||', ONE)).toEqual([line(t('||a')), line(t('b||'))])
  })

  it.each([[null], ['yes'], [1], [true]])('refuses options %j that are no object', (options) => {
    expect(() => parse('a', options)).toThrow(new TypeError('markdown options must be an object'))
  })

  it.each([['yes'], [1], [null], [{}]])('refuses a oneLine %j that is no boolean', (oneLine) => {
    expect(() => parse('a', { oneLine })).toThrow(new TypeError('oneLine must be true or false'))
  })

  it('reads every text in the archive reading exactly as 22b6793 did', () => {
    const tokens = ['**', '*', '_', '__', '~~', '||', '|', '|||', '`', '```', '> ', '>>> ', '# ', '-# ', '- ', '1. ', '[', '](', ')', '<', '>',
      '\\', `<:e:${E}>`, `<@&${E}>`, 'https://a.io/x', 'word', ' ', '\\|', ZWSP, LS, '\n', '\n', '\r\n', '\r']
    fc.assert(fc.property(fc.array(fc.constantFrom(...tokens), { maxLength: 80 }), (parts) => {
      const s = parts.join('')
      expect(parse(s, ONE)).toEqual(parseBefore(s))
    }), { numRuns: 4000 })
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
      expect(parse(s, ONE)).toEqual(parseBefore(s))
    }), { numRuns: 2000 })
  })
})

describe('a spoiler that runs over lines', () => {
  it.each([
    ['two lines', '||ALPHA\nBRAVO||', [unit(line(t('ALPHA')), line(t('BRAVO')))]],
    ['a blank line between', '||ALPHA\n\nBRAVO||', [unit(line(t('ALPHA')), blank, line(t('BRAVO')))]],
    ['a quote between', '||ALPHA\n> quote\nBRAVO||', [unit(line(t('ALPHA')), quote(line(t('quote'))), line(t('BRAVO')))]],
    ['a list between', '||ALPHA\n- item\nBRAVO||', [unit(line(t('ALPHA')), list('item'), line(t('BRAVO')))]],
    ['a heading between', '||ALPHA\n## Head\nBRAVO||', [unit(line(t('ALPHA')), { type: 'heading', level: 2, children: [t('Head')] }, line(t('BRAVO')))]],
    ['a whole fence between, bars and all', '||a\n```\nx || y\n```\nb||', [unit(line(t('a')), { type: 'codeblock', lang: '', text: 'x || y' }, line(t('b')))]],
  ])('is one spoiler node: %s', (_, src, nodes) => {
    expect(parse(src)).toEqual(nodes)
  })

  it('keeps the words before its first bar and after its last outside it, on lines of their own', () => {
    expect(parse('before ||ALPHA\nBRAVO|| after')).toEqual([line(t('before ')), unit(line(t('ALPHA')), line(t('BRAVO'))), line(t(' after'))])
    expect(parse('||ALPHA\nBRAVO||\nCHARLIE')).toEqual([unit(line(t('ALPHA')), line(t('BRAVO'))), line(t('CHARLIE'))])
    expect(parse('x\n||a\nb||')).toEqual([line(t('x')), unit(line(t('a')), line(t('b')))])
  })

  it('reads the certain lines before the first uncertain one as they were', () => {
    expect(parse('a ||b|| c\n> ||d|| e\n||f\ng||')).toEqual([
      line(t('a '), spoiler(t('b')), t(' c')),
      quote(line(spoiler(t('d')), t(' e'))),
      unit(line(t('f')), line(t('g'))),
    ])
  })

  it('hides from the first bar of the first uncertain line to the last bar, certain lines and words between them too', () => {
    expect(exposure(parse('w0 ||w1\nw2|| w3\n||w4|| w5\n**w6** ||w7\nw8|| w9'))).toEqual({ hidden: words(1, 8), shown: ['w0', 'w9'] })
    expect(exposure(parse('w0 ||w1|| **w2** ||w3\nw4|| w5'))).toEqual({ hidden: words(1, 4), shown: ['w0', 'w5'] })
  })

  it('leaves the one-line parse when the first uncertain line holds the last bar', () => {
    for (const src of ['||a\nb', 'a ||b|| c\n**x ||y', 'a\n||', '**a ||b**\nc', 'x\n`a||b` ||c']) expect(parse(src), src).toEqual(parseBefore(src))
  })

  it.each([
    ['inline code', '`c`'], ['a backslash', '\\x'], ['italics', '*e*'], ['underscores', 'snake_case'], ['a strike', '~~s~~'],
    ['a link', '[l](https://a.io)'], ['a broken mention', '<@1234>'], ['an address', 'https://a.io/x'], ['three bars', 'a|||b'],
    ['four bars', 'a||||b'], ['a line separator', `a${LS}b`], ['an odd bar', '||'], ['a blank pair', '|| ||'],
  ])('reads a line with %s as uncertain', (_, x) => {
    expect(exposure(parse(`w0 ${x} ||w1|| w2\nw3 ||w4|| w5`))).toEqual({ hidden: words(1, 4), shown: ['w0', 'w5'] })
  })

  it.each([['a parenthesis', ')'], ['an angle bracket', '>'], ['a square bracket', ']']])(
    'reads a line with %s after its first bar as uncertain, and one with it only before as certain', (_, x) => {
      expect(exposure(parse(`w0 ||w1|| b${x} c ||w2||\nw3 ||w4|| w5`))).toEqual({ hidden: words(1, 4), shown: ['w0', 'w5'] })
      for (const src of [`(see${x} w0 ||w1|| w2\nw3 ||w4||`, `> a ${x} ||w0||\n||w1||`]) expect(parse(src), src).toEqual(parseBefore(src))
    },
  )

  it('reads a line with bars inside a fence as uncertain', () => {
    expect(exposure(parse('```\nw0 ||w1||\n```\nw2 ||w3|| w4'))).toEqual({ hidden: words(1, 3), shown: ['w0', 'w4'] })
  })

  it('finds the fences inside quotes as parseBlocks does, so bars in them are uncertain', () => {
    // A fence that opens on the >>> line itself, after its marker.
    expect(exposure(parse('x\n>>> ```\nw0 ||w1||\n```\nw2 ||w3||'))).toEqual({ hidden: words(1, 3), shown: ['w0'] })
    // A fence in a >>> quote that starts after other lines.
    expect(exposure(parse('x\n>>> a\n```\nw0 ||w1||\n```\nw2 ||w3||'))).toEqual({ hidden: words(1, 3), shown: ['w0'] })
    // A fence in a > quote, its lines read without their marker.
    expect(exposure(parse('> ```\n> w0 ||w1||\n> ```\nw2 ||w3||'))).toEqual({ hidden: words(1, 3), shown: ['w0'] })
  })

  it.each([['plain', ''], ['quote', '> '], ['heading', '# '], ['list item', '- '], ['numbered item', '1. '], ['subtext', '-# '], ['>>> quote', '>>> ']])(
    'reads a %s line whose bars pair within it as certain', (_, prefix) => {
      for (const src of [`${prefix}w0 ||w1|| w2\nw3 ||w4|| w5`, `${prefix}a | b ||w0|| || w1 || c\n||w2||`, `x\n${prefix}w0 ||w1||`]) {
        expect(parse(src), src).toEqual(parseBefore(src))
      }
    },
  )

  it('cuts a quote at the first bar and keeps the quote on both sides', () => {
    expect(parse('> a ||b\n> c||\n> d')).toEqual([quote(line(t('a '))), unit(quote(line(t('b')), line(t('c')))), quote(line(t('d')))])
    expect(parse('> ||a\n> b||\n> c')).toEqual([unit(quote(line(t('a')), line(t('b')))), quote(line(t('c')))])
    expect(parse("> a ||b\nc||")).toEqual([quote(line(t('a '))), unit(quote(line(t('b'))), line(t('c')))])
    expect(parse('a ||b\n> c||\nd')).toEqual([line(t('a ')), unit(line(t('b')), quote(line(t('c')))), line(t('d'))])
    expect(parse('||a\n> b||')).toEqual([unit(line(t('a')), quote(line(t('b'))))])
  })

  it('drops the >>> marker alone before the first bar, and keeps the quote', () => {
    expect(parse('>>> ||a\nb||')).toEqual([unit(quote(line(t('a')), line(t('b'))))])
    expect(parse('||a\n>>> ||\nc')).toEqual([unit(line(t('a'))), quote(line(t('c')))])
  })

  it('reads the lines after the last bar as blocks again, quotes too, but nests no quote in a quote it carries on', () => {
    expect(parse('||a\nb||\n> c\n>>> d')).toEqual([unit(line(t('a')), line(t('b'))), quote(line(t('c'))), quote(line(t('d')))])
    expect(parse('>>> ||a\nb||\n> c')).toEqual([unit(quote(line(t('a')), line(t('b')))), quote(line(t('> c')))])
    expect(parse('> a ||b\n> c||\n> > d')).toEqual([quote(line(t('a '))), unit(quote(line(t('b')), line(t('c')))), quote(line(t('> d')))])
  })

  it('leaves out a piece the bars leave blank', () => {
    expect(parse('||a\nb||   \nc')).toEqual([unit(line(t('a')), line(t('b'))), line(t('c'))])
    expect(parse('||   \na||')).toEqual([unit(line(t('a')))])
  })

  it('keeps a >>> quote around what comes after the last bar', () => {
    expect(parse('>>> a ||b\nc||\nd')).toEqual([quote(line(t('a '))), unit(quote(line(t('b')), line(t('c')))), quote(line(t('d')))])
    expect(parse('>>> a\nb ||c\nd||\ne')).toEqual([quote(line(t('a')), line(t('b '))), unit(quote(line(t('c')), line(t('d')))), quote(line(t('e')))])
    expect(parse('||a\n>>> b|| c\nd')).toEqual([unit(line(t('a')), quote(line(t('b')))), quote(line(t(' c')), line(t('d')))])
    expect(parse('||a\n>>> b||')).toEqual([unit(line(t('a')), quote(line(t('b'))))])
  })

  it('reads the markers alone before the first bar as words in it, and keeps a list item or heading with words before it', () => {
    expect(parse('- ||a\nb||')).toEqual([unit(line(t('- a')), line(t('b')))])
    expect(parse('# ||a\nb||')).toEqual([unit(line(t('# a')), line(t('b')))])
    expect(parse('1. ||a\nb||')).toEqual([unit(line(t('1. a')), line(t('b')))])
    expect(parse('  ||a\nb||')).toEqual([unit(line(t('  a')), line(t('b')))])
    expect(parse('> - ||a\n> b||')).toEqual([unit(quote(line(t('- a')), line(t('b'))))])
    expect(parse('- one ||a\n- two||')).toEqual([list('one '), unit(line(t('a')), list('two'))])
    expect(parse('# Title ||a\nb||')).toEqual([{ type: 'heading', level: 1, children: [t('Title ')] }, unit(line(t('a')), line(t('b')))])
    expect(parse('-# small ||a\nb||')).toEqual([{ type: 'subtext', children: [t('small ')] }, unit(line(t('a')), line(t('b')))])
  })

  it('drops a last line that is blank before its last bar, and keeps one with markers', () => {
    expect(parse('||a\n  ||')).toEqual([unit(line(t('a')))])
    expect(parse('||a\n> ||\nb')).toEqual([unit(line(t('a'))), line(t('b'))])
    expect(parse('||a\n1. ||')).toEqual([unit(line(t('a')), { type: 'list', ordered: true, items: [{ marker: '1.', children: [line()] }] })])
  })

  it('reads the pieces the bars cut as words, never as blocks', () => {
    expect(parse('||- a\nb||')).toEqual([unit(line(t('- a')), line(t('b')))])
    expect(parse('||a\nb|| # c')).toEqual([unit(line(t('a')), line(t('b'))), line(t(' # c'))])
    expect(parse('||a\nb||> c\nd')).toEqual([unit(line(t('a')), line(t('b'))), line(t('> c')), line(t('d'))])
    expect(parse('||a\nb||```\nc\n```')).toEqual([unit(line(t('a')), line(t('b'))), line(t('```')), line(t('c')), line(t('```'))])
  })
})

describe('a Discord mention, channel, role, emoji, timestamp or slash command beside the bars', () => {
  const NBSP = String.fromCharCode(0xa0)
  const tokens = () => {
    const [id17, id20] = ['12345678901234567', '12345678901234567890']
    return [
      `<@${E}>`, `<@!${id17}>`, `<@&${id20}>`, `<#${id17}>`, `<#${id20}>`, `<:gg:${id17}>`, `<a:g-g:${id20}>`, `<:${'a'.repeat(32)}:${E}>`,
      `<:A:${E}>`, '<t:1>', `<t:${'1'.repeat(17)}>`, '<t:-1700000000>', ...[...'tTdDfFR'].map((style) => `<t:1700000000:${style}>`),
      `</roll:${id17}>`, `</roll dice:${id20}>`, `</${'r'.repeat(32)} ${'d'.repeat(32)}:${E}>`, `</R-1:${E}>`,
    ]
  }
  const underscored = () => [`<:pepe_hands:${E}>`, `<a:_:${E}>`, `<:e__x:${E}>`, `</set_role:${E}>`, `</roll x_:${E}>`]
  const broken = () => {
    const [id16, id21] = ['1234567890123456', '123456789012345678901']
    return [
      `<@${id16}>`, `<@${id21}>`, `<#${id16}>`, `<#${id21}>`, `<@!&${E}>`, `<@ ${E}>`, `<@${E} >`, `<${E}>`, `<@${E}`, `<#${E}`, `<<@${E}>`, `<@${'１'.repeat(18)}>`,
      `<:${'a'.repeat(33)}:${E}>`, `<::${E}>`, `<:e.e:${E}>`, `<b:e:${E}>`, `<:e:${id16}>`, `<:e:${id21}>`, `<:e:${E}`,
      '<t:>', `<t:${'1'.repeat(18)}>`, '<t:1:X>', '<t:1:RR>', '<t:1:>', '<t:x>', '<t:--1>', '<T:1>',
      `</:${E}>`, `</a b c:${E}>`, `</a  b:${E}>`, '</a b:>', `</a:${id16}>`, `</a b:${id21}>`, `</${'r'.repeat(33)}:${E}>`, `</a\tb:${E}>`,
    ]
  }

  it.each([...tokens(), ...underscored()])('reads a line with %s before its first bar as certain', (x) => {
    for (const src of [`${x}||w0|| w1\nw2 ||w3||`, `w0${x} ||w1||\n||w2||`, `> ${x} w0 ||w1||\nw2 ||w3||`, `${x}${x}||w0||\n||w1||`]) {
      expect(parse(src), src).toEqual(parseBefore(src))
    }
  })

  it.each(tokens())('reads a line with %s after its first bar as certain when a space comes earlier on the line', (x) => {
    for (const src of [`w0 ||w1||${x}\nw2 ||w3||`, `||w0|| ${x}||w1||\n||w2||`, `a ||w0|| b${x}c\n||w1||`, `a ||w0||${x}${x}\n||w1||`]) {
      expect(parse(src), src).toEqual(parseBefore(src))
    }
  })

  it.each(tokens().filter((x) => !x.includes(' ')))('reads a line with %s after its first bar and no space before it as uncertain, a tab or a no-break space before it too', (x) => {
    for (const gap of ['', '\t', NBSP]) {
      expect(exposure(parse(`w0${gap}||w1||${gap}${x} w2\nw3 ||w4|| w5`)), gap).toEqual({ hidden: words(1, 4), shown: ['w0', 'w5'] })
      expect(exposure(parse(`w0${gap}||w1||${gap}${x}\nw2 ||w3||`)), gap).toEqual({ hidden: words(1, 3), shown: ['w0'] })
    }
  })

  // The leading run of a line, whose spaces a quote's or a list item's text loses: spaces, tabs and `>`, and any other white space.
  const leads = ['> ', '>', '  > ', '> > ', '>>> ', '  ', '\t', ' \t> ', `${NBSP}> `, ` ${NBSP}> `, `${NBSP} `, '\u3000> ', '\u2003 ']
  it.each(leads)('counts no space of a leading %j before a token after the first bar', (lead) => {
    for (const x of [`<@${E}>`, `<:gg:${E}>`, '<t:1:R>', `</roll:${E}>`]) {
      expect(exposure(parse(`${lead}w0||w1||${x} w2\nw3 ||w4|| w5`)), x).toEqual({ hidden: words(1, 4), shown: ['w0', 'w5'] })
    }
  })

  it.each(['> - ', '- ', '1. ', '# ', '-# ', '> a '])('counts the space of a leading %j before a token after the first bar', (lead) => {
    const src = numbered(`${lead}W||W||<@${E}>\nW ||W||`)
    expect(parse(src), src).toEqual(parseBefore(src))
  })

  it('reads a line with a slash command and its subcommand after its first bar as certain, the space in it before its >', () => {
    for (const src of [`w0||w1||</roll dice:${E}>\nw2 ||w3||`, `w0\t||w1||</roll dice:${E}><@${E}>\n||w2||`]) expect(parse(src), src).toEqual(parseBefore(src))
    expect(exposure(parse(`w0||w1||</roll_dice x:${E}>\nw2 ||w3||`))).toEqual({ hidden: words(1, 3), shown: ['w0'] })
  })

  it('reads a pair that holds nothing but a token as no blank pair', () => {
    for (const src of [`a || <@${E}> ||\n||w0||`, `<t:1> ||<t:1>||\n||w0||`]) expect(parse(src), src).toEqual(parseBefore(src))
  })

  it.each(underscored())('reads a line with %s after its first bar as uncertain, a space before it or not', (x) => {
    expect(exposure(parse(`w0 ||w1|| ${x} w2\nw3 ||w4|| w5`))).toEqual({ hidden: words(1, 4), shown: ['w0', 'w5'] })
  })

  it.each(broken())('reads a line with %s as uncertain, before its first bar or after it', (x) => {
    for (const src of [`w0 ${x} ||w1|| w2\nw3 ||w4|| w5`, `w0 ||w1|| ${x} w2\nw3 ||w4|| w5`]) {
      expect(exposure(parse(src)), src).toEqual({ hidden: words(1, 4), shown: ['w0', 'w5'] })
    }
  })

  it.each([
    ['a reply that opens with a mention', `<@${E}> ||w0 w1||\nw2 w3\nw4 ||w5||`, ['w2', 'w3', 'w4']],
    ['an emoji after a spoiler', `w0 ||w1|| <:gg:${E}>\nw2\n||w3||`, ['w0', 'w2']],
    ['an emoji with an underscore before a spoiler', `<:pepe_hands:${E}> w0 ||w1||\nw2\n||w3||`, ['w0', 'w2']],
    ['a timestamp before a spoiler', `w0 <t:1700000000:R> ||w1||\nw2 w3\n||w4||`, ['w0', 'w2', 'w3']],
    ['a role and a channel round a spoiler', `<@&${E}> w0 ||w1|| in <#${E}>\nw2\n||w3||`, ['w0', 'w2']],
    ['a slash command after a spoiler', `w0 ||w1|| try </roll dice:${E}>\nw2\n||w3||`, ['w0', 'w2']],
    ['mentions on every line', `<@${E}> ||w0||\n<@${E}> w1\n<@!${E}> ||w2|| <@${E}>`, ['w1']],
    ['an emoji after a spoiler in a quote', `> w0 ||w1|| <:gg:${E}>\n> w2\n> ||w3||`, ['w0', 'w2']],
    ['a mention after a spoiler in a list, the bullet spaced', `- w0||w1||<@${E}>\n- w2\n- ||w3||`, ['w0', 'w2']],
    ['a mention after a spoiler under a heading marker', `# w0||w1||<@${E}>\nw2\n||w3||`, ['w0', 'w2']],
  ])('shows what lies between the spoilers now: %s', (_, src, shown) => {
    const all = src.match(WORD)
    expect(exposure(parse(src))).toEqual({ hidden: all.filter((w) => !shown.includes(w)), shown })
    expect(parse(src)).toEqual(parseBefore(src))
  })
})

describe('hostile input', () => {
  it.each([
    ['`||` at the end of a line and the start of the next', 'a ||\nb\n|| c', [line(t('a ')), unit(line(t('b'))), line(t(' c'))]],
    ['`||` on a line of its own, twice', '||\n||', [unit()]],
    ['`|||` on both lines', '|||a\nb|||', [unit(line(t('|a')), line(t('b|')))]],
    ['`||||` opens at its first bar', '||||\nx||', [unit(line(t('||')), line(t('x')))]],
    ['a last bar escaped by half', '||a\nb\\||', [unit(line(t('a')), line(t('b\\')))]],
    ['a first bar escaped by half', '\\||a\nb||', [line(t('\\')), unit(line(t('a')), line(t('b')))]],
    ['CRLF', '||a\r\nb||', [unit(line(t('a')), line(t('b')))]],
    ['a lone CR', '||a\rb||', [unit(line(t('a')), line(t('b')))]],
    ['ZWSP inside the bars', `||${ZWSP}a\nb${ZWSP}||`, [unit(line(t(`${ZWSP}a`)), line(t(`b${ZWSP}`)))]],
    ['an opener at EOF after a closed one', '||a\nb||\n||', [unit(line(t('a')), line(t('b||')))]],
    ['bars in inline code inside it', '||a `x`\n`||` b||', [unit(line(t('a '), code('x')), line(code('||'), t(' b')))]],
    ['bars on two lines of a fence (Discord may not read it as code)', '```\n||a\nb||\n```', [line(t('```')), unit(line(t('a')), line(t('b'))), line(t('```'))]],
  ])('%s', (_, src, nodes) => {
    expect(parse(src)).toEqual(nodes)
  })

  it.each([
    ['an opener nothing closes', '||a\nb'],
    ['an opener at EOF', 'a\n||'],
    ['an opener with only blank lines after it', 'a ||b\n\nc'],
    ['escaped bars', '\\|\\|a\nb||'],
    ['escaped bars at the end', '||a\nb\\|\\|'],
    ['ZWSP between the bars', `|${ZWSP}|a\nb||`],
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
    ['100k certain lines', Array.from({ length: 100_000 }, () => 'a ||b|| c').join('\n')],
    ['100k certain lines of tokens', Array.from({ length: 100_000 }, () => `<@${E}> ||b|| <:gg:${E}>`).join('\n')],
    ['100k tokens after a bar, a space before them', `a ||b|| ${`<@${E}>`.repeat(100_000)}\n||c||`],
    ['100k tokens after a bar, no space before them', `||b||${`<t:1:R>`.repeat(100_000)}\n||c||`],
  ])('%s parse in bounded time', (_, s) => {
    const budget = globalThis.__stryker__ ? 60_000 : 6000
    const at = performance.now()
    expect(() => parse(s)).not.toThrow()
    expect(performance.now() - at).toBeLessThan(budget)
  }, 120_000)
})

describe('what the reviews found shown, hidden now', () => {
  it.each([
    ['an opener in bold', '**w0 ||w1**\n||w2\nw3||', ['w0']],
    ['an opener on a quote line', '> ||w0\n||w1\nw2||', []],
    ['an opener in a heading', '# w0 ||w1\n||w2\nw3||', ['w0']],
    ['a bar in inline code between', '||w0\n`w1||` ||w2\nw3|| w4', ['w4']],
    ['a bar in a fence between', '||w0\n```\nw1||\n```\n||w2\nw3||', []],
    ['a half-escaped bar between', '||w0\nw1 \\|| w2 ||w3\nw4||', []],
    ['a bar in code, then words after it', '||w0\n`w1||w2`\nw3|| w4\n||w5\nw6||', []],
    ['a bar in a link label between', '||w0\n[w1 ||w2](https://a.io) w3||\n||w4\nw5|| w6', ['w6']],
    ['four bars before the opener', '||||w0||\nw1|| w2\n||w3', ['w3']],
    ['five bars', '|||||w0\nw1|| w2\n||w3\nw4||', []],
    ['bold over lines round the opener', '**w0\n||w1**\nw2|| w3\nw4||', ['w0']],
    ['italics over lines round the opener', '*w0\n||w1*\nw2|| w3\nw4||', ['w0']],
    ['bold over lines after the opener', '**w0 ||w1\nw2** w3|| w4\n||w5', ['w0', 'w5']],
    ['inline code over lines', '`w0\nw1 ||w2`\nw3|| w4\nw5||', ['w0', 'w1']],
    ['bold over lines between two spoilers', '||w0\nw1|| **w2\n||w3**\nw4|| w5\nw6||', []],
    ['a code block that closes mid-line', '```\nx ||w0\ny```\nw1 ||w2\nw3||', []],
    ['a code block that opens mid-line', 'see ```\nx ||w0\n```\nw1 ||w2\nw3||', []],
    ['a bar in a fence the site reads as code', '```\na``` ||w0\n```\nw1 ||w2\nw3||', []],
    ['the one-line code rule', '`a ||w0``\nw1|| w2\n||w3\nw4||', []],
    ['the one-line em rule', '*w0 **x** ||w1*\nw2|| w3\nw4||', ['w0']],
    ['a bare > in a quote', '> ||w0\n>\n> w1|| w2\n> w3||', []],
    ['a list item running on', '- w0\n||w1\n\nw2|| w3\n||w4\nw5||', ['w0']],
    ['a link title over lines', '[x](https://a.io "\n|| " ) ||w0\nw1||\nw2 ||w3||', []],
    ['a link address over lines', '[x](https://a.io/(\n|| )) ||w0\nw1||\nw2 ||w3||', []],
    ['a link title over lines, with the last bar next', '[x](https://a.io "\n|| " ) ||w0\nw1||', []],
    ['an autolink over lines', '<x:/a\nb||c>||d||e||w0\nw1||', []],
    ['a mailto autolink over lines', '<a\nb||c@d>||e||f||w0\nw1||', []],
    // A token's `>` may end an angle form begun on an earlier line, and a `_` in its name may end a span begun there.
    ['a mailto over lines that ends at a mention', `<w0\nw1||w2<@${E}> ||w3\nw4||`, ['w0', 'w1']],
    ['an autolink over lines that ends at a channel', `<x:/w0\nw1||w2<#${E}> ||w3\nw4||`, ['w0', 'w1']],
    ['a mailto over lines that ends at a mention on the bar', `<w0\nw1||<@${E}> ||w2\nw3||`, ['w0', 'w1']],
    ['a mailto over lines that ends at an emoji', `<w0@\nw1||w2<:gg:${E}> ||w3\nw4||`, ['w0', 'w1']],
    ['a mailto over lines that ends at a timestamp', `<w0@x\nw1||w2<t:1:R> ||w3\nw4||`, ['w0', 'w1']],
    ['a mailto over lines that ends at a slash command', `<w0@x\nw1||w2</roll:${E}> ||w3\nw4||`, ['w0', 'w1']],
    ['a mailto over lines that ends at a mention after a tab', `<w0\nw1\t||w2\t<@${E}> ||w3\nw4||`, ['w0', 'w1']],
    ['italics over lines that end in an emoji name', `_w0\nw1 ||w2 <:e_:${E}> ||w3\nw4||`, ['w0', 'w1']],
    ['an underline over lines that ends in an emoji name', `__w0\nw1 ||w2 <:e__x:${E}> ||w3\nw4||`, ['w0', 'w1']],
    ['italics over lines that end in a slash command', `_w0\nw1 ||w2 </a_:${E}> ||w3\nw4||`, ['w0', 'w1']],
    ["the site's own italics between two slash commands", `</_a:${E}> ||w0 </b_:${E}> w1||\nw2\n||w3||`, []],
    // A quote's or a list item's text is read again without its lines' leading spaces, tabs and `>`, so their spaces don't count.
    ['a mailto over quote lines that ends at a mention', `> <w0\n> w1||w2<@${E}>||w3\n> w4||`, ['w0', 'w1']],
    ['a mailto over quote lines that ends at a mention, the last bar next', `> <w0\n> w1||w2<@${E}>||\n> w3||`, ['w0', 'w1']],
    ['a mailto over quote lines that ends at a mention on the bar', `> <w0\n> ||<@${E}> ||w1\n> w2||`, ['w0']],
    ['an autolink over quote lines that ends at a channel', `> <x:/w0\n> w1||w2<#${E}>||w3\n> w4||`, ['w0', 'w1']],
    ['a mailto over quote lines that ends at an emoji', `> <w0@\n> w1||w2<:gg:${E}>||w3\n> w4||`, ['w0', 'w1']],
    ['a mailto over quote lines that ends at a role', `> <w0@\n> w1||w2<@&${E}>||w3\n> w4||`, ['w0', 'w1']],
    ['a mailto over quote lines that ends at a nickname mention', `> <w0@\n> w1||w2<@!${E}>||w3\n> w4||`, ['w0', 'w1']],
    ['a mailto over quote lines that ends at a timestamp', `> <w0@\n> w1||w2<t:1:R>||w3\n> w4||`, ['w0', 'w1']],
    ['a mailto over quote lines that ends at a slash command', `> <w0@\n> w1||w2</roll:${E}>||w3\n> w4||`, ['w0', 'w1']],
    ['a mailto over quote lines with spaces before the markers', `  > <w0\n  > w1||w2<@${E}>||w3\n  > w4||`, ['w0', 'w1']],
    ['a mailto over quote lines, CRLF', `> <w0\r\n> w1||w2<@${E}>||w3\r\n> w4||`, ['w0', 'w1']],
    ['a mailto over nested quote markers', `> > <w0\n> > w1||w2<@${E}>||w3\n> > w4||`, ['w0', 'w1']],
    ['a heart in a quoted reply', `> gg w0 <3\n> w1||w2<@${E}> ||w3 w4\n> w5|| w6`, ['w0', 'w1', 'w6']],
    ['a mailto over a list item', `- <w0\n  w1||w2<@${E}>||w3\n  w4||`, ['w0', 'w1']],
    ['a mailto over a numbered list item', `1. <w0\n   w1||w2<@${E}>||w3\n   w4||`, ['w0', 'w1']],
    ['a mailto over a list item in a quote', `> - <w0\n>   w1||w2<@${E}>||w3\n>   w4||`, ['w0', 'w1']],
    ['a mailto over a list item indented with a tab, read as spaces', `100. <w0\n\t w1||w2<@${E}>||w3\n\t w4||`, ['w0', 'w1']],
    // No reading known cuts more than spaces, tabs and `>` there, but the site skips every white space, in case one does.
    ['a mailto over quote lines that a no-break space starts', `> <w0\n\u00a0> w1||w2<@${E}>||w3\n\u00a0> w4||`, ['w0', 'w1']],
    ['a mailto over quote lines that an ideographic space starts', `> <w0\n\u3000> w1||w2<@${E}>||w3\n\u3000> w4||`, ['w0', 'w1']],
    ['a mailto over a list item indented with a no-break space and a space', `- <w0\n\u00a0 w1||w2<@${E}>||w3\n\u00a0 w4||`, ['w0', 'w1']],
  ])('%s', (_, src, shown) => {
    const all = src.match(WORD)
    expect(exposure(parse(src))).toEqual({ hidden: all.filter((w) => !shown.includes(w)).sort((a, b) => a.slice(1) - b.slice(1)), shown })
  })
})

describe('unchanged where every bar pairs on its line', () => {
  const tokens = ['**', '*', '_', '__', '~~', '||', '|', '`', '```', '> ', '>>> ', '# ', '-# ', '- ', '1. ', '[', '](', ')', '<', '>', '\\',
    `<:e:${E}>`, `<@&${E}>`, 'https://a.io/x', 'word', ' ', '\\|', ZWSP]
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
  it('parses every text whose lines with bars are all certain exactly as before', () => {
    const tok = fc.constantFrom('W', 'W.', '||W||', '||W W||', '|| W ||', 'a | b', '#', '-', '(x', '!', '?', '@here', ':e:', '1.', `<@${E}>`,
      `<#${E}>`, `<a:gg:${E}>`, '<t:1700000000:R>', `</roll dice:${E}>`)
    const lineOf = fc.tuple(fc.constantFrom('', '', '> ', '>>> ', '- ', '1. ', '# ', '-# ', '  '), fc.array(tok, { maxLength: 6 }))
      .map(([prefix, parts]) => prefix + parts.join(' '))
    fc.assert(fc.property(fc.array(lineOf, { minLength: 1, maxLength: 10 }), (lines) => {
      const s = numbered(lines.join('\n'))
      expect(parse(s)).toEqual(parseBefore(s))
    }), { numRuns: 3000 })
  })
})

describe('fail closed', () => {
  /**
   * One reading of Discord over the whole message: a lazy scan in the way of its markdown rules, each spoiler a `||` and
   * the nearest `||` at least one character on, with the rules that may hold bars switched on or off: code blocks (none,
   * the site's fence lines, or open and close at any ```), inline code (none, on one line, or over lines), spans `**`
   * `__` `~~` `*` `_` (none, on one line, or over lines; an em that may hold a `**` or not), escapes, masked links and
   * angle forms (none, on one line, or over lines: a link's label is read, its address, with `( … )` in it, and its
   * title are not; an autolink `<…:/…>` or `<…@…>` is not read), Discord's tokens (mentions, channels, roles, emoji,
   * timestamps and slash commands read whole, or not at all, so that a span may start in one), and blocks (one flow;
   * each quote, heading, subtext and list item read alone and the lines around them apart; or every line read again
   * without its leading white space and `>`, as a quote's or a list item's text is without its spaces, tabs and `>` (and
   * as a reading that cut any other white space there would read it), and a list item, heading or subtext starting a text
   * of its own without its marker).
   * → [start, end) of each stretch it hides, in the message.
   */
  function readingHides(lines, code, o) {
    const starts = []
    lines.reduce((at, l, k) => (starts.push(at), at + l.length + 1), 0)
    const shown = lines.map((l, k) => (o.fence === 'lines' && code[k] ? 'x'.repeat(l.length) : l))
    const out = []
    const SPANS = ['**', '__', '~~', '*', '_']
    // → where a masked link that starts at `at` ends (just past its `)`), or -1: `[label](address "title")`.
    const linkEnd = (s, at, over) => {
      const ok = (from, to) => over || !s.slice(from, to).includes('\n')
      const close = s.indexOf(']', at + 1)
      if (close === -1 || s[close + 1] !== '(' || !ok(at, close)) return -1
      for (let k = close + 2; k < s.length; k++) {
        if (s[k] === ')') return ok(close, k) ? k + 1 : -1
        if (s[k] === '(') {
          const inner = s.indexOf(')', k)
          if (inner === -1) return -1
          k = inner
        } else if (/\s/.test(s[k]) && /["']/.test(s[k + 1] ?? '')) {
          const end = s.indexOf(s[k + 1], k + 2)
          const shut = end === -1 ? -1 : s.slice(end + 1).search(/\S/)
          if (shut === -1 || s[end + 1 + shut] !== ')') return -1
          return ok(close, end + 1 + shut) ? end + 2 + shut : -1
        }
      }
      return -1
    }
    const scan = (s, base) => {
      const closeOf = (d, from, over) => {
        const e = s.indexOf(d, from)
        return e === -1 || (!over && s.slice(from, e).includes('\n')) ? -1 : e
      }
      for (let i = 0; i < s.length; ) {
        if (o.escapes && s[i] === '\\') {
          i += 2
          continue
        }
        if (o.tokens && s[i] === '<') {
          DISCORD_TOKEN.lastIndex = i
          if (DISCORD_TOKEN.test(s)) {
            i = DISCORD_TOKEN.lastIndex
            continue
          }
        }
        if (o.fence === 'mid' && s.startsWith('```', i)) {
          const e = s.indexOf('```', i + 3)
          if (e !== -1) {
            i = e + 3
            continue
          }
        }
        if (o.code !== 'none' && s[i] === '`') {
          const e = closeOf('`', i + 1, o.code === 'over')
          if (e !== -1) {
            i = e + 1
            continue
          }
        }
        if (o.raw !== 'none' && s[i] === '[') {
          const end = linkEnd(s, i, o.raw === 'over')
          if (end !== -1) {
            scan(s.slice(i + 1, s.indexOf(']', i)), base + i + 1)
            i = end
            continue
          }
        }
        if (o.raw !== 'none' && s[i] === '<') {
          const e = s.indexOf('>', i + 1)
          const inner = e === -1 ? '' : s.slice(i + 1, e)
          if (inner && !inner.includes(' ') && (o.raw === 'over' || !inner.includes('\n')) && /:\/|@/.test(inner)) {
            i = e + 1
            continue
          }
        }
        if (s.startsWith('||', i)) {
          const e = s.indexOf('||', i + 3)
          if (e !== -1) {
            out.push([base + i, base + e + 2])
            i = e + 2
            continue
          }
        }
        const d = o.spans === 'none' ? undefined : SPANS.find((x) => s.startsWith(x, i))
        if (d) {
          let e = closeOf(d, i + d.length, o.spans === 'over')
          while (d === '*' && o.em === 'skip' && e !== -1 && s[e + 1] === '*') e = closeOf('*', e + 2, o.spans === 'over')
          if (e > i + d.length) {
            scan(s.slice(i + d.length, e), base + i + d.length)
            i = e + d.length
            continue
          }
        }
        i++
      }
    }
    if (o.blocks === 'flow') {
      scan(shown.join('\n'), 0)
      return out
    }
    if (o.blocks === 'content') {
      // The text read so far, and where each of its characters lies in the message.
      let text = ''
      let at = []
      let started = false
      const flush = () => {
        const from = out.length
        scan(text, 0)
        for (const stretch of out.slice(from)) stretch.splice(0, 2, at[stretch[0]], at[stretch[1] - 1] + 1)
        text = ''
        at = []
        started = false
      }
      shown.forEach((l, k) => {
        const lead = /^[\s>]*/.exec(l)[0].length
        const marker = /^(?:[-*+]|\d{1,9}\.|#{1,3}|-#) +/.exec(l.slice(lead))
        if (marker) flush()
        else if (started) {
          text += '\n'
          at.push(starts[k] - 1)
        }
        const from = lead + (marker ? marker[0].length : 0)
        text += l.slice(from)
        for (let c = from; c < l.length; c++) at.push(starts[k] + c)
        started = true
      })
      flush()
      return out
    }
    let deep = false
    const key = lines.map((l, k) => {
      deep ||= !code[k] && l.startsWith('>>> ')
      const quoted = !deep && (l.startsWith('> ') || l === '>')
      const own = quoted ? l.slice(2) : l.replace(/^>>> /, '')
      if (!code[k] && /^[ \t]*(?:#{1,3} +\S|-# +\S|(?:[-*]|\d{1,9}\.) +)/.test(own)) return `alone${k}`
      return deep ? 'deep' : quoted ? 'quote' : 'plain'
    })
    for (let k = 0; k < lines.length; ) {
      let end = k + 1
      while (end < lines.length && key[end] === key[k] && !key[k].startsWith('alone')) end++
      scan(shown.slice(k, end).join('\n'), starts[k])
      k = end
    }
    return out
  }

  // Discord's own token rules, wider than the site's: any id, an emoji's name in \w, a slash command with up to two more words.
  const DISCORD_TOKEN = /<(?:@[!&]?\d+|#\d+|a?:\w+:\d+|t:-?\d{1,17}(?::[tTdDfFR])?|\/[\w-]{1,32}(?: [\w-]{1,32}){0,2}:\d+)>/y
  const READINGS = []
  for (const fence of ['none', 'lines', 'mid']) {
    for (const code of ['none', 'line', 'over']) {
      for (const [spans, em] of [['none', 'near'], ['line', 'near'], ['line', 'skip'], ['over', 'near'], ['over', 'skip']]) {
        for (const escapes of [true, false]) {
          for (const blocks of ['flow', 'alone', 'content']) {
            for (const raw of ['none', 'line', 'over']) for (const tokens of [true, false]) READINGS.push({ fence, code, spans, em, escapes, blocks, raw, tokens })
          }
        }
      }
    }
  }

  it('has readings that hide what the reviews found behind a link, an angle form or a span over lines', () => {
    for (const [s, word] of [
      ['[x](https://a.io "\n|| " ) ||w0\nw1||\nw2 ||w3||', 'w0'], ['[x](https://a.io/(\n|| )) ||w0\nw1||\nw2 ||w3||', 'w0'],
      ['<x:/a\nb||c>||d||e||w0\nw1||', 'w0'], ['<a\nb||c@d>||e||f||w0\nw1||', 'w0'], [`<w0\nw1||w2<@${E}> ||w3\nw4||`, 'w3'],
      [`_w0\nw1 ||w2 <:e_:${E}> ||w3\nw4||`, 'w3'], [`</_a:${E}> ||w0 </b_:${E}> w1||\nw2\n||w3||`, 'w0'],
      [`> <w0\n> w1||w2<@${E}>||w3\n> w4||`, 'w3'], [`- <w0\n  w1||w2<@${E}>||w3\n  w4||`, 'w3'], [`100. <w0\n\t w1||w2<@${E}>||w3\n\t w4||`, 'w3'],
    ]) {
      const lines = s.split('\n')
      const stretches = READINGS.flatMap((o) => readingHides(lines, lines.map(() => false), o))
      expect(stretches.some(([a, b]) => s.indexOf(word) >= a && s.indexOf(word) < b), s).toBe(true)
    }
  })

  /** → messages of the union oracle's alphabet: { s, lines, codeLines }, the text, its lines, and which of them the fences hold. */
  function messages() {
    const tok = fc.constantFrom('W', 'W', '||', '||', '||W||', '`W||W`', '`W`', '`', '```', '\\||', '\\|\\|', '**W ||W**', '*W ||W*', '**', '*', '_',
      '~~', '[W ||W](https://a.io)', '**W**', '|||', '||||', '|||||', 'W|W', '[W](https://a.io "', '" )', '[W](https://a.io/(', '))', ')',
      '"', '[W', '](https://a.io)', '(W', '<x:/W', 'W>', '<W', '@W>', '>', ']', `<@${E}>`, `<:e_:${E}>`, '<t:1:R>', `</a b:${E}>`)
    const text = fc.tuple(fc.constantFrom('', '', '> ', '>', '>>> ', '- ', '1. ', '# ', '-# '), fc.array(tok, { maxLength: 5 }))
      .map(([prefix, parts]) => ({ lines: [prefix + parts.join(' ')], code: [false] }))
    const fence = fc.tuple(fc.boolean(), fc.array(tok, { minLength: 1, maxLength: 4 })).map(([quoted, parts]) => ({ quoted, body: parts.join(' ') }))
    const blank = fc.constant({ lines: [''], code: [false] })
    // A link, a title or an autolink left open on a line with no bars, and the next line, which may close it among bars.
    const runOn = fc.tuple(
      fc.constantFrom('[W](https://a.io "', '[W](https://a.io/(', "[W](https://a.io '", '<x:/W', '<W', '[W'),
      fc.array(fc.constantFrom('||', '||', 'W', '" )', "' )", '))', ')', 'W>', '@W>', '](https://a.io)'), { minLength: 2, maxLength: 7 }),
      fc.constantFrom(' ', ''),
    ).map(([open, parts, gap]) => ({ lines: [open, parts.join(gap)], code: [false, false] }))
    // Discord tokens before, at and after a line's first bar, a space, a tab or nothing before each, after a line that may
    // leave an angle form or a span open, both lines in one quote, one list item or neither.
    const token = fc.constantFrom(`<@${E}>`, `<#${E}>`, `<@&${E}>`, `<:e:${E}>`, `<:e_:${E}>`, `<a:e__x:${E}>`, '<t:1:R>', `</a:${E}>`,
      `</a b:${E}>`, `</_a:${E}>`, `</a_:${E}>`, '<@1>')
    const run = (part, maxLength) => fc.array(fc.tuple(fc.constantFrom('', '', '\t', ' '), part), { maxLength }).map((parts) => parts.flat().join(''))
    const tokens = fc.tuple(
      fc.oneof(
        fc.constant(['', '']),
        fc.constantFrom(['> ', '> '], [' > ', ' > '], ['> > ', '> > '], ['>>> ', '']),
        fc.constantFrom(['- ', '  '], ['- ', '- '], ['> - ', '>   '], ['1. ', '   ']),
        // A tab is read as spaces, and a list item's lines lose as many as its marker is wide.
        fc.constantFrom(['100. ', '\t '], ['- ', '\t '], ['\t', '\t '], ['> ', '>\t ']),
        // Other white space before the markers, which the site skips too.
        fc.constantFrom(['> ', '\u00a0> '], ['\u00a0> ', '\u00a0> '], ['\u3000> ', '\u3000> '], ['- ', '\u00a0 ']),
      ),
      fc.constantFrom('', '<W', '<x:/W', 'W<W@', '_W', '__W', '[W](<W'),
      run(fc.oneof(fc.constant('W'), token), 2),
      run(fc.constant('W'), 2),
      fc.constantFrom('', '', '\t', ' '),
      token,
      run(fc.oneof(fc.constantFrom('||', '||', 'W'), token), 5),
    ).map(([[first, then], open, head, mid, gap, tok, tail]) => {
      const body = `${head}||${mid}${gap}${tok}${tail}`
      return open ? { lines: [first + open, then + body], code: [false, false] } : { lines: [first + body], code: [false] }
    })
    return fc.array(fc.oneof(text, text, fence, blank, runOn, tokens, tokens, tokens), { minLength: 1, maxLength: 7 }).map((blocks) => {
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
      const lines = s.split('\n')
      const codeLines = all.flatMap((b) => b.code)
      return { s, lines, codeLines }
    })
  }

  it('hides every word any reading of Discord, or the site line by line, hides', () => {
    fc.assert(fc.property(messages(), ({ s, lines, codeLines }) => {
      const stretches = READINGS.flatMap((o) => readingHides(lines, codeLines, o))
      const byLine = new Set(exposure(parseBefore(s)).hidden)
      const nodes = parse(s)
      const { hidden, shown } = exposure(nodes)
      const first = s.indexOf('||')
      const last = s.lastIndexOf('||')
      // The last line with bars keeps its one-line parse when it is the first that is not certain (the ruling: a reading
      // may differ within that one line, as before). So a stretch that starts on it is not held against the site then, and
      // only then: on a certain last line, as on a one-line message, every stretch is held. A stretch that starts before it
      // is held whatever the parse says. Whether the last line is uncertain is read from the text with one more line of
      // bars, which makes a unit of that line exactly when it is not certain (a line added after changes no earlier role).
      const lastLine = s.lastIndexOf('\n', last) + 1
      const uncertainLast = !nodes.some((n) => n.lastBar) && parse(`${s}\n||`).some((n) => n.lastBar)
      const held = stretches.filter(([a]) => a < lastLine || !uncertainLast)
      for (const m of s.matchAll(WORD)) {
        const why = `${m[0]} in ${JSON.stringify(s)}`
        if (byLine.has(m[0]) || held.some(([a, b]) => m.index >= a && m.index < b)) expect(hidden, why).toContain(m[0])
        if (first === -1 || m.index < first || m.index > last + 1) expect(shown, why).toContain(m[0])
      }
    }), {
      numRuns: globalThis.__stryker__ ? 150 : 1500,
      // A certain() that let code through would read this one-line message as certain, and so be held to every reading of
      // it: one that reads no code pairs `||w1` || ` and hides w1.
      examples: [[{ s: '`w0||w1` || w2', lines: ['`w0||w1` || w2'], codeLines: [false] }]],
    })
    // 1620 readings a document: well past vitest's 5 s default under coverage.
  }, 300_000)

  it('hides exactly what lies between the first bar of the first uncertain line and the last bar, after certain lines', () => {
    const certainTok = fc.constantFrom('W', 'W', '||W||', '|| W ||', 'a | W', `<@${E}>`, `<:gg:${E}>`, '<t:1:R>')
    const certainLine = fc.tuple(fc.constantFrom('', '> ', '- ', '# '), fc.array(certainTok, { maxLength: 4 })).map(([p, parts]) => p + parts.join(' '))
    const unsure = fc.constantFrom('||', '**W**', '`W`', 'W_W', '\\x', '[W](https://a.io)', '|||', '<@1234>', `||W|| <:e_:${E}>`)
    const uncertainLine = fc.tuple(fc.array(certainTok, { maxLength: 2 }), unsure, fc.array(certainTok, { maxLength: 2 }))
      .map(([a, x, b]) => [...a, x, ...b, '||W||'].join(' '))
    const anyLine = fc.oneof(certainLine, uncertainLine, fc.constantFrom('', 'W', 'W ||W', 'W|| W'))
    fc.assert(fc.property(fc.array(certainLine, { maxLength: 3 }), uncertainLine, fc.array(anyLine, { minLength: 1, maxLength: 4 }), (before, u, after) => {
      const s = numbered([...before, u, ...after].join('\n'))
      const lines = s.split('\n')
      const uStart = lines.slice(0, before.length).reduce((n, l) => n + l.length + 1, 0)
      const first = s.indexOf('||', uStart)
      const last = s.lastIndexOf('||')
      if (last < uStart + lines[before.length].length) {
        expect(parse(s)).toEqual(parseBefore(s))
        return
      }
      const oldHidden = new Set(exposure(parseBefore(lines.slice(0, before.length).join('\n'))).hidden)
      const expected = { hidden: [], shown: [] }
      for (const m of s.matchAll(WORD)) {
        const inside = m.index > first && m.index < last
        ;(inside || (m.index < uStart && oldHidden.has(m[0])) ? expected.hidden : expected.shown).push(m[0])
      }
      const order = (a, b) => a.slice(1) - b.slice(1)
      expect(exposure(parse(s)), JSON.stringify(s)).toEqual({ hidden: expected.hidden.sort(order), shown: expected.shown.sort(order) })
    }), { numRuns: 2000 })
  })

  it('masks for a quote every word any reading of Discord, or the site in either dialect or line by line, hides, and keeps the words outside the bars', () => {
    fc.assert(fc.property(messages(), ({ s, lines, codeLines }) => {
      const masked = maskSpoilers(s)
      const kept = new Set(masked.match(WORD) ?? [])
      const stretches = READINGS.flatMap((o) => readingHides(lines, codeLines, o))
      const site = new Set([...exposure(parse(s)).hidden, ...exposure(parse(s, EXT)).hidden, ...exposure(parseBefore(s)).hidden])
      const first = s.indexOf('||')
      const last = s.lastIndexOf('||')
      // No `||` is left, so neither dialect hides anything in what is quoted: what is left is read as words.
      expect(masked).not.toContain('||')
      for (const dialect of ['discord', 'extended']) expect(exposure(parse(masked, { dialect })).hidden).toEqual([])
      for (const m of s.matchAll(WORD)) {
        const why = `${m[0]} in ${JSON.stringify(s)}`
        if (site.has(m[0]) || stretches.some(([a, b]) => m.index >= a && m.index < b)) expect(kept.has(m[0]), why).toBe(false)
        if (first === -1 || m.index < first || m.index > last + 1) expect(kept.has(m[0]), why).toBe(true)
      }
    }), { numRuns: globalThis.__stryker__ ? 150 : 1000 })
  }, 300_000)

  it('masks for a quote exactly the pairs of the certain lines before the first uncertain one, and all from its first bar to the last', () => {
    const certainTok = fc.constantFrom('W', 'W', '||W||', '|| W ||', 'a | W', `<@${E}>`, `<:gg:${E}>`, '<t:1:R>')
    const certainLine = fc.tuple(fc.constantFrom('', '> ', '- ', '# '), fc.array(certainTok, { maxLength: 4 })).map(([p, parts]) => p + parts.join(' '))
    const unsure = fc.constantFrom('||', '**W**', '`W`', 'W_W', '\\x', '[W](https://a.io)', '|||', '<@1234>', `||W|| <:e_:${E}>`)
    const uncertainLine = fc.tuple(fc.array(certainTok, { maxLength: 2 }), unsure, fc.array(certainTok, { maxLength: 2 }))
      .map(([a, x, b]) => [...a, x, ...b, '||W||'].join(' '))
    const anyLine = fc.oneof(certainLine, uncertainLine, fc.constantFrom('', 'W', 'W ||W', 'W|| W'))
    fc.assert(fc.property(fc.array(certainLine, { maxLength: 3 }), uncertainLine, fc.array(anyLine, { maxLength: 4 }), (before, u, after) => {
      const s = numbered([...before, u, ...after].join('\n'))
      const lines = s.split('\n')
      const uStart = lines.slice(0, before.length).reduce((n, l) => n + l.length + 1, 0)
      const first = s.indexOf('||', uStart)
      const last = s.lastIndexOf('||')
      const oldHidden = new Set(exposure(parseBefore(lines.slice(0, before.length).join('\n'))).hidden)
      const want = [...s.matchAll(WORD)].filter((m) => !(m.index > first && m.index < last) && !(m.index < uStart && oldHidden.has(m[0]))).map((m) => m[0])
      expect(maskSpoilers(s).match(WORD) ?? [], JSON.stringify(s)).toEqual(want)
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

describe('maskSpoilers: a quote keeps no word a spoiler may hide', () => {
  const m = SPOILER_MASK
  it.each([
    ['a spoiler on its line', 'a ||b|| c', `a ${m} c`],
    ['two on a certain line, and the words between them', 'w0 ||w1|| w2 ||w3|| w4', `w0 ${m} w2 ${m} w4`],
    ['a spoiler over lines', 'w0 ||w1\nw2|| w3', `w0 ${m} w3`],
    ['certain lines, then all from the first bar of the first uncertain one to the last bar', 'a ||b|| c\n**x** ||d\ne|| f\ng', `a ${m} c\n**x** ${m} f\ng`],
    ['a spoiler over lines that runs to the end of the message', 'see **this** ||w1\nw2||', `see **this** ${m}`],
    ['the last bar on the first uncertain line', 'x\n**a** ||b|| c', `x\n**a** ${m} c`],
    ['a bar on its own, which hides nothing but is masked all the same', 'a || b', `a ${m} b`],
    ['a quote that the bars cut', '> a ||b\n> c||\n> d', `> a ${m}\n> d`],
    ['no bar at all: as it was, its line breaks \\n', 'a\r\nb\rc', 'a\nb\nc'],
    ['bars escaped, which are no `||`', '\\|\\|a\\|\\|', '\\|\\|a\\|\\|'],
    ['nothing', '', ''],
  ])('%s', (_, src, masked) => {
    expect(maskSpoilers(src)).toBe(masked)
  })

  it('is the mask the excerpts show', () => {
    expect(SPOILER_MASK).toBe('\u2592\u2592\u2592')
  })

  it('masks what a quote would show once the extended dialect reads it again', () => {
    const asQuoted = (src) => src.split('\n').map((l) => `> ${l}`).join('\n')
    // A one-line spoiler of Discord's over a row of pipes: the extended dialect reads the two lines as a table, its bars as borders.
    const table = 'x | y ||w0||\n-|-|-|-|-'
    expect(exposure(parse(table)).hidden).toEqual(['w0'])
    const read = parse(asQuoted(table), EXT)
    const kinds = []
    walk(read, (n) => kinds.push(n.type))
    expect(kinds).toContain('table')
    expect(kinds).not.toContain('spoiler')
    expect(plainText(read)).toContain('w0')
    expect(maskSpoilers(table)).toBe(`x | y ${m}\n-|-|-|-|-`)
    // A reply of the site's, whose quote marks a quote makes words: its bars pair another way.
    const reply = '> ||w0\n||w1\nw2||'
    expect(exposure(parse(reply, EXT)).hidden).toEqual(['w1', 'w2'])
    expect(exposure(parse(asQuoted(reply), EXT)).shown).toEqual(expect.arrayContaining(['w1', 'w2']))
    expect(maskSpoilers(reply)).toBe(`> ${m}`)
  })

  it('masks every word the extended dialect hides: in tables, pictures, notes and spoilers over the lines of a paragraph (property)', () => {
    const tok = fc.constantFrom('W', 'W', ' ', '||', '||', '||W||', '\n', '\n', '\n\n', '| W | W |', '|-|-|', '| ||W|| |', '|', '![W](upload:1)', '||![W](upload:2)||',
      '[^a]', '[^a]: W', '[^a]: ||W||', '#### ', '---', '> ', '>>> ', '- ', '**', '*', '`', '\\|', '\\', '[W](https://a.io)')
    fc.assert(fc.property(fc.array(tok, { maxLength: 40 }), (parts) => {
      const s = numbered(parts.join(''))
      const kept = new Set(maskSpoilers(s).match(WORD) ?? [])
      const first = s.indexOf('||')
      const last = s.lastIndexOf('||')
      // walk reaches every node, a table's cells and the notes too.
      const hidden = []
      walk(parse(s, EXT), (n) => n.type === 'spoiler' && hidden.push(...(plainText(n.children, { raw: true }).match(WORD) ?? [])))
      for (const word of hidden) expect(kept.has(word), `${word} in ${JSON.stringify(s)}`).toBe(false)
      for (const w of s.matchAll(WORD)) if (first === -1 || w.index < first || w.index > last + 1) expect(kept.has(w[0]), `${w[0]} in ${JSON.stringify(s)}`).toBe(true)
    }), { numRuns: 3000 })
  })

  it('takes only a string', () => {
    for (const src of [null, undefined, 42, ['a']]) expect(() => maskSpoilers(src)).toThrow(new TypeError('markdown source must be a string'))
  })

  it('stays linear on hostile input', () => {
    const budget = globalThis.__stryker__ ? 60_000 : 6000
    for (const src of ['a ||b|| c\n'.repeat(100_000), '||a\n'.repeat(100_000), '```a\n'.repeat(100_000) + '||b', '|'.repeat(200_000)]) {
      const at = performance.now()
      maskSpoilers(src)
      expect(performance.now() - at).toBeLessThan(budget)
    }
  }, 120_000)
})

describe('the extended dialect, the one replies are written in on the site: unchanged', () => {
  it('reads a spoiler over the lines of a paragraph as one, and bars over a blank line as text, as its Preview shows them', () => {
    const br = { type: 'br' }
    expect(parse('||a\nb||', EXT)).toEqual([line(spoiler(t('a'), br, t('b')))])
    expect(parse('||a\n\nb||', EXT)).toEqual([line(t('||a')), blank, line(t('b||'))])
    expect(parse('||a\n- b\nc||', EXT)).toEqual([line(t('||a')), list('b'), line(t('c||'))])
    expect(parse('**x** ||a\nb|| c\n||d||', EXT)).toEqual([line({ type: 'strong', children: [t('x')] }, t(' '), spoiler(t('a'), br, t('b')), t(' c')), line(spoiler(t('d')))])
  })

  it('reads every text exactly as at 8a17c63', () => {
    const tokens = ['**', '*', '_', '__', '~~', '||', '||', '|', '|||', '`', '```', '> ', '>>> ', '# ', '#### ', '-# ', '- ', '1. ', '---', '[', '](', ')', '<', '>',
      '\\', `<:e:${E}>`, `<@&${E}>`, 'https://a.io/x', 'word', ' ', '\\|', ZWSP, LS, '\n', '\n', '\n\n', '\r\n', '| a | b |', '|-|-|', '| ||a|| |',
      '![a](upload:1)', '||![a](upload:2)||', '[^a]', '[^a]: n', '[x](https://a.io)']
    fc.assert(fc.property(fc.array(fc.constantFrom(...tokens), { maxLength: 80 }), (parts) => {
      const s = parts.join('')
      expect(parse(s, EXT)).toEqual(parseBatch2(s, EXT))
      expect(parseInline(s, EXT)).toEqual(parseInlineBatch2(s, EXT))
    }), { numRuns: 4000 })
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
      expect(parse(s, EXT)).toEqual(parseBatch2(s, EXT))
    }), { numRuns: 2000 })
  })
})
