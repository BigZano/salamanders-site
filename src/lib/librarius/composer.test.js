import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'
import { parse, plainText, walk } from '../archive/markdown'
import { ACTIONS, apply, asQuote, insertBlock, draftKey, draftStorage, saveDraft, loadDraft, clearDraft, clearAllDrafts } from './composer'

// Every id here is invented.
const POST = '200000000000000410'
const MESSAGE = '200000000000000411'
const OTHER_POST = '200000000000000412'
const MEMBER = '200000000000000413'
const EMOJI = '200000000000000414'

// A text with its selection written into it: «…» is a selection, ‸ a caret. No test text has these characters of its own.
const CARET = '‸'
function at(marked) {
  const caret = marked.indexOf(CARET)
  if (caret !== -1) return { text: marked.slice(0, caret) + marked.slice(caret + 1), selection: { start: caret, end: caret } }
  const open = marked.indexOf('«')
  const close = marked.indexOf('»')
  return {
    text: marked.slice(0, open) + marked.slice(open + 1, close) + marked.slice(close + 1),
    selection: { start: open, end: close - 1 },
  }
}
function show({ text, selection: { start, end } }) {
  if (start === end) return text.slice(0, start) + CARET + text.slice(start)
  return `${text.slice(0, start)}«${text.slice(start, end)}»${text.slice(end)}`
}
function run(marked, action) {
  const { text, selection } = at(marked)
  return show(apply(text, selection, action))
}

const blocks = (text) => parse(text, { dialect: 'extended' })
function nodesOf(text, type) {
  const found = []
  walk(blocks(text), (node) => node.type === type && found.push(node))
  return found
}

describe('ACTIONS', () => {
  it('lists every toolbar action, in the order of the toolbar', () => {
    expect(ACTIONS).toEqual([
      'h1', 'h2', 'h3',
      'bold', 'italic', 'underline', 'strike', 'spoiler',
      'quote', 'code', 'bullet', 'numbered',
      'link', 'image', 'table', 'rule', 'mention', 'emoji',
      'subtext',
    ])
    expect(Object.isFrozen(ACTIONS)).toBe(true)
  })
})

describe('apply: what it is given', () => {
  it('takes only a string for the text', () => {
    for (const text of [null, undefined, 3, ['a'], { length: 0 }]) {
      expect(() => apply(text, { start: 0, end: 0 }, 'bold')).toThrow(TypeError)
      expect(() => apply(text, { start: 0, end: 0 }, 'bold')).toThrow('the text must be a string')
    }
  })

  it('takes only { start, end } of whole numbers for the selection', () => {
    for (const selection of [null, undefined, 'x', 0, {}, { start: 0 }, { end: 0 }, { start: '0', end: 0 }, { start: 0, end: 0.5 }, { start: NaN, end: NaN }, { start: 0, end: Infinity }]) {
      expect(() => apply('abc', selection, 'bold')).toThrow(TypeError)
      expect(() => apply('abc', selection, 'bold')).toThrow('the selection must be { start, end }')
    }
  })

  it('takes a selection only inside the text, its start first', () => {
    for (const [start, end] of [[-1, 0], [0, 4], [2, 1], [4, 4], [-1, -1]]) {
      expect(() => apply('abc', { start, end }, 'bold')).toThrow(RangeError)
    }
    for (const [start, end] of [[0, 0], [0, 3], [3, 3], [1, 2]]) {
      expect(() => apply('abc', { start, end }, 'bold')).not.toThrow()
    }
  })

  it('refuses an action it does not know, of any kind', () => {
    for (const action of ['Bold', 'h4', '', 'toString', '__proto__', 'constructor', { type: 'hasOwnProperty' }, { type: 'nope' }]) {
      expect(() => apply('abc', { start: 0, end: 0 }, action)).toThrow(RangeError)
    }
    const hostile = { toString: () => { throw new Error('read') } }
    for (const action of [null, undefined, 3, true, Symbol('bold'), hostile, ['bold'], { type: hostile }, { type: 3 }, { type: null }, {}]) {
      expect(() => apply('abc', { start: 0, end: 0 }, action)).toThrow(TypeError)
      expect(() => apply('abc', { start: 0, end: 0 }, action)).toThrow('an action is a name')
    }
  })

  it('takes { type } for an action as well as its name', () => {
    expect(apply('ab', { start: 0, end: 2 }, { type: 'bold' })).toEqual(apply('ab', { start: 0, end: 2 }, 'bold'))
    expect(apply('ab', { start: 1, end: 1 }, { type: 'h1' })).toEqual({ text: '# ab', selection: { start: 3, end: 3 } })
  })

  it('needs the payload of an image, a mention and an emoji', () => {
    for (const name of ['image', 'mention', 'emoji']) {
      expect(() => apply('abc', { start: 0, end: 0 }, name)).toThrow(TypeError)
      expect(() => apply('abc', { start: 0, end: 0 }, { type: name })).toThrow(TypeError)
    }
  })
})

