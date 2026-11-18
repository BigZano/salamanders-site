import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { parse } from './librariusMarkdown.js'
import {
  DEFAULT_FORM,
  FORMS,
  MAX_PARTS,
  PLAIN_LIMIT,
  PRIMARY_LIMIT,
  budget,
  displayableLength,
  limitFor,
  markers,
  placement,
  split,
  toDiscord,
} from './librariusForm.js'

// Every id, link and name here is invented.
const AUTHOR = '200000000000000401'
const REPLIED = '200000000000000402'
const GUILD = '200000000000000403'
const THREAD = '200000000000000404'
const MSG = ['200000000000000411', '200000000000000412', '200000000000000413']
const SITE = 'https://site.example/librarius/200000000000000404'
const JUMP = 'https://discord.com/channels/200000000000000403/200000000000000404/200000000000000409'
const BASE = `https://discord.com/channels/${GUILD}/${THREAD}`
const FOOTER = `-# <@${AUTHOR}>`
const PLAIN_FOOTER = `-# <@${AUTHOR}> · [Open On Site](<${SITE}>)`
const REPLY_LINE = `-# ↪ <@${REPLIED}> [jump](<${JUMP}>)`
const BUTTON = { type: 1, components: [{ type: 2, style: 5, label: 'Open On Site', url: SITE }] }
const WORST_ID = '9'.repeat(20)
const WORST_BASE = `https://discord.com/channels/${WORST_ID}/${WORST_ID}`
const SEP = { type: 14, divider: true, spacing: 1 }

const opts = (over = {}) => ({ form: 'v2', authorId: AUTHOR, replyTo: null, siteUrl: SITE, images: [], ...over })
const v2 = (src, over) => toDiscord(src, opts(over))
const plain = (src, over) => toDiscord(src, opts({ form: 'plain', ...over }))
const inner = (part) => part.components[0].components
const displays = (part) => inner(part).filter((c) => c.type === 10).map((c) => c.content)
const gallery = (...names) => ({ type: 12, items: names.map((n) => ({ media: { url: `attachment://${n}` } })) })
const MARK = /^\*\*\d+\/\d+\*\*[ \n]/
const unmark = (s) => s.replace(MARK, '')
const x = (n) => 'x'.repeat(n)
const count = (components) => components.reduce((n, c) => n + 1 + (c.components ? count(c.components) : 0), 0)
const FORM_MSG = 'form must be "v2" or "plain"'
const ID_MSG = (what) => `${what} must be a Discord id`
const URL_MSG = (what) => `${what} must be an https link of at most 200 characters, with no space or angle bracket`
const BASE_MSG = 'the thread link must be https://discord.com/channels/<guild id>/<thread id>'
// A mark in front of a piece, as split writes it.
const m = (k, n, body) => `**${k}/${n}** ${body}`

describe('constants', () => {
  it('names the forms, the default and the limits of the plan', () => {
    expect(FORMS).toEqual(['v2', 'plain'])
    expect(Object.isFrozen(FORMS)).toBe(true)
    expect(DEFAULT_FORM).toBe('v2')
    expect(PRIMARY_LIMIT).toBe(3950)
    expect(PLAIN_LIMIT).toBe(1950)
    expect(MAX_PARTS).toBe(3)
  })

  it('limitFor gives a form its body budget and refuses any other form', () => {
    expect(limitFor('v2')).toBe(3950)
    expect(limitFor('plain')).toBe(1950)
    for (const bad of [undefined, null, 'V2', 'html', '', 3, {}]) expect(() => limitFor(bad)).toThrow(new RangeError(FORM_MSG))
  })
})

describe('displayableLength', () => {
  it('counts every text display and every button label of a V2 part, and nothing else', () => {
    const part = {
      text: 'not counted',
      files: [],
      components: [
        {
          type: 17,
          components: [{ type: 10, content: 'abc' }, SEP, gallery('a.png'), { type: 10, content: 'de' }, { type: 1, components: [{ type: 2, style: 5, label: 'xyz', url: SITE }] }],
        },
      ],
    }
    expect(displayableLength(part)).toBe(8)
  })

  it('counts the content of a plain part', () => {
    expect(displayableLength({ text: 'abcd', components: null, files: [] })).toBe(4)
    expect(displayableLength({ text: '', components: null, files: [] })).toBe(0)
  })

  it('agrees with what a built part holds', () => {
    const r = v2('hi')
    expect(displayableLength(r.parts[0])).toBe(`hi\n${FOOTER}`.length + 'Open On Site'.length)
    expect(displayableLength(plain('hi').parts[0])).toBe(`hi\n${PLAIN_FOOTER}`.length)
  })
})

