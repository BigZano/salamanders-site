import { spawn, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { toDiscord } from './librariusForm.js'
import { parse } from './librariusMarkdown.js'
import { MAX_SOURCE, MENTION_CAP, Unfoldable, answerJob, automodMatcher, automodUnchecked, cleanName, createRegexRunner, killRunners, scanInWorker, scanPatterns, shownBy, spawnRegexWorker, translatePattern, typed, unmasked, validateReply } from './librariusSend.js'

// Every id, name, keyword, rule and link here is invented.
const U1 = '200000000000000421'
const U2 = '200000000000000422'
const U3 = '200000000000000423'
const ROLE_A = '200000000000000431'
const ROLE_B = '200000000000000432'
const FORUM = '200000000000000441'
const POST = '200000000000000442'
const REPLIED = '200000000000000443'
const JUMP = 'https://discord.com/channels/200000000000000403/200000000000000404/200000000000000409'

const rule = (over = {}) => ({
  id: '200000000000000451',
  name: 'Test Rule',
  enabled: true,
  trigger_type: 1,
  trigger_metadata: { keyword_filter: [], regex_patterns: [], allow_list: [] },
  exempt_roles: [],
  exempt_channels: [],
  actions: [{ type: 1 }],
  ...over,
})
const keywordRule = (keyword_filter, meta = {}, over = {}) =>
  rule({ trigger_metadata: { keyword_filter, regex_patterns: [], allow_list: [], ...meta }, ...over })
const mentionRule = (limit, over = {}) => rule({ trigger_type: 5, trigger_metadata: { mention_total_limit: limit }, ...over })
const quiet = { log: () => {} }
const matcher = (rules, who = {}) => automodMatcher(rules, { ...quiet, ...who })
const find = (keywords, text, meta, who) => matcher([keywordRule(keywords, meta)], who)(text)
const hit = (start, end, name = 'Test Rule') => ({ rule: name, start, end })
// What a call throws: the kind of error and the words it says, which are part of what the caller is told.
function thrown(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}
// What a promise rejects with: the kind of error and the words it says.
async function rejectsAs(promise, type, message) {
  let error = null
  try {
    await promise
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(type)
  expect(error.message).toBe(message)
}
const throwsAs = (fn, type, message) => {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(type)
  expect(error.message).toBe(message)
}

describe('automodMatcher: a keyword that is a whole word', () => {
  it('matches in any case and says where', () => {
    const m = matcher([keywordRule(['zorp'])])
    expect(m('zorp')).toEqual(hit(0, 4))
    expect(m('Say ZoRp now')).toEqual(hit(4, 8))
    expect(m('a\nzorp')).toEqual(hit(2, 6))
    expect(m('x\tZORP')).toEqual(hit(2, 6))
  })

  it('finds nothing in a text without it, or in an empty one', () => {
    const m = matcher([keywordRule(['zorp'])])
    expect(m('')).toBeNull()
    expect(m('nothing to see here')).toBeNull()
  })

  it('does not match inside a longer word', () => {
    const m = matcher([keywordRule(['zorp'])])
    for (const text of ['zorps', 'gzorp', 'zorpy', 'unzorp', 'zorpé', 'éZORP', 'ñzorp', 'zorpß', 'zorp𝐱', '𐐨zorp', 'zorp𐐨']) {
      expect(m(text), text).toBeNull()
    }
  })

  it('takes punctuation, digits, an underscore and symbols for the edge of a word', () => {
    const m = matcher([keywordRule(['zorp'])])
    for (const text of ['zorp.', '(zorp)', 'zorp!', '"zorp"', 'zorp2', '2zorp', 'a-zorp-b', 'zorp/x', 'zorp,zorp', 'zorp😀', '😀zorp', "zorp's"]) {
      expect(m(text), text).not.toBeNull()
    }
    expect(m('a-zorp-b')).toEqual(hit(2, 6))
    expect(m('x_zorp')).toEqual(hit(2, 6))
    expect(m('zorp_x')).toEqual(hit(0, 4))
    expect(m('😀zorp')).toEqual(hit(2, 6))
  })

  it('takes a letter of a script written without spaces for the edge of a word', () => {
    const m = matcher([keywordRule(['zorp'])])
    expect(m('你zorp你')).toEqual(hit(1, 5))
    expect(m('ひらzorpがな')).toEqual(hit(2, 6))
    expect(m('カタzorpカナ')).toEqual(hit(2, 6))
    expect(m('ไทยzorpไทย')).toEqual(hit(3, 7))
    expect(m('ລາວzorpລາວ')).toEqual(hit(3, 7))
    expect(m('ខ\u17d2ម\u17c2រzorpខ\u17d2ម\u17c2រ')).toEqual(hit(5, 9))
    expect(m('မ\u103cန\u103azorpမ\u103cန\u103a')).toEqual(hit(4, 8))
    expect(matcher([keywordRule(['坏'])])('你坏啊')).toEqual(hit(1, 2))
  })

  it('matches a phrase across any run of whitespace', () => {
    const m = matcher([keywordRule(['red cat'])])
    for (const text of ['red cat', 'red  cat', 'red\ncat', 'red\u00a0cat', 'red\tcat', 'RED \u3000 CAT']) {
      expect(m(text), text).not.toBeNull()
    }
    expect(m('a red  cat b')).toEqual(hit(2, 10))
    for (const text of ['redcat', 'red-cat', 'red, cat', 'red cats', 'bred cat']) expect(m(text), text).toBeNull()
  })

  it('ignores whitespace around the keyword it was given', () => {
    expect(find(['  zorp \n'], 'a zorp b')).toEqual(hit(2, 6))
    expect(find([' red  cat '], 'red cat')).toEqual(hit(0, 7))
  })

  it('reads a keyword that begins or ends with a mark that is not a letter', () => {
    expect(find(['!zorp'], 'a !zorp')).toEqual(hit(2, 7))
    expect(find(['420'], 'a 420 b')).toEqual(hit(2, 5))
    expect(find(['420'], 'a420')).toBeNull()
  })
})

describe('automodMatcher: what is written around or inside a keyword', () => {
  it('sees through the marks that a message takes out when it is shown', () => {
    const m = matcher([keywordRule(['zorp'])])
    expect(m('**zorp**')).toEqual(hit(2, 6))
    expect(m('zo**r**p')).toEqual(hit(0, 8))
    expect(m('z_o_r_p')).toEqual(hit(0, 7))
    expect(m('z~o~r~p')).toEqual(hit(0, 7))
    expect(m('z||o||rp')).toEqual(hit(0, 8))
    expect(m('z`o`rp')).toEqual(hit(0, 6))
    expect(m('z\\orp')).toEqual(hit(0, 5))
  })

  it('sees through characters that show as nothing', () => {
    const m = matcher([keywordRule(['zorp'])])
    expect(m('zo\u200brp')).toEqual(hit(0, 5))
    expect(m('z\u200do\u200crp')).toEqual(hit(0, 6))
    expect(m('z\u00adorp')).toEqual(hit(0, 5))
    expect(m('z\u0001orp')).toEqual(hit(0, 5))
    expect(m('z\ufeffo\u2060rp')).toEqual(hit(0, 6))
    expect(m('z\ud800orp')).toEqual(hit(0, 5))
    expect(m('z\udc00orp')).toEqual(hit(0, 5))
  })

  it('reads those characters as a gap between words as well', () => {
    expect(find(['foo bar'], 'foo\u200bbar')).toEqual(hit(0, 7))
    expect(find(['foo bar'], 'foo*bar')).toEqual(hit(0, 7))
    expect(find(['foo bar'], 'foo_bar')).toEqual(hit(0, 7))
    expect(find(['foo'], 'foo_bar')).toEqual(hit(0, 3))
    expect(find(['foo'], 'foo\u200bbar')).toEqual(hit(0, 3))
  })

  it('sees through combining marks', () => {
    const m = matcher([keywordRule(['zorp'])])
    expect(m('z\u0335o\u0335r\u0335p\u0335')).toEqual(hit(0, 7))
    expect(m('zörp')).toEqual(hit(0, 4))
    expect(m('zo\u0308rp')).toEqual(hit(0, 5))
    expect(find(['café'], 'CAFE\u0301')).toEqual(hit(0, 4))
    expect(find(['cafe'], 'a CAFÉ')).toEqual(hit(2, 6))
    expect(find(['café'], 'cafe')).toEqual(hit(0, 4))
  })

  it('folds width, ligatures and letter case the way a reader would', () => {
    expect(find(['zorp'], 'ｚｏｒｐ')).toEqual(hit(0, 4))
    expect(find(['flibber'], 'ﬂibber')).toEqual(hit(0, 6))
    expect(find(['strasse'], 'Straße')).toEqual(hit(0, 6))
    expect(find(['kiwi'], 'KIWI')).toEqual(hit(0, 4))
    expect(find(['σας'], 'ΣΑΣ')).toEqual(hit(0, 3))
    expect(find(['σσ'], 'ς ς')).toBeNull()
    expect(find(['ǆ'], 'Ǆ')).toEqual(hit(0, 1))
    expect(find(['i'], 'İ')).toEqual(hit(0, 1))
  })

  it('reads a keyword written with those marks as it is read', () => {
    expect(find(['zo_rp'], 'zorp')).toEqual(hit(0, 4))
    expect(find(['zo_rp'], 'zo rp')).toEqual(hit(0, 5))
    expect(find(['zo_rp'], 'zo_rp')).toEqual(hit(0, 5))
    expect(find(['ZÖRP'], 'zorp')).toEqual(hit(0, 4))
    expect(find(['\u200b'], 'anything')).toBeNull()
  })

  it('handles letters beyond the first plane', () => {
    expect(find(['😀zorp'], 'x 😀ZORP y')).toEqual(hit(2, 8))
    expect(find(['zorp'], 'z😀')).toBeNull()
    expect(find(['*zorp'], '𐐨zorp')).toEqual(hit(0, 6))
    expect(find(['zorp*'], 'zorp𐐨')).toEqual(hit(0, 6))
    expect(find(['*zorp'], '😀𐐨zorp')).toEqual(hit(2, 8))
    expect(find(['zorp'], '𐐨 zorp')).toEqual(hit(3, 7))
  })

  it('does not mistake a lone half of a pair for a letter, or let it hide a word', () => {
    expect(find(['zorp'], 'zorp\ud83d')).toEqual(hit(0, 4))
    expect(find(['zorp'], '\ude00zorp')).toEqual(hit(1, 5))
  })
})

describe('automodMatcher: the wildcards', () => {
  const ends = ['catch', 'Catapult', 'CATTLE', 'wildcat', 'copyCat', 'location', 'eduCATion']

  it('a * at the end is a prefix: the word must start with the keyword', () => {
    const m = matcher([keywordRule(['cat*'])])
    for (const text of ['catch', 'Catapult', 'CATTLE', 'cat']) expect(m(text), text).toEqual(hit(0, text.length))
    for (const text of ['educat', 'bobcat', 'scat', 'location', 'wildcat']) expect(m(text), text).toBeNull()
    expect(m('see catalog now')).toEqual(hit(4, 11))
    expect(m('cat!')).toEqual(hit(0, 3))
    expect(m('cat2x')).toEqual(hit(0, 3))
  })

  it('a * at the start is a suffix: the word must end with the keyword', () => {
    const m = matcher([keywordRule(['*cat'])])
    for (const text of ['wildcat', 'copyCat', 'cat']) expect(m(text), text).toEqual(hit(0, text.length))
    for (const text of ['catch', 'cats', 'location']) expect(m(text), text).toBeNull()
    expect(m('a wildcat b')).toEqual(hit(2, 9))
    expect(m('wild2cat')).toEqual(hit(5, 8))
    expect(m('educat!x')).toEqual(hit(0, 6))
  })

  it('a * at both ends matches anywhere in a word, and shows the whole word', () => {
    const m = matcher([keywordRule(['*cat*'])])
    for (const text of ends) expect(m(text), text).toEqual(hit(0, text.length))
    expect(m('a location b')).toEqual(hit(2, 10))
    expect(m('x2catalog3y')).toEqual(hit(2, 9))
    expect(m('dog')).toBeNull()
  })

  it('takes any number of stars at an end for one', () => {
    for (const keyword of ['**cat**', '*cat**', '***cat*']) {
      expect(find([keyword], 'location'), keyword).toEqual(hit(0, 8))
    }
    expect(find(['cat**'], 'bobcat')).toBeNull()
    expect(find(['**cat'], 'catch')).toBeNull()
  })

  it('has no keyword in one made of stars or of nothing, and skips what is no text', () => {
    for (const keyword of ['*', '**', '', ' ', '*  *', '*\u200b*']) {
      expect(find([keyword], 'anything at all'), JSON.stringify(keyword)).toBeNull()
    }
    expect(find([null, 5, {}, undefined, [], 'zorp'], 'a zorp')).toEqual(hit(2, 6))
  })

  it('a * between two parts of a keyword stands for the letters between them, up to a space', () => {
    const m = matcher([keywordRule(['c*t'])])
    for (const text of ['cat', 'cut', 'ct', 'coat', 'c-t', 'c.t']) expect(m(text), text).not.toBeNull()
    expect(m('a coat b')).toEqual(hit(2, 6))
    for (const text of ['c at', 'cats', 'xcat', 'c a t', 'ca']) expect(m(text), text).toBeNull()
  })

  it('lets that run be 60 characters, and no more', () => {
    const m = matcher([keywordRule(['c*t'])])
    expect(m(`c${'x'.repeat(60)}t`)).toEqual(hit(0, 62))
    expect(m(`c${'x'.repeat(61)}t`)).toBeNull()
    expect(m(`c${'x'.repeat(59)}t`)).toEqual(hit(0, 61))
  })

  it('takes the first part where it can be followed by the rest, and the last where its edge holds', () => {
    const m = matcher([keywordRule(['a*b'])])
    expect(m('axbxb')).toEqual(hit(0, 5))
    expect(m('axbx')).toBeNull()
    expect(m('a b')).toBeNull()
    expect(m('aab')).toEqual(hit(0, 3))
    expect(m('xa ab')).toEqual(hit(3, 5))
    expect(matcher([keywordRule(['a*b*c'])])('a1b2c')).toEqual(hit(0, 5))
    expect(matcher([keywordRule(['a*b*c'])])('a1 b2c')).toBeNull()
    expect(matcher([keywordRule(['a*b*c'])])('abbc!')).toEqual(hit(0, 4))
    expect(matcher([keywordRule(['a*b*c'])])('axxcxb')).toBeNull()
  })

  it('takes a later place of a middle part when the first one leads nowhere, so an early decoy hides no match', () => {
    // The `b` at 1 is 78 from the `c`, too far; the `b` at 30 is 29 from the `a` and 49 from the `c`.
    const text = `ab${'x'.repeat(28)}b${'x'.repeat(49)}c`
    for (const keyword of ['a*b*c', '*a*b*c*', 'a*b*c*', '*a*b*c']) {
      expect(find([keyword], text), keyword).toEqual(hit(0, 81))
      expect(find([keyword], text.replace('ab', 'ax')), keyword).toEqual(hit(0, 81))
    }
    // A decoy for each of two middle parts, and one that is a space too far: the second `b` is past a space.
    expect(find(['a*b*c*d'], `ab${'x'.repeat(40)}bc${'x'.repeat(20)}c${'x'.repeat(50)}d`)).toEqual(hit(0, 116))
    expect(find(['a*b*c'], `ab${'x'.repeat(28)} b${'x'.repeat(49)}c`)).toBeNull()
    // The last part where its edge holds, after a decoy of the middle one: `c` at 80 is inside a word, the one at 82 ends it.
    expect(find(['a*b*c'], `ab${'x'.repeat(28)}b${'x'.repeat(49)}cxc`)).toEqual(hit(0, 83))
    // An allow entry is not: each of its middle parts is taken at its first place only, and a decoy there lets nothing by (see the allow list).
    expect(find(['*x*'], text, { allow_list: ['a*b*c'] })).toEqual(hit(0, 81))
    expect(find(['*x*'], text, { allow_list: ['a*b*cc'] })).toEqual(hit(0, 81))
  })

  it('finds a keyword of several parts over a word that holds its first part at every place and the rest of it nowhere, and further on', () => {
    const word = 'n'.repeat(11_000)
    expect(find(['*n*gg*r*'], word)).toBeNull()
    expect(find(['*n*gg*r*'], `${word}ggr`)).toEqual(hit(0, 11_003))
    expect(find(['*n*gg*r*'], `${word} ggr`)).toBeNull()
    expect(find(['*n*gg*r'], `${word}ggrx`)).toBeNull()
    expect(find(['*n*gg*r', 'zz'], `${word}ggr zz`)).toEqual(hit(0, 11_003))
    // A keyword that does not start a word is only found where one starts.
    expect(find(['n*gg'], `${word}gg ngg`)).toEqual(hit(11_003, 11_006))
    // The first part at the very end of the text, where nothing can follow it.
    expect(find(['a*b'], 'xa')).toBeNull()
    expect(find(['a*b', 'xa'], 'xa')).toEqual(hit(0, 2))
  })

  it('a middle * with a star at an end too', () => {
    expect(find(['*c*t*'], 'xx coats yy')).toEqual(hit(3, 8))
    expect(find(['c*t*'], 'coats')).toEqual(hit(0, 5))
    expect(find(['*c*t'], 'xcoat')).toEqual(hit(0, 5))
    expect(find(['*c*t'], 'xcoats')).toBeNull()
  })

  it('a middle * with a phrase part keeps the space of the phrase', () => {
    expect(find(['red* cat'], 'redd cat')).toEqual(hit(0, 8))
    expect(find(['red* cat'], 'red  cat')).toEqual(hit(0, 8))
    expect(find(['red* cat'], 'reddcat')).toBeNull()
    expect(find(['a*b c'], 'axb c')).toEqual(hit(0, 5))
    expect(find(['a*b c'], 'axb  c')).toEqual(hit(0, 6))
    expect(find(['a* *b'], 'a x b')).toBeNull()
  })

  it('a star between parts that are marks is the same star', () => {
    expect(find(['a*_*b'], 'axb')).toEqual(hit(0, 3))
    expect(find(['a**b'], 'axb')).toEqual(hit(0, 3))
  })
})

describe('automodMatcher: the allow list', () => {
  it('exempts a match that lies inside an allowed word', () => {
    const meta = { allow_list: ['zorper'] }
    expect(find(['*zorp*'], 'zorper', meta)).toBeNull()
    expect(find(['*zorp*'], 'ZORPER', meta)).toBeNull()
    expect(find(['*zorp*'], 'zorpest', meta)).toEqual(hit(0, 7))
    expect(find(['*zorp*'], 'zorp', meta)).toEqual(hit(0, 4))
  })

  it('goes on past an exempt match to the next one', () => {
    const meta = { allow_list: ['zorper'] }
    expect(find(['*zorp*'], 'zorper zorp', meta)).toEqual(hit(7, 11))
    expect(find(['*zorp*'], 'zorp zorper', meta)).toEqual(hit(0, 4))
    expect(find(['*zorp*'], 'zorper zorper zorper', meta)).toBeNull()
    expect(find(['*zorp*'], 'zorper zorper zorpy', meta)).toEqual(hit(14, 19))
  })

  it('takes wildcards, phrases and case like a keyword does', () => {
    expect(find(['*zorp*'], 'xzorpy', { allow_list: ['*zorpy'] })).toBeNull()
    expect(find(['*zorp*'], 'xzorpyz', { allow_list: ['*zorpy'] })).toEqual(hit(0, 7))
    expect(find(['*zorp*'], 'xzorpyz', { allow_list: ['*zorpy*'] })).toBeNull()
    expect(find(['*zorp*'], 'zorpish', { allow_list: ['zorp*'] })).toBeNull()
    expect(find(['zorp'], 'zorp farm', { allow_list: ['zorp farm'] })).toBeNull()
    expect(find(['zorp'], 'ZORP  FARM', { allow_list: ['Zorp Farm'] })).toBeNull()
    expect(find(['zorp'], 'zorp farms', { allow_list: ['zorp farm'] })).toEqual(hit(0, 4))
    expect(find(['zorp'], 'the zorp farm zorp', { allow_list: ['zorp farm'] })).toEqual(hit(14, 18))
  })

  it('does not exempt a match that only part of an allowed phrase covers', () => {
    expect(find(['*zorp*'], 'zorpish', { allow_list: ['zorp'] })).toEqual(hit(0, 7))
    expect(find(['zorp'], 'a zorp b', { allow_list: ['b zorp'] })).toEqual(hit(2, 6))
    expect(find(['zorp'], 'x zorp farm', { allow_list: ['zorp farm y'] })).toEqual(hit(2, 6))
  })

  it('exempts only the keyword that the allowed text holds, not another in the same text', () => {
    const meta = { allow_list: ['flibber zorp'] }
    expect(find(['zorp', 'gronk'], 'flibber zorp gronk', meta)).toEqual(hit(13, 18))
    expect(find(['zorp'], 'flibber zorp', meta)).toBeNull()
  })

  it('looks at every allowed span, however they overlap', () => {
    const meta = { allow_list: ['aa bb cc', 'bb', 'xx'] }
    expect(find(['bb'], 'aa bb cc', meta)).toBeNull()
    expect(find(['cc'], 'aa bb cc', meta)).toBeNull()
    expect(find(['aa'], 'aa bb cc', meta)).toBeNull()
    expect(find(['bb'], 'aa bb dd', meta)).toBeNull()
    expect(find(['dd'], 'aa bb dd', meta)).toEqual(hit(6, 8))
    expect(find(['zz'], 'zz xx zz', { allow_list: ['xx', 'zz xx zz'] })).toBeNull()
    expect(find(['zz'], 'yy zz xx', { allow_list: ['zz xx', 'xx'] })).toBeNull()
  })

  it('is kept to its own rule', () => {
    const rules = [keywordRule(['zorp'], { allow_list: ['zorp'] }, { name: 'First' }), keywordRule(['zorp'], {}, { name: 'Second' })]
    expect(matcher(rules)('zorp')).toEqual(hit(0, 4, 'Second'))
    expect(matcher([rules[0]])('zorp')).toBeNull()
  })

  it('is read the way the text is: an allowed word with marks in it counts', () => {
    expect(find(['zorp'], 'ZORP farm', { allow_list: ['zörp  FARM'] })).toBeNull()
    expect(find(['zorp'], 'zo**r**p farm', { allow_list: ['zorp farm'] })).toBeNull()
    expect(find(['zorp'], 'zo\u200brp farm', { allow_list: ['zorp farm'] })).toBeNull()
  })

  it('reads a middle part of an allow entry at its first place only, which Discord does not document: an early decoy there lets nothing by', () => {
    // `a*b*c` over `ab`, 28 `x`, `b`, 49 `x`, `c`: the `b` at 1 is 79 from the `c`, too far, and the `b` at 30 is in reach of both. A keyword
    // reads its way through the second `b`; an allow entry stops at the first, and so holds nothing, and the match of `*x*` is refused.
    const text = `ab${'x'.repeat(28)}b${'x'.repeat(49)}c`
    for (const entry of ['a*b*c', '*a*b*c*', 'a*b*c*', '*a*b*c']) {
      expect(find(['*x*'], text, { allow_list: [entry] }), entry).toEqual(hit(0, 81))
      // With no decoy, the first `b` is the one in reach, and the entry holds the word.
      expect(find(['*x*'], text.replace('ab', 'ax'), { allow_list: [entry] }), entry).toBeNull()
    }
    // A decoy for each of two middle parts: the keyword finds its way, the allow entry does not. A decoy of the second middle part only (the `c`
    // at 43, 72 from the `d`) is one too; with the first place of each middle part in reach of the next, the entry holds the word.
    const two = `ab${'x'.repeat(40)}bc${'x'.repeat(20)}c${'x'.repeat(50)}d`
    expect(find(['a*b*c*d'], two)).toEqual(hit(0, 116))
    expect(find(['*x*'], two, { allow_list: ['a*b*c*d'] })).toEqual(hit(0, 116))
    expect(find(['*x*'], `a${'x'.repeat(41)}bc${'x'.repeat(20)}c${'x'.repeat(50)}d`, { allow_list: ['a*b*c*d'] })).toEqual(hit(0, 116))
    expect(find(['*x*'], `a${'x'.repeat(41)}b${'x'.repeat(21)}c${'x'.repeat(50)}d`, { allow_list: ['a*b*c*d'] })).toBeNull()
    // The last part is still taken where its edge holds, as before: `c` at 80 is inside a word, the one at 82 ends it.
    expect(find(['*x*'], `ax${'x'.repeat(28)}b${'x'.repeat(49)}cxc`, { allow_list: ['a*b*c'] })).toBeNull()
    // An entry of two parts has no middle one, and is read as it was: its last part where its edge holds (the `b` at 52, not the one at 21).
    expect(find(['*x*'], `a${'x'.repeat(20)}b${'x'.repeat(30)}b`, { allow_list: ['a*b'] })).toBeNull()
    // The keywords keep their reading: the same text is a match of `a*b*c` itself, and only a keyword that the allow list holds goes by.
    expect(find(['a*b*c'], text)).toEqual(hit(0, 81))
    expect(find(['a*b*c'], text, { allow_list: ['*x*'] })).toBeNull()
  })

  it('has nothing to exempt in a list of no text', () => {
    expect(find(['zorp'], 'zorp', { allow_list: [null, 5, '', '*', {}] })).toEqual(hit(0, 4))
    expect(find(['zorp'], 'zorp', { allow_list: 'zorp' })).toEqual(hit(0, 4))
    expect(find(['zorp'], 'zorp', { allow_list: null })).toEqual(hit(0, 4))
  })
})

describe('automodMatcher: which rules and which members', () => {
  it('names the first rule in the list that matches, with where', () => {
    const rules = [keywordRule(['gronk'], {}, { name: 'One' }), keywordRule(['zorp'], {}, { name: 'Two' }), keywordRule(['zorp'], {}, { name: 'Three' })]
    expect(matcher(rules)('a zorp')).toEqual(hit(2, 6, 'Two'))
    expect(matcher(rules)('zorp gronk')).toEqual(hit(5, 10, 'One'))
  })

  it('takes the earliest match of a rule over all its keywords', () => {
    expect(find(['gronk', 'zorp'], 'zorp gronk')).toEqual(hit(0, 4))
    expect(find(['zorp', 'gronk'], 'gronk zorp')).toEqual(hit(0, 5))
    expect(find(['*orp*', 'zorp'], 'zorp')).toEqual(hit(0, 4))
    expect(find(['zorp*', '*zorp*'], 'xzorpy')).toEqual(hit(0, 6))
  })

  it('names a rule that has no name', () => {
    expect(matcher([keywordRule(['zorp'], {}, { name: undefined })])('zorp')).toEqual(hit(0, 4, 'unnamed'))
    expect(matcher([keywordRule(['zorp'], {}, { name: '' })])('zorp')).toEqual(hit(0, 4, 'unnamed'))
    expect(matcher([keywordRule(['zorp'], {}, { name: 5 })])('zorp')).toEqual(hit(0, 4, 'unnamed'))
  })

  it('skips a rule that is switched off, but takes one that does not say', () => {
    expect(matcher([keywordRule(['zorp'], {}, { enabled: false })])('zorp')).toBeNull()
    expect(matcher([keywordRule(['zorp'], {}, { enabled: undefined })])('zorp')).toEqual(hit(0, 4))
    expect(matcher([keywordRule(['zorp'], {}, { enabled: true })])('zorp')).toEqual(hit(0, 4))
  })

  it('applies a rule whatever it does about a match', () => {
    for (const actions of [[{ type: 2 }], [{ type: 3 }], [], undefined]) {
      expect(matcher([keywordRule(['zorp'], {}, { actions })])('zorp'), JSON.stringify(actions)).toEqual(hit(0, 4))
    }
  })

  it('skips the rules that are not keyword rules, and what is no rule', () => {
    const odd = [null, 5, 'zorp', [], {}, { trigger_type: 1 }, { trigger_type: '1', trigger_metadata: { keyword_filter: ['zorp'] } }]
    const rules = [
      ...odd,
      rule({ trigger_type: 3, trigger_metadata: { keyword_filter: ['zorp'] } }),
      rule({ trigger_type: 4, trigger_metadata: { keyword_filter: ['zorp'], presets: [1] } }),
      rule({ trigger_type: 6, trigger_metadata: { keyword_filter: ['zorp'] } }),
      keywordRule(['gronk']),
    ]
    expect(matcher(rules)('zorp')).toBeNull()
    expect(matcher(rules)('gronk')).toEqual(hit(0, 5))
  })

  it('reads a keyword rule with no metadata, or odd metadata, as one with no keywords', () => {
    for (const trigger_metadata of [undefined, null, 5, 'zorp', [], {}, { keyword_filter: 'zorp' }, { keyword_filter: null }]) {
      expect(matcher([rule({ trigger_metadata })])('zorp'), JSON.stringify(trigger_metadata)).toBeNull()
    }
  })

  it('exempts a member who has one of the roles the rule exempts', () => {
    const rules = [keywordRule(['zorp'], {}, { exempt_roles: [ROLE_A, ROLE_B] })]
    expect(matcher(rules, { memberRoleIds: [ROLE_B] })('zorp')).toBeNull()
    expect(matcher(rules, { memberRoleIds: ['x', ROLE_A, 'y'] })('zorp')).toBeNull()
    expect(matcher(rules, { memberRoleIds: ['200000000000000499'] })('zorp')).toEqual(hit(0, 4))
    expect(matcher(rules, { memberRoleIds: [] })('zorp')).toEqual(hit(0, 4))
    expect(matcher(rules, {})('zorp')).toEqual(hit(0, 4))
  })

  it('exempts a member from the rules that exempt them and not from the others', () => {
    const rules = [keywordRule(['zorp'], {}, { name: 'One', exempt_roles: [ROLE_A] }), keywordRule(['zorp'], {}, { name: 'Two', exempt_roles: [ROLE_B] })]
    expect(matcher(rules, { memberRoleIds: [ROLE_A] })('zorp')).toEqual(hit(0, 4, 'Two'))
    expect(matcher(rules, { memberRoleIds: [ROLE_B] })('zorp')).toEqual(hit(0, 4, 'One'))
    expect(matcher(rules, { memberRoleIds: [ROLE_A, ROLE_B] })('zorp')).toBeNull()
  })

  it('exempts a rule in the channels that it exempts', () => {
    const rules = [keywordRule(['zorp'], {}, { exempt_channels: [FORUM] })]
    expect(matcher(rules, { channelIds: [FORUM] })('zorp')).toBeNull()
    expect(matcher(rules, { channelIds: [POST, FORUM] })('zorp')).toBeNull()
    expect(matcher(rules, { channelIds: [POST] })('zorp')).toEqual(hit(0, 4))
    expect(matcher(rules, { channelIds: [] })('zorp')).toEqual(hit(0, 4))
    expect(matcher(rules, {})('zorp')).toEqual(hit(0, 4))
  })

  it('reads missing or odd exemptions as none', () => {
    for (const exempt of [undefined, null, 'x', {}, 5]) {
      const r = keywordRule(['zorp'], {}, { exempt_roles: exempt, exempt_channels: exempt })
      expect(matcher([r], { memberRoleIds: [ROLE_A], channelIds: [FORUM] })('zorp')).toEqual(hit(0, 4))
    }
  })

  it('exempts no rule from an administrator or a manager of the server, whatever they write', () => {
    const rules = [keywordRule(['zorp']), mentionRule(5), keywordRule(['*'], { regex_patterns: ['.'] })]
    const m = matcher(rules, { isAdmin: true })
    expect(m('zorp')).toBeNull()
    expect(m('zorp zorp')).toBeNull()
    expect(m.mentionCap).toBe(MENTION_CAP)
  })

  it('does not exempt a member for whom isAdmin is false or not given', () => {
    expect(matcher([keywordRule(['zorp'])], { isAdmin: false })('zorp')).toEqual(hit(0, 4))
    expect(matcher([keywordRule(['zorp'])], {})('zorp')).toEqual(hit(0, 4))
  })
})

describe('automodMatcher: the cap on mentions', () => {
  it('is 10 when no rule limits them, and with the live limit of 40', () => {
    expect(matcher([]).mentionCap).toBe(10)
    expect(matcher([keywordRule(['zorp'])]).mentionCap).toBe(10)
    expect(matcher([mentionRule(40)]).mentionCap).toBe(10)
  })

  it('is one under the limit of the rule, when that is under 11', () => {
    expect(matcher([mentionRule(12)]).mentionCap).toBe(10)
    expect(matcher([mentionRule(11)]).mentionCap).toBe(10)
    expect(matcher([mentionRule(10)]).mentionCap).toBe(9)
    expect(matcher([mentionRule(5)]).mentionCap).toBe(4)
    expect(matcher([mentionRule(2)]).mentionCap).toBe(1)
    expect(matcher([mentionRule(1)]).mentionCap).toBe(0)
  })

  it('is nothing when the limit is nothing or is not a number: a rule that cannot be read lets none through', () => {
    for (const limit of [0, -3, undefined, null, '40', 5.5, NaN, Infinity]) {
      expect(matcher([mentionRule(limit)]).mentionCap, String(limit)).toBe(0)
    }
    expect(matcher([rule({ trigger_type: 5, trigger_metadata: undefined })]).mentionCap).toBe(0)
    expect(matcher([rule({ trigger_type: 5, trigger_metadata: 'x' })]).mentionCap).toBe(0)
  })

  it('takes the least of the rules that apply', () => {
    expect(matcher([mentionRule(40), mentionRule(6)]).mentionCap).toBe(5)
    expect(matcher([mentionRule(6), mentionRule(40)]).mentionCap).toBe(5)
  })

  it('leaves out a rule that is off, or that exempts the member or the channel', () => {
    expect(matcher([mentionRule(5, { enabled: false })]).mentionCap).toBe(10)
    expect(matcher([mentionRule(5, { exempt_roles: [ROLE_A] })], { memberRoleIds: [ROLE_A] }).mentionCap).toBe(10)
    expect(matcher([mentionRule(5, { exempt_roles: [ROLE_A] })], { memberRoleIds: [ROLE_B] }).mentionCap).toBe(4)
    expect(matcher([mentionRule(5, { exempt_channels: [FORUM] })], { channelIds: [FORUM] }).mentionCap).toBe(10)
    expect(matcher([mentionRule(5, { exempt_channels: [FORUM] })], { channelIds: [POST] }).mentionCap).toBe(4)
    expect(matcher([mentionRule(5)], { isAdmin: true }).mentionCap).toBe(10)
  })

  it('is no reason for a match in the text', () => {
    expect(matcher([mentionRule(1)])(`<@${U1}> <@${U2}>`)).toBeNull()
  })
})

// What the checks of the time that a text takes are made of. A check at eight times the length takes about eight times as long when the walk
// is linear and about 64 times as long when it is quadratic, whatever the speed of the host or of Stryker's instrumented copy of the module, so
// the ratio is what is measured, against RATIO, which is far from both: load on the host can make the longer run twice as slow as the shorter
// for each character (its data falls out of a cache that other processes share), which at four times the length, against a RATIO of 8, failed
// the linear walks at 9.1 and passed the quadratic one at 7.1. So that load falls on the two sizes alike, the shorter is run 8 times for each run
// of the longer (a round of each takes about as long when the walk is linear), the two are run in turn, 5 times each, and the least time of
// each is taken: load (the collector, other test files, other work on the host) only ever adds time. A ratio on the wrong side of RATIO is
// measured again, twice at most, before it is believed. A loose ceiling on the time of the longer one is kept besides, for a walk that is slow
// and not quadratic.
const RATIO = 20
const BOUND_MS = 4_000
const MEASURES = 3
// → the least time of the thunk over 5 runs, after one that is not counted (it pays for the compiling of the code it runs).
function timeOf(thunk) {
  thunk()
  let least = Number.POSITIVE_INFINITY
  for (let run = 0; run < 5; run++) {
    const started = performance.now()
    thunk()
    least = Math.min(least, performance.now() - started)
  }
  return least
}
// → { ratio, ms }: what a check takes at 8n against what it takes at n, as `make(n)` gives the thunk for a text of about n characters (8,000
// and 64,000 by default, which is long enough for a walk that flattens a string for each space, or one that looks over a word for each place
// of it, to show), and the least time of the longer.
function scaling(make, n = 8_000) {
  const small = make(n)
  const large = make(8 * n)
  const smalls = () => {
    for (let k = 0; k < 8; k++) small()
  }
  // One run of each is not counted (it pays for the compiling of the code it runs).
  smalls()
  large()
  let least = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  for (let round = 0; round < 5; round++) {
    least = [smalls, large].map((thunk, k) => {
      const started = performance.now()
      thunk()
      return Math.min(least[k], performance.now() - started)
    })
  }
  return { ratio: (8 * least[1]) / Math.max(least[0], 0.4), ms: least[1] }
}
// → the measure of scaling() that is on the side of RATIO that `under` asks for, or the last of MEASURES that are not.
function measured(make, n, under) {
  let found = scaling(make, n)
  for (let again = 1; again < MEASURES && found.ratio < RATIO !== under; again++) found = scaling(make, n)
  return found
}
function expectLinear(label, make, n) {
  const { ratio, ms } = measured(make, n, true)
  expect(ratio, label).toBeLessThan(RATIO)
  expect(ms, label).toBeLessThan(BOUND_MS)
}
// → { ratio, ms }: what `heavy` takes against what `light` takes, run in turn 5 times each, with the least of each (as scaling() does), and the
// least time of `heavy`; measured again, twice at most, while the ratio is not under `limit`. For a check that a list of many costs about what
// a list of one does.
function versus(light, heavy, limit) {
  let found = null
  for (let again = 0; again < MEASURES && (found === null || found.ratio >= limit); again++) {
    light()
    heavy()
    let least = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
    for (let round = 0; round < 5; round++) {
      least = [light, heavy].map((thunk, k) => {
        const started = performance.now()
        thunk()
        return Math.min(least[k], performance.now() - started)
      })
    }
    found = { ratio: least[1] / Math.max(least[0], 0.05), ms: least[1] }
  }
  return found
}

describe('translatePattern: a pattern of Rust\'s, as the pattern JavaScript runs', () => {
  it('leaves a pattern that means the same in both as it is', () => {
    for (const source of ['zorp', 'zor+p', 'a|b', '(a)(b)', '[a-z]+', '\\.', 'a{2,3}', '\\p{Lu}{2}', '\\P{L}', '[\\p{L}0-9]', '^a$', '(?<n>a)', '😀+', '\\n\\t', '\\x41', '\\u0041', '\\/']) {
      expect(translatePattern(source), source).toBe(source)
    }
    expect(translatePattern('')).toBe('')
  })

  it('takes a leading (?i) off, since every pattern is run in any case, and only a leading one', () => {
    expect(translatePattern('(?i)zorp')).toBe('zorp')
    expect(translatePattern('(?i)')).toBe('')
    expect(translatePattern('(?i)(?i)zorp')).toBeNull()
    expect(translatePattern('a(?i)zorp')).toBeNull()
    expect(translatePattern('(?s)zorp')).toBeNull()
    expect(translatePattern('(?-i)zorp')).toBeNull()
    expect(translatePattern('(?i')).toBeNull()
  })

  it('writes \\A as ^, \\z as $, and \\pL as \\p{L}, and the same for the capital letters of \\P', () => {
    expect(translatePattern('\\Azorp')).toBe('^zorp')
    expect(translatePattern('zorp\\z')).toBe('zorp$')
    expect(translatePattern('\\pLorp')).toBe('\\p{L}orp')
    expect(translatePattern('\\PLorp')).toBe('\\P{L}orp')
    expect(translatePattern('\\pL+\\pN')).toBe('\\p{L}+\\p{N}')
    expect(translatePattern('[\\pL]')).toBe('[\\p{L}]')
    expect(translatePattern('\\p{Lu}\\pL')).toBe('\\p{Lu}\\p{L}')
    expect(translatePattern('(?i)\\Az\\z')).toBe('^z$')
  })

  it('does not read an escaped backslash as the start of an escape', () => {
    expect(translatePattern('\\\\Azorp')).toBe('\\\\Azorp')
    expect(translatePattern('zorp\\\\z')).toBe('zorp\\\\z')
    expect(translatePattern('\\\\pL')).toBe('\\\\pL')
    expect(translatePattern('\\\\.')).toBe('\\\\[^\\n]')
    expect(translatePattern('\\\\\\Azorp')).toBe('\\\\^zorp')
  })

  it('writes . as any character but a line feed, and leaves it alone in a class and when escaped', () => {
    expect(translatePattern('a.b')).toBe('a[^\\n]b')
    expect(translatePattern('[.]')).toBe('[.]')
    expect(translatePattern('\\.')).toBe('\\.')
    expect(translatePattern('[^.]')).toBe('[^.]')
  })

  it('reads \\s, \\S and [^\\s] as Rust does, by the White_Space of Unicode that it names: U+0085 is white space and U+FEFF is not', () => {
    // Rust's White_Space, written out: the \\s of JavaScript has U+FEFF and lacks U+0085.
    const white = (c) => (c >= 0x9 && c <= 0xd) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
    const forms = [['\\s', true], ['[\\s]', true], ['[b\\s]', true], ['[\\sb]', true], ['\\S', false], ['[^\\s]', false], ['[^b\\s]', false]]
    for (const [source, isWhite] of forms) {
      const re = new RegExp(`^${translatePattern(source)}$`, 'u')
      const wrong = []
      for (let c = 0; c <= 0xffff; c++) {
        if (c >= 0xd800 && c <= 0xdfff) continue
        if (c === 0x62 && source.includes('b')) continue
        if (re.test(String.fromCodePoint(c)) !== (white(c) === isWhite)) wrong.push(c.toString(16))
      }
      for (const c of [0x10000, 0x1f600, 0xe0020, 0x10ffff]) if (re.test(String.fromCodePoint(c)) !== !isWhite) wrong.push(c.toString(16))
      expect(wrong, source).toEqual([])
    }
    expect(new RegExp(translatePattern('[b\\s]'), 'u').test('b')).toBe(true)
    expect(new RegExp(translatePattern('[^b\\s]'), 'u').test('b')).toBe(false)
  })

  it('writes \\s and \\S in a pattern and leaves the rest of it as it is, and gives up on \\S in a class', () => {
    expect(translatePattern('a\\sb')).toMatch(/^a\[[^\]]+\]b$/)
    expect(translatePattern('a\\Sb')).toMatch(/^a\[\^[^\]]+\]b$/)
    expect(translatePattern('[a\\sb]')).toMatch(/^\[a[^\]]+b\]$/)
    expect(translatePattern('\\\\sb')).toBe('\\\\sb')
    expect(translatePattern('\\\\S')).toBe('\\\\S')
    expect(translatePattern('[\\S]')).toBeNull()
    expect(translatePattern('[a\\S]')).toBeNull()
    expect(translatePattern('[^\\S]')).toBeNull()
  })

  it('gives up on a group of flags with an s in it, where Rust\'s . takes a line feed and the . written here does not', () => {
    for (const source of ['(?Us:a)', '(?sU:a)', '(?s:zo.rp)', '(?is:zo.rp)', '(?si:a)', '(?-s:a.b)', '(?s-i:a)', '(?i-s:a)', 'a(?s:.)b', '(?sx:a)', '((?s:a))', '(?m-s:a)', '(?i)(?s:a)', '(?s:', '(?is)a', '(?s)a']) {
      expect(translatePattern(source), source).toBeNull()
    }
  })

  it('keeps the groups it can read the same: of other flags, of no flags, a look at what follows, and a name that has an s in it', () => {
    expect(translatePattern('(?i:a.b)')).toBe('(?i:a[^\\n]b)')
    expect(translatePattern('(?m:a)')).toBe('(?m:a)')
    expect(translatePattern('(?:a)')).toBe('(?:a)')
    expect(translatePattern('(?=a)a')).toBe('(?=a)a')
    expect(translatePattern('(?!a)b')).toBe('(?!a)b')
    expect(translatePattern('(?<s>a)')).toBe('(?<s>a)')
    expect(translatePattern('(?<name>s)')).toBe('(?<name>s)')
    expect(translatePattern('(?i:s)')).toBe('(?i:s)')
    expect(translatePattern('(?:s)')).toBe('(?:s)')
    expect(translatePattern('(as)')).toBe('(as)')
    expect(translatePattern('(ss)')).toBe('(ss)')
    expect(translatePattern('zo?s')).toBe('zo?s')
    expect(translatePattern('(a?s)')).toBe('(a?s)')
  })

  it('does not take what is only written like a group of flags for one: an escaped parenthesis, and a class', () => {
    expect(translatePattern('\\(?s:a')).toBe('\\(?s:a')
    expect(translatePattern('[(?s]')).toBe('[(?s]')
    expect(translatePattern('a\\(?s')).toBe('a\\(?s')
  })

  it('gives up on what Rust reads as Unicode and JavaScript reads as ASCII, wherever it stands', () => {
    for (const source of ['\\bzorp\\b', 'zorp\\b', '\\Bz', '\\w+', '\\W', '\\d', '\\D+', '[\\w]', '[^\\d]', 'a\\bb', '(?i)\\w', 'x\\\\\\w']) {
      expect(translatePattern(source), source).toBeNull()
    }
  })

  it('gives up on a class of POSIX, a class in a class, an intersection or a difference in one, and a class that starts with ]', () => {
    for (const source of ['[[:alpha:]]+orp', '[[:^alpha:]]', '[a[b]]', '[a&&b]', '[a--b]', '[+--/]', '[a~~b]', '[a-z&&[^b]]', '[]a]', '[^]a]', '[]', '[^]', '[a[]']) {
      expect(translatePattern(source), source).toBeNull()
    }
    // A single - or & or ~ is a character, and a - between two is a range.
    for (const source of ['[a-z]', '[a&b]', '[a~b]', '[a-]', '[-a]', '[a-b-c]', '[\\]]', '[\\[]', '[^a]', '[^\\]]', '[aa]', '[aab]', '[&a&]', '[~a~]', '[a-a]', '[^aa]']) {
      expect(translatePattern(source), source).toBe(source)
    }
    // What follows a class is read outside it again.
    expect(translatePattern('[a].')).toBe('[a][^\\n]')
    expect(translatePattern('[^a]\\Az')).toBe('[^a]^z')
    expect(translatePattern('[a]\\s')).toMatch(/^\[a\]\[[^\]]+\]$/)
    expect(translatePattern('[a][b]')).toBe('[a][b]')
  })

  it('gives up on what does not compile in Unicode mode, and has no fallback that reads it another way', () => {
    for (const source of ['(', 'a)', '[', 'a\\', '\\p', '(?P<n>a)', '\\p{Greek}', '\\p{}', '\\x{41}', 'a\\-b', 'a\\_b', '\\<', '\\A\\', '\\pQ', '*a', 'a**', '(?=a)(']) {
      expect(translatePattern(source), source).toBeNull()
    }
  })

  it('has \\A and \\z in a class left for the compiler, which refuses them', () => {
    expect(translatePattern('[\\A]')).toBeNull()
    expect(translatePattern('[\\z]')).toBeNull()
  })

  it('is null for what is no text', () => {
    for (const source of [undefined, null, 5, {}, ['a'], true]) expect(translatePattern(source)).toBeNull()
  })

  it('answers a source that compiles, whatever the text, and never throws', () => {
    const piece = fc.constantFrom('a', '\\', '[', ']', '^', '(', ')', '?', 'i', '.', 'p', 'P', '{', '}', 'L', 'A', 'z', 's', 'S', 'b', 'w', 'd', '-', '&', '~', ':', '*', '+', '|', '😀', '\ud800')
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 12 }).map((a) => a.join('')), (source) => {
        const out = translatePattern(source)
        if (out !== null) expect(() => new RegExp(out, 'giu')).not.toThrow()
      }),
      { numRuns: 3000 },
    )
  })
})