describe('apply: headings, subtext, quotes and lists (line actions)', () => {
  it('makes the line a heading of each level, the caret where it was in the words', () => {
    expect(run('Ash‸ plain', 'h1')).toBe('# Ash‸ plain')
    expect(run('Ash‸ plain', 'h2')).toBe('## Ash‸ plain')
    expect(run('Ash‸ plain', 'h3')).toBe('### Ash‸ plain')
    expect(run('Ash‸ plain', 'subtext')).toBe('-# Ash‸ plain')
    expect(run('Ash‸ plain', 'quote')).toBe('> Ash‸ plain')
    expect(run('Ash‸ plain', 'bullet')).toBe('- Ash‸ plain')
    expect(run('Ash‸ plain', 'numbered')).toBe('1. Ash‸ plain')
  })

  it('puts a caret at the start of the line after the mark, ready to type', () => {
    expect(run('‸Ash', 'h1')).toBe('# ‸Ash')
    expect(run('‸', 'h2')).toBe('## ‸')
    expect(run('‸', 'quote')).toBe('> ‸')
    expect(run('one\n‸two', 'quote')).toBe('one\n> ‸two')
    expect(run('one\n‸', 'bullet')).toBe('one\n- ‸')
  })

  it('takes the mark off a line that has it', () => {
    expect(run('# Ash‸', 'h1')).toBe('Ash‸')
    expect(run('## Ash‸', 'h2')).toBe('Ash‸')
    expect(run('### Ash‸', 'h3')).toBe('Ash‸')
    expect(run('-# Ash‸', 'subtext')).toBe('Ash‸')
    expect(run('> Ash‸', 'quote')).toBe('Ash‸')
    expect(run('>‸', 'quote')).toBe('‸')
    expect(run('- Ash‸', 'bullet')).toBe('Ash‸')
    expect(run('* Ash‸', 'bullet')).toBe('Ash‸')
    expect(run('1. Ash‸', 'numbered')).toBe('Ash‸')
    expect(run('17. Ash‸', 'numbered')).toBe('Ash‸')
    expect(run('#   Ash‸', 'h1')).toBe('Ash‸')
    expect(run('-   Ash‸', 'bullet')).toBe('Ash‸')
  })

  it('swaps one heading for another, and a heading for subtext, rather than stacking them', () => {
    expect(run('## Ash‸', 'h1')).toBe('# Ash‸')
    expect(run('# Ash‸', 'h3')).toBe('### Ash‸')
    expect(run('#### Ash‸', 'h2')).toBe('## Ash‸')
    expect(run('###### Ash‸', 'h1')).toBe('# Ash‸')
    expect(run('-# Ash‸', 'h1')).toBe('# Ash‸')
    expect(run('# Ash‸', 'subtext')).toBe('-# Ash‸')
  })

  it('swaps one kind of list for the other', () => {
    expect(run('1. Ash‸', 'bullet')).toBe('- Ash‸')
    expect(run('- Ash‸', 'numbered')).toBe('1. Ash‸')
    expect(run('* Ash‸', 'numbered')).toBe('1. Ash‸')
  })

  it('reads a mark only where it is one', () => {
    // No space after the mark: these lines are words, and get the mark in front of them.
    expect(run('#Ash‸', 'h1')).toBe('# #Ash‸')
    expect(run('-#Ash‸', 'subtext')).toBe('-# -#Ash‸')
    expect(run('>Ash‸', 'quote')).toBe('> >Ash‸')
    expect(run('-Ash‸', 'bullet')).toBe('- -Ash‸')
    expect(run('1.Ash‸', 'numbered')).toBe('1. 1.Ash‸')
    expect(run('####### Ash‸', 'h1')).toBe('# ####### Ash‸')
    expect(run('1234567890. Ash‸', 'numbered')).toBe('1. 1234567890. Ash‸')
    expect(run('**Ash**‸', 'bullet')).toBe('- **Ash**‸')
    expect(run('---‸', 'bullet')).toBe('- ---‸')
    expect(run('1) Ash‸', 'numbered')).toBe('1. 1) Ash‸')
  })

  it('keeps the other marks of a line: a quote holds a list, a list item holds a heading', () => {
    expect(run('- one‸', 'quote')).toBe('> - one‸')
    expect(run('> one‸', 'bullet')).toBe('> - one‸')
    expect(run('> - one‸', 'h1')).toBe('> - # one‸')
    expect(run('> - # one‸', 'quote')).toBe('- # one‸')
    expect(run('> - # one‸', 'bullet')).toBe('> # one‸')
    expect(run('> - # one‸', 'h1')).toBe('> - one‸')
    expect(run('> - # one‸', 'numbered')).toBe('> 1. # one‸')
    expect(run('# one‸', 'bullet')).toBe('- # one‸')
    expect(run('-# one‸', 'quote')).toBe('> -# one‸')
  })

  it('keeps the indent of a line, so a nested item stays nested', () => {
    expect(run('  one‸', 'bullet')).toBe('  - one‸')
    expect(run('  - one‸', 'bullet')).toBe('  one‸')
    expect(run('\t- one‸', 'numbered')).toBe('\t1. one‸')
    expect(run('  one‸', 'quote')).toBe('>   one‸')
  })

  it('works on every line the selection touches, and no other', () => {
    expect(run('«Ash\nplain\nmap»', 'bullet')).toBe('- «Ash\n- plain\n- map»')
    expect(run('«Ash\nplain\nmap»', 'numbered')).toBe('1. «Ash\n2. plain\n3. map»')
    expect(run('one\nt«wo\nthr»ee\nfour', 'quote')).toBe('one\n> t«wo\n> thr»ee\nfour')
    expect(run('o«ne\ntw»o', 'h1')).toBe('# o«ne\n# tw»o')
    expect(run('one\n«two»\nthree', 'h2')).toBe('one\n## «two»\nthree')
  })

  it('leaves out the line a selection ends at the very start of', () => {
    expect(run('«one\n»two', 'quote')).toBe('> «one\n»two')
    expect(run('«one\ntwo\n»three', 'bullet')).toBe('- «one\n- two\n»three')
    expect(run('one«\n»two', 'quote')).toBe('> one«\n»two')
  })

  it('takes in the line a selection ends at the very end of, and not the next', () => {
    expect(run('«one»\ntwo', 'quote')).toBe('> «one»\ntwo')
    expect(run('«one\ntwo»\nthree', 'quote')).toBe('> «one\n> two»\nthree')
  })

  it('finds the line of a caret at the very start of a text that opens with a line break', () => {
    expect(run('‸\nAsh', 'h1')).toBe('# ‸\nAsh')
    expect(run('\n‸Ash', 'h1')).toBe('\n# ‸Ash')
    expect(run('\n\n‸', 'quote')).toBe('\n\n> ‸')
    expect(run('one‸\ntwo', 'h1')).toBe('# one‸\ntwo')
    expect(run('one\ntwo‸\n', 'h1')).toBe('one\n# two‸\n')
  })

  it('gives every touched line the mark when only some have it, and takes it off when all do', () => {
    expect(run('«- one\ntwo»', 'bullet')).toBe('- «one\n- two»')
    expect(run('«* one\ntwo»', 'bullet')).toBe('- «one\n- two»')
    expect(run('«- one\n* two»', 'bullet')).toBe('«one\ntwo»')
    expect(run('«# one\ntwo»', 'h1')).toBe('# «one\n# two»')
    expect(run('«## one\n# two»', 'h1')).toBe('# «one\n# two»')
    expect(run('«> one\ntwo»', 'quote')).toBe('> «one\n> two»')
    expect(run('«1. one\n2. two\nthree»', 'numbered')).toBe('1. «one\n2. two\n3. three»')
    expect(run('«1. one\n1. two»', 'numbered')).toBe('«one\ntwo»')
  })

  it('skips blank lines for headings, subtext and lists, but quotes them so the quote holds together', () => {
    expect(run('«one\n\ntwo»', 'numbered')).toBe('1. «one\n\n2. two»')
    expect(run('1. «one\n\n2. two»', 'numbered')).toBe('«one\n\ntwo»')
    expect(run('«one\n  \ntwo»', 'h2')).toBe('## «one\n  \n## two»')
    expect(run('«one\n\ntwo»', 'subtext')).toBe('-# «one\n\n-# two»')
    expect(run('«one\n\ntwo»', 'quote')).toBe('> «one\n> \n> two»')
    expect(run('> «one\n> \n> two»', 'quote')).toBe('«one\n\ntwo»')
    expect(run('«\none»', 'bullet')).toBe('«\n- one»')
    expect(run('«> \n> one»', 'bullet')).toBe('«> \n> - one»')
    expect(run('one\n«> \n> two»', 'bullet')).toBe('one\n«> \n> - two»')
  })

  it('marks blank lines when the selection touches nothing else', () => {
    expect(run('«\n\n»x', 'bullet')).toBe('- «\n- \n»x')
    expect(run('«  \n»x', 'h1')).toBe('«  # \n»x')
  })

  it('moves a caret that was inside a mark to the start of the words', () => {
    expect(run('#‸# one', 'h2')).toBe('‸one')
    expect(run('#‸# one', 'h1')).toBe('# ‸one')
    expect(run('‸## one', 'h1')).toBe('# ‸one')
    expect(run('‸- one', 'bullet')).toBe('‸one')
    expect(run('-‸ one', 'numbered')).toBe('1. ‸one')
    expect(run('‸> one', 'quote')).toBe('‸one')
    expect(run('>‸ one', 'quote')).toBe('‸one')
  })

  it('treats a carriage return as part of its line', () => {
    expect(run('one\r\ntwo‸', 'bullet')).toBe('one\r\n- two‸')
    expect(run('«one\r\ntwo»', 'quote')).toBe('> «one\r\n> two»')
  })

  it('makes the node each claims, read by the shared parser', () => {
    const heading = (marked, action) => nodesOf(apply(at(marked).text, at(marked).selection, action).text, 'heading')
    expect(heading('Ash‸', 'h1')).toMatchObject([{ level: 1 }])
    expect(heading('Ash‸', 'h2')).toMatchObject([{ level: 2 }])
    expect(heading('Ash‸', 'h3')).toMatchObject([{ level: 3 }])
    expect(plainText(heading('Ash‸', 'h3'))).toBe('Ash\n')

    const made = (marked, action) => apply(at(marked).text, at(marked).selection, action).text
    expect(blocks(made('Ash‸', 'subtext'))).toMatchObject([{ type: 'subtext' }])
    expect(blocks(made('«one\n\ntwo»', 'quote'))).toMatchObject([{ type: 'quote' }])
    expect(blocks(made('«one\ntwo»', 'bullet'))).toMatchObject([{ type: 'list', ordered: false, items: [{ marker: '-' }, { marker: '-' }] }])
    expect(blocks(made('«one\ntwo\nthree»', 'numbered'))).toMatchObject([{ type: 'list', ordered: true, items: [{ marker: '1.' }, { marker: '2.' }, { marker: '3.' }] }])
    expect(blocks(made('> - one‸', 'h1'))).toMatchObject([{ type: 'quote', children: [{ type: 'list', items: [{ children: [{ type: 'heading', level: 1 }] }] }] }])
  })
})