describe('split: where a part ends', () => {
  it('keeps a text that fits as the one part, untouched and unmarked', () => {
    expect(split('hello', 40)).toEqual(['hello'])
    expect(split('', 40)).toEqual([''])
    expect(split(x(40), 40)).toEqual([x(40)])
    expect(split(`a\n${x(38)}`, 40)).toEqual([`a\n${x(38)}`])
  })

  it('refuses what is no text and a limit too small to mark a part in', () => {
    for (const bad of [undefined, null, 5, {}, ['a']]) expect(() => split(bad, 40)).toThrow(new TypeError('the text must be a string'))
    for (const bad of [31, 0, -40, 40.5, Number.NaN, Infinity, '40', undefined, null]) expect(() => split('abc', bad)).toThrow(new RangeError('the limit must be a whole number of at least 32'))
    expect(split('abc', 32)).toEqual(['abc'])
  })

  it('marks every part of a split text 1/N, N, and a part is no longer than the limit with its mark', () => {
    const parts = split(x(41), 40)
    expect(parts).toEqual([m(1, 2, x(32)), m(2, 2, x(9))])
    expect(parts[0]).toHaveLength(40)
  })

  it('breaks at a blank line, the latest one that fits', () => {
    const a = 'a'.repeat(10)
    const [b, c, d] = ['b', 'c', 'd'].map((ch) => ch.repeat(10))
    expect(split(`${a}\n\n${b}\n\n${c}\n\n${d}`, 40)).toEqual([m(1, 2, `${a}\n\n${b}\n\n`), m(2, 2, `${c}\n\n${d}`)])
  })

  it('breaks at a blank line before a later line end, because a paragraph break is the better break', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((ch) => ch.repeat(10))
    expect(split(`${a}\n\n${b}\n${c}`, 32)).toEqual([m(1, 2, `${a}\n\n`), m(2, 2, `${b}\n${c}`)])
  })

  it('fills a part exactly to the limit, marker included, and moves the break when one more character comes', () => {
    const b = 'b'.repeat(10)
    expect(split(`${'a'.repeat(30)}\n\n${b}`, 40)).toEqual([m(1, 2, `${'a'.repeat(30)}\n\n`), m(2, 2, b)])
    const parts = split(`${'a'.repeat(31)}\n\n${b}`, 40)
    expect(parts).toEqual([m(1, 2, `${'a'.repeat(31)}\n`), m(2, 2, `\n${b}`)])
    expect(parts[0]).toHaveLength(40)
  })

  it('takes a break only if it leaves the part half full: a paragraph break at 16 of 32, not at 15', () => {
    // Half of the room of 32 (40 less the 8 of the mark) is 16: the blank line after 14 characters and its line end is the 16th.
    expect(split(`${x(14)}\n\n${'y'.repeat(30)}`, 40)).toEqual([m(1, 2, `${x(14)}\n\n`), m(2, 2, 'y'.repeat(30))])
    // At 15 it does not, and the part is filled by cutting the line after it.
    expect(split(`${x(13)}\n\n${'y'.repeat(30)}`, 40)).toEqual([m(1, 2, `${x(13)}\n\n${'y'.repeat(17)}`), m(2, 2, 'y'.repeat(13))])
  })

  it('takes the next kind of break down when the better one leaves the part under half full', () => {
    // The blank line is at 9 of 32: the line end at 21 is taken.
    const text = ['a'.repeat(8), '', 'b'.repeat(11), 'c'.repeat(20)].join('\n')
    expect(split(text, 40).map(unmark)).toEqual([`${'a'.repeat(8)}\n\n${'b'.repeat(11)}\n`, 'c'.repeat(20)])
    // A line end inside a list is the third kind: taken when the first two are under half.
    const items = ['- aaaaaaa', '- bbbbbbb', '- ccccccc', `- ${'d'.repeat(30)}`]
    expect(split(['x'.repeat(5), ...items].join('\n'), 40).map(unmark)[0]).toBe(`${'x'.repeat(5)}\n- aaaaaaa\n- bbbbbbb\n`)
  })

  it('counts the rows before a cut line toward the half: a space at 20 of 23 is taken after a short row', () => {
    const text = `${x(8)}\n${'abcd '.repeat(20)}`
    expect(split(text, 40).map(unmark)[0]).toBe(`${x(8)}\nabcd abcd abcd abcd `)
  })

  it('takes a space only if it leaves the part half full, and cuts hard when no break does', () => {
    expect(split(`${x(15)} ${x(60)}`, 40).map(unmark)[0]).toBe(`${x(15)} `)
    expect(split(`${x(14)} ${x(60)}`, 40).map(unmark)[0]).toBe(`${x(14)} ${x(17)}`)
  })

  it('breaks at a line end when there is no blank line', () => {
    expect(split(`${x(20)}\n${'y'.repeat(20)}`, 40)).toEqual([m(1, 2, `${x(20)}\n`), m(2, 2, 'y'.repeat(20))])
  })

  it('does not break between two lines of one list or one table while a break outside them fits', () => {
    const list = ['- one item', '- two item', '- six item'].join('\n')
    expect(split(`${x(20)}\n\n${list}`, 40)).toEqual([m(1, 2, `${x(20)}\n\n`), `**2/2**\n${list}`])
    // No blank line: the line end before the list is a better break than one between its items.
    expect(split(`${x(17)}\n${list}`, 40)).toEqual([m(1, 2, `${x(17)}\n`), `**2/2**\n${list}`])
    const table = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
    expect(split(`${x(17)}\n\n${table}`, 40)).toEqual([m(1, 3, `${x(17)}\n\n`), m(2, 3, '| a | b |\n| - | - |\n| 1 | 2 |\n'), m(3, 3, '| 3 | 4 |')])
    expect(split(`${x(17)}\n${table}`, 40)[0]).toBe(m(1, 3, `${x(17)}\n`))
  })

  it('breaks between the items of a list longer than a part, never inside an item', () => {
    const items = Array.from({ length: 8 }, (_, i) => `- item number ${i}`)
    const parts = split(items.join('\n'), 40)
    expect(parts.map(unmark).join('')).toBe(items.join('\n'))
    for (const part of parts) for (const line of unmark(part).split('\n').filter(Boolean)) expect(items).toContain(line)
  })

  it('does not break inside a code fence while a break outside it fits', () => {
    const code = `\`\`\`\n${x(10)}\n${x(10)}\n\`\`\``
    expect(split(`intro line\n\n${code}\n\n${x(20)}`, 60)).toEqual([m(1, 2, `intro line\n\n${code}\n\n`), m(2, 2, x(20))])
    // Over a part, the fence is cut between its lines, after the break before it.
    const fence = `\`\`\`\n${x(20)}\n${x(20)}\n${x(20)}\n\`\`\``
    const parts = split(`${x(20)}\n\n${fence}\n\ntail`, 50)
    expect(parts.map(unmark)).toEqual([`${x(20)}\n\n`, `\`\`\`\n${x(20)}\n`, `${x(20)}\n`, `${x(20)}\n\`\`\`\n\ntail`])
  })

  it('never cuts right before a fence closes, where the next part would be a fence with nothing in it', () => {
    const text = `\`\`\`\n${x(10)}\n${x(10)}\n${x(14)}\n\`\`\`\n${'y'.repeat(50)}`
    expect(split(text, 46).map(unmark)).toEqual([`\`\`\`\n${x(10)}\n${x(10)}\n`, `${x(14)}\n\`\`\`\n`, 'y'.repeat(38), 'y'.repeat(12)])
  })

  it('cuts right before a fence closes, as the last resort, when nothing else fits', () => {
    const text = `\`\`\`\n${x(20)}\n\`\`\`${'y'.repeat(20)}`
    expect(split(text, 40).map(unmark)).toEqual([`\`\`\`\n${x(20)}\n`, `\`\`\`${'y'.repeat(20)}`])
  })

  it('ends a part at the latest boundary, however empty, when the row that ran out of room is not one to cut', () => {
    // After the first cut one character of the y line is left, and the row that follows the blank line starts with a fence.
    const text = [x(5), 'y'.repeat(27), '', `\`\`\`${'z'.repeat(100)}`].join('\n')
    const parts = split(text, 40).map(unmark)
    expect(parts.slice(0, 2)).toEqual([`${x(5)}\n${'y'.repeat(26)}`, 'y\n\n'])
    expect(parts.join('')).toBe(text)
  })

  it('cuts a line longer than a part after the fence it is in opens, and goes on past the closing', () => {
    const text = `\`\`\`\n${x(33)}\n\`\`\`${'y'.repeat(60)}`
    // The 5 left of the x line is a part of 6: the line that ran out of room is the closing one, and it starts with a fence.
    expect(split(text, 40).map(unmark)).toEqual([`\`\`\`\n${x(28)}`, `${x(5)}\n`, `\`\`\`${'y'.repeat(29)}`, 'y'.repeat(31)])
    expect(split(`\`\`\`\n${x(80)}\n\`\`\``, 40).map(unmark)).toEqual([`\`\`\`\n${x(28)}`, x(32), `${x(20)}\n\`\`\``])
  })

  it('prefers a break before a fence to one in its first line, when the part is half full by it', () => {
    const text = `${x(17)}\n\`\`\`\n${x(80)}\n\`\`\``
    expect(split(text, 40).map(unmark)[0]).toBe(`${x(17)}\n`)
    // With less before it, the part is filled by the first line of the code.
    const short = split(`intro\n\`\`\`\n${x(80)}\n\`\`\``, 40).map(unmark)
    expect(short.join('')).toBe(`intro\n\`\`\`\n${x(80)}\n\`\`\``)
    expect(short[0]).toBe(`intro\n\`\`\`\n${x(22)}`)
  })

  it('does not take a blank line inside a code fence for a paragraph break', () => {
    const fence = `\`\`\`\n${x(10)}\n\n${x(10)}\n\n${x(10)}\n\`\`\``
    // The break after the first line is the only one outside the fence.
    expect(split(`${x(17)}\n${fence}`, 40).map(unmark)[0]).toBe(`${x(17)}\n`)
  })

  it('takes the fence of a quote, or one that is indented, for a fence', () => {
    const quoted = ['> ```', `> ${x(7)}`, `> ${x(7)}`, '> ```'].join('\n')
    expect(split(`${x(15)}\n${quoted}`, 40).map(unmark)).toEqual([`${x(15)}\n`, quoted])
    const indented = ['  ```', x(7), x(7), '  ```'].join('\n')
    expect(split(`${x(15)}\n${indented}`, 40).map(unmark)).toEqual([`${x(15)}\n`, indented])
  })

  it('puts as much of the first line of the code in the part of the fence that opens as there is room for', () => {
    const cut = (openerLength) => split(`\`\`\`${'a'.repeat(openerLength - 3)}\n${x(40)}`, 32).map(unmark)
    expect(cut(21)[0]).toBe(`\`\`\`${'a'.repeat(18)}\nxx`)
    expect(cut(22)[0]).toBe(`\`\`\`${'a'.repeat(19)}\nx`)
    // With no room left for even one character, the part is the opener and its line end.
    expect(cut(23)[0]).toBe(`\`\`\`${'a'.repeat(20)}\n`)
  })

  it('takes a fence in a quote in a quote for a fence', () => {
    const quoted = ['> > ```', `> > ${x(2)}`, `> > ${x(2)}`, '> > ```'].join('\n')
    expect(split(`${x(15)}\n${quoted}`, 40).map(unmark)).toEqual([`${x(15)}\n`, quoted])
  })

  it('takes a line with three backticks in the middle of it for no fence', () => {
    const first = `${x(12)} \`\`\` a`
    const text = [first, '', 'b'.repeat(10), 'c'.repeat(8), 'd'.repeat(20)].join('\n')
    expect(unmark(split(text, 40)[0])).toBe(`${first}\n\n`)
  })

  it('takes a line of nothing but spaces for a blank line', () => {
    const text = [x(14), '  ', 'y'.repeat(10), 'z'.repeat(20)].join('\n')
    expect(split(text, 40)[0]).toBe(m(1, 2, `${x(14)}\n  \n`))
  })

  it('takes a line that starts with a hyphen and no space for no list item', () => {
    const text = [x(10), '-aaaaaaaa', '-bbbbbbbb', `-${'d'.repeat(20)}`].join('\n')
    expect(split(text, 40)[0]).toBe(m(1, 2, `${x(10)}\n-aaaaaaaa\n-bbbbbbbb\n`))
  })

  it('breaks before a blank line when the break after it does not fit and another is farther back', () => {
    const text = [x(5), '', 'y'.repeat(24), '', 'z'.repeat(10)].join('\n')
    expect(split(text, 40).map(unmark)).toEqual([`${x(5)}\n\n${'y'.repeat(24)}\n`, `\n${'z'.repeat(10)}`])
  })

  it('does not take two lines that hold a spoiler for two lines of a table', () => {
    const text = ['a'.repeat(10), '||bbbbbb||', '||cccccc||', 'd'.repeat(20)].join('\n')
    expect(split(text, 40)[0]).toBe(m(1, 2, `${'a'.repeat(10)}\n||bbbbbb||\n`))
  })

  it('does not break between the lines of a list of any of its kinds, or of a quoted list, before the line end ahead of it', () => {
    for (const mark of ['* ', '1. ', '> - ', '  - ', '10. ']) {
      const items = ['a', 'b', 'c', 'd'].map((ch) => mark + ch.repeat(8 - mark.length))
      const parts = split(`${x(15)}\n${items.join('\n')}`, 40).map(unmark)
      expect(parts).toEqual([`${x(15)}\n`, `${items.slice(0, 3).join('\n')}\n`, items[3]])
    }
  })

  it('breaks a long line at a sentence end, before it breaks at a space', () => {
    const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.'
    expect(split(text, 40)).toEqual([m(1, 3, 'Alpha beta gamma. '), m(2, 3, 'Delta epsilon zeta. '), m(3, 3, 'Eta theta iota.')])
    for (const end of ['!', '?']) {
      expect(split(text.replaceAll('.', end), 40)[0]).toBe(m(1, 3, `Alpha beta gamma${end} `))
    }
  })

  it('does not take a dot with no space after it for a sentence end', () => {
    const text = 'Alpha beta gamma.Delta epsilon zeta. Eta theta iota.'
    expect(split(text, 40)).toEqual([m(1, 2, 'Alpha beta gamma.Delta epsilon '), m(2, 2, 'zeta. Eta theta iota.')])
  })

  it('breaks at the last space when no sentence ends in reach', () => {
    const text = Array.from({ length: 9 }, () => 'abcd').join(' ')
    expect(split(text, 40)).toEqual([m(1, 2, 'abcd '.repeat(6)), m(2, 2, 'abcd abcd abcd')])
    expect(split(`${'abcd '.repeat(9)}end`, 40)[0]).toBe(m(1, 2, 'abcd '.repeat(6)))
  })

  it('does not take the space after a dot that an earlier part ended on for a sentence end', () => {
    const text = `${x(31)}. ${'abcd '.repeat(30)}end`
    const parts = split(text, 40).map(unmark)
    expect(parts[0]).toBe(`${x(31)}.`)
    expect(parts[1]).toBe(` ${'abcd '.repeat(6)}`)
  })

  it('does not take a sentence end that would leave the part under half full, and breaks at a space instead', () => {
    expect(split(`. ${'abcd '.repeat(30)}end`, 40).map(unmark)[0]).toBe(`. ${'abcd '.repeat(6)}`)
    // Half of 32 is 16: a sentence end at 16 is taken, one at 15 is not.
    const at = (n) => `${x(n - 2)}. ${'abcd '.repeat(30)}end`
    expect(split(at(16), 40).map(unmark)[0]).toBe(`${x(14)}. `)
    expect(split(at(15), 40).map(unmark)[0]).toBe(`${x(13)}. ${'abcd '.repeat(3)}`)
  })

  it('does not make a part of the first sentence of a long text with no sentence end after it', () => {
    // B5: a part is at least half full, so "Hello. " is not a part of its own.
    const hard = split(`Hello. ${'a'.repeat(3900)}`, 3000).map(unmark)
    expect(hard[0]).toBe(`Hello. ${'a'.repeat(2985)}`)
    const spaced = split(`Hello. ${'abcd '.repeat(780)}`, 3000).map(unmark)
    expect(spaced).toHaveLength(2)
    expect(spaced[0].length).toBeGreaterThan(2980)
    expect(spaced.join('')).toBe(`Hello. ${'abcd '.repeat(780)}`)
  })

  it('takes a tab for a space', () => {
    expect(split(Array.from({ length: 9 }, () => 'abcd').join('\t'), 40)[0]).toBe(m(1, 2, 'abcd\t'.repeat(6)))
  })

  it('cuts hard when nothing in reach is a break', () => {
    expect(split(x(100), 40)).toEqual([m(1, 4, x(32)), m(2, 4, x(32)), m(3, 4, x(32)), m(4, 4, x(4))])
  })

  it('never cuts inside a surrogate pair, and does when the pair is whole before the cut', () => {
    const smile = '😀'
    expect(split(x(31) + smile.repeat(6), 40)).toEqual([m(1, 2, x(31)), m(2, 2, smile.repeat(6))])
    expect(split(x(30) + smile.repeat(6), 40)).toEqual([m(1, 2, x(30) + smile), m(2, 2, smile.repeat(5))])
  })

  it('keeps a pair whose halves are the first and the last of their ranges, and takes a lone half for nothing to keep', () => {
    for (const pair of ['\ud800\udc00', '\udbff\udfff', '\ud83d\ude00']) {
      expect(split(x(31) + pair.repeat(6), 40)).toEqual([m(1, 2, x(31)), m(2, 2, pair.repeat(6))])
    }
    expect(split(`${x(31)}\ud800a${x(20)}`, 40)[0]).toBe(m(1, 2, `${x(31)}\ud800`))
    expect(split(`${x(32)}\udc00${x(20)}`, 40)[0]).toBe(m(1, 2, x(32)))
    expect(split(`${x(31)}\ud7ff\udc00${x(20)}`, 40)[0]).toBe(m(1, 2, `${x(31)}\ud7ff`))
    expect(split(`${x(31)}\ud800\ue000${x(20)}`, 40)[0]).toBe(m(1, 2, `${x(31)}\ud800`))
    expect(split(`${x(31)}\ud800\ud800${x(20)}`, 40)[0]).toBe(m(1, 2, `${x(31)}\ud800`))
    expect(split(`${x(31)}\udbff\udbff${x(20)}`, 40)[0]).toBe(m(1, 2, `${x(31)}\udbff`))
  })

  it('takes a pair for a pair whatever follows it, and two lone halves for none', () => {
    expect(split(`${x(31)}😀${x(20)}`, 40)[0]).toBe(m(1, 2, x(31)))
    expect(unmark(split(`${x(31)}\udc00\udc00${x(20)}`, 40)[0])).toBe(`${x(31)}\udc00`)
    expect(unmark(split(`${x(31)}\ue000\udc00${x(20)}`, 40)[0])).toBe(`${x(31)}\ue000`)
  })

  it('writes the mark with a newline when its part starts with block syntax, so the syntax still works', () => {
    const text = `${x(30)}\n\n# Title\n${'y'.repeat(30)}`
    expect(split(text, 40)).toEqual([m(1, 3, `${x(30)}\n\n`), `**2/3**\n# Title\n${'y'.repeat(24)}`, m(3, 3, 'y'.repeat(6))])
    for (const start of ['# a', '### a', '###### a', '-# a', '- a', '* a', '1. a', '123456789. a', '> a', '>>> a', '```', '   - a', '\t# a']) {
      const parts = split(`${x(30)}\n\n${start}\n${'y'.repeat(10)}`, 42)
      expect(parts[1].startsWith('**2/2**\n')).toBe(true)
    }
    for (const start of ['#a', '-x', '1.a', '1 a', 'a', '`a`', '####### a', '1234567890. a', '']) {
      const parts = split(`${x(30)}\n\n${start}\n${'y'.repeat(10)}`, 42)
      expect(parts[1].startsWith('**2/2** ')).toBe(true)
    }
  })

  it('widens the mark when there are ten parts or more, and every part still fits', () => {
    const parts = split(x(400), 32)
    expect(parts.length).toBeGreaterThanOrEqual(10)
    expect(parts[0].startsWith(`**1/${parts.length}** `)).toBe(true)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(32)
    expect(parts.map(unmark).join('')).toBe(x(400))
    expect(parts.length).toBe(19)
  })

  it('handles a text of nothing but line ends and a line of nothing but spaces', () => {
    const lines = '\n'.repeat(100)
    expect(split(lines, 40).map(unmark).join('')).toBe(lines)
    const spaces = ' '.repeat(100)
    expect(split(spaces, 40).map(unmark)).toEqual([' '.repeat(32), ' '.repeat(32), ' '.repeat(32), '    '])
  })

  it('splits a long text in linear time', () => {
    const lines = 'a\n'.repeat(100_000)
    const start = performance.now()
    const parts = split(lines, 4000)
    expect(parts.map(unmark).join('')).toBe(lines)
    expect(split(x(1_000_000), 4000).length).toBeGreaterThan(200)
    // Uninstrumented this takes about 100 ms; Stryker's instrumentation is some 10 times slower.
    expect(performance.now() - start).toBeLessThan(globalThis.__stryker__ ? 20_000 : 2000)
  })
})

