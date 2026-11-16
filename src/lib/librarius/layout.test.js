import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parse, plainText } from '../archive/markdown'
import { isArticle, groupMessages, excerpt, firstUnread, railMonths, isImage } from './layout'

// Invented ids only (the 200000000000000400 range), and invented names.
const ID = (n) => `2000000000000004${String(n).padStart(2, '0')}`
const T0 = Date.parse('2026-11-08T12:00:00.000Z')
const MIN = 60_000
const at = (ms) => new Date(T0 + ms).toISOString()
const image = (n) => ({ id: ID(n), filename: `p${n}.png`, contentType: 'image/png', size: 10, width: 4, height: 4, url: 'https://cdn.discordapp.com/attachments/1/2/p.png' })
const video = (n) => ({ ...image(n), filename: `v${n}.mp4`, contentType: 'video/mp4' })
const message = (n, over = {}) => ({
  id: ID(n),
  authorId: ID(90),
  authorName: 'Tor',
  authorAvatar: null,
  content: 'short',
  createdAt: at(0),
  editedAt: null,
  replyTo: null,
  attachments: [],
  embeds: [],
  stickers: [],
  reactions: [],
  origin: 'discord',
  ...over,
})
const article = (m) => isArticle(m, parse(m.content))

describe('isImage', () => {
  it.each([
    ['image/png', true],
    ['image/gif', true],
    ['image/svg+xml', true],
    ['IMAGE/JPEG', true],
    ['video/mp4', false],
    ['application/pdf', false],
    ['text/plain', false],
    ['images/png', false],
    ['x-image/png', false],
    [' image/png', false],
    ['image', false],
    ['', false],
    [null, false],
    [undefined, false],
    [42, false],
    [{ toString: () => 'image/png' }, false],
    [['image/png'], false],
  ])('%j → %s', (contentType, expected) => {
    expect(isImage({ contentType })).toBe(expected)
  })
})

describe('isArticle', () => {
  it('is false for a short plain message', () => {
    expect(article(message(1))).toBe(false)
  })

  it('turns on at exactly 600 characters, not at 599', () => {
    expect(article(message(1, { content: 'a'.repeat(599) }))).toBe(false)
    expect(article(message(2, { content: 'a'.repeat(600) }))).toBe(true)
    expect(article(message(3, { content: 'a'.repeat(601) }))).toBe(true)
    expect(article(message(4, { content: 'a'.repeat(4000) }))).toBe(true)
  })

  it('counts the length of the content, not of what it renders as', () => {
    // 600 characters of which almost none is visible text once parsed, and 599 of the same.
    expect(article(message(1, { content: '`' + 'a'.repeat(598) + '`' }))).toBe(true)
    expect(article(message(2, { content: '`' + 'a'.repeat(597) + '`' }))).toBe(false)
  })

  it('is true when there is a heading, at any of the three levels', () => {
    for (const content of ['# One', '## Two', '### Three', 'before\n# After a line', '  # indented']) {
      expect(article(message(1, { content })), content).toBe(true)
    }
  })

  it('finds a heading inside a quote and inside a list', () => {
    expect(article(message(1, { content: '> # quoted heading' }))).toBe(true)
    expect(article(message(2, { content: '- # heading in a list' }))).toBe(true)
    expect(article(message(3, { content: '- one\n  - # a nested one' }))).toBe(true)
  })

  it.each([
    '#hashtag',
    '#',
    '# ',
    '####  four hashes are no heading',
    '-# subtext is small print',
    'a # b',
    '`# code`',
    '```\n# in a code block\n```',
    '\\# escaped',
  ])('is false for %j, which is no heading', (content) => {
    expect(article(message(1, { content }))).toBe(false)
  })

  it('is true for two images, not for one, and not for two files that are not images', () => {
    expect(article(message(1, { attachments: [image(1)] }))).toBe(false)
    expect(article(message(2, { attachments: [image(1), image(2)] }))).toBe(true)
    expect(article(message(3, { attachments: [image(1), image(2), image(3)] }))).toBe(true)
    expect(article(message(4, { attachments: [video(1), video(2)] }))).toBe(false)
    expect(article(message(5, { attachments: [image(1), video(2)] }))).toBe(false)
    expect(article(message(6, { attachments: [image(1), video(2), image(3)] }))).toBe(true)
    expect(article(message(7, { attachments: [{ ...image(1), contentType: null }, { ...image(2), contentType: null }] }))).toBe(false)
  })

  it('answers a boolean', () => {
    expect(isArticle(message(1), [])).toBe(false)
    expect(isArticle(message(2, { content: 'a'.repeat(600) }), [])).toBe(true)
  })

  it('judges the nodes it is given, not the content', () => {
    expect(isArticle(message(1, { content: 'plain' }), parse('# a heading'))).toBe(true)
    expect(isArticle(message(2, { content: '# a heading' }), parse('plain'))).toBe(false)
  })

  it('refuses what is no message or no list of nodes', () => {
    for (const nodes of [null, undefined, {}, 'text']) expect(() => isArticle(message(1), nodes)).toThrow(/needs the parsed nodes/)
    for (const bad of [
      message(1, { content: null }),
      message(1, { content: 600 }),
      message(1, { attachments: null }),
      message(1, { attachments: undefined }),
      message(1, { attachments: {} }),
      null,
      undefined,
      'text',
      7,
    ]) {
      expect(() => isArticle(bad, []), String(bad)).toThrow(/needs text content and a list of attachments/)
    }
  })

  it('answers the same for a message as for a copy of it, whatever the content', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 700 }), (content) => {
        const m = message(1, { content })
        expect(article(m)).toBe(article({ ...m }))
        expect(article(m)).toBe(content.length >= 600 || parse(content).some(function has(n) {
          return n.type === 'heading' || (n.children ?? []).some(has) || (n.items ?? []).some((it) => it.children.some(has))
        }))
      }),
    )
  })
})