describe('apply: bold, italic, underline, strike, spoiler and code (wrapping actions)', () => {
  const MARKS = { bold: '**', italic: '*', underline: '__', strike: '~~', spoiler: '||', code: '`' }

  it('wraps the selection, and keeps it selected inside the marks', () => {
    for (const [action, mark] of Object.entries(MARKS)) {
      expect(run('Ash «plain» map', action)).toBe(`Ash ${mark}«plain»${mark} map`)
    }
  })

  it('unwraps a selection the marks lie just outside of', () => {
    for (const [action, mark] of Object.entries(MARKS)) {
      expect(run(`Ash ${mark}«plain»${mark} map`, action)).toBe('Ash «plain» map')
    }
  })

  it('unwraps a selection that takes in its own marks', () => {
    for (const [action, mark] of Object.entries(MARKS)) {
      expect(run(`Ash «${mark}plain${mark}» map`, action)).toBe('Ash «plain» map')
    }
  })

  it('puts the pair in with the caret between them when nothing is selected, and takes an empty pair out again', () => {
    for (const [action, mark] of Object.entries(MARKS)) {
      expect(run('Ash ‸', action)).toBe(`Ash ${mark}‸${mark}`)
      expect(run(`Ash ${mark}‸${mark}`, action)).toBe('Ash ‸')
      expect(run('‸', action)).toBe(`${mark}‸${mark}`)
      expect(run('a‸b', action)).toBe(`a${mark}‸${mark}b`)
    }
  })

  it('leaves the white space at either end of the selection outside the marks', () => {
    expect(run('Ash« plain »map', 'bold')).toBe('Ash **«plain»** map')
    expect(run('Ash«  plain»', 'italic')).toBe('Ash  *«plain»*')
    expect(run('«plain\t»map', 'strike')).toBe('~~«plain»~~\tmap')
    expect(run('« pl ain »', 'spoiler')).toBe(' ||«pl ain»|| ')
  })

  it('treats a selection of only white space as a caret at its end', () => {
    expect(run('Ash« »map', 'italic')).toBe('Ash *‸*map')
    expect(run('Ash«  »', 'bold')).toBe('Ash  **‸**')
    expect(run('«\n\n»', 'bold')).toBe('\n\n**‸**')
  })

  it('tells bold and italic apart when the stars run together', () => {
    expect(run('**«x»**', 'italic')).toBe('***«x»***')
    expect(run('*«x»*', 'bold')).toBe('***«x»***')
    expect(run('***«x»***', 'italic')).toBe('**«x»**')
    expect(run('***«x»***', 'bold')).toBe('*«x»*')
    expect(run('*«x»*', 'italic')).toBe('«x»')
    expect(run('**«x»**', 'bold')).toBe('«x»')
    expect(run('**‸**', 'italic')).toBe('***‸***')
    expect(run('***‸***', 'bold')).toBe('*‸*')
    expect(run('***‸***', 'italic')).toBe('**‸**')
    expect(run('*‸*', 'bold')).toBe('***‸***')
  })

  it('reads marks inside the selection the same way', () => {
    expect(run('«**x**»', 'italic')).toBe('***«x»***')
    expect(run('«*x*»', 'bold')).toBe('***«x»***')
    expect(run('«***x***»', 'italic')).toBe('**«x»**')
    expect(run('«***x***»', 'bold')).toBe('*«x»*')
    expect(run('«****»', 'bold')).toBe('‸')
    expect(run('«**»', 'italic')).toBe('‸')
    expect(run('«***»', 'italic')).toBe('‸*')
    expect(run('«*x»', 'italic')).toBe('**«x»*')
    expect(run('«x*»', 'italic')).toBe('*«x»**')
    expect(run('a «****» b', 'bold')).toBe('a ‸ b')
    expect(run('ab «**» c', 'italic')).toBe('ab ‸ c')
  })

  it('unwraps the pairs of two marks, however many marks there are beyond them', () => {
    expect(run('~~~«x»~~~', 'strike')).toBe('~«x»~')
    expect(run('___«x»___', 'underline')).toBe('_«x»_')
    expect(run('_«x»_', 'underline')).toBe('___«x»___')
    expect(run('|«x»|', 'spoiler')).toBe('|||«x»|||')
    expect(run('~~«x»~', 'strike')).toBe('~~~~«x»~~~')
  })

  it('uses two backticks for code that has a backtick in it, and takes out as many as it finds', () => {
    expect(run('«a`b»', 'code')).toBe('``«a`b»``')
    expect(run('``«a`b»``', 'code')).toBe('«a`b»')
    expect(run('«``a`b``»', 'code')).toBe('«a`b»')
    expect(run('```«x»```', 'code')).toBe('«x»')
    expect(run('`‸`', 'code')).toBe('‸')
    expect(run('``‸``', 'code')).toBe('‸')
  })

  it('wraps each line of a selection over several, leaving blank lines alone', () => {
    expect(run('«one\ntwo»', 'bold')).toBe('**«one**\n**two»**')
    expect(run('«one\n\n  \ntwo»', 'italic')).toBe('*«one*\n\n  \n*two»*')
    expect(run('a«b\nc»d', 'strike')).toBe('a~~«b~~\n~~c»~~d')
    expect(run('**«one**\n**two»**', 'bold')).toBe('«one\ntwo»')
    expect(run('«**one**\n**two**»', 'bold')).toBe('«one\ntwo»')
  })

  it('wraps only the lines that are not wrapped yet, when some are', () => {
    expect(run('«**one**\ntwo»', 'bold')).toBe('**«one**\n**two»**')
    expect(run('**«one**\ntwo»', 'bold')).toBe('**«one**\n**two»**')
    expect(run('«one\n**two**»', 'bold')).toBe('**«one**\n**two»**')
    expect(run('«one\n**two»**', 'bold')).toBe('**«one**\n**two»**')
  })

  it('keeps a line\'s heading, quote or list mark outside the marks', () => {
    expect(run('«# Title»', 'bold')).toBe('# **«Title»**')
    expect(run('«> one\n> two»', 'italic')).toBe('> *«one*\n> *two»*')
    expect(run('«- one\n- two»', 'spoiler')).toBe('- ||«one||\n- ||two»||')
    expect(run('‸- one', 'bold')).toBe('- **‸**one')
    expect(run('#‸ Title', 'code')).toBe('# `‸`Title')
    expect(run('«# »Title', 'bold')).toBe('# **‸**Title')
  })

  it('fences a selection over several lines for code, taking in the whole of each line', () => {
    expect(run('«one\ntwo»', 'code')).toBe('```\n«one\ntwo»\n```')
    expect(run('a«b\nc»d', 'code')).toBe('```\n«ab\ncd»\n```')
    expect(run('before\n«one\ntwo»\nafter', 'code')).toBe('before\n```\n«one\ntwo»\n```\nafter')
    expect(run('«\n one\ntwo \n»', 'code')).toBe('\n```\n« one\ntwo »\n```\n')
    expect(run('```\n«one\ntwo»\nb', 'code')).toBe('```\n```\n«one\ntwo»\n```\nb')
    expect(run('a\n«one\ntwo»\n```', 'code')).toBe('a\n```\n«one\ntwo»\n```\n```')
    expect(run('«```\none\ntwo»', 'code')).toBe('```\n«```\none\ntwo»\n```')
    expect(run('«one\ntwo\n```»', 'code')).toBe('```\n«one\ntwo\n```»\n```')
  })

  it('reads a fence line as the parser does: three backticks at the start, and a language of word characters, + or -', () => {
    for (const lang of ['', 'js', 'c++', 'objective-c', 'x_1']) {
      expect(run(`\`\`\`${lang}\n«one\ntwo»\n\`\`\``, 'code')).toBe('«one\ntwo»')
    }
    for (const above of ['a```', '``` x', '````', '```js!', ' ```', '``']) {
      expect(run(`${above}\n«one\ntwo»\n\`\`\``, 'code')).toBe(`${above}\n\`\`\`\n«one\ntwo»\n\`\`\`\n\`\`\``)
    }
    expect(run('«a```\none\n```»', 'code')).toBe('```\n«a```\none\n```»\n```')
    expect(run('«```\none\n```x»', 'code')).toBe('```\n«```\none\n```x»\n```')
  })

  it('takes a selection that ends with its line break as one line, which is inline code', () => {
    expect(run('«one\n»two', 'code')).toBe('`«one»`\ntwo')
  })

  it('takes the fence away from lines it is just outside of', () => {
    expect(run('```\n«one\ntwo»\n```', 'code')).toBe('«one\ntwo»')
    expect(run('```js\n«one\ntwo»\n```', 'code')).toBe('«one\ntwo»')
    expect(run('x\n```\no«ne\ntw»o\n```\ny', 'code')).toBe('x\n«one\ntwo»\ny')
    expect(run('```\n«one\ntwo»\n```\n```', 'code')).toBe('«one\ntwo»\n```')
  })

  it('takes the fence away from a selection that takes it in', () => {
    expect(run('«```\none\ntwo\n```»', 'code')).toBe('«one\ntwo»')
    expect(run('«```py\none\n```»', 'code')).toBe('«one»')
    expect(run('x\n«```\none\n```»\ny', 'code')).toBe('x\n«one»\ny')
    expect(run('«```\n\n```»', 'code')).toBe('‸')
    expect(run('«```\n```»', 'code')).toBe('‸')
    expect(run('x\n«```\n```»\ny', 'code')).toBe('x\n‸\ny')
  })

  it('makes the node each claims, read by the shared parser', () => {
    const made = (marked, action) => apply(at(marked).text, at(marked).selection, action).text
    const TYPES = { bold: 'strong', italic: 'em', underline: 'underline', strike: 'strike', spoiler: 'spoiler' }
    for (const [action, type] of Object.entries(TYPES)) {
      const [node] = nodesOf(made('Ash «plain» map', action), type)
      expect(plainText(node.children)).toBe('plain')
    }
    expect(nodesOf(made('Ash «plain» map', 'code'), 'code')).toMatchObject([{ text: 'plain' }])
    expect(nodesOf(made('«a`b»', 'code'), 'code')).toMatchObject([{ text: 'a`b' }])
    expect(blocks(made('«one\ntwo»', 'code'))).toMatchObject([{ type: 'codeblock', text: 'one\ntwo' }])

    const both = made(made('«x»', 'italic').replace('*x*', '*«x»*'), 'bold')
    expect(both).toBe('***x***')
    expect(blocks(both)).toMatchObject([{ type: 'line', children: [{ type: 'strong', children: [{ type: 'em' }] }] }])

    const lines = blocks(made('«one\ntwo»', 'spoiler'))
    expect(lines.flatMap((line) => line.children.map((node) => node.type))).toEqual(['spoiler', 'spoiler'])
    expect(nodesOf(made('«# Title»', 'bold'), 'heading')).toMatchObject([{ level: 1, children: [{ type: 'strong' }] }])
  })
})