describe('split: properties', () => {
  const EMOJI_TEXT = fc.array(fc.constantFrom('a', 'b', ' ', '\n', '.', '😀', '𝒳', 'é', '\n\n', '- ', '```\n', '| a | b |\n', '# '), { maxLength: 300 }).map((a) => a.join(''))
  const LIMIT = fc.integer({ min: 32, max: 160 })

  it('puts the text back together once the marks are taken off, and no part is over the limit', () => {
    fc.assert(
      fc.property(fc.oneof(EMOJI_TEXT, fc.string({ unit: 'binary', maxLength: 500 })), LIMIT, (text, limit) => {
        const parts = split(text, limit)
        expect(parts.length).toBeGreaterThanOrEqual(1)
        for (const part of parts) expect(part.length).toBeLessThanOrEqual(limit)
        if (text.length <= limit) expect(parts).toEqual([text])
        else expect(parts.map(unmark).join('')).toBe(text)
      }),
      { numRuns: 400 },
    )
  })

  // B5: every part but the last is at least half the limit, with its mark. A break is taken only if it leaves the part half
  // its room, the room being the limit less the mark. There are two exceptions, neither in a text with no code fence: the cut
  // before a fence closes or after one opens (a last resort that is taken only when no other is left), which the check below
  // lets pass when the part ends where a line with a fence starts or begins with one.
  it('leaves every part but the last at least half the limit', () => {
    const PROSE = fc.array(fc.constantFrom('a', 'b', ' ', '\n', '\n\n', '. ', '! ', '? ', '- ', '# ', '| a | b |\n', '😀', '𝒳', 'word ', 'x'.repeat(40), '> ', '1. '), { maxLength: 400 }).map((a) => a.join(''))
    fc.assert(
      fc.property(fc.oneof(PROSE, fc.string({ unit: 'binary', maxLength: 600 })), LIMIT, (text, limit) => {
        const parts = split(text, limit)
        for (const part of parts.slice(0, -1)) expect(part.length * 2).toBeGreaterThanOrEqual(limit)
      }),
      { numRuns: 600 },
    )
  })

  it('leaves every part but the last at least half the limit, except where a fence ends or begins one', () => {
    const FENCED = fc.array(fc.constantFrom('a', ' ', '\n', '. ', '```\n', '```js\n', '> ```\n', 'x'.repeat(40), '- '), { maxLength: 400 }).map((a) => a.join(''))
    fc.assert(
      fc.property(FENCED, LIMIT, (text, limit) => {
        const parts = split(text, limit).map(unmark)
        parts.slice(0, -1).forEach((part, i) => {
          const edge = /(^|\n)[ \t>]*```[^\n]*\n?$/.test(part) || /^[ \t>]*```/.test(parts[i + 1])
          if (!edge) expect(part.length + 8).toBeGreaterThanOrEqual(limit / 2)
        })
      }),
      { numRuns: 600 },
    )
  })

  it('numbers the parts in order, over the count of them', () => {
    fc.assert(
      fc.property(EMOJI_TEXT, LIMIT, (text, limit) => {
        const parts = split(text, limit)
        if (parts.length === 1) return
        parts.forEach((part, i) => expect(part.startsWith(`**${i + 1}/${parts.length}**`)).toBe(true))
      }),
      { numRuns: 300 },
    )
  })

  it('never splits a surrogate pair', () => {
    fc.assert(
      fc.property(EMOJI_TEXT, LIMIT, (text, limit) => {
        for (const part of split(text, limit)) expect(part.isWellFormed()).toBe(true)
      }),
      { numRuns: 400 },
    )
  })

  it('makes progress: no part is empty once the mark is off, unless the text was', () => {
    fc.assert(
      fc.property(EMOJI_TEXT, LIMIT, (text, limit) => {
        const parts = split(text, limit)
        if (parts.length === 1) return
        for (const part of parts) expect(unmark(part).length).toBeGreaterThan(0)
      }),
      { numRuns: 300 },
    )
  })
})

describe('markers', () => {
  it('gives part 1 the links to the later parts, and each later part the link back', () => {
    expect(markers([MSG[0], MSG[1]], BASE)).toEqual([`-# continues: [2/2](<${BASE}/${MSG[1]}>)`, `-# [↑ from 1/2](<${BASE}/${MSG[0]}>)`])
    expect(markers(MSG, BASE)).toEqual([
      `-# continues: [2/3](<${BASE}/${MSG[1]}>) · [3/3](<${BASE}/${MSG[2]}>)`,
      `-# [↑ from 1/3](<${BASE}/${MSG[0]}>)`,
      `-# [↑ from 1/3](<${BASE}/${MSG[0]}>)`,
    ])
  })

  it('has nothing to say of a reply in one part', () => {
    expect(markers([MSG[0]], BASE)).toEqual([''])
    expect(markers([null], BASE)).toEqual([''])
  })

  it('answers null for a line that needs an id not known yet', () => {
    expect(markers([MSG[0], null, null], BASE)).toEqual([null, `-# [↑ from 1/3](<${BASE}/${MSG[0]}>)`, `-# [↑ from 1/3](<${BASE}/${MSG[0]}>)`])
    expect(markers([MSG[0], MSG[1], null], BASE)[0]).toBeNull()
    expect(markers([MSG[0], null], BASE)[0]).toBeNull()
    expect(markers([null, MSG[1], MSG[2]], BASE)).toEqual([`-# continues: [2/3](<${BASE}/${MSG[1]}>) · [3/3](<${BASE}/${MSG[2]}>)`, null, null])
  })

  it('refuses what is no list of one to three ids that are known or null', () => {
    for (const bad of [undefined, null, 'ab', {}, 5]) expect(() => markers(bad, BASE)).toThrow(new TypeError('partIds must be a list'))
    for (const bad of [[], [...MSG, MSG[0]]]) expect(() => markers(bad, BASE)).toThrow(new RangeError('partIds must hold 1 to 3 ids'))
    for (const id of ['1234567890123456', '123456789012345678901', '12345678901234567a', '', ' 200000000000000411', `${MSG[0]}\n`, 5, undefined, {}]) {
      expect(() => markers([MSG[0], id], BASE)).toThrow(new RangeError(ID_MSG('partIds entry')))
    }
  })

  it('refuses a thread link that is not a Discord channel link of a guild and a thread', () => {
    for (const bad of [
      'https://discord.com/channels/1/2',
      `http://discord.com/channels/${GUILD}/${THREAD}`,
      `${BASE}/`,
      `${BASE}/${MSG[0]}`,
      `https://canary.discord.com/channels/${GUILD}/${THREAD}`,
      `https://discord.com/channels/${GUILD}`,
      `https://discord.com/channels/${GUILD}/${THREAD}?x=1`,
      `https://discord.com/channels/${GUILD.slice(2)}/${THREAD}`,
      `https://discord.com/channels/${GUILD}/${THREAD.slice(2)}`,
      `https://discord.com/channels/${GUILD}${'0'.repeat(3)}/${THREAD}`,
      `https://discord.com/channels/${GUILD}/${THREAD}${'0'.repeat(3)}`,
      ` ${BASE}`,
      `${BASE}\n`,
      '',
      5,
      undefined,
      null,
      { toString: () => BASE },
      [BASE],
    ]) {
      expect(() => markers(MSG, bad)).toThrow(new RangeError(BASE_MSG))
    }
  })

  it('takes ids and a link of the greatest length the reservation counts on', () => {
    const lines = markers([WORST_ID, WORST_ID, WORST_ID], WORST_BASE)
    expect(lines[0].length).toBe(217)
    expect(lines[1].length).toBe(110)
  })
})

describe('toDiscord: what it refuses', () => {
  const ok = () => toDiscord('hi', opts())

  it('answers a reply that is well formed', () => {
    expect(ok().parts).toHaveLength(1)
  })

  it('refuses a source that is no text', () => {
    for (const bad of [undefined, null, 5, {}, ['a']]) expect(() => toDiscord(bad, opts())).toThrow(new TypeError('the source must be a string'))
  })

  it('refuses options that are no object', () => {
    for (const bad of [undefined, null, 5, 'v2', []]) expect(() => toDiscord('hi', bad)).toThrow(new TypeError('the options must be an object'))
  })

  it('takes the default form when none is given, and refuses one that is not a form', () => {
    const r = toDiscord('hi', opts({ form: undefined }))
    expect(r.parts[0].components).not.toBeNull()
    for (const bad of ['V2', 'html', '', null, 5, {}]) expect(() => toDiscord('hi', opts({ form: bad }))).toThrow(new RangeError(FORM_MSG))
  })

  it('refuses an author id that is not a snowflake', () => {
    for (const bad of [undefined, null, 123, '', '1234567890123456', '123456789012345678901', '12345678901234567a', ` ${AUTHOR}`, `${AUTHOR}\n`, 200000000000000401n]) {
      expect(() => toDiscord('hi', opts({ authorId: bad }))).toThrow(new RangeError(ID_MSG('authorId')))
    }
  })

  it('refuses a site link that is not an https link without spaces or angle brackets, or is over 200 characters', () => {
    const long = (n) => `https://${'a'.repeat(n - 8)}`
    for (const bad of [undefined, null, 5, '', 'http://site.example/x', 'ftp://site.example/x', '//site.example', 'https://', 'https://a b', 'https://a\nb', 'https://a>b', 'https://a<b', long(201)]) {
      expect(() => toDiscord('hi', opts({ siteUrl: bad }))).toThrow(new RangeError(URL_MSG('siteUrl')))
    }
    expect(toDiscord('hi', opts({ siteUrl: long(200) })).parts).toHaveLength(1)
  })

  it('refuses a reply-to that is not an id and a link, with the same rules for the link', () => {
    const to = (over) => opts({ replyTo: { authorId: REPLIED, url: JUMP, ...over } })
    expect(() => toDiscord('hi', opts({ replyTo: 'x' }))).toThrow(new TypeError('replyTo must be an object or null'))
    expect(() => toDiscord('hi', opts({ replyTo: 5 }))).toThrow(new TypeError('replyTo must be an object or null'))
    for (const bad of [undefined, '12', 5, null]) expect(() => toDiscord('hi', to({ authorId: bad }))).toThrow(new RangeError(ID_MSG('replyTo.authorId')))
    for (const bad of [undefined, '', 'http://a.example', 'https://a b', 'https://a>b', `https://${'a'.repeat(193)}`]) expect(() => toDiscord('hi', to({ url: bad }))).toThrow(new RangeError(URL_MSG('replyTo.url')))
    expect(toDiscord('hi', to({ url: `https://${'a'.repeat(192)}` })).parts).toHaveLength(1)
    expect(toDiscord('hi', opts({ replyTo: null })).parts).toHaveLength(1)
    expect(toDiscord('hi', opts({ replyTo: undefined })).parts).toHaveLength(1)
  })

  it('refuses images that are not a list of a ref from 1 to 10 and a plain file name, each ref once', () => {
    const img = (over) => opts({ images: [{ ref: 1, name: 'u1.png', ...over }] })
    expect(() => toDiscord('hi', opts({ images: 'x' }))).toThrow(new TypeError('images must be a list'))
    expect(() => toDiscord('hi', opts({ images: {} }))).toThrow(new TypeError('images must be a list'))
    expect(() => toDiscord('hi', opts({ images: null }))).toThrow(new TypeError('images must be a list'))
    expect(() => toDiscord('hi', opts({ images: ['x'] }))).toThrow(new TypeError('images must hold objects'))
    expect(() => toDiscord('hi', opts({ images: [null] }))).toThrow(new TypeError('images must hold objects'))
    expect(() => toDiscord('hi', opts({ images: [[]] }))).toThrow(new TypeError('images must hold objects'))
    // No images at all is a reply with none.
    const { images, ...without } = opts()
    expect(images).toEqual([])
    expect(toDiscord('hi', without).parts).toHaveLength(1)
    for (const bad of [0, 11, 1.5, '1', Number.NaN, -1, undefined, null]) expect(() => toDiscord('hi', img({ ref: bad }))).toThrow(new RangeError('an image ref must be a whole number from 1 to 10'))
    for (const bad of ['', '.png', '-a.png', '../x.png', 'a b.png', 'a/b.png', 'a\\b.png', 'a:b.png', 5, undefined, null, `a${'b'.repeat(100)}`]) {
      expect(() => toDiscord('hi', img({ name: bad }))).toThrow(new RangeError('an image name must be a plain file name'))
    }
    expect(() => toDiscord('hi', opts({ images: [{ ref: 2, name: 'a.png' }, { ref: 2, name: 'b.png' }] }))).toThrow(new RangeError('image ref 2 is given twice'))
    for (const good of [1, 10]) expect(toDiscord('hi', img({ ref: good })).parts).toHaveLength(1)
    expect(toDiscord('hi', img({ name: `a${'b'.repeat(99)}` })).parts).toHaveLength(1)
    expect(toDiscord('hi', img({ name: 'A_b-1.c.PNG' })).parts).toHaveLength(1)
  })

  it('refuses a thread that is not a link and up to three ids known or null', () => {
    const th = (over) => opts({ thread: { urlBase: BASE, partIds: [MSG[0]], ...over } })
    expect(() => toDiscord('hi', opts({ thread: 'x' }))).toThrow(new TypeError('thread must be an object'))
    expect(() => toDiscord('hi', opts({ thread: null }))).toThrow(new TypeError('thread must be an object'))
    expect(() => toDiscord('hi', opts({ thread: [] }))).toThrow(new TypeError('thread must be an object'))
    expect(() => toDiscord('hi', th({ urlBase: 'https://discord.com/channels/1/2' }))).toThrow(new RangeError(BASE_MSG))
    expect(() => toDiscord('hi', th({ partIds: 'ab' }))).toThrow(new TypeError('thread.partIds must be a list'))
    expect(() => toDiscord('hi', th({ partIds: [...MSG, MSG[0]] }))).toThrow(new RangeError('thread.partIds must hold 0 to 3 ids'))
    expect(() => toDiscord('hi', th({ partIds: ['12'] }))).toThrow(new RangeError(ID_MSG('thread.partIds entry')))
    expect(() => toDiscord('hi', th({ partIds: [undefined] }))).toThrow(new RangeError(ID_MSG('thread.partIds entry')))
    expect(toDiscord('hi', th({ partIds: [null, null, null] })).parts).toHaveLength(1)
    expect(toDiscord('hi', opts({ thread: undefined })).parts).toHaveLength(1)
  })

  it('does not change what it was given', () => {
    const images = [{ ref: 1, name: 'u1.png' }]
    const replyTo = { authorId: REPLIED, url: JUMP }
    const thread = { urlBase: BASE, partIds: [...MSG] }
    const o = opts({ images, replyTo, thread })
    const snapshot = JSON.stringify(o)
    toDiscord('a ![x](upload:1)', o)
    expect(JSON.stringify(o)).toBe(snapshot)
  })
})