describe('automodUnchecked: the rules that have a pattern the site cannot check', () => {
  const rx = (patterns, over = {}) => keywordRule([], { regex_patterns: patterns }, over)

  it('names each rule with a pattern that translatePattern gives up on, once, in the order of the rules', () => {
    const rules = [
      rx(['fine', '\\bword\\b'], { name: 'Alpha' }),
      rx(['fine'], { name: 'Beta' }),
      rx(['[[:alpha:]]', '\\w'], { name: 'Gamma' }),
      rx(['(?P<n>x)'], { name: 'Alpha' }),
      rx(['\\d'], { name: '' }),
      rx([null, 'x'], { name: 'Delta' }),
    ]
    expect(automodUnchecked(rules)).toEqual(['Alpha', 'Gamma', 'unnamed', 'Delta'])
  })

  it('says nothing of a pattern that is fine, or a rule with none', () => {
    expect(automodUnchecked([rx(['(?i)zorp', '\\Aa\\z', '\\pL+']), keywordRule(['zorp']), rx([])])).toEqual([])
    expect(automodUnchecked([])).toEqual([])
  })

  it('leaves out a rule that is off, a rule that is not a keyword rule, and what is no rule', () => {
    const bad = ['\\w']
    const rules = [rx(bad, { name: 'Off', enabled: false }), rx(bad, { name: 'Spam', trigger_type: 5 }), rx(bad, { name: 'Other', trigger_type: 3 }), null, 5, 'x', [], undefined, rx(bad, { name: 'On' })]
    expect(automodUnchecked(rules)).toEqual(['On'])
  })

  it('reads a rule with no metadata, or patterns that are not a list, as one with none', () => {
    expect(automodUnchecked([rule({ trigger_metadata: undefined }), rule({ trigger_metadata: 'x' }), rx('\\w'), rx({ 0: '\\w' }), rx(null)])).toEqual([])
  })

  it('does not look at who the rule applies to: it names a rule that exempts roles too', () => {
    expect(automodUnchecked([rx(['\\w'], { name: 'Exempt', exempt_roles: [ROLE_A], exempt_channels: [FORUM] })])).toEqual(['Exempt'])
  })

  it('is told rules that are a list', () => {
    for (const rules of [undefined, null, {}, 'x', 5, new Set()]) throwsAs(() => automodUnchecked(rules), TypeError, 'the rules must be a list')
  })

  it('changes nothing it is given', () => {
    const rules = [rx(['\\w'], { name: 'A' })]
    const before = JSON.stringify(rules)
    automodUnchecked(rules)
    expect(JSON.stringify(rules)).toBe(before)
  })
})

describe('scanPatterns: what the worker runs', () => {
  const scan = (rules, texts) => scanPatterns({ rules, texts })

  it('finds the first match that is not empty, and says where, in any case', () => {
    expect(scan([['zor+p']], ['a ZORRRP b'])).toEqual({ text: 0, rule: 0, start: 2, end: 8 })
    expect(scan([['x*']], ['abxxc'])).toEqual({ text: 0, rule: 0, start: 2, end: 4 })
    expect(scan([['x*']], ['abc'])).toBeNull()
    expect(scan([['x*']], [''])).toBeNull()
    expect(scan([['^']], ['abc'])).toBeNull()
    expect(scan([['']], ['abc'])).toBeNull()
    expect(scan([['zorp']], ['zorp'])).toEqual({ text: 0, rule: 0, start: 0, end: 4 })
  })

  it('finds nothing in no texts, with no rules, or with no patterns', () => {
    expect(scan([['zorp']], [])).toBeNull()
    expect(scan([], ['zorp'])).toBeNull()
    expect(scan([[]], ['zorp'])).toBeNull()
  })

  it('goes through the texts in order, and in each through the rules in order', () => {
    expect(scan([['aa'], ['bb']], ['x', 'bb aa'])).toEqual({ text: 1, rule: 0, start: 3, end: 5 })
    expect(scan([['bb'], ['aa']], ['aa', 'bb'])).toEqual({ text: 0, rule: 1, start: 0, end: 2 })
    expect(scan([['aa'], ['bb']], ['bb', 'aa'])).toEqual({ text: 0, rule: 1, start: 0, end: 2 })
    expect(scan([['aa'], ['aa']], ['aa'])).toEqual({ text: 0, rule: 0, start: 0, end: 2 })
  })

  it('takes the earliest match of the patterns of one rule, and the first when they start together', () => {
    expect(scan([['b', 'a']], ['xab'])).toEqual({ text: 0, rule: 0, start: 1, end: 2 })
    expect(scan([['a', 'b']], ['xab'])).toEqual({ text: 0, rule: 0, start: 1, end: 2 })
    expect(scan([['ab', 'a']], ['xab'])).toEqual({ text: 0, rule: 0, start: 1, end: 3 })
    expect(scan([['a', 'ab']], ['xab'])).toEqual({ text: 0, rule: 0, start: 1, end: 2 })
  })

  it('keeps the earlier match when a later pattern of the rule finds none', () => {
    expect(scan([['a', 'zzz']], ['xa'])).toEqual({ text: 0, rule: 0, start: 1, end: 2 })
    expect(scan([['zzz', 'a', 'yyy']], ['xa'])).toEqual({ text: 0, rule: 0, start: 1, end: 2 })
  })

  it('starts each text at its start, whatever the last one left in the pattern', () => {
    expect(scan([['zorp']], ['a zorp', 'zorp'])).toEqual({ text: 0, rule: 0, start: 2, end: 6 })
    expect(scan([['zorp'], ['gronk']], ['a zorp', 'gronk'])).toEqual({ text: 0, rule: 0, start: 2, end: 6 })
    expect(scan([['gronk']], ['a zorp', 'gronk'])).toEqual({ text: 1, rule: 0, start: 0, end: 5 })
  })

  it('reads in Unicode: a pair is one character, and a property is known', () => {
    expect(scan([['\\p{Lu}{2}']], ['a ZZ b'])).toEqual({ text: 0, rule: 0, start: 2, end: 4 })
    expect(scan([['😀+']], ['a 😀😀'])).toEqual({ text: 0, rule: 0, start: 2, end: 6 })
    expect(scan([['^.$']], ['😀'])).toEqual({ text: 0, rule: 0, start: 0, end: 2 })
  })

  it('goes on past an empty match, also in the middle of a pair, and stops', () => {
    expect(scan([['(?:)']], ['😀😀 a'])).toBeNull()
    expect(scan([['x*']], ['😀😀x'])).toEqual({ text: 0, rule: 0, start: 4, end: 5 })
    expect(scan([['\\p{Lu}*']], ['😀😀'])).toBeNull()
    expect(scan([['(?:)', 'b']], ['😀b'])).toEqual({ text: 0, rule: 0, start: 2, end: 3 })
  })

  it('throws for a source that does not compile, which translatePattern never gives', () => {
    expect(() => scan([['(']], ['a'])).toThrow(SyntaxError)
  })

  it('throws for a job that is not made of lists of texts, so that no text that was not read is told as one with no match', () => {
    for (const rules of [undefined, null, 'a', 5, {}, [5], [null], ['a'], [[5]], [[null]], [[['a']]], [['a'], 5], [['a', 5]], [[], null], [['a'], ['b', null]]]) throwsAs(() => scan(rules, ['a']), TypeError, 'the job must be a list of lists of patterns and a list of texts')
    for (const texts of [undefined, null, 'a', 5, {}, [5], [null], [undefined], [['a']], new Set(['a']), ['a', 5], [5, 'a'], ['a', null]]) throwsAs(() => scan([['a']], texts), TypeError, 'the job must be a list of lists of patterns and a list of texts')
  })
})

describe('automodMatcher: regular expressions, in a worker of their own', () => {
  const withRegex = (patterns, over = {}) => keywordRule([], { regex_patterns: patterns }, over)
  const regex = (rules, texts, who) => matcher(rules, who).regex(texts)
  const hitAt = (text, start, end, name = 'Test Rule') => ({ rule: name, text, start, end })
  const SLOW = '(a+)+$'
  const slowText = `${'a'.repeat(60)}!`

  beforeAll(async () => {
    await scanInWorker({ rules: [['a']], texts: ['a'] })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('matches a pattern, in any case, and says where and in which text', async () => {
    const m = matcher([withRegex(['zor+p'])])
    expect(await m.regex(['a ZORRRP b'])).toEqual(hitAt(0, 2, 8))
    expect(await m.regex(['nothing'])).toBeNull()
    expect(await m.regex(['nothing', 'a zorp'])).toEqual(hitAt(1, 2, 6))
    expect(await m.regex(['zorp', 'a zorp'])).toEqual(hitAt(0, 0, 4))
    expect(await m.regex([])).toBeNull()
  })

  it('gives the name of the first rule that matches, and does not run what is not a keyword matcher', async () => {
    const rules = [withRegex(['nomatch'], { name: 'First' }), withRegex(['zorp'], { name: 'Second' }), withRegex(['zorp'], { name: 'Third' })]
    expect(await regex(rules, ['a zorp'])).toEqual(hitAt(0, 2, 6, 'Second'))
    expect(await regex([withRegex(['zorp'], { name: 'Spam', trigger_type: 5 })], ['zorp'])).toBeNull()
    expect(await regex([withRegex(['zorp'], { name: '' })], ['zorp'])).toEqual(hitAt(0, 0, 4, 'unnamed'))
  })

  it('reads the patterns of Rust that it can, and finds what the reviewers found it missed', async () => {
    const found = async (pattern, text) => (await regex([withRegex([pattern])], [text]))?.start ?? null
    expect(await found('\\Azorp', 'zorp x')).toBe(0)
    expect(await found('\\Azorp', 'a zorp')).toBeNull()
    expect(await found('zorp\\z', 'x zorp')).toBe(2)
    expect(await found('zorp\\z', 'zorp x')).toBeNull()
    expect(await found('\\pLorp', 'a zorp')).toBe(2)
    expect(await found('\\pLorp', 'a 1orp')).toBeNull()
    expect(await found('(?i)ZORP', 'a zorp')).toBe(2)
    expect(await found('a.b', 'a\rb')).toBe(0)
    expect(await found('a.b', 'a b')).toBe(0)
    expect(await found('a.b', 'a\nb')).toBeNull()
    expect(await found('a\\sb', 'a\u0085b')).toBe(0)
    expect(await found('a\\sb', 'a b')).toBe(0)
  })

  it('finds what Rust finds with \\S and [^\\s] beside U+FEFF, which is not white space for it, and not with \\s', async () => {
    const found = async (pattern, text) => (await regex([withRegex([pattern])], [text]))?.start ?? null
    expect(await found('zo\\Srp', 'zo\ufeffrp')).toBe(0)
    expect(await found('zo[^\\s]rp', 'zo\ufeffrp')).toBe(0)
    expect(await found('discord\\.gg/\\S+', 'discord.gg/\ufeffinvite')).toBe(0)
    expect(await found('zo\\srp', 'zo\ufeffrp')).toBeNull()
    expect(await found('zo[\\s]rp', 'zo\ufeffrp')).toBeNull()
    expect(await found('zo\\srp', 'zo\u0085rp')).toBe(0)
    expect(await found('zo\\Srp', 'zo\u0085rp')).toBeNull()
    expect(await found('zo\\srp', 'zo\u3000rp')).toBe(0)
  })

  it('does not run a pattern with an s group, which would miss a line feed that Rust\'s . takes, and the others of its rule are run', async () => {
    expect(await regex([withRegex(['(?s:zo.rp)'])], ['zo\nrp'])).toBeNull()
    expect(await regex([withRegex(['(?s:zo.rp)', 'gronk'])], ['zo\nrp gronk'])).toEqual(hitAt(0, 6, 11))
    expect(automodUnchecked([withRegex(['(?s:zo.rp)'], { name: 'Dotall' })])).toEqual(['Dotall'])
    expect(await regex([withRegex(['(?i:zo.rp)'])], ['zo\nrp'])).toBeNull()
    expect(await regex([withRegex(['(?i:zo.rp)'])], ['ZOxRP'])).toEqual(hitAt(0, 0, 5))
  })

  it('skips a pattern it cannot read the same way, and runs the rule\'s others', async () => {
    const rules = [withRegex(['\\bпривет\\b', 'z\\w+p', '[[:alpha:]]+orp', '(?P<n>zorp)', 'a\\_b', '(', 'gronk'])]
    expect(await regex(rules, ['zörp привет zorp a_b gronk'])).toEqual(hitAt(0, 21, 26))
    expect(await regex([withRegex(['\\bпривет\\b', 'z\\w+p'])], ['привет zörp zorp'])).toBeNull()
    expect(await regex([withRegex(['a\\-b'])], ['x A-B'])).toBeNull()
  })

  it('skips what is no pattern, and a list of patterns that is no list', async () => {
    expect(await regex([withRegex([null, 5, '', {}, 'gronk'])], ['a gronk'])).toEqual(hitAt(0, 2, 7))
    expect(await regex([withRegex('gronk')], ['gronk'])).toBeNull()
    expect(await regex([withRegex(['('])], ['a'])).toBeNull()
  })

  it('is kept to the rules that apply to the member, and to keyword rules that are on', async () => {
    expect(await regex([withRegex(['zorp'], { enabled: false })], ['zorp'])).toBeNull()
    expect(await regex([withRegex(['zorp'], { exempt_roles: [ROLE_A] })], ['zorp'], { memberRoleIds: [ROLE_A] })).toBeNull()
    expect(await regex([withRegex(['zorp'], { exempt_channels: [FORUM] })], ['zorp'], { channelIds: [FORUM] })).toBeNull()
    expect(await regex([withRegex(['zorp'])], ['zorp'], { isAdmin: true })).toBeNull()
    expect(await regex([withRegex(['zorp'], { exempt_roles: [ROLE_A] })], ['zorp'], { memberRoleIds: [ROLE_B] })).toEqual(hitAt(0, 0, 4))
  })

  it('is no part of what the matcher answers for a text, which is its keywords', async () => {
    const m = matcher([keywordRule(['gronk'], { regex_patterns: ['zor+p'] })])
    expect(m('zorp')).toBeNull()
    expect(m('gronk')).toEqual(hit(0, 5))
    expect(await m.regex(['zorp gronk'])).toEqual(hitAt(0, 0, 4))
  })

  it('answers {unchecked} for a text over 10,000 characters, at once, when a pattern would have to run, and only then', async () => {
    const rules = [withRegex(['needle'], { name: 'Pattern' }), keywordRule(['gronk'], {}, { name: 'Word' })]
    const ten = `${'x'.repeat(9_994)}needle`
    expect(ten).toHaveLength(10_000)
    expect(await regex(rules, [ten])).toEqual(hitAt(0, 9_994, 10_000, 'Pattern'))
    expect(await regex(rules, [`${ten}.`])).toEqual({ unchecked: true })
    expect(await regex(rules, ['fine', `${ten}.`])).toEqual({ unchecked: true })
    expect(await regex(rules, [`${ten}.`, 'needle'])).toEqual({ unchecked: true })
    // No pattern to run, no cap: the keywords read a text of any length that the form takes.
    expect(await regex([keywordRule(['gronk'])], ['x'.repeat(16_000)])).toBeNull()
    expect(await regex([withRegex(['needle'], { enabled: false })], ['x'.repeat(16_000)])).toBeNull()
    expect(await regex([withRegex(['('])], ['x'.repeat(16_000)])).toBeNull()
    expect(matcher(rules)(`${ten}. gronk`)).toEqual(hit(10_002, 10_007, 'Word'))
  })

  it('answers {unchecked} for a pattern that runs past the budget, and the next answer comes from a new worker', async () => {
    const m = matcher([withRegex([SLOW], { name: 'Slow' })])
    const started = performance.now()
    expect(await m.regex([slowText])).toEqual({ unchecked: true })
    const took = performance.now() - started
    expect(took).toBeGreaterThanOrEqual(240)
    expect(took).toBeLessThan(2_500)
    expect(await regex([withRegex(['zor+p'])], ['a zorp'])).toEqual(hitAt(0, 2, 6))
    expect(await m.regex(['aaa'])).toEqual(hitAt(0, 0, 3, 'Slow'))
  })

  it('gives up at the first slow pattern, and does not go on to the next rule, pattern or text', async () => {
    const m = matcher([withRegex([SLOW], { name: 'Slow' }), withRegex([SLOW, SLOW, SLOW], { name: 'Slower' }), withRegex(['zorp'], { name: 'Fast' })])
    const started = performance.now()
    expect(await m.regex([slowText, slowText, slowText, 'zorp'])).toEqual({ unchecked: true })
    expect(performance.now() - started).toBeLessThan(2_500)
  })

  it('does not hold up the server while it waits: the event loop keeps turning', async () => {
    const m = matcher([withRegex([SLOW])])
    let worst = 0
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 5)
    expect(await m.regex([slowText])).toEqual({ unchecked: true })
    clearInterval(tick)
    // About 6 ms (Node and Bun); the budget is 250.
    expect(worst).toBeLessThan(150)
  })

  it('counts an answer that came in the budget or later as it is: late is no answer, even one that says no match', async () => {
    const real = performance.now.bind(performance)
    const clock = vi.spyOn(performance, 'now')
    // The clock says what the code of the module asks it, and the real time to anybody else: the first reading is the time the job
    // was handed over, and every one after it is `gap` ms later.
    const run = async (gap, pattern = 'zorp') => {
      let readings = 0
      clock.mockImplementation(() => (new Error().stack.includes('librariusSend.js') ? (readings++ === 0 ? 1_000 : 1_000 + gap) : real()))
      return regex([withRegex([pattern])], ['a zorp'])
    }
    for (const gap of [0, 1, 100, 249, 249.9]) expect(await run(gap), String(gap)).toEqual(hitAt(0, 2, 6))
    for (const gap of [250, 250.1, 251, 1_000, 10_000]) expect(await run(gap), String(gap)).toEqual({ unchecked: true })
    expect(await run(10_000, 'nomatch')).toEqual({ unchecked: true })
    expect(await run(249, 'nomatch')).toBeNull()
  })

  it('keeps its worker from one answer to the next, which a new one for each would not do in time', async () => {
    const m = matcher([withRegex(['zorp'])])
    await m.regex(['warm'])
    const started = performance.now()
    for (let i = 0; i < 100; i++) expect(await m.regex(['a zorp'])).toEqual(hitAt(0, 2, 6))
    // A worker that is there answers in well under a millisecond (Node and Bun); starting one takes some 15 to 25 ms, so 100 of them
    // are some 2 seconds.
    expect(performance.now() - started).toBeLessThan(800)
  })

  it('leaves no listener on the worker for a job that is over, however many jobs it runs', async () => {
    const warnings = []
    const onWarning = (warning) => warnings.push(warning.name)
    // A new worker, for Node warns of too many listeners once for each worker, and the one the tests have used may have been told already.
    await scanInWorker({ rules: [['(']], texts: ['a'] })
    process.on('warning', onWarning)
    const m = matcher([withRegex(['zorp'])])
    for (let i = 0; i < 25; i++) expect(await m.regex(['a zorp'])).toEqual(hitAt(0, 2, 6))
    await new Promise((resolve) => setImmediate(resolve))
    process.off('warning', onWarning)
    expect(warnings).not.toContain('MaxListenersExceededWarning')
  })

  it('runs the jobs of replies that come together one after the other, each with its own budget', async () => {
    const slow = matcher([withRegex([SLOW], { name: 'Slow' })])
    const fast = matcher([withRegex(['zor+p'], { name: 'Fast' })])
    const started = performance.now()
    const [a, b, c] = await Promise.all([slow.regex([slowText]), fast.regex(['a zorp']), fast.regex(['nothing'])])
    expect(a).toEqual({ unchecked: true })
    expect(b).toEqual(hitAt(0, 2, 6, 'Fast'))
    expect(c).toBeNull()
    expect(performance.now() - started).toBeLessThan(3_000)
  })

  it('is told texts that are a list of strings', async () => {
    const m = matcher([withRegex(['zorp'])])
    for (const texts of [undefined, null, 'zorp', {}, [5], [null], ['a', undefined], new Set(['a'])]) {
      await expect(m.regex(texts), String(texts)).rejects.toThrow(new TypeError('the texts must be a list of strings'))
    }
    await expect(matcher([]).regex('x')).rejects.toThrow(TypeError)
  })

  it('does not change what it answers when the log it is given throws', async () => {
    const loud = automodMatcher([withRegex(['(', '\\w'], { name: 'Broken Log Rule' }), withRegex(['needle'])], {
      log: () => {
        throw new Error('the log is broken')
      },
    })
    expect(await loud.regex(['a needle'])).toEqual(hitAt(0, 2, 8))
    expect(loud('x')).toBeNull()
  })

  it('never puts a pattern or a text in what it logs', async () => {
    const lines = []
    const secret = 'zq9\\wxk'
    const m = automodMatcher([withRegex([secret], { name: 'Logged Once Rule' })], { log: (...args) => lines.push(args.join(' ')) })
    await m.regex(['member text zq9'])
    for (const line of lines) {
      expect(line).not.toContain('zq9')
      expect(line).not.toContain('member text')
    }
  })
})

describe('answerJob: what the child process says to a job', () => {
  it('is { found } of the scan, which is null when nothing matched', () => {
    expect(answerJob({ rules: [['zor+p']], texts: ['a zorrp'] })).toEqual({ found: { text: 0, rule: 0, start: 2, end: 7 } })
    expect(answerJob({ rules: [['zorp']], texts: ['nothing'] })).toEqual({ found: null })
  })

  it('is { failed: true } for a job that cannot be run, and never says what was in it', () => {
    for (const job of [{ rules: [['(']], texts: ['a'] }, { rules: [['a']], texts: [null] }, { rules: [['a']], texts: [5] }, { rules: [['a']], texts: 'x' }, { rules: 'a', texts: ['a'] }, { rules: [[5]], texts: ['a'] }, { rules: [5], texts: ['a'] }, {}, null, 5]) {
      expect(answerJob(job), JSON.stringify(job)).toEqual({ failed: true })
    }
  })
})

// What the runner is given in place of a child process, so that the time and what it says are the test's: a child that reads from its
// parent (`send`), is killed (`kill`), says things (`emit('message', ...)`), and ends (`emit('exit', ...)`).
class FakeChild extends EventEmitter {
  constructor(onSend = () => {}) {
    super()
    this.jobs = []
    this.signals = []
    this.onSend = onSend
  }

  send(job, callback) {
    this.jobs.push(job)
    this.onSend(job, callback)
  }

  kill(signal) {
    this.signals.push(signal)
    return true
  }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))