describe('groupMessages', () => {
  const run = (...ms) => groupMessages(ms).map((x) => x.grouped)

  it('is empty for no messages', () => {
    expect(groupMessages([])).toEqual([])
  })

  it('refuses what is no list', () => {
    for (const bad of [null, undefined, {}, 'abc', 7]) expect(() => groupMessages(bad)).toThrow(/takes a list of messages/)
  })

  it('refuses a list with something in it that is no message', () => {
    expect(() => groupMessages([message(1), null])).toThrow(TypeError)
    expect(() => groupMessages([message(1), { ...message(2), attachments: null }])).toThrow(/needs text content/)
    expect(() => groupMessages([message(1), { ...message(2), content: 5 }])).toThrow(TypeError)
  })

  it('never groups the first message', () => {
    expect(run(message(1))).toEqual([false])
  })

  it('keeps the messages themselves, in order, in a new list', () => {
    const input = [message(1), message(2, { createdAt: at(MIN) }), message(3, { authorId: ID(91), createdAt: at(2 * MIN) })]
    const out = groupMessages(input)
    expect(out).not.toBe(input)
    expect(out.map((x) => x.message)).toEqual(input)
    out.forEach((x, i) => expect(x.message).toBe(input[i]))
    expect(Object.keys(out[0]).sort()).toEqual(['grouped', 'message'])
  })

  it('groups a message after one from the same person a minute before', () => {
    expect(run(message(1), message(2, { createdAt: at(MIN) }))).toEqual([false, true])
  })

  it('does not group a message from someone else', () => {
    expect(run(message(1), message(2, { authorId: ID(91), createdAt: at(MIN) }))).toEqual([false, false])
  })

  it('groups the same time exactly, and 7 minutes less a second', () => {
    expect(run(message(1), message(2))).toEqual([false, true])
    expect(run(message(1), message(2, { createdAt: at(7 * MIN - 1000) }))).toEqual([false, true])
  })

  it('groups at exactly 7 minutes, and not a millisecond or a second after', () => {
    expect(run(message(1), message(2, { createdAt: at(7 * MIN) }))).toEqual([false, true])
    expect(run(message(1), message(2, { createdAt: at(7 * MIN + 1) }))).toEqual([false, false])
    expect(run(message(1), message(2, { createdAt: at(7 * MIN + 1000) }))).toEqual([false, false])
  })

  it('measures from the message before, not from the first of the run', () => {
    // 6 minutes between each: the third is 12 from the first and still grouped.
    expect(run(message(1), message(2, { createdAt: at(6 * MIN) }), message(3, { createdAt: at(12 * MIN) }))).toEqual([false, true, true])
    expect(run(message(1), message(2, { createdAt: at(6 * MIN) }), message(3, { createdAt: at(14 * MIN) }))).toEqual([false, true, false])
  })

  it('does not group a message that comes before the one it follows', () => {
    expect(run(message(1, { createdAt: at(MIN) }), message(2, { createdAt: at(0) }))).toEqual([false, false])
    expect(run(message(1, { createdAt: at(MIN) }), message(2, { createdAt: at(MIN - 1) }))).toEqual([false, false])
  })

  it('does not group a message with a time that is no time, in either place', () => {
    for (const bad of ['', 'not a date', 'Invalid Date', null, undefined, {}]) {
      expect(run(message(1), message(2, { createdAt: bad })), String(bad)).toEqual([false, false])
      expect(run(message(1, { createdAt: bad }), message(2)), String(bad)).toEqual([false, false])
    }
  })

  it('does not take a number or a Date object for a time', () => {
    expect(run(message(1, { createdAt: 5 }), message(2, { createdAt: 5 }))).toEqual([false, false])
    expect(run(message(1, { createdAt: 5 }), message(2, { createdAt: 6 }))).toEqual([false, false])
    expect(run(message(1, { createdAt: new Date(T0) }), message(2, { createdAt: new Date(T0) }))).toEqual([false, false])
  })

  it('does not group a reply, but groups the message after a reply', () => {
    const replyTo = { id: ID(50), authorId: ID(91), authorName: 'Ixen', content: 'q' }
    expect(run(message(1), message(2, { replyTo, createdAt: at(MIN) }))).toEqual([false, false])
    expect(run(message(1, { replyTo }), message(2, { createdAt: at(MIN) }))).toEqual([false, true])
  })

  it('does not group an article, or what follows one', () => {
    const long = { content: 'a'.repeat(600) }
    expect(run(message(1), message(2, { ...long, createdAt: at(MIN) }))).toEqual([false, false])
    expect(run(message(1, long), message(2, { createdAt: at(MIN) }))).toEqual([false, false])
    expect(run(message(1, long), message(2, { createdAt: at(MIN) }), message(3, { createdAt: at(2 * MIN) }))).toEqual([false, false, true])
  })

  it('treats a heading and two images as an article too', () => {
    expect(run(message(1), message(2, { content: '# Title', createdAt: at(MIN) }))).toEqual([false, false])
    expect(run(message(1, { content: '# Title' }), message(2, { createdAt: at(MIN) }))).toEqual([false, false])
    expect(run(message(1), message(2, { attachments: [image(1), image(2)], createdAt: at(MIN) }))).toEqual([false, false])
    expect(run(message(1, { attachments: [image(1), image(2)] }), message(2, { createdAt: at(MIN) }))).toEqual([false, false])
    expect(run(message(1), message(2, { attachments: [image(1)], createdAt: at(MIN) }))).toEqual([false, true])
  })

  it('compares authors by id, not by name', () => {
    expect(run(message(1), message(2, { authorName: 'Someone Else', createdAt: at(MIN) }))).toEqual([false, true])
    expect(run(message(1), message(2, { authorId: ID(91), authorName: 'Tor', createdAt: at(MIN) }))).toEqual([false, false])
  })

  it('does not group across two people who talk in turn', () => {
    const a = (n, t) => message(n, { createdAt: at(t) })
    const b = (n, t) => message(n, { authorId: ID(91), createdAt: at(t) })
    expect(run(a(1, 0), b(2, 1000), a(3, 2000), b(4, 3000), b(5, 4000))).toEqual([false, false, false, false, true])
  })

  it('agrees with an independent model over any run of messages', () => {
    const replyTo = { id: ID(50), authorId: ID(91), authorName: 'Ixen', content: 'q' }
    const kinds = {
      plain: {},
      long: { content: 'x'.repeat(600) },
      heading: { content: '## Title' },
      images: { attachments: [image(1), image(2)] },
      reply: { replyTo },
    }
    const step = fc.record({
      who: fc.constantFrom(90, 91, 92),
      gap: fc.constantFrom(-1000, 0, 1, 1000, 6 * MIN, 7 * MIN - 1, 7 * MIN, 7 * MIN + 1, 7 * MIN + 1000, 30 * MIN),
      kind: fc.constantFrom(...Object.keys(kinds)),
    })
    fc.assert(
      fc.property(fc.array(step, { maxLength: 25 }), (steps) => {
        let clock = 0
        const list = steps.map((s, i) => {
          clock += s.gap
          return message(i + 1, { authorId: ID(s.who), createdAt: at(clock), ...kinds[s.kind] })
        })
        const heavy = (s) => ['long', 'heading', 'images'].includes(s.kind)
        const expected = steps.map((s, i) => {
          if (i === 0) return false
          const p = steps[i - 1]
          const gap = Date.parse(list[i].createdAt) - Date.parse(list[i - 1].createdAt)
          return s.who === p.who && gap >= 0 && gap <= 7 * MIN && !heavy(s) && !heavy(p) && s.kind !== 'reply'
        })
        expect(groupMessages(list).map((x) => x.grouped)).toEqual(expected)
      }),
    )
  })
})