describe('toDiscord: the form of a reply in one part', () => {
  it('is one container: the text, the footer, then the link button', () => {
    expect(v2('Hello **world**')).toEqual({
      parts: [
        {
          text: `Hello **world**\n${FOOTER}`,
          components: [{ type: 17, components: [{ type: 10, content: `Hello **world**\n${FOOTER}` }, BUTTON] }],
          files: [],
        },
      ],
      length: 15,
      overBudget: false,
    })
  })

  it('is plain text and a footer line in the plain form, with no components', () => {
    expect(plain('Hello **world**')).toEqual({
      parts: [{ text: `Hello **world**\n${PLAIN_FOOTER}`, components: null, files: [] }],
      length: 15,
      overBudget: false,
    })
  })

  it('puts the reply line first', () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    expect(displays(v2('Hi', { replyTo }).parts[0])).toEqual([`${REPLY_LINE}\nHi\n${FOOTER}`])
    expect(plain('Hi', { replyTo }).parts[0].text).toBe(`${REPLY_LINE}\nHi\n${PLAIN_FOOTER}`)
    expect(v2('Hi', { replyTo }).length).toBe(2)
  })

  it('is the footer alone for an empty reply, and for one of nothing but blank lines', () => {
    for (const src of ['', ' ', '\n\n\n', ' \n\t\n']) {
      expect(displays(v2(src).parts[0])).toEqual([FOOTER])
      expect(plain(src).parts[0].text).toBe(PLAIN_FOOTER)
      expect(v2(src).length).toBe(0)
    }
  })

  it('does not hand out a part that shares what a later call gets', () => {
    const first = v2('a')
    inner(first.parts[0])[1].components[0].label = 'changed'
    first.parts[0].files.push('x')
    const second = v2('a')
    expect(inner(second.parts[0])[1]).toEqual(BUTTON)
    expect(second.parts[0].files).toEqual([])
  })

  it('turns a lone surrogate into the replacement character, as Discord refuses one', () => {
    expect(plain('a\ud800b\udc00c').parts[0].text).toBe(`a\ufffdb\ufffdc\n${PLAIN_FOOTER}`)
    expect(plain('a\udbffb\udfffc').parts[0].text).toBe(`a\ufffdb\ufffdc\n${PLAIN_FOOTER}`)
    expect(plain('\ud800\ud800\udc00\udc00').parts[0].text).toBe(`\ufffd\ud800\udc00\ufffd\n${PLAIN_FOOTER}`)
    expect(plain('a😀b').parts[0].text).toBe(`a😀b\n${PLAIN_FOOTER}`)
  })
})

