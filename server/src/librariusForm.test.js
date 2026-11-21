import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
import { automodMatcher, validateReply } from './librariusSend.js'

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
// The zero-width space that the form puts between marks that touch, and in a mark that a cut leaves with nothing in it.
const ZW = '\u200b'

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
// The unescaped `||` of a text outside code and links, read on its own so that it can be set against the module's reading.
const bars = (text) => {
  let n = 0
  let fenced = false
  for (const row of text.split('\n')) {
    if (/^(?:[ \t]*>)*[ \t]*```/.test(row)) fenced = !fenced
    else if (!fenced) n += (row.replace(/\\[\s\S]|``[\s\S]+?``|`[^`]+`|<[^>]*>/g, 'x').match(/\|\|/g) ?? []).length
  }
  return n
}
// The marks of a text that are open at its end (as many as would be needed to close them), read as `bars` reads, and apart from it.
const unbalanced = (text) => {
  const open = { '||': 0, '**': 0, '*': 0, __: 0, '~~': 0 }
  let fenced = false
  for (const row of text.split('\n')) {
    if (/^(?:[ \t]*>)*[ \t]*```/.test(row)) fenced = !fenced
    else if (!fenced) {
      const bare = row.replace(/^(?:[ \t]*>)*[ \t]*(?:[-*]|\d+\.) /, '').replace(/\\[\s\S]|``[\s\S]+?``|`[^`]+`|<[^>]*>/g, 'x')
      for (const [, mark] of bare.matchAll(/(\|\||\*+|__|~~)/g)) {
        if (mark.startsWith('*')) {
          open['**'] += Math.floor(mark.length / 2)
          open['*'] += mark.length % 2
        } else open[mark]++
      }
    }
  }
  return Object.entries(open).filter(([, n]) => n % 2 === 1).map(([mark]) => mark)
}
// The text of a part as the member reads it: its display texts in V2, its content in plain.
const textOf = (part) => (part.components === null ? part.text : displays(part).join('\n'))
// The texts of a part that Discord parses on their own: a V2 message is one Text Display at a time, a plain one its content.
const textsOf = (part) => (part.components === null ? [part.text] : displays(part))