const JOB = { rules: [['zorp']], texts: ['a zorp'] }
const FOUND = { found: { text: 0, rule: 0, start: 2, end: 6 } }

describe('createRegexRunner: the jobs, the child they run in, and the time they have', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function runner(onSend) {
    const children = []
    const scan = createRegexRunner(() => {
      const child = new FakeChild(onSend)
      children.push(child)
      return child
    })
    return { children, scan }
  }
  const ready = async (child) => {
    child.emit('message', { ready: true })
    await flush()
  }

  it('sends a job to a child that is ready, and answers what the child answers', async () => {
    const { children, scan } = runner()
    const done = scan(JOB)
    expect(children).toHaveLength(1)
    expect(children[0].jobs).toEqual([])
    await ready(children[0])
    expect(children[0].jobs).toEqual([JOB])
    children[0].emit('message', FOUND)
    expect(await done).toEqual(FOUND)
    expect(children[0].signals).toEqual([])
    // What it listened for while the job was in the child is let go of: one `exit` and one `error` stay, for the child's own sake.
    expect(children[0].listenerCount('message')).toBe(0)
    expect(children[0].listenerCount('exit')).toBe(1)
    expect(children[0].listenerCount('error')).toBe(1)
  })

  it('answers { found: null } as it is: no match is an answer', async () => {
    const { children, scan } = runner()
    const done = scan(JOB)
    await ready(children[0])
    children[0].emit('message', { found: null })
    expect(await done).toEqual({ found: null })
  })

  it('keeps one child for the jobs after it, and starts none before the first job', async () => {
    const { children, scan } = runner((job, callback) => callback(null))
    expect(children).toHaveLength(0)
    const first = scan(JOB)
    await ready(children[0])
    children[0].emit('message', FOUND)
    await first
    const second = scan(JOB)
    await flush()
    children[0].emit('message', { found: null })
    expect(await second).toEqual({ found: null })
    expect(children).toHaveLength(1)
    expect(children[0].jobs).toEqual([JOB, JOB])
  })

  it('runs the jobs one at a time, in the order they came, each with the answer of its own', async () => {
    const { children, scan } = runner()
    const a = scan({ ...JOB, n: 'a' })
    const b = scan({ ...JOB, n: 'b' })
    const c = scan({ ...JOB, n: 'c' })
    await ready(children[0])
    expect(children[0].jobs.map((j) => j.n)).toEqual(['a'])
    children[0].emit('message', { found: { text: 0, rule: 0, start: 1, end: 2 } })
    await flush()
    expect(children[0].jobs.map((j) => j.n)).toEqual(['a', 'b'])
    children[0].emit('message', { found: { text: 0, rule: 0, start: 3, end: 4 } })
    await flush()
    children[0].emit('message', { found: null })
    expect(await a).toEqual({ found: { text: 0, rule: 0, start: 1, end: 2 } })
    expect(await b).toEqual({ found: { text: 0, rule: 0, start: 3, end: 4 } })
    expect(await c).toEqual({ found: null })
    expect(children).toHaveLength(1)
  })

  it('refuses the 10th job at once when the first is running and 8 wait, and runs all of the others', async () => {
    const { children, scan } = runner()
    const settled = []
    const jobs = Array.from({ length: 9 }, (_, i) => scan({ ...JOB, n: i }).then((answer) => (settled.push(i), answer)))
    expect(await scan(JOB)).toBeNull()
    expect(settled).toEqual([])
    await ready(children[0])
    for (let i = 0; i < 9; i++) {
      expect(children[0].jobs).toHaveLength(i + 1)
      children[0].emit('message', { found: { text: i, rule: 0, start: 0, end: 1 } })
      await flush()
    }
    const answers = await Promise.all(jobs)
    expect(answers.map((a) => a.found.text)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(children[0].jobs.map((j) => j.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('takes a job again once the line has gone down, and refuses none while 8 wait or fewer', async () => {
    const { children, scan } = runner()
    const jobs = Array.from({ length: 9 }, () => scan(JOB))
    await ready(children[0])
    for (let i = 0; i < 9; i++) {
      children[0].emit('message', { found: null })
      await flush()
    }
    expect(await Promise.all(jobs)).toEqual(Array(9).fill({ found: null }))
    const again = scan(JOB)
    await flush()
    children[0].emit('message', FOUND)
    expect(await again).toEqual(FOUND)
  })

  it('does not count the time a child takes to start, but gives the job its 250 ms from the moment it is sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { children, scan } = runner()
    const done = scan(JOB)
    await vi.advanceTimersByTimeAsync(1_500)
    await ready(children[0])
    expect(children[0].jobs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(249)
    children[0].emit('message', FOUND)
    expect(await done).toEqual(FOUND)
    expect(children[0].signals).toEqual([])
    // No timer is left to fire for a job that is over, nor for a child that said it was ready.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers null for a job not answered in 250 ms, kills the child, forgets it, and starts a new one for the next job', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { children, scan } = runner()
    let answer = 'pending'
    const done = scan(JOB).then((a) => (answer = a))
    await ready(children[0])
    await vi.advanceTimersByTimeAsync(249)
    expect(answer).toBe('pending')
    expect(children[0].signals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(answer).toBeNull()
    expect(children[0].signals).toEqual(['SIGKILL'])
    const next = scan(JOB)
    expect(children).toHaveLength(2)
    await ready(children[1])
    children[1].emit('message', FOUND)
    expect(await next).toEqual(FOUND)
    // Whatever the first child says or does now is nobody's answer, and does not make the child that is in use one that is forgotten.
    children[0].emit('message', { found: null })
    children[0].emit('exit', null, 'SIGKILL')
    expect(children[1].signals).toEqual([])
    const third = scan(JOB)
    await flush()
    children[1].emit('message', FOUND)
    expect(await third).toEqual(FOUND)
    expect(children).toHaveLength(2)
  })

  it('does not start the clock of the next job in the time that the one before it takes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { children, scan } = runner()
    const a = scan(JOB)
    const b = scan(JOB)
    await ready(children[0])
    await vi.advanceTimersByTimeAsync(200)
    children[0].emit('message', FOUND)
    await a
    await vi.advanceTimersByTimeAsync(200)
    children[0].emit('message', FOUND)
    expect(await b).toEqual(FOUND)
    expect(children).toHaveLength(1)
  })

  it('does not take an answer that came in the budget or later for one, and kills the child', async () => {
    const real = performance.now.bind(performance)
    const clock = vi.spyOn(performance, 'now')
    for (const [gap, expected] of [[249.9, FOUND], [250, null], [10_000, null]]) {
      let readings = 0
      clock.mockImplementation(() => (new Error().stack.includes('librariusSend.js') ? (readings++ === 0 ? 1_000 : 1_000 + gap) : real()))
      const { children, scan } = runner()
      const done = scan(JOB)
      await ready(children[0])
      children[0].emit('message', FOUND)
      expect(await done, String(gap)).toEqual(expected)
      expect(children[0].signals, String(gap)).toEqual(expected === null ? ['SIGKILL'] : [])
    }
  })

  it('fails a child that is not ready in 2 seconds: every job that waits is answered null, the child is killed, and the next job starts a new one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { children, scan } = runner()
    const answers = {}
    const jobs = [1, 2, 3].map((i) => scan(JOB).then((a) => (answers[i] = a)))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(answers).toEqual({})
    expect(children[0].signals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all(jobs)
    expect(answers).toEqual({ 1: null, 2: null, 3: null })
    expect(children).toHaveLength(1)
    expect(children[0].signals).toEqual(['SIGKILL'])
    expect(children[0].jobs).toEqual([])
    const next = scan(JOB)
    expect(children).toHaveLength(2)
    await ready(children[1])
    children[1].emit('message', FOUND)
    expect(await next).toEqual(FOUND)
  })

  it('does not take a late "ready" for a child that was failed, and runs jobs that come after it on the new one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { children, scan } = runner()
    const first = scan(JOB)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await first).toBeNull()
    const second = scan(JOB)
    children[0].emit('message', { ready: true })
    await flush()
    expect(children[0].jobs).toEqual([])
    await ready(children[1])
    expect(children[1].jobs).toEqual([JOB])
    children[1].emit('message', FOUND)
    expect(await second).toEqual(FOUND)
  })

  it('ignores a message that is not "ready" while it waits for it', async () => {
    const { children, scan } = runner()
    const done = scan(JOB)
    for (const message of [{ found: null }, {}, null, 'ready', 5, { ready: 'yes' }, { ready: false }, []]) children[0].emit('message', message)
    await flush()
    expect(children[0].jobs).toEqual([])
    await ready(children[0])
    expect(children[0].jobs).toEqual([JOB])
    children[0].emit('message', FOUND)
    expect(await done).toEqual(FOUND)
  })

  it('answers null at once, for the waiting jobs too, when the child ends or fails before it is ready, and the next job starts a new one', async () => {
    for (const event of [['exit', 1, null], ['exit', null, 'SIGKILL'], ['error', new Error('spawn failed')]]) {
      const { children, scan } = runner()
      const jobs = [scan(JOB), scan(JOB)]
      children[0].emit(...event)
      expect(await Promise.all(jobs), event[0]).toEqual([null, null])
      expect(children[0].jobs).toEqual([])
      const next = scan(JOB)
      expect(children).toHaveLength(2)
      await ready(children[1])
      children[1].emit('message', FOUND)
      expect(await next).toEqual(FOUND)
    }
  })

  it('answers null for a job when the child ends in the middle of it, which is no answer of "no match", and starts a new one for the next', async () => {
    for (const event of [['exit', 1, null], ['exit', null, 'SIGSEGV'], ['error', new Error('broken pipe')]]) {
      const { children, scan } = runner()
      const done = scan(JOB)
      await ready(children[0])
      const started = performance.now()
      children[0].emit(...event)
      expect(await done, event[0]).toBeNull()
      expect(performance.now() - started).toBeLessThan(200)
      const next = scan(JOB)
      expect(children).toHaveLength(2)
      await ready(children[1])
      children[1].emit('message', FOUND)
      expect(await next).toEqual(FOUND)
    }
  })

  it('starts a new child for the next job when the one it had ends between two jobs', async () => {
    const { children, scan } = runner()
    const first = scan(JOB)
    await ready(children[0])
    children[0].emit('message', FOUND)
    await first
    children[0].emit('exit', 1, null)
    const second = scan(JOB)
    expect(children).toHaveLength(2)
    await ready(children[1])
    children[1].emit('message', FOUND)
    expect(await second).toEqual(FOUND)
  })

  it('does not end the process for an error of the child, which ends the job it is in, and the next job starts a new child', async () => {
    const { children, scan } = runner()
    const first = scan(JOB)
    await ready(children[0])
    expect(() => children[0].emit('error', new Error('x'))).not.toThrow()
    expect(await first).toBeNull()
    const second = scan(JOB)
    await ready(children[1])
    children[1].emit('message', FOUND)
    expect(await second).toEqual(FOUND)
    expect(() => children[1].emit('error', new Error('later'))).not.toThrow()
    expect(() => children[0].emit('error', new Error('later still'))).not.toThrow()
  })

  it('takes nothing for an answer that has no `found`, and kills the child that said it', async () => {
    for (const message of [{}, { failed: true }, null, 'found', 5, [], { found: undefined }, { ready: true }]) {
      const { children, scan } = runner()
      const done = scan(JOB)
      await ready(children[0])
      children[0].emit('message', message)
      expect(await done, JSON.stringify(message)).toBeNull()
      expect(children[0].signals).toEqual(['SIGKILL'])
    }
  })

  it('answers null for a job that cannot be sent: a refusal of the channel, or a job it cannot write', async () => {
    const refusing = runner((job, callback) => callback(new Error('channel closed')))
    const a = refusing.scan(JOB)
    await ready(refusing.children[0])
    const started = performance.now()
    expect(await a).toBeNull()
    // At once, and not when the 250 ms are over.
    expect(performance.now() - started).toBeLessThan(150)
    expect(refusing.children[0].signals).toEqual(['SIGKILL'])

    const throwing = runner(() => {
      throw new TypeError('cannot write')
    })
    const b = throwing.scan(JOB)
    await ready(throwing.children[0])
    const throwingStarted = performance.now()
    expect(await b).toBeNull()
    expect(performance.now() - throwingStarted).toBeLessThan(150)
    expect(throwing.children[0].signals).toEqual(['SIGKILL'])

    const next = throwing.scan(JOB)
    expect(throwing.children).toHaveLength(2)
    await ready(throwing.children[1])
    expect(await next).toBeNull()
  })

  it('takes the callback of a send that went well for nothing', async () => {
    const { children, scan } = runner((job, callback) => callback(null))
    const done = scan(JOB)
    await ready(children[0])
    children[0].emit('message', FOUND)
    expect(await done).toEqual(FOUND)
  })

  it('rejects the job, and not the ones after it, when a child cannot be started at all', async () => {
    let starts = 0
    const scan = createRegexRunner(() => {
      if (starts++ === 0) throw new Error('cannot start')
      const child = new FakeChild()
      queueMicrotask(() => child.emit('message', { ready: true }))
      child.onSend = () => queueMicrotask(() => child.emit('message', FOUND))
      return child
    })
    const [a, b] = await Promise.allSettled([scan(JOB), scan(JOB)])
    expect(a.status).toBe('rejected')
    expect(a.reason.message).toBe('cannot start')
    expect(b).toEqual({ status: 'fulfilled', value: FOUND })
  })

  it('gives each job that comes together with others the answer that the child gave to it, and no other', async () => {
    const { children, scan } = runner()
    const jobs = Array.from({ length: 9 }, (_, i) => scan({ rules: [['x']], texts: [`t${i}`], n: i }))
    await ready(children[0])
    for (let i = 0; i < 9; i++) {
      expect(children[0].jobs[i].n).toBe(i)
      children[0].emit('message', { found: { text: i, rule: 0, start: i, end: i + 1 } })
      await flush()
    }
    const answers = await Promise.all(jobs)
    answers.forEach((answer, i) => expect(answer).toEqual({ found: { text: i, rule: 0, start: i, end: i + 1 } }))
  })
})

describe('scanInWorker: the one child process, the real one', () => {
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  const IPC = { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'json', env: {} }
  const WORKER = new URL('./librariusRegexWorker.js', import.meta.url).href
  // A child that is made by a script of the test, in place of the one of the module.
  const standIn = (script) => () => spawn(process.execPath, ['--input-type=module', '-e', script], IPC)
  // The module's own child, with what the test needs to know of each: its pid, and the time it was over.
  function recording(make = spawnRegexWorker) {
    const children = []
    const scan = createRegexRunner(() => {
      const child = make()
      children.push({ pid: child.pid, ended: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))) })
      return child
    })
    return { children, scan }
  }
  const SLOW = { rules: [['(a+)+$']], texts: [`${'a'.repeat(60)}!`] }
  const FAST = { rules: [['a']], texts: ['xa'] }
  const FAST_FOUND = { found: { text: 0, rule: 0, start: 1, end: 2 } }

  it('answers { found } of a job, and the same job again', async () => {
    const job = { rules: [['zor+p']], texts: ['a zorrp'] }
    expect(await scanInWorker(job)).toEqual({ found: { text: 0, rule: 0, start: 2, end: 7 } })
    expect(await scanInWorker(job)).toEqual({ found: { text: 0, rule: 0, start: 2, end: 7 } })
    expect(await scanInWorker({ rules: [['x']], texts: ['a'] })).toEqual({ found: null })
  })

  it('answers null for a job that cannot be run, a pattern that does not compile, and the next job is answered', async () => {
    expect(await scanInWorker({ rules: [['(']], texts: ['a'] })).toBeNull()
    expect(await scanInWorker(FAST)).toEqual(FAST_FOUND)
  })

  it('answers null for a job that cannot be written to the child, and the jobs after it still run', async () => {
    // With a child that is ready, so that what is timed is the job and not the start of a child.
    expect(await scanInWorker(FAST)).toEqual(FAST_FOUND)
    const started = performance.now()
    expect(await scanInWorker({ rules: [['a']], texts: [1n] })).toBeNull()
    expect(performance.now() - started).toBeLessThan(150)
    expect(await scanInWorker(FAST)).toEqual(FAST_FOUND)
  })

  it('kills the child of a job that runs past the budget: its pid is gone, and the next job is answered by a new child', async () => {
    const { children, scan } = recording()
    const started = performance.now()
    expect(await scan(SLOW)).toBeNull()
    const took = performance.now() - started
    expect(took).toBeGreaterThanOrEqual(240)
    expect(took).toBeLessThan(2_500)
    expect(children).toHaveLength(1)
    expect((await children[0].ended).signal).toBe('SIGKILL')
    expect(alive(children[0].pid)).toBe(false)
    expect(await scan(FAST)).toEqual(FAST_FOUND)
    expect(children).toHaveLength(2)
    expect(children[1].pid).not.toBe(children[0].pid)
    expect(alive(children[1].pid)).toBe(true)
    process.kill(children[1].pid, 'SIGKILL')
  })

  it('kills the child of every job that goes over, one after the other, and leaves none running', async () => {
    const { children, scan } = recording()
    for (let i = 0; i < 3; i++) expect(await scan(SLOW)).toBeNull()
    expect(children).toHaveLength(3)
    for (const child of children) {
      expect((await child.ended).signal).toBe('SIGKILL')
      expect(alive(child.pid)).toBe(false)
    }
  })

  it('answers null for a job in whose middle the child ends, long before the budget, and the next job is answered', async () => {
    let made = 0
    let readyAt = null
    const { children, scan } = recording(() => {
      if (made++ > 0) return spawnRegexWorker()
      const child = standIn("process.on('message', () => process.exit(1)); process.send({ ready: true })")()
      // The first thing it says is that it is ready: what is timed is the job, and not how long a process takes to start.
      child.once('message', () => (readyAt = performance.now()))
      return child
    })
    expect(await scan(FAST)).toBeNull()
    expect(performance.now() - readyAt).toBeLessThan(240)
    expect((await children[0].ended).code).toBe(1)
    expect(await scan(FAST)).toEqual(FAST_FOUND)
    expect(children).toHaveLength(2)
    process.kill(children[1].pid, 'SIGKILL')
  })

  it('does not count the time a child takes to start in the budget of its first job', async () => {
    const { children, scan } = recording(standIn(`setTimeout(() => import(${JSON.stringify(WORKER)}), 600)`))
    const started = performance.now()
    expect(await scan(FAST)).toEqual(FAST_FOUND)
    expect(performance.now() - started).toBeGreaterThanOrEqual(600)
    process.kill(children[0].pid, 'SIGKILL')
  })

  it('answers null at once for a child that cannot be started, and starts another for the next job', async () => {
    let made = 0
    const { children, scan } = recording(() => (made++ === 0 ? spawn('/nonexistent/librarius-regex-child', [], IPC) : spawnRegexWorker()))
    const started = performance.now()
    expect(await scan(FAST)).toBeNull()
    expect(performance.now() - started).toBeLessThan(1_500)
    expect(await scan(FAST)).toEqual(FAST_FOUND)
    expect(children).toHaveLength(2)
    process.kill(children[1].pid, 'SIGKILL')
  })

  it('starts a new child for the next job when the one it had was killed from outside between two jobs', async () => {
    const { children, scan } = recording()
    expect(await scan(FAST)).toEqual(FAST_FOUND)
    process.kill(children[0].pid, 'SIGKILL')
    await children[0].ended
    expect(await scan(FAST)).toEqual(FAST_FOUND)
    expect(children).toHaveLength(2)
    process.kill(children[1].pid, 'SIGKILL')
  })

  it('gives each of many jobs that come together the answer of its own', async () => {
    const jobs = Array.from({ length: 9 }, (_, i) => ({ rules: [[`t${i}x`], [`t${i}`]], texts: ['nothing', `a t${i}x b`] }))
    const answers = await Promise.all(jobs.map((job) => scanInWorker(job)))
    answers.forEach((answer, i) => expect(answer, String(i)).toEqual({ found: { text: 1, rule: 0, start: 2, end: 4 + String(i).length } }))
  })

  it('gives each of the replies that come together the answer of its own, whatever its rule and its text', async () => {
    const asked = Array.from({ length: 9 }, (_, i) => {
      const m = matcher([keywordRule([], { regex_patterns: [`token${i}`] }, { name: `Rule ${i}` })])
      return { i, answer: m.regex(['nothing', `a token${i} here`]) }
    })
    for (const { i, answer } of asked) expect(await answer, String(i)).toEqual({ rule: `Rule ${i}`, text: 1, start: 2, end: 8 })
  })

  it('does not give the child what the server keeps in its environment', async () => {
    if (process.platform !== 'linux') return
    process.env.LIBRARIUS_TEST_SECRET = 'not-for-the-child'
    try {
      const { children, scan } = recording()
      expect(await scan(FAST)).toEqual(FAST_FOUND)
      const names = readFileSync(`/proc/${children[0].pid}/environ`, 'utf8').split('\0').filter(Boolean).map((entry) => entry.split('=')[0])
      expect(names.every((name) => name.startsWith('NODE_CHANNEL'))).toBe(true)
      process.kill(children[0].pid, 'SIGKILL')
    } finally {
      delete process.env.LIBRARIUS_TEST_SECRET
    }
  })

  it('starts the child in the folder of its own file, where Bun finds no `.env` of the server to read into its environment', async () => {
    if (process.platform !== 'linux') return
    const { children, scan } = recording()
    expect(await scan(FAST)).toEqual(FAST_FOUND)
    const folder = dirname(fileURLToPath(new URL('./librariusRegexWorker.js', import.meta.url)))
    expect(realpathSync(readlinkSync(`/proc/${children[0].pid}/cwd`))).toBe(realpathSync(folder))
    process.kill(children[0].pid, 'SIGKILL')
  })

  // A process that runs a script of the test, with what it prints and how it ended.
  const runScript = (script) =>
    new Promise((resolve) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000, env: {} }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : error.code, stdout, stderr }))
    })
  const SEND = JSON.stringify(new URL('./librariusSend.js', import.meta.url).href)

  it('kills the child it has when its own process exits, even one that is in the middle of a job', async () => {
    const run = await runScript(`
      import { createRegexRunner, spawnRegexWorker } from ${SEND}
      const scan = createRegexRunner(() => { const c = spawnRegexWorker(); console.log(c.pid); return c })
      scan({ rules: [['(a+)+$']], texts: ['a'.repeat(60) + '!'] })
      setTimeout(() => process.exit(0), 200)
    `)
    expect(run.code).toBe(0)
    const pid = Number(run.stdout)
    expect(pid).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(pid)).toBe(false)
  })

  it('kills what each runner has now, the ones that have a child and the ones that have none', async () => {
    // What runs when the process exits, run by hand: it kills the child of every runner of this file, the one of the module too, which the
    // next job of that one finds gone and starts another for.
    // A runner that has been given no job, and so has no child.
    createRegexRunner(() => new FakeChild())
    const children = []
    const busy = createRegexRunner(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const job = busy(JOB)
    children[0].emit('message', { ready: true })
    await flush()
    expect(children[0].signals).toEqual([])
    killRunners()
    expect(children[0].signals).toEqual(['SIGKILL'])
    children[0].emit('exit', null, 'SIGKILL')
    expect(await job).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await scanInWorker(FAST)).toEqual(FAST_FOUND)
  })

  it('has one thing to do when its process exits, whatever the number of runners, and nothing to say when there is no child', async () => {
    const run = await runScript(`
      import { createRegexRunner, spawnRegexWorker } from ${SEND}
      const before = process.listenerCount('exit')
      const runners = Array.from({ length: 30 }, () => createRegexRunner(spawnRegexWorker))
      console.log(process.listenerCount('exit') - before)
      // One that had a child that was killed, and so has none now.
      const answer = await runners[0]({ rules: [['(a+)+$']], texts: ['a'.repeat(60) + '!'] })
      console.log(answer)
    `)
    expect(run.stdout.trim().split('\n')).toEqual(['0', 'null'])
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
  })

  it('does not keep a process alive that has nothing else to do, and the child goes with it', async () => {
    const script = `
      import { createRegexRunner, spawnRegexWorker } from ${JSON.stringify(new URL('./librariusSend.js', import.meta.url).href)}
      const pids = []
      const scan = createRegexRunner(() => { const c = spawnRegexWorker(); pids.push(c.pid); return c })
      const answer = await scan({ rules: [['a']], texts: ['xa'] })
      console.log(JSON.stringify({ answer, pids }))
    `
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000, env: {} }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    })
    const { answer, pids } = JSON.parse(out)
    expect(answer).toEqual(FAST_FOUND)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(pids[0])).toBe(false)
  })
})

// The tests that time a walk take long where Stryker's instrumented copy of the module runs them (every line asks which mutant is on),
// far over the 5 s that a test has.
const TIMED = { timeout: 120_000 }

// Under Stryker these runs of n against 8n, each taken several times and measured again, take longer than even TIMED allows, once
// for every mutant. They guard how the work grows with the text. A mutant that stops a walk advancing is a hang, which Stryker counts
// as a kill, so the mutation run leaves them out.
describe.skipIf(process.env.STRYKER_MUTATOR_WORKER)('automodMatcher: it stays linear in the length of the text', TIMED, () => {
  // One word of 16,000 characters, which the old reading walked end to end for every place a keyword met it: seconds, on Bun
  // 7 s for `*ass*` and 20 s for `*a*`.
  const word = (unit, n = 16_000) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)

  it('measures what it says it does: a walk that is quadratic is over the ratio, and a linear one is under it', () => {
    const quadratic = (n) => () => {
      let sum = 0
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j += 8) sum += i ^ j
      return sum
    }
    const linear = (n) => () => {
      let sum = 0
      for (let i = 0; i < n * 64; i++) sum += i ^ 3
      return sum
    }
    expect(measured(quadratic, 2_000, false).ratio).toBeGreaterThan(RATIO)
    expect(measured(linear, 2_000, true).ratio).toBeLessThan(RATIO)
  })

  it('answers `*a*`, `*ab*` and `*ass*` over one long word, and says where', () => {
    for (const [keyword, unit] of [['*a*', 'a'], ['*ab*', 'ab'], ['*ass*', 'ass'], ['*a*', 'ab'], ['*ass*', 'bass']]) {
      expect(find([keyword], word(unit)), keyword + unit).toEqual(hit(0, 16_000))
    }
  })

  it('takes four times as long for four times the word, with `*a*` and `*ass*`', () => {
    for (const [keyword, unit] of [['*a*', 'a'], ['*ass*', 'ass'], ['*ass*', 'bass']]) {
      expectLinear(keyword + unit, (n) => {
        const text = word(unit, n)
        const m = matcher([keywordRule([keyword])])
        return () => m(text)
      })
    }
  })

  it('reads the edges of a word right beside a character of the last place of the plane, which is one unit and no letter', () => {
    expect(find(['\uffff*'], '\uffffbc')).toEqual(hit(0, 3))
    expect(find(['*\uffff'], 'ab\uffff')).toEqual(hit(0, 3))
    expect(find(['*\uffff*'], 'ab\uffffcd ef')).toEqual(hit(0, 5))
    expect(find(['\uffff'], 'ab\uffffcd')).toBeNull()
  })

  it('reads the edges of a word that holds pairs, which are two units and one letter', () => {
    expect(find(['*zorp'], '\u{10428}\u{10428}zorp')).toEqual(hit(0, 8))
    expect(find(['zorp*'], 'zorp\u{10428}\u{10428}')).toEqual(hit(0, 8))
    expect(find(['*zorp*'], 'a \u{10428}zorp\u{10428} b')).toEqual(hit(2, 10))
    expect(find(['zorp'], '\u{10428}zorp')).toBeNull()
  })

  it('answers a prefix and a suffix keyword over one long word', () => {
    const text = word('a')
    for (const [keywords, expected] of [[['a*'], hit(0, 16_000)], [['*a'], hit(0, 16_000)], [['aa*'], hit(0, 16_000)], [['*aa'], hit(0, 16_000)], [['a'], null], [['ab*'], null], [['*ba'], null], [['*a*b'], null]]) {
      expect(find(keywords, text), keywords.join()).toEqual(expected)
    }
  })

  it('takes four times as long for four times the word, with a prefix, a suffix, a whole word and a wildcard in the middle', () => {
    for (const keywords of [['a*'], ['*aa'], ['a'], ['*a*b']]) {
      expectLinear(keywords.join(), (n) => {
        const text = word('a', n)
        const m = matcher([keywordRule(keywords)])
        return () => m(text)
      })
    }
  })

  it('takes four times as long for four times the word, whatever the word is made of, when every place the keyword meets it is a match', () => {
    for (const unit of ['𐐨', 'a\u200b', 'a*', 'a ']) {
      // `a ` is the one that tells a string that is flattened for each space: a ratio of 9.4 for that, and 4 for the walk that is not.
      expectLinear(JSON.stringify(unit), (n) => {
        const text = word(unit, n)
        const m = matcher([keywordRule(['*a*', '*𐐨*', '*é*'])])
        return () => m(text)
      })
    }
  })

  it('lets an allow entry that is free at both ends cover the match of a place it did not start from, in a word that has no letters in it', () => {
    // `*a1*` matches at 0 (the word is the letter at 2 as well: it ends at 3) and at 2 (it ends at 4): the second is the one that covers `a1` there.
    expect(find(['a1'], 'a1a1', { allow_list: ['*a1*'] })).toBeNull()
    expect(find(['a1'], 'a1a1')).toEqual(hit(2, 4))
    expect(find(['a1'], 'a1a1 a1', { allow_list: ['*a1*'] })).toBeNull()
    expect(find(['1a'], 'a1a1', { allow_list: ['*1a*'] })).toBeNull()
  })

  it('stops at the first match the allow list does not cover, and walks the rest only while it does', () => {
    const text = word('a')
    // Every match is inside the word, which the allow list covers: all of them are looked at, each in a moment.
    expect(find(['*a*'], text, { allow_list: ['*a*'] })).toBeNull()
    // The first word is covered, in every one of its 8,000 places; the second is not, and is what is found.
    expect(find(['*a*'], `${'a'.repeat(8_000)} ${'a'.repeat(7_000)}`, { allow_list: [`*${'a'.repeat(7_500)}*`] })).toEqual(hit(8_001, 15_001))
    expect(find(['*a*'], `${'a'.repeat(7_000)} ${'a'.repeat(8_000)}`, { allow_list: [`*${'a'.repeat(7_500)}*`] })).toEqual(hit(0, 7_000))
    expect(find(['a*', '*a', '*a*'], text, { allow_list: ['*aa*', 'a*', '*a'] })).toBeNull()
  })

  it('takes four times as long for four times the word, with an allow list that covers every match, and with several rules', () => {
    for (const [keywords, allow] of [[['*a*'], ['*a*']], [['*a*a*'], ['*a*']], [['a*', '*a', '*a*'], ['*aa*', 'a*', '*a']]]) {
      expectLinear(`${keywords} / ${allow}`, (n) => {
        const text = word('a', n)
        const m = matcher([keywordRule(keywords, { allow_list: allow })])
        return () => m(text)
      })
    }
  })

  it('takes no longer for 100 allow entries that overlap on one word of 11,000 characters, which each cover every match', () => {
    const allow = Array.from({ length: 100 }, (_, i) => `*${'a'.repeat(i + 1)}*`)
    const text = word('a', 11_000)
    const m = matcher([keywordRule(['*a*'], { allow_list: allow })])
    expect(m(text)).toBeNull()
    // 5 to 13 ms (Node and Bun); the walk that looks at every place that each of the 100 entries matches at, which is 1.1 million
    // matches and 55 million comparisons, took 150 to 250 ms, and takes about 4 times that in Stryker's copy of the module.
    expect(timeOf(() => m(text))).toBeLessThan(150)
  })

  it('takes about as long for 200 copies of a keyword of one piece as for one, over one word of 11,000 characters that the allow list covers', () => {
    // A keyword of one piece is skipped to the end of the word after its first match, whatever the length of its first piece (one unit, which
    // the index looks up whole, or more, which is compared with the text): about 2.5 to 4 times as long for 200 copies (a look at where each
    // is skipped to, at every place). A match at every place for each, and a comparison of a first piece of 60 letters at every place, are
    // 27 and 52 times as long. A ratio, and not a time, so that Stryker's slower copy of the module is held to the same.
    const text = word('a', 11_000)
    for (const keyword of ['*a*', '*aa*', `*${'a'.repeat(60)}*`]) {
      const one = matcher([keywordRule([keyword], { allow_list: ['*a*'] })])
      const copies = matcher([keywordRule(Array(200).fill(keyword), { allow_list: ['*a*'] })])
      expect(copies(text), keyword).toBeNull()
      expect(matcher([keywordRule(Array(200).fill(keyword))])(text), keyword).toEqual(hit(0, 11_000))
      expect(versus(() => one(text), () => copies(text), 10).ratio, keyword).toBeLessThan(10)
    }
  })

  it('answers a text of many short words, and a keyword in all of them', () => {
    const text = 'ass '.repeat(4_000)
    for (const keywords of [['*ass*'], ['ass'], ['ass*'], ['*ass']]) expect(find(keywords, text), keywords.join()).toEqual(hit(0, 3))
    expect(find(['*ass*'], text, { allow_list: ['ass'] })).toBeNull()
  })

  it('takes four times as long for four times the words, when there are many short ones', () => {
    for (const [keywords, allow] of [[['*ass*'], []], [['ass'], []], [['*ass*'], ['ass']]]) {
      expectLinear(`${keywords} / ${allow}`, (n) => {
        const text = 'ass '.repeat(n / 4)
        const m = matcher([keywordRule(keywords, { allow_list: allow })])
        return () => m(text)
      })
    }
  })
})