describe('toDiscord: flattening the extended markdown', () => {
  const body = (src, over) => plain(src, over).parts[0].text.slice(0, -`\n${PLAIN_FOOTER}`.length)

  it('keeps headings 1 to 3 and turns headings 4 to 6 into a bold line', () => {
    expect(body('# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six')).toBe('# One\n## Two\n### Three\n**Four**\n**Five**\n**Six**')
  })

  it('does not nest bold in a bold heading, but keeps the other marks', () => {
    expect(body('#### a **b** c')).toBe('**a b c**')
    expect(body('#### a *b* `c` ~~d~~')).toBe('**a *b* `c` ~~d~~**')
    expect(body('### a **b** c')).toBe('### a **b** c')
  })

  it('keeps subtext, quotes, lists and code blocks as they were written', () => {
    expect(body('-# small **x**')).toBe('-# small **x**')
    expect(body('> a\n> b')).toBe('> a\n> b')
    expect(body('> a\n>\n> b')).toBe('> a\n>\n> b')
    expect(body('>>> x\ny')).toBe('> x\n> y')
    expect(body('- a\n  - b\n    - c\n* d\n1. e\n2. f')).toBe('- a\n  - b\n    - c\n* d\n1. e\n2. f')
    expect(body('1. a\n   - b')).toBe('1. a\n  - b')
    expect(body('```js\nlet a = 1\n\nlet b\n```')).toBe('```js\nlet a = 1\n\nlet b\n```')
    expect(body('```\nx\n```')).toBe('```\nx\n```')
    expect(body('> ```js\n> x\n> ```')).toBe('> ```js\n> x\n> ```')
    expect(body('- ## big\n- -# small\n- #### four')).toBe('- ## big\n- -# small\n- **four**')
  })

  it('does not let a code block close early: three backticks in it are kept apart', () => {
    expect(body('```\na```b\n```x\n    ```\n```')).toBe('```\na``\u200b`b\n``\u200b`x\n    ``\u200b`\n```')
    expect(body('```\n````\n```')).toBe('```\n``\u200b``\n```')
  })

  it('keeps a language name of letters, digits, plus and hyphen', () => {
    for (const lang of ['c++', 'objective-c', 'js_2', 'X9']) expect(body(`\`\`\`${lang}\nx\n\`\`\``)).toBe(`\`\`\`${lang}\nx\n\`\`\``)
  })

  it('keeps no language name that is not a plain short one', () => {
    expect(body(`\`\`\`${'a'.repeat(20)}\nx\n\`\`\``)).toBe(`\`\`\`${'a'.repeat(20)}\nx\n\`\`\``)
    expect(body(`\`\`\`${'a'.repeat(21)}\nx\n\`\`\``)).toBe('```\nx\n```')
  })

  it('writes the marks the writer meant as they are, and escapes the text that only looks like a mark', () => {
    const marked = '**a** *b* ***c*** __d__ ~~e~~ ||f|| `g` ``h`i``'
    expect(body(marked)).toBe(marked)
    expect(body('x _em_ y')).toBe('x *em* y')
    expect(body('||a\nb||')).toBe('||a\nb||')
    const source = String.raw`\* \_ \~ \| \` \< \[ \] \\`
    expect(body(source)).toBe(source)
    expect(body('snake_case_name')).toBe('snake\\_case\\_name')
  })

  it('escapes what would turn a line into a heading, list, subtext or quote, and nothing else', () => {
    for (const src of [String.raw`\# not a heading`, String.raw`\## no`, String.raw`\### no`, String.raw`\- not a list`, String.raw`\-# not subtext`, String.raw`\> not a quote`]) {
      expect(body(src)).toBe(src)
    }
    expect(body(`a\n${String.raw`  \# indented`}`)).toBe(`a\n${String.raw`  \# indented`}`)
    expect(body(String.raw`\#### four`)).toBe('#### four')
    expect(body('a # b')).toBe('a # b')
    expect(body('#nospace')).toBe('#nospace')
    expect(body('-x')).toBe('-x')
    expect(body('a > b')).toBe('a > b')
  })

  it('does not escape the text that starts a mark, which is not the start of the line', () => {
    expect(body(String.raw`**\# a** _\- b_ ~~\> c~~`)).toBe('**# a** *- b* ~~> c~~')
  })

  it('does not escape the text of a line that is not at its start, nor the text that follows a mark', () => {
    expect(body('**a** # b')).toBe('**a** # b')
    expect(body('**a** - b')).toBe('**a** - b')
    expect(body('**a** > b')).toBe('**a** > b')
    expect(body('[l](https://a.example/x) - b')).toBe('[l](<https://a.example/x>) - b')
  })

  it('keeps a mention, an emoji and a link, and wraps a bare link so that Discord shows no preview', () => {
    expect(body('<@123456789012345678> <@!123456789012345678> <@&123456789012345678> <#123456789012345678> <:wave:123456789012345678> <a:dance:123456789012345678>')).toBe(
      '<@123456789012345678> <@!123456789012345678> <@&123456789012345678> <#123456789012345678> <:wave:123456789012345678> <a:dance:123456789012345678>',
    )
    expect(body('see https://a.example/x.')).toBe('see <https://a.example/x>.')
    expect(body('<https://a.example/y>')).toBe('<https://a.example/y>')
    expect(body('[site](https://a.example/z)')).toBe('[site](<https://a.example/z>)')
    expect(body('[a **b** c](https://a.example/z)')).toBe('[a **b** c](<https://a.example/z>)')
    expect(body('https://a.example/x>y')).toBe('<https://a.example/x%3Ey>')
    // A link with nothing to show as its text is the bare address.
    expect(body('[ ](https://a.example/z)')).toBe('<https://a.example/z>')
    // And a mark that holds nothing marks nothing.
    expect(body('a ** ** b')).toBe('a   b')
  })

  it('writes a code span that holds a backtick in double ticks, and apart from a backtick it begins with', () => {
    expect(body('`x`')).toBe('`x`')
    expect(body('``a`b``')).toBe('``a`b``')
    expect(body('```x``')).toBe('`` `x``')
  })

  it('turns a table into a code block of cells padded to the width of their column', () => {
    expect(body('| name | qty |\n| --- | --- |\n| apple | 3 |\n| fig | 12 |')).toBe(['```', '| name  | qty |', '| ----- | --- |', '| apple | 3   |', '| fig   | 12  |', '```'].join('\n'))
  })

  it('fills a short row out with empty cells, and gives a column of one character one dash', () => {
    expect(body('| a | b |\n|---|---|\n| 1 |')).toBe('```\n| a | b |\n| - | - |\n| 1 |   |\n```')
    expect(body('a | b\n:-:|--:\n1 | 2')).toBe('```\n| a | b |\n| - | - |\n| 1 | 2 |\n```')
  })

  it('gives a column with nothing in it the width of one character', () => {
    expect(body('| |\n|-|\n| |')).toBe('```\n|   |\n| - |\n|   |\n```')
  })

  it('shows the runs of spaces of a cell as one space', () => {
    expect(body('| k |\n|---|\n| a   b\t c |')).toBe('```\n| k     |\n| ----- |\n| a b c |\n```')
  })

  it('trims the text of a cell once the marks are off it', () => {
    const shown = '(https://a.example/z)'
    expect(body('| k |\n|---|\n| [ ](https://a.example/z) |')).toBe(['```', `| ${'k'.padEnd(shown.length)} |`, `| ${'-'.repeat(shown.length)} |`, `| ${shown} |`, '```'].join('\n'))
  })

  it('reads a cell as the text it shows: no marks, a link with its address, a mention as it is', () => {
    const cell = '**b** [l](https://a.example/p) `c` <@123456789012345678> <:w:123456789012345678> *e* __u__ ~~s~~ ![alt](upload:1) https://a.example/q a\\|b'
    const shown = 'b l (https://a.example/p) c <@123456789012345678> :w: e u s alt https://a.example/q a|b'
    expect(body(`| k |\n|---|\n| ${cell} |`)).toBe(['```', `| ${'k'.padEnd(shown.length)} |`, `| ${'-'.repeat(shown.length)} |`, `| ${shown} |`, '```'].join('\n'))
  })

  it('keeps a table cell as one line and out of the way of the code block around it', () => {
    expect(body('| a |\n|---|\n| x ``` y |')).toBe('```\n| a        |\n| -------- |\n| x ``\u200b` y |\n```')
    expect(body('> | a |\n> |---|\n> | 1 |')).toBe('> ```\n> | a |\n> | - |\n> | 1 |\n> ```')
  })

  it('turns a divider into a Separator in the V2 form, and into a blank line in the plain form', () => {
    expect(inner(v2('a\n\n---\n\nb').parts[0])).toEqual([{ type: 10, content: 'a' }, SEP, { type: 10, content: `b\n${FOOTER}` }, BUTTON])
    expect(body('a\n---\nb')).toBe('a\n\nb')
    expect(body('a\n\n---\n\nb')).toBe('a\n\n\n\nb')
  })

  it('leaves out a Separator at the start or end of a part, where it would divide nothing', () => {
    expect(inner(v2('---\na\n---').parts[0])).toEqual([{ type: 10, content: `a\n${FOOTER}` }, BUTTON])
    expect(inner(v2('---').parts[0])).toEqual([{ type: 10, content: FOOTER }, BUTTON])
    expect(inner(v2('a\n---\n---\nb').parts[0]).map((c) => c.type)).toEqual([10, 14, 14, 10, 1])
  })

  it('lists a footnote at the end of the part, after the text and before the footer', () => {
    expect(displays(v2('a[^a]\n\n[^a]: the note').parts[0])).toEqual([`a\\[^a]\n-# \\[^a]: the note\n${FOOTER}`])
    expect(body('a[^a]\n\n[^a]: the note')).toBe('a\\[^a]\n-# \\[^a]: the note')
    expect(body('x[^a_b]\n\n[^a_b]: n')).toBe('x\\[^a\\_b]\n-# \\[^a\\_b]: n')
    expect(body('[^b]: second\nx[^b] y[^a]\n[^a]: first')).toBe('x\\[^b] y\\[^a]\n-# \\[^b]: second\n-# \\[^a]: first')
  })

  it('lists a note cited in the head or in a row of a table on the part that holds the table', () => {
    for (const table of ['| h[^a] |\n|---|\n| 1 |', '| h |\n|---|\n| 1[^a] |']) {
      const r = plain(`${table}\n\n${'c'.repeat(1000)}\n\n${'d'.repeat(1000)}\n\n[^a]: n`)
      expect(r.parts).toHaveLength(2)
      expect(r.parts[0].text.endsWith('\n-# \\[^a]: n')).toBe(true)
      expect(r.parts[1].text).not.toContain('-# \\[^a]')
    }
  })

  it('does not count blank lines at the start of a reply against its room', () => {
    expect(v2(`\n\n\n${x(PRIMARY_LIMIT)}`).parts).toHaveLength(1)
    expect(plain(`  \n\n${x(2000 - PLAIN_FOOTER.length - 1)}\n\n`).parts).toHaveLength(1)
  })

  it('counts a note once on a part, however many of its lines cite it', () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    const note = 'n'.repeat(100)
    const tail = note.length + '-# \\[^a]: '.length + 1
    // "a[^a]" shows as 6 characters of text and a line end, twice, and the note is listed once.
    const room = 4000 - REPLY_LINE.length - 38 - tail
    const body = (pad) => `${x(pad)}[^a]\n${x(1)}[^a]\n\n[^a]: ${note}`
    const exact = room - 5 - 1 - 6
    const fit = v2(body(exact), { replyTo })
    expect(fit.parts).toHaveLength(1)
    expect(displayableLength(fit.parts[0])).toBe(4000)
    expect(v2(body(exact + 1), { replyTo }).parts).toHaveLength(2)
  })

  it('lists a note once, for a note cited twice in one part', () => {
    expect(body('a[^a] b[^a]\n\n[^a]: n')).toBe('a\\[^a] b\\[^a]\n-# \\[^a]: n')
  })

  it('lists a note that no text cites at the end of the reply, and leaves a reference with no note as text', () => {
    expect(body('text\n\n[^z]: lone')).toBe('text\n-# \\[^z]: lone')
    expect(body('a[^q]')).toBe('a\\[^q\\]')
    expect(body('[^z]: only')).toBe('-# \\[^z]: only')
  })

  it('shows the alt text of an image in a note, which has no gallery', () => {
    const r = v2('x[^a]\n\n[^a]: **bold** ![pic](upload:1)', { images: [{ ref: 1, name: 'u1.png' }] })
    expect(displays(r.parts[0])).toEqual([`x\\[^a]\n-# \\[^a]: **bold** pic\n${FOOTER}`])
    expect(r.parts[0].files).toEqual([])
  })

  it('counts a footnote cited in a table cell, and lists it after the table', () => {
    expect(body('| a |\n|---|\n| 1[^n] |\n\n[^n]: note')).toBe('```\n| a     |\n| ----- |\n| 1[^n] |\n```\n-# \\[^n]: note')
  })

  it('puts an image in a Media Gallery where it was written, and attaches nothing in the V2 form beyond the file', () => {
    const images = [{ ref: 2, name: 'u2.png' }]
    const r = v2('before\n\n![alt](upload:2)\n\nafter', { images })
    expect(inner(r.parts[0])).toEqual([{ type: 10, content: 'before' }, gallery('u2.png'), { type: 10, content: `after\n${FOOTER}` }, BUTTON])
    expect(r.parts[0].files).toEqual(['u2.png'])
    expect(r.parts[0].text).toBe(`before\nafter\n${FOOTER}`)
  })

  it('shows an image written in the middle of a line after that line', () => {
    const images = [{ ref: 1, name: 'u1.png' }]
    const r = v2('see ![a](upload:1) here\nnext', { images })
    expect(inner(r.parts[0])).toEqual([{ type: 10, content: 'see  here' }, gallery('u1.png'), { type: 10, content: `next\n${FOOTER}` }, BUTTON])
    expect(v2('**![a](upload:1)** [![a](upload:1)](https://a.example) # ![a](upload:1)', { images }).parts[0].files).toEqual(['u1.png'])
    expect(inner(v2('**![a](upload:1)**', { images }).parts[0])).toEqual([gallery('u1.png'), { type: 10, content: FOOTER }, BUTTON])
  })

  it('puts consecutive images in one gallery, ten at most, and names a file once', () => {
    const images = [
      { ref: 1, name: 'u1.png' },
      { ref: 2, name: 'u2.png' },
    ]
    const r = v2('![a](upload:1)\n![b](upload:2)\n![c](upload:1)', { images })
    expect(inner(r.parts[0])[0]).toEqual(gallery('u1.png', 'u2.png', 'u1.png'))
    expect(r.parts[0].files).toEqual(['u1.png', 'u2.png'])
    const eleven = v2(Array.from({ length: 11 }, () => '![a](upload:1)').join('\n'), { images })
    expect(inner(eleven.parts[0]).slice(0, 2)).toEqual([gallery(...Array(10).fill('u1.png')), gallery('u1.png')])
    expect(inner(v2('![a](upload:1)\ntext\n![b](upload:2)', { images }).parts[0]).map((c) => c.type)).toEqual([12, 10, 12, 10, 1])
  })

  it('attaches an image under its part in the plain form, and shows nothing of it in the text', () => {
    const images = [
      { ref: 1, name: 'u1.png' },
      { ref: 2, name: 'u2.png' },
    ]
    const r = plain('before\n\n![alt](upload:2)\n\nafter ![b](upload:1) ![c](upload:2)', { images })
    expect(r.parts[0].text).toBe(`before\n\n\nafter\n${PLAIN_FOOTER}`)
    expect(r.parts[0].files).toEqual(['u2.png', 'u1.png'])
    expect(r.parts[0].components).toBeNull()
  })

  it('leaves no row for a line that held an image and nothing else but spaces', () => {
    const images = [{ ref: 1, name: 'u1.png' }]
    expect(body('a\n ![a](upload:1) \nb', { images })).toBe('a\nb')
    expect(inner(v2('- ![a](upload:1)', { images }).parts[0])).toEqual([gallery('u1.png'), { type: 10, content: FOOTER }, BUTTON])
    expect(inner(v2('## ![a](upload:1)\n-# ![a](upload:1)', { images }).parts[0])).toEqual([gallery('u1.png', 'u1.png'), { type: 10, content: FOOTER }, BUTTON])
  })

  it('shows the alt text of an image that has no file, as the site does, and nothing when it has none', () => {
    expect(body('a ![alt *text*](upload:5) b')).toBe('a alt \\*text\\* b')
    expect(body('![](upload:5)\nx')).toBe('x')
    // The alt text is the start of its line when the image is, and what at the start of a line is markup is escaped.
    expect(body('![# a](upload:5)')).toBe('\\# a')
    expect(body('x ![# a](upload:5)')).toBe('x # a')
    expect(v2('![alt](upload:5)').parts[0].files).toEqual([])
    expect(body('![a](upload:1)', { images: [{ ref: 2, name: 'u2.png' }] })).toBe('a')
  })

  it('writes an https image address, which is no image, as the masked link it is', () => {
    expect(body('![x](https://a.example/i.png)')).toBe('![x](<https://a.example/i.png>)')
  })
})

describe('toDiscord: where a reply is split', () => {
  const para = (ch, n) => ch.repeat(n)
  const paragraphs = (n, size) => Array.from({ length: n }, (_, i) => para(String.fromCharCode(97 + i), size)).join('\n\n')

  it('keeps a body of exactly the budget in one part, and splits one character more', () => {
    expect(v2(x(PRIMARY_LIMIT)).parts).toHaveLength(1)
    expect(v2(x(PRIMARY_LIMIT + 1)).parts).toHaveLength(2)
  })

  it('counts the reply line in the 4000 of a one-part reply, to the character', () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    const room = 4000 - REPLY_LINE.length - 38
    const one = v2(x(room), { replyTo })
    expect(one.parts).toHaveLength(1)
    expect(displayableLength(one.parts[0])).toBe(4000)
    expect(v2(x(room + 1), { replyTo }).parts).toHaveLength(2)
    const plainRoom = 2000 - REPLY_LINE.length - PLAIN_FOOTER.length - 2
    const pOne = plain(x(plainRoom), { replyTo })
    expect(pOne.parts).toHaveLength(1)
    expect(pOne.parts[0].text).toHaveLength(2000)
    expect(plain(x(plainRoom + 1), { replyTo }).parts).toHaveLength(2)
  })

  it('keeps the footer of the plain form in the 2000 of the last part', () => {
    const room = 2000 - PLAIN_FOOTER.length - 1
    expect(plain(x(room)).parts).toHaveLength(1)
    const two = plain(x(room + 1))
    expect(two.parts).toHaveLength(2)
    for (const part of two.parts) expect(part.text.length).toBeLessThanOrEqual(2000)
  })

  it('marks every part 1/N and breaks where a reader would, with the footer on the last part only', () => {
    const r = v2(paragraphs(3, 3000))
    expect(r.parts).toHaveLength(3)
    expect(r.parts.map((p) => displays(p).at(0))).toEqual([m(1, 3, para('a', 3000)), m(2, 3, para('b', 3000)), `${m(3, 3, para('c', 3000))}\n${FOOTER}`])
    expect(r.parts.map((p) => inner(p).at(-1))).toEqual([{ type: 10, content: m(1, 3, para('a', 3000)) }, { type: 10, content: m(2, 3, para('b', 3000)) }, BUTTON])
    expect(r.overBudget).toBe(false)
    expect(r.length).toBe(9000)
  })

  it('is over budget at the fourth part, and not at the third', () => {
    expect(v2(paragraphs(3, 3000)).overBudget).toBe(false)
    const four = v2(paragraphs(4, 3000))
    expect(four.parts).toHaveLength(4)
    expect(four.overBudget).toBe(true)
    expect(plain(paragraphs(3, 1000)).overBudget).toBe(false)
    expect(plain(paragraphs(3, 1000)).parts).toHaveLength(3)
    const pFour = plain(paragraphs(4, 1000))
    expect(pFour.parts).toHaveLength(4)
    expect(pFour.overBudget).toBe(true)
  })

  it('still answers every part of a reply that is over budget, each within the limit', () => {
    const r = v2(paragraphs(26, 3000))
    expect(r.overBudget).toBe(true)
    expect(r.parts.length).toBeGreaterThan(MAX_PARTS)
    for (const part of r.parts) expect(displayableLength(part)).toBeLessThanOrEqual(4000)
    expect(r.parts.at(-1).components[0].components.at(-1)).toEqual(BUTTON)
    expect(displays(r.parts[0])[0].startsWith(`**1/${r.parts.length}** `)).toBe(true)
  })

  it('fills part 1 to 4000 with the room its continues line takes, even when no link is sent yet', () => {
    const lines = markers([WORST_ID, WORST_ID, WORST_ID], WORST_BASE)
    const r = v2(x(9000))
    expect(r.parts).toHaveLength(3)
    expect(displayableLength(r.parts[0])).toBe(4000 - lines[0].length - 1)
    expect(displayableLength(r.parts[1])).toBe(4000 - lines[1].length - 1)
    for (const part of r.parts) expect(displayableLength(part)).toBeLessThanOrEqual(4000)
  })

  it('fills parts to exactly 4000 when the links are as long as they can be', () => {
    const thread = { urlBase: WORST_BASE, partIds: [WORST_ID, WORST_ID, WORST_ID] }
    const r = v2(x(9000), { thread })
    expect(r.parts).toHaveLength(3)
    expect(displayableLength(r.parts[0])).toBe(4000)
    expect(displayableLength(r.parts[1])).toBe(4000)
    expect(displayableLength(r.parts[2])).toBeLessThan(4000)
    const p = plain(x(4500), { thread })
    expect(p.parts).toHaveLength(3)
    expect(p.parts[0].text).toHaveLength(2000)
    expect(p.parts[1].text).toHaveLength(2000)
  })

  it('reserves the room of the first part for the reply line too, to the character', () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    const thread = { urlBase: WORST_BASE, partIds: [WORST_ID, WORST_ID, WORST_ID] }
    const r = v2(x(9000), { thread, replyTo })
    expect(displayableLength(r.parts[0])).toBe(4000)
    expect(displays(r.parts[0])[0].startsWith(`${REPLY_LINE}\n**1/3** `)).toBe(true)
  })

  it('sends the links to the later parts on part 1 and the link back on each later part', () => {
    const thread = { urlBase: BASE, partIds: MSG }
    const r = v2(paragraphs(3, 3000), { thread })
    const [one, two, three] = r.parts.map((p) => displays(p))
    expect(one).toEqual([`${m(1, 3, para('a', 3000))}\n-# continues: [2/3](<${BASE}/${MSG[1]}>) · [3/3](<${BASE}/${MSG[2]}>)`])
    expect(two).toEqual([`-# [↑ from 1/3](<${BASE}/${MSG[0]}>)\n${m(2, 3, para('b', 3000))}`])
    expect(three).toEqual([`-# [↑ from 1/3](<${BASE}/${MSG[0]}>)\n${m(3, 3, para('c', 3000))}\n${FOOTER}`])
    const p = plain(paragraphs(3, 1000), { thread })
    expect(p.parts[0].text).toBe(`${m(1, 3, para('a', 1000))}\n-# continues: [2/3](<${BASE}/${MSG[1]}>) · [3/3](<${BASE}/${MSG[2]}>)`)
    expect(p.parts[2].text).toBe(`-# [↑ from 1/3](<${BASE}/${MSG[0]}>)\n${m(3, 3, para('c', 1000))}\n${PLAIN_FOOTER}`)
  })

  it('leaves out a link whose message is not sent yet, and cuts in the same places as without links', () => {
    const src = paragraphs(3, 3000)
    const without = v2(src)
    for (const partIds of [[MSG[0], null, null], [MSG[0]], [null, null, null], [], MSG, [MSG[0], MSG[1], MSG[2]]]) {
      const r = v2(src, { thread: { urlBase: BASE, partIds } })
      expect(r.parts).toHaveLength(3)
      r.parts.forEach((part, i) => {
        const lines = displays(part)[0].split('\n').filter((l) => !/^-# (continues|\[↑)/.test(l))
        expect(lines).toEqual(displays(without.parts[i])[0].split('\n'))
      })
    }
    const partial = v2(src, { thread: { urlBase: BASE, partIds: [MSG[0], null, null] } })
    expect(displays(partial.parts[0])[0]).not.toContain('continues')
    expect(displays(partial.parts[1])[0]).toContain('↑ from 1/3')
    const later = v2(src, { thread: { urlBase: BASE, partIds: [null, MSG[1], MSG[2]] } })
    expect(displays(later.parts[0])[0]).toContain('continues')
    expect(displays(later.parts[1])[0]).not.toContain('↑')
  })

  it('sends no link for a reply in one part, whatever it is given', () => {
    const r = v2('short', { thread: { urlBase: BASE, partIds: MSG } })
    expect(displays(r.parts[0])).toEqual([`short\n${FOOTER}`])
  })

  it('cuts a fence that does not fit into parts that each close it and open it again', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, '0')} ${x(90)}`)
    const r = plain(`\`\`\`js\n${lines.join('\n')}\n\`\`\``)
    expect(r.parts.length).toBeGreaterThan(1)
    const seen = []
    r.parts.forEach((part, i) => {
      const body = part.text.replace(`\n${PLAIN_FOOTER}`, '')
      const rows = body.split('\n')
      const fences = rows.filter((l) => l.startsWith('```'))
      expect(fences.length % 2).toBe(0)
      expect(rows[0]).toBe(`**${i + 1}/${r.parts.length}**`)
      expect(rows[1]).toBe('```js')
      expect(rows.at(-1)).toBe('```')
      expect(part.text.length).toBeLessThanOrEqual(2000)
      seen.push(...rows.filter((l) => l.startsWith('line ')))
    })
    expect(seen).toEqual(lines)
  })

  it('closes and opens a fence in a quote with the quote mark', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `> line ${String(i).padStart(2, '0')} ${x(90)}`)
    const r = plain(`> \`\`\`\n${lines.join('\n')}\n> \`\`\``)
    expect(r.parts.length).toBeGreaterThan(1)
    for (const part of r.parts) {
      const rows = part.text.replace(`\n${PLAIN_FOOTER}`, '').split('\n')
      expect(rows[1]).toBe('> ```')
      expect(rows.at(-1)).toBe('> ```')
    }
  })

  it('cuts inside a long line of a fence, with the fence closed and opened round the cut', () => {
    const r = plain(`\`\`\`\n${'k'.repeat(5000)}\n\`\`\``)
    expect(r.parts.length).toBeGreaterThan(2)
    for (const part of r.parts) {
      expect(part.text.length).toBeLessThanOrEqual(2000)
      expect(part.text.split('\n').filter((l) => l.startsWith('```')).length % 2).toBe(0)
    }
    expect(r.parts.map((p) => p.text.replaceAll(/[^k]/g, '')).join('')).toBe('k'.repeat(5000))
  })

  it('does not close a fence that a cut did not fall in', () => {
    const r = plain(`${x(1500)}\n\n\`\`\`\ncode\n\`\`\`\n\n${x(1500)}`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `${x(1500)}\n\n\`\`\`\ncode\n\`\`\``), `${m(2, 2, x(1500))}\n${PLAIN_FOOTER}`])
  })

  it('puts a footnote at the end of each part that cites it, and not of the others', () => {
    const src = `${para('a', 1000)}[^a]\n\n${para('b', 1000)}\n\n${para('c', 1000)}[^b]\n\n[^a]: first note\n[^b]: second note`
    const r = plain(src)
    expect(r.parts).toHaveLength(3)
    expect(r.parts[0].text).toBe(`${m(1, 3, `${para('a', 1000)}\\[^a]`)}\n-# \\[^a]: first note`)
    expect(r.parts[1].text).toBe(m(2, 3, para('b', 1000)))
    expect(r.parts[2].text).toBe(`${m(3, 3, `${para('c', 1000)}\\[^b]`)}\n-# \\[^b]: second note\n${PLAIN_FOOTER}`)
    expect(r.length).toBe(1005 + 1000 + 1005 + '-# \\[^a]: first note'.length + '-# \\[^b]: second note'.length)
  })

  it('counts the room a note takes against the part that lists it', () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    const note = 'n'.repeat(200)
    const room = 4000 - REPLY_LINE.length - 38 - (note.length + '-# \\[^a]: '.length + 1)
    const fit = v2(`${x(room - 5)}[^a]\n\n[^a]: ${note}`, { replyTo })
    expect(fit.parts).toHaveLength(1)
    expect(displayableLength(fit.parts[0])).toBe(4000)
    expect(v2(`${x(room - 4)}[^a]\n\n[^a]: ${note}`, { replyTo }).parts).toHaveLength(2)
  })

  it('lists the notes of a line on its part up to 400 characters, and at the end of the reply past that', () => {
    const at = (text) => plain(`${para('a', 1000)}[^a]\n\n${para('b', 1000)}\n\n${para('c', 1000)}\n\n[^a]: ${text}`)
    const fit = at('n'.repeat(389))
    expect(fit.parts[0].text.endsWith(`\n-# \\[^a]: ${'n'.repeat(389)}`)).toBe(true)
    expect(fit.parts[2].text).not.toContain('-# \\[^a]')
    const over = at('n'.repeat(390))
    expect(over.parts[0].text).not.toContain('-# \\[^a]')
    expect(over.parts[2].text).toBe(`${m(3, 3, para('c', 1000))}\n-# \\[^a]: ${'n'.repeat(390)}\n${PLAIN_FOOTER}`)
  })

  it('cuts the first line of a part, when the closing and opening of its fence leave it too little room', () => {
    // A part of the middle holds 1881 characters of body; its fence is opened again (4) and closed (4), and its first line is the z line.
    const letters = (text, ch) => text.split(ch).length - 1
    const run = (z) => plain(`\`\`\`\n${'q'.repeat(1700)}\n${'z'.repeat(z)}\n${'j'.repeat(3000)}\n\`\`\``).parts
    for (const part of run(1874)) {
      expect(part.text.length).toBeLessThanOrEqual(2000)
      expect(part.text.split('\n').filter((l) => l.startsWith('```')).length % 2).toBe(0)
    }
    // The line fits a part but not with the fence's closing: it is cut, one character short of whole, or at the room there is.
    expect(run(1873).map((part) => letters(part.text, 'z'))).toEqual([0, 1872, 1, 0])
    expect(run(1876).map((part) => letters(part.text, 'z'))).toEqual([0, 1873, 3, 0])
    expect(run(1872).map((part) => letters(part.text, 'z'))).toEqual([0, 1872, 0, 0])
    for (const z of [1872, 1873, 1876]) expect(run(z).reduce((n, part) => n + letters(part.text, 'j'), 0)).toBe(3000)
  })

  it('fills the part of a fence that opens with the first line of the code, when that line is a part long', () => {
    const run = (k) => plain(`\`\`\`\n${'k'.repeat(k)}\n${'j'.repeat(2000)}\n\`\`\``).parts
    // 1774 is the body of a first part: the line is cut after the opener, and the part holds 1766 of it.
    const whole = run(1774)
    expect(whole[0].text).toBe(`**1/3**\n\`\`\`\n${'k'.repeat(1766)}\n\`\`\``)
    expect(whole[1].text.split('\n')[2]).toBe('k'.repeat(8))
    // A line of 1769 fits with the opener but not with the fence's closing too: the opener ends the part, with nothing in it.
    const less = run(1769)
    expect(less[0].text).toBe('**1/4**\n```\n```')
    expect(less[1].text.split('\n')[2]).toBe('k'.repeat(1769))
  })

  it('makes no part of the first sentence of a long reply, in either form', () => {
    const v = v2(`Hello. ${'a'.repeat(5000)}`)
    expect(v.parts).toHaveLength(2)
    expect(displays(v.parts[0])[0]).toHaveLength('**1/2** '.length + 3774)
    const p = plain(`Hello. ${'a'.repeat(5000)}`)
    expect(p.parts).toHaveLength(3)
    expect(p.parts[0].text).toHaveLength('**1/3** '.length + 1774)
  })

  it('cuts the last pieces of a long line so that the last part has something and the others do not run over', () => {
    expect(plain('k'.repeat(5505)).parts.map((part) => part.text.split('k').length - 1)).toEqual([1774, 1881, 1849, 1])
  })

  it('makes room for a wider mark when a reply has ten parts or more', () => {
    // 9 for "**1/26** " and 3772 of text, which is what the 4000 leaves with the 218 of the links that part 1 may take.
    const r = v2(x(100_000))
    expect(r.parts).toHaveLength(26)
    expect(displays(r.parts[0])[0]).toHaveLength(9 + 3772)
    expect(displays(r.parts[1])[0]).toHaveLength(9 + 3879)
  })

  it('counts the notes of a line that is cut against each piece of it', () => {
    const r = plain(`${'k'.repeat(5000)}[^a]\n\n[^a]: n`)
    expect(r.parts.map((part) => part.text.length)).toEqual([1782, 1889, 1489])
    expect(r.parts[0].text.endsWith('\n-# \\[^a]: n')).toBe(true)
    expect(r.parts[1].text).toContain('-# \\[^a]: n')
  })

  it('fills a part cut inside a fence to exactly 2000, with its fence closed and opened again', () => {
    const thread = { urlBase: WORST_BASE, partIds: [WORST_ID, WORST_ID, WORST_ID] }
    const r = plain(`\`\`\`\n${'k'.repeat(3739)}\n\`\`\``, { thread })
    expect(r.parts).toHaveLength(3)
    expect(r.parts[0].text).toHaveLength(2000)
    expect(r.parts[1].text).toHaveLength(2000)
    expect(r.parts[0].text.split('\n')[1]).toBe('```')
    expect(r.parts[1].text.split('\n').slice(0, 3)).toEqual([`-# [↑ from 1/3](<${WORST_BASE}/${WORST_ID}>)`, '**2/3**', '```'])
  })

  it('leaves room on the last part for the footer, which the part before it does not need', () => {
    const second = `${'a'.repeat(1000)}\n\n${'b'.repeat(1800)}`
    const r = plain(second)
    expect(r.parts).toHaveLength(3)
    for (const part of r.parts) expect(part.text.length).toBeLessThanOrEqual(2000)
    const big = v2(`${x(3000)}\n\n${'b'.repeat(3860)}`)
    expect(big.parts).toHaveLength(3)
    for (const part of big.parts) expect(displayableLength(part)).toBeLessThanOrEqual(4000)
  })

  it('lists a note that is too long to sit on a part at the end of the reply, as lines the splitter can cut', () => {
    const note = 'n'.repeat(500)
    const r = plain(`a[^a]\n\n[^a]: ${note}`)
    expect(r.parts).toHaveLength(1)
    expect(r.parts[0].text).toBe(`a\\[^a]\n-# \\[^a]: ${note}\n${PLAIN_FOOTER}`)
    const huge = plain(`a[^a]\n\n[^a]: ${'n'.repeat(5000)}`)
    expect(huge.parts.length).toBeGreaterThan(2)
    for (const part of huge.parts) expect(part.text.length).toBeLessThanOrEqual(2000)
  })

  it('lists the notes of a line that cites many of them at the end, when they would not fit beside it', () => {
    const labels = Array.from({ length: 12 }, (_, i) => `n${i}`)
    const notes = labels.map((l) => `[^${l}]: ${'t'.repeat(60)}`).join('\n')
    const refs = labels.map((l) => `[^${l}]`).join(' ')
    const r = plain(`${refs}\n\n${x(1700)}\n\n${notes}`)
    for (const part of r.parts) expect(part.text.length).toBeLessThanOrEqual(2000)
    const all = r.parts.map((p) => p.text).join('\n')
    for (const l of labels) expect(all).toContain(`-# \\[^${l}]: ${'t'.repeat(60)}`)
    expect(r.parts[0].text).not.toContain('-# \\[^n0]')
  })

  it('does not take a note again for a part that holds only a part of the line that cites it', () => {
    const r = plain(`${'word '.repeat(700)}[^a]\n\n[^a]: note`)
    expect(r.parts).toHaveLength(2)
    for (const part of r.parts) expect(part.text.length).toBeLessThanOrEqual(2000)
    expect(r.parts.map((p) => p.text).join('\n').split('-# \\[^a]: note').length - 1).toBe(2)
  })

  it('keeps no more than 17 dividers or image breaks in a V2 part, so a part keeps within 40 components', () => {
    const src = Array.from({ length: 40 }, () => 'a\n---').join('\n')
    const r = v2(src)
    expect(r.parts.length).toBeGreaterThanOrEqual(2)
    for (const part of r.parts) expect(count(part.components)).toBeLessThanOrEqual(40)
    expect(v2(Array.from({ length: 60 }, () => 'a\n---').join('\n')).overBudget).toBe(true)
    const ok = v2(Array.from({ length: 17 }, () => 'a\n---').join('\n') + '\na')
    expect(ok.parts).toHaveLength(1)
    expect(count(ok.parts[0].components)).toBeLessThanOrEqual(40)
  })

  it('splits a reply of images at 17 in a part', () => {
    const images = [{ ref: 1, name: 'u1.png' }]
    const src = Array.from({ length: 17 }, (_, i) => `t${i}\n![a](upload:1)`).join('\n')
    expect(v2(src, { images }).parts).toHaveLength(1)
    const more = v2(`${src}\nlast\n![a](upload:1)`, { images })
    expect(more.parts).toHaveLength(2)
    for (const part of more.parts) expect(count(part.components)).toBeLessThanOrEqual(40)
  })

  it('splits where an image is, since there it is a break', () => {
    const images = [{ ref: 1, name: 'u1.png' }]
    const r = v2(`${para('a', 3000)}\n![a](upload:1)\n${para('b', 3000)}`, { images })
    expect(r.parts).toHaveLength(2)
    expect(r.parts[0].files).toEqual(['u1.png'])
    expect(r.parts[1].files).toEqual([])
    expect(inner(r.parts[0]).map((c) => c.type)).toEqual([10, 12])
    const p = plain(`${para('a', 1000)}\n![a](upload:1)\n${para('b', 1000)}\n\n${para('c', 1000)}`, { images })
    expect(p.parts.map((part) => part.files)).toEqual([['u1.png'], [], []])
  })

  it('marks a part that starts with an image, before it, and only once', () => {
    const images = [{ ref: 1, name: 'u1.png' }]
    const src = `${Array.from({ length: 18 }, () => '![a](upload:1)').join('\n')}\ntail`
    const r = v2(src, { images })
    expect(r.parts).toHaveLength(2)
    expect(inner(r.parts[0]).map((c) => c.type)).toEqual([10, 12, 12])
    expect(displays(r.parts[0])).toEqual(['**1/2**'])
    expect(inner(r.parts[1])).toEqual([{ type: 10, content: '**2/2**' }, gallery('u1.png'), { type: 10, content: `tail\n${FOOTER}` }, BUTTON])
  })

  it('still marks a part with nothing in it but dividers, which are left out', () => {
    const r = v2(Array.from({ length: 18 }, () => '---').join('\n'))
    expect(r.parts).toHaveLength(2)
    expect(displays(r.parts[0])).toEqual(['**1/2**'])
    expect(displays(r.parts[1])).toEqual([`**2/2**\n${FOOTER}`])
    // The limit of 17 is the one thing that may end a part under half full.
    expect(displayableLength(r.parts[0])).toBeLessThan(2000)
  })

  it('names a file once for each part it is in', () => {
    const images = [{ ref: 1, name: 'u1.png' }]
    const r = v2(`![a](upload:1)\n${para('a', 3000)}\n![a](upload:1)\n${para('b', 3000)}\n![a](upload:1)`, { images })
    expect(r.parts.map((p) => p.files)).toEqual([['u1.png'], ['u1.png']])
  })

  it('reads a long reply in time that is linear in its size', () => {
    const src = 'a\n\n'.repeat(50_000)
    const start = performance.now()
    const r = v2(src)
    expect(r.overBudget).toBe(true)
    const images = [{ ref: 1, name: 'u1.png' }]
    expect(v2('![a](upload:1)\n'.repeat(20_000), { images }).parts.length).toBeGreaterThan(500)
    expect(plain('![a](upload:1)\n'.repeat(20_000), { images }).parts).toHaveLength(1)
    expect(performance.now() - start).toBeLessThan(globalThis.__stryker__ ? 30_000 : 5000)
  })
})