describe('apply: link, image, table, rule, mention and emoji (inserts)', () => {
  it('makes the selection the text of a link, and selects the address to type over', () => {
    expect(run('see «the map» now', 'link')).toBe('see [the map](«https://») now')
    expect(run('see« the map »now', 'link')).toBe('see [the map](«https://») now')
  })

  it('makes a selected address the address of a link, and selects its text to type over', () => {
    expect(run('see «https://example.org/map» now', 'link')).toBe('see [«link text»](https://example.org/map) now')
    expect(run('«http://example.org»', 'link')).toBe('[«link text»](http://example.org)')
    // Not one address, so it is the text.
    expect(run('«https://example.org/a b»', 'link')).toBe('[https://example.org/a b](«https://»)')
    for (const odd of ['(', ')', '<', '>', '\t']) {
      expect(run(`«https://example.org/a${odd}b»`, 'link')).toBe(`[https://example.org/a${odd}b](«https://»)`)
    }
    expect(run('«ftp://example.org»', 'link')).toBe('[ftp://example.org](«https://»)')
    expect(run('«https://»', 'link')).toBe('[https://](«https://»)')
    expect(run('«see https://example.org»', 'link')).toBe('[see https://example.org](«https://»)')
  })

  it('puts a link with text to type over at the caret, or after a selection no link text can be', () => {
    expect(run('see ‸', 'link')).toBe('see [«link text»](https://)')
    expect(run('«a\nb»', 'link')).toBe('a\nb[«link text»](https://)')
    expect(run('«a [b]»', 'link')).toBe('a [b][«link text»](https://)')
    expect(run('«a]b»', 'link')).toBe('a]b[«link text»](https://)')
    expect(run('«a[b»', 'link')).toBe('a[b[«link text»](https://)')
    expect(run('« »', 'link')).toBe(' [«link text»](https://)')
  })

  it('makes a link once an address is typed over the selection', () => {
    const { text, selection } = apply('see the map', { start: 4, end: 11 }, 'link')
    const typed = text.slice(0, selection.start) + 'https://example.org/map' + text.slice(selection.end)
    expect(nodesOf(typed, 'link')).toMatchObject([{ href: 'https://example.org/map', children: [{ type: 'text', value: 'the map' }] }])
    const url = apply('https://example.org/map', { start: 0, end: 23 }, 'link')
    expect(nodesOf(url.text, 'link')).toMatchObject([{ href: 'https://example.org/map', children: [{ type: 'text', value: 'link text' }] }])
  })

  const image = (marked, name, n) => show(apply(at(marked).text, at(marked).selection, { type: 'image', name, n }))

  it('puts an image on a line of its own, the caret after it', () => {
    expect(image('‸', 'Ash plain map', 1)).toBe('![Ash plain map](upload:1)‸')
    expect(image('Ash‸ plain', 'map.png', 2)).toBe('Ash\n![map.png](upload:2)‸\n plain')
    expect(image('one\n‸two', 'map.png', 3)).toBe('one\n![map.png](upload:3)‸\ntwo')
    expect(image('one‸\ntwo', 'map.png', 4)).toBe('one\n![map.png](upload:4)‸\ntwo')
    expect(image('one\n‸', 'map.png', 10)).toBe('one\n![map.png](upload:10)‸')
    expect(image('‸one', 'map.png', 5)).toBe('![map.png](upload:5)‸\none')
    expect(image('one‸', 'map.png', 6)).toBe('one\n![map.png](upload:6)‸')
  })

  it('puts an image after the selection, keeping the selected text', () => {
    expect(image('a«b»c', 'map.png', 3)).toBe('ab\n![map.png](upload:3)‸\nc')
  })

  it('takes out of an image\'s name what would end its text, and folds its white space', () => {
    expect(image('‸', 'map [v2]\r\n final.png', 1)).toBe('![map v2 final.png](upload:1)‸')
    expect(image('‸', '  \t[]  ', 1)).toBe('![](upload:1)‸')
    expect(image('‸', '', 1)).toBe('![](upload:1)‸')
    expect(image('‸', 'a\u2028b', 1)).toBe('![a b](upload:1)‸')
    expect(image('‸', ' a ', 1)).toBe('![a](upload:1)‸')
    const { text } = apply('', { start: 0, end: 0 }, { type: 'image', name: 'map [v2]\n.png', n: 7 })
    expect(nodesOf(text, 'image')).toMatchObject([{ alt: 'map v2 .png', ref: 7 }])
  })

  it('refuses an image that is not upload 1 to 10, or has no name', () => {
    for (const n of [0, 11, -1, 1.5, NaN, Infinity]) {
      expect(() => apply('', { start: 0, end: 0 }, { type: 'image', name: 'a', n })).toThrow(n === 0 || n === 11 || n === -1 ? RangeError : TypeError)
    }
    for (const n of ['1', null, undefined, 1n]) {
      expect(() => apply('', { start: 0, end: 0 }, { type: 'image', name: 'a', n })).toThrow(TypeError)
    }
    for (const name of [null, undefined, 3, ['a']]) {
      expect(() => apply('', { start: 0, end: 0 }, { type: 'image', name, n: 1 })).toThrow('an image needs its name')
    }
    expect(() => apply('', { start: 0, end: 0 }, { type: 'image', name: 'a', n: 1 })).not.toThrow()
    expect(() => apply('', { start: 0, end: 0 }, { type: 'image', name: 'a', n: 10 })).not.toThrow()
  })

  it('puts a table on lines of its own, its first heading selected to type over', () => {
    expect(run('‸', 'table')).toBe('| «Column» | Column |\n| --- | --- |\n| Cell | Cell |')
    expect(run('one‸', 'table')).toBe('one\n| «Column» | Column |\n| --- | --- |\n| Cell | Cell |')
    expect(run('‸one', 'table')).toBe('| «Column» | Column |\n| --- | --- |\n| Cell | Cell |\none')
    const [table] = nodesOf(apply('', { start: 0, end: 0 }, 'table').text, 'table')
    expect(table.head.map((cell) => plainText(cell))).toEqual(['Column', 'Column'])
    expect(table.rows.map((row) => row.map((cell) => plainText(cell)))).toEqual([['Cell', 'Cell']])
  })

  it('puts a rule on a line of its own, the caret after it', () => {
    expect(run('‸', 'rule')).toBe('---‸')
    expect(run('one‸', 'rule')).toBe('one\n---‸')
    expect(run('one‸ two', 'rule')).toBe('one\n---‸\n two')
    expect(run('«one»', 'rule')).toBe('one\n---‸')
    const { text } = apply('one', { start: 3, end: 3 }, 'rule')
    expect(blocks(text)).toMatchObject([{ type: 'line' }, { type: 'divider' }])
  })

  const insert = (marked, action) => show(apply(at(marked).text, at(marked).selection, action))

  it('puts a mention where the caret is, or in place of the selection, the caret after it', () => {
    expect(insert('hi ‸', { type: 'mention', id: MEMBER })).toBe(`hi <@${MEMBER}>‸`)
    expect(insert('hi «Ixen»!', { type: 'mention', id: MEMBER })).toBe(`hi <@${MEMBER}>‸!`)
    expect(nodesOf(apply('hi ', { start: 3, end: 3 }, { type: 'mention', id: MEMBER }).text, 'mention')).toMatchObject([{ kind: 'user', id: MEMBER }])
  })

  it('refuses a mention of anything but a member id, written as a string', () => {
    for (const id of ['1234567890123456', '123456789012345678901', 'abc', '', ` ${MEMBER}`, `${MEMBER}\n`, `<@${MEMBER}>`]) {
      expect(() => apply('', { start: 0, end: 0 }, { type: 'mention', id })).toThrow(RangeError)
    }
    for (const id of [200000000000000400, null, undefined, [MEMBER]]) {
      expect(() => apply('', { start: 0, end: 0 }, { type: 'mention', id })).toThrow(TypeError)
    }
    expect(() => apply('', { start: 0, end: 0 }, { type: 'mention', id: '12345678901234567' })).not.toThrow()
    expect(() => apply('', { start: 0, end: 0 }, { type: 'mention', id: '12345678901234567890' })).not.toThrow()
  })

  it('puts an emoji where the caret is, or in place of the selection, the caret after it', () => {
    expect(insert('hi ‸', { type: 'emoji', text: '😀' })).toBe('hi 😀‸')
    expect(insert('hi «there»!', { type: 'emoji', text: '😀' })).toBe('hi 😀‸!')
    const custom = `<:salamander:${EMOJI}>`
    expect(insert('‸', { type: 'emoji', text: custom })).toBe(`${custom}‸`)
    expect(nodesOf(apply('', { start: 0, end: 0 }, { type: 'emoji', text: custom }).text, 'emoji')).toMatchObject([{ name: 'salamander', id: EMOJI }])
  })

  it('refuses an emoji that is no text, or more than one line', () => {
    for (const text of ['', '\n', 'a\nb', 'a\r']) {
      expect(() => apply('', { start: 0, end: 0 }, { type: 'emoji', text })).toThrow(RangeError)
    }
    for (const text of [null, undefined, 5, ['😀']]) {
      expect(() => apply('', { start: 0, end: 0 }, { type: 'emoji', text })).toThrow('an emoji needs its text')
    }
  })
})