describe('automodMatcher: keywords of several pieces and joiners that are no letters, against a plain list of every span', () => {
  // The spans of a keyword as it is written for Discord's filter, worked out the plain way: every place of the first piece is looked at,
  // none is skipped, every place of each later piece within its reach is tried in turn until the rest follows (the first way through, by
  // the places of the pieces in order), and the allow list is every one of its spans (a span lies inside the allow list when any one of
  // them holds it). The text is made of the letters a to c and x, `-` and `1` (which end a word and are no space), and single spaces.
  // `firstOnly` is the reading that took the first place of a middle piece and no other, which an early decoy of the piece led astray: the
  // reading of the keywords before rB8's M1, and the reading of the allow list now (`allowFirstOnly`, which is `firstOnly` unless it is given).
  const letter = (c) => c !== undefined && ((c >= 'a' && c <= 'c') || c === 'x')
  const MAX_GAP = 60
  const reachOf = (t, pos, pieces, k, needEdge, firstOnly) => {
    if (k === pieces.length) return needEdge && letter(t[pos]) ? -1 : pos
    for (let p = pos; p <= pos + MAX_GAP; p++) {
      if (t.startsWith(pieces[k], p)) {
        const end = reachOf(t, p + pieces[k].length, pieces, k + 1, needEdge, firstOnly)
        if (end !== -1 || (firstOnly && k !== pieces.length - 1)) return end
      }
      if (t[p] === ' ') break
    }
    return -1
  }
  const spansOf = (t, k, firstOnly = false) => {
    const out = []
    for (let i = t.indexOf(k.pieces[0]); i !== -1; i = t.indexOf(k.pieces[0], i + 1)) {
      const inside = letter(t[i - 1])
      if (!k.lead && inside) continue
      const stop = reachOf(t, i + k.pieces[0].length, k.pieces.slice(1), 0, !k.trail, firstOnly)
      if (stop === -1) continue
      let a = i
      if (inside) while (letter(t[a - 1])) a--
      let b = stop
      while (letter(t[b])) b++
      out.push([a, b])
    }
    return out
  }
  const modelOf = (t, keywords, allow, firstOnly = false, allowFirstOnly = firstOnly) => {
    const held = allow.flatMap((k) => spansOf(t, k, allowFirstOnly))
    let best = null
    for (const k of keywords) {
      const found = spansOf(t, k, firstOnly).find(([a, b]) => !held.some(([c, d]) => c <= a && b <= d))
      if (found !== undefined && (best === null || found[0] < best.start)) best = { start: found[0], end: found[1] }
    }
    return best === null ? null : { rule: 'Test Rule', ...best }
  }
  const written = (k) => `${k.lead ? '*' : ''}${k.pieces.join('*')}${k.trail ? '*' : ''}`

  it('does not let a skip over the places that a free-ended keyword of one piece has taken in lose the match that a keyword of several pieces has further on', () => {
    // `*a*b*c` matches at the first `a` (as `abac`, which the allow list holds) and at the second (as `abac-bc`, which it does not): the
    // second starts inside the span of the first, and reaches past it.
    for (const keyword of ['*a*b*c', '*a*b*c*']) {
      expect(find([keyword], 'abac-bc', { allow_list: ['abac'] }), keyword).toEqual(hit(0, 7))
      expect(find([keyword], 'abac-bc'), keyword).toEqual(hit(0, 4))
    }
    expect(find(['*a*b*c'], 'abac-bc', { allow_list: ['abac', '*abac-bc*'] })).toBeNull()
  })

  it('finds the first match that the allow list does not hold, as the list of every span says, for keywords of up to 3 pieces and allow entries made of the text', () => {
    const piece = fc.constantFrom('a', 'b', 'c', 'ab', 'bc', 'a-', '-b', '1', 'a b', '-')
    const keyword = fc.record({ pieces: fc.array(piece, { minLength: 1, maxLength: 3 }), lead: fc.boolean(), trail: fc.boolean() })
    const token = fc.constantFrom('a', 'b', 'c', 'ab', 'bc', 'ba', 'aba', '-', '1', '-1', ' ')
    const text = fc
      .array(token, { minLength: 1, maxLength: 10 })
      .map((list) => list.join('').replace(/ {2,}/g, ' ').trim())
      .filter((t) => t !== '')
    // An entry of the allow list is a piece or two of the text itself, with or without a `*` at its ends.
    const entryOf = (t) =>
      fc.record({
        pieces: fc.array(fc.tuple(fc.nat(t.length), fc.nat(t.length)).map(([i, j]) => t.slice(Math.min(i, j), Math.max(i, j) + 1).trim()).filter((p) => p !== ''), { minLength: 1, maxLength: 2 }),
        lead: fc.boolean(),
        trail: fc.boolean(),
      })
    // And texts of words that are cut by `-` and `1` where the pieces are letters only and free at the start, with allow entries that are the
    // words of the text or a piece of its start: where a later start inside a word can reach past the first, and the allow list holds the first.
    const letters = fc.constantFrom('a', 'b', 'c', 'ab', 'ba')
    const joined = fc
      .array(fc.constantFrom('a', 'b', 'c', 'ab', 'bc', 'ba', 'aba', 'abc', '-', '1'), { minLength: 3, maxLength: 12 })
      .map((list) => list.join(''))
      .chain((t) => {
        const words = t.split(/[-1 ]+/).filter((w) => w !== '')
        const entry = fc.record({ pieces: fc.constantFrom(...words, t.slice(0, 4), t.slice(0, 5)).map((w) => [w]), lead: fc.boolean(), trail: fc.boolean() })
        return fc.tuple(fc.constant(t), fc.array(fc.record({ pieces: fc.array(letters, { minLength: 1, maxLength: 3 }), lead: fc.boolean(), trail: fc.boolean() }), { minLength: 1, maxLength: 2 }), fc.array(entry, { minLength: 1, maxLength: 2 }))
      })
    fc.assert(
      fc.property(
        fc.oneof(text.chain((t) => fc.tuple(fc.constant(t), fc.array(keyword, { minLength: 1, maxLength: 3 }), fc.array(entryOf(t), { maxLength: 3 }))), joined),
        ([t, keywords, allow]) => {
          const m = matcher([keywordRule(keywords.map(written), { allow_list: allow.map(written) })])
          expect(m(t), JSON.stringify({ t, keywords: keywords.map(written), allow: allow.map(written) })).toEqual(modelOf(t, keywords, allow))
        },
      ),
      { numRuns: 4_000 },
    )
  })

  it('finds the first match that the list of every span says, through gaps of up to 60 and the decoys of middle pieces (the property)', () => {
    // Long runs of `x` between the pieces, so that the first place of a middle piece is often too far from the next piece, where a later one is not.
    // A decoy is a place of a middle piece too far from the next piece, before one that is not (`a x25 b x25 b x40 c` for `a*b*c`). The texts are
    // built from a keyword: each piece, with a second place of it now and then, and runs of `x` of any length up to 58 between them, with a
    // joiner or a space put in at times; the other keywords and the allow list are made of the same pieces.
    const piece = fc.constantFrom('a', 'b', 'c', 'ab', 'bc', 'a-', '1')
    const keyword = fc.record({ pieces: fc.array(piece, { minLength: 2, maxLength: 4 }), lead: fc.boolean(), trail: fc.boolean() })
    const run = fc.integer({ min: 0, max: 58 }).map((n) => 'x'.repeat(n))
    const step = fc.tuple(fc.constantFrom(0, 0, 0, 1), run, run, fc.constantFrom('', '', '', '', '-', ' ', 'a', 'c'))
    const built = keyword.chain((k) =>
      fc.tuple(
        fc.constant(k),
        fc.array(step, { minLength: k.pieces.length, maxLength: k.pieces.length }).map((steps) =>
          k.pieces
            .map((p, i) => {
              const [twice, before, after, odd] = steps[i]
              return `${twice ? `${p}${before}` : ''}${p}${after}${odd}`
            })
            .join('')
            .replace(/ {2,}/g, ' ')
            .trim(),
        ),
      ),
    )
    let found = 0
    let decoys = 0
    fc.assert(
      fc.property(built, fc.array(keyword, { maxLength: 2 }), fc.array(keyword, { maxLength: 2 }), ([k, t], others, allow) => {
        const keywords = [k, ...others]
        const m = matcher([keywordRule(keywords.map(written), { allow_list: allow.map(written) })])
        // The keywords through any place of their middle pieces, the allow list at the first place of each.
        const expected = modelOf(t, keywords, allow, false, true)
        if (expected !== null) found++
        if (JSON.stringify(expected) !== JSON.stringify(modelOf(t, keywords, allow, true))) decoys++
        expect(m(t), JSON.stringify({ t, keywords: keywords.map(written), allow: allow.map(written) })).toEqual(expected)
      }),
      { numRuns: 4_000 },
    )
    // Not a property that holds for want of matches, nor of the texts where the first place of a middle piece is not the one to take.
    expect(found).toBeGreaterThan(800)
    expect(decoys).toBeGreaterThan(25)
  })

  // Texts built round an allow entry of 3 or 4 pieces, the way `built` is round a keyword, with keywords that match the words of the text
  // (`*x*`, `*a*`, ...) or are made of the same pieces: where the entry holds a match through a later place of a middle piece and not through its
  // first, the reading of the allow list before (through any place, as the keywords are read) let the match by.
  const around = (entry) =>
    entry.chain((k) =>
      fc.tuple(
        fc.constant(k),
        fc.array(fc.tuple(fc.constantFrom(0, 1, 1), fc.integer({ min: 0, max: 58 }), fc.integer({ min: 0, max: 58 }), fc.constantFrom('', '', '', '', '-', ' ', 'a', 'c')), { minLength: k.pieces.length, maxLength: k.pieces.length }).map((steps) =>
          k.pieces
            .map((p, i) => {
              const [twice, before, after, odd] = steps[i]
              return `${twice ? `${p}${'x'.repeat(before)}` : ''}${p}${'x'.repeat(after)}${odd}`
            })
            .join('')
            .replace(/ {2,}/g, ' ')
            .trim(),
        ),
      ),
    )
  const piecesOf = (min, max) => fc.record({ pieces: fc.array(fc.constantFrom('a', 'b', 'c', 'ab', 'bc', 'a-', '1'), { minLength: min, maxLength: max }), lead: fc.boolean(), trail: fc.boolean() })
  const wordKeyword = fc.constantFrom('x', 'a', 'b', 'xx', 'c').map((piece) => ({ pieces: [piece], lead: true, trail: true }))

  it('never lets by what the reading of an allow entry at the first place of each middle piece refuses, and differs from the reading through any place only by refusing more (the property)', () => {
    let flips = 0
    let held = 0
    fc.assert(
      fc.property(around(piecesOf(3, 4)), fc.array(fc.oneof(wordKeyword, piecesOf(1, 3)), { minLength: 1, maxLength: 3 }), fc.array(piecesOf(3, 4), { maxLength: 1 }), ([entry, t], keywords, more) => {
        const allow = [entry, ...more]
        const label = JSON.stringify({ t, keywords: keywords.map(written), allow: allow.map(written) })
        const found = matcher([keywordRule(keywords.map(written), { allow_list: allow.map(written) })])(t)
        const firstPlace = modelOf(t, keywords, allow, false, true)
        const anyPlace = modelOf(t, keywords, allow)
        expect(found, label).toEqual(firstPlace)
        // Where the two readings differ, the one that is read now refuses, and no later than the other would have.
        if (anyPlace !== null) {
          expect(found, label).not.toBeNull()
          expect(found.start, label).toBeLessThanOrEqual(anyPlace.start)
        }
        if (anyPlace === null && found !== null) flips++
        if (JSON.stringify(firstPlace) !== JSON.stringify(modelOf(t, keywords, []))) held++
      }),
      { numRuns: 3_000 },
    )
    // Not a property that holds for want of the cases it is about: replies the allow list held before and refuses now, and replies it holds.
    expect(flips).toBeGreaterThan(30)
    expect(held).toBeGreaterThan(300)
  })

  it('answers as it did for an allow list whose entries have no `*` inside, or one, which have no middle piece (the property)', () => {
    let held = 0
    fc.assert(
      fc.property(around(piecesOf(1, 2)), fc.array(fc.oneof(wordKeyword, piecesOf(1, 4)), { minLength: 1, maxLength: 3 }), fc.array(piecesOf(1, 2), { maxLength: 2 }), ([entry, t], keywords, more) => {
        const allow = [entry, ...more]
        const found = matcher([keywordRule(keywords.map(written), { allow_list: allow.map(written) })])(t)
        const before = modelOf(t, keywords, allow)
        expect(found, JSON.stringify({ t, keywords: keywords.map(written), allow: allow.map(written) })).toEqual(before)
        if (JSON.stringify(before) !== JSON.stringify(modelOf(t, keywords, []))) held++
      }),
      { numRuns: 3_000 },
    )
    expect(held).toBeGreaterThan(300)
  })
})

describe('automodMatcher: the keywords of a rule are looked for in one pass over the text', TIMED, () => {
  it('answers the keyword that starts earliest, and the first of those that start together, whatever the order they are written in', () => {
    // `a b` ends at 3 and `a*` at 1, and both start at 0.
    expect(find(['a b', 'a*'], 'a b')).toEqual(hit(0, 3))
    expect(find(['a*', 'a b'], 'a b')).toEqual(hit(0, 1))
    expect(find(['zz', 'a b', 'a*'], 'a b')).toEqual(hit(0, 3))
    expect(find(['zz', 'a*', 'a b'], 'a b')).toEqual(hit(0, 1))
    // One written with a head of one unit and one with two, which are looked up apart.
    expect(find(['ab*', 'a*'], 'abc')).toEqual(hit(0, 3))
    expect(find(['a*', 'ab*'], 'abc')).toEqual(hit(0, 3))
    expect(find(['*bc', 'ab'], 'x abc bc')).toEqual(hit(2, 5))
    // The earliest start wins over the order.
    expect(find(['gronk', 'zorp'], 'zorp gronk')).toEqual(hit(0, 4))
    expect(find(['zorp', 'gronk'], 'zorp gronk')).toEqual(hit(0, 4))
    expect(find(['zorp', 'gronk'], 'gronk zorp')).toEqual(hit(0, 5))
    // A keyword that starts later inside the same word, and so ends it earlier, has no more to say than the one that starts the word.
    expect(find(['*orp', '*zor*'], 'a zorp')).toEqual(hit(2, 6))
    // Of the spans of one keyword that start together, the first: `*a*b*c` in `abac-bc` is `abac` from its first `a` and the whole from its second.
    expect(find(['*a*b*c'], 'abac-bc')).toEqual(hit(0, 4))
    // Of the two readings that start together, the one without the characters that show nothing: `ba` and `d` are one word there.
    expect(find(['ba*'], 'ba\u200bd')).toEqual(hit(0, 4))
    expect(find(['ba*'], 'ba\u200bd x')).toEqual(hit(0, 4))
  })

  it('looks a keyword up by its first unit or its first two, a pair of units as one character, and a keyword at the very end of the text', () => {
    expect(find(['a'], 'a b')).toEqual(hit(0, 1))
    expect(find(['a'], 'b a')).toEqual(hit(2, 3))
    expect(find(['a'], 'a')).toEqual(hit(0, 1))
    expect(find(['ab'], 'ab')).toEqual(hit(0, 2))
    expect(find(['ba'], 'a ba')).toEqual(hit(2, 4))
    expect(find(['ba'], 'a b')).toBeNull()
    expect(find(['*b'], 'ab')).toEqual(hit(0, 2))
    expect(find(['\u{10428}'], 'a \u{10428}')).toEqual(hit(2, 4))
    expect(find(['\u{10428}\u{10428}'], 'a \u{10428}\u{10428}')).toEqual(hit(2, 6))
    expect(find(['\u{10428}'], '\u{10428}')).toEqual(hit(0, 2))
    expect(find(['\u{10428}x'], '\u{10428}')).toBeNull()
    // The same first unit and a different second one.
    expect(find(['abc', 'abd', 'ab', 'ax'], 'ax')).toEqual(hit(0, 2))
    expect(find(['abc', 'abd', 'ab'], 'abd')).toEqual(hit(0, 3))
    expect(find(['abc', 'abd', 'ab'], 'ab')).toEqual(hit(0, 2))
  })

  it('does not take a keyword for found at a place where it only starts as one that was found before', () => {
    expect(find(['abc', 'abd'], 'abx abd')).toEqual(hit(4, 7))
    expect(find(['abc'], 'ab abc')).toEqual(hit(3, 6))
  })

  it('answers 6 rules of 1,000 keywords over 11,000 characters of Hangul in about as long as 6 rules of one, and says where', () => {
    // Pseudo-random Hangul, the same for every run: 11,000 syllables, which are 29,000 letters when they are taken apart.
    let seed = 20_261_118
    const next = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0)
    const syllable = () => String.fromCodePoint(0xac00 + (next() % 11_172))
    const hangul = (n) => Array.from({ length: n }, syllable).join('')
    const text = hangul(11_000)
    const rulesOf = (per) =>
      Array.from({ length: 6 }, (_, r) => keywordRule(Array.from({ length: per }, () => hangul(2 + (next() % 3))), {}, { name: `Rule ${r}` }))
    const few = matcher(rulesOf(1))
    const many = matcher(rulesOf(1_000))
    expect(many(text)).toBeNull()
    // The same text with one keyword of the last rule put into it: found, in that rule, at the place it was put.
    const last = Array.from({ length: 1_000 }, () => hangul(3))
    const wanted = matcher([...rulesOf(1_000).slice(0, 5), keywordRule([...last, '비밀단어'], {}, { name: 'Last' })])
    expect(wanted(`${text.slice(0, 5_000)} 비밀단어 ${text.slice(5_000)}`)).toEqual({ rule: 'Last', start: 5_001, end: 5_005 })
    const { ratio, ms } = versus(() => few(text), () => many(text), 10)
    // About 1 to 3 times as long, where one pass for each keyword is a thousand times as long; and under a second in any case (ten
    // under Stryker, where every statement asks which mutant is on).
    expect(ratio).toBeLessThan(10)
    expect(ms).toBeLessThan(globalThis.__stryker__ ? 10_000 : 1_000)
  })

  it('takes about as long for 1,000 keywords that start with the same two units as for one, over a text of those two units, in Latin and in Hangul', () => {
    // Addresses that start with `di`, as a list against scams has them, and words that start with the syllable 시, whose two letters are the
    // first two units of each. The index by two units tried every keyword of such a group at every place that held them: 41 and 26 times as
    // long on Bun. No keyword is found in the text, which is the two units over and over (one word of Hangul, and no full stop).
    let seed = 20_261_119
    const next = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0)
    const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + (next() % 26))).join('')
    const syllable = () => String.fromCodePoint(0xac00 + (next() % 11_172))
    for (const [unit, keywordOf] of [['di', () => `di${letters(4 + (next() % 6))}.com`], ['시', () => `시${syllable()}${syllable()}`]]) {
      const text = unit.repeat(11_000 / unit.length)
      const list = Array.from({ length: 1_000 }, keywordOf)
      const one = matcher([keywordRule(list.slice(0, 1))])
      const many = matcher([keywordRule(list)])
      expect(many(text), unit).toBeNull()
      // The last of the list put after the text: found there.
      expect(many(`${text} ${list[999]}`), unit).toEqual(hit(text.length + 1, text.length + 1 + list[999].length))
      const { ratio, ms } = versus(() => one(text), () => many(text), 10)
      expect(ratio, unit).toBeLessThan(10)
      // A ceiling for a walk that is slow for one keyword as much as for many: about 5 ms on Node.
      expect(ms, unit).toBeLessThan(2_000)
    }
  })

  it('takes about as long for 6 rules of 1,000 addresses, 300 of each starting with `di`, as for 6 rules of one, over 11,000 characters of `di`', () => {
    let seed = 20_261_120
    const next = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0)
    const address = (start) => `${start}${Array.from({ length: 4 + (next() % 6) }, () => String.fromCharCode(97 + (next() % 26))).join('')}.com`
    const rulesOf = (per, di) => Array.from({ length: 6 }, (_, r) => keywordRule(Array.from({ length: per }, (_, k) => address(k < di ? 'di' : '')), {}, { name: `Rule ${r}` }))
    const text = 'di'.repeat(5_500)
    const few = matcher(rulesOf(1, 1))
    const many = matcher(rulesOf(1_000, 300))
    expect(many(text)).toBeNull()
    const { ratio, ms } = versus(() => few(text), () => many(text), 10)
    expect(ratio).toBeLessThan(10)
    expect(ms).toBeLessThan(2_000)
  })

  it('takes about as long for 200 keywords with a `*` inside as for one, over a word of their first letter that holds the rest of them nowhere or out of reach', () => {
    // `*n*gg…r*` over a word of `n`: the old reach looked 61 places on from every `n` for the next piece, for each keyword, 2.3 s on Bun for 50.
    // A keyword that has no match at a place is looked at again only where the rest of it could follow (see retryAfter): tried at every place
    // instead, 200 of them take about 30 times as long as one, and 50 took 8 times, which a limit of 10 did not tell from the skip.
    const tail = (i) => `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`
    const word = 'n'.repeat(11_000)
    const shapes = [
      [(i) => `*n*gg${tail(i)}r*`, word],
      [(i) => `*n*gg${tail(i)}r`, word],
      // The rest of each after a space, which a `*` does not reach over, and 70 places after the end of the word, more than 60 from any `n`.
      [(i) => `*n*gg${tail(i)}r*`, `${word} gg${tail(0)}r gg${tail(49)}r`],
      [(i) => `*n*gg*${tail(i)}r*`, `${word}gg${'x'.repeat(70)}${tail(0)}r`],
      // The rest of every one of them after a space: each has a place to skip to, past the word, from its first place on.
      [(i) => `*n*gg${tail(i)}r*`, `${word} ${Array.from({ length: 200 }, (_, i) => `gg${tail(i)}r`).join(' ')}`],
    ]
    for (const [keywordOf, text] of shapes) {
      const list = Array.from({ length: 200 }, (_, i) => keywordOf(i))
      const one = matcher([keywordRule(list.slice(0, 1))])
      const many = matcher([keywordRule(list)])
      expect(many(text), list[0]).toBeNull()
      const { ratio, ms } = versus(() => one(text), () => many(text), 10)
      expect(ratio, list[0]).toBeLessThan(10)
      expect(ms, list[0]).toBeLessThan(2_000)
    }
    // And each is found where the rest of it is in reach.
    expect(matcher([keywordRule(Array.from({ length: 200 }, (_, i) => `*n*gg${tail(i)}r*`))])(`${word}gg${tail(199)}r`)).toEqual(hit(0, 11_005))
  })

  it('takes about as long for 1,000 keywords with the same first piece as for one, over a word of that piece that holds the rest of them nowhere', () => {
    // Each of them was looked at, at every place of the word, for whether it was to be tried there, though none could be after its first try:
    // 1,000 `n*XYZ` over 11,000 `n` were 172 ms a rule on Bun, and 953 ms for 6 rules.
    const word = 'n'.repeat(11_000)
    for (const keyword of ['n*xyz', '*n*xyz', '*n*xyz*', 'n*x*y*z']) {
      const one = matcher([keywordRule([keyword])])
      const many = matcher([keywordRule(Array(1_000).fill(keyword))])
      expect(many(word), keyword).toBeNull()
      const { ratio, ms } = versus(() => one(word), () => many(word), 5)
      expect(ratio, keyword).toBeLessThan(5)
      expect(ms, keyword).toBeLessThan(2_000)
    }
    // And found where the rest of them is, the first of them, after a word that only one of them was tried at for most of.
    expect(matcher([keywordRule(Array(1_000).fill('*n*xyz'))])(`${word}xyz`)).toEqual(hit(0, 11_003))
    expect(matcher([keywordRule([...Array(999).fill('*n*xyz'), '*n*q'])])(`${word}q`)).toEqual(hit(0, 11_001))
  })

  it('makes no set of places for a piece that nothing can follow, nor for the pieces before it: 1,000 keywords of 30 pieces cost about what 1,000 of 2 do', () => {
    // A set is the size of the text over 8, and every later piece of a keyword had one, made at its first look with a look at every place of
    // the piece, whether or not the piece was there and whether or not anything could follow it: 1,000 keywords of 30 pieces over 11,000
    // characters took about 40 times as long as 1,000 of 2 on Node, and 6 rules of them were 5.4 s and 610 MB a reply on Bun.
    let seed = 20_261_122
    const next = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0)
    // Words of 12 letters from `a` to `p`, and a `q` after them, after a space, which no `*` reaches over. (The low bits of `next` repeat every 16.)
    const letter = () => String.fromCharCode(97 + ((next() >>> 16) % 16))
    const text = `${Array.from({ length: 846 }, () => Array.from({ length: 12 }, letter).join('')).join(' ')} q`
    const listOf = (pieces, last) => Array.from({ length: 1_000 }, () => `*${Array.from({ length: pieces - 1 }, letter).join('*')}*${last}*`)
    // The last piece of each is not in the text, or is where nothing before it can reach.
    for (const last of ['z', 'q']) {
      const list = listOf(30, last)
      const two = matcher([keywordRule(listOf(2, last))])
      const thirty = matcher([keywordRule(list)])
      expect(thirty(text), last).toBeNull()
      const { ratio, ms } = versus(() => two(text), () => thirty(text), 10)
      expect(ratio, last).toBeLessThan(10)
      expect(ms, last).toBeLessThan(2_000)
      // And found where all of its pieces follow one another: the word that is the pieces of the last of them, put after the text.
      const word = list[999].replaceAll('*', '')
      expect(thirty(`${text} ${word}`), last).toEqual(hit(text.length + 1, text.length + 1 + word.length))
    }
  })

  it('takes about as long for 200 copies of a keyword of several pieces as for one, over a word that holds it at every place', () => {
    // A keyword of several pieces is looked for at every place, as no match lets it skip one (see nextPlace), so once one of its matches is
    // not held by the allow list it is not tried again: it has nothing more to say. Without that, 200 copies of `*a*a*` over a word of 11,000 are
    // 2.2 million matches.
    const text = 'a'.repeat(11_000)
    for (const keyword of ['*a*a*', '*a*aa*a*', 'a*a*']) {
      const one = matcher([keywordRule([keyword])])
      const copies = matcher([keywordRule(Array(200).fill(keyword))])
      expect(copies(text), keyword).toEqual(hit(0, 11_000))
      expect(versus(() => one(text), () => copies(text), 10).ratio, keyword).toBeLessThan(10)
    }
  })

  it('makes a small tree of the first pieces: 6 rules of 1,000 keywords take a few MB, and not a node for every unit of every keyword', () => {
    // A node for each unit was 105 MB a matcher for these lists, and a matcher is made for each reply.
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc')
    let seed = 20_261_121
    const next = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0)
    const word = () => Array.from({ length: 20 + (next() % 30) }, () => String.fromCharCode(97 + (next() % 26))).join('')
    const rules = Array.from({ length: 6 }, () => keywordRule(Array.from({ length: 1_000 }, word)))
    gc()
    const before = process.memoryUsage().heapUsed
    const made = Array.from({ length: 3 }, () => matcher(rules))
    gc()
    const each = (process.memoryUsage().heapUsed - before) / made.length
    expect(made.map((m) => m('a b c'))).toEqual([null, null, null])
    // About 3 MB on Node.
    expect(each).toBeLessThan(20_000_000)
  })
})

describe('automodMatcher: a text that folds to far more than it is', () => {
  const guard = matcher([keywordRule(['zorp'])])
  const FDFA = '\ufdfa'
  // Of the characters that make up the text, `fdfa` fold to 18 each (U+FDFA) and `plain` to one.
  const mixed = (fdfa, plain) => FDFA.repeat(fdfa) + 'a'.repeat(plain)

  it('throws Unfoldable for a text that folds to more than 4 times its length, and takes one that folds to exactly that', () => {
    // 45 characters of 255 fold to 18 each: 210 + 810 = 1,020, which is 4 times 255.
    expect(guard(mixed(45, 210))).toBeNull()
    throwsAs(() => guard(mixed(46, 209)), Unfoldable, 'the text folds to more than it may')
    expect(guard(mixed(45, 210).replace('a', ' zorp '))).toEqual(hit(46, 50))
  })

  it('lets a short text fold to 1,000 whatever its length, since nothing short can make the work long', () => {
    expect(guard(mixed(55, 10))).toBeNull()
    throwsAs(() => guard(mixed(55, 11)), Unfoldable, 'the text folds to more than it may')
    expect(guard(FDFA)).toBeNull()
    expect(guard(FDFA.repeat(3))).toBeNull()
  })

  it('takes the texts that folding makes longer by a little, as most of what is written in a script with accents or capitals does', () => {
    expect(guard('É'.repeat(4_000))).toBeNull()
    expect(guard('é'.repeat(4_000))).toBeNull()
    expect(guard('ß'.repeat(4_000))).toBeNull()
    expect(guard('ǆ'.repeat(4_000))).toBeNull()
    expect(guard('x   '.repeat(2_000))).toBeNull()
  })

  it('takes a text that grows to the total that is left, charges it, and throws for one that grows past it', () => {
    // Each ß folds to ss: one more than it is.
    const spend = { left: 250 }
    expect(guard('ß'.repeat(100), spend)).toBeNull()
    expect(spend.left).toBe(150)
    expect(guard('abc', spend)).toBeNull()
    expect(spend.left).toBe(150)
    expect(guard('ß'.repeat(150), spend)).toBeNull()
    expect(spend.left).toBe(0)
    expect(guard('abc', spend)).toBeNull()
    throwsAs(() => guard('ß', spend), Unfoldable, 'the text folds to more than it may')
    expect(spend.left).toBe(0)
    throwsAs(() => guard('ß'.repeat(100), { left: 99 }), Unfoldable, 'the text folds to more than it may')
  })

  it('takes nothing from the allowance for a text that folds to fewer units than it is, and gives nothing back', () => {
    // A mathematical letter is two units and folds to one.
    const spend = { left: 100 }
    expect(guard('\u{1d41a}'.repeat(50), spend)).toBeNull()
    expect(spend.left).toBe(100)
    // What is added is of the whole text: another that adds 50 (60 ß add 60, and 10 of them add nothing more than they take away).
    expect(guard(`${'ß'.repeat(60)}${'\u{1d41a}'.repeat(10)}`, spend)).toBeNull()
    expect(spend.left).toBe(50)
  })

  it('lets one reply grow its texts to 64,000 characters in all, which a call that is not given a total has to itself', () => {
    expect(guard('ß'.repeat(64_000))).toBeNull()
    throwsAs(() => guard('ß'.repeat(64_001)), Unfoldable, 'the text folds to more than it may')
    // What is charged is not charged twice, nor kept from one call to the next.
    expect(guard('ß'.repeat(64_000))).toBeNull()
  })

  it('does not fold at all, and so does not throw, when no rule has a keyword to look for', () => {
    const big = FDFA.repeat(11_000)
    expect(matcher([])(big)).toBeNull()
    expect(matcher([keywordRule([], { regex_patterns: ['x'] })])(big)).toBeNull()
    expect(matcher([keywordRule(['zorp'], {}, { enabled: false })])(big)).toBeNull()
    expect(matcher([keywordRule(['zorp'], {}, { exempt_roles: [ROLE_A] })], { memberRoleIds: [ROLE_A] })(big)).toBeNull()
    expect(matcher([mentionRule(5)])(big)).toBeNull()
    // The keywords that are looked for as they are written are not folded either.
    expect(matcher([keywordRule(['||'])])(`${big}||`)).toEqual(hit(11_000, 11_002))
  })

  it('answers 11,000 characters that fold to 18 each in a few milliseconds, where reading them took seconds', () => {
    const started = performance.now()
    throwsAs(() => guard(FDFA.repeat(11_000)), Unfoldable, 'the text folds to more than it may')
    // 7 s on Node and 0.33 s on Bun before the bound; about 5 ms now (Stryker's instrumented copy is about ten times slower).
    expect(performance.now() - started).toBeLessThan(globalThis.__stryker__ ? 2_500 : 250)
  })

  it('does not fold a keyword, which the people who manage the server wrote, against the bound', () => {
    expect(() => matcher([keywordRule([FDFA.repeat(60)])])).not.toThrow()
    expect(matcher([keywordRule([FDFA.repeat(40)])])(`a ${FDFA.repeat(40)} b`)).toEqual(hit(2, 42))
  })
})

describe('automodMatcher: what shows as blank', () => {
  // Characters that show nothing and are no space, no control and no format character: the fillers of Hangul, the blank of Braille, and
  // the ones that Unicode keeps for what is not yet written (the default ignorables, assigned or not).
  const BLANKS = ['\u115f', '\u1160', '\u3164', '\uffa0', '\u2800', '\u2065', '\ufff0', '\u{e0000}']

  it('reads each of them as nothing and as a space, so that a word they split is found, and so is a phrase they stand in for the space of', () => {
    for (const blank of BLANKS) {
      const name = `U+${blank.codePointAt(0).toString(16)}`
      expect(find(['zorp'], `zo${blank}rp`), name).toEqual(hit(0, 4 + blank.length))
      expect(find(['the mat'], `the${blank}mat`), name).toEqual(hit(0, 6 + blank.length))
      expect(find(['*zorp'], `a ${blank}zorp`), name).toEqual(hit(2 + blank.length, 6 + blank.length))
      expect(find(['zorp'], `zo${blank}${blank}rp`), name).toEqual(hit(0, 4 + 2 * blank.length))
      expect(find(['zorp'], `zo${blank}x${blank}rp`), name).toBeNull()
    }
  })

  it('reads a mark that shows nothing (a joiner of graphemes, a variation selector) as nothing in both readings, as any mark: it is no place between words', () => {
    const CGJ = String.fromCodePoint(0x34f)
    const VS16 = String.fromCodePoint(0xfe0f)
    const MONGOLIAN = String.fromCodePoint(0x180b)
    const ZWSP = String.fromCodePoint(0x200b)
    for (const mark of [CGJ, VS16, MONGOLIAN, String.fromCodePoint(0x17b5)]) {
      const name = `U+${mark.codePointAt(0).toString(16)}`
      expect(find(['bad'], `ba${mark}d`), name).toEqual(hit(0, 4))
      // The zero-width space is a place between words in one reading, so `bad` is a word of its own there and the mark does not split it.
      expect(find(['bad'], `x${ZWSP}ba${mark}d`), name).toEqual(hit(2, 6))
      expect(find(['bad'], `x${ZWSP}b${mark}ad`), name).toEqual(hit(2, 6))
      expect(find(['the mat'], `the${mark}mat`), name).toBeNull()
    }
  })

  it('reads the examples of the review: the filler of Hangul between two words, and the unassigned ignorable inside one', () => {
    expect(find(['the mat'], 'the\u3164mat')).toEqual(hit(0, 7))
    expect(find(['zorp'], 'zo\u2065rp')).toEqual(hit(0, 5))
  })

  it('does not read a letter of Hangul, or a pattern of Braille that is not blank, as nothing', () => {
    expect(find(['zorp'], 'zoㄱrp')).toBeNull()
    expect(find(['zorp'], 'zo⠁rp')).toBeNull()
    expect(find(['zorp'], 'zoᅡrp')).toBeNull()
  })

  it('strips them from a name, where they could hide a word that Discord refuses', () => {
    expect(cleanName('disc\u3164ord')).toBe('Member')
    expect(cleanName('cly\u2800de')).toBe('Member')
  })
})