// A model of how Discord shows a text, for what a spoiler hides. It reads left to right, each mark taking the first closing mark
// that suits it (the lazy rules of simple-markdown, with Discord's spoiler rule `^\|\|([\s\S]+?)\|\|`), so that a `||` that
// closes nothing the writer meant pairs with the next one, as it does in Discord.
const RE = {
  escape: /\\([^0-9A-Za-z\s])/y,
  code: /(`+)([\s\S]*?[^`])\1(?!`)/y,
  link: /\[((?:\[[^\]]*\]|[^[\]]|\](?=[^[]*\]))*)\]\(\s*<?((?:\([^)]*\)|[^\s\\]|\\.)*?)>?(?:\s+['"]([\s\S]*?)['"])?\s*\)/y,
  angle: /<[^\s>]+>/y,
  strong: /\*\*((?:\\[\s\S]|[^\\])+?)\*\*(?!\*)/y,
  underline: /__((?:\\[\s\S]|[^\\])+?)__(?!_)/y,
  star: /\*(?=\S)((?:\*\*|\\[\s\S]|\s+(?:\\[\s\S]|[^\s*\\]|\*\*)|[^\s*\\])+?)\*(?!\*)/y,
  score: /\b_((?:__|\\[\s\S]|[^\\_])+?)_\b/y,
  strike: /~~(?=\S)((?:\\[\s\S]|~(?!~)|[^\s~]|\s(?!~~))+?)~~/y,
  spoiler: /\|\|([\s\S]+?)\|\|/y,
}
// The rules to try at a character. Where more than one matches (bold and italic at a `*`, underline and italic at a `_`), the longest
// match is taken, and of two as long the italic: simple-markdown gives the three one order and weighs each match by its length, with
// 0.2 more for an italic and 0.1 for a bold (its `quality`). That tells at a run of three `*` or more, as in `***a**\**`, which the form
// writes for `_**a***_` and which is an italic of a bold and an asterisk, not a bold of `*a`.
const RULES_AT = { '\\': ['escape'], '`': ['code'], '<': ['angle'], '[': ['link'], '*': ['strong', 'star'], _: ['underline', 'score'], '~': ['strike'], '|': ['spoiler'] }
const QUALITY = { strong: 0.1, star: 0.2, score: 0.2 }
const weight = (t) => t.found[0].length + (QUALITY[t.name] ?? 0)
// → [character, hidden][] of an inline run, pushed on `out`.
function showInline(s, hidden, out) {
  const push = (text, h) => {
    for (const ch of text.split('')) out.push([ch, h])
  }
  for (let i = 0; i < s.length; ) {
    const tried = (RULES_AT[s[i]] ?? []).map((name) => {
      RE[name].lastIndex = i
      return { name, found: RE[name].exec(s) }
    })
    const rule = tried.filter((t) => t.found !== null).sort((a, b) => weight(b) - weight(a))[0]
    if (rule === undefined) {
      push(s[i], hidden)
      i++
      continue
    }
    const { name, found } = rule
    if (name === 'escape') push(found[1], hidden)
    else if (name === 'code') push(found[2].trim(), hidden)
    else if (name === 'angle') push(found[0], hidden)
    else showInline(found[1], hidden || name === 'spoiler', out)
    i += found[0].length
  }
  return out
}
// The blocks of a text, as the runs of text that Discord reads each as one: a paragraph (its lines together), a heading, a list
// item, a quote. Code is no run: what is in a fence is shown as it is.
function showBlocks(text) {
  const runs = []
  let cur = []
  let depth = 0
  let fenced = false
  const flush = () => {
    if (cur.length > 0) runs.push({ run: cur.join('\n') })
    cur = []
  }
  for (const raw of text.split('\n')) {
    if (/^(?:[ \t]*>)*[ \t]*```/.test(raw)) {
      flush()
      fenced = !fenced
      continue
    }
    if (fenced) {
      runs.push({ code: raw })
      continue
    }
    let line = raw
    let d = 0
    for (let q = /^[ \t]*> ?/.exec(line); q !== null; q = /^[ \t]*> ?/.exec(line)) {
      d++
      line = line.slice(q[0].length)
    }
    if (d !== depth) flush()
    depth = d
    const head = /^ *#{1,3} +/.exec(line) ?? /^ *-# +/.exec(line)
    const item = /^[ \t]*(?:[-*]|\d+\.) +/.exec(line)
    if (line.trim() === '') flush()
    else if (head !== null) {
      flush()
      runs.push({ run: line.slice(head[0].length) })
    } else if (item !== null) {
      flush()
      cur.push(line.slice(item[0].length))
    } else cur.push(line)
  }
  flush()
  return runs
}
// → the words of a text as Discord shows it, each with whether all, some or none of its characters are hidden.
const discordWords = (text) => {
  const chars = []
  for (const block of showBlocks(text)) {
    if (block.code !== undefined) for (const ch of block.code.split('')) chars.push([ch, false])
    else showInline(block.run, false, chars)
    chars.push([' ', false])
  }
  const shown = chars.map((c) => c[0]).join('')
  return [...shown.matchAll(/[A-Za-z][A-Za-z0-9]*/g)].map((w) => {
    const flags = chars.slice(w.index, w.index + w[0].length).map((c) => c[1])
    return { word: w[0], hidden: flags.every(Boolean) ? 'all' : flags.some(Boolean) ? 'some' : 'none' }
  })
}
// The words of a source that the parser puts in a spoiler, and those it puts outside one (a word that is both is in neither).
function wordClasses(src) {
  const inside = new Set()
  const outside = new Set()
  const take = (text, hidden) => {
    for (const w of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) (hidden ? inside : outside).add(w)
  }
  const visit = (nodes, hidden) => {
    for (const n of nodes) {
      if (n.type === 'text') take(n.value, hidden)
      else if (n.type === 'code') take(n.text, hidden)
      else if (n.type === 'codeblock') take(n.text, false)
      visit(n.children ?? [], hidden || n.type === 'spoiler')
      for (const item of n.items ?? []) visit(item.children, hidden)
    }
  }
  visit(parse(src, { dialect: 'extended' }), false)
  return { spoiler: new Set([...inside].filter((w) => !outside.has(w))), plain: new Set([...outside].filter((w) => !inside.has(w))) }
}
// → what is wrong with the parts of a reply as Discord shows them: a word the parser puts in a spoiler that a part shows, or a
// word it puts outside one that a part hides.
const leaks = (src, parts) => {
  const classes = wordClasses(src)
  const found = []
  for (const part of parts) {
    for (const text of textsOf(part)) {
      for (const { word, hidden } of discordWords(text)) {
        if (classes.spoiler.has(word) && hidden !== 'all') found.push(`shows ${word}: ${JSON.stringify(text.slice(0, 200))}`)
        else if (classes.plain.has(word) && hidden !== 'none') found.push(`hides ${word}: ${JSON.stringify(text.slice(0, 200))}`)
      }
    }
  }
  return found.slice(0, 4)
}

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

  it('ends a part early rather than cut a line of code that a fence closes after, or start a part with a fence', () => {
    // The boundary that would fill the second part is right before the fence that closes the code, and the line of code before
    // it can only be cut at the space before its ```, which would start the next part with a fence that the text does not have.
    const text = `> \`\`\`\n\`\`\`\n\`\`\`js\n${'x'.repeat(40)}> \`\`\`\n${'x'.repeat(40)}> \`\`\`\n> \`\`\`\n`
    expect(split(text, 62)).toEqual([
      `**1/3**\n> \`\`\`\n\`\`\`\n\`\`\`js\n${'x'.repeat(38)}`,
      m(2, 3, `xx> \`\`\`\n`),
      m(3, 3, `${'x'.repeat(40)}> \`\`\`\n> \`\`\`\n`),
    ])
  })

  it('leaves every part but the last at least half the limit, except next to a fence', () => {
    const FENCED = fc.array(fc.constantFrom('a', ' ', '\n', '. ', '```\n', '```js\n', '> ```\n', 'x'.repeat(40), '- '), { maxLength: 400 }).map((a) => a.join(''))
    fc.assert(
      fc.property(FENCED, LIMIT, (text, limit) => {
        const parts = split(text, limit).map(unmark)
        let end = 0
        parts.slice(0, -1).forEach((part) => {
          end += part.length
          // Next to a fence: the part ends with a fence line, or the text after it starts with one, or the boundary at the end of
          // the line after it, which would have filled the part, is right before a fence (see split's cut rules).
          const edge = /(^|\n)[ \t>]*```[^\n]*\n?$/.test(part) || /^([^\n]*\n)?[ \t>]*```/.test(text.slice(end))
          if (!edge) expect(part.length + 8).toBeGreaterThanOrEqual(limit / 2)
        })
      }),
      { numRuns: 600 },
    )
  })

  it('closes and opens nothing again at a cut, whatever marks are open there', () => {
    const text = `**${'x'.repeat(100)}**`
    expect(split(text, 40)).toEqual([m(1, 4, text.slice(0, 32)), m(2, 4, text.slice(32, 64)), m(3, 4, text.slice(64, 96)), m(4, 4, text.slice(96))])
    const bars = `||${'x '.repeat(50)}||`
    expect(split(bars, 40).map(unmark).join('')).toBe(bars)
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

describe('toDiscord: the start of a line that a picture was taken out of', () => {
  const images = [{ ref: 1, name: 'u1.png' }]
  const firstLine = (src, over) => plain(src, { images, ...over }).parts[0].text.split('\n')[0]

  it('escapes what would start a heading, a quote, a list or subtext after a picture, as at the start of any line', () => {
    // The picture is shown after the line, so its text is at the start of the line in Discord and no longer follows a picture.
    const cases = [
      ['![x](upload:1)# Big', '\\# Big'],
      ['![x](upload:1)### Big', '\\### Big'],
      ['![x](upload:1)> quoted', '\\> quoted'],
      ['![x](upload:1)>x', '\\>x'],
      ['![x](upload:1)- item', '\\- item'],
      ['![x](upload:1)-# small', '\\-# small'],
      ['![x](upload:1)* item', '\\* item'],
      ['![x](upload:1)1. first', '1\\. first'],
      ['![x](upload:1)10. tenth', '10\\. tenth'],
      ['![x](upload:1)  - item', '\\- item'],
      ['![x](upload:1) # Big', '\\# Big'],
      ['![x](upload:1)![x](upload:1)# Big', '\\# Big'],
      ['![x](upload:1)![x](upload:1)> quoted', '\\> quoted'],
    ]
    for (const [src, shown] of cases) expect(firstLine(src)).toBe(shown)
    expect(displays(v2('![x](upload:1)# Big', { images }).parts[0])).toEqual(['\\# Big', FOOTER])
  })

  it('leaves alone what follows something that stays in the line, and what is no start of a line', () => {
    const cases = [
      ['![x](upload:2)# Big', 'x# Big'],
      ['![x](upload:1)||# a||', '||# a||'],
      ['![x](upload:1)**a** # b', '**a** # b'],
      ['![x](upload:1)a # b', 'a # b'],
      ['![x](upload:1)1.5 is a number', '1.5 is a number'],
      ['![x](upload:1)1.x', '1.x'],
      ['![x](upload:1)#hashtag', '#hashtag'],
      ['![x](upload:1)-dash', '-dash'],
      ['Hello 1. world', 'Hello 1. world'],
    ]
    for (const [src, shown] of cases) expect(firstLine(src)).toBe(shown)
  })

  it('escapes a number that starts a heading or a list item, which is shown as it is written', () => {
    expect(firstLine('## 1. one')).toBe('## 1\\. one')
    expect(firstLine('- 1. one')).toBe('- 1\\. one')
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
    // A line of 1769 fits with the opener but not with the fence's closing too: it is cut at the 1766 that leave room for the
    // closing, and not left whole to the next part with an empty fence before it.
    const less = run(1769)
    expect(less).toHaveLength(3)
    expect(less[0].text).toBe(`**1/3**\n\`\`\`\n${'k'.repeat(1766)}\n\`\`\``)
    expect(less[1].text.split('\n').slice(0, 4)).toEqual(['**2/3**', '```', 'kkk', 'j'.repeat(1869)])
  })

  it('never makes part 1 a fence with nothing in it, where the code line fits a part but not with the fence closed', () => {
    // A fence of one code line of L characters, then text: the line fits the room of part 1 for L up to 3766 (V2), the closing fence
    // does not, and the windows below are where the line was moved whole to part 2 and part 1 was left an empty fence.
    const replyTo = { authorId: REPLIED, url: JUMP }
    const windows = [
      ['v2', null, 3766, 3000],
      ['v2', replyTo, 3694, 3000],
      ['plain', null, 1766, 1500],
      ['plain', replyTo, 1694, 1500],
    ]
    for (const [form, reply, first, tail] of windows) {
      for (let L = first - 2; L <= first + 5; L++) {
        const r = toDiscord(`\`\`\`\n${'k'.repeat(L)}\n\`\`\`\n${'y'.repeat(tail)}`, opts({ form, replyTo: reply }))
        const parts = r.parts.map(textOf)
        expect(parts[0]).not.toMatch(/```\n```/)
        expect(parts).toHaveLength(2)
        for (const part of parts) expect(part.split('\n').filter((l) => l.startsWith('```')).length % 2).toBe(0)
        expect(parts.join('').split('k').length - 1).toBe(L)
        expect(r.parts.map((part) => (form === 'v2' ? displayableLength(part) : part.text.length)).every((n) => n <= (form === 'v2' ? 4000 : 2000))).toBe(true)
      }
    }
  })

  it('cuts inside the code line of a fence that the closing fence does not fit after, with room for the fence to close', () => {
    // 3766 is the room of a code line in part 1 (3774 less the opener's 4 and the closing fence's 4): the line is cut at it.
    const r = v2(`\`\`\`\n${x(3769)}\n\`\`\`\n${'y'.repeat(3000)}`)
    expect(displays(r.parts[0])).toEqual([`**1/2**\n\`\`\`\n${x(3766)}\n\`\`\``])
    expect(displays(r.parts[1])).toEqual([`**2/2**\n\`\`\`\n${x(3)}\n\`\`\`\n${'y'.repeat(3000)}\n${FOOTER}`])
    const p = plain(`\`\`\`\n${x(1769)}\n\`\`\`\n${'y'.repeat(1500)}`)
    expect(p.parts[0].text).toBe(`**1/2**\n\`\`\`\n${x(1766)}\n\`\`\``)
    expect(p.parts[1].text).toBe(`**2/2**\n\`\`\`\n${x(3)}\n\`\`\`\n${'y'.repeat(1500)}\n${PLAIN_FOOTER}`)
  })

  it('cuts inside the rest of a code line that an earlier part left, where the closing fence does not fit after it either', () => {
    // 1766 of the line go to part 1; the 1874 left take the 1873 that part 2 has room for (1881 less its fence, opened again and closed).
    const k = (n) => 'k'.repeat(n)
    const r = plain(`\`\`\`\n${k(3640)}\n\`\`\`\n${'y'.repeat(1500)}`)
    expect(r.parts.map((p) => p.text)).toEqual([
      `**1/3**\n\`\`\`\n${k(1766)}\n\`\`\``,
      `**2/3**\n\`\`\`\n${k(1873)}\n\`\`\``,
      `**3/3**\n\`\`\`\n${k(1)}\n\`\`\`\n${'y'.repeat(1500)}\n${PLAIN_FOOTER}`,
    ])
  })

  it('counts the notes a line of a table cites against the part when it is cut for the fence to close', () => {
    // The head line of 1757 fits with its note (12) and the opener (4), but not with the fence closing too: it is cut at 1754.
    for (let n = 1742; n <= 1747; n++) {
      const head = `| ${'h'.repeat(n)}[^1] | b |`
      const r = plain(`${head}\n| - | - |\n| c | d |\n\n[^1]: n`)
      for (const part of r.parts) expect(part.text.length).toBeLessThanOrEqual(2000)
      expect(r.parts.map((p) => p.text.split('\n').filter((l) => l.startsWith('```')).length % 2)).toEqual(r.parts.map(() => 0))
      if (n === 1745) expect(r.parts[0].text).toBe(`**1/3**\n\`\`\`\n${head.slice(0, 1754)}\n\`\`\`\n-# \\[^1]: n`)
    }
  })

  it('cuts inside the last code line of a fence that has more lines before it, when the closing fence does not fit after it', () => {
    // Part 1 holds the opener (4), the line of 100 (101), the code line's piece, and the closing fence (4) in its 1774.
    const r = plain(`\`\`\`\n${x(100)}\n${x(1666)}\n\`\`\`\n${'y'.repeat(1500)}`)
    expect(r.parts[0].text).toBe(`**1/2**\n\`\`\`\n${x(100)}\n${x(1665)}\n\`\`\``)
    expect(r.parts[1].text).toBe(`**2/2**\n\`\`\`\n${x(1)}\n\`\`\`\n${'y'.repeat(1500)}\n${PLAIN_FOOTER}`)
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

// What a spoiler or a mark that a cut falls in does: Discord shows the bars of an unpaired one as text and hides nothing,
// so a part closes what is open at its end and opens it again at its start.
describe('toDiscord: a spoiler that a cut falls in', () => {
  const lines = (n, size) => Array.from({ length: n }, (_, i) => `${String(i).padStart(2, '0')}${'a'.repeat(size - 2)}`)
  const spaced = (n) => Array(n).fill('a').join(' ')

  it('closes the spoiler at a cut between its lines and opens it again at the start of the next part', () => {
    // Rows of 98 characters, 99 with the line end: part 1 takes 17 rows (1685 of its 1774) and the closing bars (2) fit, 18 do not.
    const rows = lines(40, 98)
    const r = plain(`||${rows.join('\n')}||`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 3, `||${rows.slice(0, 17).join('\n')}||`), m(2, 3, `||${rows.slice(17, 35).join('\n')}||`), `${m(3, 3, `||${rows.slice(35).join('\n')}||`)}\n${PLAIN_FOOTER}`])
  })

  it('does the same in the V2 form', () => {
    const rows = lines(100, 98)
    const r = v2(`||${rows.join('\n')}||`)
    expect(r.parts).toHaveLength(3)
    for (const part of r.parts) {
      expect(bars(textOf(part)) % 2).toBe(0)
      expect(displayableLength(part)).toBeLessThanOrEqual(4000)
    }
    expect(displays(r.parts[0]).at(-1).endsWith('||')).toBe(true)
    expect(displays(r.parts[1])[0].startsWith('**2/3** ||')).toBe(true)
  })

  it('keeps an intro, a long spoiler and an outro from showing a spoiler cut in two', () => {
    const rows = Array.from({ length: 70 }, (_, i) => `In chapter five the Chapter Master falls at the gate, line ${i}.`)
    const r = v2(`Spoilers for the campaign finale below.\n\n||${rows.join('\n')}||\n\nWhat did you all think?`)
    expect(r.parts).toHaveLength(2)
    for (const part of r.parts) expect(bars(textOf(part)) % 2).toBe(0)
    expect(textOf(r.parts[0])).toMatch(/^\*\*1\/2\*\* Spoilers for the campaign finale below\.\n\n\|\|In chapter five/)
    const end = /line (\d+)\.\|\|$/.exec(textOf(r.parts[0]))
    const start = /^\*\*2\/2\*\* \|\|In chapter five the Chapter Master falls at the gate, line (\d+)\./.exec(textOf(r.parts[1]))
    expect(Number(start[1])).toBe(Number(end[1]) + 1)
    expect(textOf(r.parts[1])).toContain('line 69.||\n\nWhat did you all think?')
  })

  it('cuts a spoiler of one long line at a sentence end, closing and opening it round the cut', () => {
    // A part of 1774 holds `||` and 354 sentences of 5 (1772) and the 2 of the closing bars; part 2 holds 375 of them.
    const text = Array(900).fill('abc.').join(' ')
    const r = plain(`||${text}||`)
    const sentences = (n) => Array(n).fill('abc.').join(' ')
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 3, `||${sentences(354)}||`), m(2, 3, `||${sentences(375)}||`), `${m(3, 3, `||${sentences(171)}||`)}\n${PLAIN_FOOTER}`])
  })

  it('cuts a spoiler of one long line at a space, closing and opening it round the cut', () => {
    const r = plain(`||${spaced(2001)}||`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 3, `||${spaced(885)}||`), m(2, 3, `||${spaced(938)}||`), `${m(3, 3, `||${spaced(178)}||`)}\n${PLAIN_FOOTER}`])
  })

  it('cuts a spoiler that is one long word anywhere, with room for the bars it closes with', () => {
    const r = plain(`||${'a'.repeat(4000)}||`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 3, `||${'a'.repeat(1770)}||`), m(2, 3, `||${'a'.repeat(1877)}||`), `${m(3, 3, `||${'a'.repeat(353)}||`)}\n${PLAIN_FOOTER}`])
  })

  it('cuts the first line of a spoiler when the second has one character of room, and the closing bars would not fit in it', () => {
    // The first line and its line end are 1773 of the 1774 of part 1: the closing bars (2) fit after neither it nor one character of the next.
    const r = plain(`||${'a'.repeat(1770)}\n${'b'.repeat(300)}||`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `||${'a'.repeat(1769)}||`), `${m(2, 2, `||a\n${'b'.repeat(300)}||`)}\n${PLAIN_FOOTER}`])
  })

  it('prefers a line end outside a spoiler to a later one inside it, as with a fence', () => {
    const rows = lines(10, 98)
    const r = plain(`${x(1000)}\n||${rows.join('\n')}||`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, x(1000)), `${m(2, 2, `||${rows.join('\n')}||`)}\n${PLAIN_FOOTER}`])
  })

  it('opens a spoiler of a quote after the quote mark, and keeps the mark on its own line', () => {
    // Rows of 98 with the quote mark, as the rows of 98 in the first test: 17, 18 and 5 of them in the parts.
    const q = lines(40, 96)
    const block = (from, to) => q.slice(from, to).map((row, i) => `> ${i === 0 ? '||' : ''}${row}${from + i === to - 1 ? '||' : ''}`).join('\n')
    const r = plain(`> ||${q.join('\n> ')}||`)
    expect(r.parts.map((p) => p.text)).toEqual([`**1/3**\n${block(0, 17)}`, `**2/3**\n${block(17, 35)}`, `**3/3**\n${block(35, 40)}\n${PLAIN_FOOTER}`])
  })

  it('leaves a spoiler that no cut falls in as it is written', () => {
    const rows = lines(10, 98)
    const r = plain(`${x(1700)}\n\n||${rows.join('\n')}||`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, x(1700)), `${m(2, 2, `||${rows.join('\n')}||`)}\n${PLAIN_FOOTER}`])
  })

  it('does not count bars in code, in a link, in a fence or escaped, and so closes none of them', () => {
    const unit = 'an `a||b` and <https://x.example/a||b> and \\|\\| and word '
    const r = plain(`||${unit.repeat(80)}||`)
    expect(r.parts.length).toBeGreaterThan(1)
    for (const part of r.parts) expect(bars(part.text) % 2).toBe(0)
    const fenced = plain(`${x(1700)}\n\n\`\`\`\n||\n\`\`\`\n\n${x(1700)}`)
    expect(fenced.parts[0].text).toBe(m(1, 2, `${x(1700)}\n\n\`\`\`\n||\n\`\`\``))
  })

  it('never cuts the bars it closes with off a half, nor an escape from its mark', () => {
    for (const form of ['v2', 'plain']) {
      // The closing bars of the first spoiler fall on the end of the room of part 1, to either side of it.
      const room = form === 'v2' ? 3774 : 1774
      for (let k = room - 34; k <= room + 16; k++) {
        const r = toDiscord(`||${'a'.repeat(k)}||${'b'.repeat(2500 + room)}`, opts({ form }))
        for (const part of r.parts) expect(bars(textOf(part)) % 2).toBe(0)
      }
    }
    const piped = plain(`||${'a|'.repeat(2000)}||`)
    expect(piped.parts.length).toBeGreaterThan(2)
    for (const part of piped.parts) expect(bars(part.text) % 2).toBe(0)
  })

  it('puts the text back together once the bars of the cuts are off', () => {
    const rows = lines(60, 80)
    for (const form of ['v2', 'plain']) {
      const r = toDiscord(`||${rows.join('\n')}||`, opts({ form }))
      const last = r.parts.length - 1
      expect(last).toBeGreaterThan(0)
      const body = r.parts.map((part, i) => {
        let text = unmark(textOf(part))
        if (i === last) text = text.replace(form === 'v2' ? FOOTER : PLAIN_FOOTER, '')
        text = text.trim()
        // The bars at the start of the first part and the end of the last are the writer's, the others the cuts'.
        if (i > 0) {
          expect(text.startsWith('||')).toBe(true)
          text = text.slice(2)
        }
        if (i < last) {
          expect(text.endsWith('||')).toBe(true)
          text = text.slice(0, -2)
        }
        return text
      })
      expect(body.join('\n')).toBe(`||${rows.join('\n')}||`)
    }
  })
})