// --- properties ---

const UNITS = ['a', 'b', 'Z', '1', '9', ' ', '\t', '\n', '\r', '*', '_', '~', '|', '`', '#', '-', '>', '.', '[', ']', '(', ')', '!', ':', '/', '😀', 'é']
const anyText = fc.string({ unit: fc.constantFrom(...UNITS), maxLength: 60 })
const withSelection = (text) => fc.tuple(fc.nat(text.length), fc.nat(text.length)).map(([a, b]) => ({ text, selection: { start: Math.min(a, b), end: Math.max(a, b) } }))
const anyAction = fc.oneof(
  fc.constantFrom(...ACTIONS.filter((name) => !['image', 'mention', 'emoji'].includes(name))),
  fc.record({ type: fc.constant('image'), name: fc.string({ maxLength: 12 }), n: fc.integer({ min: 1, max: 10 }) }),
  fc.record({ type: fc.constant('mention'), id: fc.stringMatching(/^\d{17,20}$/) }),
  fc.record({ type: fc.constant('emoji'), text: fc.constantFrom('😀', '👍🏽', `<:salamander:${EMOJI}>`, `<a:flame:${EMOJI}>`) }),
)

describe('apply: properties', () => {
  it('always gives back a text and a selection inside it, start first', () => {
    fc.assert(
      fc.property(anyText.chain(withSelection), anyAction, ({ text, selection }, action) => {
        const out = apply(text, selection, action)
        expect(Object.keys(out).sort()).toEqual(['selection', 'text'])
        expect(typeof out.text).toBe('string')
        expect(Object.keys(out.selection).sort()).toEqual(['end', 'start'])
        expect(Number.isInteger(out.selection.start)).toBe(true)
        expect(Number.isInteger(out.selection.end)).toBe(true)
        expect(out.selection.start).toBeGreaterThanOrEqual(0)
        expect(out.selection.start).toBeLessThanOrEqual(out.selection.end)
        expect(out.selection.end).toBeLessThanOrEqual(out.text.length)
        // What comes back can be given back.
        expect(() => apply(out.text, out.selection, action)).not.toThrow()
      }),
      { numRuns: 1500 },
    )
  })

  it('never loses the text round the selection when it inserts', () => {
    fc.assert(
      fc.property(anyText.chain(withSelection), anyAction, ({ text, selection }, action) => {
        const type = typeof action === 'string' ? action : action.type
        const out = apply(text, selection, action)
        if (type === 'mention' || type === 'emoji') {
          expect(out.text.startsWith(text.slice(0, selection.start))).toBe(true)
          expect(out.text.endsWith(text.slice(selection.end))).toBe(true)
          expect(out.text.length).toBeGreaterThan(text.length - (selection.end - selection.start))
        }
        if (type === 'image' || type === 'table' || type === 'rule') {
          expect(out.text.startsWith(text.slice(0, selection.end))).toBe(true)
          expect(out.text.endsWith(text.slice(selection.end))).toBe(true)
          expect(out.text.length).toBeGreaterThan(text.length)
        }
      }),
      { numRuns: 800 },
    )
  })

  // A line built from its marks, the way the composer reads one: a quote, an indent, a list mark, a heading or subtext
  // mark, then the words. The words have no mark of their own at their start.
  const WORD_UNITS = ['a', 'b', 'Z', '1', ' ', '*', '_', '#', '-', '>', '.', '`', '|', '!']
  const words = fc
    .string({ unit: fc.constantFrom(...WORD_UNITS), maxLength: 10 })
    .filter((w) => !/^[ \t]/.test(w) && !/^(>|[-*] |\d+\. |#{1,6} |-# )/.test(w) && !/^[-*]$/.test(w))
  const lineArb = fc.record({
    quote: fc.constantFrom('', '> '),
    indent: fc.constantFrom('', '  ', '\t'),
    list: fc.constantFrom('', '- ', '* ', '1. ', '12. ', '-   '),
    head: fc.constantFrom('', '# ', '## ', '### ', '#### ', '-# ', '#  '),
    words,
  })
  const compose = (l) => l.quote + l.indent + l.list + l.head + l.words
  const LAYER = { quote: 'quote', bullet: 'list', numbered: 'list', h1: 'head', h2: 'head', h3: 'head', subtext: 'head' }
  const KIND = {
    quote: (l) => l.quote !== '',
    bullet: (l) => /^[-*]/.test(l.list),
    numbered: (l) => /^\d/.test(l.list),
    h1: (l) => /^# /.test(l.head),
    h2: (l) => /^## /.test(l.head),
    h3: (l) => /^### /.test(l.head),
    subtext: (l) => l.head === '-# ',
  }
  const canonical = (action, k) => ({ quote: '> ', bullet: '- ', numbered: `${k + 1}. `, h1: '# ', h2: '## ', h3: '### ', subtext: '-# ' })[action]

  it('changes only the one mark of each line the action is for, the way a person expects', () => {
    const lines = fc.array(lineArb, { minLength: 1, maxLength: 6 })
    const pick = lines.chain((ls) => fc.tuple(fc.constant(ls), fc.nat(ls.length - 1), fc.nat(ls.length - 1), fc.constantFrom(...Object.keys(LAYER))))
    fc.assert(
      fc.property(pick, ([ls, a, b, action]) => {
        const first = Math.min(a, b)
        const last = Math.max(a, b)
        const texts = ls.map(compose)
        const text = texts.join('\n')
        const lineStart = (i) => texts.slice(0, i).reduce((n, t) => n + t.length + 1, 0)
        // From the start of the first line to the end of the last.
        const selection = { start: lineStart(first), end: lineStart(last) + texts[last].length }
        const out = apply(text, selection, action)
        const outLines = out.text.split('\n')
        expect(outLines).toHaveLength(ls.length)

        // A selection that ends at the very start of a line does not touch it, and one that ends on an empty line after the first
        // ends at its start.
        const reached = last > first && texts[last] === '' ? last - 1 : last
        const touched = ls.map((_, i) => i).filter((i) => i >= first && i <= reached)
        const blank = (i) => (ls[i].indent + ls[i].list + ls[i].head + ls[i].words).trim() === ''
        const written = touched.filter((i) => !blank(i))
        const acted = action === 'quote' || written.length === 0 ? touched : written
        const off = acted.every((i) => KIND[action](ls[i]))
        const layer = LAYER[action]
        ls.forEach((l, i) => {
          const k = acted.indexOf(i)
          const expected = k === -1 ? compose(l) : compose({ ...l, [layer]: off ? '' : canonical(action, k) })
          expect(outLines[i]).toBe(expected)
        })
      }),
      { numRuns: 1500 },
    )
  })

  it('leaves alone an empty last line that a selection ends at the start of (a seed of the property above)', () => {
    const text = '  -   one\n> -# two\n\n> three'
    const end = '  -   one\n> -# two\n'.length
    expect(apply(text, { start: 0, end }, 'quote').text).toBe('>   -   one\n> -# two\n\n> three')
    expect(apply(text, { start: 0, end: end - 1 }, 'quote').text).toBe('>   -   one\n> -# two\n\n> three')
    expect(apply('one\n\ntwo', { start: 0, end: 5 }, 'quote').text).toBe('> one\n> \ntwo')
  })

  it('gives back the text a line action was pressed on when it is pressed again, on lines with no marks', () => {
    const clean = fc.array(fc.record({ indent: fc.constantFrom('', '  '), words }), { minLength: 1, maxLength: 6 })
    fc.assert(
      fc.property(clean.map((ls) => ls.map((l) => l.indent + l.words).join('\n')).chain(withSelection), fc.constantFrom(...Object.keys(LAYER)), ({ text, selection }, action) => {
        const once = apply(text, selection, action)
        const twice = apply(once.text, once.selection, action)
        expect(twice.text).toBe(text)
      }),
      { numRuns: 1500 },
    )
  })

  const MARK = { bold: '**', italic: '*', underline: '__', strike: '~~', spoiler: '||', code: '`' }
  const plain = (opts) => fc.string({ unit: fc.constantFrom('a', 'b', 'Z', '1', ' ', ',', '!', '?', '(', ')', "'", ':', 'é'), ...opts })
  const core = plain({ minLength: 1, maxLength: 12 }).filter((s) => s.trim() === s && s !== '')
  const spaces = fc.string({ unit: fc.constantFrom(' ', '\t'), maxLength: 3 })

  it('wraps a selection on one line with its marks round it, keeps it selected, and unwraps it again', () => {
    const before = plain({ maxLength: 10 })
    const after = plain({ maxLength: 10 })
    fc.assert(
      fc.property(before, spaces, core, spaces, after, fc.constantFrom(...Object.keys(MARK)), (b, lead, inner, trail, a, action) => {
        const text = b + lead + inner + trail + a
        const selection = { start: b.length, end: b.length + lead.length + inner.length + trail.length }
        const out = apply(text, selection, action)
        const mark = MARK[action]
        expect(out.text).toBe(b + lead + mark + inner + mark + trail + a)
        expect(out.text.slice(out.selection.start, out.selection.end)).toBe(inner)
        expect(out.selection.start).toBe(b.length + lead.length + mark.length)
        const back = apply(out.text, out.selection, action)
        expect(back.text).toBe(text)
        expect(back.text.slice(back.selection.start, back.selection.end)).toBe(inner)
      }),
      { numRuns: 1500 },
    )
  })

  it('fences lines for code and takes the fence away again', () => {
    const line = plain({ maxLength: 8 })
    fc.assert(
      fc.property(fc.array(line, { maxLength: 3 }), fc.array(line, { minLength: 2, maxLength: 4 }), fc.array(line, { maxLength: 3 }), (above, picked, below) => {
        fc.pre(picked[0].trim() !== '' && picked.at(-1).trim() !== '')
        const text = [...above, ...picked, ...below].join('\n')
        const from = above.reduce((n, l) => n + l.length + 1, 0)
        const selection = { start: from, end: from + picked.join('\n').length }
        const out = apply(text, selection, 'code')
        expect(out.text).toBe([...above, '```', ...picked, '```', ...below].join('\n'))
        expect(out.text.slice(out.selection.start, out.selection.end)).toBe(picked.join('\n'))
        expect(apply(out.text, out.selection, 'code').text).toBe(text)
        expect(blocks(out.text).find((node) => node.type === 'codeblock')).toMatchObject({ text: picked.join('\n') })
      }),
      { numRuns: 800 },
    )
  })

  it('stays linear on a long text: a line action and a wrap over fifty thousand lines', () => {
    const text = 'a\n'.repeat(50_000) + 'a'
    const all = { start: 0, end: text.length }
    const listed = apply(text, all, 'bullet')
    expect(listed.text).toBe('- a\n'.repeat(50_000) + '- a')
    expect(apply(listed.text, listed.selection, 'bullet').text).toBe(text)
    const bold = apply(text, all, 'bold')
    expect(bold.text).toBe('**a**\n'.repeat(50_000) + '**a**')
    const stars = '*'.repeat(200_000)
    expect(apply(stars, { start: 100_000, end: 100_000 }, 'italic').text).toBe('*'.repeat(200_002))
    expect(apply(stars, { start: 0, end: stars.length }, 'code').text).toBe('`' + stars + '`')
  })
})

// --- drafts ---

/** A storage like the browser's, held in a Map, in the order things were put in. */
function memoryStorage(entries = []) {
  const map = new Map(entries)
  return {
    map,
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  }
}
/** A storage that refuses everything, as a full one or a private window's can. */
function refusingStorage() {
  const no = () => {
    throw new DOMException('refused', 'QuotaExceededError')
  }
  return {
    get length() {
      return no()
    },
    key: no,
    getItem: no,
    setItem: no,
    removeItem: no,
  }
}

describe('asQuote', () => {
  it('puts each line of the words behind a quote mark, and an empty line behind the bare mark', () => {
    expect(asQuote('One line')).toBe('> One line')
    expect(asQuote('First\nSecond')).toBe('> First\n> Second')
    expect(asQuote('Before\n\nAfter')).toBe('> Before\n>\n> After')
    expect(asQuote('Before\n   \nAfter')).toBe('> Before\n>\n> After')
  })

  it('reads a Windows or an old Mac line break as a line break', () => {
    expect(asQuote('One\r\nTwo\rThree')).toBe('> One\n> Two\n> Three')
  })

  it('leaves out the blank lines at either end, and the white space at the end of each line', () => {
    expect(asQuote('\n\n  Words  \t\n\n')).toBe('>   Words')
    expect(asQuote('\r\n\tIndented\r\n')).toBe('> \tIndented')
    expect(asQuote('a  \nb\t')).toBe('> a\n> b')
  })

  it('keeps the marks the words have, so that a quoted list or heading is still one inside the quote', () => {
    expect(asQuote('- item\n# Heading\n> quoted')).toBe('> - item\n> # Heading\n> > quoted')
    expect(asQuote('>>> all of it')).toBe('> >>> all of it')
  })

  it('keeps every character of the words, an emoji\'s two halves included', () => {
    expect(asQuote('Ash 😀 é')).toBe('> Ash 😀 é')
  })

  it('refuses words that are not text', () => {
    for (const value of [undefined, null, 1, ['a'], { text: 'a' }, new String('a')]) expect(() => asQuote(value), String(value)).toThrow(TypeError)
  })

  it('refuses words with nothing in them to quote', () => {
    for (const value of ['', ' ', '\n', '\r\n\t \n', ' \n']) expect(() => asQuote(value), JSON.stringify(value)).toThrow(RangeError)
  })

  it('is one quote, whatever the words, and its lines are the words\' own lines, trimmed', () => {
    fc.assert(
      fc.property(anyText.filter((t) => /\S/.test(t)), (words) => {
        const out = asQuote(words)
        const lines = out.split('\n')
        for (const line of lines) expect(line === '>' || line.startsWith('> ')).toBe(true)
        expect(lines[0]).not.toBe('>')
        expect(lines.at(-1)).not.toBe('>')
        const own = words.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd())
        const first = own.findIndex((line) => line !== '')
        const last = own.findLastIndex((line) => line !== '')
        expect(lines.map((line) => line.slice(2))).toEqual(own.slice(first, last + 1))
        const nodes = blocks(out)
        expect(nodes.map((node) => node.type)).toEqual(['quote'])
      }),
      { numRuns: 600 },
    )
  })
})

describe('insertBlock', () => {
  it('puts the block on lines of its own after the selection, and the caret on a new line under it', () => {
    expect(show(insertBlock('', { start: 0, end: 0 }, '> q'))).toBe('> q\n‸')
    expect(show(insertBlock('My words', { start: 8, end: 8 }, '> q'))).toBe('My words\n> q\n‸')
    expect(show(insertBlock('abcdef', { start: 3, end: 3 }, '> q'))).toBe('abc\n> q\n‸\ndef')
    expect(show(insertBlock('abc\ndef', { start: 3, end: 3 }, '> q'))).toBe('abc\n> q\n‸\ndef')
    expect(show(insertBlock('abc\ndef', { start: 4, end: 4 }, '> q'))).toBe('abc\n> q\n‸\ndef')
    expect(show(insertBlock('abc\n', { start: 4, end: 4 }, '> q\n> r'))).toBe('abc\n> q\n> r\n‸')
  })

  it('goes after the selection and keeps what was selected', () => {
    expect(show(insertBlock('one two three', { start: 4, end: 7 }, 'B'))).toBe('one two\nB\n‸\n three')
    expect(show(insertBlock('one\ntwo', { start: 0, end: 7 }, 'B'))).toBe('one\ntwo\nB\n‸')
  })

  it('refuses a text, a selection or a block of the wrong kind, or a selection outside the text', () => {
    expect(() => insertBlock(1, { start: 0, end: 0 }, 'B')).toThrow(TypeError)
    expect(() => insertBlock('ab', null, 'B')).toThrow(TypeError)
    expect(() => insertBlock('ab', { start: 0.5, end: 1 }, 'B')).toThrow(TypeError)
    expect(() => insertBlock('ab', { start: 2, end: 1 }, 'B')).toThrow(RangeError)
    expect(() => insertBlock('ab', { start: 0, end: 3 }, 'B')).toThrow(RangeError)
    expect(() => insertBlock('ab', { start: -1, end: 0 }, 'B')).toThrow(RangeError)
    for (const value of [undefined, null, 1, ['B'], new String('B')]) expect(() => insertBlock('ab', { start: 0, end: 0 }, value)).toThrow(TypeError)
  })

  it('refuses a block with nothing in it', () => {
    for (const value of ['', ' ', '\n\n', '\t\r\n']) expect(() => insertBlock('ab', { start: 0, end: 0 }, value), JSON.stringify(value)).toThrow(RangeError)
  })

  it('never loses the text, and the block always stands on lines of its own with the caret after it', () => {
    fc.assert(
      fc.property(anyText.chain(withSelection), anyText.filter((t) => /\S/.test(t)), ({ text, selection }, words) => {
        const quote = asQuote(words)
        const out = insertBlock(text, selection, quote)
        const at = selection.end
        const before = at === 0 || text[at - 1] === '\n' ? '' : '\n'
        const after = at === text.length || text[at] === '\n' ? '' : '\n'
        expect(out.text).toBe(text.slice(0, at) + before + quote + '\n' + after + text.slice(at))
        const caret = at + before.length + quote.length + 1
        expect(out.selection).toEqual({ start: caret, end: caret })
        expect(out.text[caret - 1]).toBe('\n')
        // What comes back can be given to the toolbar.
        expect(() => apply(out.text, out.selection, 'bold')).not.toThrow()
      }),
      { numRuns: 600 },
    )
  })
})

describe('draftKey', () => {
  it('names the key a draft is kept under: the post, then the message replied to or "new"', () => {
    expect(draftKey(POST, MESSAGE)).toBe(`lb-draft:${POST}:${MESSAGE}`)
    expect(draftKey(POST, null)).toBe(`lb-draft:${POST}:new`)
    expect(draftKey(POST)).toBe(`lb-draft:${POST}:new`)
    expect(draftKey(OTHER_POST, MESSAGE)).not.toBe(draftKey(POST, MESSAGE))
  })

  it('takes only ids written as strings', () => {
    for (const postId of [null, undefined, 200000000000000400, '', 'abc', '1234567890123456', ` ${POST}`, `${POST}:new`]) {
      expect(() => draftKey(postId, null)).toThrow(TypeError)
    }
    for (const replyTo of [200000000000000400, '', 'new', 'abc', `${MESSAGE}:x`, false, 0]) {
      expect(() => draftKey(POST, replyTo)).toThrow(TypeError)
    }
  })

  it('gives every post and reply a key of its own', () => {
    const id = fc.stringMatching(/^\d{17,20}$/)
    fc.assert(
      fc.property(id, fc.option(id), id, fc.option(id), (p1, r1, p2, r2) => {
        fc.pre(p1 !== p2 || r1 !== r2)
        expect(draftKey(p1, r1)).not.toBe(draftKey(p2, r2))
        expect(draftKey(p1, r1).startsWith('lb-draft:')).toBe(true)
      }),
    )
  })
})

describe('saveDraft, loadDraft and clearDraft', () => {
  it('keeps a draft for its post and reply, and gives it back', () => {
    const storage = memoryStorage()
    expect(saveDraft(storage, POST, MESSAGE, '## The Arridian Wastes')).toBe(true)
    expect(saveDraft(storage, POST, null, 'a new reply')).toBe(true)
    expect(storage.map.get(`lb-draft:${POST}:${MESSAGE}`)).toBe('## The Arridian Wastes')
    expect(loadDraft(storage, POST, MESSAGE)).toBe('## The Arridian Wastes')
    expect(loadDraft(storage, POST, null)).toBe('a new reply')
    expect(loadDraft(storage, POST)).toBe('a new reply')
    expect(loadDraft(storage, OTHER_POST, MESSAGE)).toBeNull()
  })

  it('keeps any text with something in it as it is', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        fc.pre(/\S/.test(text))
        const storage = memoryStorage()
        expect(saveDraft(storage, POST, MESSAGE, text)).toBe(true)
        expect(loadDraft(storage, POST, MESSAGE)).toBe(text)
      }),
    )
  })

  it('keeps no draft of an empty or blank text, and drops the one it had', () => {
    const storage = memoryStorage()
    saveDraft(storage, POST, MESSAGE, 'words')
    for (const text of ['', '   ', '\n\t\n', '\u00a0']) {
      saveDraft(storage, POST, MESSAGE, 'words')
      expect(saveDraft(storage, POST, MESSAGE, text)).toBe(true)
      expect(loadDraft(storage, POST, MESSAGE)).toBeNull()
      expect(storage.map.size).toBe(0)
    }
  })

  it('takes only text for a draft', () => {
    for (const text of [null, undefined, 3, ['a']]) {
      expect(() => saveDraft(memoryStorage(), POST, MESSAGE, text)).toThrow(TypeError)
    }
  })

  it('clears the one draft, and leaves the rest', () => {
    const storage = memoryStorage([['other', 'kept']])
    saveDraft(storage, POST, MESSAGE, 'one')
    saveDraft(storage, POST, null, 'two')
    clearDraft(storage, POST, MESSAGE)
    expect(loadDraft(storage, POST, MESSAGE)).toBeNull()
    expect(loadDraft(storage, POST, null)).toBe('two')
    expect(storage.map.get('other')).toBe('kept')
    clearDraft(storage, POST)
    expect(loadDraft(storage, POST, null)).toBeNull()
  })

  it('never throws when the storage refuses, or there is none', () => {
    for (const storage of [refusingStorage(), null, undefined, {}]) {
      expect(saveDraft(storage, POST, MESSAGE, 'words')).toBe(false)
      expect(saveDraft(storage, POST, MESSAGE, '')).toBe(false)
      expect(loadDraft(storage, POST, MESSAGE)).toBeNull()
      expect(clearDraft(storage, POST, MESSAGE)).toBeUndefined()
      expect(clearAllDrafts(storage)).toBeUndefined()
    }
  })

  it('gives back nothing for a stored value that is not text', () => {
    const storage = { getItem: () => 42 }
    expect(loadDraft(storage, POST, MESSAGE)).toBeNull()
    expect(loadDraft({ getItem: () => undefined }, POST, MESSAGE)).toBeNull()
    expect(loadDraft({ getItem: () => '' }, POST, MESSAGE)).toBe('')
  })

  it('still refuses bad ids, which are the caller\'s mistake and not the storage\'s', () => {
    expect(() => saveDraft(memoryStorage(), 'abc', null, 'x')).toThrow(TypeError)
    expect(() => loadDraft(memoryStorage(), POST, 'abc')).toThrow(TypeError)
    expect(() => clearDraft(memoryStorage(), 'abc')).toThrow(TypeError)
  })
})