describe('typed: the text as the member typed it, with what the form wrote for its links and its marks undone', TIMED, () => {
  it('writes `[text](<address>)` as `[text](address)` and `<address>` as `address`, for http and https', () => {
    expect(typed('[a](<https://e.com>)')).toBe('[a](https://e.com)')
    expect(typed('see <https://e.com> now')).toBe('see https://e.com now')
    expect(typed('<http://e.com/x?y=1&z=2#f>')).toBe('http://e.com/x?y=1&z=2#f')
    expect(typed('<https://e.com/a%3Eb>')).toBe('https://e.com/a%3Eb')
    expect(typed('<https://a.com> <http://b.com>\n[c](<https://d.com>)')).toBe('https://a.com http://b.com\n[c](https://d.com)')
    expect(typed('<<https://e.com>>')).toBe('<https://e.com>')
    // What is in an address is the address: the form escapes nothing in it, so nothing in it is undone.
    expect(typed('[a\\_b](<https://e.com/a_b\\*c>)')).toBe('[a_b](https://e.com/a_b\\*c)')
  })

  it('takes the backslash out of every escape that the form writes: before a mark of Discord\'s markdown, and before what would start a line', () => {
    expect(typed('z\\*rp')).toBe('z*rp')
    expect(typed('free\\_nitro')).toBe('free_nitro')
    expect(typed('see z\\*rp now')).toBe('see z*rp now')
    for (const mark of ['\\', '*', '_', '~', '|', '`', '<', '[', ']', '#', '-', '>', '.']) expect(typed(`z\\${mark}rp`), mark).toBe(`z${mark}rp`)
    // The escapes of the start of a line, and of a footnote reference.
    expect(typed('\\# zorp')).toBe('# zorp')
    expect(typed('\\- zorp')).toBe('- zorp')
    expect(typed('\\-# zorp')).toBe('-# zorp')
    expect(typed('\\>zorp')).toBe('>zorp')
    expect(typed('12\\. zorp')).toBe('12. zorp')
    expect(typed('\\[^1]')).toBe('[^1]')
    expect(typed('\\*\\*\\_\\_\\~\\~\\|\\|')).toBe('**__~~||')
  })

  it('reads the escapes from left to right, so that a backslash the form doubled is one backslash, and what follows it is read on its own', () => {
    expect(typed('\\\\')).toBe('\\')
    expect(typed('a\\\\b')).toBe('a\\b')
    expect(typed('\\\\\\\\')).toBe('\\\\')
    expect(typed('z\\\\\\*rp')).toBe('z\\*rp')
    expect(typed('z\\\\*rp')).toBe('z\\*rp')
    // A doubled backslash before a link, and an escaped angle bracket, which is no link: the member typed the bracket.
    expect(typed('\\\\<https://e.com>')).toBe('\\https://e.com')
    expect(typed('\\<https://e.com>')).toBe('<https://e.com>')
    expect(typed('\\<https://e.com\\>')).toBe('<https://e.com>')
  })

  it('leaves a backslash before anything that the form does not escape, and one at the end, as it is', () => {
    for (const text of ['\\a', 'a\\', '\\', '\\ ', '\\1', '\\é', '\\(', '\\)', '\\!', '\\@', '\\:', '\\^', '\\\n', 'zo\\rp', '\\\u{10428}']) {
      expect(typed(text), JSON.stringify(text)).toBe(text)
    }
  })

  it('takes out every zero-width space: those that the form puts between marks, and those of the member, as the text that is sent is read too', () => {
    // Between two marks of one character that touch, after an escaped one, in a run of three backticks, and in a mark that a cut leaves empty.
    expect(typed('*a*\u200b**b**')).toBe('*a***b**')
    expect(typed('__a__\u200b__b__')).toBe('__a____b__')
    expect(typed('`a`\u200b`b`')).toBe('`a``b`')
    expect(typed('\\*\u200b**b**')).toBe('***b**')
    expect(typed('``\u200b`')).toBe('```')
    expect(typed('**\u200b**')).toBe('****')
    expect(typed('~~\u200b~~')).toBe('~~~~')
    expect(typed('z\u200bo\u200b\u200brp')).toBe('zorp')
    expect(typed('\u200b')).toBe('')
    // The space that a spoiler is given, and every other character that shows as nothing, are left: they are no part of what this undoes.
    for (const text of ['|| ||', 'z\u200corp', 'z\u200dorp', 'z\u2060orp', 'z\ufeffo', 'z\u00adorp']) expect(typed(text), JSON.stringify(text)).toBe(text)
  })

  it('reads each italic that the form writes with `*` as one of `_` when it is asked to, as the member may have typed it, and keeps every run of two stars, or of four or more', () => {
    // The form writes every italic with `*`, `_free_` as `*free*`, so a pattern that takes `_` and not `*` saw no `_` where Discord sees the member's.
    expect(typed('claim your *free* nitro now', '_')).toBe('claim your _free_ nitro now')
    expect(typed('claim your free *nitro* now', '_')).toBe('claim your free _nitro_ now')
    expect(typed('claim your free\\_*nitro* now', '_')).toBe('claim your free__nitro_ now')
    // A bold and the marks of a cut are runs of stars, and are kept as they are; a run of three is a bold round an italic (see below).
    expect(typed('**a** ***b*** ****', '_')).toBe('**a** **_b_** ****')
    expect(typed('**free *nitro***', '_')).toBe('**free _nitro_**')
    // Two marks that touch, which the form sets apart with a zero-width space, are two marks.
    expect(typed('*a*\u200b**b**', '_')).toBe('_a_**b**')
    expect(typed('**a**\u200b*b*', '_')).toBe('**a**_b_')
    // A star that the member typed is escaped, and is the star it is; a star in an address is the address's.
    expect(typed('\\*not italic\\*', '_')).toBe('*not italic*')
    expect(typed('\\\\*a*', '_')).toBe('\\_a_')
    expect(typed('<https://e.com/a*b*c>', '_')).toBe('https://e.com/a*b*c')
    expect(typed('[*a*](<https://e.com/*>)', '_')).toBe('[_a_](https://e.com/*)')
  })

  it('reads a run of exactly three stars, which the form writes for a bold round an italic, as `**_` where it opens and `_**` where it closes', () => {
    // The form writes `**_free nitro_**` as `***free nitro***`, so a pattern that reads a `_` at the edge of an italic (`_free`, `nitro_`) saw none.
    expect(typed('***free nitro***', '_')).toBe('**_free nitro_**')
    expect(typed('claim ***free nitro*** now', '_')).toBe('claim **_free nitro_** now')
    expect(typed('***free*** ***nitro***', '_')).toBe('**_free_** **_nitro_**')
    // A bold that starts or ends with an italic, and an italic that starts or ends with a bold, which is read with the bold outside as well.
    expect(typed('***free* nitro**', '_')).toBe('**_free_ nitro**')
    expect(typed('**free *nitro***', '_')).toBe('**free _nitro_**')
    expect(typed('*free **nitro***', '_')).toBe('_free **nitro_**')
    expect(typed('***free** nitro*', '_')).toBe('**_free** nitro_')
    // With no space on either side, it opens when no mark of stars is open, and closes when one is.
    expect(typed('(***free nitro***).', '_')).toBe('(**_free nitro_**).')
    expect(typed('x***free***y', '_')).toBe('x**_free_**y')
    expect(typed('**free *nitro***.', '_')).toBe('**free _nitro_**.')
    expect(typed('*free **nitro***!', '_')).toBe('_free **nitro_**!')
    expect(typed('***free***\u200b***nitro***', '_')).toBe('**_free_****_nitro_**')
    expect(typed('\\_***free***\\_', '_')).toBe('_**_free_**_')
    expect(typed('**a**\u200b***b***.', '_')).toBe('**a****_b_**.')
    // An italic open on its own, or a bold on its own, is enough for it to close.
    expect(typed('*free***nitro*', '_')).toBe('_free_**nitro_')
    expect(typed('**free***nitro**', '_')).toBe('**free_**nitro**')
    // A run of three with a space or the end of the text on both sides holds nothing, and is kept; so are escaped stars, and runs of two and of
    // four or more. With `*`, a run of three is what it was.
    for (const text of ['a *** b', '***', ' *** ', '**free** ****', '*****a*****', '****a****']) expect(typed(text, '_'), text).toBe(text)
    expect(typed('\\*\\*\\*free\\*\\*\\*', '_')).toBe('***free***')
    for (const text of ['***free nitro***', '(***free nitro***).', '**free *nitro***']) expect(typed(text, '*'), text).toBe(text)
  })

  it('reads an italic as the form writes it, with `*`, when it is not asked to, and is told no other mark', () => {
    for (const text of ['*free* nitro', '**a** *b*', '*a*\u200b**b**', '***free***']) {
      expect(typed(text, '*'), text).toBe(typed(text))
      expect(typed(text), text).toBe(text.replaceAll('\u200b', ''))
    }
    for (const italic of ['', '**', '__', '~', 'x', null, 1]) throwsAs(() => typed('*a*', italic), RangeError, 'the italic must be * or _')
  })

  it('changes nothing but stars, to `_`, when it reads the italic as `_`: each that stands alone, and one of each run of three (the property)', () => {
    const unit = fc.constantFrom('\\', '*', '**', '***', '_', '<', '>', 'https://', 'a', ' ', '\u200b', '`', '[', ']', '(', ')')
    fc.assert(
      fc.property(fc.oneof(fc.array(unit, { maxLength: 30 }).map((list) => list.join('')), fc.string({ unit: 'binary', maxLength: 30 })), (text) => {
        const star = typed(text)
        const under = typed(text, '_')
        expect(under.length).toBe(star.length)
        for (let i = 0; i < star.length; i++) if (under[i] !== star[i]) expect([star[i], under[i]], JSON.stringify(text)).toEqual(['*', '_'])
      }),
      { numRuns: 2_000 },
    )
    // Of a text of letters, spaces and stars, which holds no escape, no address and no zero-width space, it is each star of its own as `_`, each
    // run of two or of four or more as it is, and a run of three as `**_` with a space or nothing before it and a character after it that is no
    // space, as `_**` the other way round, as it is with a space or nothing on both sides, and as one of the two between two characters.
    let between = 0
    fc.assert(
      fc.property(fc.array(fc.constantFrom('*', '*', '***', 'a', ' ', 'b', '.'), { maxLength: 30 }), (list) => {
        const text = list.join('')
        const under = typed(text, '_')
        expect(under.length, text).toBe(text.length)
        const blank = (c) => c === undefined || c === ' '
        for (const { 0: run, index } of text.matchAll(/\*+/g)) {
          const read = under.slice(index, index + run.length)
          const [before, after] = [blank(text[index - 1]), blank(text[index + run.length])]
          if (run.length === 1) expect(read, text).toBe('_')
          else if (run.length !== 3 || (before && after)) expect(read, text).toBe(run)
          else if (before) expect(read, text).toBe('**_')
          else if (after) expect(read, text).toBe('_**')
          else {
            between++
            expect(['**_', '_**'], text).toContain(read)
          }
        }
      }),
      { numRuns: 2_000 },
    )
    expect(between).toBeGreaterThan(100)
  })

  it('leaves what the form does not put there as it is: mentions, timestamps, emoji, channels, and what is no whole address', () => {
    for (const text of ['<@200000000000000421>', '<@!200000000000000421>', '<t:1700000000:R>', '<:name:200000000000000421>', '<a:name:200000000000000421>', '<#200000000000000421>', '<id:customize>', '<https://e.com', 'https://e.com>', '<https://e.com >', '<https://e .com>', '<HTTPS://e.com>', '<ftp://e.com>', '<https:/e.com>', '< https://e.com>', '<>', '', 'zorp', 'z*rp', 'free_nitro']) {
      expect(typed(text), text).toBe(text)
    }
  })

  it('is never longer than the text, and is the text when it holds no backslash, no angle bracket and no zero-width space (the property)', () => {
    const unit = fc.constantFrom('\\', '*', '_', '<', '>', 'https://', 'h', 'a', ' ', '\u200b', '`', '#', '.', '-', '[', ']', '(', ')')
    fc.assert(
      fc.property(fc.oneof(fc.array(unit, { maxLength: 30 }).map((list) => list.join('')), fc.string({ unit: 'binary', maxLength: 30 })), (text) => {
        const copy = typed(text)
        expect(copy.length).toBeLessThanOrEqual(text.length)
        if (!/[\\<\u200b]/.test(text)) expect(copy).toBe(text)
      }),
      { numRuns: 2_000 },
    )
  })

  it('takes four times as long for four times the text, whatever the shape of the text that is no link, or half of one, or escapes', () => {
    for (const unit of ['<https://', '<h', '<', '<https://a', '<https://a>', '<https://a <', '[a](<https://a>) ', '\\', '\\*', '\\\\*', '*\u200b', '\u200b', '\\<https://a>', '<https://a\\', '*', '*a', '**', '*a**', '***', '***a', 'a***', ' ***', '(***a***).', '*a ***b** ']) {
      for (const italic of ['*', '_']) {
        expectLinear(`${JSON.stringify(unit)} ${italic}`, (n) => {
          const text = unit.repeat(Math.ceil(n / unit.length))
          return () => typed(text, italic)
        })
      }
    }
  })
})

describe('unmasked: the text of the masked links of a text, without their brackets and their addresses', TIMED, () => {
  it('is the text of a link put where the link was, and the text before and after it as it was', () => {
    expect(unmasked('[zo](https://e.com)rp')).toBe('zorp')
    expect(unmasked('zo[rp](https://e.com)')).toBe('zorp')
    expect(unmasked('a [b](https://e.com) c [d](https://f.com) e')).toBe('a b c d e')
    expect(unmasked('[a](u)[b](u)[c](u)')).toBe('abc')
    expect(unmasked('[](https://e.com)x')).toBe('x')
    expect(unmasked('[zo]()rp')).toBe('zorp')
  })

  it('reads the address as Discord does: a title, angle brackets, one level of parentheses, and a space of the one that writes it', () => {
    for (const link of ['[zo](https://e.com "a title")rp', '[zo](<https://e.com>)rp', '[zo](https://e.com/a_(b))rp', '[zo]( https://e.com )rp', '[zo](https://e.com/(a)(b))rp']) {
      expect(unmasked(link), link).toBe('zorp')
    }
  })

  it('leaves what is not a masked link as it is', () => {
    for (const text of ['zorp', '', '[zo]', '[zo] (https://e.com)rp', '[zo](https://e.com', '[zo\nx](https://e.com)rp', '(zo)[rp]', '[zo][rp]', '[zo](https://e.com\n)rp', '[zo](https://e.com/((a)))rp', '[zo[x]](u)', '](u)', '[](']) {
      expect(unmasked(text), JSON.stringify(text)).toBe(text)
    }
  })

  it('reads the inner link of two that are nested, which is what Discord shows of them, once', () => {
    expect(unmasked('[a [zo](u)rp](v)')).toBe('[a zorp](v)')
  })

  it('takes four times as long for four times the text, whatever the shape of the text that is no link, or half of one', () => {
    for (const unit of ['[a](', '[', '](', '[a](b', '[a](b)', '[a](b "']) {
      expectLinear(JSON.stringify(unit), (n) => {
        const text = unit.repeat(Math.ceil(n / unit.length))
        return () => unmasked(text)
      })
    }
  })
})

describe('automodMatcher: the options and the text it is given', () => {
  it('refuses rules that are not a list', () => {
    for (const rules of [undefined, null, {}, 'x', 5, new Set()]) {
      throwsAs(() => automodMatcher(rules, {}), TypeError, 'the rules must be a list')
    }
  })

  it('refuses options of the wrong kind', () => {
    const lists = 'must be a list of ids'
    throwsAs(() => automodMatcher([], { memberRoleIds: 'x' }), TypeError, `memberRoleIds ${lists}`)
    throwsAs(() => automodMatcher([], { memberRoleIds: [5] }), TypeError, `memberRoleIds ${lists}`)
    throwsAs(() => automodMatcher([], { memberRoleIds: null }), TypeError, `memberRoleIds ${lists}`)
    throwsAs(() => automodMatcher([], { channelIds: 'x' }), TypeError, `channelIds ${lists}`)
    throwsAs(() => automodMatcher([], { channelIds: [null] }), TypeError, `channelIds ${lists}`)
    throwsAs(() => automodMatcher([], { isAdmin: 'false' }), TypeError, 'isAdmin must be true or false')
    throwsAs(() => automodMatcher([], { isAdmin: 1 }), TypeError, 'isAdmin must be true or false')
    throwsAs(() => automodMatcher([], { isAdmin: null }), TypeError, 'isAdmin must be true or false')
    throwsAs(() => automodMatcher([], { log: 'x' }), TypeError, 'log must be a function')
    throwsAs(() => automodMatcher([], null), TypeError, 'the options must be an object')
    throwsAs(() => automodMatcher([], 'x'), TypeError, 'the options must be an object')
    throwsAs(() => automodMatcher([], []), TypeError, 'the options must be an object')
  })

  it('takes no options at all, and no lists of roles or channels', () => {
    expect(automodMatcher([keywordRule(['zorp'])])('zorp')).toEqual(hit(0, 4))
    expect(automodMatcher([keywordRule(['zorp'], {}, { exempt_roles: ['Stryker was here'], exempt_channels: ['Stryker was here'] })], {})('zorp')).toEqual(hit(0, 4))
    expect(automodMatcher([keywordRule(['zorp'], {}, { exempt_roles: [ROLE_A] })], { memberRoleIds: undefined, channelIds: undefined })('zorp')).toEqual(hit(0, 4))
  })

  it('refuses a text that is not text', () => {
    const m = matcher([keywordRule(['zorp'])])
    for (const text of [undefined, null, 5, {}, ['zorp'], new String('zorp')]) throwsAs(() => m(text), TypeError, 'the text must be a string')
  })

  it('answers for every text it is given the same way again', () => {
    const m = matcher([keywordRule(['zorp'])])
    expect(m('a zorp')).toEqual(hit(2, 6))
    expect(m('a zorp')).toEqual(hit(2, 6))
    expect(m('b')).toBeNull()
    expect(m('zorp')).toEqual(hit(0, 4))
  })

  it('never changes the rules it was given', () => {
    const rules = [keywordRule(['*Zorp*', 'a*b'], { allow_list: ['Zorper'] })]
    const before = JSON.stringify(rules)
    const m = matcher(rules)
    m('zorp zorper axb')
    expect(JSON.stringify(rules)).toBe(before)
  })

  it('reads a keyword that has a space beside its stars as the word', () => {
    expect(find(['** cat'], 'bobcat')).toEqual(hit(0, 6))
    expect(find(['cat **'], 'catch')).toEqual(hit(0, 5))
    expect(find(['* cat *'], 'a location')).toEqual(hit(2, 10))
    expect(find(['*', '**', ' ', '* *'], 'undefined')).toBeNull()
    expect(find(['*', '**', ' ', '* *'], 'Stryker was here undefined null')).toBeNull()
  })
})

describe('automodMatcher: a keyword that holds no word, a space beside its stars, and the capital sharp s', () => {
  it('reads the capital sharp s as the lower case one, and both as ss', () => {
    for (const [keyword, text] of [['straße', 'STRAẞE'], ['STRAẞE', 'straße'], ['strasse', 'STRAẞE'], ['STRAẞE', 'strasse'], ['ẞ', 'ß'], ['ß', 'ẞ'], ['ss', 'ẞ'], ['ẞ', 'ss'], ['straẞe', 'STRASSE']]) {
      expect(find([keyword], text), `${keyword} ${text}`).toEqual(hit(0, text.length))
    }
    expect(find(['straße'], 'a STRAẞE b')).toEqual(hit(2, 8))
    expect(find(['*asse*'], 'STRAẞE')).toEqual(hit(0, 6))
  })

  it('matches a keyword that folds to nothing as it is written, in any case, wherever it stands in the text', () => {
    for (const keyword of ['||', '~~', '```', '`', '|', '__', '\\', '\u200b', '\u0301', '||||']) {
      const text = `a ${keyword} b`
      expect(find([keyword], text), JSON.stringify(keyword)).toEqual(hit(2, 2 + keyword.length))
      expect(find([keyword], `x${keyword}y`), JSON.stringify(keyword)).toEqual(hit(1, 1 + keyword.length))
    }
    expect(find(['||'], 'a || b')).toEqual(hit(2, 4))
    expect(find(['||'], '||secret||')).toEqual(hit(0, 2))
    expect(find(['```'], '```js\ncode\n```')).toEqual(hit(0, 3))
    expect(find(['~~'], 'x ~~gone~~')).toEqual(hit(2, 4))
  })

  it('looks for a lone half of a pair as that half, and not inside a pair', () => {
    expect(find(['\ud800'], 'a\ud800b')).toEqual(hit(1, 2))
    expect(find(['\udc00'], 'a\udc00')).toEqual(hit(1, 2))
    expect(find(['\ud800'], 'a\u{10000}b')).toBeNull()
    expect(find(['\udc00'], 'a\u{10000}b')).toBeNull()
  })

  it('does not match it where it is not written, or in a text that holds only its pieces', () => {
    expect(find(['||'], 'a | b')).toBeNull()
    expect(find(['||'], 'a b')).toBeNull()
    expect(find(['```'], '`` `')).toBeNull()
    expect(find(['~~'], 'a ~ b')).toBeNull()
    expect(find(['\u200b'], 'a b')).toBeNull()
  })

  it('reads the stars and the space round such a keyword as they are read round any other', () => {
    for (const keyword of ['*||*', '||*', '*||', ' || ', '* || *', ' *||', '||* ', '**||**']) {
      expect(find([keyword], 'a||b'), JSON.stringify(keyword)).toEqual(hit(1, 3))
    }
    expect(find(['|*|'], 'a|*|b')).toEqual(hit(1, 4))
    expect(find(['|*|'], 'a|x|b')).toBeNull()
  })

  it('keeps the rest of the rule at work with such a keyword in it, and the earliest match', () => {
    expect(find(['||', 'zorp'], 'a zorp ||')).toEqual(hit(2, 6))
    expect(find(['zorp', '||'], 'a || zorp')).toEqual(hit(2, 4))
    expect(find(['||'], 'a zorp ||', { allow_list: ['zorp', '||', '*'] })).toEqual(hit(7, 9))
  })

  it('still has no keyword in one that is nothing, stars or space', () => {
    for (const keyword of ['', ' ', '\t', '*', '**', '* *', '  *  ', '***', '\n*\n']) {
      expect(find([keyword], 'anything || at ~~ all \u200b'), JSON.stringify(keyword)).toBeNull()
    }
  })

  it('reads a keyword with a space before its star as the keyword with the star at its end: ` *cat` is a suffix', () => {
    expect(find([' *cat'], 'bobcat')).toEqual(hit(0, 6))
    expect(find(['  *cat'], 'a bobcat')).toEqual(hit(2, 8))
    expect(find(['\t*cat'], 'bobcat')).toEqual(hit(0, 6))
    expect(find([' *cat'], 'catch')).toBeNull()
    expect(find(['cat* '], 'catch')).toEqual(hit(0, 5))
    expect(find(['cat * '], 'catch')).toEqual(hit(0, 5))
    expect(find([' *cat* '], 'a location')).toEqual(hit(2, 10))
    expect(find([' cat '], 'a cat b')).toEqual(hit(2, 5))
    expect(find([' cat '], 'bobcat')).toBeNull()
    expect(find([' *cat'], 'bobcat')).toEqual(hit(0, 6))
  })

  it('reads an allow entry with space beside its star the same way', () => {
    expect(find(['*cat*'], 'bobcat', { allow_list: [' *cat'] })).toBeNull()
    expect(find(['*cat*'], 'catch', { allow_list: [' *cat'] })).toEqual(hit(0, 5))
  })

  it('is not changed by what an allow list holds that folds to nothing: it lets nothing go, and nothing literal goes', () => {
    expect(find(['*zorp*'], 'zorp', { allow_list: ['||', '*', ' '] })).toEqual(hit(0, 4))
    expect(find(['||'], 'a || b', { allow_list: ['||', '*||*', '*'] })).toEqual(hit(2, 4))
  })
})

