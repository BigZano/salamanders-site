import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { toDiscord } from './librariusForm.js'
import { MAX_SOURCE, MENTION_CAP, automodMatcher, automodUnchecked, cleanName, scanInWorker, scanPatterns, shownBy, translatePattern, validateReply } from './librariusSend.js'

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

  it('reads \\s as holding U+0085, in a class and out of one, and gives up on \\S in a class', () => {
    expect(translatePattern('a\\sb')).toBe('a[\\s\\u0085]b')
    expect(translatePattern('[\\s]')).toBe('[\\s\\u0085]')
    expect(translatePattern('[a\\sb]')).toBe('[a\\s\\u0085b]')
    expect(translatePattern('a\\Sb')).toBe('a[^\\s\\u0085]b')
    expect(translatePattern('[\\S]')).toBeNull()
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
    expect(translatePattern('[a]\\s')).toBe('[a][\\s\\u0085]')
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

describe('scanInWorker: the one worker', () => {
  it('answers { found } of a job, and the same job again', async () => {
    const job = { rules: [['zor+p']], texts: ['a zorrp'] }
    expect(await scanInWorker(job)).toEqual({ found: { text: 0, rule: 0, start: 2, end: 7 } })
    expect(await scanInWorker(job)).toEqual({ found: { text: 0, rule: 0, start: 2, end: 7 } })
    expect(await scanInWorker({ rules: [['x']], texts: ['a'] })).toEqual({ found: null })
  })

  it('answers null for a job that crashes the worker, and the next job gets a new one', async () => {
    expect(await scanInWorker({ rules: [['(']], texts: ['a'] })).toBeNull()
    expect(await scanInWorker({ rules: [['a']], texts: ['a'] })).toEqual({ found: { text: 0, rule: 0, start: 0, end: 1 } })
  })

  it('rejects a job that cannot be handed over, and the jobs after it still run', async () => {
    await expect(scanInWorker({ rules: [], texts: [() => 1] })).rejects.toThrow()
    expect(await scanInWorker({ rules: [['a']], texts: ['a'] })).toEqual({ found: { text: 0, rule: 0, start: 0, end: 1 } })
  })

  it('stays answering after a worker is ended for being slow', async () => {
    expect(await scanInWorker({ rules: [['(a+)+$']], texts: [`${'a'.repeat(60)}!`] })).toBeNull()
    for (let i = 0; i < 3; i++) expect(await scanInWorker({ rules: [['a']], texts: ['xa'] })).toEqual({ found: { text: 0, rule: 0, start: 1, end: 2 } })
  })
})

describe('automodMatcher: it stays linear in the length of the text', () => {
  // One word of 16,000 characters, which the old reading walked end to end for every place a keyword met it: seconds, on Bun
  // 7 s for `*ass*` and 20 s for `*a*`. Each check is 6 to 37 ms now (Node and Bun, see the report), and up to about 1.1 s when
  // Stryker's instrumented copy of the module runs it. The bound is far above both, so that a loaded host and the mutation run do
  // not fail it, and still under what a quadratic walk takes, which is more than that on every runtime, instrumented or not.
  const BOUND_MS = 4_000
  const timed = (fn) => {
    const started = performance.now()
    const value = fn()
    return { value, ms: performance.now() - started }
  }
  const word = (unit, n = 16_000) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)

  it('answers `*a*`, `*ab*` and `*ass*` over one long word, and says where, within the bound', () => {
    for (const [keyword, unit] of [['*a*', 'a'], ['*ab*', 'ab'], ['*ass*', 'ass'], ['*a*', 'ab'], ['*ass*', 'bass']]) {
      const text = word(unit)
      const { value, ms } = timed(() => find([keyword], text))
      expect(value, keyword + unit).toEqual(hit(0, 16_000))
      expect(ms, keyword + unit).toBeLessThan(BOUND_MS)
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

  it('answers a prefix and a suffix keyword over one long word, within the bound', () => {
    const text = word('a')
    for (const [keywords, expected] of [[['a*'], hit(0, 16_000)], [['*a'], hit(0, 16_000)], [['aa*'], hit(0, 16_000)], [['*aa'], hit(0, 16_000)], [['a'], null], [['ab*'], null], [['*ba'], null], [['*a*b'], null]]) {
      const { value, ms } = timed(() => find(keywords, text))
      expect(value, keywords.join()).toEqual(expected)
      expect(ms, keywords.join()).toBeLessThan(BOUND_MS)
    }
  })

  it('answers when every place the keyword meets the word is a match, whatever the word is made of', () => {
    for (const unit of ['é', '𐐨', 'a\u0301', 'a\u200b', 'a*', 'a_']) {
      const text = word(unit, 15_000)
      const { ms } = timed(() => find(['*a*', '*𐐨*', '*é*'], text))
      expect(ms, JSON.stringify(unit)).toBeLessThan(BOUND_MS)
    }
  })

  it('stops at the first match the allow list does not cover, and walks the rest only while it does', () => {
    const text = word('a')
    // Every match is inside the word, which the allow list covers: all of them are looked at, each in a moment.
    const covered = timed(() => find(['*a*'], text, { allow_list: ['*a*'] }))
    expect(covered.value).toBeNull()
    expect(covered.ms).toBeLessThan(BOUND_MS)
    // The first word is covered, in every one of its 8,000 places; the second is not, and is what is found.
    const partly = timed(() => find(['*a*'], `${'a'.repeat(8_000)} ${'a'.repeat(7_000)}`, { allow_list: [`*${'a'.repeat(7_500)}*`] }))
    expect(partly.value).toEqual(hit(8_001, 15_001))
    expect(partly.ms).toBeLessThan(BOUND_MS)
    const first = timed(() => find(['*a*'], `${'a'.repeat(7_000)} ${'a'.repeat(8_000)}`, { allow_list: [`*${'a'.repeat(7_500)}*`] }))
    expect(first.value).toEqual(hit(0, 7_000))
    expect(first.ms).toBeLessThan(BOUND_MS)
    const many = timed(() => find(['a*', '*a', '*a*'], text, { allow_list: ['*aa*', 'a*', '*a'] }))
    expect(many.value).toBeNull()
    expect(many.ms).toBeLessThan(BOUND_MS)
  })

  it('answers a text of many short words, and a keyword in all of them, within the bound', () => {
    const text = 'ass '.repeat(4_000)
    for (const keywords of [['*ass*'], ['ass'], ['ass*'], ['*ass']]) {
      const { value, ms } = timed(() => find(keywords, text))
      expect(value, keywords.join()).toEqual(hit(0, 3))
      expect(ms, keywords.join()).toBeLessThan(BOUND_MS)
    }
    const allowed = timed(() => find(['*ass*'], text, { allow_list: ['ass'] }))
    expect(allowed.value).toBeNull()
    expect(allowed.ms).toBeLessThan(BOUND_MS)
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
const opts = (over = {}) => ({ form: 'v2', automod: none, ownUploadIds: [], ...over })
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
    expect((await validateReply(reply(words(1_300)), { automod: none, ownUploadIds: [] })).ok).toBe(true)
  })

  // The first size of a reply, in words, that one set of options takes and another does not: where a length of the footer, the
  // author or the reply line shows. The plain form holds about 1,050 of these words in 3 messages.
  const between = async (take, refuse) => {
    for (let n = 900; n < 1_100; n++) if ((await send(reply(words(n)), take)).ok && (await send(reply(words(n)), refuse)).status === 413) return n
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

  it('counts the longest footer there can be when it is not told what it is', async () => {
    const longest = `https://${'a'.repeat(192)}`
    expect(longest).toHaveLength(200)
    for (const n of [1_040, 1_050, 1_056, 1_057, 1_058, 1_060]) {
      const known = await send(reply(words(n)), { form: 'plain', siteUrl: longest, authorId: '9'.repeat(20) })
      expect(await send(reply(words(n)), { form: 'plain' }), String(n)).toEqual(known)
    }
  })

  it('counts the room that the author takes, as the caller says it is', async () => {
    const n = await between({ form: 'plain', authorId: '1'.repeat(17) }, { form: 'plain', authorId: '1'.repeat(20) })
    expect(n).not.toBeNull()
    expect(await send(reply(words(n)), { form: 'plain' })).toEqual(BUDGET)
    expect((await send(reply(words(n)), { form: 'plain', authorId: U1 })).ok).toBe(true)
    await expect(send(reply('hi'), { authorId: 'x' })).rejects.toThrow(RangeError)
    await expect(send(reply('hi'), { siteUrl: 'http://s.example/' })).rejects.toThrow(RangeError)
  })

  it('counts the room that the reply line takes', async () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    let n = null
    for (let k = 900; k < 1_100 && n === null; k++) {
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
    expect(shownBy([v2('first', 'second', 'third')], { reply: null, footer: FOOT })).toEqual(['first', 'second', 'third'])
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
    expect(shownBy([part], { reply: null, footer: FOOT })).toEqual(['one', 'two'])
  })

  it('takes the reply line off the start of the first message, and the footer off the end of the last', () => {
    expect(shownBy([plain(`${REPLY}\nhello\n${FOOT}`)], fixed)).toEqual(['hello'])
    expect(shownBy([v2(`${REPLY}\nhello\n${FOOT}`)], fixed)).toEqual(['hello'])
    expect(shownBy([v2(`${REPLY}\nhello`, `more\n${FOOT}`)], fixed)).toEqual(['hello', 'more'])
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
    expect(shownBy([v2('null', 'more')], { reply: null, footer: FOOT })).toEqual(['null', 'more'])
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
    for (const source of ['zo||![x](upload:1)||rp', 'zo**![x](upload:1)**rp', 'zo~~![x](upload:1)~~rp', 'zo*![x](upload:1)*rp', 'zo__![x](upload:1)__rp', '[zo![x](upload:1)rp](https://example.test/a)']) {
      expect(zorp(source), source).toBeNull()
      for (const form of ['v2', 'plain']) expect(await via(source, zorp, { form }), `${form} ${source}`).toEqual(BLOCK('No Zorp'))
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

  it('reads the words that a picture alone on its line leaves the text of as two Text Displays, and as one text in the fallback', async () => {
    const source = 'the\n\n![x](upload:1)\n\nmat'
    expect(phrase(source)).toBeNull()
    expect((await via(source, phrase, { form: 'v2' })).ok).toBe(true)
    expect(await via(source, phrase, { form: 'plain' })).toEqual(BLOCK('No Mat'))
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
    const shownOf = (source, form) =>
      toDiscord(source, { form, authorId: U1, siteUrl: 'https://example.test/x', replyTo: null, images: [{ ref: 1, name: 'image-1.png' }] })
        .parts.map((part) => squash(part.text))
        .join('\n')

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
          if (!r.ok && r.status === 422) expect(squash(source).includes('zorp') || inSent, source).toBe(true)
        }),
        { numRuns: 1_500 },
      )
      // Not a property that holds because nothing reaches it: a good part of the sources are ones that only the sent text refuses.
      expect(onlyInSent).toBeGreaterThan(100)
    })

    it('refuses the reply when what is sent holds the keyword, for sources that are made of anything (the property)', async () => {
      const pieces = fc.constantFrom('zo', 'rp', 'z', 'o', 'r', 'p', 'zorp', 'zor', '![x](upload:1)', '![](upload:1)', ' ', '\n', '\n\n', '**', '*', '_', '||', '~~', '`', '> ', '- ', '# ', '-# ', '| a | b |\n|---|---|\n| ', ' |', '[^1]', '\n\n[^1]: ', '[', '](https://example.test/a)', '\\')
      await fc.assert(
        fc.asyncProperty(fc.array(pieces, { minLength: 1, maxLength: 14 }), fc.constantFrom('v2', 'plain'), async (list, form) => {
          const source = list.join('')
          const r = await via(source, m, { authorId: U1, siteUrl: 'https://example.test/x', form })
          const inSent = shownOf(source, form).includes('zorp')
          if (inSent) expect(r.ok, source).toBe(false)
          if (!r.ok && r.status === 422) expect(squash(source).includes('zorp') || inSent, source).toBe(true)
        }),
        { numRuns: 1_000 },
      )
    })
  })
})

describe('validateReply: the regular expressions of the server\'s rules', () => {
  const withRegex = (patterns, over = {}) => keywordRule([], { regex_patterns: patterns }, over)
  const UNCHECKED = { ok: false, status: 422, error: "This reply couldn't be checked against the server's rules. Try a shorter one." }
  const by = (rules, source, over = {}) => send(reply(source, over.reply), { automod: matcher(rules), ...over.options })

  it('refuses a reply that a pattern matches, with the rule and where in the source', async () => {
    expect(await by([withRegex(['zor+p'], { name: 'No Zorp' })], 'Say zorrp now')).toEqual({
      ok: false,
      status: 422,
      error: 'Blocked by the server\'s AutoMod rule "No Zorp".',
      rule: 'No Zorp',
      match: { start: 4, end: 9 },
    })
    expect((await by([withRegex(['zor+p'])], 'Say nothing')).ok).toBe(true)
  })

  it('refuses a reply that a pattern matches only in what is sent, with no match in the source', async () => {
    const r = await send(reply('zo![x](upload:1)rp', { uploads: ['u1'] }), { automod: matcher([withRegex(['zorp'], { name: 'No Zorp' })]), ownUploadIds: ['u1'] })
    expect(r).toEqual({ ok: false, status: 422, error: 'Blocked by the server\'s AutoMod rule "No Zorp".', rule: 'No Zorp', match: null })
  })

  it('says it could not check a reply of more than 10,000 characters, when a pattern would have to run, and no rule name', async () => {
    const long = `${'word '.repeat(2_100)}x`
    expect(long.length).toBeGreaterThan(10_000)
    expect(await by([withRegex(['needle'])], long)).toEqual(UNCHECKED)
    expect((await by([keywordRule(['needle'])], long)).ok).toBe(true)
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

  it('asks for the source first, then each text that is sent, in one go', async () => {
    const asked = []
    const automod = Object.assign(() => null, { regex: async (texts) => (asked.push(texts), null) })
    expect((await send(reply('Say hi'), { automod })).ok).toBe(true)
    expect(asked).toEqual([['Say hi', 'Say hi']])
    expect((await send(reply('x'), { automod: Object.assign(() => null, { regex: async () => ({ rule: 'Mock', text: 1, start: 0, end: 1 }) }) })).match).toBeNull()
    expect((await send(reply('x'), { automod: Object.assign(() => null, { regex: async () => ({ rule: 'Mock', text: 0, start: 0, end: 1 }) }) })).match).toEqual({ start: 0, end: 1 })
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
    expect((await validateReply(reply('hi'), { automod: none, ownUploadIds: [], form: undefined })).ok).toBe(true)
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
    expect((await validateReply(reply('hi'), { automod: none })).ok).toBe(true)
    expect(await validateReply(reply('![a](upload:1)', { uploads: ['Stryker was here'] }), { automod: none })).toEqual({
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