describe('toDiscord: a mark that a cut falls in', () => {
  const spaced = (n) => Array(n).fill('a').join(' ')
  // 2001 words of one letter: the cuts fall after a space, and these are the words that each part holds, for marks of 2, 1, 4 and 3
  // characters (a part of 1774 holds the opening mark, the words and the closing mark, the part after it 1881 less the mark it
  // opens again, and so on).
  const split3 = (open, shut, counts) => [m(1, 3, `${open}${spaced(counts[0])}${shut}`), m(2, 3, `${open}${spaced(counts[1])}${shut}`), `${m(3, 3, `${open}${spaced(counts[2])}${shut}`)}\n${PLAIN_FOOTER}`]
  const cases = [
    ['bold', '**', '**', [885, 938, 178]],
    ['italic', '*', '*', [886, 939, 176]],
    ['underline', '__', '__', [885, 938, 178]],
    ['strike', '~~', '~~', [885, 938, 178]],
    ['code', '`', '`', [886, 939, 176]],
    ['a spoiler of bold', '||**', '**||', [883, 936, 182]],
    ['bold italic', '***', '***', [884, 937, 180]],
    ['a heading of level 4', '**', '**', [885, 938, 178]],
  ]

  for (const [name, open, shut, counts] of cases) {
    it(`closes ${name} at a cut inside a line, and opens it again after the mark of the next part`, () => {
      const src = name === 'a heading of level 4' ? `#### ${spaced(2001)}` : `${open}${spaced(2001)}${shut}`
      expect(plain(src).parts.map((p) => p.text)).toEqual(split3(open, shut, counts))
    })
  }

  it('closes code of double ticks round a cut, and opens it again', () => {
    const unit = 'x`y '
    const r = plain(`\`\`${unit.repeat(1000)}x\`y\`\``)
    expect(r.parts.map((p) => p.text.replace(`\n${PLAIN_FOOTER}`, ''))).toEqual([m(1, 3, `\`\`${unit.repeat(442).trimEnd()}\`\``), m(2, 3, `\`\`${unit.repeat(469).trimEnd()}\`\``), m(3, 3, `\`\`${unit.repeat(1000 - 442 - 469)}x\`y\`\``)])
  })

  it('keeps the space a cut falls at out of the mark it closes and the one it opens again', () => {
    const r = plain(`**${'a  '.repeat(1500)}a**`)
    expect(r.parts.length).toBeGreaterThan(1)
    r.parts.forEach((part, i) => {
      expect(part.text).not.toMatch(/ \*\*(\n|$)/)
      if (i > 0) expect(part.text).toMatch(/^\*\*\d\/\d\*\* \*\*a/)
    })
  })

  it('does not take the marker of a list item for a mark', () => {
    const r = plain(`* ${spaced(2001)}`)
    expect(r.parts[0].text).toBe(`**1/3**\n* ${spaced(886)}`)
    expect(r.parts[1].text.startsWith('**2/3** a')).toBe(true)
    expect(r.parts.map((p) => (p.text.match(/\*/g) ?? []).length)).toEqual([5, 4, 4])
  })

  it('reads the marks of a list item after its marker, wherever its marker is a mark itself', () => {
    const r = plain(`* **${spaced(2001)}**`)
    expect(r.parts.map((p) => p.text)).toEqual([`**1/3**\n* **${spaced(884)}**`, m(2, 3, `**${spaced(938)}**`), `${m(3, 3, `**${spaced(179)}**`)}\n${PLAIN_FOOTER}`])
    const quoted = plain(`> - **${spaced(2001)}**`)
    expect(quoted.parts[1].text.startsWith('**2/3** **')).toBe(true)
  })

  it('cuts at a space in front of a mark, the mark staying whole in the next part', () => {
    const r = plain(`${spaced(886)} **${spaced(800)}**`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, spaced(886)), `${m(2, 2, `**${spaced(800)}**`)}\n${PLAIN_FOOTER}`])
  })

  it('never cuts between the ticks that open code, nor between those that close it', () => {
    // The ticks start at 1771, where the room of part 1 (1774), less the 2 of the ticks it would close with, ends one place on.
    const r = plain(`${'a'.repeat(1771)}\`\`b\`c\`\`${'d'.repeat(500)}`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, 'a'.repeat(1771)), `${m(2, 2, `\`\`b\`c\`\`${'d'.repeat(500)}`)}\n${PLAIN_FOOTER}`])
  })

  it('cuts after the space that follows a span of code, which is no longer in the code', () => {
    const r = plain(`${spaced(885)} \`c\` ${spaced(850)}`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `${spaced(885)} \`c\``), `${m(2, 2, spaced(850))}\n${PLAIN_FOOTER}`])
  })

  it('cuts right after the mark that closes a span, when that is where the room ends', () => {
    const r = plain(`**${'a'.repeat(1770)}**${'b'.repeat(500)}`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `**${'a'.repeat(1770)}**`), `${m(2, 2, 'b'.repeat(500))}\n${PLAIN_FOOTER}`])
  })

  it('opens a mark again before what a cut left of a link, and not after it, as it is no mark of a quote', () => {
    // The cut falls inside the link, before its closing bracket, which is no quote mark however it looks at the start of the part.
    const r = plain(`**<https://a.example/${'x'.repeat(1751)}>** ${'b'.repeat(300)}`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `**<https://a.example/${'x'.repeat(1751)}**`), `${m(2, 2, `**>** ${'b'.repeat(300)}`)}\n${PLAIN_FOOTER}`])
  })

  it('reads the marks of a line of code of a fence as no marks, and leaves the fence as it was', () => {
    for (const size of [93, 94, 95, 96, 97]) {
      const rows = Array.from({ length: 40 }, (_, i) => `${i % 2 === 0 ? '**' : '||'}${'a'.repeat(size)}`)
      const r = plain(`\`\`\`\n${rows.join('\n')}\n\`\`\``)
      expect(r.parts.length).toBeGreaterThan(1)
      for (const part of r.parts) {
        const body = part.text.replace(`\n${PLAIN_FOOTER}`, '').split('\n')
        expect(body.slice(1, 2)).toEqual(['```'])
        expect(body.at(-1)).toBe('```')
        expect(body.slice(2, -1).every((row) => /^(\*\*|\|\|)a+$/.test(row))).toBe(true)
      }
    }
  })

  it('does not close what a link, an escape or a mention in angle brackets holds', () => {
    const unit = 'see <https://a.example/x*y__z~~w> and \\* \\_ \\~ and <@123456789012345678> and word '
    const r = plain(unit.repeat(60))
    expect(r.parts.length).toBeGreaterThan(1)
    for (const part of r.parts) expect(part.text.replace(/\n-# <@.*$/, '')).not.toMatch(/\*\*$|__$|~~$/)
  })

  it('carries a mark of a line across a cut between the lines of a spoiler it is in', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `**${String(i).padStart(2, '0')}${'a'.repeat(94)}**`)
    const r = plain(`||${rows.join('\n')}||`)
    expect(r.parts.length).toBeGreaterThan(1)
    for (const part of r.parts) expect(unbalanced(part.text)).toEqual([])
  })
})

describe('toDiscord: where the room runs out in a fence that comes right after another, with notes to carry', () => {
  // Three lines that cite a note each, and the notes (385 characters each) that every part with a citing line lists: the tail of
  // part 1 is over its half, so a cut at a boundary is not taken for the fill and the cut falls inside a row.
  const cites = (k) => Array.from({ length: k }, (_, i) => `line ${i} cites [^n${i}]`).join('\n')
  const notes = (k, n) => Array.from({ length: k }, (_, i) => `[^n${i}]: ${'z'.repeat(n)}`).join('\n')
  const NOTE_LINES = [0, 1, 2].map((i) => `-# \\[^n${i}]: ${'z'.repeat(385)}`).join('\n')
  const CITING = [0, 1, 2].map((i) => `line ${i} cites \\[^n${i}]`).join('\n')

  it('moves a block that would open and close empty after another to the next part, whole', () => {
    // The first block is 509 of the room that is left, and the next one's opening fence has none: it is left for part 2.
    const r = plain(`${cites(3)}\n\`\`\`\n${'a'.repeat(505)}\n\`\`\`\n\`\`\`\nb\n\`\`\`\n\n${'y'.repeat(2500)}\n\n${notes(3, 385)}`)
    expect(r.parts.map((p) => p.text)).toEqual([
      `**1/3** ${CITING}\n\`\`\`\n${'a'.repeat(505)}\n\`\`\`\n${NOTE_LINES}`,
      `**2/3**\n\`\`\`\nb\n\`\`\`\n\n${'y'.repeat(1870)}`,
      `**3/3** ${'y'.repeat(630)}\n${PLAIN_FOOTER}`,
    ])
  })

  it('cuts cleanly between two blocks, whichever of them the room runs out in', () => {
    const r = plain(`${cites(3)}\n\`\`\`\n${'a'.repeat(511)}\n\`\`\`\n\`\`\`\nb\n\`\`\`\n\n${'y'.repeat(2500)}\n\n${notes(3, 385)}`)
    expect(r.parts.map((p) => p.text)).toEqual([
      `**1/3** ${CITING}\n\`\`\`\n${'a'.repeat(511)}\n\`\`\`\n${NOTE_LINES}`,
      `**2/3**\n\`\`\`\nb\n\`\`\`\n\n${'y'.repeat(1870)}`,
      `**3/3** ${'y'.repeat(630)}\n${PLAIN_FOOTER}`,
    ])
  })

  it('cuts raw text before a closing fence with text on its line, and not inside the fence', () => {
    // The code fits the part, the fence line does not, and a split that closes no fence leaves it whole for the next part.
    expect(split(`\`\`\`\n${'x'.repeat(18)}\n\`\`\`${'z'.repeat(10)}`, 33)).toEqual([`**1/2**\n\`\`\`\n${'x'.repeat(18)}\n`, `**2/2**\n\`\`\`${'z'.repeat(10)}`])
  })

  it('splits raw text that opens a fence in the line a part would end in, as 3 parts', () => {
    expect(split('d\n```jjjjjjjjjjjjjjjjjj\n---\n---\n---', 32)).toEqual(['**1/3** d\n', '**2/3**\n```jjjjjjjjjjjjjjjjjj\n--', '**3/3** -\n---\n---'])
  })
})