describe('clearAllDrafts', () => {
  it('removes every draft and nothing else, however alike its key is', () => {
    const kept = {
      'lb-anchor:1': 'a place',
      'lb-draft': 'no colon',
      'LB-DRAFT:1:new': 'other case',
      'xlb-draft:1:new': 'prefix before',
      ' lb-draft:1:new': 'space before',
      'salamanders-discord-return-path': '/planner',
    }
    const storage = memoryStorage(Object.entries(kept))
    saveDraft(storage, POST, MESSAGE, 'one')
    saveDraft(storage, POST, null, 'two')
    saveDraft(storage, OTHER_POST, null, 'three')
    storage.setItem('lb-draft:', 'just the prefix')
    clearAllDrafts(storage)
    expect(Object.fromEntries(storage.map)).toEqual(kept)
  })

  it('removes a draft that is the only thing kept, and the first and the last of many', () => {
    const storage = memoryStorage()
    saveDraft(storage, POST, null, 'one')
    clearAllDrafts(storage)
    expect(storage.map.size).toBe(0)
    saveDraft(storage, POST, null, 'one')
    storage.setItem('between', 'kept')
    saveDraft(storage, OTHER_POST, null, 'two')
    clearAllDrafts(storage)
    expect([...storage.map.keys()]).toEqual(['between'])
  })

  it('works with a storage whose keys move as they go, like the browser\'s may', () => {
    // Taking a key out moves every later one down, so removing while counting up would skip one.
    const storage = memoryStorage([[draftKey(POST), 'a'], [draftKey(OTHER_POST), 'b'], [draftKey(POST, MESSAGE), 'c']])
    clearAllDrafts(storage)
    expect(storage.map.size).toBe(0)
  })

  it('removes the drafts it can when one of them will not go', () => {
    const storage = memoryStorage([[draftKey(POST), 'a'], [draftKey(OTHER_POST), 'b'], [draftKey(POST, MESSAGE), 'c']])
    const remove = storage.removeItem
    storage.removeItem = (key) => {
      if (key === draftKey(POST)) throw new DOMException('refused', 'SecurityError')
      remove(key)
    }
    clearAllDrafts(storage)
    expect([...storage.map.keys()]).toEqual([draftKey(POST)])
  })

  it('removes the drafts it can name when the storage names a key as nothing', () => {
    const storage = memoryStorage([[draftKey(POST), 'a'], ['kept', 'k'], [draftKey(OTHER_POST), 'b']])
    const key = storage.key
    storage.key = (i) => (i === 1 ? null : key(i))
    clearAllDrafts(storage)
    expect([...storage.map.keys()]).toEqual(['kept'])
  })
})

describe('draftStorage', () => {
  // The browser's own localStorage is put back after each test; each test puts its own in its place.
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  afterEach(() => {
    if (own) Object.defineProperty(globalThis, 'localStorage', own)
    else delete globalThis.localStorage
  })
  const stand = (get) => Object.defineProperty(globalThis, 'localStorage', { get, configurable: true })

  it('is the browser\'s localStorage, the very one', () => {
    const storage = memoryStorage([['kept', 'k']])
    stand(() => storage)
    expect(draftStorage()).toBe(storage)
  })

  it('is null where reading localStorage throws, as it does when a browser blocks storage', () => {
    stand(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(draftStorage()).toBeNull()
  })

  it('is null where there is no localStorage at all', () => {
    stand(() => undefined)
    expect(draftStorage()).toBeNull()
    stand(() => null)
    expect(draftStorage()).toBeNull()
  })

  it('gives the drafts somewhere that never makes them throw, whatever the browser does', () => {
    stand(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(saveDraft(draftStorage(), POST, null, 'kept?')).toBe(false)
    expect(loadDraft(draftStorage(), POST, null)).toBeNull()
    expect(() => clearAllDrafts(draftStorage())).not.toThrow()
  })
})