describe('budget', () => {
  it('answers the characters used, the room of three parts and the number of parts', () => {
    expect(budget('Hello', opts())).toEqual({ used: 5, limit: 3 * 3950, parts: 1 })
    expect(budget('Hello', opts({ form: 'plain' }))).toEqual({ used: 5, limit: 3 * 1950, parts: 1 })
    expect(budget(`${x(5000)}`, opts())).toEqual({ used: 5000, limit: 11850, parts: 2 })
    expect(budget('', opts())).toEqual({ used: 0, limit: 11850, parts: 1 })
  })

  it('agrees with toDiscord, and refuses what toDiscord refuses', () => {
    const src = `${'word '.repeat(2000)}`
    const r = toDiscord(src, opts())
    expect(budget(src, opts())).toEqual({ used: r.length, limit: 11850, parts: r.parts.length })
    expect(() => budget('hi', opts({ form: 'x' }))).toThrow(new RangeError(FORM_MSG))
    expect(() => budget(5, opts())).toThrow(new TypeError('the source must be a string'))
  })

  it('shows a parts count over 3 for a reply that is over budget', () => {
    expect(budget('a\n\n'.repeat(20_000), opts()).parts).toBeGreaterThan(MAX_PARTS)
  })
})

describe('toDiscord: properties over hostile replies', () => {
  const word = fc.stringMatching(/^[a-z]{1,12}$/)
  const sentence = fc.array(word, { minLength: 1, maxLength: 14 }).map((w) => `${w.join(' ')}.`)
  const prose = fc.array(sentence, { minLength: 1, maxLength: 40 }).map((s) => s.join(' '))
  const lines = fc.array(sentence, { minLength: 1, maxLength: 12 }).map((s) => s.join('\n'))
  const block = fc.oneof(
    { weight: 6, arbitrary: prose },
    { weight: 3, arbitrary: lines },
    { weight: 2, arbitrary: fc.array(word, { minLength: 1, maxLength: 40 }).map((w) => w.map((t) => `- ${t} item`).join('\n')) },
    { weight: 2, arbitrary: fc.array(word, { minLength: 1, maxLength: 70 }).map((w) => `\`\`\`\n${w.join('\n')}\n\`\`\``) },
    { weight: 2, arbitrary: fc.array(word, { minLength: 1, maxLength: 12 }).map((w) => `| a | b |\n| - | - |\n${w.map((t) => `| ${t} | ${t}${t} |`).join('\n')}`) },
    { weight: 2, arbitrary: fc.constantFrom('---', '# H', '#### Four', '-# small', '> quote', '![a](upload:1)', '![b](upload:2)', '![c](upload:3)\n![c](upload:3)', '```', '| a |', '[^a]: note a', '[^b]: ' + 'n'.repeat(300)) },
    { weight: 2, arbitrary: prose.map((p) => `${p}[^a] and${p.slice(0, 20)}[^b]`) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 6000 }).map((n) => x(n)) },
    { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 80 }) },
    { weight: 1, arbitrary: fc.array(fc.constantFrom('😀', '𝒳', 'a', ' ', '|', '*', '_', '\\', '`', '<', '[', '>'), { maxLength: 400 }).map((a) => a.join('')) },
  )
  const doc = fc.array(block, { maxLength: 12 }).chain((blocks) => fc.constantFrom('\n\n', '\n').map((sep) => blocks.join(sep)))
  const IMAGES = [1, 2, 3].map((ref) => ({ ref, name: `u${ref}.png` }))
  const options = fc.record({
    form: fc.constantFrom('v2', 'plain'),
    replyTo: fc.constantFrom(null, { authorId: REPLIED, url: JUMP }, { authorId: WORST_ID, url: `https://${'a'.repeat(192)}` }),
    thread: fc.constantFrom(undefined, { urlBase: BASE, partIds: MSG }, { urlBase: WORST_BASE, partIds: [WORST_ID, WORST_ID, WORST_ID] }, { urlBase: BASE, partIds: [MSG[0], null, null] }),
    siteUrl: fc.constantFrom(SITE, `https://${'s'.repeat(192)}`),
  })
  const build = (o) => ({ ...opts(), ...o, images: IMAGES })

  it('never throws, never over the limit, never with more than 40 components', () => {
    fc.assert(
      fc.property(doc, options, (src, o) => {
        const r = toDiscord(src, build(o))
        expect(r.parts.length).toBeGreaterThanOrEqual(1)
        expect(r.overBudget).toBe(r.parts.length > MAX_PARTS)
        for (const part of r.parts) {
          if (o.form === 'v2') {
            expect(displayableLength(part)).toBeLessThanOrEqual(4000)
            expect(count(part.components)).toBeLessThanOrEqual(40)
            expect(part.components).toHaveLength(1)
            for (const c of inner(part)) if (c.type === 10) expect(c.content.length).toBeGreaterThan(0)
            expect(part.files.length).toBeLessThanOrEqual(10)
          } else {
            expect(part.text.length).toBeLessThanOrEqual(2000)
            expect(part.components).toBeNull()
          }
          expect(part.text.length).toBeGreaterThan(0)
          expect(part.text.isWellFormed()).toBe(true)
          expect(new Set(part.files).size).toBe(part.files.length)
        }
      }),
      { numRuns: 150 },
    )
  })

  it('counts every displayable character of every V2 part against 4000, links and all', () => {
    fc.assert(
      fc.property(doc, options, (src, o) => {
        const r = toDiscord(src, build({ ...o, form: 'v2' }))
        for (const part of r.parts) {
          const texts = inner(part)
            .filter((c) => c.type === 10)
            .reduce((n, c) => n + c.content.length, 0)
          const labels = part.components[0].components.filter((c) => c.type === 1).reduce((n, c) => n + c.components[0].label.length, 0)
          expect(texts + labels).toBeLessThanOrEqual(4000)
        }
      }),
      { numRuns: 150 },
    )
  })

  // The half is of the room for the text: the part holds that and its marker, reply line and links, all of which count to
  // the limit. The links are in a part only when its message ids are given, at their longest here, and for no more than 3 parts.
  it('leaves every part but the last at least half the limit, as long as no divider or image breaks it', () => {
    const body = fc.oneof(prose, lines, fc.integer({ min: 1, max: 4000 }).map((n) => x(n)), fc.array(word, { minLength: 1, maxLength: 70 }).map((w) => `\`\`\`\n${w.join('\n')}\n\`\`\``), fc.array(word, { minLength: 1, maxLength: 40 }).map((w) => w.map((t) => `- ${t} item`).join('\n')))
    const plainDoc = fc.array(body, { maxLength: 4 }).chain((blocks) => fc.constantFrom('\n\n', '\n').map((sep) => blocks.join(sep)))
    const thread = { urlBase: WORST_BASE, partIds: [WORST_ID, WORST_ID, WORST_ID] }
    fc.assert(
      fc.property(plainDoc, fc.constantFrom('v2', 'plain'), fc.constantFrom(null, { authorId: REPLIED, url: JUMP }), (src, form, replyTo) => {
        const r = toDiscord(src, build({ form, replyTo, thread }))
        if (r.parts.length > MAX_PARTS) return
        for (const part of r.parts.slice(0, -1)) expect(displayableLength(part)).toBeGreaterThanOrEqual((form === 'v2' ? 4000 : 2000) / 2)
      }),
      { numRuns: 200 },
    )
  })

  it('numbers its parts in order, and puts the footer on the last one only', () => {
    fc.assert(
      fc.property(doc, options, (src, o) => {
        const r = toDiscord(src, build(o))
        const n = r.parts.length
        r.parts.forEach((part, i) => {
          const text = o.form === 'v2' ? displays(part).join('\n') : part.text
          const last = i === n - 1
          expect(text.includes(`-# <@${AUTHOR}>`)).toBe(last)
          if (o.form === 'v2') expect(inner(part).some((c) => c.type === 1)).toBe(last)
          if (n > 1) expect(new RegExp(`\\*\\*${i + 1}/${n}\\*\\*`).test(text)).toBe(true)
          else expect(/\*\*1\/1\*\*/.test(text)).toBe(false)
        })
      }),
      { numRuns: 120 },
    )
  })

  it('cuts in the same places whatever links it is given', () => {
    fc.assert(
      fc.property(doc, fc.constantFrom('v2', 'plain'), (src, form) => {
        const bare = toDiscord(src, build({ form }))
        const linked = toDiscord(src, build({ form, thread: { urlBase: WORST_BASE, partIds: [WORST_ID, WORST_ID, WORST_ID] } }))
        expect(linked.parts).toHaveLength(bare.parts.length)
        expect(linked.length).toBe(bare.length)
        expect(linked.parts.map((p) => p.files)).toEqual(bare.parts.map((p) => p.files))
      }),
      { numRuns: 100 },
    )
  })

  it('loses nothing and repeats nothing of a reply that is words and line ends', () => {
    const plainDoc = fc.array(fc.oneof(prose, lines, fc.integer({ min: 1, max: 5000 }).map((n) => 'w'.repeat(n))), { minLength: 1, maxLength: 8 }).map((b) => b.join('\n\n'))
    fc.assert(
      fc.property(plainDoc, fc.constantFrom('v2', 'plain'), (src, form) => {
        const r = toDiscord(src, build({ form }))
        const body = r.parts
          .map((part, i) => {
            const text = form === 'v2' ? displays(part).join('') : part.text
            const noFooter = i === r.parts.length - 1 ? text.replace(form === 'v2' ? FOOTER : PLAIN_FOOTER, '') : text
            return unmark(noFooter)
          })
          .join('')
        expect(body.replace(/\s+/g, '')).toBe(src.replace(/\s+/g, ''))
      }),
      { numRuns: 150 },
    )
  })

  it('parses back to what was written, for the text of one line', () => {
    // The parser takes an escaped mark inside a span for the span's end, which Discord does not, so escapes stand between spans.
    const escaped = fc.constantFrom('\\*', '\\_', '\\~', '\\|', '\\`', '\\<', '\\[', '\\]', '\\\\', '\\#', '\\-', '\\>', '\\-#')
    const atoms = fc.oneof(
      word,
      escaped,
      fc.constantFrom('#', '-', '>', '-#', '1.', '<@123456789012345678>', '<:w:123456789012345678>', 'https://a.example/x', '<https://a.example/y>', '[t](https://a.example/z)', '@everyone'),
      word.map((w) => `**${w}**`),
      word.map((w) => `*${w}*`),
      word.map((w) => `_${w}_`),
      word.map((w) => `__${w}__`),
      word.map((w) => `~~${w}~~`),
      word.map((w) => `||${w}||`),
      word.map((w) => `\`${w}\``),
      word.map((w) => `***${w}***`),
      word.map((w) => `**${w} *${w}* ${w}**`),
    )
    fc.assert(
      fc.property(fc.array(atoms, { minLength: 1, maxLength: 12 }), (items) => {
        const src = `x ${items.join(' ')}`
        const text = plain(src).parts[0].text
        const flat = text.slice(0, text.lastIndexOf('\n-# <@'))
        const before = parse(src, { dialect: 'discord' })
        expect(before).toHaveLength(1)
        expect(parse(flat, { dialect: 'discord' })).toEqual(before)
      }),
      { numRuns: 500 },
    )
  })
})