describe('toDiscord: the start of a line after a line break inside a spoiler', () => {
  it('keeps the backslash of a line start that a member escaped after a break in a spoiler', () => {
    for (const mark of ['\\#', '\\>', '\\-', '\\-#']) {
      const r = plain(`||first line\n${mark} not a mark||`)
      expect(r.parts[0].text).toBe(`||first line\n${mark} not a mark||\n${PLAIN_FOOTER}`)
    }
    const quoted = plain('> ||first line\n> \\# not a heading||')
    expect(quoted.parts[0].text).toBe(`> ||first line\n> \\# not a heading||\n${PLAIN_FOOTER}`)
  })

  it('does so after a break that follows other marks, and after more than one', () => {
    const r = plain('||**bold** first\n\\# one\n\\> two\n\\-# three||')
    expect(r.parts[0].text).toBe(`||**bold** first\n\\# one\n\\> two\n\\-# three||\n${PLAIN_FOOTER}`)
  })

  it('does not escape a text that follows a break but is no line start, or one that follows other text on its line', () => {
    const r = plain('||first line\nsecond # line - not > a start||')
    expect(r.parts[0].text).toBe(`||first line\nsecond # line - not > a start||\n${PLAIN_FOOTER}`)
  })

  it('writes the same text in V2 as in plain', () => {
    expect(displays(v2('||first line\n\\# not a heading||').parts[0])).toEqual([`||first line\n\\# not a heading||\n${FOOTER}`])
  })

  it('leaves no line of nothing but spaces in a spoiler, where a picture that is attached or a mark of spaces was all of a line', () => {
    // A blank line ends a block, so the bars on either side of one would pair with no other, and show what they hold.
    const images = [{ ref: 1, name: 'u1.png' }]
    expect(plain('x ||ALPHA\n![p](upload:1)\nBRAVO|| y', { images }).parts[0].text).toBe(`x ||ALPHA\nBRAVO|| y\n${PLAIN_FOOTER}`)
    expect(displays(v2('x ||ALPHA\n![p](upload:1)\nBRAVO|| y', { images }).parts[0])).toEqual(['x ||ALPHA\nBRAVO|| y', FOOTER])
    expect(plain('||ALPHA\n__ __\n![](upload:2)\nBRAVO|| y').parts[0].text).toBe(`||ALPHA\n BRAVO|| y\n${PLAIN_FOOTER}`)
    expect(plain('> ||ALPHA\n> *![p](upload:1)*\n> BRAVO||', { images }).parts[0].text).toBe(`> ||ALPHA\n> BRAVO||\n${PLAIN_FOOTER}`)
    // The line after it starts a line all the same, and is escaped as one. The first line and the last hold the bars, and stay.
    expect(plain('||ALPHA\n![p](upload:1)\n\\# BRAVO||', { images }).parts[0].text).toBe(`||ALPHA\n\\# BRAVO||\n${PLAIN_FOOTER}`)
    expect(plain('||![p](upload:1)\n![p](upload:1)\nALPHA\n![p](upload:1)||', { images }).parts[0].text).toBe(`||\nALPHA\n||\n${PLAIN_FOOTER}`)
    for (const src of ['x ||ALPHA\n![p](upload:1)\nBRAVO|| y', '||ALPHA\n__ __\n![](upload:2)\nBRAVO|| y', '> ||ALPHA\n> *![p](upload:1)*\n> BRAVO||']) {
      for (const form of FORMS) expect(leaks(src, toDiscord(src, opts({ form, images })).parts)).toEqual([])
    }
  })
})

