import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { MAX_SOURCE, MENTION_CAP, automodMatcher, cleanName, validateReply } from './librariusSend.js'

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

describe('automodMatcher: regular expressions', () => {
  const withRegex = (patterns, over = {}) => keywordRule([], { regex_patterns: patterns }, over)

  it('matches a pattern, in any case, and says where', () => {
    const m = matcher([withRegex(['zor+p'])])
    expect(m('a ZORRRP b')).toEqual(hit(2, 8))
    expect(m('nothing')).toBeNull()
  })

  it('takes the first match that is not empty', () => {
    expect(matcher([withRegex(['x*'])])('abxxc')).toEqual(hit(2, 4))
    expect(matcher([withRegex(['x*'])])('abc')).toBeNull()
    expect(matcher([withRegex(['x*'])])('')).toBeNull()
    expect(matcher([withRegex(['^'])])('abc')).toBeNull()
  })

  it('reads a pattern as Unicode when it can, and as plain when it must', () => {
    expect(matcher([withRegex(['\\p{Lu}{2}'])])('a ZZ b')).toEqual(hit(2, 4))
    expect(matcher([withRegex(['a\\-b'])])('x A-B')).toEqual(hit(2, 5))
    expect(matcher([withRegex(['😀+'])])('a 😀😀')).toEqual(hit(2, 6))
  })

  it('finds the earliest of a rule keyword and a pattern, and a pattern needs no allow list exemption', () => {
    expect(matcher([keywordRule(['gronk'], { regex_patterns: ['zor+p'] })])('zorp gronk')).toEqual(hit(0, 4))
    expect(matcher([keywordRule(['gronk'], { regex_patterns: ['zor+p'] })])('gronk zorp')).toEqual(hit(0, 5))
    expect(matcher([keywordRule([], { regex_patterns: ['zorp'], allow_list: ['zorp'] })])('zorp')).toEqual(hit(0, 4))
  })

  it('tries every pattern of the rule, and skips one that cannot be compiled', () => {
    expect(matcher([withRegex(['(', 'gronk'])])('a gronk')).toEqual(hit(2, 7))
    expect(matcher([withRegex(['('])])('a')).toBeNull()
    expect(matcher([withRegex([null, 5, '', {}, 'gronk'])])('a gronk')).toEqual(hit(2, 7))
    expect(matcher([withRegex('gronk')])('gronk')).toBeNull()
  })

  it('is kept to its own rule and to the rules that apply to the member', () => {
    expect(matcher([withRegex(['zorp'], { enabled: false })])('zorp')).toBeNull()
    expect(matcher([withRegex(['zorp'], { exempt_roles: [ROLE_A] })], { memberRoleIds: [ROLE_A] })('zorp')).toBeNull()
    expect(matcher([withRegex(['zorp'], { exempt_channels: [FORUM] })], { channelIds: [FORUM] })('zorp')).toBeNull()
    expect(matcher([withRegex(['zorp'], { trigger_type: 3 })])('zorp')).toBeNull()
  })

  it('gives up on a pattern that runs past its time, and the next call works', () => {
    const m = matcher([withRegex(['(a+)+$'], { name: 'Slow' }), keywordRule(['gronk'], {}, { name: 'Fast' })])
    const started = Date.now()
    expect(m(`${'a'.repeat(60)}!`)).toBeNull()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(m(`${'a'.repeat(60)}! gronk`)).toEqual(hit(62, 67, 'Fast'))
    expect(matcher([withRegex(['zor+p'])])('zorp')).toEqual(hit(0, 4))
    expect(m('aaa')).toEqual(hit(0, 3, 'Slow'))
  })

  it('does not look at a text of more than 10,000 characters, but still reads its keywords', () => {
    const m = matcher([withRegex(['needle'], { name: 'Pattern' }), keywordRule(['gronk'], {}, { name: 'Word' })])
    const ten = `${'x'.repeat(9_994)}needle`
    expect(ten).toHaveLength(10_000)
    expect(m(ten)).toEqual(hit(9_994, 10_000, 'Pattern'))
    expect(m(`${ten}.`)).toBeNull()
    expect(m(`${ten}. gronk`)).toEqual(hit(10_002, 10_007, 'Word'))
  })

  it('does not change what it answers when the log it is given throws', () => {
    const rules = [withRegex(['(', '(a+)+$']), withRegex(['needle'])]
    const loud = automodMatcher(rules, {
      log: () => {
        throw new Error('the log is broken')
      },
    })
    expect(loud(`${'a'.repeat(60)}! needle`)).toEqual(hit(62, 68))
    expect(loud(`${'x'.repeat(10_000)} needle`)).toBeNull()
  })

  it('leaves no text behind for the next pattern to read', () => {
    const m = matcher([withRegex(['gronk'])])
    expect(m('a gronk')).toEqual(hit(2, 7))
    expect(m('a zorp')).toBeNull()
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
  it('goes through as it is, with what it names', () => {
    const r = send(reply('Hello there.'))
    expect(r).toEqual({ ok: true, clean: { source: 'Hello there.', replyTo: null, mentions: [], uploads: [] } })
  })

  it('keeps the reply it answers, as the two fields that the form takes', () => {
    const replyTo = { authorId: REPLIED, url: JUMP, extra: 'x' }
    const r = send(reply('Hello', { replyTo }))
    expect(r.ok).toBe(true)
    expect(r.clean.replyTo).toEqual({ authorId: REPLIED, url: JUMP })
    expect(r.clean.replyTo).not.toBe(replyTo)
  })

  it('takes a reply with no replyTo, mentions or uploads fields', () => {
    expect(send({ source: 'Hello' })).toEqual({ ok: true, clean: { source: 'Hello', replyTo: null, mentions: [], uploads: [] } })
    expect(send({ source: 'Hello', replyTo: undefined, mentions: undefined, uploads: undefined }).ok).toBe(true)
  })

  it('gives back copies, and changes nothing it was given', () => {
    const input = reply(`Hi <@${U1}>`, { mentions: [U1], uploads: ['a1'] })
    const copy = JSON.stringify(input)
    const r = send(input, { ownUploadIds: ['a1'] })
    expect(r.ok).toBe(true)
    r.clean.mentions.push('x')
    r.clean.uploads.push('x')
    expect(JSON.stringify(input)).toBe(copy)
  })

  it('works in the plain form too', () => {
    expect(send(reply('Hello'), { form: 'plain' }).ok).toBe(true)
  })
})

describe('validateReply: nothing to send', () => {
  const COPY = { ok: false, status: 400, error: 'Write something first.' }

  it('refuses an empty text, or one of only whitespace or nothing that shows', () => {
    for (const source of ['', ' ', '\n\n', '\t \r\n', '\u00a0', '\u200b', '\ufeff', '\u2028', '\u0000', ' \u200b\u200d\u2060 ', '\u0001\u0002', '\u3000']) {
      expect(send(reply(source)), JSON.stringify(source)).toEqual(COPY)
    }
  })

  it('refuses what is not a text, and what is not a reply', () => {
    for (const source of [undefined, null, 5, {}, [], ['a'], true]) expect(send(reply(source)), String(source)).toEqual(COPY)
    for (const input of [undefined, null, 5, 'hello', [], true]) expect(send(input), String(input)).toEqual(COPY)
  })

  it('takes one character that shows', () => {
    for (const source of ['.', 'a', '😀', '\u200ba\u200b', ' é ']) expect(send(reply(source)).ok, source).toBe(true)
  })

  it('is told before anything else is looked at', () => {
    expect(send(reply('', { mentions: 'x', uploads: 'x' }))).toEqual(COPY)
  })
})

describe('validateReply: how long a source may be', () => {
  const BUDGET = { ok: false, status: 413, error: "That's longer than Discord can carry in 3 messages." }

  it('keeps the limit at 16,000 code units', () => {
    expect(MAX_SOURCE).toBe(16_000)
  })

  it('takes a source of exactly 16,000 that fits in a message, and refuses one of 16,001', () => {
    expect(padded(16_000)).toHaveLength(16_000)
    expect(send(reply(padded(16_000))).ok).toBe(true)
    expect(padded(16_001)).toHaveLength(16_001)
    expect(send(reply(padded(16_001)))).toEqual(BUDGET)
    expect(send(reply(padded(15_999))).ok).toBe(true)
  })

  it('counts code units, not characters', () => {
    expect(send(reply(`${padded(15_998)}\n😀`))).toEqual(BUDGET)
    expect(send(reply(`${padded(15_997)}\n😀`)).ok).toBe(true)
  })

  it('refuses a huge source at once, as too long and before it is parsed', () => {
    const started = Date.now()
    expect(send(reply('a '.repeat(3_000_000)))).toEqual(BUDGET)
    expect(send(reply(' '.repeat(5_000_000)))).toEqual(BUDGET)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('tells a huge source it is too long before it asks whether it is empty', () => {
    expect(send(reply(' '.repeat(16_001)))).toEqual(BUDGET)
  })
})

describe('validateReply: the 3 messages of Discord', () => {
  const BUDGET = { ok: false, status: 413, error: "That's longer than Discord can carry in 3 messages." }
  const words = (n) => 'word '.repeat(n)

  it('refuses a reply that needs a fourth message', () => {
    expect(send(reply(words(2_500)))).toEqual(BUDGET)
    expect(send(reply(words(2_500)), { form: 'plain' })).toEqual(BUDGET)
  })

  it('takes a reply of two and of three messages', () => {
    expect(send(reply(words(1_300))).ok).toBe(true)
    expect(send(reply(words(2_200))).ok).toBe(true)
  })

  it('counts the messages of the form it is given: a long reply fits in the primary form and not in the fallback', () => {
    expect(send(reply(words(1_300)), { form: 'v2' }).ok).toBe(true)
    expect(send(reply(words(1_300)), { form: 'plain' })).toEqual(BUDGET)
  })

  it('uses the primary form when it is not told', () => {
    expect(validateReply(reply(words(1_300)), { automod: none, ownUploadIds: [] }).ok).toBe(true)
  })

  // The first size of a reply, in words, that one set of options takes and another does not: where a length of the footer, the
  // author or the reply line shows. The plain form holds about 1,050 of these words in 3 messages.
  const between = (take, refuse) => {
    for (let n = 900; n < 1_100; n++) if (send(reply(words(n)), take).ok && send(reply(words(n)), refuse).status === 413) return n
    return null
  }

  it('counts the room that the footer takes in the fallback, as the caller says it is', () => {
    const short = 'https://s.example/a'
    const long = `https://s.example/${'a'.repeat(180)}`
    const n = between({ form: 'plain', siteUrl: short }, { form: 'plain', siteUrl: long })
    expect(n).not.toBeNull()
    expect(send(reply(words(n)), { form: 'plain', siteUrl: short }).ok).toBe(true)
    expect(send(reply(words(n)), { form: 'plain', siteUrl: long })).toEqual(BUDGET)
  })

  it('counts the longest footer there can be when it is not told what it is', () => {
    const longest = `https://${'a'.repeat(192)}`
    expect(longest).toHaveLength(200)
    for (const n of [1_040, 1_050, 1_056, 1_057, 1_058, 1_060]) {
      const known = send(reply(words(n)), { form: 'plain', siteUrl: longest, authorId: '9'.repeat(20) })
      expect(send(reply(words(n)), { form: 'plain' }), String(n)).toEqual(known)
    }
  })

  it('counts the room that the author takes, as the caller says it is', () => {
    const n = between({ form: 'plain', authorId: '1'.repeat(17) }, { form: 'plain', authorId: '1'.repeat(20) })
    expect(n).not.toBeNull()
    expect(send(reply(words(n)), { form: 'plain' })).toEqual(BUDGET)
    expect(send(reply(words(n)), { form: 'plain', authorId: U1 }).ok).toBe(true)
    expect(() => send(reply('hi'), { authorId: 'x' })).toThrow(RangeError)
    expect(() => send(reply('hi'), { siteUrl: 'http://s.example/' })).toThrow(RangeError)
  })

  it('counts the room that the reply line takes', () => {
    const replyTo = { authorId: REPLIED, url: JUMP }
    let n = null
    for (let k = 900; k < 1_100 && n === null; k++) {
      const without = send(reply(words(k)), { form: 'plain' }).ok
      if (without && send(reply(words(k), { replyTo }), { form: 'plain' }).status === 413) n = k
    }
    expect(n).not.toBeNull()
    expect(send(reply(words(n), { replyTo }), { form: 'plain' })).toEqual(BUDGET)
    expect(send(reply(words(n), { replyTo }), { form: 'v2' }).ok).toBe(true)
  })

  it('does not show the alt text of a picture that has its file, so it does not count it', () => {
    const alt = 'a '.repeat(6_000)
    const source = `![${alt}](upload:1)`
    expect(send(reply(source, { uploads: ['u1'] }), { ownUploadIds: ['u1'] }).ok).toBe(true)
  })

  it('throws, as the form does, for a reply it is told the wrong way', () => {
    expect(() => send(reply('hi', { replyTo: { authorId: 'x', url: 'y' } }))).toThrow(RangeError)
    expect(() => send(reply('hi', { replyTo: 'x' }))).toThrow(TypeError)
  })
})

describe('validateReply: links', () => {
  const LINK = { ok: false, status: 400, error: 'Links must start with http:// or https://.' }

  it('refuses a masked link to anything but http or https', () => {
    for (const dest of ['ftp://y.example/', 'javascript:alert(1)', 'www.a.example', '#top', '/a/b', '//a.example', 'mailto:a@b.example', 'data:text/html,x', 'file:///etc/x', 'HTTPS://a.example', 'tel:123', 'a.example', 'a(b)', 'x/(y)(z)']) {
      expect(send(reply(`See [here](${dest}) now`)), dest).toEqual(LINK)
    }
  })

  it('refuses a link with no address, or whose address is in angle brackets or has space around it', () => {
    for (const text of ['[x]()', '[x]( )', '[x](<ftp://y.example>)', '[x]( ftp://y.example )', '[x](  <ftp://y.example>  )', '[x]( \t ftp://y.example\t)']) {
      expect(send(reply(text)), text).toEqual(LINK)
    }
  })

  it('refuses a link that is made of something else, or whose text is', () => {
    for (const text of ['**[x](ftp://y.example)**', '[*x*](ftp://y.example)', '[x](ftp://y_z_w)', '[x](ftp://y**z**w)', '[x](ftp://y*z*w)', '[x](ftp://y||z||w)', '[x](ftp://y~~z~~w)', '[**x**](ftp://y)', '> [x](ftp://y)', '- [x](ftp://y)', '||[x](ftp://y)||', '# [x](ftp://y)', '| a |\n|---|\n| [x](ftp://y) |', '[^a]: [x](ftp://y)\ntext [^a]', '[x](ftp://y)\n```\ncode\n```']) {
      expect(send(reply(text)), text).toEqual(LINK)
    }
  })

  it('refuses an angle link to anything but http or https', () => {
    for (const text of ['<ftp://y.example>', '<mailto:a@b.example>', '<javascript:alert(1)>', '<data:text/html,x>', '<file:///x>', '<FTP://y.example>', 'a <steam://run/1> b', '<x-y.z+w:rest>', '<ab:cd>']) {
      expect(send(reply(text)), text).toEqual(LINK)
    }
  })

  it('takes a link to http or https, in every way it can be written', () => {
    for (const text of ['[x](https://a.example)', '[x](http://a.example/p?q=1#f)', '<https://a.example>', 'https://a.example/x', '[x]( <https://a.example> )', '[x](https://a.example) and [y](http://b.example)', '**[x](https://a.example)**']) {
      expect(send(reply(text)).ok, text).toBe(true)
    }
  })

  it('takes what Discord writes in angle brackets that is not a link', () => {
    for (const text of ['<t:1700000000:R>', '<t:1700000000>', '<id:customize>', '<id:browse>', `<a:wave:${U1}>`, `<:wave:${U1}>`, `<@${U1}>`, `<#${U2}>`, '<3', 'a < b > c', '<b>bold</b>', '<a:b>']) {
      const mentions = text === `<@${U1}>` ? [U1] : []
      expect(send(reply(text, { mentions })).ok, text).toBe(true)
    }
  })

  it('takes a link-shaped text in code, as it is not a link', () => {
    for (const text of ['`[x](ftp://y)`', '```\n[x](ftp://y)\n```', '``[x](ftp://y)``', '<`ftp://y`>']) {
      expect(send(reply(text)).ok, text).toBe(true)
    }
  })

  it('takes brackets and parentheses that are not a link', () => {
    for (const text of ['[x] (ftp://y)', '[see note](see below)', 'f(x) and [1] (a)', '[x](a b)', '(see [1])', ']( no', '[x](\nftp://y)', '[x]\n(ftp://y)', 'a](\nftp://x)', '[x](a((b)))', '[x](a]b)']) {
      expect(send(reply(text)).ok, text).toBe(true)
    }
  })

  it('takes an address that starts as it should, and that the page cannot make a link of', () => {
    for (const text of ['[x](https://)', '[x](https://a.example/wiki/Foo_(bar))', '[x](http://a.example "title")', '[x](https://a.example/a((b)))']) {
      expect(send(reply(text)).ok, text).toBe(true)
    }
  })

  it('takes a picture of the reply, which has the same brackets', () => {
    expect(send(reply('![a](upload:1)', { uploads: ['u1'] }), { ownUploadIds: ['u1'] }).ok).toBe(true)
  })

  it('refuses a picture that is not one this form takes, as a link that does not work', () => {
    expect(send(reply('![a](upload:11)'))).toEqual(LINK)
    expect(send(reply('![a](upload:0)'))).toEqual(LINK)
    expect(send(reply('![a](https://a.example/p.png)')).ok).toBe(true)
    expect(send(reply('![a](ftp://a.example/p.png)'))).toEqual(LINK)
  })

  it('stays quick on a text made to make the check slow', () => {
    const started = Date.now()
    for (const text of [`](${' '.repeat(9_000)}`, '](  '.repeat(1_200), '<a'.repeat(1_500), `<${'a'.repeat(9_000)}`, '](a'.repeat(1_500), '[x]((('.repeat(800), '](<'.repeat(1_500), `](${'(a'.repeat(4_000)}`]) {
      expect(send(reply(text)).ok, text.slice(0, 12)).toBe(true)
    }
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('validateReply: pictures', () => {
  const MINE = { ok: false, status: 400, error: "That picture isn't one of yours." }
  const TOO_MANY = { ok: false, status: 400, error: 'A reply can hold 10 pictures at most.' }
  const ids = (n) => Array.from({ length: n }, (_, i) => `u${i + 1}`)

  it('takes a picture that is one of the caller, and keeps the list', () => {
    const r = send(reply('![a](upload:1) text ![b](upload:2)', { uploads: ['u1', 'u2'] }), { ownUploadIds: ['u1', 'u2', 'u3'] })
    expect(r).toEqual({ ok: true, clean: { source: '![a](upload:1) text ![b](upload:2)', replyTo: null, mentions: [], uploads: ['u1', 'u2'] } })
  })

  it('takes the ids as a list or as a set', () => {
    const input = reply('![a](upload:1)', { uploads: ['u1'] })
    expect(send(input, { ownUploadIds: ['u1'] }).ok).toBe(true)
    expect(send(input, { ownUploadIds: new Set(['u1']) }).ok).toBe(true)
    expect(send(input, { ownUploadIds: new Set() })).toEqual(MINE)
    expect(send(input, { ownUploadIds: [] })).toEqual(MINE)
  })

  it('refuses a picture of someone else', () => {
    expect(send(reply('![a](upload:1)', { uploads: ['u9'] }), { ownUploadIds: ['u1'] })).toEqual(MINE)
  })

  it('refuses a picture with no file named for it', () => {
    expect(send(reply('![a](upload:1)'), { ownUploadIds: ['u1'] })).toEqual(MINE)
    expect(send(reply('![a](upload:2)', { uploads: ['u1'] }), { ownUploadIds: ['u1'] })).toEqual(MINE)
    expect(send(reply('![a](upload:10)', { uploads: ids(9) }), { ownUploadIds: ids(9) })).toEqual(MINE)
  })

  it('takes the tenth picture', () => {
    const r = send(reply('![a](upload:10)', { uploads: ids(10) }), { ownUploadIds: ids(10) })
    expect(r.ok).toBe(true)
    expect(r.clean.uploads).toEqual(ids(10))
  })

  it('refuses more than ten files, or one that is not one of the caller, even when no picture shows it', () => {
    expect(send(reply('text', { uploads: ids(11) }), { ownUploadIds: ids(11) })).toEqual(TOO_MANY)
    expect(send(reply('text', { uploads: ids(10) }), { ownUploadIds: ids(10) }).ok).toBe(true)
    expect(send(reply('text', { uploads: ['u1', 'u9'] }), { ownUploadIds: ['u1'] })).toEqual(MINE)
    expect(send(reply('text', { uploads: ['u1'] }), { ownUploadIds: ['u1'] }).ok).toBe(true)
  })

  it('refuses a list of files that is not a list of ids', () => {
    for (const uploads of ['u1', {}, 5, true]) expect(send(reply('text', { uploads }), { ownUploadIds: ['u1'] }), String(uploads)).toEqual(MINE)
    for (const entry of [5, null, undefined, {}, ['u1'], 1n]) {
      expect(send(reply('text', { uploads: [entry] }), { ownUploadIds: [entry, '5', 'u1'] }), String(entry)).toEqual(MINE)
    }
  })

  it('takes null for no files, as it takes a list with none', () => {
    expect(send(reply('text', { uploads: null })).clean.uploads).toEqual([])
  })

  it('takes the same file twice', () => {
    expect(send(reply('![a](upload:1)![b](upload:2)', { uploads: ['u1', 'u1'] }), { ownUploadIds: ['u1'] }).ok).toBe(true)
  })

  it('takes the same picture written twice', () => {
    expect(send(reply('![a](upload:1) ![b](upload:1)', { uploads: ['u1'] }), { ownUploadIds: ['u1'] }).ok).toBe(true)
  })

  it('does not count a picture that is written in code', () => {
    expect(send(reply('`![a](upload:3)`', { uploads: [] })).ok).toBe(true)
    expect(send(reply('```\n![a](upload:3)\n```')).ok).toBe(true)
  })

  it('takes a reply that is only a picture', () => {
    expect(send(reply('![](upload:1)', { uploads: ['u1'] }), { ownUploadIds: ['u1'] }).ok).toBe(true)
  })

  it('is told after the length and the links', () => {
    expect(send(reply(`[x](ftp://y) ![a](upload:1)`))).toEqual({ ok: false, status: 400, error: 'Links must start with http:// or https://.' })
    expect(send(reply(`${'word '.repeat(2_500)} ![a](upload:1)`))).toEqual({ ok: false, status: 413, error: "That's longer than Discord can carry in 3 messages." })
  })
})

describe('validateReply: mentions', () => {
  const PICK = (cap = 10) => ({ ok: false, status: 400, error: `Pick people to mention from the list (${cap} at most).` })
  const id = (n) => `2000000000000005${String(n).padStart(2, '0')}`
  const tokens = (n, open = '<@') => Array.from({ length: n }, (_, i) => `${open}${id(i)}>`).join(' ')
  const picked = (n) => Array.from({ length: n }, (_, i) => id(i))

  it('takes a mention of a person who was picked, and names them', () => {
    const r = send(reply(`Hi <@${U1}> and <@${U2}>`, { mentions: [U2, U1, U3] }))
    expect(r.ok).toBe(true)
    expect(r.clean.mentions).toEqual([U1, U2])
  })

  it('takes a mention with a bang as the same person', () => {
    const r = send(reply(`Hi <@!${U1}> and <@${U1}>`, { mentions: [U1] }))
    expect(r.ok).toBe(true)
    expect(r.clean.mentions).toEqual([U1])
  })

  it('refuses a mention of a person who was not picked', () => {
    expect(send(reply(`Hi <@${U1}>`))).toEqual(PICK())
    expect(send(reply(`Hi <@${U1}>`, { mentions: [U2] }))).toEqual(PICK())
    expect(send(reply(`Hi <@${U1}> <@${U2}>`, { mentions: [U1] }))).toEqual(PICK())
    expect(send(reply(`Hi <@!${U1}>`, { mentions: [U2] }))).toEqual(PICK())
  })

  it('refuses a mention of a role, which no one can pick', () => {
    expect(send(reply(`Hi <@&${ROLE_A}>`, { mentions: [ROLE_A] }))).toEqual(PICK())
    expect(send(reply(`Hi <@&${ROLE_A}>`))).toEqual(PICK())
  })

  it('takes a mention of a channel, which pings no one', () => {
    expect(send(reply(`See <#${POST}>`)).ok).toBe(true)
  })

  it('takes @everyone and @here as text, which the message cannot ping', () => {
    expect(send(reply('Hi @everyone and @here')).ok).toBe(true)
  })

  it('does not count a mention in code, which is not one', () => {
    expect(send(reply(`\`<@${U1}>\``)).ok).toBe(true)
    expect(send(reply(`\`\`\`\n<@${U1}>\n\`\`\``)).ok).toBe(true)
  })

  it('counts a mention in a quote, a list, a spoiler, a heading and a table', () => {
    for (const text of [`> <@${U1}>`, `- <@${U1}>`, `||<@${U1}>||`, `# <@${U1}>`, `**<@${U1}>**`, `| a |\n|---|\n| <@${U1}> |`, `[^a]: <@${U1}>\ntext [^a]`]) {
      expect(send(reply(text)), text).toEqual(PICK())
      expect(send(reply(text, { mentions: [U1] })).ok, text).toBe(true)
    }
  })

  it('drops a person who was picked and is not mentioned, and does not count them', () => {
    const r = send(reply(`Hi <@${U1}>`, { mentions: [U1, ...picked(30)] }))
    expect(r.ok).toBe(true)
    expect(r.clean.mentions).toEqual([U1])
  })

  it('takes ten people and refuses an eleventh', () => {
    expect(send(reply(tokens(10), { mentions: picked(10) })).ok).toBe(true)
    expect(send(reply(tokens(11), { mentions: picked(11) }))).toEqual(PICK())
    expect(send(reply(tokens(40), { mentions: picked(40) }))).toEqual(PICK())
  })

  it('counts a person once however often they are mentioned', () => {
    const text = Array.from({ length: 25 }, (_, i) => `<@${id(i % 10)}>`).join(' ')
    const r = send(reply(text, { mentions: picked(10) }))
    expect(r.ok).toBe(true)
    expect(r.clean.mentions).toEqual(picked(10))
  })

  it('keeps the people in the order they are mentioned', () => {
    const r = send(reply(`<@${U3}> <@${U1}> <@${U2}> <@${U3}>`, { mentions: [U1, U2, U3] }))
    expect(r.clean.mentions).toEqual([U3, U1, U2])
  })

  it('keeps to the cap the caller gives, and to the least of that and the cap of the rules', () => {
    expect(send(reply(tokens(3), { mentions: picked(3) }), { mentionCap: 3 }).ok).toBe(true)
    expect(send(reply(tokens(4), { mentions: picked(4) }), { mentionCap: 3 })).toEqual(PICK(3))
    expect(send(reply(tokens(1), { mentions: picked(1) }), { mentionCap: 0 })).toEqual(PICK(0))
    expect(send(reply('no one'), { mentionCap: 0 }).ok).toBe(true)
    const strict = Object.assign(() => null, { mentionCap: 4 })
    expect(send(reply(tokens(4), { mentions: picked(4) }), { automod: strict }).ok).toBe(true)
    expect(send(reply(tokens(5), { mentions: picked(5) }), { automod: strict })).toEqual(PICK(4))
    expect(send(reply(tokens(5), { mentions: picked(5) }), { automod: strict, mentionCap: 5 })).toEqual(PICK(4))
    expect(send(reply(tokens(5), { mentions: picked(5) }), { automod: strict, mentionCap: 3 })).toEqual(PICK(3))
    expect(send(reply(tokens(4), { mentions: picked(4) }), { automod: strict, mentionCap: 4 }).ok).toBe(true)
  })

  it('takes the cap of the matcher of the rules, as it comes', () => {
    const m = automodMatcher([mentionRule(6)], quiet)
    expect(send(reply(tokens(5), { mentions: picked(5) }), { automod: m }).ok).toBe(true)
    expect(send(reply(tokens(6), { mentions: picked(6) }), { automod: m })).toEqual(PICK(5))
    const free = automodMatcher([mentionRule(6)], { ...quiet, isAdmin: true })
    expect(send(reply(tokens(10), { mentions: picked(10) }), { automod: free }).ok).toBe(true)
    expect(send(reply(tokens(11), { mentions: picked(11) }), { automod: free })).toEqual(PICK(10))
  })

  it('does not take a cap that is not a whole number for no cap', () => {
    const odd = Object.assign(() => null, { mentionCap: '2' })
    expect(send(reply(tokens(10), { mentions: picked(10) }), { automod: odd }).ok).toBe(true)
    expect(send(reply(tokens(11), { mentions: picked(11) }), { automod: odd })).toEqual(PICK())
    const nan = Object.assign(() => null, { mentionCap: NaN })
    expect(send(reply(tokens(11), { mentions: picked(11) }), { automod: nan })).toEqual(PICK())
  })

  it('refuses a list of picked people that is not a list', () => {
    for (const mentions of ['x', {}, 5, true]) expect(send(reply(`<@${U1}>`, { mentions }))).toEqual(PICK())
    for (const mentions of ['x', {}, 5, true]) expect(send(reply('hi', { mentions })), String(mentions)).toEqual(PICK())
  })

  it('takes null for no one picked, as it takes a list with none', () => {
    expect(send(reply('hi', { mentions: null })).clean.mentions).toEqual([])
    expect(send(reply(`<@${U1}>`, { mentions: null }))).toEqual(PICK())
  })

  it('does not take a picked entry that is not an id for a person', () => {
    expect(send(reply(`<@${U1}>`, { mentions: [5, null, {}, [U1], U2] }))).toEqual(PICK())
    expect(send(reply(`<@${U1}>`, { mentions: [5, null, {}, U1] })).ok).toBe(true)
  })

  it('does not take an id with a leading zero for a person who was picked', () => {
    const zero = `0${U1.slice(1)}`
    expect(send(reply(`<@${zero}>`, { mentions: [zero] }))).toEqual(PICK())
    expect(send(reply(`<@${U1}>`, { mentions: [zero] }))).toEqual(PICK())
    expect(send(reply(`<@${'1'.repeat(20)}>`, { mentions: ['1'.repeat(20)] })).ok).toBe(true)
    expect(send(reply(`<@${'1'.repeat(17)}>`, { mentions: ['1'.repeat(17)] })).ok).toBe(true)
  })

  it('is told after the length, the links and the pictures', () => {
    expect(send(reply(`[x](ftp://y) <@${U1}>`))).toEqual({ ok: false, status: 400, error: 'Links must start with http:// or https://.' })
    expect(send(reply(`<@${U1}> ![a](upload:1)`))).toEqual({ ok: false, status: 400, error: "That picture isn't one of yours." })
  })
})

describe('validateReply: the rules of the server', () => {
  const blockZorp = automodMatcher([keywordRule(['zorp'], {}, { name: 'No Zorp' })], quiet)

  it('refuses a reply that a rule blocks, with the rule and where', () => {
    expect(send(reply('Say zorp now'), { automod: blockZorp })).toEqual({
      ok: false,
      status: 422,
      error: 'Blocked by the server\'s AutoMod rule "No Zorp".',
      rule: 'No Zorp',
      match: { start: 4, end: 8 },
    })
  })

  it('takes a reply that no rule blocks', () => {
    expect(send(reply('Say nothing'), { automod: blockZorp }).ok).toBe(true)
  })

  it('asks the matcher about the text it will send', () => {
    const seen = []
    const automod = (text) => (seen.push(text), null)
    send(reply('Hello <@!' + U1 + '>', { mentions: [U1] }), { automod })
    send(reply('a\u0000b'), { automod })
    expect(seen).toEqual([`Hello <@!${U1}>`, 'a\ufffdb'])
  })

  it('answers with where the match is in the source the writer sees, even when it was cleaned', () => {
    const r = send(reply('a\u0000b zorp\ud800 c'), { automod: blockZorp })
    expect(r.match).toEqual({ start: 4, end: 8 })
  })

  it('is told after everything else', () => {
    expect(send(reply('zorp [x](ftp://y)'), { automod: blockZorp }).status).toBe(400)
    expect(send(reply(`zorp <@${U1}>`), { automod: blockZorp }).status).toBe(400)
    expect(send(reply('zorp ![a](upload:1)'), { automod: blockZorp }).status).toBe(400)
    expect(send(reply(`zorp ${'word '.repeat(2_500)}`), { automod: blockZorp }).status).toBe(413)
    expect(send(reply('zorp'), { automod: blockZorp }).status).toBe(422)
  })

  it('does not run the matcher for a reply that is refused before it', () => {
    let asked = 0
    const automod = () => (asked++, null)
    send(reply(''), { automod })
    send(reply('[x](ftp://y)'), { automod })
    send(reply(`<@${U1}>`), { automod })
    send(reply('x'.repeat(16_001)), { automod })
    expect(asked).toBe(0)
    send(reply('fine'), { automod })
    expect(asked).toBe(1)
  })

  it('reads a member who is exempt as one who may write what the rule blocks', () => {
    const exempt = automodMatcher([keywordRule(['zorp'], {}, { exempt_roles: [ROLE_A] })], { ...quiet, memberRoleIds: [ROLE_A] })
    expect(send(reply('zorp'), { automod: exempt }).ok).toBe(true)
  })
})

describe('validateReply: what is kept of the text', () => {
  it('replaces a NUL and a lone half of a pair by the replacement character, one for one', () => {
    const r = send(reply('a\u0000b\ud800c\udc00d😀'))
    expect(r.ok).toBe(true)
    expect(r.clean.source).toBe('a\ufffdb\ufffdc\ufffdd😀')
    expect(r.clean.source).toHaveLength('a\u0000b\ud800c\udc00d😀'.length)
  })

  it('keeps the text it is given otherwise, to the character', () => {
    const source = '  \r\n# Title \u00a0\n\t**bold** \u200b 😀 e\u0301 \r\n'
    expect(send(reply(source)).clean.source).toBe(source)
  })

})

describe('validateReply: the options', () => {
  it('refuses a form that is neither', () => {
    for (const form of ['v3', '', null, 5, 'V2', {}]) throwsAs(() => send(reply('hi'), { form }), RangeError, 'form must be "v2" or "plain"')
  })

  it('refuses a form before it looks at the text', () => {
    expect(() => send(reply(''), { form: 'v3' })).toThrow(RangeError)
  })

  it('takes no form for the primary form', () => {
    expect(validateReply(reply('hi'), { automod: none, ownUploadIds: [], form: undefined }).ok).toBe(true)
  })

  it('refuses a matcher that is not a function', () => {
    for (const automod of [undefined, null, {}, 'x', 5, [], { mentionCap: 3 }]) {
      throwsAs(() => send(reply('hi'), { automod }), TypeError, 'automod must be a function')
      throwsAs(() => send(reply(''), { automod }), TypeError, 'automod must be a function')
    }
  })

  it('refuses a cap that is not a whole number from 0 to 10', () => {
    for (const mentionCap of [-1, 11, 1.5, NaN, '5', null, Infinity]) {
      throwsAs(() => send(reply('hi'), { mentionCap }), RangeError, 'mentionCap must be a whole number from 0 to 10')
    }
    for (const mentionCap of [0, 1, 10]) expect(send(reply('hi'), { mentionCap }).ok).toBe(true)
    expect(send(reply('hi'), { mentionCap: undefined }).ok).toBe(true)
  })

  it('refuses ids of pictures that are not a list or a set', () => {
    for (const ownUploadIds of ['u1', {}, 5, null, new Map()]) throwsAs(() => send(reply('hi'), { ownUploadIds }), TypeError, 'ownUploadIds must be a list or a set')
    expect(validateReply(reply('hi'), { automod: none }).ok).toBe(true)
    expect(validateReply(reply('![a](upload:1)', { uploads: ['Stryker was here'] }), { automod: none })).toEqual({
      ok: false,
      status: 400,
      error: "That picture isn't one of yours.",
    })
  })

  it('refuses options that are not an object', () => {
    for (const options of [undefined, null, 5, 'x', []]) throwsAs(() => validateReply(reply('hi'), options), TypeError, 'the options must be an object')
  })

  it('takes the primary cap of mentions to be ten', () => {
    expect(MENTION_CAP).toBe(10)
  })
})

describe('validateReply: for any input', () => {
  it('answers a refusal or a clean reply, and never throws, whatever the body is', () => {
    const junk = fc.oneof(fc.string(), fc.anything(), fc.constant(undefined))
    fc.assert(
      fc.property(fc.record({ source: junk, mentions: junk, uploads: junk, replyTo: fc.constant(null) }, { requiredKeys: [] }), (input) => {
        const r = send(input)
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

  it('gives back a source that Postgres can store and that is as long as the one it was given', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 1, maxLength: 200 }), (source) => {
        const r = send(reply(`a ${source}`))
        if (!r.ok) return
        expect(r.clean.source).toHaveLength(source.length + 2)
        expect(r.clean.source).not.toContain('\u0000')
        expect(r.clean.source.isWellFormed()).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })

  it('never names a person who is not both mentioned and picked', () => {
    const idArb = fc.constantFrom(U1, U2, U3, '200000000000000424', '200000000000000425')
    fc.assert(
      fc.property(fc.array(idArb, { maxLength: 8 }), fc.array(idArb, { maxLength: 8 }), (mentioned, pickedIds) => {
        const source = `x ${mentioned.map((m) => `<@${m}>`).join(' ')}`
        const r = send(reply(source, { mentions: pickedIds }))
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