describe('excerpt', () => {
  it('is the text of the markup, with no markup in it', () => {
    expect(excerpt('Hello **bold** and __under__ and ~~gone~~ and `code`')).toBe('Hello bold and under and gone and code')
  })

  it('shows a link as its address and a masked link as its words', () => {
    expect(excerpt('see https://example.org/a now')).toBe('see https://example.org/a now')
    expect(excerpt('see [the page](https://example.org/a) now')).toBe('see the page now')
  })

  it('shows a custom emoji as its name between colons and drops a mention', () => {
    expect(excerpt('go <:wolf:200000000000000411> now')).toBe('go :wolf: now')
    expect(excerpt('<@200000000000000412> hello')).toBe('hello')
  })

  it('collapses every run of white space to one space, and trims the ends', () => {
    expect(excerpt('  a \n\n b\t\tc\r\nd  ')).toBe('a b c d')
    expect(excerpt('a  b c　d')).toBe('a b c d')
    expect(excerpt('# Title\nbody\n\n- one\n- two')).toBe('Title body one two')
  })

  it('leaves zero-width and right-to-left characters as they are', () => {
    expect(excerpt('a​b')).toBe('a​b')
    expect(excerpt('a‮b‏c‎')).toBe('a‮b‏c‎')
  })

  it('is empty for an empty or blank message', () => {
    expect(excerpt('')).toBe('')
    expect(excerpt(' \n\t ')).toBe('')
  })

  it('leaves 120 characters whole and cuts 121 to 119 and an ellipsis', () => {
    expect(excerpt('a'.repeat(119))).toBe('a'.repeat(119))
    expect(excerpt('a'.repeat(120))).toBe('a'.repeat(120))
    expect(excerpt('a'.repeat(121))).toBe('a'.repeat(119) + '…')
    expect(excerpt('a'.repeat(4000))).toBe('a'.repeat(119) + '…')
  })

  it('takes the longest length as an argument', () => {
    expect(excerpt('abcdef', 6)).toBe('abcdef')
    expect(excerpt('abcdefg', 6)).toBe('abcde…')
    expect(excerpt('a', 1)).toBe('a')
    expect(excerpt('ab', 1)).toBe('…')
    expect(excerpt('abc', 2)).toBe('a…')
  })

  it('does not leave a space in front of the ellipsis', () => {
    expect(excerpt('aaaa bbbb cccc', 6)).toBe('aaaa…')
    expect(excerpt('aaaa   bbbb', 6)).toBe('aaaa…')
  })

  it('counts a character outside the basic plane as one, and never cuts one in two', () => {
    const wolves = '🐺'.repeat(200)
    const cut = excerpt(wolves)
    expect(Array.from(cut)).toHaveLength(120)
    expect(cut).toBe('🐺'.repeat(119) + '…')
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    expect(excerpt('🐺'.repeat(120))).toBe('🐺'.repeat(120))
  })

  it('refuses a length that is not a whole number of at least 1', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, '5', null]) expect(() => excerpt('abc', bad), String(bad)).toThrow(/whole number from 1/)
  })

  it('uses the default length for undefined, and refuses what is no text', () => {
    expect(excerpt('a'.repeat(200), undefined)).toBe('a'.repeat(119) + '…')
    for (const bad of [null, undefined, 5, {}, ['a']]) expect(() => excerpt(bad)).toThrow(TypeError)
  })

  it('stays quick on a hostile run of nested markers', () => {
    const run = '**__~~||'.repeat(500)
    const start = performance.now()
    const out = excerpt(run)
    expect(performance.now() - start).toBeLessThan(200)
    expect(Array.from(out).length).toBeLessThanOrEqual(120)
  })

  it('is the plain text of the parse, collapsed and cut, whatever the content', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.integer({ min: 1, max: 150 }), (content, max) => {
        const full = plainText(parse(content)).replace(/\s+/g, ' ').trim()
        const chars = Array.from(full)
        const out = excerpt(content, max)
        expect(Array.from(out).length).toBeLessThanOrEqual(max)
        if (chars.length <= max) expect(out).toBe(full)
        else expect(out).toBe(chars.slice(0, max - 1).join('').trimEnd() + '…')
        expect(out).not.toMatch(/\s{2}|^\s|\s$/)
      }),
    )
  })
})