describe('toDiscord: a part that starts inside a line', () => {
  // `rank N - brother` is prose: no part of it may start a bullet, a heading, a quote or a numbered list that the source had not.
  const startsBlock = (text) => text.split('\n').some((line) => /^\s*(?:[-*] |-# |#{1,6} |>|\d{1,9}\. )/.test(line))

  it('never starts a bullet, a heading, a quote or a numbered list that the prose it cuts had not', () => {
    // A sentence end is the best place to cut, so a number with a full stop is cut in front of after a sentence, not after a space.
    const pieces = [
      ['- brother', '\\- brother'],
      ['-# brother', '\\-# brother'],
      ['## brother', '\\## brother'],
      ['> brother', '\\> brother'],
      ['it. 1. brother', '1\\. brother'],
      ['it. 12. brother', '12\\. brother'],
    ]
    for (const [piece, written] of pieces) {
      let cutBefore = 0
      for (let pad = 0; pad < 30; pad++) {
        const src = `${'p'.repeat(pad)}${Array.from({ length: 400 }, (_, i) => `rank ${i} ${piece}`).join(' ')}`
        for (const form of FORMS) {
          const r = toDiscord(src, opts({ form }))
          expect(r.parts.length).toBeGreaterThan(1)
          for (const part of r.parts) {
            expect(startsBlock(textOf(part).replace(PLAIN_FOOTER, '').replace(FOOTER, ''))).toBe(false)
            if (textsOf(part)[0].startsWith(`**${r.parts.indexOf(part) + 1}/${r.parts.length}** ${written}`)) cutBefore++
          }
        }
      }
      // The cut fell before the piece in some of the texts, or the test says nothing.
      expect(cutBefore).toBeGreaterThan(0)
    }
  })

  it('writes the start of a part that starts inside a line after its mark on the same line, escaped as a line start is', () => {
    // 1774 characters of part 1 are `rank NNN - brother ` of 19: the cut before `- brother` comes after `rank 0.. `.
    const pad = (n) => 'p'.repeat(n)
    const seen = new Set()
    for (let n = 0; n < 20; n++) {
      const r = plain(`${pad(n)} ${Array.from({ length: 300 }, (_, i) => `rank ${String(i).padStart(3, '0')} - brother`).join(' ')}`)
      const second = r.parts[1].text
      if (/^\*\*2\/\d\*\* \\- brother/.test(second)) seen.add('escaped')
      expect(second).not.toMatch(/^\*\*2\/\d\*\*\n/)
    }
    expect([...seen]).toEqual(['escaped'])
  })

  it('still puts a line end after the mark when the part starts at a row start with block syntax', () => {
    const rows = Array.from({ length: 80 }, (_, i) => `- item ${String(i).padStart(2, '0')} ${'a'.repeat(40)}`)
    const r = plain(rows.join('\n'))
    expect(r.parts.length).toBeGreaterThan(1)
    expect(r.parts[1].text).toMatch(/^\*\*2\/\d\*\*\n- item /)
  })

  it('does not put a line end after the mark of a raw split part that starts inside a line', () => {
    // The room of a part is 32 (40 less the mark): the cut is after the space at 31, in front of the `-`.
    const text = `${'a'.repeat(31)} - brother ${'b'.repeat(40)}`
    const parts = split(text, 40)
    expect(parts[1]).toBe(`**2/3** - brother ${'b'.repeat(22)}`)
    expect(parts.map(unmark).join('')).toBe(text)
  })

  it('keeps the line end after the mark of a raw split part that starts at a row start with block syntax', () => {
    const parts = split(`${'a'.repeat(30)}\n- ${'b'.repeat(30)}`, 40)
    expect(parts[1]).toBe(`**2/2**\n- ${'b'.repeat(30)}`)
  })

  it('does not escape what a code line that a fence is cut in starts with after the cut', () => {
    let at = 0
    for (let pad = 0; pad < 20; pad++) {
      const r = plain(`\`\`\`\n${'p'.repeat(pad)} ${Array(250).fill('rank - brother').join(' ')}\n\`\`\``)
      for (const part of r.parts) {
        expect(part.text).not.toContain('\\-')
        if (/^\*\*\d\/\d\*\*\n```\n- brother/.test(part.text)) at++
      }
    }
    // Some of the cuts fell in front of a `-`, or the test says nothing.
    expect(at).toBeGreaterThan(0)
  })
})

describe('toDiscord: emphasis that is written twice in a row', () => {
  it('joins an emphasis that follows another, so that no `**` is written between two italics', () => {
    expect(plain('*so*_very_').parts[0].text).toBe(`*sovery*\n${PLAIN_FOOTER}`)
    expect(plain('I was *so*_very_ moved').parts[0].text).toBe(`I was *sovery* moved\n${PLAIN_FOOTER}`)
    expect(plain('*a*_b_*c*').parts[0].text).toBe(`*abc*\n${PLAIN_FOOTER}`)
  })

  it('joins them across what shows nothing between them, a picture that is attached', () => {
    const r = plain('*so*![p](upload:1)_very_', { images: [{ ref: 1, name: 'u1.png' }] })
    expect(r.parts[0].text).toBe(`*sovery*\n${PLAIN_FOOTER}`)
    expect(r.parts[0].files).toEqual(['u1.png'])
  })

  it('keeps the closing mark of an italic that an italic with nothing in it but a picture follows', () => {
    const r = plain('*a*_![p](upload:1)_', { images: [{ ref: 1, name: 'u1.png' }] })
    expect(r.parts[0].text).toBe(`*a*\n${PLAIN_FOOTER}`)
    expect(r.parts[0].files).toEqual(['u1.png'])
  })

  it('writes bold that touches an italic, before it or after it, as bold and as an italic with a zero-width space between, and joins neither', () => {
    expect(plain('**a***b*').parts[0].text).toBe(`**a**${ZW}*b*\n${PLAIN_FOOTER}`)
    expect(plain('*a***b**').parts[0].text).toBe(`*a*${ZW}**b**\n${PLAIN_FOOTER}`)
    expect(plain('_a_**b**').parts[0].text).toBe(`*a*${ZW}**b**\n${PLAIN_FOOTER}`)
    expect(plain('**a**_b_').parts[0].text).toBe(`**a**${ZW}*b*\n${PLAIN_FOOTER}`)
  })

  it('puts a zero-width space between two marks of one character that touch, so that Discord closes each where it was written', () => {
    const images = [{ ref: 1, name: 'u1.png' }]
    expect(plain('**so****very**').parts[0].text).toBe(`**so**${ZW}**very**\n${PLAIN_FOOTER}`)
    expect(plain('__so____very__').parts[0].text).toBe(`__so__${ZW}__very__\n${PLAIN_FOOTER}`)
    // A picture that is attached shows nothing between them, so they touch as well.
    expect(plain('**so**![p](upload:1)**very**', { images }).parts[0].text).toBe(`**so**${ZW}**very**\n${PLAIN_FOOTER}`)
    expect(plain('__so__![p](upload:1)__very__', { images }).parts[0].text).toBe(`__so__${ZW}__very__\n${PLAIN_FOOTER}`)
    expect(plain('*so*![p](upload:1)**very**', { images }).parts[0].text).toBe(`*so*${ZW}**very**\n${PLAIN_FOOTER}`)
    expect(plain('`so`![p](upload:1)`very`', { images }).parts[0].text).toBe(`\`so\`${ZW}\`very\`\n${PLAIN_FOOTER}`)
    expect(v2('**so****very**').parts[0].text).toBe(`**so**${ZW}**very**\n${FOOTER}`)
  })

  it('puts none between marks that something shows between, that are of two characters, or that Discord closes at the first chance', () => {
    expect(plain('**so** **very**').parts[0].text).toBe(`**so** **very**\n${PLAIN_FOOTER}`)
    expect(plain('*so*__very__').parts[0].text).toBe(`*so*__very__\n${PLAIN_FOOTER}`)
    // A strike holds no `~~` and a spoiler closes at the next bars, so these are read as two already.
    expect(plain('~~so~~~~very~~').parts[0].text).toBe(`~~so~~~~very~~\n${PLAIN_FOOTER}`)
    expect(plain('||so||||very||').parts[0].text).toBe(`||so||||very||\n${PLAIN_FOOTER}`)
    // A text that only ends with the character of a mark does not touch the mark before it, nor a text the next text, though the bold
    // of a bold heading leaves only its text.
    expect(plain('*so*very\\*').parts[0].text).toBe(`*so*very\\*\n${PLAIN_FOOTER}`)
    expect(plain('#### so**os**').parts[0].text).toBe(`**soos**\n${PLAIN_FOOTER}`)
  })

  it('writes an italic inside an italic as its text, since Discord has none, and its marks would be read as bold', () => {
    expect(plain('*_a_*').parts[0].text).toBe(`*a*\n${PLAIN_FOOTER}`)
    expect(plain('*_a_ b*').parts[0].text).toBe(`*a b*\n${PLAIN_FOOTER}`)
    expect(plain('_a *b*_').parts[0].text).toBe(`*a b*\n${PLAIN_FOOTER}`)
    expect(plain('*a ||_b_|| c*').parts[0].text).toBe(`*a ||b|| c*\n${PLAIN_FOOTER}`)
    // Two that touch inside it are not joined as italics are, for they have no marks to join.
    expect(plain('*_a_![p](upload:1)_b_*', { images: [{ ref: 1, name: 'u1.png' }] }).parts[0].text).toBe(`*ab*\n${PLAIN_FOOTER}`)
    // The italics after it have their marks again, and so do those of a note.
    expect(plain('*_a_* *c*').parts[0].text).toBe(`*a* *c*\n${PLAIN_FOOTER}`)
    expect(plain('x[^a]\n\n[^a]: *so* noted').parts[0].text).toBe(`x\\[^a]\n-# \\[^a]: *so* noted\n${PLAIN_FOOTER}`)
  })

  it('shows no spoiler of a reply where marks that touch would have paired with the marks in it', () => {
    // The brief's line: Discord's italic would take `*so***`, and the bold left over would pair with the bold in the spoiler.
    const touching = 'I was *so***very** moved. Later: ||the **captain** dies||'
    // An italic in an italic, written `**a* b*`, would be a bold opened that pairs with the one in the spoiler.
    const nested = '*_a_ b* and ||SECRET **x** y||'
    for (const src of [touching, nested]) {
      for (const form of FORMS) {
        const r = toDiscord(src, opts({ form }))
        expect(r.parts).toHaveLength(1)
        expect(leaks(src, r.parts)).toEqual([])
      }
    }
    expect(plain(touching).parts[0].text).toBe(`I was *so*${ZW}**very** moved. Later: ||the **captain** dies||\n${PLAIN_FOOTER}`)
  })

  it("is refused by Send's AutoMod for a keyword that a zero-width space splits, which its matcher reads as nothing", async () => {
    const rule = { id: '200000000000000451', name: 'No Zorp', enabled: true, trigger_type: 1, trigger_metadata: { keyword_filter: ['zorp'], regex_patterns: [], allow_list: [] }, exempt_roles: [], exempt_channels: [], actions: [{ type: 1 }] }
    const automod = automodMatcher([rule], { log: () => {} })
    const upload = '200000000000000461'
    // The source holds no "zorp", for the picture stands between its halves; what is sent does, with a zero-width space in it.
    const source = '**zo**![p](upload:1)**rp**'
    expect(automod(source)).toBeNull()
    for (const form of FORMS) {
      expect(toDiscord(source, opts({ form, images: [{ ref: 1, name: 'image-1.png' }] })).parts[0].text.startsWith(`**zo**${ZW}**rp**\n`)).toBe(true)
      const r = await validateReply({ source, replyTo: null, mentions: [], uploads: [upload] }, { form, automod, ownUploadIds: [upload], authorId: AUTHOR, siteUrl: SITE })
      expect(r).toEqual({ ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "No Zorp".', rule: 'No Zorp', match: null })
    }
  })

  it('writes an italic of nothing but a space, which has no mark to join, as the space', () => {
    expect(plain('*a*_![ ](upload:2)_.').parts[0].text).toBe(`*a* .\n${PLAIN_FOOTER}`)
  })

  it('leaves two italics that something shows between as two', () => {
    expect(plain('*so* _very_').parts[0].text).toBe(`*so* *very*\n${PLAIN_FOOTER}`)
    expect(plain('*so*x _very_').parts[0].text).toBe(`*so*x *very*\n${PLAIN_FOOTER}`)
    expect(plain('*so*![p](upload:2)_very_').parts[0].text).toBe(`*so*p*very*\n${PLAIN_FOOTER}`)
  })

  it('joins italics that hold other marks', () => {
    expect(plain('_a **b** c_*d*').parts[0].text).toBe(`*a **b** cd*\n${PLAIN_FOOTER}`)
    expect(plain('||*a*_b_||').parts[0].text).toBe(`||*ab*||\n${PLAIN_FOOTER}`)
  })

  it('carries no stray bold through a long reply, and shows no spoiler of it (the repro of the re-review)', () => {
    const src = `I was *so*_very_ moved by this.\n\n${Array.from({ length: 60 }, (_, i) => `Filler line number ${i} of the long reply.`).join('\n')}\n${Array.from({ length: 30 }, (_, i) => `Thoughts ${i}: ||SECRET${i} the **captain** falls||.`).join('\n')}`
    const r = plain(src)
    expect(r.parts.length).toBeGreaterThan(1)
    expect(leaks(src, r.parts)).toEqual([])
    for (const part of r.parts) {
      expect(unbalanced(part.text)).toEqual([])
      expect(part.text.replace(/\*\*(?:\d\/\d|captain)\*\*/g, '')).not.toContain('**')
    }
  })
})

describe('toDiscord: marks that Discord reads otherwise than the parser, at a space or inside a mark of their own kind', () => {
  const images = [{ ref: 1, name: 'u1.png' }]

  it('writes the spaces at the inner edges of an italic or a strike outside its marks, which Discord would leave to pair with a spoiler (the re-review)', () => {
    // Discord takes no italic or strike that starts or ends with a space: `*a *` is no italic, and its second mark opens one with the
    // first mark of the spoiler, which shows what it holds. A picture that is attached shows nothing, and leaves the space at the edge.
    expect(plain('*a ![p](upload:1)*||*SECRET*||', { images }).parts[0].text).toBe(`*a* ||*SECRET*||\n${PLAIN_FOOTER}`)
    expect(plain('~~ a~~||~~SECRET~~||').parts[0].text).toBe(`~~a~~||~~SECRET~~||\n${PLAIN_FOOTER}`)
    expect(plain('_![](upload:2) |_||*a*||').parts[0].text).toBe(`*\\|*||*a*||\n${PLAIN_FOOTER}`)
    expect(plain('so ~~ a~~ and ~~b ~~||~~SECRET~~||').parts[0].text).toBe(`so  ~~a~~ and ~~b~~ ||~~SECRET~~||\n${PLAIN_FOOTER}`)
    // A mark of nothing but spaces in it leaves the spaces at its edge too, and so does one that starts with a picture.
    expect(plain('*a __ __*||*SECRET*||').parts[0].text).toBe(`*a*  ||*SECRET*||\n${PLAIN_FOOTER}`)
    expect(plain('*![p](upload:1) a*||*SECRET*||', { images }).parts[0].text).toBe(`*a*||*SECRET*||\n${PLAIN_FOOTER}`)
    expect(v2('*a ![p](upload:1)*||*SECRET*||', { images }).parts[0].text).toBe(`*a* ||*SECRET*||\n${FOOTER}`)
    // Bold, underline and a spoiler are marks to Discord with a space at their edges, and keep it.
    expect(plain('** a **||**SECRET**|| and __b __||__OTHER__|| and || c||').parts[0].text).toBe(`** a **||**SECRET**|| and __b __||__OTHER__|| and || c||\n${PLAIN_FOOTER}`)
    for (const src of ['*a ![p](upload:1)*||*SECRET*||', '~~ a~~||~~SECRET~~||', '~~a ~~||~~SECRET~~||', '*![p](upload:1) a*||*SECRET*||', '*a __ __*||*SECRET*||', '** a **||**SECRET**||']) {
      for (const form of FORMS) expect(leaks(src, toDiscord(src, opts({ form, images })).parts)).toEqual([])
    }
  })

  it('joins an italic to the one before it only where the two marks touch, now that a space may stand between them', () => {
    expect(plain('*a*_b ![p](upload:1)_*c*', { images }).parts[0].text).toBe(`*ab* *c*\n${PLAIN_FOOTER}`)
    expect(plain('*a*_![p](upload:1) b_', { images }).parts[0].text).toBe(`*a* *b*\n${PLAIN_FOOTER}`)
    expect(plain('**a**_![p](upload:1) b_ and ~~c ![p](upload:1)~~~~d~~', { images }).parts[0].text).toBe(`**a** *b* and ~~c~~ ~~d~~\n${PLAIN_FOOTER}`)
  })

  it('cuts an italic or a strike whose edges were spaces as one that ends in its last word, the spaces left outside it', () => {
    // The strike ends at 1700, and the space after it is the latest place that fits; a bold of an italic keeps the spaces in its bold.
    expect(plain(`~~ ${'a '.repeat(849)}~~${'b'.repeat(500)}`).parts.map((p) => p.text)).toEqual([m(1, 2, `~~${'a '.repeat(848)}a~~`), `${m(2, 2, 'b'.repeat(500))}\n${PLAIN_FOOTER}`])
    expect(plain(`*** ${'a '.repeat(849)}***${'b'.repeat(500)}`).parts.map((p) => p.text)).toEqual([m(1, 2, `** *${'a '.repeat(847)}a***`), `${m(2, 2, `***a* **${'b'.repeat(500)}`)}\n${PLAIN_FOOTER}`])
    // A mark that opens with a space is opened again in the next part before its first word, with no space and no mark left empty.
    for (const [mark, opened] of [['~~', '~~'], ['***', '** *']]) {
      const r = plain(`${'q '.repeat(850)}${mark} ${'z'.repeat(2000)}${mark}`)
      expect(r.parts).toHaveLength(3)
      expect(r.parts[0].text).toBe(m(1, 3, `${'q '.repeat(849)}q`))
      expect(r.parts[1].text.startsWith(`**2/3** ${opened}zzz`)).toBe(true)
    }
  })

  it('writes a bold inside a bold as its text, for Discord reads the italic between them as holding bolds, the one in a spoiler closing the one before it (the re-review)', () => {
    // `***` is a bold that holds an italic, so `***||**A**||***` is a bold in a bold: Discord's longest match takes the italic, and in it
    // `**||**` is a bold, which shows A.
    expect(plain('***||**A**||***').parts[0].text).toBe(`***||A||***\n${PLAIN_FOOTER}`)
    expect(plain('***a ||**B**|| c***').parts[0].text).toBe(`***a ||B|| c***\n${PLAIN_FOOTER}`)
    expect(plain('***[a **b** c](https://a.example/x)***').parts[0].text).toBe(`***[a b c](<https://a.example/x>)***\n${PLAIN_FOOTER}`)
    // The bolds after it have their marks again.
    expect(plain('***a **b** c*** **d**').parts[0].text).toBe(`***a b c*** **d**\n${PLAIN_FOOTER}`)
    for (const src of ['***||**A**||***', '***a ||**B**|| c***', 'x ***y ||**SECRET**|| z*** and ||OTHER||']) {
      for (const form of FORMS) expect(leaks(src, toDiscord(src, opts({ form })).parts)).toEqual([])
    }
    // The parser closes an underline, a strike and a spoiler at the first of its marks, so none of them is ever inside one of its own.
    for (const src of ['___||__A__||___', '~~~||~~A~~||~~~', '__a __||__B__|| c__', '~~a ~~||~~B~~|| c~~', '||a ||B|| c||', '|| a **||B||** c ||']) {
      for (const form of FORMS) expect(leaks(src, toDiscord(src, opts({ form })).parts)).toEqual([])
    }
  })
})

describe('toDiscord: what Discord shows of the spoilers of a reply that is cut', () => {
  const hiddenOf = (text) => Object.fromEntries(discordWords(text).map((w) => [w.word, w.hidden]))
  const spaced = (n) => Array(n).fill('a').join(' ')

  it('has a model of Discord that shows what a spoiler hides as hidden, and a pair of bars that closes nothing as pairing with the next', () => {
    expect(hiddenOf('a ||SECRET|| b')).toEqual({ a: 'none', SECRET: 'all', b: 'none' })
    expect(hiddenOf('||ONE two|| three ||FOUR||')).toEqual({ ONE: 'all', two: 'all', three: 'none', FOUR: 'all' })
    // A part that starts with `||` opened again and then the bars that close it: they pair with the next spoiler's bars.
    expect(hiddenOf('**2/3** |||| a || b ||')).toEqual({ a: 'all', b: 'none' })
    // Bold takes the first closing `**`, and so a spoiler in it that its text closes is left open.
    expect(hiddenOf('**Thoughts ||SECRET the **captain** falls||')).toEqual({ Thoughts: 'none', SECRET: 'none', the: 'none', captain: 'none', falls: 'none' })
    expect(hiddenOf('**bold ||SECRET|| bold**')).toEqual({ bold: 'none', SECRET: 'all' })
    expect(hiddenOf('> ||ONE\n> two|| three')).toEqual({ ONE: 'all', two: 'all', three: 'none' })
    expect(hiddenOf('```\n||code||\n```\nafter')).toEqual({ code: 'none', after: 'none' })
    expect(hiddenOf('\\|\\|not\\|\\| `||code||` [t](<https://a.example/x||y>) ||HIDDEN||')).toEqual({ not: 'none', code: 'none', t: 'none', HIDDEN: 'all' })
  })

  it('has a model in which marks that touch pair as Discord pairs them, and a spoiler of a space pairs with itself', () => {
    // The italic takes `*so***`, and the bold that is left pairs with the bold in the spoiler, whose bars it swallows.
    expect(hiddenOf('I was *so***very** moved. Later: ||the **captain** dies||')).toMatchObject({ the: 'none', captain: 'none', dies: 'none' })
    expect(hiddenOf(`I was *so*${ZW}**very** moved. Later: ||the **captain** dies||`)).toMatchObject({ so: 'none', very: 'none', the: 'all', captain: 'all', dies: 'all' })
    expect(hiddenOf('**so****very** ||the **captain** dies||')).toMatchObject({ the: 'none' })
    expect(hiddenOf(`**so**${ZW}**very** ||the **captain** dies||`)).toMatchObject({ so: 'none', very: 'none', the: 'all' })
    // Bars that close nothing pair with the next ones; a space between them makes a spoiler of them.
    expect(hiddenOf('**3/3** |||| then ||SECRET|| and ||OTHER|| end')).toMatchObject({ then: 'all', SECRET: 'none', and: 'all', OTHER: 'none' })
    expect(hiddenOf('**3/3** || || then ||SECRET|| and ||OTHER|| end')).toEqual({ then: 'none', SECRET: 'all', and: 'none', OTHER: 'all', end: 'none' })
    // An italic of a space is none, in Discord as in the model, and its second mark opens one; an italic of a zero-width space is one.
    expect(hiddenOf('* *then ||SECRET.*b* x||')).toMatchObject({ then: 'none', SECRET: 'none', x: 'none' })
    expect(hiddenOf(`*${ZW}*then ||SECRET.*b* x||`)).toEqual({ then: 'none', SECRET: 'all', b: 'all', x: 'all' })
  })

  it('has a model that takes the longest of the bold and the italic that match at a run of asterisks, and the italic of two as long, as Discord does', () => {
    // `_**a***_` is written `***a**\**`, an italic of a bold and an asterisk. Were bold taken first, it would be a bold of `*a`, and the
    // asterisk left over would open an italic with the first mark of the spoiler.
    expect(hiddenOf('***a**\\**||*u*||')).toEqual({ a: 'none', u: 'all' })
    expect(hiddenOf('***a*** ||**u**||')).toEqual({ a: 'none', u: 'all' })
    const src = '_**a***_||_u_||'
    expect(plain(src).parts[0].text).toBe(`***a**\\**||*u*||\n${PLAIN_FOOTER}`)
    for (const form of FORMS) expect(leaks(src, toDiscord(src, opts({ form })).parts)).toEqual([])
  })

  // The marks that a cut keeps from leaving a pair of them with nothing in: each is read as the mark of what it holds. (An italic or a
  // strike has the spaces at its edges written outside it, so a cut never finds one there.)
  const PAIRS = ['||', '**', '__', '`']

  for (const mark of PAIRS) {
    it(`cuts ${mark} that ends in a space before the space, so that no part starts with the ${mark} that closes it`, () => {
      // The closing mark starts at 1701 or so, where the room of part 1 (1774, less the mark it closes with) takes a cut at its end.
      const r = plain(`${mark} ${'a '.repeat(849)}${mark}${'b'.repeat(500)}`)
      expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `${mark} ${'a '.repeat(847)}a${mark}`), `${m(2, 2, `${mark}a ${mark}${'b'.repeat(500)}`)}\n${PLAIN_FOOTER}`])
    })

    it(`does not cut ${mark} right after its opening mark and the space after it, which would leave a pair of them at the end of the part`, () => {
      const r = plain(`${'q '.repeat(850)}${mark} ${'z'.repeat(2000)}${mark}`)
      expect(r.parts).toHaveLength(3)
      expect(r.parts[0].text).toBe(m(1, 3, `${'q '.repeat(849)}q`))
      expect(r.parts[1].text.startsWith(`**2/3** ${mark} zzz`)).toBe(true)
      for (const part of r.parts) expect(part.text).not.toContain(`${mark}${mark}`)
    })
  }

  it('cuts in front of an escape that a spoiler holds, and after one, as at any other character', () => {
    expect(plain(`||${'a '.repeat(849)}\\*${'b'.repeat(500)}||`).parts.map((p) => p.text)).toEqual([m(1, 2, `||${'a '.repeat(848)}a||`), `${m(2, 2, `||\\*${'b'.repeat(500)}||`)}\n${PLAIN_FOOTER}`])
    const r = plain(`||${'a '.repeat(840)}\\* ${'z'.repeat(2000)}||`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 3, `||${'a '.repeat(840)}\\*||`), m(2, 3, `||${'z'.repeat(1877)}||`), `${m(3, 3, `||${'z'.repeat(123)}||`)}\n${PLAIN_FOOTER}`])
  })

  it('cuts bold that ends in a space before the last word, where the cut that the room allows is right before that space', () => {
    // The closing bars start at 1773 and take 2 of the room, so a cut at 1772 would fit, in front of the space and no mark: but only
    // spaces lie between it and the mark.
    const r = plain(`**${'a'.repeat(1770)} **${'b'.repeat(500)}`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `**${'a'.repeat(1769)}**`), `${m(2, 2, `**a **${'b'.repeat(500)}`)}\n${PLAIN_FOOTER}`])
  })

  it('looks over more than one space between a cut and the mark that closes, and between the mark that opens and a cut', () => {
    const r = plain(`|| ${'a  '.repeat(566)}||${'b'.repeat(500)}`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `|| ${'a  '.repeat(564)}a||`), `${m(2, 2, `||a  ||${'b'.repeat(500)}`)}\n${PLAIN_FOOTER}`])
    const q = plain(`${'q '.repeat(850)}||   ${'z'.repeat(2000)}||`)
    expect(q.parts[0].text).toBe(m(1, 3, `${'q '.repeat(849)}q`))
    for (const part of q.parts) expect(part.text).not.toContain('||||')
  })

  it('cuts a spoiler that ends a sentence before that sentence, as the next best end', () => {
    const r = plain(`||${'abc. '.repeat(340)}||${'b'.repeat(500)}`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `||${'abc. '.repeat(338)}abc.||`), `${m(2, 2, `||abc. ||${'b'.repeat(500)}`)}\n${PLAIN_FOOTER}`])
  })

  it('does not cut between the lines of a spoiler right before the line that starts with the bars that close it', () => {
    const rows = Array.from({ length: 17 }, (_, i) => `${String(i).padStart(2, '0')}${'a'.repeat(96)}`)
    const r = plain(`||${rows.join('\n')}\n|| ${'y'.repeat(400)} ||SECRET|| tail`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `||${rows.slice(0, 16).join('\n')}||`), `${m(2, 2, `||${rows[16]}\n|| ${'y'.repeat(400)} ||SECRET|| tail`)}\n${PLAIN_FOOTER}`])
    expect(leaks(`||${rows.join('\n')}\n|| ${'y'.repeat(400)} ||SECRET|| tail`, r.parts)).toEqual([])
  })

  it('does the same for a spoiler in a quote, where the line with the closing bars starts with the quote mark', () => {
    const rows = Array.from({ length: 18 }, (_, i) => `${String(i).padStart(2, '0')}${'a'.repeat(94)}`)
    const src = `> ||${rows.join('\n> ')}\n> || ${'y'.repeat(400)} ||SECRET|| tail`
    const r = plain(src)
    expect(r.parts.map((p) => p.text)).toEqual([`**1/2**\n> ||${rows.slice(0, 17).join('\n> ')}||`, `**2/2**\n> ||${rows[17]}\n> || ${'y'.repeat(400)} ||SECRET|| tail\n${PLAIN_FOOTER}`])
    expect(leaks(src, r.parts)).toEqual([])
  })

  it('does not cut between the lines of a spoiler right after the line that ends with the bars that open it', () => {
    // Row 1 has 80 characters of room in part 1, and the closing bars (2) take two of them.
    const r = plain(`${'x'.repeat(1690)} ||\n${'c'.repeat(300)}||`)
    expect(r.parts.map((p) => p.text)).toEqual([m(1, 2, `${'x'.repeat(1690)} ||\n${'c'.repeat(78)}||`), `${m(2, 2, `||${'c'.repeat(222)}||`)}\n${PLAIN_FOOTER}`])
  })

  it('cuts a spoiler of nothing but spaces anywhere that leaves room, and gives the bars a space to hide, never `||||`', () => {
    // Every place in the spaces is right after the opening bars, and the last is right before the closing ones, so none is clean.
    expect(plain(`||${' '.repeat(3000)}w||`).parts.map((p) => p.text)).toEqual(['**1/2** || ||', `${m(2, 2, '||w||')}\n${PLAIN_FOOTER}`])
    const r = plain(`||${' '.repeat(5000)}w||tail`)
    expect(r.parts.map((p) => p.text)).toEqual(['**1/3** || ||', '**2/3** || ||', `${m(3, 3, '||w||tail')}\n${PLAIN_FOOTER}`])
  })

  it('keeps the spoilers after a spoiler of spaces hidden, where the part that starts with its closing bars gives them a space (the re-review)', () => {
    for (const [form, spaces] of [['plain', 3000], ['v2', 5000]]) {
      const src = `||SPOILT${' '.repeat(spaces)}|| then ||SECRET|| and ||OTHER|| end`
      const r = toDiscord(src, opts({ form }))
      expect(r.parts.map(textOf)).toEqual(['**1/3** ||SPOIL||', '**2/3** ||T||', `**3/3** || || then ||SECRET|| and ||OTHER|| end\n${form === 'v2' ? FOOTER : PLAIN_FOOTER}`])
      expect(leaks(src, r.parts)).toEqual([])
      for (const part of r.parts) expect(textOf(part)).not.toMatch(/^\*\*\d\/\d\*\* \|\|\|\|/)
    }
  })

  it('gives any other mark that a cut leaves with nothing in it a zero-width space, as Discord takes no italic or strike of a space', () => {
    expect(plain(`**${' '.repeat(3000)}w**`).parts.map((p) => p.text)).toEqual([`**1/2** **${ZW}**`, `${m(2, 2, '**w**')}\n${PLAIN_FOOTER}`])
    // The innermost mark is given it, here in a strike or an italic, whose own spaces at an edge are written outside them.
    expect(plain(`~~__${' '.repeat(3000)}w__~~`).parts.map((p) => p.text)).toEqual([`**1/2** ~~__${ZW}__~~`, `${m(2, 2, '~~__w__~~')}\n${PLAIN_FOOTER}`])
    expect(plain(`*__${' '.repeat(3000)}w__*`).parts.map((p) => p.text)).toEqual([`**1/2** *__${ZW}__*`, `${m(2, 2, '*__w__*')}\n${PLAIN_FOOTER}`])
    expect(plain(`~~${' '.repeat(3000)}w~~`).parts.map((p) => p.text)).toEqual(['**1/2**', `${m(2, 2, '~~w~~')}\n${PLAIN_FOOTER}`])
    const src = `**SPOILT${' '.repeat(3000)}** then ||SECRET|| and **b**`
    const r = plain(src)
    expect(r.parts.map((p) => p.text)).toEqual(['**1/3** **SPOIL**', '**2/3** **T**', `**3/3** **${ZW}** then ||SECRET|| and **b**\n${PLAIN_FOOTER}`])
    expect(leaks(src, r.parts)).toEqual([])
  })

  it('counts what it gives the bars at the start of a part against the room of that part', () => {
    // Part 3 starts with `|| ||`, and its space is a character of its room: with it the part is cut one word earlier.
    const r = plain(`||SPOILT${' '.repeat(3000)}||${' q'.repeat(850)}`)
    expect(r.parts.map((p) => p.text.slice(0, 20))).toEqual(['**1/4** ||SPOIL||', '**2/4** ||T||', '**3/4** || || q q q ', '**4/4** q q q q q q '])
    expect(r.parts[2].text).toBe(`**3/4** || ||${' q'.repeat(375)}`)
  })

  it('cuts a long run of spaces in a spoiler in time that is linear in its length', () => {
    // A cut that looks over the spaces to the next mark at each place in them took 28 s for 15,000 of them.
    const start = performance.now()
    for (const form of FORMS) expect(toDiscord(`||${' '.repeat(15_000)}w||`, opts({ form })).parts.length).toBeGreaterThan(1)
    expect(performance.now() - start).toBeLessThan(globalThis.__stryker__ ? 30_000 : 2000)
  })

  it('keeps the spoilers of a reply of spaced spoilers hidden, in both forms (the first repro of the re-review)', () => {
    const src = `Intro. ${Array.from({ length: 200 }, (_, i) => `|| SECRET${i} dies. || Then a plain sentence ${i}. `).join('')}`
    for (const form of FORMS) {
      const r = toDiscord(src, opts({ form }))
      expect(r.parts.length).toBeGreaterThan(1)
      expect(leaks(src, r.parts)).toEqual([])
      for (const part of r.parts) expect(textOf(part)).not.toContain('||||')
    }
  })

  it('keeps the other twist of a spoiler that closes at the start of a line hidden, in both forms (the second repro of the re-review)', () => {
    const body = (n) => Array.from({ length: n }, (_, i) => `In chapter five the captain falls at gate ${i}.`).join('\n')
    for (const [form, n] of [['plain', 76], ['v2', 162]]) {
      const src = `Spoilers for the finale below.\n\n||${body(n)}\n|| What a finale. And the other twist: ||SECRET_TWO is the traitor|| and that is all.`
      const r = toDiscord(src, opts({ form }))
      expect(r.parts).toHaveLength(3)
      expect(leaks(src, r.parts)).toEqual([])
      for (const part of r.parts) expect(textOf(part)).not.toContain('||||')
    }
  })

  // Words of a spoiler are capitals and the rest are lower case, so a word says what it is; the parser says it again (wordClasses).
  const LOWER = 'alpha bravo cargo delta ember frost gamma haven ivory jewel karst lunar mango noble ocean piper quartz raven sable tango umber vigil wharf xenon yacht zephyr bison cedar dune finch grove'.split(' ')
  const lw = fc.constantFrom(...LOWER)
  const sw = fc.constantFrom(...LOWER.map((w) => w.toUpperCase()))
  const some = (item, least, most) => fc.array(item, { minLength: least, maxLength: most }).map((a) => a.join(' '))
  const sentence = some(lw, 1, 8).map((s) => `${s}.`)
  const secret = some(sw, 1, 6)
  const unit = fc.oneof(
    { weight: 8, arbitrary: sentence },
    { weight: 3, arbitrary: secret.map((s) => `||${s}||`) },
    { weight: 4, arbitrary: secret.map((s) => `|| ${s} ||`) },
    { weight: 3, arbitrary: secret.map((s) => `|| ${s}. ||`) },
    { weight: 2, arbitrary: secret.map((s) => `||${s}.||`) },
    { weight: 2, arbitrary: fc.array(secret, { minLength: 2, maxLength: 5 }).map((l) => `||${l.join('\n')}||`) },
    { weight: 2, arbitrary: fc.tuple(secret, secret, sentence, secret).map(([a, b, p, c]) => `||${a}\n${b}\n|| ${p} ||${c}||`) },
    { weight: 2, arbitrary: fc.tuple(sw, sw, sw).map(([a, b, c]) => `||${a} **${b}** ${c}||`) },
    { weight: 2, arbitrary: fc.tuple(lw, sw, lw).map(([a, b, c]) => `**${a} ||${b}|| ${c}**`) },
    { weight: 1, arbitrary: secret.map((s) => `||**${s}**||`) },
    { weight: 2, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `*${a}*_${b}_`) },
    { weight: 1, arbitrary: fc.tuple(sw, sw).map(([a, b]) => `||*${a}*_${b}_||`) },
    // Marks that touch: of other kinds, and of one character, where Discord's lazy rules would pair a bold's marks with later ones
    // but for the zero-width space the form puts between them, even in a reply of one part. A picture that is attached shows nothing.
    { weight: 1, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `**${a}**__${b}__`) },
    { weight: 1, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `~~${a}~~**${b}**`) },
    { weight: 1, arbitrary: fc.tuple(sw, sw).map(([a, b]) => `||${a}||||${b}||`) },
    { weight: 1, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `*${a}***${b}**`) },
    { weight: 1, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `**${a}***${b}*`) },
    { weight: 1, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `**${a}****${b}**`) },
    { weight: 1, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `__${a}____${b}__`) },
    { weight: 2, arbitrary: fc.tuple(lw, lw, fc.constantFrom('**', '__', '*', '`', '~~')).map(([a, b, mark]) => `${mark}${a}${mark}![p](upload:1)${mark}${b}${mark}`) },
    { weight: 1, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `*${a}*![p](upload:1)**${b}**`) },
    { weight: 1, arbitrary: fc.tuple(sw, sw).map(([a, b]) => `||*${a}***${b}**||`) },
    { weight: 1, arbitrary: fc.tuple(sw, sw).map(([a, b]) => `||**${a}****${b}**||`) },
    // An italic in an italic, which the form writes as its text.
    { weight: 1, arbitrary: fc.tuple(lw, lw).map(([a, b]) => `*_${a}_ ${b}*`) },
    // A mark with a space at an inner edge, then a spoiler that opens with the same mark: Discord takes no italic or strike so, and
    // would pair its marks with the spoiler's but for the spaces that the form writes outside it. A picture that is attached shows
    // nothing, and leaves a space at the edge of an italic. Bold and underline are marks with the spaces in them.
    { weight: 1, arbitrary: fc.tuple(lw, sw).map(([a, b]) => `*${a} ![p](upload:1)*||*${b}*||`) },
    { weight: 1, arbitrary: fc.tuple(lw, sw).map(([a, b]) => `*![p](upload:1) ${a}*||*${b}*||`) },
    { weight: 1, arbitrary: fc.tuple(lw, sw, fc.constantFrom('~~', '**', '__')).map(([a, b, mark]) => `${mark} ${a}${mark}||${mark}${b}${mark}||`) },
    { weight: 1, arbitrary: fc.tuple(lw, sw, fc.constantFrom('~~', '**', '__')).map(([a, b, mark]) => `${mark}${a} ${mark}||${mark}${b}${mark}||`) },
    // A bold in a bold, which `***` makes (a bold that holds an italic), and which the form writes as its text.
    { weight: 1, arbitrary: sw.map((a) => `***||**${a}**||***`) },
    { weight: 1, arbitrary: fc.tuple(lw, sw, lw).map(([a, b, c]) => `***${a} ||**${b}**|| ${c}***`) },
    // A spoiler over lines, one of which is all a picture that is attached, or a mark of spaces: it shows nothing.
    { weight: 1, arbitrary: fc.tuple(sw, sw, fc.constantFrom('![p](upload:1)', '__ __', '*![p](upload:1)*')).map(([a, b, line]) => `||${a}\n${line}\n${b}||`) },
  )
  // A paragraph of units, on one line or on a few: a spoiler that is cut can fall anywhere in it.
  const paragraph = (least, most) =>
    fc
      .array(fc.tuple(unit, fc.constantFrom(' ', ' ', ' ', ' ', '\n')), { minLength: least, maxLength: most })
      .map((units) => units.map(([u, join], i) => (i === 0 ? '' : join) + u).join(''))
  const quoted = (text) => text.split('\n').map((line) => `> ${line}`).join('\n')
  const docOf = (form) => {
    const para = form === 'v2' ? paragraph(100, 300) : paragraph(50, 160)
    return fc.array(fc.oneof({ weight: 5, arbitrary: para }, { weight: 1, arbitrary: para.map(quoted) }), { minLength: 1, maxLength: 3 }).map((paras) => paras.join('\n\n'))
  }
  const replyTos = fc.constantFrom(null, { authorId: REPLIED, url: JUMP }, { authorId: WORST_ID, url: `https://${'a'.repeat(192)}` })
  const threads = fc.constantFrom(undefined, { urlBase: BASE, partIds: MSG }, { urlBase: WORST_BASE, partIds: [WORST_ID, WORST_ID, WORST_ID] }, { urlBase: BASE, partIds: [MSG[0], null, null] })

  for (const form of FORMS) {
    it(`shows no word of a spoiler and hides no other word, in whatever part a cut puts them (${form}, with and without the reply line)`, () => {
      let cut = 0
      fc.assert(
        fc.property(docOf(form), replyTos, threads, (src, replyTo, thread) => {
          const r = toDiscord(src, opts({ form, replyTo, thread, images: [{ ref: 1, name: 'u1.png' }] }))
          if (r.parts.length > 1) cut++
          const found = leaks(src, r.parts)
          if (found.length > 0) throw new Error(found.join('\n'))
        }),
        // A reply is thousands of characters long, so what is said of a failure is the leaks and the start of the reply, not all of it.
        {
          numRuns: 1000,
          interruptAfterTimeLimit: 90_000,
          reporter: (d) => {
            if (d.failed) throw new Error(`seed ${d.seed} after ${d.numRuns} runs and ${d.numShrinks} shrinks: ${d.errorInstance?.message}\nreply: ${JSON.stringify(d.counterexample[0]).slice(0, 1200)}`)
          },
        },
      )
      // Most of the replies are cut, or the property says nothing of cuts.
      expect(cut).toBeGreaterThan(500)
    }, 180_000)
  }
})