describe('automodMatcher: against a plain model of the rules', () => {
  // A model of the rules over lower case letters and single spaces: the same words, the same edges.
  const letter = (c) => c !== undefined && c >= 'a' && c <= 'z'
  const spans = (text, k) => {
    const out = []
    for (let i = text.indexOf(k.word); i !== -1; i = text.indexOf(k.word, i + 1)) {
      const j = i + k.word.length
      if (!k.lead && letter(text[i - 1])) continue
      if (!k.trail && letter(text[j])) continue
      let a = i
      let b = j
      if (k.lead) while (a > 0 && letter(text[a - 1])) a--
      if (k.trail) while (b < text.length && letter(text[b])) b++
      out.push([a, b])
    }
    return out
  }
  const model = (text, keywords, allow) => {
    const exempt = allow.flatMap((k) => spans(text, k))
    let best = null
    for (const k of keywords) {
      const found = spans(text, k).find(([a, b]) => !exempt.some(([c, d]) => c <= a && b <= d))
      if (found !== undefined && (best === null || found[0] < best.start)) best = { start: found[0], end: found[1] }
    }
    return best === null ? null : { rule: 'Test Rule', ...best }
  }
  const written = (k) => `${k.lead ? '*' : ''}${k.word}${k.trail ? '*' : ''}`
  const kw = fc.record({ word: fc.constantFrom('a', 'b', 'ab', 'ba', 'aa', 'a b', 'b a', 'abb'), lead: fc.boolean(), trail: fc.boolean() })
  const words = fc.array(fc.constantFrom('a', 'b', 'ab', 'ba', 'aab', 'bb'), { maxLength: 8 }).map((w) => w.join(' '))

  it('finds the same first match as the model', () => {
    fc.assert(
      fc.property(words, fc.array(kw, { minLength: 1, maxLength: 3 }), fc.array(kw, { maxLength: 3 }), (text, keywords, allow) => {
        const m = matcher([keywordRule(keywords.map(written), { allow_list: allow.map(written) })])
        expect(m(text)).toEqual(model(text, keywords, allow))
      }),
      { numRuns: 1500 },
    )
  })

  it('finds a keyword wherever marks are put between its letters, and in any case', () => {
    const marks = fc.constantFrom('', '*', '_', '~', '|', '`', '\\', '\u200b', '\u200d', '\u0301', '\u00ad')
    fc.assert(
      fc.property(fc.array(marks, { minLength: 4, maxLength: 4 }), fc.boolean(), (gaps, upper) => {
        const letters = upper ? 'ZORP' : 'zorp'
        const text = `x ${gaps[0]}${letters[0]}${gaps[1]}${letters[1]}${gaps[2]}${letters[2]}${gaps[3]}${letters[3]} y`
        const found = matcher([keywordRule(['zorp'])])(text)
        expect(found).not.toBeNull()
        expect(found.start).toBeGreaterThanOrEqual(2)
        expect(found.end).toBeLessThanOrEqual(text.length - 2)
        expect(text.slice(found.start, found.end).replace(/[^zorpZORP]/g, '').toLowerCase()).toBe('zorp')
      }),
    )
  })

  it('always answers within the text, with a start before its end, for any text and keywords', () => {
    const odd = fc.oneof(fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' }), fc.stringMatching(/^[a-c *_\u200b\u0301😀]{0,40}$/))
    fc.assert(
      fc.property(odd, fc.array(odd, { maxLength: 4 }), fc.array(odd, { maxLength: 3 }), (text, keywords, allow) => {
        const found = matcher([keywordRule(keywords, { allow_list: allow })])(text)
        if (found === null) return
        expect(found.start).toBeGreaterThanOrEqual(0)
        expect(found.end).toBeLessThanOrEqual(text.length)
        expect(found.start).toBeLessThan(found.end)
      }),
      { numRuns: 1000 },
    )
  })

  it('stays quick on hostile texts and keywords', () => {
    const long = 'a.'.repeat(8_000)
    const rules = [
      keywordRule(['a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b', '*a*a*a*b*', 'a*b'], { allow_list: ['a'] }),
      keywordRule(Array.from({ length: 100 }, (_, i) => `${'ab'.repeat(29)}${i % 10}x`)),
    ]
    const m = matcher(rules)
    const started = Date.now()
    for (const text of [long, 'a'.repeat(16_000), 'a '.repeat(8_000), ' '.repeat(16_000), '*'.repeat(16_000), '\u200b'.repeat(16_000), 'é'.repeat(16_000)]) {
      m(text)
    }
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('stays quick when every match is exempt', () => {
    const text = 'a '.repeat(8_000)
    const started = Date.now()
    expect(find(['a'], text, { allow_list: ['a'] })).toBeNull()
    expect(find(['a'], text, { allow_list: ['a', '*a*', 'a a'] })).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

const none = () => null
const SITE = 'https://example.test/x'
const opts = (over = {}) => ({ form: 'v2', automod: none, ownUploadIds: [], authorId: U1, siteUrl: SITE, ...over })
const send = (input, over) => validateReply(input, opts(over))
const reply = (source, over = {}) => ({ source, replyTo: null, mentions: [], uploads: [], ...over })

// A table, which Discord shows without the padding of its cells: n characters of source that fit in one message.
function padded(n) {
  const rows = Array.from({ length: 40 }, () => '| x |')
  const spare = n - ['| h |', '|---|', ...rows].join('\n').length
  const per = Math.floor(spare / 40)
  const extra = spare - per * 40
  const body = rows.map((_, i) => `| x${' '.repeat(per + (i === 0 ? extra : 0) + 1)}|`)
  return ['| h |', '|---|', ...body].join('\n')
}

describe('validateReply: a reply that is fine', () => {
  it('goes through as it is, with what it names', async () => {
    const r = await send(reply('Hello there.'))
    expect(r).toEqual({ ok: true, clean: { source: 'Hello there.', replyTo: null, mentions: [], uploads: [] } })
  })

  it('keeps the reply it answers, as the two fields that the form takes', async () => {
    const replyTo = { authorId: REPLIED, url: JUMP, extra: 'x' }
    const r = await send(reply('Hello', { replyTo }))
    expect(r.ok).toBe(true)
    expect(r.clean.replyTo).toEqual({ authorId: REPLIED, url: JUMP })
    expect(r.clean.replyTo).not.toBe(replyTo)
  })

  it('takes a reply with no replyTo, mentions or uploads fields', async () => {
    expect(await send({ source: 'Hello' })).toEqual({ ok: true, clean: { source: 'Hello', replyTo: null, mentions: [], uploads: [] } })
    expect((await send({ source: 'Hello', replyTo: undefined, mentions: undefined, uploads: undefined })).ok).toBe(true)
  })

  it('gives back copies, and changes nothing it was given', async () => {
    const input = reply(`Hi <@${U1}>`, { mentions: [U1], uploads: ['a1'] })
    const copy = JSON.stringify(input)
    const r = await send(input, { ownUploadIds: ['a1'] })
    expect(r.ok).toBe(true)
    r.clean.mentions.push('x')
    r.clean.uploads.push('x')
    expect(JSON.stringify(input)).toBe(copy)
  })

  it('works in the plain form too', async () => {
    expect((await send(reply('Hello'), { form: 'plain' })).ok).toBe(true)
  })
})

describe('validateReply: nothing to send', () => {
  const COPY = { ok: false, status: 400, error: 'Write something first.' }

  it('refuses an empty text, or one of only whitespace or nothing that shows', async () => {
    for (const source of ['', ' ', '\n\n', '\t \r\n', '\u00a0', '\u200b', '\ufeff', '\u2028', '\u0000', ' \u200b\u200d\u2060 ', '\u0001\u0002', '\u3000']) {
      expect(await send(reply(source)), JSON.stringify(source)).toEqual(COPY)
    }
  })

  it('refuses what is not a text, and what is not a reply', async () => {
    for (const source of [undefined, null, 5, {}, [], ['a'], true]) expect(await send(reply(source)), String(source)).toEqual(COPY)
    for (const input of [undefined, null, 5, 'hello', [], true]) expect(await send(input), String(input)).toEqual(COPY)
  })

  it('takes one character that shows', async () => {
    for (const source of ['.', 'a', '😀', '\u200ba\u200b', ' é ']) expect((await send(reply(source))).ok, source).toBe(true)
  })

  it('is told before anything else is looked at', async () => {
    expect(await send(reply('', { mentions: 'x', uploads: 'x' }))).toEqual(COPY)
  })
})

describe('validateReply: how long a source may be', () => {
  const BUDGET = { ok: false, status: 413, error: "That's longer than Discord can carry in 3 messages." }

  it('keeps the limit at 16,000 code units', () => {
    expect(MAX_SOURCE).toBe(16_000)
  })

  it('takes a source of exactly 16,000 that fits in a message, and refuses one of 16,001', async () => {
    expect(padded(16_000)).toHaveLength(16_000)
    expect((await send(reply(padded(16_000)))).ok).toBe(true)
    expect(padded(16_001)).toHaveLength(16_001)
    expect(await send(reply(padded(16_001)))).toEqual(BUDGET)
    expect((await send(reply(padded(15_999)))).ok).toBe(true)
  })

  it('counts code units, not characters', async () => {
    expect(await send(reply(`${padded(15_998)}\n😀`))).toEqual(BUDGET)
    expect((await send(reply(`${padded(15_997)}\n😀`))).ok).toBe(true)
  })

  it('refuses a huge source at once, as too long and before it is parsed', async () => {
    const started = Date.now()
    expect(await send(reply('a '.repeat(3_000_000)))).toEqual(BUDGET)
    expect(await send(reply(' '.repeat(5_000_000)))).toEqual(BUDGET)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('tells a huge source it is too long before it asks whether it is empty', async () => {
    expect(await send(reply(' '.repeat(16_001)))).toEqual(BUDGET)
  })
})

describe('validateReply: the 3 messages of Discord', () => {
  const BUDGET = { ok: false, status: 413, error: "That's longer than Discord can carry in 3 messages." }
  const words = (n) => 'word '.repeat(n)

  it('refuses a reply that needs a fourth message', async () => {
    expect(await send(reply(words(2_500)))).toEqual(BUDGET)
    expect(await send(reply(words(2_500)), { form: 'plain' })).toEqual(BUDGET)
  })

  it('takes a reply of two and of three messages', async () => {
    expect((await send(reply(words(1_300)))).ok).toBe(true)
    expect((await send(reply(words(2_200)))).ok).toBe(true)
  })

  it('counts the messages of the form it is given: a long reply fits in the primary form and not in the fallback', async () => {
    expect((await send(reply(words(1_300)), { form: 'v2' })).ok).toBe(true)
    expect(await send(reply(words(1_300)), { form: 'plain' })).toEqual(BUDGET)
  })

  it('uses the primary form when it is not told', async () => {
    expect((await validateReply(reply(words(1_300)), { automod: none, ownUploadIds: [], authorId: U1, siteUrl: SITE })).ok).toBe(true)
  })

  // The first size of a reply, in words, that one set of options takes and another does not: where a length of the footer, the
  // author or the reply line shows. The plain form holds about 1,050 of these words in 3 messages.
  const between = async (take, refuse) => {
    for (let n = 1_000; n < 1_150; n++) if ((await send(reply(words(n)), take)).ok && (await send(reply(words(n)), refuse)).status === 413) return n
    return null
  }

  it('counts the room that the footer takes in the fallback, as the caller says it is', async () => {
    const short = 'https://s.example/a'
    const long = `https://s.example/${'a'.repeat(180)}`
    const n = await between({ form: 'plain', siteUrl: short }, { form: 'plain', siteUrl: long })
    expect(n).not.toBeNull()
    expect((await send(reply(words(n)), { form: 'plain', siteUrl: short })).ok).toBe(true)
    expect(await send(reply(words(n)), { form: 'plain', siteUrl: long })).toEqual(BUDGET)
  })

  it('has to be told who writes and where the button goes, so that what it counts and what it checks are what is sent', async () => {
    const options = { form: 'v2', automod: none, ownUploadIds: [] }
    for (const [name, value] of [['authorId', undefined], ['authorId', null], ['authorId', 5], ['authorId', {}], ['siteUrl', undefined], ['siteUrl', null], ['siteUrl', 5], ['siteUrl', ['https://s.example/']]]) {
      const given = { authorId: U1, siteUrl: SITE, ...options, [name]: value }
      await rejectsAs(validateReply(reply('hi'), given), TypeError, `${name} must be a string`)
      // Before the reply is looked at: a reply that is refused for what it says is no excuse.
      await rejectsAs(validateReply(reply(''), given), TypeError, `${name} must be a string`)
    }
    await rejectsAs(validateReply(reply('hi'), options), TypeError, 'authorId must be a string')
  })

  it('counts the room that the author takes, as the caller says it is', async () => {
    // With the longest link there can be, so that the 3 characters of the author are the ones that decide.
    const siteUrl = `https://${'a'.repeat(192)}`
    const n = await between({ form: 'plain', siteUrl, authorId: '1'.repeat(17) }, { form: 'plain', siteUrl, authorId: '1'.repeat(20) })
    expect(n).not.toBeNull()
    expect(await send(reply(words(n)), { form: 'plain', siteUrl, authorId: '1'.repeat(20) })).toEqual(BUDGET)
    expect((await send(reply(words(n)), { form: 'plain', siteUrl, authorId: '1'.repeat(17) })).ok).toBe(true)
    await expect(send(reply('hi'), { authorId: 'x' })).rejects.toThrow(RangeError)
    await expect(send(reply('hi'), { siteUrl: 'http://s.example/' })).rejects.toThrow(RangeError)
  })

  it('counts the room that the reply line takes', async () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    let n = null
    for (let k = 1_000; k < 1_150 && n === null; k++) {
      const without = (await send(reply(words(k)), { form: 'plain' })).ok
      if (without && (await send(reply(words(k), { replyTo }), { form: 'plain' })).status === 413) n = k
    }
    expect(n).not.toBeNull()
    expect(await send(reply(words(n), { replyTo }), { form: 'plain' })).toEqual(BUDGET)
    expect((await send(reply(words(n), { replyTo }), { form: 'v2' })).ok).toBe(true)
  })

  it('does not show the alt text of a picture that has its file, so it does not count it', async () => {
    const alt = 'a '.repeat(6_000)
    const source = `![${alt}](upload:1)`
    expect((await send(reply(source, { uploads: ['u1'] }), { ownUploadIds: ['u1'] })).ok).toBe(true)
  })

  it('throws, as the form does, for a reply it is told the wrong way', async () => {
    await expect(send(reply('hi', { replyTo: { authorId: 'x', url: 'y' } }))).rejects.toThrow(RangeError)
    await expect(send(reply('hi', { replyTo: 'x' }))).rejects.toThrow(TypeError)
  })
})

describe('validateReply: links', () => {
  const LINK = { ok: false, status: 400, error: 'Links must start with http:// or https://.' }

  it('refuses a masked link to anything but http or https', async () => {
    for (const dest of ['ftp://y.example/', 'javascript:alert(1)', 'www.a.example', '#top', '/a/b', '//a.example', 'mailto:a@b.example', 'data:text/html,x', 'file:///etc/x', 'HTTPS://a.example', 'tel:123', 'a.example', 'a(b)', 'x/(y)(z)']) {
      expect(await send(reply(`See [here](${dest}) now`)), dest).toEqual(LINK)
    }
  })

  it('refuses a link with no address, or whose address is in angle brackets or has space around it', async () => {
    for (const text of ['[x]()', '[x]( )', '[x](<ftp://y.example>)', '[x]( ftp://y.example )', '[x](  <ftp://y.example>  )', '[x]( \t ftp://y.example\t)']) {
      expect(await send(reply(text)), text).toEqual(LINK)
    }
  })

  it('refuses a link that is made of something else, or whose text is', async () => {
    for (const text of ['**[x](ftp://y.example)**', '[*x*](ftp://y.example)', '[x](ftp://y_z_w)', '[x](ftp://y**z**w)', '[x](ftp://y*z*w)', '[x](ftp://y||z||w)', '[x](ftp://y~~z~~w)', '[**x**](ftp://y)', '> [x](ftp://y)', '- [x](ftp://y)', '||[x](ftp://y)||', '# [x](ftp://y)', '| a |\n|---|\n| [x](ftp://y) |', '[^a]: [x](ftp://y)\ntext [^a]', '[x](ftp://y)\n```\ncode\n```']) {
      expect(await send(reply(text)), text).toEqual(LINK)
    }
  })

  it('refuses an angle link to anything but http or https', async () => {
    for (const text of ['<ftp://y.example>', '<mailto:a@b.example>', '<javascript:alert(1)>', '<data:text/html,x>', '<file:///x>', '<FTP://y.example>', 'a <steam://run/1> b', '<x-y.z+w:rest>', '<ab:cd>']) {
      expect(await send(reply(text)), text).toEqual(LINK)
    }
  })

  it('takes a link to http or https, in every way it can be written', async () => {
    for (const text of ['[x](https://a.example)', '[x](http://a.example/p?q=1#f)', '<https://a.example>', 'https://a.example/x', '[x]( <https://a.example> )', '[x](https://a.example) and [y](http://b.example)', '**[x](https://a.example)**']) {
      expect((await send(reply(text))).ok, text).toBe(true)
    }
  })

  it('takes what Discord writes in angle brackets that is not a link', async () => {
    for (const text of ['<t:1700000000:R>', '<t:1700000000>', '<id:customize>', '<id:browse>', `<a:wave:${U1}>`, `<:wave:${U1}>`, `<@${U1}>`, `<#${U2}>`, '<3', 'a < b > c', '<b>bold</b>', '<a:b>']) {
      const mentions = text === `<@${U1}>` ? [U1] : []
      expect((await send(reply(text, { mentions }))).ok, text).toBe(true)
    }
  })

  it('takes a link-shaped text in code, as it is not a link', async () => {
    for (const text of ['`[x](ftp://y)`', '```\n[x](ftp://y)\n```', '``[x](ftp://y)``', '<`ftp://y`>']) {
      expect((await send(reply(text))).ok, text).toBe(true)
    }
  })

  it('takes brackets and parentheses that are not a link', async () => {
    for (const text of ['[x] (ftp://y)', '[see note](see below)', 'f(x) and [1] (a)', '[x](a b)', '(see [1])', ']( no', '[x](\nftp://y)', '[x]\n(ftp://y)', 'a](\nftp://x)', '[x](a((b)))', '[x](a]b)']) {
      expect((await send(reply(text))).ok, text).toBe(true)
    }
  })

  it('takes an address that starts as it should, and that the page cannot make a link of', async () => {
    for (const text of ['[x](https://)', '[x](https://a.example/wiki/Foo_(bar))', '[x](http://a.example "title")', '[x](https://a.example/a((b)))']) {
      expect((await send(reply(text))).ok, text).toBe(true)
    }
  })

  it('takes a picture of the reply, which has the same brackets', async () => {
    expect((await send(reply('![a](upload:1)', { uploads: ['u1'] }), { ownUploadIds: ['u1'] })).ok).toBe(true)
  })

  it('refuses a picture that is not one this form takes, as a link that does not work', async () => {
    expect(await send(reply('![a](upload:11)'))).toEqual(LINK)
    expect(await send(reply('![a](upload:0)'))).toEqual(LINK)
    expect((await send(reply('![a](https://a.example/p.png)'))).ok).toBe(true)
    expect(await send(reply('![a](ftp://a.example/p.png)'))).toEqual(LINK)
  })

  it('stays quick on a text made to make the check slow', async () => {
    const started = Date.now()
    for (const text of [`](${' '.repeat(9_000)}`, '](  '.repeat(1_200), '<a'.repeat(1_500), `<${'a'.repeat(9_000)}`, '](a'.repeat(1_500), '[x]((('.repeat(800), '](<'.repeat(1_500), `](${'(a'.repeat(4_000)}`]) {
      expect((await send(reply(text))).ok, text.slice(0, 12)).toBe(true)
    }
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('validateReply: pictures', () => {
  const MINE = { ok: false, status: 400, error: "That picture isn't one of yours." }
  const TOO_MANY = { ok: false, status: 400, error: 'A reply can hold 10 pictures at most.' }
  const ids = (n) => Array.from({ length: n }, (_, i) => `u${i + 1}`)

  it('takes a picture that is one of the caller, and keeps the list', async () => {
    const r = await send(reply('![a](upload:1) text ![b](upload:2)', { uploads: ['u1', 'u2'] }), { ownUploadIds: ['u1', 'u2', 'u3'] })
    expect(r).toEqual({ ok: true, clean: { source: '![a](upload:1) text ![b](upload:2)', replyTo: null, mentions: [], uploads: ['u1', 'u2'] } })
  })

  it('takes the ids as a list or as a set', async () => {
    const input = reply('![a](upload:1)', { uploads: ['u1'] })
    expect((await send(input, { ownUploadIds: ['u1'] })).ok).toBe(true)
    expect((await send(input, { ownUploadIds: new Set(['u1']) })).ok).toBe(true)
    expect(await send(input, { ownUploadIds: new Set() })).toEqual(MINE)
    expect(await send(input, { ownUploadIds: [] })).toEqual(MINE)
  })

  it('refuses a picture of someone else', async () => {
    expect(await send(reply('![a](upload:1)', { uploads: ['u9'] }), { ownUploadIds: ['u1'] })).toEqual(MINE)
  })

  it('refuses a picture with no file named for it', async () => {
    expect(await send(reply('![a](upload:1)'), { ownUploadIds: ['u1'] })).toEqual(MINE)
    expect(await send(reply('![a](upload:2)', { uploads: ['u1'] }), { ownUploadIds: ['u1'] })).toEqual(MINE)
    expect(await send(reply('![a](upload:10)', { uploads: ids(9) }), { ownUploadIds: ids(9) })).toEqual(MINE)
  })

  it('takes the tenth picture', async () => {
    const r = await send(reply('![a](upload:10)', { uploads: ids(10) }), { ownUploadIds: ids(10) })
    expect(r.ok).toBe(true)
    expect(r.clean.uploads).toEqual(ids(10))
  })

  it('refuses more than ten files, or one that is not one of the caller, even when no picture shows it', async () => {
    expect(await send(reply('text', { uploads: ids(11) }), { ownUploadIds: ids(11) })).toEqual(TOO_MANY)
    expect((await send(reply('text', { uploads: ids(10) }), { ownUploadIds: ids(10) })).ok).toBe(true)
    expect(await send(reply('text', { uploads: ['u1', 'u9'] }), { ownUploadIds: ['u1'] })).toEqual(MINE)
    expect((await send(reply('text', { uploads: ['u1'] }), { ownUploadIds: ['u1'] })).ok).toBe(true)
  })

  it('refuses a list of files that is not a list of ids', async () => {
    for (const uploads of ['u1', {}, 5, true]) expect(await send(reply('text', { uploads }), { ownUploadIds: ['u1'] }), String(uploads)).toEqual(MINE)
    for (const entry of [5, null, undefined, {}, ['u1'], 1n]) {
      expect(await send(reply('text', { uploads: [entry] }), { ownUploadIds: [entry, '5', 'u1'] }), String(entry)).toEqual(MINE)
    }
  })

  it('takes null for no files, as it takes a list with none', async () => {
    expect((await send(reply('text', { uploads: null }))).clean.uploads).toEqual([])
  })

  it('takes the same file twice', async () => {
    expect((await send(reply('![a](upload:1)![b](upload:2)', { uploads: ['u1', 'u1'] }), { ownUploadIds: ['u1'] })).ok).toBe(true)
  })

  it('takes the same picture written twice', async () => {
    expect((await send(reply('![a](upload:1) ![b](upload:1)', { uploads: ['u1'] }), { ownUploadIds: ['u1'] })).ok).toBe(true)
  })

  it('does not count a picture that is written in code', async () => {
    expect((await send(reply('`![a](upload:3)`', { uploads: [] }))).ok).toBe(true)
    expect((await send(reply('```\n![a](upload:3)\n```'))).ok).toBe(true)
  })

  it('takes a reply that is only a picture', async () => {
    expect((await send(reply('![](upload:1)', { uploads: ['u1'] }), { ownUploadIds: ['u1'] })).ok).toBe(true)
  })

  it('is told after the length and the links', async () => {
    expect(await send(reply(`[x](ftp://y) ![a](upload:1)`))).toEqual({ ok: false, status: 400, error: 'Links must start with http:// or https://.' })
    expect(await send(reply(`${'word '.repeat(2_500)} ![a](upload:1)`))).toEqual({ ok: false, status: 413, error: "That's longer than Discord can carry in 3 messages." })
  })
})

// Discord would show a picture inside a spoiler (the form sends it as a gallery item or a file that nothing hides), and the site hides it.
describe('validateReply: a picture inside a spoiler', () => {
  const INSIDE = { ok: false, status: 400, error: "A picture can't go inside a spoiler yet: put it outside the bars." }
  const own = { ownUploadIds: ['u1', 'u2'] }

  it.each(['v2', 'plain'])('refuses one in the %s form, alone, with text round it, in a quote or over lines', async (form) => {
    for (const source of ['||![the last map](upload:1)||', '||The ending: ![map](upload:1) she dies||', '> ||![a](upload:1)||', '||a\n![b](upload:2)\nc||', '![a](upload:1) ||**![b](upload:2)**||']) {
      expect(await send(reply(source, { uploads: ['u1', 'u2'] }), { ...own, form }), source).toEqual(INSIDE)
    }
  })

  it('takes the same pictures outside the bars, and bars with none in them', async () => {
    for (const source of ['![the last map](upload:1) ||the ending||', '||the ending|| ![map](upload:1)', '`||![a](upload:1)||` ![b](upload:2)', '\\|\\|![a](upload:1)\\|\\|']) {
      expect((await send(reply(source, { uploads: ['u1', 'u2'] }), own)).ok, source).toBe(true)
    }
  })

  it('is told after the length and the links, and before whose the pictures are', async () => {
    expect(await send(reply(`[x](ftp://y) ||![a](upload:1)||`))).toEqual({ ok: false, status: 400, error: 'Links must start with http:// or https://.' })
    expect(await send(reply(`${'word '.repeat(2_500)} ||![a](upload:1)||`))).toEqual({ ok: false, status: 413, error: "That's longer than Discord can carry in 3 messages." })
    expect(await send(reply('||![a](upload:1)||', { uploads: ['u9'] }), own)).toEqual(INSIDE)
  })
})

describe('validateReply: mentions', () => {
  const PICK = (cap = 10) => ({ ok: false, status: 400, error: `Pick people to mention from the list (${cap} at most).` })
  const id = (n) => `2000000000000005${String(n).padStart(2, '0')}`
  const tokens = (n, open = '<@') => Array.from({ length: n }, (_, i) => `${open}${id(i)}>`).join(' ')
  const picked = (n) => Array.from({ length: n }, (_, i) => id(i))

  it('takes a mention of a person who was picked, and names them', async () => {
    const r = await send(reply(`Hi <@${U1}> and <@${U2}>`, { mentions: [U2, U1, U3] }))
    expect(r.ok).toBe(true)
    expect(r.clean.mentions).toEqual([U1, U2])
  })

  it('takes a mention with a bang as the same person', async () => {
    const r = await send(reply(`Hi <@!${U1}> and <@${U1}>`, { mentions: [U1] }))
    expect(r.ok).toBe(true)
    expect(r.clean.mentions).toEqual([U1])
  })

  it('refuses a mention of a person who was not picked', async () => {
    expect(await send(reply(`Hi <@${U1}>`))).toEqual(PICK())
    expect(await send(reply(`Hi <@${U1}>`, { mentions: [U2] }))).toEqual(PICK())
    expect(await send(reply(`Hi <@${U1}> <@${U2}>`, { mentions: [U1] }))).toEqual(PICK())
    expect(await send(reply(`Hi <@!${U1}>`, { mentions: [U2] }))).toEqual(PICK())
  })

  it('refuses a mention of a role, which no one can pick', async () => {
    expect(await send(reply(`Hi <@&${ROLE_A}>`, { mentions: [ROLE_A] }))).toEqual(PICK())
    expect(await send(reply(`Hi <@&${ROLE_A}>`))).toEqual(PICK())
  })

  it('takes a mention of a channel, which pings no one', async () => {
    expect((await send(reply(`See <#${POST}>`))).ok).toBe(true)
  })

  it('takes @everyone and @here as text, which the message cannot ping', async () => {
    expect((await send(reply('Hi @everyone and @here'))).ok).toBe(true)
  })

  it('does not count a mention in code, which is not one', async () => {
    expect((await send(reply(`\`<@${U1}>\``))).ok).toBe(true)
    expect((await send(reply(`\`\`\`\n<@${U1}>\n\`\`\``))).ok).toBe(true)
  })

  it('counts a mention in a quote, a list, a spoiler, a heading and a table', async () => {
    for (const text of [`> <@${U1}>`, `- <@${U1}>`, `||<@${U1}>||`, `# <@${U1}>`, `**<@${U1}>**`, `| a |\n|---|\n| <@${U1}> |`, `[^a]: <@${U1}>\ntext [^a]`]) {
      expect(await send(reply(text)), text).toEqual(PICK())
      expect((await send(reply(text, { mentions: [U1] }))).ok, text).toBe(true)
    }
  })

  it('drops a person who was picked and is not mentioned, and does not count them', async () => {
    const r = await send(reply(`Hi <@${U1}>`, { mentions: [U1, ...picked(30)] }))
    expect(r.ok).toBe(true)
    expect(r.clean.mentions).toEqual([U1])
  })

  it('takes ten people and refuses an eleventh', async () => {
    expect((await send(reply(tokens(10), { mentions: picked(10) }))).ok).toBe(true)
    expect(await send(reply(tokens(11), { mentions: picked(11) }))).toEqual(PICK())
    expect(await send(reply(tokens(40), { mentions: picked(40) }))).toEqual(PICK())
  })

  it('counts a person once however often they are mentioned', async () => {
    const text = Array.from({ length: 25 }, (_, i) => `<@${id(i % 10)}>`).join(' ')
    const r = await send(reply(text, { mentions: picked(10) }))
    expect(r.ok).toBe(true)
    expect(r.clean.mentions).toEqual(picked(10))
  })

  it('keeps the people in the order they are mentioned', async () => {
    const r = await send(reply(`<@${U3}> <@${U1}> <@${U2}> <@${U3}>`, { mentions: [U1, U2, U3] }))
    expect(r.clean.mentions).toEqual([U3, U1, U2])
  })

  it('keeps to the cap the caller gives, and to the least of that and the cap of the rules', async () => {
    expect((await send(reply(tokens(3), { mentions: picked(3) }), { mentionCap: 3 })).ok).toBe(true)
    expect(await send(reply(tokens(4), { mentions: picked(4) }), { mentionCap: 3 })).toEqual(PICK(3))
    expect(await send(reply(tokens(1), { mentions: picked(1) }), { mentionCap: 0 })).toEqual(PICK(0))
    expect((await send(reply('no one'), { mentionCap: 0 })).ok).toBe(true)
    const strict = Object.assign(() => null, { mentionCap: 4 })
    expect((await send(reply(tokens(4), { mentions: picked(4) }), { automod: strict })).ok).toBe(true)
    expect(await send(reply(tokens(5), { mentions: picked(5) }), { automod: strict })).toEqual(PICK(4))
    expect(await send(reply(tokens(5), { mentions: picked(5) }), { automod: strict, mentionCap: 5 })).toEqual(PICK(4))
    expect(await send(reply(tokens(5), { mentions: picked(5) }), { automod: strict, mentionCap: 3 })).toEqual(PICK(3))
    expect((await send(reply(tokens(4), { mentions: picked(4) }), { automod: strict, mentionCap: 4 })).ok).toBe(true)
  })

  it('takes the cap of the matcher of the rules, as it comes', async () => {
    const m = automodMatcher([mentionRule(6)], quiet)
    expect((await send(reply(tokens(5), { mentions: picked(5) }), { automod: m })).ok).toBe(true)
    expect(await send(reply(tokens(6), { mentions: picked(6) }), { automod: m })).toEqual(PICK(5))
    const free = automodMatcher([mentionRule(6)], { ...quiet, isAdmin: true })
    expect((await send(reply(tokens(10), { mentions: picked(10) }), { automod: free })).ok).toBe(true)
    expect(await send(reply(tokens(11), { mentions: picked(11) }), { automod: free })).toEqual(PICK(10))
  })

  it('does not take a cap that is not a whole number for no cap', async () => {
    const odd = Object.assign(() => null, { mentionCap: '2' })
    expect((await send(reply(tokens(10), { mentions: picked(10) }), { automod: odd })).ok).toBe(true)
    expect(await send(reply(tokens(11), { mentions: picked(11) }), { automod: odd })).toEqual(PICK())
    const nan = Object.assign(() => null, { mentionCap: NaN })
    expect(await send(reply(tokens(11), { mentions: picked(11) }), { automod: nan })).toEqual(PICK())
  })

  it('refuses a list of picked people that is not a list', async () => {
    for (const mentions of ['x', {}, 5, true]) expect(await send(reply(`<@${U1}>`, { mentions }))).toEqual(PICK())
    for (const mentions of ['x', {}, 5, true]) expect(await send(reply('hi', { mentions })), String(mentions)).toEqual(PICK())
  })

  it('takes null for no one picked, as it takes a list with none', async () => {
    expect((await send(reply('hi', { mentions: null }))).clean.mentions).toEqual([])
    expect(await send(reply(`<@${U1}>`, { mentions: null }))).toEqual(PICK())
  })

  it('does not take a picked entry that is not an id for a person', async () => {
    expect(await send(reply(`<@${U1}>`, { mentions: [5, null, {}, [U1], U2] }))).toEqual(PICK())
    expect((await send(reply(`<@${U1}>`, { mentions: [5, null, {}, U1] }))).ok).toBe(true)
  })

  it('does not take an id with a leading zero for a person who was picked', async () => {
    const zero = `0${U1.slice(1)}`
    expect(await send(reply(`<@${zero}>`, { mentions: [zero] }))).toEqual(PICK())
    expect(await send(reply(`<@${U1}>`, { mentions: [zero] }))).toEqual(PICK())
    expect((await send(reply(`<@${'1'.repeat(20)}>`, { mentions: ['1'.repeat(20)] }))).ok).toBe(true)
    expect((await send(reply(`<@${'1'.repeat(17)}>`, { mentions: ['1'.repeat(17)] }))).ok).toBe(true)
  })

  it('is told after the length, the links and the pictures', async () => {
    expect(await send(reply(`[x](ftp://y) <@${U1}>`))).toEqual({ ok: false, status: 400, error: 'Links must start with http:// or https://.' })
    expect(await send(reply(`<@${U1}> ![a](upload:1)`))).toEqual({ ok: false, status: 400, error: "That picture isn't one of yours." })
  })
})

describe('validateReply: the rules of the server', () => {
  const blockZorp = automodMatcher([keywordRule(['zorp'], {}, { name: 'No Zorp' })], quiet)

  it('refuses a reply that a rule blocks, with the rule and where', async () => {
    expect(await send(reply('Say zorp now'), { automod: blockZorp })).toEqual({
      ok: false,
      status: 422,
      error: 'Blocked by the server\'s AutoMod rule "No Zorp".',
      rule: 'No Zorp',
      match: { start: 4, end: 8 },
    })
  })

  it('takes a reply that no rule blocks', async () => {
    expect((await send(reply('Say nothing'), { automod: blockZorp })).ok).toBe(true)
  })

  it('asks the matcher about the text it will send, and then about what each message of it shows', async () => {
    const seen = []
    const automod = (text) => (seen.push(text), null)
    await send(reply('Hello <@!' + U1 + '>', { mentions: [U1] }), { automod })
    await send(reply('a\u0000b'), { automod })
    expect(seen).toEqual([`Hello <@!${U1}>`, `Hello <@!${U1}>`, 'a\ufffdb', 'a\ufffdb'])
  })

  it('answers with where the match is in the source the writer sees, even when it was cleaned', async () => {
    const r = await send(reply('a\u0000b zorp\ud800 c'), { automod: blockZorp })
    expect(r.match).toEqual({ start: 4, end: 8 })
  })

  it('is told after everything else', async () => {
    expect((await send(reply('zorp [x](ftp://y)'), { automod: blockZorp })).status).toBe(400)
    expect((await send(reply(`zorp <@${U1}>`), { automod: blockZorp })).status).toBe(400)
    expect((await send(reply('zorp ![a](upload:1)'), { automod: blockZorp })).status).toBe(400)
    expect((await send(reply(`zorp ${'word '.repeat(2_500)}`), { automod: blockZorp })).status).toBe(413)
    expect((await send(reply('zorp'), { automod: blockZorp })).status).toBe(422)
  })

  it('does not run the matcher for a reply that is refused before it', async () => {
    let asked = 0
    const automod = () => (asked++, null)
    await send(reply(''), { automod })
    await send(reply('[x](ftp://y)'), { automod })
    await send(reply(`<@${U1}>`), { automod })
    await send(reply('x'.repeat(16_001)), { automod })
    expect(asked).toBe(0)
    // The source, and what the one message of it shows.
    await send(reply('fine'), { automod })
    expect(asked).toBe(2)
  })

  it('reads a member who is exempt as one who may write what the rule blocks', async () => {
    const exempt = automodMatcher([keywordRule(['zorp'], {}, { exempt_roles: [ROLE_A] })], { ...quiet, memberRoleIds: [ROLE_A] })
    expect((await send(reply('zorp'), { automod: exempt })).ok).toBe(true)
  })
})

describe('shownBy: what the messages show of the reply itself', () => {
  const REPLY = '-# ↪ <@200000000000000443> [jump](<https://discord.example/x>)'
  const FOOT = '-# <@200000000000000421>'
  const v2 = (...contents) => ({ text: contents.join('\n'), components: [{ type: 17, components: contents.map((content) => ({ type: 10, content })) }], files: [] })
  const plain = (text) => ({ text, components: null, files: [] })
  const fixed = { reply: REPLY, footer: FOOT }

  it('is the text of a plain message, and the contents of the Text Displays of a V2 one, one by one', () => {
    expect(shownBy([plain('hello\nthere')], { reply: null, footer: FOOT })).toEqual(['hello\nthere'])
    expect(shownBy([v2('first')], { reply: null, footer: FOOT })).toEqual(['first'])
  })

  it('adds, for a V2 message of more than one Text Display, the contents joined by a line end, which is what the fallback shows of it', () => {
    expect(shownBy([v2('first', 'second', 'third')], { reply: null, footer: FOOT })).toEqual(['first', 'second', 'third', 'first\nsecond\nthird'])
    expect(shownBy([v2('first', '', 'third')], { reply: null, footer: FOOT })).toEqual(['first', 'third', 'first\nthird'])
    // A plain message is one text, and a V2 one with one display shows nothing more.
    expect(shownBy([plain('first\nsecond')], { reply: null, footer: FOOT })).toEqual(['first\nsecond'])
    expect(shownBy([v2('first', FOOT)], { reply: null, footer: FOOT })).toEqual(['first'])
  })

  it('joins the Text Displays of each message by themselves, and never those of two messages', () => {
    const parts = [v2('**1/2** a', 'b'), v2('**2/2** c', 'd')]
    expect(shownBy(parts, { reply: null, footer: FOOT })).toEqual(['a', 'b', 'a\nb', 'c', 'd', 'c\nd'])
  })

  it('finds Text Displays however deep they are in the components, and skips what is not one', () => {
    const part = {
      text: '',
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: 'one' },
            { type: 12, items: [{ media: { url: 'attachment://a.png' } }] },
            { type: 14, divider: true },
            { type: 1, components: [{ type: 2, label: 'Open On Site', url: 'https://x.example/' }] },
            { type: 17, components: [{ type: 10, content: 'two' }] },
          ],
        },
      ],
      files: [],
    }
    expect(shownBy([part], { reply: null, footer: FOOT })).toEqual(['one', 'two', 'one\ntwo'])
  })

  it('takes the reply line off the start of the first message, and the footer off the end of the last', () => {
    expect(shownBy([plain(`${REPLY}\nhello\n${FOOT}`)], fixed)).toEqual(['hello'])
    expect(shownBy([v2(`${REPLY}\nhello\n${FOOT}`)], fixed)).toEqual(['hello'])
    expect(shownBy([v2(`${REPLY}\nhello`, `more\n${FOOT}`)], fixed)).toEqual(['hello', 'more', 'hello\nmore'])
  })

  it('takes a line off that is the whole of its Text Display, and leaves nothing of it', () => {
    expect(shownBy([v2(REPLY, 'hello', FOOT)], fixed)).toEqual(['hello'])
    expect(shownBy([v2(REPLY)], { reply: REPLY, footer: REPLY })).toEqual([])
    expect(shownBy([plain(`${REPLY}\n${FOOT}`)], fixed)).toEqual([])
  })

  it('leaves a first line that is not the reply line, a last line that is not the footer, and a line that is only part of one', () => {
    expect(shownBy([plain('hello\nthere')], fixed)).toEqual(['hello\nthere'])
    expect(shownBy([plain(`${REPLY} more\nhello\n${FOOT} more`)], fixed)).toEqual([`${REPLY} more\nhello\n${FOOT} more`])
    expect(shownBy([plain(`hello\n${REPLY}\n${FOOT}\nx`)], fixed)).toEqual([`hello\n${REPLY}\n${FOOT}\nx`])
    expect(shownBy([plain(`x${REPLY}\nhello`)], fixed)).toEqual([`x${REPLY}\nhello`])
    expect(shownBy([plain(`hello\nx${FOOT}`)], fixed)).toEqual([`hello\nx${FOOT}`])
    expect(shownBy([plain(`hello${FOOT}`)], fixed)).toEqual([`hello${FOOT}`])
  })

  it('takes nothing off the start when there is no reply line, even a first line that says null or is the stand-in', () => {
    expect(shownBy([plain('null\nx')], { reply: null, footer: FOOT })).toEqual(['null\nx'])
    expect(shownBy([v2('null', 'more')], { reply: null, footer: FOOT })).toEqual(['null', 'more', 'null\nmore'])
  })

  it('looks for the reply line in the first part only, and for the footer in the last only', () => {
    // The footer of the first part and the reply line of the second are in the reply itself, as far as this goes.
    const parts = [plain(`**1/2** one\n${FOOT}`), plain(`${REPLY}\n**2/2** two`)]
    expect(shownBy(parts, fixed)).toEqual([`one\n${FOOT}`, `${REPLY}\n**2/2** two`])
  })

  it('takes the mark of a part off its start when there is more than one part, whether a space, a line end or nothing follows it', () => {
    const two = (a, b) => shownBy([plain(a), plain(b)], { reply: null, footer: FOOT })
    expect(two('**1/2** one', '**2/2** two')).toEqual(['one', 'two'])
    expect(two('**1/2**\n# one', '**2/2**\n# two')).toEqual(['# one', '# two'])
    expect(two('**1/2**', '**2/2**\nafter')).toEqual(['after'])
    expect(shownBy([v2('**1/2**', 'one'), v2('**2/2**')], { reply: null, footer: FOOT })).toEqual(['one'])
  })

  it('takes the mark that is its own Text Display, which is what a part that starts with a picture has', () => {
    expect(shownBy([v2('**1/2**', 'a'), v2('**2/2**', 'b')], { reply: null, footer: FOOT })).toEqual(['a', 'b'])
    expect(shownBy([v2(`${REPLY}\n**1/2**`, 'a'), v2('**2/2**', 'b')], fixed)).toEqual(['a', 'b'])
  })

  it('leaves what is not the mark of that part: another part\'s mark, a mark with something stuck to it, or one that is not at the start', () => {
    const two = (a, b) => shownBy([plain(a), plain(b)], { reply: null, footer: FOOT })
    expect(two('**2/2** one', '**1/2** two')).toEqual(['**2/2** one', '**1/2** two'])
    expect(two('**1/2**x one', '**2/2**x two')).toEqual(['**1/2**x one', '**2/2**x two'])
    expect(two('x **1/2** one', 'x **2/2** two')).toEqual(['x **1/2** one', 'x **2/2** two'])
    expect(two('**1/3** one', '**2/3** two')).toEqual(['**1/3** one', '**2/3** two'])
  })

  it('takes no mark off a reply of one part, even one that starts like it', () => {
    expect(shownBy([plain('**1/1** one')], { reply: null, footer: FOOT })).toEqual(['**1/1** one'])
    expect(shownBy([plain('**1/2** one')], { reply: null, footer: FOOT })).toEqual(['**1/2** one'])
  })

  it('takes the reply line first, so that the mark that follows it is the start', () => {
    expect(shownBy([plain(`${REPLY}\n**1/2** one`), plain(`**2/2** two\n${FOOT}`)], fixed)).toEqual(['one', 'two'])
  })

  it('leaves out a text that is nothing, and keeps the order of the parts', () => {
    expect(shownBy([v2('**1/3**', '', 'a'), v2('**2/3**'), v2('**3/3** c', FOOT)], fixed)).toEqual(['a', 'c'])
  })
})

describe('validateReply: the text that is sent, not only the text that was written', () => {
  // A picture written inside a line is sent as a file, and nothing of it is left in the line: what stood on its two sides is next
  // to each other in what Discord shows, where no rule of the server's own is applied to it by Discord (a webhook is not filtered).
  const zorp = automodMatcher([keywordRule(['zorp'], {}, { name: 'No Zorp' })], quiet)
  const phrase = automodMatcher([keywordRule(['the mat'], {}, { name: 'No Mat' })], quiet)
  const withPicture = { uploads: ['u1'] }
  const via = (source, automod, over = {}) => send(reply(source, withPicture), { automod, ownUploadIds: ['u1'], ...over })
  const BLOCK = (name) => ({ ok: false, status: 422, error: `Blocked by the server's AutoMod rule "${name}".`, rule: name, match: null })

  it('refuses a picture inside a word, which joins the two halves of it, in both forms', async () => {
    expect(zorp('zo![x](upload:1)rp')).toBeNull()
    for (const form of ['v2', 'plain']) {
      expect(await via('zo![x](upload:1)rp', zorp, { form }), form).toEqual(BLOCK('No Zorp'))
      expect(await via('say zo![](upload:1)rp now', zorp, { form }), form).toEqual(BLOCK('No Zorp'))
      expect(await via('zo![x](upload:1)![y](upload:1)rp', zorp, { form }), form).toEqual(BLOCK('No Zorp'))
    }
  })

  it('refuses a picture between the words of a phrase that run together without it', async () => {
    expect(phrase('the ![x](upload:1)mat')).toBeNull()
    for (const form of ['v2', 'plain']) {
      expect(await via('the ![x](upload:1)mat', phrase, { form }), form).toEqual(BLOCK('No Mat'))
      expect(await via('the![x](upload:1) mat', phrase, { form }), form).toEqual(BLOCK('No Mat'))
    }
  })

  it('refuses a picture in a cell of a table, which shows as its alt text, and so as nothing when there is none', async () => {
    const table = '| h |\n|---|\n| zo![](upload:1)rp |'
    expect(zorp(table)).toBeNull()
    for (const form of ['v2', 'plain']) expect(await via(table, zorp, { form }), form).toEqual(BLOCK('No Zorp'))
    expect((await via('| h |\n|---|\n| zo![x](upload:1)rp |', zorp)).ok).toBe(true)
  })

  it('refuses a picture that is all a mark holds, which is left out with the picture', async () => {
    for (const source of ['zo**![x](upload:1)**rp', 'zo~~![x](upload:1)~~rp', 'zo*![x](upload:1)*rp', 'zo__![x](upload:1)__rp', '[zo![x](upload:1)rp](https://example.test/a)']) {
      expect(zorp(source), source).toBeNull()
      for (const form of ['v2', 'plain']) expect(await via(source, zorp, { form }), `${form} ${source}`).toEqual(BLOCK('No Zorp'))
    }
    // A spoiler of a picture is refused before the rules read it: the picture would show in Discord.
    for (const form of ['v2', 'plain']) {
      expect(await via('zo||![x](upload:1)||rp', zorp, { form }), form).toEqual({ ok: false, status: 400, error: "A picture can't go inside a spoiler yet: put it outside the bars." })
    }
  })

  it('refuses a picture in a note under the text, which the note shows as its alt text', async () => {
    const source = 'a note[^1]\n\n[^1]: zo![](upload:1)rp'
    expect(zorp(source)).toBeNull()
    for (const form of ['v2', 'plain']) expect(await via(source, zorp, { form }), form).toEqual(BLOCK('No Zorp'))
  })

  it('refuses a picture in a quote, a list, a heading and a line of small print', async () => {
    for (const lead of ['> ', '- ', '1. ', '# ', '### ', '-# ']) {
      for (const form of ['v2', 'plain']) expect(await via(`${lead}zo![x](upload:1)rp`, zorp, { form }), `${form} ${lead}`).toEqual(BLOCK('No Zorp'))
    }
  })

  it('refuses the same text with no picture in it, as the source check does, and with the match in the source', async () => {
    expect(await via('say zorp now', zorp)).toEqual({ ...BLOCK('No Zorp'), match: { start: 4, end: 8 } })
  })

  it('takes a picture that is not between two halves of anything', async () => {
    for (const source of ['zo ![x](upload:1) rp', 'zo\n\n![x](upload:1)\n\nrp', '![x](upload:1)zorb', 'zo![x](upload:1)', '![x](upload:1)rp']) {
      for (const form of ['v2', 'plain']) expect((await via(source, zorp, { form })).ok, `${form} ${source}`).toBe(true)
    }
  })

  it('refuses the words that a picture alone on its line sets apart, in the primary form as in the fallback: the same reply, the same answer', async () => {
    // In V2 the two halves are two Text Displays, and in the fallback one text with the picture's lines gone: what a reader sees is the same.
    for (const source of ['the\n\n![x](upload:1)\n\nmat', 'the\n![x](upload:1)\nmat', 'the\n\n![x](upload:1)\n\n![x](upload:1)\n\nmat', '> the\n\n![x](upload:1)\n\nmat']) {
      expect(phrase(source), source).toBeNull()
      for (const form of ['v2', 'plain']) expect(await via(source, phrase, { form }), `${form} ${source}`).toEqual(BLOCK('No Mat'))
    }
    // The same without the phrase: nothing is refused.
    for (const form of ['v2', 'plain']) expect((await via('the\n\n![x](upload:1)\n\nmug', phrase, { form })).ok, form).toBe(true)
  })

  it('does not look at what the site writes into a message: the reply line, the mark of a part, the footer, the button', async () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    const words = (n) => 'word '.repeat(n)
    const site = automodMatcher([keywordRule(['jump', 'open', 'site', 'on', 'from', 'continues', REPLIED, JUMP, 'discord', 'channels', '1', '2', '3', '1/2', '2/2', '*1*', '*2*', '*open*', '*discord*', '*jump*', '*↪*', U1, '*a*example*'], {}, { name: 'Site' })], quiet)
    for (const form of ['v2', 'plain']) {
      const one = await send(reply('Hello there', { replyTo }), { automod: site, form, authorId: U1, siteUrl: 'https://example.test/x' })
      expect(one.ok, form).toBe(true)
      const long = await send(reply(words(1_300), { replyTo }), { automod: site, form: 'v2', authorId: U1, siteUrl: 'https://example.test/x' })
      expect(long.ok).toBe(true)
    }
    // The same words in the reply itself are refused, which shows the keywords are good ones.
    expect((await send(reply('please jump'), { automod: site })).status).toBe(422)
    expect((await send(reply('open'), { automod: site, form: 'plain' })).status).toBe(422)
  })

  it('looks at every message of a long reply: the word that a picture joins is found in the first, the middle and the last', async () => {
    const filler = (n) => 'word '.repeat(n)
    const joined = 'zo![](upload:1)rp'
    const lay = (head, tail) => `${filler(head)}${joined} ${filler(tail)}`
    const geometry = [
      ['v2', lay(0, 1_100), 2],
      ['v2', lay(1_100, 0), 2],
      ['v2', lay(0, 2_100), 3],
      ['v2', lay(1_000, 1_000), 3],
      ['v2', lay(2_100, 0), 3],
      ['plain', lay(0, 600), 2],
      ['plain', lay(600, 0), 2],
      ['plain', lay(500, 500), 3],
    ]
    for (const [form, source, count] of geometry) {
      const sent = toDiscord(source, { form, authorId: U1, siteUrl: 'https://example.test/x', replyTo: null, images: [{ ref: 1, name: 'image-1.png' }] })
      expect(sent.parts, `${form} ${source.length}`).toHaveLength(count)
      expect(await via(source, zorp, { form }), `${form} ${source.length}`).toEqual(BLOCK('No Zorp'))
    }
  })

  it('keeps the match to the source: null for a hit that only the sent text has', async () => {
    const r = await via('zo![x](upload:1)rp', zorp)
    expect(r.match).toBeNull()
    expect(Object.hasOwn(r, 'match')).toBe(true)
    expect(r.rule).toBe('No Zorp')
  })

  it('is told before the sent text is read: a refusal for a link, a picture or a mention comes first', async () => {
    expect((await via('zo![x](upload:1)rp [x](ftp://y)', zorp)).status).toBe(400)
    expect((await via(`zo![x](upload:1)rp <@${U1}>`, zorp)).status).toBe(400)
    expect((await send(reply('zo![x](upload:1)rp'), { automod: zorp })).status).toBe(400)
  })

  describe('for any source made around the keyword (the property)', () => {
    const m = automodMatcher([keywordRule(['*zorp*'], {}, { name: 'No Zorp' })], quiet)
    const squash = (t) => t.replace(/[*_~|`\\\u200b]/g, '').toLowerCase()
    const sentOf = (source, form) =>
      toDiscord(source, { form, authorId: U1, siteUrl: 'https://example.test/x', replyTo: null, images: [{ ref: 1, name: 'image-1.png' }] })
        .parts.map((part) => part.text)
        .join('\n')
    const shownOf = (source, form) => squash(sentOf(source, form))
    // The text of a link beside the text round it, without the brackets and the address: `[zo](https://x)rp` shows "zorp", which the
    // matcher reads as well (the oracle is its own: one pass of its own pattern, over the source and over what is sent).
    const unlink = (text) => text.replace(/\[([^\][\n]*)\]\([^)\n]*\)/g, '$1')
    // Where the keyword may be found for a refusal to be right: in the source or in what is sent, as written and with the links read as their text.
    const holdsZorp = (source, form) => [source, unlink(source), sentOf(source, form), unlink(sentOf(source, form))].some((text) => squash(text).includes('zorp'))

    it('refuses the reply when what is sent holds the keyword, and only then, where the keyword is cut by what is left out of the line', async () => {
      const gap = fc.array(fc.constantFrom('![x](upload:1)', '![](upload:1)', '**', '*', '_', '||', '~~', '`', ' ', '\n', '\u200b', '[^1]', '\\'), { maxLength: 3 }).map((a) => a.join(''))
      const lead = fc.constantFrom('', '> ', '- ', '1. ', '# ', '### ', '-# ', '| h |\n|---|\n| ', '\n\n[^1]: ', 'say ', '**', '||', '[', '*', '> - ')
      const tail = fc.constantFrom('', ' |', '** ', '||', '](https://example.test/a)', ' more', '\n\n[^1]: note', '*')
      let onlyInSent = 0
      await fc.assert(
        fc.asyncProperty(lead, fc.integer({ min: 1, max: 3 }), gap, tail, fc.constantFrom('v2', 'plain'), async (before, cut, between, after, form) => {
          const source = `${before}${'zorp'.slice(0, cut)}${between}${'zorp'.slice(cut)}${after}`
          const r = await via(source, m, { authorId: U1, siteUrl: 'https://example.test/x', form })
          const inSent = shownOf(source, form).includes('zorp')
          if (inSent) expect(r.ok, source).toBe(false)
          if (inSent && m(source) === null && r.status === 422) onlyInSent++
          if (!r.ok && r.status === 422) expect(holdsZorp(source, form), source).toBe(true)
        }),
        { numRuns: 1_500 },
      )
      // Not a property that holds because nothing reaches it: a good part of the sources are ones that only the sent text refuses.
      expect(onlyInSent).toBeGreaterThan(100)
    })

    it('refuses the same replies in the primary form and in the fallback, where each is one message (the property)', async () => {
      // The two forms cut a reply in different places (3,950 and 1,950 characters a message), so a reply of more than one message in
      // either has parts that the other has not: those are left out, and a reply that is long in both is checked by the property above,
      // on its own parts. What is compared is a reply that either form sends as one message, where the text shown is the same text
      // (the picture lines that set it apart in V2 are blank lines in the fallback), whatever the order and the placing of pictures.
      const two = automodMatcher([keywordRule(['*zorp*', 'the mat'], {}, { name: 'No Zorp' })], quiet)
      const pieces = fc.constantFrom('zo', 'rp', 'z', 'orp', 'zorp', 'the', 'mat', ' ', '\n', '\n\n', '\n\n![x](upload:1)\n\n', '\n![](upload:1)\n', '![x](upload:1)', '![](upload:1)', '**', '||', '~~', '> ', '- ', '# ', '---', '\n\n---\n\n', '| a | b |\n|---|---|\n| ', ' |', '[^1]', '\n\n[^1]: ', '`', '\\')
      // Half the sources are built around the two keywords, with what sets the halves apart between them; half are made of anything.
      const gap = fc.constantFrom('![x](upload:1)', '![](upload:1)', '\n\n![x](upload:1)\n\n', '\n![](upload:1)\n', ' ![x](upload:1) ', '**![x](upload:1)**', '||![x](upload:1)||', '\n\n---\n\n', '\n\n', ' ', '')
      const lead = fc.constantFrom('', '> ', '- ', '# ', '| h |\n|---|\n| ', '\n\n[^1]: ', 'say ')
      const around = fc
        .tuple(lead, fc.constantFrom(['zo', 'rp'], ['z', 'orp'], ['the ', 'mat'], ['the', 'mat'], ['the\n', 'mat']), gap, gap)
        .map(([before, [one, other], between, after]) => `${before}${one}${between}${other}${after}`)
      let bothRefusedBySent = 0
      let compared = 0
      await fc.assert(
        fc.asyncProperty(fc.oneof(around, fc.array(pieces, { minLength: 1, maxLength: 14 }).map((list) => list.join(''))), async (source) => {
          const options = { authorId: U1, siteUrl: 'https://example.test/x' }
          const made = (form) => toDiscord(source, { ...options, form, replyTo: null, images: [{ ref: 1, name: 'image-1.png' }] })
          if (made('v2').parts.length !== 1 || made('plain').parts.length !== 1) return
          compared++
          const v2 = await via(source, two, { ...options, form: 'v2' })
          const plain = await via(source, two, { ...options, form: 'plain' })
          expect(v2, source).toEqual(plain)
          if (!v2.ok && v2.status === 422 && two(source) === null) bothRefusedBySent++
        }),
        { numRuns: 3_000 },
      )
      expect(compared).toBeGreaterThan(2_000)
      // Not a property that holds for want of anything to refuse: a good part of the sources are refused only for what is sent.
      expect(bothRefusedBySent).toBeGreaterThan(30)
    })

    it('refuses the reply when what is sent holds the keyword, for sources that are made of anything (the property)', async () => {
      const pieces = fc.constantFrom('zo', 'rp', 'z', 'o', 'r', 'p', 'zorp', 'zor', '![x](upload:1)', '![](upload:1)', ' ', '\n', '\n\n', '**', '*', '_', '||', '~~', '`', '> ', '- ', '# ', '-# ', '| a | b |\n|---|---|\n| ', ' |', '[^1]', '\n\n[^1]: ', '[', '](https://example.test/a)', '\\')
      await fc.assert(
        fc.asyncProperty(fc.array(pieces, { minLength: 1, maxLength: 14 }), fc.constantFrom('v2', 'plain'), async (list, form) => {
          const source = list.join('')
          const r = await via(source, m, { authorId: U1, siteUrl: 'https://example.test/x', form })
          const inSent = shownOf(source, form).includes('zorp')
          if (inSent) expect(r.ok, source).toBe(false)
          if (!r.ok && r.status === 422) expect(holdsZorp(source, form), source).toBe(true)
        }),
        { numRuns: 1_000 },
      )
    })

    it('is right to refuse what the oracle once called a reply with no keyword in it: the label of a link and the text beside it read "zorp"', async () => {
      // Found by a run of the property above that went wrong about one time in eight: the matcher was right and the oracle did not read the
      // label of a link without its brackets.
      for (const form of ['v2', 'plain']) {
        for (const source of ['[zo](https://example.test/a)rp', 'zor[p](https://example.test/a)', 'zo[rp](https://example.test/a)zo']) {
          const r = await via(source, m, { authorId: U1, siteUrl: 'https://example.test/x', form })
          expect(r, `${form} ${source}`).toMatchObject({ ok: false, status: 422, rule: 'No Zorp', match: null })
          expect(squash(source).includes('zorp'), source).toBe(false)
          expect(holdsZorp(source, form), source).toBe(true)
        }
      }
    })

    it('holds for the runs that found it: the same seeds and the same paths as the ones that failed', async () => {
      const pieces = fc.constantFrom('zo', 'rp', 'z', 'o', 'r', 'p', 'zorp', 'zor', '![x](upload:1)', '![](upload:1)', ' ', '\n', '\n\n', '**', '*', '_', '||', '~~', '`', '> ', '- ', '# ', '-# ', '| a | b |\n|---|---|\n| ', ' |', '[^1]', '\n\n[^1]: ', '[', '](https://example.test/a)', '\\')
      // The second was found by another run of the whole suite: `zo[rp](https://example.test/a)zo`, the text before the link and its label.
      for (const [seed, path] of [[-178024739, '544:2:0:0:1:4:1:4:8'], [-646092332, '317:2:2:10:10:10']]) {
        await fc.assert(
          fc.asyncProperty(fc.array(pieces, { minLength: 1, maxLength: 14 }), fc.constantFrom('v2', 'plain'), async (list, form) => {
            const source = list.join('')
            const r = await via(source, m, { authorId: U1, siteUrl: 'https://example.test/x', form })
            if (!r.ok && r.status === 422) expect(holdsZorp(source, form), source).toBe(true)
          }),
          { numRuns: 1_000, seed, path },
        )
      }
    })
  })
})

describe('validateReply: the regular expressions of the server\'s rules', () => {
  const withRegex = (patterns, over = {}) => keywordRule([], { regex_patterns: patterns }, over)
  const UNCHECKED = { ok: false, status: 422, error: "This reply couldn't be checked against the server's rules. Try a shorter one." }
  const by = (rules, source, over = {}) => send(reply(source, over.reply), { automod: matcher(rules), ...over.options })

  it('refuses a reply that a pattern matches in what is sent, with the rule and no place, since the place is in a text the writer never sees', async () => {
    for (const form of ['v2', 'plain']) {
      expect(await by([withRegex(['zor+p'], { name: 'No Zorp' })], 'Say zorrp now', { options: { form } })).toEqual({
        ok: false,
        status: 422,
        error: 'Blocked by the server\'s AutoMod rule "No Zorp".',
        rule: 'No Zorp',
        match: null,
      })
      expect((await by([withRegex(['zor+p'])], 'Say nothing', { options: { form } })).ok).toBe(true)
    }
  })

  it('runs the patterns over what is sent and not over the source, which holds what is not sent', async () => {
    const options = { ownUploadIds: ['u1'] }
    const input = { reply: { uploads: ['u1'] }, options }
    expect((await by([withRegex(['upload'])], 'a ![x](upload:1) b', input)).ok).toBe(true)
    expect((await by([withRegex(['\\!\\['])], 'a ![x](upload:1) b', input)).ok).toBe(true)
    expect((await by([withRegex(['a\\s+b'])], 'a ![x](upload:1) b', input)).rule).toBe('Test Rule')
  })

  it('refuses a reply that a pattern matches only in what is sent, with no match in the source', async () => {
    const r = await send(reply('zo![x](upload:1)rp', { uploads: ['u1'] }), { automod: matcher([withRegex(['zorp'], { name: 'No Zorp' })]), ownUploadIds: ['u1'] })
    expect(r).toEqual({ ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "No Zorp".', rule: 'No Zorp', match: null })
  })

  it('checks a reply of more than 10,000 characters message by message, so that no pattern runs over all of it', async () => {
    const long = `${'word '.repeat(2_100)}x`
    expect(long.length).toBeGreaterThan(10_000)
    // Three messages of the primary form hold about 11,800 characters.
    expect((await by([withRegex(['needle'])], long)).ok).toBe(true)
    expect((await by([withRegex(['needle'], { name: 'Last' })], `${long} needle`)).rule).toBe('Last')
    expect((await by([withRegex(['needle'], { enabled: false })], long)).ok).toBe(true)
  })

  it('says it could not check a reply when a pattern runs past the budget', async () => {
    const started = performance.now()
    expect(await by([withRegex(['(a+)+$'])], `${'a'.repeat(60)}!`)).toEqual(UNCHECKED)
    expect(performance.now() - started).toBeLessThan(2_500)
    expect((await by([withRegex(['(a+)+$'])], 'aaa')).status).toBe(422)
    expect((await by([withRegex(['zorp'])], 'fine')).ok).toBe(true)
  })

  it('is told after the keywords, the links, the pictures and the mentions, and still before the reply is let through', async () => {
    const rules = [withRegex(['zorp'], { name: 'Pattern' }), keywordRule(['gronk'], {}, { name: 'Word' })]
    expect((await by(rules, 'zorp gronk')).rule).toBe('Word')
    expect((await by(rules, 'zorp [x](ftp://y)')).status).toBe(400)
    expect((await by(rules, 'zorp')).rule).toBe('Pattern')
  })

  it('does not take a first line that is the stand-in the site uses to find its own lines for one of its own', async () => {
    // The sent text is "x", which no rule of the source sees, since the source has the picture in it: only the pattern for the whole text does.
    const r = await send(reply('x![](upload:1)', { uploads: ['u1'] }), { automod: matcher([withRegex(['^x$'], { name: 'Only X' })]), ownUploadIds: ['u1'] })
    expect(r).toEqual({ ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "Only X".', rule: 'Only X', match: null })
  })

  it('never reaches for a pattern when the matcher it is given is a plain function', async () => {
    expect((await send(reply('zorp'), { automod: () => null })).ok).toBe(true)
  })

  it('reads the links as the member wrote them as well as as they are sent: a rule against the shape of a link still refuses it, in both forms', async () => {
    // The form sends every link in angle brackets (`[t](<url>)`, `<url>`), so a pattern for `](http` or for a URL after a space would see
    // none of them in what is sent, where it saw them in the source before the patterns were kept from the source.
    const masked = 'see [here](https://evil.example/x) now'
    const bare = 'see https://evil.example/x now'
    const cases = [['\\]\\(https?://', masked], ['\\[[^\\]]*\\]\\(\\s*https?://', masked], ['(?:^|\\s)https?://evil', bare], ['\\(https?://[^)]*\\)', masked]]
    for (const form of ['v2', 'plain']) {
      for (const [pattern, source] of cases) {
        expect(await by([withRegex([pattern], { name: 'No Links' })], source, { options: { form } }), `${form} ${pattern}`).toEqual({
          ok: false,
          status: 422,
          error: 'Blocked by the server\'s AutoMod rule "No Links".',
          rule: 'No Links',
          match: null,
        })
      }
    }
    // What is not a link is not touched, nor what a pattern for the sent spelling looks for.
    expect((await by([withRegex(['\\]\\(https?://'])], 'see [here](ftp://x)', { options: { form: 'v2' } })).status).toBe(400)
    expect((await by([withRegex(['\\]\\(https?://'])], 'no link at all')).ok).toBe(true)
    expect((await by([withRegex(['\\]\\(<https'], { name: 'Sent' })], masked)).rule).toBe('Sent')
  })

  it('reads a link twice only when the member\'s spelling is not the sent one, and always within the size of a message', async () => {
    const asked = []
    const automod = Object.assign(() => null, { regex: async (texts) => (asked.push(texts), null) })
    await send(reply('Say hi'), { automod, form: 'plain' })
    await send(reply('[a](https://e.com) b'), { automod, form: 'plain' })
    await send(reply('see https://e.com'), { automod, form: 'plain' })
    await send(reply(`hi <@${U1}>`, { mentions: [U1] }), { automod, form: 'plain' })
    expect(asked).toEqual([['Say hi'], ['[a](<https://e.com>) b', '[a](https://e.com) b'], ['see <https://e.com>', 'see https://e.com'], [`hi <@${U1}>`]])
    // Each copy is shorter than its text: the links are only let out of their angle brackets.
    asked.length = 0
    await send(reply(`${'[a](https://e.com/x) '.repeat(450)}`), { automod, form: 'v2' })
    expect(asked[0].length).toBeGreaterThan(1)
    for (const [text, copy] of [asked[0].slice(0, 2)]) expect(copy.length).toBeLessThan(text.length)
    expect(Math.max(...asked[0].map((t) => t.length))).toBeLessThan(4_100)
  })

  it('reads what the member typed and not the escapes that the form wrote for it: a pattern for `z*rp` or `free_nitro` refuses them, in both forms', async () => {
    // The form escapes every mark of a text (`z*rp` is sent as `z\*rp`), so a pattern written for the spelling a member types would see none of
    // them in what is sent. The patterns are the rules that catch a word written with a symbol in it, which a keyword cannot (its `*` is a wildcard).
    const cases = [
      ['z[o*]rp', 'z*rp'],
      ['z.rp', 'z*rp'],
      ['z.rp', 'z_rp'],
      ['z.rp', 'z|rp'],
      ['z.rp', 'z~rp'],
      ['z[o<]rp', 'z<rp'],
      ['free.nitro', 'free_nitro'],
      ['z[^a-z]rp', 'z[rp'],
      ['z\\]rp', 'z]rp'],
      ['z`rp', 'z`rp'],
      ['z[o*]rp', 'see z*rp now'],
      ['n[i1!*]gg', 'n*gg'],
      ['fr[e3]{2}.?n[i1]tro', 'free_nitro'],
      ['z\\\\rp', 'z\\\\rp'],
      ['^# zorp$', '\\# zorp'],
    ]
    for (const form of ['v2', 'plain']) {
      for (const [pattern, source] of cases) {
        expect(await by([withRegex([pattern], { name: 'No Zorp' })], source, { options: { form } }), `${form} ${pattern} ${source}`).toEqual({
          ok: false,
          status: 422,
          error: 'Blocked by the server\'s AutoMod rule "No Zorp".',
          rule: 'No Zorp',
          match: null,
        })
      }
      // What is sent is read as well: a pattern for the escaped spelling still refuses it, and one for no spelling of it refuses nothing.
      expect((await by([withRegex(['z\\\\\\*rp'], { name: 'Sent' })], 'z*rp', { options: { form } })).rule, form).toBe('Sent')
      expect((await by([withRegex(['z[o*]rp'])], 'zarp z​xrp', { options: { form } })).ok, form).toBe(true)
    }
  })

  it('reads each italic as one of `_` as well, which the form writes with `*`: a pattern against `free_nitro` refuses `_free_ nitro`, in both forms', async () => {
    // The form writes every italic with `*` (`_free_` is sent as `*free*`), so a pattern whose class takes `_` and not `*`, the usual shape of
    // one against `free_nitro`, saw no `_` where Discord sees the member's: it refused `free nitro` and `free_nitro`, and let `_free_ nitro` by.
    const pattern = 'free[\\s_.-]*nitro'
    const BLOCKED = { ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "No Nitro".', rule: 'No Nitro', match: null }
    for (const form of ['v2', 'plain']) {
      for (const source of ['claim your _free_ nitro now', 'claim your free _nitro_ now', 'claim your free__nitro_ now', 'free _nitro_', '_free_ _nitro_', '~~free _nitro_~~', '||free _nitro_||', '**free _nitro_**', '_free_ nitro\n\nand more']) {
        expect(await by([withRegex([pattern], { name: 'No Nitro' })], source, { options: { form } }), `${form} ${source}`).toEqual(BLOCKED)
      }
      // An italic written with `*` is read the same way, which refuses a little more than Discord would: fail closed.
      expect(await by([withRegex([pattern], { name: 'No Nitro' })], 'claim your *free* nitro now', { options: { form } }), form).toEqual(BLOCKED)
      // A bold and a star that the member escaped are kept as they are: Discord reads `free**` and `free\*` there. A bold italic is read as
      // `**_free_**` too, and `free_**` is not what the pattern takes either.
      for (const source of ['claim your **free** nitro now', 'claim your ***free*** nitro now', 'claim your \\*free\\* nitro now', 'claim your nitro for free']) {
        expect((await by([withRegex([pattern])], source, { options: { form } })).ok, `${form} ${source}`).toBe(true)
      }
    }
  })

  it('reads a bold round an italic, which the form sends as a run of three stars, with the `_` inside the bold: `_free` and `nitro_` refuse `**_free nitro_**`, in both forms', async () => {
    // The form writes `**_free nitro_**` as `***free nitro***`, and the copy with the italics as `_` kept the run as it was, so a pattern that reads
    // a `_` at the edge of the italic missed it, where Discord, which reads what the member typed, blocks it.
    const BLOCKED = { ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "No Nitro".', rule: 'No Nitro', match: null }
    const cases = [
      ['_free', 'claim **_free nitro_** now'],
      ['nitro_', 'claim **_free nitro_** now'],
      ['_nitro_', '**_free_** **_nitro_**'],
      ['_free', '(**_free nitro_**).'],
      ['nitro_', '(**_free nitro_**).'],
      ['_free', '**_free_ nitro**'],
      ['nitro_', '**free _nitro_**.'],
      ['_nitro_', 'x**_nitro_**y'],
    ]
    for (const form of ['v2', 'plain']) {
      for (const [pattern, source] of cases) {
        expect(new RegExp(translatePattern(pattern), 'giu').test(source), source).toBe(true)
        expect(await by([withRegex([pattern], { name: 'No Nitro' })], source, { options: { form } }), `${form} ${pattern} ${source}`).toEqual(BLOCKED)
      }
      // What the run is read as when the member typed it so, which Discord reads as stars: refused too, which fails closed (`***free***` is sent
      // as `**_free_**` is, and the site cannot tell the two apart).
      expect(await by([withRegex(['_free'], { name: 'No Nitro' })], 'claim your ***free*** nitro now', { options: { form } }), form).toEqual(BLOCKED)
      // A bold, a run of four, escaped stars and a run of three that holds nothing are not italics, and a pattern against `_free` lets them be.
      for (const source of ['claim your **free** nitro now', 'claim your ****free nitro', 'claim your \\*\\*\\*free\\*\\*\\* nitro', 'a *** free nitro']) {
        expect((await by([withRegex(['_free'])], source, { options: { form } })).ok, `${form} ${source}`).toBe(true)
      }
    }
  })

  it('reads a text a third time, with its italics as `_`, only when that is not the same as either of the others, and never longer than the text', async () => {
    const asked = []
    const automod = Object.assign(() => null, { regex: async (texts) => (asked.push(texts), null) })
    await send(reply('_free_ nitro'), { automod, form: 'plain' })
    await send(reply('_free_ z*rp'), { automod, form: 'plain' })
    await send(reply('a **b** c'), { automod, form: 'plain' })
    await send(reply('z*rp'), { automod, form: 'plain' })
    // A bold round an italic, whose run of three stars is the italic as well (the sent text and the typed one are the same here).
    await send(reply('**_free_** nitro'), { automod, form: 'plain' })
    expect(asked).toEqual([['*free* nitro', '_free_ nitro'], ['*free* z\\*rp', '*free* z*rp', '_free_ z*rp'], ['a **b** c'], ['z\\*rp', 'z*rp'], ['***free*** nitro', '**_free_** nitro']])
    // A long reply of italics, in each part of it: every copy is as long as its text at most, and no text is longer than a message.
    asked.length = 0
    await send(reply('_zo_ z~rp '.repeat(900)), { automod, form: 'v2' })
    expect(asked[0].length % 3).toBe(0)
    for (let k = 0; k < asked[0].length; k += 3) {
      expect(asked[0][k + 1].length).toBeLessThan(asked[0][k].length)
      expect(asked[0][k + 2].length).toBe(asked[0][k + 1].length)
    }
    expect(Math.max(...asked[0].map((t) => t.length))).toBeLessThan(4_100)
  })

  it('reads the text a second time only when the member\'s spelling is not the sent one, and the copy is never longer than the text', async () => {
    const asked = []
    const automod = Object.assign(() => null, { regex: async (texts) => (asked.push(texts), null) })
    await send(reply('z*rp'), { automod, form: 'plain' })
    await send(reply('free_nitro and [a](https://e.com)'), { automod, form: 'plain' })
    await send(reply('Say hi'), { automod, form: 'plain' })
    await send(reply('a **b** c'), { automod, form: 'plain' })
    expect(asked).toEqual([['z\\*rp', 'z*rp'], ['free\\_nitro and [a](<https://e.com>)', 'free_nitro and [a](https://e.com)'], ['Say hi'], ['a **b** c']])
    // Every mark of a long text escaped, in each part of it: each copy is shorter than its text, and no text is longer than a message. (No star:
    // two of them a word apart are an italic, which is read a third time.)
    asked.length = 0
    await send(reply('z~rp_x '.repeat(1_200)), { automod, form: 'v2' })
    expect(asked[0].length).toBeGreaterThan(2)
    for (let k = 0; k < asked[0].length; k += 2) expect(asked[0][k + 1].length).toBeLessThan(asked[0][k].length)
    expect(Math.max(...asked[0].map((t) => t.length))).toBeLessThan(4_100)
  })

  describe('for any source that is one line of text, made of letters, marks and escapes (the property)', () => {
    // A source that the parser reads as one line of nothing but text is what its text nodes say, with the member's own escapes read:
    // the plain reading, which is what the member meant to show. It is read in the site's dialect, the one a reply is written in:
    // in Discord's, `---` is a line of text, but on the site it is a divider, which is sent as no text at all.
    const piece = fc.constantFrom('z', 'o', 'r', 'p', 'zo', 'rp', 'free', 'nitro', ' ', '*', '_', '~', '|', '<', '>', '[', ']', '\\', '`', '#', '-', '.', '1', '(', ')', ':', '!', '@', '​')
    const lineOf = (source) => {
      const tree = parse(source, { dialect: 'extended' })
      if (tree.length !== 1 || tree[0].type !== 'line' || !tree[0].children.every((node) => node.type === 'text')) return null
      return tree[0].children.map((node) => node.value).join('')
    }

    it('asks the patterns nothing of a divider, which is sent as no text (seed 601580538 found it with the oracle in the wrong dialect)', async () => {
      for (const form of ['v2', 'plain']) {
        const asked = []
        const automod = Object.assign(() => null, { regex: async (texts) => (asked.push(...texts), null) })
        expect(await send(reply('---'), { automod, form })).toMatchObject({ ok: true })
        expect(lineOf('---')).toBeNull()
        expect(asked).toEqual([])
      }
    })

    it('gives the patterns that plain reading, whatever the marks in it, in both forms', async () => {
      let lines = 0
      await fc.assert(
        fc.asyncProperty(fc.array(piece, { minLength: 1, maxLength: 16 }), fc.constantFrom('v2', 'plain'), async (list, form) => {
          const source = list.join('')
          const plain = lineOf(source)
          if (plain === null || plain.trim() === '') return
          const asked = []
          const automod = Object.assign(() => null, { regex: async (texts) => (asked.push(...texts), null) })
          // A reply that is refused before the rules are asked (`[zo](rp)` is a link that is not http) has nothing to say here.
          if (!(await send(reply(source), { automod, form })).ok) return
          lines++
          expect(asked, JSON.stringify(source)).toContain(plain.trim().replaceAll('​', ''))
        }),
        { numRuns: 3_000 },
      )
      // Not a property that holds for want of sources: most are one line of text.
      expect(lines).toBeGreaterThan(1_000)
    })

    it('refuses the reply when a pattern matches the plain reading, and refuses it only for what the plain reading or the sent text holds', async () => {
      // Sources made more of the spellings that the patterns are for, so that a good part of them is refused.
      const spelling = fc.constantFrom('z*rp', 'z_rp', 'z~rp', 'z|rp', 'z<rp', 'z[rp', 'z]rp', 'z\\rp', 'z`rp', 'free_nitro', 'free.nitro', 'o*', 'r_p', '[o]', '<z', 'z~~r', '\\# ', '\\-', '\\>')
      const patterns = ['z.rp', 'z[o*_~|<\\[\\]\\\\`]rp', 'z[^a-z]rp', 'free.nitro', '[*_~|<\\[\\]\\\\`]{2}', 'o\\*', 'r_p', 'z\\\\', '<z', '\\[o\\]', 'z~+r', '^[#>-]']
      let refused = 0
      await fc.assert(
        fc.asyncProperty(fc.array(fc.oneof(piece, spelling), { minLength: 1, maxLength: 8 }), fc.constantFrom(...patterns), fc.constantFrom('v2', 'plain'), async (list, pattern, form) => {
          const source = list.join('')
          const plain = lineOf(source)
          if (plain === null || plain.trim() === '') return
          if (!(await send(reply(source), { form })).ok) return
          const holds = (text) => new RegExp(translatePattern(pattern), 'giu').test(text)
          const r = await by([withRegex([pattern], { name: 'No Zorp' })], source, { options: { form } })
          if (holds(plain)) {
            refused++
            expect(r, `${form} ${pattern} ${JSON.stringify(source)}`).toEqual({ ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "No Zorp".', rule: 'No Zorp', match: null })
          }
          if (!r.ok) {
            // The line of the reply, without the footer that the site writes under it.
            const sent = toDiscord(source, { form, authorId: U1, siteUrl: SITE, replyTo: null, images: [] }).parts[0].text.split('\n')[0]
            expect(holds(plain.trim().replaceAll('​', '')) || holds(sent), `${form} ${pattern} ${JSON.stringify(source)}`).toBe(true)
          }
        }),
        { numRuns: 600 },
      )
      expect(refused).toBeGreaterThan(100)
    })
  })

  describe('for any source of words with the marks of Discord round them and between them (the property)', () => {
    // A pattern of Discord's own reads what the member typed, marks and all, so whatever a pattern finds there, the site refuses: the words in a
    // mark or in none (`_free_`, `*free*`, `**free**`, `***free***`, an underline, a strike, a spoiler, an escape), and what stands between them,
    // which is where a pattern against `free_nitro` looks.
    const MARKED = { strong: '**', underline: '__', strike: '~~', spoiler: '||' }
    // → the nodes as text, each mark round what it holds and each italic written with `italic`: what the member meant, in either spelling.
    const written = (nodes, italic) =>
      nodes.map((node) => (node.type === 'text' ? node.value : `${MARKED[node.type] ?? italic}${written(node.children, italic)}${MARKED[node.type] ?? italic}`)).join('')
    const MARKS_ONLY = new Set(['text', 'em', ...Object.keys(MARKED)])
    const onlyMarks = (nodes) => nodes.every((node) => MARKS_ONLY.has(node.type) && (node.type === 'text' || onlyMarks(node.children)))
    // Two italics side by side, which the form writes as one (`_free__nitro_` is sent as `*freenitro*`), an italic in an italic, which it writes
    // as its text (`_a *free* b_` is sent as `*a free b*`), and a mark that holds only a space, which it writes as the space (`nitro__ __free` is
    // sent as `nitro free`), so that nothing is left of the member's marks there for a copy of the text to read again: what the form does, and
    // not what this file can undo. A source with one of them is left out. A bold round an italic, and an italic round a bold, whole or at one
    // edge, are made: the form sends them with a run of three stars there (`**_free_**` and `_**free**_` as `***free***`), which the copy with
    // the italics as `_` reads with the `_` inside the bold, as `**_free_**` (see typed). So a refusal is told by the source written either
    // way round as well: each bold and italic that touch, `_**` or `**_`, the other way.
    const lost = (nodes, italic = false) =>
      nodes.some(
        (node, k) =>
          node.type !== 'text' &&
          ((node.type === 'em' && (italic || nodes[k + 1]?.type === 'em')) || written(node.children, '*').trim() === '' || lost(node.children, italic || node.type === 'em')),
      )
    const marks = [
      ...['', '', '_', '*', '**', '***', '__', '___', '~~', '||', '\\_', '\\*'].map((mark) => [mark, mark]),
      ['**_', '_**'],
      ['**_', '_**'],
      ['_**', '**_'],
      ['**_', '_ zorp**'],
      ['**zorp _', '_**'],
      ['_**', '** zorp_'],
      ['_zorp **', '**_'],
      ['~~_', '_~~'],
      ['||_', '_||'],
    ]
    const item = fc
      .tuple(fc.constantFrom(...marks), fc.constantFrom('free', 'nitro', 'free nitro', 'free_nitro', 'zorp', 'claim'))
      .map(([[open, close], words]) => `${open}${words}${close}`)
    const turned = (text) => text.replace(/_\*\*|\*\*_/g, (pair) => (pair === '_**' ? '**_' : '_**'))
    const gap = fc.constantFrom(' ', ' ', '  ', '_', '__', '.', '-', ' _', '_ ', '', ' - ')
    const source = fc.tuple(item, fc.array(fc.tuple(gap, item), { maxLength: 4 })).map(([first, rest]) => first + rest.map(([g, i]) => g + i).join(''))
    const patterns = ['free[\\s_.-]*nitro', 'free[ _.-]+nitro', 'free_+nitro', 'free.nitro', 'free\\s+nitro', 'free[^a-z]nitro', '_free', 'nitro_', '_nitro_', '\\*free', 'e~~']

    it('refuses the reply when a pattern matches the source as it was typed, and refuses it only for what the source, read with either italic, or the sent text holds', async () => {
      let lines = 0
      let refused = 0
      let runs = 0
      await fc.assert(
        fc.asyncProperty(source, fc.constantFrom(...patterns), fc.constantFrom('v2', 'plain'), async (text, pattern, form) => {
          const tree = parse(text, { dialect: 'extended' })
          if (tree.length !== 1 || tree[0].type !== 'line' || !onlyMarks(tree[0].children) || lost(tree[0].children)) return
          if (!(await send(reply(text), { form })).ok) return
          lines++
          const holds = (t) => new RegExp(translatePattern(pattern), 'giu').test(t)
          const r = await by([withRegex([pattern], { name: 'No Nitro' })], text, { options: { form } })
          const label = `${form} ${pattern} ${JSON.stringify(text)}`
          const sent = toDiscord(text, { form, authorId: U1, siteUrl: SITE, replyTo: null, images: [] }).parts[0].text.split('\n')[0]
          if (/(?<!\*)\*\*\*(?!\*)/.test(sent)) runs++
          if (holds(text)) expect(r, label).toEqual({ ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "No Nitro".', rule: 'No Nitro', match: null })
          if (!r.ok) {
            refused++
            const under = written(tree[0].children, '_')
            expect(holds(text) || holds(written(tree[0].children, '*')) || holds(under) || holds(turned(under)) || holds(sent), label).toBe(true)
          }
        }),
        { numRuns: 1_000 },
      )
      // Not a property that holds for want of sources, of refusals, or of bolds round italics.
      expect(lines).toBeGreaterThan(600)
      expect(refused).toBeGreaterThan(150)
      expect(runs).toBeGreaterThan(300)
    })
  })

  it('asks for the texts that are sent, in one go, and never for the source', async () => {
    const asked = []
    const automod = Object.assign(() => null, { regex: async (texts) => (asked.push(texts), null) })
    expect((await send(reply('Say hi'), { automod })).ok).toBe(true)
    expect((await send(reply('x ![](upload:1) y', { uploads: ['u1'] }), { automod, ownUploadIds: ['u1'], form: 'plain' })).ok).toBe(true)
    expect(asked).toEqual([['Say hi'], ['x  y']])
    for (const text of [0, 1]) {
      const found = Object.assign(() => null, { regex: async () => ({ rule: 'Mock', text, start: 0, end: 1 }) })
      expect(await send(reply('x'), { automod: found })).toEqual({ ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "Mock".', rule: 'Mock', match: null })
    }
  })
})

describe('validateReply: a reply whose texts fold to far more than they are', () => {
  const UNCHECKED = { ok: false, status: 422, error: "This reply couldn't be checked against the server's rules. Try a shorter one." }
  const zorp = () => matcher([keywordRule(['zorp'], {}, { name: 'No Zorp' })])
  const FDFA = '\ufdfa'
  // n characters of the text, whole ones.
  const fit = (unit, n) => {
    let text = ''
    while (text.length < n) text += unit
    return text.slice(0, n).replace(/[\ud800-\udbff]$/, '')
  }

  it('refuses 11,000 characters that fold to 18 each as a reply that could not be checked, within a few milliseconds', async () => {
    const started = performance.now()
    expect(await send(reply(FDFA.repeat(11_000)), { automod: zorp() })).toEqual(UNCHECKED)
    // The keywords took 7 s on Node and 0.33 s on Bun for this before the bound; the bound answers in about 5 ms on both (Stryker's
    // instrumented copy is about ten times slower).
    expect(performance.now() - started).toBeLessThan(globalThis.__stryker__ ? 2_500 : 250)
  })

  it('refuses it in the fallback form too, and when it is a part of a longer reply', async () => {
    expect(await send(reply(FDFA.repeat(1_900)), { automod: zorp(), form: 'plain' })).toEqual(UNCHECKED)
    expect(await send(reply(`${'word '.repeat(500)}${FDFA.repeat(2_000)}`), { automod: zorp() })).toEqual(UNCHECKED)
  })

  it('takes it when no rule would read it, which is no keyword rule or none that applies', async () => {
    expect((await send(reply(FDFA.repeat(11_000)))).ok).toBe(true)
    expect((await send(reply(FDFA.repeat(11_000)), { automod: matcher([]) })).ok).toBe(true)
    expect((await send(reply(FDFA.repeat(11_000)), { automod: matcher([keywordRule([], { regex_patterns: ['x'] })]) })).ok).toBe(true)
  })

  it('does not refuse the ordinary replies of about 10,000 characters in scripts that grow when they are folded, or in emoji', async () => {
    const ordinary = {
      Korean: '안녕하세요 여러분, 오늘은 날씨가 정말 좋네요. 같이 게임해요! 한글은 음절마다 두세 개의 자모로 풀립니다. ',
      Arabic: 'مَرْحَبًا بِكُمْ فِي موقعنا الرسمي، ﷲ يحفظكم. شكراً جزيلاً على الدعم والمساعدة. ',
      Devanagari: 'नमस्ते दुनिया, यह एक परीक्षण है। क़ख़ग ज़िंदगी फ़ौज और ड़ाल। मुझे हिंदी में लिखना पसंद है। ',
      Japanese: 'こんにちは世界、これはテストです。ｶﾞｷﾞｸﾞｹﾞｺﾞ ガギグゲゴ ﾊﾟﾋﾟﾌﾟ 日本語の文章です。',
      emoji: '😀👍🎉❤️👨‍👩‍👧🏳️‍🌈 hi 🔥🔥🔥 ',
    }
    for (const [name, unit] of Object.entries(ordinary)) {
      const text = fit(unit, 10_000)
      expect(text.length, name).toBeGreaterThan(9_990)
      const r = await send(reply(text), { automod: zorp() })
      expect(r.ok, name).toBe(true)
    }
  })

  it('does not refuse ordinary text that grows as much as the scripts that grow most, whole as a reply of 3 messages', async () => {
    // Hangul syllables with a final consonant are three letters when they are taken apart: about as long as a text gets in daily use.
    const all3 = fit('각낙닥락막박삭악작착칵탁팍학', 10_000)
    expect(all3.normalize('NFKD').length).toBeGreaterThan(29_000)
    expect((await send(reply(all3), { automod: zorp() })).ok).toBe(true)
  })

  it('counts what the source and the messages add, together, against the allowance of the reply', async () => {
    // 4 characters that fold to 18 and 19 that fold to one: each text of it is 3.957 times as long folded (a cut in the middle of the 23
    // moves that by less than 0.02), and adds 2.957 characters for each it has.
    const dense = (n) => fit(`${'a'.repeat(19)}${FDFA.repeat(4)}`, n)
    // The source and the messages: for 10,000 characters 2 * 29,570 added, which is under 64,000, and for 11,000 2 * 32,530, which is over.
    expect((await send(reply(dense(10_000)), { automod: zorp() })).ok).toBe(true)
    expect(await send(reply(dense(11_000)), { automod: zorp() })).toEqual(UNCHECKED)
  })

  it('does not refuse an ordinary reply of 10,000 characters of Korean with pictures on lines of their own and masked links', async () => {
    // Korean grows by a little over one character for each when it is taken apart, and a reply with pictures and links is read in many ways: the
    // source, each part, the displays of a part put together, and each of those again with the links read as their text. Only the source and the
    // parts are charged to the allowance.
    const korean = '안녕하세요 여러분 오늘은 날씨가 정말 좋네요 같이 게임해요 한글은 음절마다 두세 개의 자모로 풀립니다 '
    const block = fit(korean, 1_700)
    const source = Array.from({ length: 6 }, (_, k) => `${block} [링크 ${k}](https://example.test/a${k})\n\n![](upload:${k + 1})`).join('\n\n')
    expect(source.length).toBeGreaterThan(10_000)
    const uploads = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']
    const r = await send(reply(source, { uploads }), { automod: zorp(), ownUploadIds: uploads })
    expect(r.ok).toBe(true)
  })

  it('charges the source and each part to the allowance, and the displays put together and the links read as their text to none', async () => {
    const calls = []
    const automod = (text, spend) => (calls.push({ text, spend }), null)
    await send(reply('a [x](https://e.com)\n\n![](upload:1)\n\nb', { uploads: ['u1'] }), { automod, ownUploadIds: ['u1'] })
    const shared = calls[0].spend
    expect(shared).toEqual({ left: 64_000 })
    expect(calls.map(({ text, spend }) => `${spend === shared ? 'charged' : 'free'} ${text.replaceAll('\n', '/')}`)).toEqual([
      'charged a [x](https://e.com)//![](upload:1)//b',
      'free a x//!//b',
      'charged a [x](<https://e.com>)',
      'free a x',
      'charged b',
      'free a [x](<https://e.com>)/b',
      'free a x/b',
    ])
    for (const { spend } of calls) if (spend !== shared) expect(spend.left).toBe(Number.POSITIVE_INFINITY)
    // They are not charged, and they are not free of the size of the text that each is: the label of a link with a long address folds to little
    // against the whole, and to far more than itself once it is read without the address.
    const label = FDFA.repeat(300)
    const address = `https://example.test/${'a'.repeat(1_900)}`
    expect(await send(reply(`[${label}](${address})`), { automod: matcher([keywordRule(['zorp'])]) })).toEqual(UNCHECKED)
    expect((await send(reply(`[${label.slice(0, 40)}](${address})`), { automod: matcher([keywordRule(['zorp'])]) })).ok).toBe(true)
  })

  it('gives the matcher one allowance for the whole reply, and a new one for the next', async () => {
    const seen = []
    const automod = (text, spend) => (seen.push(spend), null)
    await send(reply('Say hi'), { automod })
    await send(reply('Say hi'), { automod })
    expect(seen).toHaveLength(4)
    expect(seen[0]).toBe(seen[1])
    expect(seen[2]).toBe(seen[3])
    expect(seen[0]).not.toBe(seen[2])
    expect(seen[0]).toEqual({ left: 64_000 })
  })

  it('does not take another error of the matcher for a reply that could not be checked', async () => {
    const automod = () => {
      throw new TypeError('the matcher is broken')
    }
    await rejectsAs(send(reply('Say hi'), { automod }), TypeError, 'the matcher is broken')
    const unfoldable = () => {
      throw new Unfoldable()
    }
    expect(await send(reply('Say hi'), { automod: unfoldable })).toEqual(UNCHECKED)
  })
})

describe('validateReply: a masked link, read without its brackets as well', () => {
  const REFUSED = { ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "No Zorp".', rule: 'No Zorp', match: null }
  const zorp = () => matcher([keywordRule(['zorp'], {}, { name: 'No Zorp' })])

  it('refuses the word that the text of a link and the text beside it make, in both forms, with no place in the source', async () => {
    for (const form of ['v2', 'plain']) {
      for (const source of ['[zo](https://e.com)rp', 'zo[rp](https://e.com)', '[zo](https://e.com)[rp](https://e.com)', '[z](https://e.com)[o](https://e.com)[r](https://e.com)[p](https://e.com)', '[zo](https://e.com "a title")rp', '[zo](<https://e.com>)rp', '[zo](https://e.com/a_(b))rp', '**[zo](https://e.com)rp**']) {
        expect(await send(reply(source), { automod: zorp(), form }), `${form} ${source}`).toEqual(REFUSED)
      }
    }
  })

  it('takes what is no word of the rule once the links are read without their brackets, and what is no masked link', async () => {
    for (const source of ['[zo](https://e.com)xp', '[zo] (https://e.com)rp', '[zo](https://e.com', '[zo\nx](https://e.com)rp', '(zo)[rp]', '[zo][rp]']) {
      expect((await send(reply(source), { automod: zorp() })).ok, source).toBe(true)
    }
  })

  it('refuses it when only what is sent holds it, as a picture of the source stands between the two halves there', async () => {
    const source = '[zo](https://e.com)![x](upload:1)rp'
    for (const form of ['v2', 'plain']) {
      expect(await send(reply(source, { uploads: ['u1'] }), { automod: zorp(), ownUploadIds: ['u1'], form }), form).toEqual(REFUSED)
    }
  })

  it('asks the matcher about the source and each message, and each of them again without the brackets of its links when that is not the same', async () => {
    const seen = []
    const automod = (text) => (seen.push(text), null)
    await send(reply('[zo](https://e.com)rp'), { automod, form: 'plain' })
    expect(seen).toEqual(['[zo](https://e.com)rp', 'zorp', '[zo](<https://e.com>)rp', 'zorp'])
    seen.length = 0
    await send(reply('fine'), { automod, form: 'plain' })
    expect(seen).toEqual(['fine', 'fine'])
    seen.length = 0
    await send(reply('[a](https://e.com) b'), { automod, form: 'plain' })
    expect(seen).toEqual(['[a](https://e.com) b', 'a b', '[a](<https://e.com>) b', 'a b'])
  })

  it('asks about the source with its links read and the messages without, for a link that exists only in the source', async () => {
    const seen = []
    const automod = (text) => (seen.push(text), null)
    await send(reply('[zo](https://e.com)![x](upload:1)rp', { uploads: ['u1'] }), { automod, ownUploadIds: ['u1'], form: 'plain' })
    expect(seen).toEqual(['[zo](https://e.com)![x](upload:1)rp', 'zo!xrp', '[zo](<https://e.com>)rp', 'zorp'])
  })

  it('answers a text of nothing but links and brackets at the speed of any other text', async () => {
    for (const unit of ['[a](', '[', '](', '[a](b', '[a](b)']) {
      const started = performance.now()
      await send(reply(unit.repeat(Math.floor(15_000 / unit.length))), { automod: zorp(), form: 'v2' })
      expect(performance.now() - started, unit).toBeLessThan(3_000)
    }
  })
})

describe('validateReply: what is kept of the text', () => {
  it('replaces a NUL and a lone half of a pair by the replacement character, one for one', async () => {
    const r = await send(reply('a\u0000b\ud800c\udc00d😀'))
    expect(r.ok).toBe(true)
    expect(r.clean.source).toBe('a\ufffdb\ufffdc\ufffdd😀')
    expect(r.clean.source).toHaveLength('a\u0000b\ud800c\udc00d😀'.length)
  })

  it('keeps the text it is given otherwise, to the character', async () => {
    const source = '  \r\n# Title \u00a0\n\t**bold** \u200b 😀 e\u0301 \r\n'
    expect((await send(reply(source))).clean.source).toBe(source)
  })

})

describe('validateReply: the options', () => {
  it('refuses a form that is neither', async () => {
    for (const form of ['v3', '', null, 5, 'V2', {}]) await rejectsAs(send(reply('hi'), { form }), RangeError, 'form must be "v2" or "plain"')
  })

  it('refuses a form before it looks at the text', async () => {
    await expect(send(reply(''), { form: 'v3' })).rejects.toThrow(RangeError)
  })

  it('takes no form for the primary form', async () => {
    expect((await validateReply(reply('hi'), { automod: none, ownUploadIds: [], form: undefined, authorId: U1, siteUrl: SITE })).ok).toBe(true)
  })

  it('refuses a matcher that is not a function', async () => {
    for (const automod of [undefined, null, {}, 'x', 5, [], { mentionCap: 3 }]) {
      await rejectsAs(send(reply('hi'), { automod }), TypeError, 'automod must be a function')
      await rejectsAs(send(reply(''), { automod }), TypeError, 'automod must be a function')
    }
  })

  it('refuses a cap that is not a whole number from 0 to 10', async () => {
    for (const mentionCap of [-1, 11, 1.5, NaN, '5', null, Infinity]) {
      await rejectsAs(send(reply('hi'), { mentionCap }), RangeError, 'mentionCap must be a whole number from 0 to 10')
    }
    for (const mentionCap of [0, 1, 10]) expect((await send(reply('hi'), { mentionCap })).ok).toBe(true)
    expect((await send(reply('hi'), { mentionCap: undefined })).ok).toBe(true)
  })

  it('refuses ids of pictures that are not a list or a set', async () => {
    for (const ownUploadIds of ['u1', {}, 5, null, new Map()]) await rejectsAs(send(reply('hi'), { ownUploadIds }), TypeError, 'ownUploadIds must be a list or a set')
    expect((await validateReply(reply('hi'), { automod: none, authorId: U1, siteUrl: SITE })).ok).toBe(true)
    expect(await validateReply(reply('![a](upload:1)', { uploads: ['Stryker was here'] }), { automod: none, authorId: U1, siteUrl: SITE })).toEqual({
      ok: false,
      status: 400,
      error: "That picture isn't one of yours.",
    })
  })

  it('refuses options that are not an object', async () => {
    for (const options of [undefined, null, 5, 'x', []]) await rejectsAs(validateReply(reply('hi'), options), TypeError, 'the options must be an object')
  })

  it('takes the primary cap of mentions to be ten', () => {
    expect(MENTION_CAP).toBe(10)
  })
})

describe('validateReply: for any input', () => {
  it('answers a refusal or a clean reply, and never throws, whatever the body is', async () => {
    const junk = fc.oneof(fc.string(), fc.anything(), fc.constant(undefined))
    await fc.assert(
      fc.asyncProperty(fc.record({ source: junk, mentions: junk, uploads: junk, replyTo: fc.constant(null) }, { requiredKeys: [] }), async (input) => {
        const r = await send(input)
        expect(typeof r.ok).toBe('boolean')
        if (r.ok) {
          expect(typeof r.clean.source).toBe('string')
          expect(Array.isArray(r.clean.mentions)).toBe(true)
          expect(Array.isArray(r.clean.uploads)).toBe(true)
        } else {
          expect([400, 413, 422]).toContain(r.status)
          expect(typeof r.error).toBe('string')
        }
      }),
      { numRuns: 1500 },
    )
  })

  it('gives back a source that Postgres can store and that is as long as the one it was given', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', minLength: 1, maxLength: 200 }), async (source) => {
        const r = await send(reply(`a ${source}`))
        if (!r.ok) return
        expect(r.clean.source).toHaveLength(source.length + 2)
        expect(r.clean.source).not.toContain('\u0000')
        expect(r.clean.source.isWellFormed()).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })

  it('never names a person who is not both mentioned and picked', async () => {
    const idArb = fc.constantFrom(U1, U2, U3, '200000000000000424', '200000000000000425')
    await fc.assert(
      fc.asyncProperty(fc.array(idArb, { maxLength: 8 }), fc.array(idArb, { maxLength: 8 }), async (mentioned, pickedIds) => {
        const source = `x ${mentioned.map((m) => `<@${m}>`).join(' ')}`
        const r = await send(reply(source, { mentions: pickedIds }))
        const unique = [...new Set(mentioned)]
        if (unique.every((m) => pickedIds.includes(m))) {
          expect(r.ok).toBe(true)
          expect(r.clean.mentions).toEqual(unique)
        } else {
          expect(r.ok).toBe(false)
          expect(r.status).toBe(400)
        }
      }),
      { numRuns: 500 },
    )
  })
})

describe('cleanName', () => {
  const banned = (s) => /discord|clyde/i.test(s.normalize('NFKD').replace(/[\p{M}\p{Cf}\p{Cc}*_~|`\\]/gu, ''))

  it('takes out the characters that show nothing, and is Member when that is all there was', () => {
    for (const name of ['\u200b', '\u200b\u200d\ufeff', '\u2060', '\u00ad', '\u200e\u200f', '\u202e', '\u200b\u0000\ud800', '\u{e0020}\u{e007f}']) expect(cleanName(name), JSON.stringify(name)).toBe('Member')
    expect(cleanName('a\u200bb')).toBe('ab')
    expect(cleanName('Bob\u200d')).toBe('Bob')
    expect(cleanName('\u200bBob\u2060 Smith\ufeff')).toBe('Bob Smith')
    expect(cleanName('\u200b ')).toBe('Member')
  })

  it('keeps a name that needs nothing done', () => {
    for (const name of ['Bob', 'Bob Smith', 'x', 'Ünïcode Näme', '名前', 'a b c', 'Name 123', '😀 Smile']) expect(cleanName(name), name).toBe(name)
  })

  it('takes out "discord" and "clyde" in any case', () => {
    expect(cleanName('Discord')).toBe('Member')
    expect(cleanName('CLYDE')).toBe('Member')
    expect(cleanName('Bob Discord Smith')).toBe('Bob  Smith')
    expect(cleanName('DiScOrDbob')).toBe('bob')
    expect(cleanName('bobclyde')).toBe('bob')
    expect(cleanName('xdiscordyclydez')).toBe('xyz')
    expect(cleanName('discorddiscord')).toBe('Member')
    expect(cleanName('Clydes')).toBe('s')
  })

  it('takes out a word that taking out another word makes', () => {
    expect(cleanName('disclydecord')).toBe('Member')
    expect(cleanName('Bob disclydecord')).toBe('Bob')
    expect(cleanName('discdisclydecordord')).toBe('Member')
    expect(cleanName('clclydeyde')).toBe('Member')
    expect(cleanName('xdisclydecordx')).toBe('xx')
    expect(cleanName('dclydeiscord')).toBe('Member')
  })

  it('takes out a word that is written in a way that looks the same, or that a reader would read', () => {
    for (const name of ['ｄｉｓｃｏｒｄ', 'dis\u200bcord', 'dis\u00adcord', 'discòrd', 'dı\u0307scord', 'DISCORD', 'd*i*s*c*o*r*d', 'dis_cord', 'dis\u0000cord', 'clÿde', 'c\u200dlyde', 'cl\u0335yde']) {
      const out = cleanName(`a ${name} b`)
      expect(banned(out), name).toBe(false)
      expect(out, name).toBe('a  b')
    }
  })

  it('takes out what it takes without touching the rest of the name', () => {
    expect(cleanName('Zoë discord Nåme')).toBe('Zoë  Nåme')
    expect(cleanName('😀discord😀')).toBe('😀😀')
    expect(cleanName('Zo\u0308e clyde')).toBe('Zo\u0308e')
  })

  it('does not take a word out of a name that only has its letters apart', () => {
    for (const name of ['dis cord', 'disc ord', 'cly de', 'd i s c o r d', 'dis-cord', 'disco', 'cord', 'clyd']) expect(cleanName(name), name).toBe(name)
  })

  it('takes out control characters and lone halves of a pair', () => {
    expect(cleanName('a\u0001b\u007fc\u0085d')).toBe('abcd')
    expect(cleanName('a\nb')).toBe('ab')
    expect(cleanName('a\ud800b\udc00c')).toBe('abc')
    expect(cleanName('a😀b')).toBe('a😀b')
  })

  it('cuts a name to 80 characters, never in the middle of a pair, and trims it', () => {
    expect(cleanName('a'.repeat(80))).toBe('a'.repeat(80))
    expect(cleanName('a'.repeat(81))).toBe('a'.repeat(80))
    expect(cleanName('a'.repeat(500))).toBe('a'.repeat(80))
    expect(cleanName(`${'a'.repeat(79)}😀`)).toBe('a'.repeat(79))
    expect(cleanName(`${'a'.repeat(78)}😀`)).toBe(`${'a'.repeat(78)}😀`)
    expect(cleanName(`${'a'.repeat(79)} b`)).toBe('a'.repeat(79))
    expect(cleanName(`${'a'.repeat(78)} b`)).toBe(`${'a'.repeat(78)} b`)
    expect(cleanName(`${'a'.repeat(79)}\u00a0b`)).toBe('a'.repeat(79))
    expect(cleanName(`${'a'.repeat(100)}discord`)).toBe('a'.repeat(80))
    expect(cleanName(`discord${'a'.repeat(100)}`)).toBe('a'.repeat(80))
  })

  it('trims whitespace at both ends', () => {
    expect(cleanName('  Bob  ')).toBe('Bob')
    expect(cleanName('\t Bob \n')).toBe('Bob')
    expect(cleanName('\u00a0Bob\u3000')).toBe('Bob')
    expect(cleanName(' discord Bob clyde ')).toBe('Bob')
  })

  it('answers "Member" for no name, for a name of nothing that shows, and for what is not text', () => {
    for (const name of ['', ' ', '\n\t', '\u00a0', 'discord', ' clyde ', '\u0001', '\ud800', 'discord clyde', undefined, null, 5, {}, ['Bob'], true]) {
      expect(cleanName(name), String(name)).toBe('Member')
    }
  })

  it('answers a name of 1 to 80 characters with neither word in it, whatever it is given', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 300 }), fc.string({ unit: 'grapheme', maxLength: 300 }), fc.constantFrom('discord', 'clyde', 'dis', 'cord', 'cly', 'de', ' ', 'ｄ', '\u200b').chain((w) => fc.array(fc.constant(w), { maxLength: 30 }).map((a) => a.join('')))), (name) => {
        const out = cleanName(name)
        expect(out.length).toBeGreaterThanOrEqual(1)
        expect(out.length).toBeLessThanOrEqual(80)
        expect(out.isWellFormed()).toBe(true)
        expect(banned(out)).toBe(false)
        expect(out).toBe(out.trim())
        expect(/[\p{Cc}]/u.test(out)).toBe(false)
      }),
      { numRuns: 2000 },
    )
  })

  it('answers the same name again for a name it has cleaned', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 200 }), fc.array(fc.constantFrom('dis', 'cord', 'clyde', 'cly', 'de', ' ', 'x', 'é'), { maxLength: 30 }).map((a) => a.join(''))), (name) => {
        const once = cleanName(name)
        expect(cleanName(once)).toBe(once)
      }),
      { numRuns: 2000 },
    )
  })

  it('never answers more than the name had, except for "Member"', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (name) => {
        const out = cleanName(name)
        if (out === 'Member') return
        let i = 0
        for (const ch of out) {
          i = name.indexOf(ch, i)
          expect(i).toBeGreaterThanOrEqual(0)
          i += ch.length
        }
      }),
      { numRuns: 1000 },
    )
  })

  it('reads the first 400 characters of a name and no more', () => {
    expect(cleanName(`${' '.repeat(399)}b`)).toBe('b')
    expect(cleanName(`${' '.repeat(400)}b`)).toBe('Member')
    expect(cleanName(`${'discord'.repeat(57)}b`)).toBe('b')
    expect(cleanName(`${'discord'.repeat(57)}ab`)).toBe('a')
    expect(cleanName(`${'discord'.repeat(58)}b`)).toBe('d')
    expect(cleanName(`${'x'.repeat(399)}😀`)).toBe('x'.repeat(80))
  })

  it('stays quick on a long name made to make it slow', () => {
    const started = Date.now()
    cleanName('dis'.repeat(3_000) + 'clyde'.repeat(3_000) + 'cord'.repeat(3_000))
    cleanName('discord'.repeat(20_000))
    cleanName(`${'dis'.repeat(1_000)}${'clyde'.repeat(1_000)}${'cord'.repeat(1_000)}`)
    cleanName('\u200b'.repeat(50_000))
    cleanName(`${'dis'.repeat(60)}${'clyde'.repeat(60)}${'cord'.repeat(60)}`)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