describe('placement: which pictures are attached to which part', () => {
  const pics = (...refs) => refs.map((ref) => ({ ref, name: `picture-${ref}.png` }))
  const place = (src, over) => placement(src, opts({ images: pics(1, 2, 3), ...over }))
  // Three paragraphs of 3000 characters cannot share a part, so each is one, and a picture sits between them.
  const THREE = (a, b, c) => `${x(3000)}\n\n${a}\n\n${x(3000)}\n\n${b}\n\n${x(3000)}\n\n${c}`
  const img = (n) => `![alt](upload:${n})`

  it('is no part with a picture when there are no pictures', () => {
    expect(place('Hello there.')).toEqual([])
    expect(place('')).toEqual([])
  })

  it('lists the ref of a picture in the part that carries it, in both forms', () => {
    for (const form of ['v2', 'plain']) {
      expect(place(`Look: ${img(2)}`, { form })).toEqual([[2]])
    }
  })

  it('lists the refs of a part in the order the source shows them, not the order they were given or numbered', () => {
    const src = `${img(3)}\n\ntext\n\n${img(1)}\n\n${img(2)}`
    expect(place(src)).toEqual([[3, 1, 2]])
    expect(place(src, { images: pics(2, 3, 1) })).toEqual([[3, 1, 2]])
  })

  it('lists a picture once however many times it is shown in a part', () => {
    expect(place(`${img(1)}\n\n${img(1)}\n\n${img(2)}\n\n${img(1)}`)).toEqual([[1, 2]])
  })

  it('puts each picture in the part it falls in, over three parts', () => {
    const src = THREE(img(1), img(2), img(3))
    expect(place(src)).toEqual([[1], [2], [3]])
    expect(place(THREE(img(3), img(2), img(1)))).toEqual([[3], [2], [1]])
  })

  it('keeps the parts with no picture before the last one that has one, as empty lists, and drops the empty parts that end it', () => {
    expect(place(THREE('', '', img(1)))).toEqual([[], [], [1]])
    expect(place(THREE(img(1), '', ''))).toEqual([[1]])
    expect(place(THREE('', img(2), ''))).toEqual([[], [2]])
    expect(place(THREE('', '', ''))).toEqual([])
  })

  it('does not place a picture that has no file: it is shown as its alt text', () => {
    expect(place(`${img(1)} ${img(2)}`, { images: pics(2) })).toEqual([[2]])
    expect(place(img(1), { images: [] })).toEqual([])
  })

  it('does not place what is not a picture: a link, a code span, a refused ref', () => {
    expect(place('[1](upload:1) and `![a](upload:1)`')).toEqual([])
  })

  it('is the same whatever the files are called', () => {
    const src = THREE(img(1), img(2), img(3))
    const named = place(src, { images: [1, 2, 3].map((ref) => ({ ref, name: `other-${ref}.jpg` })) })
    expect(named).toEqual(place(src))
  })

  it('is the same with the links of the parts as without them: the cuts do not move', () => {
    const src = THREE(img(1), img(2), img(3))
    const thread = { urlBase: BASE, partIds: [MSG[0], MSG[1], null] }
    expect(place(src, { thread })).toEqual(place(src))
    expect(place(src, { thread: { urlBase: BASE, partIds: [] } })).toEqual(place(src))
  })

  it('follows the reply line and the footer, which take room, as toDiscord cuts', () => {
    const src = `${x(3900)}\n\n${img(1)}`
    const replyTo = { authorId: REPLIED, url: JUMP }
    for (const over of [{}, { replyTo }]) {
      const parts = v2(src, { images: pics(1), ...over }).parts
      expect(place(src, over)).toEqual(parts.map((part) => part.files.map((name) => Number(/(\d+)/.exec(name)[1]))).reduceRight((acc, refs) => (acc.length === 0 && refs.length === 0 ? acc : [refs, ...acc]), []))
    }
  })

  it('answers for a reply that is over its budget too, since it only says where the pictures fall', () => {
    expect(place(`${x(13000)}\n\n${img(1)}`)).toEqual([[], [], [], [1]])
  })

  it('refuses two refs that share a file name, since the part cannot say which of them it carries', () => {
    expect(() => place(img(1), { images: [{ ref: 1, name: 'same.png' }, { ref: 2, name: 'same.png' }] })).toThrow(new RangeError('two image refs share a file name'))
  })

  it('refuses what toDiscord refuses', () => {
    expect(() => placement(3, opts())).toThrow(new TypeError('the source must be a string'))
    expect(() => placement('x', null)).toThrow(new TypeError('the options must be an object'))
    expect(() => place('x', { form: 'html' })).toThrow(new RangeError(FORM_MSG))
    expect(() => place('x', { authorId: 'nope' })).toThrow(new RangeError(ID_MSG('authorId')))
    expect(() => place('x', { images: [{ ref: 0, name: 'a.png' }] })).toThrow(new RangeError('an image ref must be a whole number from 1 to 10'))
  })

  it('is what the parts of toDiscord attach, as refs (property)', () => {
    const piece = fc.oneof(
      fc.string({ minLength: 0, maxLength: 60 }).map((t) => t.replace(/[\\`*_~|<>[\]()!#>-]/g, 'x')),
      fc.integer({ min: 1, max: 4 }).map((n) => img(n)),
      fc.integer({ min: 100, max: 3500 }).map(x),
    )
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 14 }), fc.subarray([1, 2, 3, 4]), fc.constantFrom('v2', 'plain'), (pieces, refs, form) => {
        const src = pieces.join('\n\n')
        const images = pics(...refs)
        const got = placement(src, opts({ form, images }))
        const parts = toDiscord(src, opts({ form, images })).parts
        const model = parts.map((part) => part.files.map((name) => Number(/(\d+)/.exec(name)[1])))
        while (model.length > 0 && model.at(-1).length === 0) model.pop()
        expect(got).toEqual(model)
        for (const refsOfPart of got) for (const ref of refsOfPart) expect(refs).toContain(ref)
      }),
      { numRuns: 150 },
    )
  })
})