describe('toDiscord: a reply with no place to cut that leaves each mark something in it (the re-review)', () => {
  it('cuts a spoiler whose second line is a character and more spaces than a part has room for, and throws nothing (the repro)', () => {
    expect(plain(`||\nA${' '.repeat(3000)}||`).parts.map((p) => p.text)).toEqual(['**1/2** ||\nA||', `**2/2** || ||\n${PLAIN_FOOTER}`])
    expect(v2(`||\nA${' '.repeat(5000)}||`).parts.map((p) => p.text)).toEqual(['**1/2** ||\nA||', `**2/2** || ||\n${FOOTER}`])
  })

  it('does so after other text on the line of its bars, and after a paragraph', () => {
    for (const form of FORMS) {
      for (const before of ['x ', 'Intro.\n\n', 'Intro.\n\nx ']) {
        const src = `${before}||\nA${' '.repeat(form === 'v2' ? 5000 : 3000)}||`
        const r = toDiscord(src, opts({ form }))
        // The text before the bars is cut off at its latest clean place first, so the reply takes a part more than it might.
        const n = r.parts.length
        expect(r.parts.slice(-2).map(textOf)).toEqual([`**${n - 1}/${n}** ||\nA||`, `**${n}/${n}** || ||\n${form === 'v2' ? FOOTER : PLAIN_FOOTER}`])
        expect(leaks(src, r.parts)).toEqual([])
        for (const part of r.parts) expect(textOf(part)).not.toContain('||||')
      }
    }
  })

  it('cuts a spoiler of three lines whose middle one all but fills a part, where neither line end is a place to cut', () => {
    // The count of parts is cut for one part first: there neither line end is a place, nor anywhere in the bars of the first line
    // or the last, so the part ends at the last line end it passed over. The parts sent are cut inside the long line.
    expect(plain(`||\n${x(1900)}\n||`).parts.map((p) => p.text)).toEqual([m(1, 2, `||\n${x(1769)}||`), `${m(2, 2, `||${x(131)}\n||`)}\n${PLAIN_FOOTER}`])
    expect(v2(`||\n${x(3945)}\n||`).parts.map((p) => p.text)).toEqual([m(1, 2, `||\n${x(3769)}||`), `${m(2, 2, `||${x(176)}\n||`)}\n${FOOTER}`])
  })

  it('cuts the line of the bars of a spoiler in its spaces, where its next line is too long to cut in', () => {
    expect(plain(`||${' '.repeat(1900)}A\nB||`).parts.map((p) => p.text)).toEqual(['**1/2** || ||', `${m(2, 2, '||A\nB||')}\n${PLAIN_FOOTER}`])
    expect(v2(`||${' '.repeat(3945)}A\nB||`).parts.map((p) => p.text)).toEqual(['**1/2** || ||', `${m(2, 2, '||A\nB||')}\n${FOOTER}`])
  })

  it('keeps room for what a mark is given to hold where a cut right after its marks leaves it empty, and else ends the part at a line end', () => {
    // Part 1 runs out of room in the last line of the second spoiler. With 7 characters left there, the cut right after its underline's
    // marks fits, as they are closed with a zero-width space in them; with 6 it does not, and the part ends at the line end before,
    // after the bars that open the second spoiler, which are given a space.
    const src = (n) => `||\n${'F'.repeat(n)}|| y ||\n__😀x__||\n\n${'w '.repeat(900)}`
    for (const [form, n] of [['plain', 1756], ['v2', 3756]]) {
      const r = toDiscord(src(n), opts({ form }))
      expect(r.parts[0].text).toBe(m(1, r.parts.length, `||\n${'F'.repeat(n)}|| y ||\n__${ZW}__||`))
      const s = toDiscord(src(n + 1), opts({ form }))
      expect(s.parts[0].text).toBe(m(1, s.parts.length, `||\n${'F'.repeat(n + 1)}|| y || ||`))
      expect(s.parts[1].text.startsWith(m(2, s.parts.length, '||__😀x__||\n\nw w'))).toBe(true)
      expect(leaks(src(n + 1), s.parts)).toEqual([])
    }
  })

  it('throws nothing for any length of these lines, near the room of a part or not', () => {
    for (const form of FORMS) {
      const near = form === 'v2' ? 3900 : 1850
      for (let n = near; n < near + 120; n++) {
        for (const src of [`||\n${x(n)}\n||`, `||${' '.repeat(n)}A\nB||`, `||\nA${' '.repeat(n)}||`, `x ||\n${x(n)}\n|| y`, `**||\n${x(n)}\n||**`]) {
          const r = toDiscord(src, opts({ form }))
          for (const part of r.parts) expect(displayableLength(part)).toBeLessThanOrEqual(form === 'v2' ? 4000 : 2000)
        }
      }
    }
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
  // A spoiler of one line, of many, or in a quote, long enough that a cut falls in it, with what hides a bar (code, a link, an escape).
  const hiders = fc.constantFrom('`a||b`', '<https://a.example/x||y>', '\\|\\|', '``c`d||e``', 'plain', '[t](<https://a.example/z>)')
  const spoilerText = fc.array(fc.oneof({ weight: 8, arbitrary: sentence }, { weight: 1, arbitrary: hiders }), { minLength: 1, maxLength: 160 })
  const spoiler = fc.oneof(
    spoilerText.map((t) => `||${t.join(' ')}||`),
    spoilerText.map((t) => `||${t.join('\n')}||`),
    spoilerText.map((t) => `> ||${t.join('\n> ')}||`),
    spoilerText.map((t) => `intro ||${t.join(' ')}|| outro`),
  )
  const block = fc.oneof(
    { weight: 6, arbitrary: prose },
    { weight: 3, arbitrary: lines },
    { weight: 2, arbitrary: fc.array(word, { minLength: 1, maxLength: 40 }).map((w) => w.map((t) => `- ${t} item`).join('\n')) },
    { weight: 2, arbitrary: fc.array(word, { minLength: 1, maxLength: 70 }).map((w) => `\`\`\`\n${w.join('\n')}\n\`\`\``) },
    { weight: 2, arbitrary: fc.array(word, { minLength: 1, maxLength: 12 }).map((w) => `| a | b |\n| - | - |\n${w.map((t) => `| ${t} | ${t}${t} |`).join('\n')}`) },
    { weight: 2, arbitrary: fc.constantFrom('---', '# H', '#### Four', '-# small', '> quote', '![a](upload:1)', '![b](upload:2)', '![c](upload:3)\n![c](upload:3)', '```', '| a |', '[^a]: note a', '[^b]: ' + 'n'.repeat(300)) },
    { weight: 2, arbitrary: prose.map((p) => `${p}[^a] and${p.slice(0, 20)}[^b]`) },
    { weight: 2, arbitrary: spoiler },
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

  // Marks round lines of any length, a character and a run of spaces of any length, and the runs alone: the reply that leaves a cut no
  // place but next to a mark, which the generators above never make, for their runs are short.
  it('never throws on a reply of long runs of spaces, line ends and marks, of up to the 16,000 characters the route takes, and keeps every limit', () => {
    const mark = fc.constantFrom('||', '**', '__', '~~', '*', '`')
    const run = fc.tuple(fc.integer({ min: 1, max: 4200 }), fc.constantFrom('x', 'A ', 'ab ')).map(([n, unit]) => (unit === 'A ' ? `A${' '.repeat(n)}` : unit.repeat(n).slice(0, n)))
    const piece = fc.oneof(
      fc.tuple(mark, run).map(([k, r]) => `${k}\n${r}\n${k}`),
      fc.tuple(mark, run).map(([k, r]) => `${k}\n${r}${k}`),
      fc.tuple(mark, run).map(([k, r]) => `${k}${r}\n${k}`),
      fc.tuple(mark, run).map(([k, r]) => `x ${k}\n${r}\n${k} y`),
      fc.tuple(mark, run).map(([k, r]) => `${k}${r}${k} then ||S|| and ||T||`),
      fc.integer({ min: 0, max: 5000 }).map((n) => ' '.repeat(n)),
      fc.constantFrom('||', '**', '*', '__', '~~', '`', '\n', '\n\n', '> ', '- ', 'word', 'B. ', '\\', '![p](upload:1)', '[^a]', '\n[^a]: note\n'),
    )
    const reply = fc.array(piece, { minLength: 1, maxLength: 6 }).map((pieces) => pieces.join('').slice(0, 16_000))
    fc.assert(
      fc.property(reply, options, (src, o) => {
        for (const part of toDiscord(src, build(o)).parts) {
          expect(displayableLength(part)).toBeLessThanOrEqual(o.form === 'v2' ? 4000 : 2000)
          if (o.form === 'v2') expect(count(part.components)).toBeLessThanOrEqual(40)
        }
      }),
      { numRuns: 400 },
    )
  }, 60_000)

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
    const body = fc.oneof(prose, lines, spoiler, fc.integer({ min: 1, max: 4000 }).map((n) => x(n)), fc.array(word, { minLength: 1, maxLength: 70 }).map((w) => `\`\`\`\n${w.join('\n')}\n\`\`\``), fc.array(word, { minLength: 1, maxLength: 40 }).map((w) => w.map((t) => `- ${t} item`).join('\n')))
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

  const spoilered = fc.array(fc.oneof(spoiler, block), { minLength: 1, maxLength: 5 }).chain((blocks) => fc.constantFrom('\n\n', '\n').map((sep) => blocks.join(sep)))
  const garbage = fc
    .array(fc.constantFrom('||', '|', '*', '**', '_', '__', '~~', '`', '``', '<', '>', '\\', ' ', 'word', 'end. ', '\n', '\n\n', '```\n', '> ', '- ', '# '), { maxLength: 500 })
    .map((a) => a.join('').repeat(4))

  // Long lines of marked text, to be cut in the middle of a mark: the marks nest, and are one of the form's own.
  const marked = fc.oneof(
    sentence,
    word.map((w) => `**${w} ${w}**`),
    word.map((w) => `*${w} ${w}*`),
    word.map((w) => `__${w} ${w}__`),
    word.map((w) => `~~${w} ${w}~~`),
    word.map((w) => `\`${w} ${w}\``),
    word.map((w) => `||${w} ${w}||`),
    word.map((w) => `**${w} *${w} ${w}* ${w}**`),
    word.map((w) => `***${w} ${w}***`),
    word.map((w) => `||**${w}** ~~${w} *${w}*~~||`),
    fc.constantFrom('[a link](<https://a.example/z>)', '<@123456789012345678>', '\\* \\_ \\~ \\| \\`', '`a*b**c||d`', '<https://a.example/x*y_z>'),
  )
  const markedLine = fc.array(marked, { minLength: 40, maxLength: 700 }).map((items) => items.join(' '))
  const markedDoc = fc.array(fc.oneof(markedLine, markedLine.map((l) => `#### ${l}`), markedLine.map((l) => `- ${l}`), markedLine.map((l) => `> ${l}`), markedLine.map((l) => `-# ${l}`), spoiler), { minLength: 1, maxLength: 3 }).map((b) => b.join('\n\n'))

  it('leaves no mark open at the end of any part: every bar, bold, italic, underline and strike a cut falls in is closed', () => {
    fc.assert(
      fc.property(fc.oneof(markedDoc, spoilered), options, (src, o) => {
        const r = toDiscord(src, build(o))
        for (const part of r.parts) expect(unbalanced(textOf(part))).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  // Two marks in a row, as `*a**b*`, are not told from a pair of other marks, so hostile text is held to bars alone.
  it('leaves no bars open at the end of any part, whatever hostile text is made of', () => {
    fc.assert(
      fc.property(garbage, options, (src, o) => {
        for (const part of toDiscord(src, build(o)).parts) expect(bars(textOf(part)) % 2).toBe(0)
      }),
      { numRuns: 300 },
    )
  })

  it('keeps every limit and every word of a reply of marked lines', () => {
    const words = (text) => text.replace(/[*_~|`\s]/g, '')
    fc.assert(
      fc.property(markedLine, fc.constantFrom('v2', 'plain'), (src, form) => {
        const r = toDiscord(src, build({ form }))
        const body = r.parts.map((part, i) => {
          const text = textOf(part)
          expect(form === 'v2' ? displayableLength(part) : text.length).toBeLessThanOrEqual(form === 'v2' ? 4000 : 2000)
          return unmark(i === r.parts.length - 1 ? text.replace(form === 'v2' ? FOOTER : PLAIN_FOOTER, '') : text)
        })
        expect(words(body.join(''))).toBe(words(src))
      }),
      { numRuns: 150 },
    )
  })

  it('loses nothing and repeats nothing of a reply with spoilers, but for the bars of its cuts', () => {
    const words = (text) => text.replace(/\|\||\s+/g, '')
    // The parser pairs a `||` with the next one even inside code, so what hides a bar is left out: only words are compared.
    const said = fc.array(sentence, { minLength: 1, maxLength: 160 })
    const written = fc.array(fc.oneof(said.map((t) => `||${t.join(' ')}||`), said.map((t) => `||${t.join('\n')}||`), said.map((t) => `intro ||${t.join(' ')}|| outro`), prose), { minLength: 1, maxLength: 4 }).map((b) => b.join('\n\n'))
    fc.assert(
      fc.property(written, fc.constantFrom('v2', 'plain'), (src, form) => {
        const r = toDiscord(src, build({ form }))
        const body = r.parts.map((part, i) => {
          const text = textOf(part)
          return unmark(i === r.parts.length - 1 ? text.replace(form === 'v2' ? FOOTER : PLAIN_FOOTER, '') : text)
        })
        expect(words(body.join(''))).toBe(words(src))
      }),
      { numRuns: 150 },
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

// The site bundles this module (the composer's meter and its Discord view run it in the browser), so an import there would drag
// a server module into the browser bundle, or break the build: the parser is the one import it may have.
describe('the form the site shares with the server', () => {
  const source = readFileSync(new URL('./librariusForm.js', import.meta.url), 'utf8')

  it('imports the markdown parser and nothing else', () => {
    // (The mutation run reads an instrumented copy, which ends its lines with a semicolon.)
    const lines = source.split(/\r?\n/).map((line) => line.replace(/;$/, ''))
    expect(lines.filter((line) => /^\s*import[\s{*'"(]/.test(line))).toEqual(["import { parse } from './librariusMarkdown.js'"])
    expect(lines.filter((line) => /\bfrom\s+['"]/.test(line))).toEqual(["import { parse } from './librariusMarkdown.js'"])
    expect(lines.filter((line) => line.includes('require('))).toEqual([])
    expect(source).not.toMatch(/\bimport\(/)
  })
})