describe('firstUnread', () => {
  const list = [message(1), message(2), message(3), message(4)]

  it('is null when nothing has been read', () => {
    expect(firstUnread(list, null)).toBeNull()
    expect(firstUnread([], null)).toBeNull()
  })

  it('is null for a position that was never set, as for null', () => {
    expect(firstUnread(list, undefined)).toBeNull()
  })

  it('is null for no messages', () => {
    expect(firstUnread([], ID(2))).toBeNull()
  })

  it('is the first message after the one that was read last', () => {
    expect(firstUnread(list, ID(2))).toBe(ID(3))
    expect(firstUnread(list, ID(1))).toBe(ID(2))
    expect(firstUnread(list, ID(3))).toBe(ID(4))
  })

  it('is the first message when the last read is before them all', () => {
    expect(firstUnread(list, '200000000000000100')).toBe(ID(1))
    expect(firstUnread(list, '0')).toBe(ID(1))
  })

  it('is null when the last read is the newest, or past it', () => {
    expect(firstUnread(list, ID(4))).toBeNull()
    expect(firstUnread(list, '200000000000000999')).toBeNull()
  })

  it('compares ids as numbers, not as text', () => {
    // 17 digits against 18: as text "99999999999999999" sorts after "100000000000000000", as numbers it is far less.
    const wide = [message(1, { id: '100000000000000000' })]
    expect(firstUnread(wide, '99999999999999999')).toBe('100000000000000000')
    const narrow = [message(1, { id: '99999999999999999' })]
    expect(firstUnread(narrow, '100000000000000000')).toBeNull()
  })

  it('compares ids beyond what a Number holds exactly', () => {
    // These two differ only in the last digit, past 2^53, where a Number would call them the same.
    const m = [message(1, { id: '1322056087792521270' })]
    expect(firstUnread(m, '1322056087792521269')).toBe('1322056087792521270')
    expect(firstUnread(m, '1322056087792521270')).toBeNull()
    expect(firstUnread(m, '1322056087792521271')).toBeNull()
  })

  it('answers the first in the list, even where the list is not in order', () => {
    const jumbled = [message(1, { id: ID(5) }), message(2, { id: ID(3) }), message(3, { id: ID(9) })]
    expect(firstUnread(jumbled, ID(4))).toBe(ID(5))
  })

  it('is a string, the id of the message', () => {
    expect(typeof firstUnread(list, ID(1))).toBe('string')
  })

  it('refuses a position that is no id, and a message with no id', () => {
    for (const bad of ['', 'abc', '12x', '-5', '1.5', ' 7', '7 ', 7, 0, {}, [], true, '1'.repeat(21)]) {
      expect(() => firstUnread(list, bad), String(bad)).toThrow(/string of 1 to 20 digits/)
    }
    expect(() => firstUnread([message(1, { id: 'abc' })], ID(1))).toThrow(/string of 1 to 20 digits/)
    expect(() => firstUnread([message(1, { id: 5 })], ID(1))).toThrow(/string of 1 to 20 digits/)
    expect(() => firstUnread([message(1, { id: undefined })], ID(1))).toThrow(/string of 1 to 20 digits/)
  })

  it('refuses no list, whatever the position', () => {
    for (const bad of [null, undefined, {}, 'abc']) {
      expect(() => firstUnread(bad, ID(1))).toThrow(/takes a list of messages/)
      expect(() => firstUnread(bad, null)).toThrow(/takes a list of messages/)
    }
  })

  it('agrees with a plain filter, for any ids', () => {
    const id = fc.bigInt({ min: 1n, max: 2n ** 63n }).map(String)
    fc.assert(
      fc.property(fc.array(id, { maxLength: 12 }), id, (ids, last) => {
        const ms = ids.map((x, i) => message(i + 1, { id: x }))
        const expected = ids.find((x) => BigInt(x) > BigInt(last)) ?? null
        expect(firstUnread(ms, last)).toBe(expected)
      }),
    )
  })
})

describe('railMonths', () => {
  const labels = (a, b) => railMonths(a, b).map((m) => m.label)

  it('is one month for a post that stays in its month', () => {
    const out = railMonths('2026-11-08T21:14:00.000Z', '2026-11-20T08:00:00.000Z')
    expect(out).toEqual([{ label: 'Nov 2026', at: new Date('2026-11-01T00:00:00.000Z') }])
    expect(out[0].at).toBeInstanceOf(Date)
  })

  it('is one month for a post with one moment', () => {
    expect(labels('2026-11-08T21:14:00.000Z', '2026-11-08T21:14:00.000Z')).toEqual(['Nov 2026'])
  })

  it('lists every month from the first to the last, oldest first', () => {
    expect(labels('2026-11-08T21:14:00.000Z', '2027-02-02T00:00:00.000Z')).toEqual(['Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027'])
  })

  it('has the first instant of each month, in UTC, as its date', () => {
    expect(railMonths('2026-11-08T21:14:00.000Z', '2027-02-02T00:00:00.000Z').map((m) => m.at.toISOString())).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      '2027-02-01T00:00:00.000Z',
    ])
  })

  it('names all twelve months', () => {
    expect(labels('2026-01-15T00:00:00.000Z', '2026-12-15T00:00:00.000Z')).toEqual([
      'Jan 2026',
      'Feb 2026',
      'Mar 2026',
      'Apr 2026',
      'May 2026',
      'Jun 2026',
      'Jul 2026',
      'Aug 2026',
      'Sep 2026',
      'Oct 2026',
      'Nov 2026',
      'Dec 2026',
    ])
  })

  it('goes by UTC months, whatever the time zone of the reader', () => {
    expect(labels('2026-11-30T23:59:59.999Z', '2026-11-30T23:59:59.999Z')).toEqual(['Nov 2026'])
    expect(labels('2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')).toEqual(['Dec 2026'])
    expect(labels('2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.999Z')).toEqual(['Jan 2026'])
    expect(labels('2025-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z')).toEqual(['Dec 2025', 'Jan 2026'])
  })

  it('takes a Date as well as a string', () => {
    expect(labels(new Date('2026-11-08T21:14:00.000Z'), new Date('2026-12-02T00:00:00.000Z'))).toEqual(['Nov 2026', 'Dec 2026'])
    expect(labels('2026-11-08T21:14:00.000Z', new Date('2026-12-02T00:00:00.000Z'))).toEqual(['Nov 2026', 'Dec 2026'])
  })

  it('answers the month of the first date alone when the last is before it', () => {
    expect(labels('2026-11-08T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).toEqual(['Nov 2026'])
    expect(labels('2026-11-08T00:00:00.000Z', '2026-11-01T00:00:00.000Z')).toEqual(['Nov 2026'])
  })

  it('gives each month a Date of its own, and does not change the ones it was given', () => {
    const a = new Date('2026-11-08T21:14:00.000Z')
    const b = new Date('2026-12-08T21:14:00.000Z')
    const out = railMonths(a, b)
    expect(a.toISOString()).toBe('2026-11-08T21:14:00.000Z')
    expect(b.toISOString()).toBe('2026-12-08T21:14:00.000Z')
    expect(out[0].at).not.toBe(out[1].at)
    expect(out[0].at).not.toBe(a)
  })

  it('refuses what is no date', () => {
    const ok = '2026-11-08T00:00:00.000Z'
    for (const bad of ['', 'not a date', new Date(NaN)]) {
      expect(() => railMonths(bad, ok), String(bad)).toThrow(RangeError)
      expect(() => railMonths(bad, ok), String(bad)).toThrow(/from 2015/)
      expect(() => railMonths(ok, bad), String(bad)).toThrow(/from 2015/)
    }
    for (const bad of [null, undefined, {}, 5, [], true]) {
      expect(() => railMonths(bad, ok), String(bad)).toThrow(TypeError)
      expect(() => railMonths(bad, ok), String(bad)).toThrow(/dates or ISO strings/)
      expect(() => railMonths(ok, bad), String(bad)).toThrow(/dates or ISO strings/)
    }
  })

  it('answers from the day Discord began, and refuses a date before it', () => {
    expect(railMonths('2015-01-01T00:00:00.000Z', '2015-01-01T00:00:00.000Z')).toEqual([{ label: 'Jan 2015', at: new Date('2015-01-01T00:00:00.000Z') }])
    expect(() => railMonths('2014-12-31T23:59:59.999Z', '2026-11-08T00:00:00.000Z')).toThrow(RangeError)
    expect(() => railMonths('2026-11-08T00:00:00.000Z', '2014-12-31T23:59:59.999Z')).toThrow(RangeError)
    expect(() => railMonths('0050-01-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z')).toThrow(RangeError)
  })

  it('answers 1200 months, and refuses 1201', () => {
    expect(railMonths('2026-01-15T00:00:00.000Z', '2125-12-15T00:00:00.000Z')).toHaveLength(1200)
    expect(() => railMonths('2026-01-15T00:00:00.000Z', '2126-01-15T00:00:00.000Z')).toThrow(RangeError)
    expect(() => railMonths('2026-01-15T00:00:00.000Z', '2126-01-15T00:00:00.000Z')).toThrow(/at most 1200 months/)
    expect(() => railMonths('2015-01-01T00:00:00.000Z', '9999-12-31T00:00:00.000Z')).toThrow(/at most 1200 months/)
  })

  it('has consecutive months from the first date to the last, whatever the dates', () => {
    const aDate = fc.date({ min: new Date('2015-01-01T00:00:00.000Z'), max: new Date('2060-12-31T23:59:59.999Z'), noInvalidDate: true })
    fc.assert(
      fc.property(aDate, aDate, (x, y) => {
        const [first, last] = x <= y ? [x, y] : [y, x]
        const out = railMonths(first, last)
        const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1
        expect(out).toHaveLength(months)
        expect(out[0].at.getTime()).toBe(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1))
        expect(out.at(-1).at.getTime()).toBe(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1))
        out.forEach((m, i) => {
          if (i > 0) expect(m.at.getUTCMonth()).toBe((out[i - 1].at.getUTCMonth() + 1) % 12)
          expect(m.at.getUTCDate()).toBe(1)
          expect(m.at.getUTCHours() + m.at.getUTCMinutes() + m.at.getUTCSeconds() + m.at.getUTCMilliseconds()).toBe(0)
          expect(m.label).toMatch(/^[A-Z][a-z]{2} \d{4}$/)
        })
      }),
    )
  })
})
