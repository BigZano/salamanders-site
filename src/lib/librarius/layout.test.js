import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parse, plainText, walk } from '../archive/markdown'
import { isArticle, groupMessages, articleMemo, samePeople, isRead, excerpt, firstUnread, railMonths, isImage, isSpoilerFile, ago, sortPosts, repliesText, sizeText } from './layout'

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
// The fastest of a few runs: a busy machine slows some of them, while code that does too much work for hostile text is
// slow in every one.
const fastest = (run, times = 5) =>
  Math.min(
    ...Array.from({ length: times }, () => {
      const start = performance.now()
      run()
      return performance.now() - start
    }),
  )

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
    expect(fastest(() => excerpt(run))).toBeLessThan(200)
    expect(Array.from(excerpt(run)).length).toBeLessThanOrEqual(120)
  })

  it('is the plain text of the parse, spoilers masked, collapsed and cut, whatever the content', () => {
    // The model: the same parse, each spoiler turned into the mask in place, and a text node (or address) that holds a
    // `||` no spoiler took cut there and ended with the mask and a sentinel, as is a spoiler over lines closed at the last
    // `||` (`lastBar`); the archive's plainText then reads it all, and what comes after the sentinel is dropped.
    const maskedText = (content) => {
      const nodes = parse(content)
      let closed = false
      walk(nodes, (node) => {
        if (node.type === 'spoiler') {
          const cut = !closed && node.lastBar === true
          Object.assign(node, { type: 'text', value: cut ? '▒▒▒\u0000' : '▒▒▒', children: undefined })
          closed ||= cut
        } else if (!closed && node.type === 'url' && node.href.includes('||')) {
          closed = true
          Object.assign(node, { type: 'text', value: node.href.slice(0, node.href.indexOf('||')) + '▒▒▒\u0000' })
        } else if (!closed && node.type === 'text' && node.value.includes('||')) {
          closed = true
          node.value = node.value.slice(0, node.value.indexOf('||')) + '▒▒▒\u0000'
        }
      })
      return plainText(nodes).split('\u0000')[0].replace(/\s+/g, ' ').trim()
    }
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.integer({ min: 1, max: 150 }), (content, max) => {
        const full = maskedText(content)
        const chars = Array.from(full)
        const out = excerpt(content, max)
        expect(Array.from(out).length).toBeLessThanOrEqual(max)
        if (chars.length <= max) expect(out).toBe(full)
        else expect(out).toBe(chars.slice(0, max - 1).join('').trimEnd() + '…')
        expect(out).not.toMatch(/\s{2}|^\s|\s$/)
      }),
    )
    // The same over text that has spoilers in it, which a random string rarely does.
    const piece = fc.constantFrom('||a b||', 'x', '**||c||**', '~~d~~', '||', '`||e||`', '\\||f||', '> ||g||', '- ||h||', '# ||i||', ' ', '\n')
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 30 }), fc.integer({ min: 1, max: 40 }), (pieces, max) => {
        const content = pieces.join('')
        const chars = Array.from(maskedText(content))
        const expected = chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…'
        expect(excerpt(content, max)).toBe(expected)
      }),
    )
  })

  describe('with a spoiler in the text', () => {
    const MASK = '▒▒▒'

    it('shows the mask in its place, and never what it hides', () => {
      expect(excerpt('||secret||')).toBe(MASK)
      expect(excerpt('before ||secret|| after')).toBe(`before ${MASK} after`)
      expect(excerpt('||one|| and ||two||')).toBe(`${MASK} and ${MASK}`)
    })

    it('is the same mask whatever the length of the secret', () => {
      expect(excerpt('||a||')).toBe(MASK)
      expect(excerpt(`||${'long secret '.repeat(30)}||`)).toBe(MASK)
    })

    it('masks a spoiler with markup, a link, a mention, an emoji or code inside', () => {
      for (const inner of ['**secret**', '__secret__', '~~secret~~', '*secret*', '`secret`', 'https://secret.example/x', '[secret](https://secret.example/x)', '<@200000000000000410> secret', '<:secret:200000000000000430>', '<#200000000000000401>', '***secret***']) {
        expect(excerpt(`a ||${inner}|| b`), inner).toBe(`a ${MASK} b`)
      }
    })

    it('masks a spoiler inside bold, italics, underline and strikethrough', () => {
      expect(excerpt('**bold ||secret|| more**')).toBe(`bold ${MASK} more`)
      expect(excerpt('*it ||secret|| ic*')).toBe(`it ${MASK} ic`)
      expect(excerpt('__under ||secret|| line__')).toBe(`under ${MASK} line`)
      expect(excerpt('~~strike ||secret|| out~~')).toBe(`strike ${MASK} out`)
      expect(excerpt('***both ||secret|| styles***')).toBe(`both ${MASK} styles`)
      expect(excerpt('**bold __under ~~strike ||secret|| x~~ x__ x**')).toBe(`bold under strike ${MASK} x x x`)
    })

    it('masks a spoiler in the label of a link', () => {
      expect(excerpt('[go ||secret|| now](https://example.org/a)')).toBe(`go ${MASK} now`)
    })

    it('masks a spoiler inside a quote, a heading, a subtext and a list, nested ones too', () => {
      expect(excerpt('> quoted ||secret||')).toBe(`quoted ${MASK}`)
      expect(excerpt('>>> quoted\n||secret|| here')).toBe(`quoted ${MASK} here`)
      expect(excerpt('# Title ||secret||')).toBe(`Title ${MASK}`)
      expect(excerpt('-# small ||secret||')).toBe(`small ${MASK}`)
      expect(excerpt('- one ||secret||\n- two')).toBe(`one ${MASK} two`)
      expect(excerpt('- one\n  - deeper ||secret||\n    - deepest ||secret||')).toBe(`one deeper ${MASK} deepest ${MASK}`)
      expect(excerpt('1. first ||secret||\n2. second')).toBe(`first ${MASK} second`)
      expect(excerpt('> - in a quote ||secret|| list')).toBe(`in a quote ${MASK} list`)
      expect(excerpt('- # heading ||secret|| in a list')).toBe(`heading ${MASK} in a list`)
    })

    it('does not mask what is not a spoiler: code stays as it was written', () => {
      expect(excerpt('`||in code||`')).toBe('||in code||')
      expect(excerpt('`a || b`')).toBe('a || b')
      expect(excerpt('```\n||in a block||\n```')).toBe('||in a block||')
      expect(excerpt('```\n||not closed\n```')).toBe('||not closed')
      expect(excerpt('a | b | c')).toBe('a | b | c')
      expect(excerpt('||')).toBe('▒▒▒')
    })

    it('does not show the secret when the cut falls in front of, in, or behind the mask', () => {
      const lead = 'a'.repeat(117)
      // 117 + a space + the mask is 121 characters: the cut lands inside the mask.
      expect(excerpt(`${lead} ||secret||`)).toBe(`${lead} ▒…`)
      expect(excerpt(`${lead} ||secret|| and more`)).toBe(`${lead} ▒…`)
      // The cut lands in front of the mask.
      expect(excerpt(`${'a'.repeat(130)} ||secret||`)).toBe(`${'a'.repeat(119)}…`)
      // The mask fits, and the text behind it is cut.
      expect(excerpt(`${'a'.repeat(100)} ||secret|| ${'b'.repeat(100)}`)).toBe(`${'a'.repeat(100)} ${MASK} ${'b'.repeat(14)}…`)
      expect(excerpt('||secret||', 2)).toBe('▒…')
      expect(excerpt('||secret||', 3)).toBe(MASK)
      expect(excerpt('||secret||', 1)).toBe('…')
    })

    it('never lets what a spoiler hides reach the excerpt, for any text around it and any length', () => {
      // A secret begins with ZQ and plain text is digits, so no word of the plain text can be mistaken for one.
      const secret = fc.stringMatching(/^[a-z]{4,10}$/).map((word) => `ZQ${word}`)
      const plain = fc.stringMatching(/^[0-9]{1,8}$/)
      const spoiler = secret.map((word) => ({ text: `||${word}||`, spoilers: 1 }))
      const wrapped = fc.tuple(secret, fc.constantFrom('**', '__', '~~', '*', '_')).map(([word, mark]) => ({ text: `${mark}7 ||${word}|| x${mark}`, spoilers: 1 }))
      const linked = secret.map((word) => ({ text: `[a ||${word}|| b](https://example.org/${'q'.repeat(3)})`, spoilers: 1 }))
      const rich = secret.map((word) => ({ text: `||**${word}** https://${word.toLowerCase()}.example <@200000000000000410> \`${word}\`||`, spoilers: 1 }))
      const words = plain.map((text) => ({ text, spoilers: 0 }))
      const piece = fc.oneof(spoiler, wrapped, linked, rich, words)
      const prefix = fc.constantFrom('', '', '> ', '- ', '1. ', '# ', '-# ')
      const line = fc.tuple(prefix, fc.array(piece, { minLength: 1, maxLength: 5 })).map(([lead, pieces]) => ({
        text: lead + pieces.map((p) => p.text).join(' '),
        spoilers: pieces.reduce((n, p) => n + p.spoilers, 0),
      }))
      fc.assert(
        fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 200 }), (lines, max) => {
          const content = lines.map((l) => l.text).join('\n')
          expect(excerpt(content, max)).not.toMatch(/ZQ|zq/)
          const all = excerpt(content, 100_000)
          expect(all).not.toMatch(/ZQ|zq|secret/i)
          expect(all.split(MASK).length - 1).toBe(lines.reduce((n, l) => n + l.spoilers, 0))
        }),
        { numRuns: 300 },
      )
    })

    describe('a spoiler a preview cut open (no `||` to close it): fail closed', () => {
      it('masks from the unmatched `||` to the end, so a spoiler cut at 200 characters hides what is left of it', () => {
        const content = `Ending: ||the traitor was ${'x'.repeat(300)}||`
        const out = excerpt(content.slice(0, 200))
        expect(out).toBe(`Ending: ${MASK}`)
        expect(out).not.toContain('traitor')
      })

      it('masks a lone `||` and what follows, wherever it is', () => {
        expect(excerpt('||')).toBe(MASK)
        expect(excerpt('|||')).toBe(MASK)
        expect(excerpt('||secret')).toBe(MASK)
        expect(excerpt('a || b')).toBe(`a ${MASK}`)
        expect(excerpt('visible ||hidden')).toBe(`visible ${MASK}`)
        expect(excerpt('only one || bar')).toBe(`only one ${MASK}`)
      })

      it('drops every node after it, of any kind', () => {
        expect(excerpt('visible ||hidden and **more** `code` https://x.example <@200000000000000410> <:w:200000000000000430> ~~s~~ tail')).toBe(`visible ${MASK}`)
        expect(excerpt('visible ||hidden https://x.example/secret')).toBe(`visible ${MASK}`)
        expect(excerpt('visible ||hidden\n```\nblock secret\n```\ntail')).toBe(`visible ${MASK}`)
      })

      it('drops the lines after it, so a spoiler across lines is masked in a preview', () => {
        expect(excerpt('||line one\nline two||')).toBe(MASK)
        expect(excerpt('||line one\nline two\nline three||')).toBe(MASK)
        expect(excerpt('first\n||second\nthird')).toBe(`first ${MASK}`)
        expect(excerpt('first\n\n||second\n\nthird\n\nfourth||')).toBe(`first ${MASK}`)
      })

      it('masks a spoiler that runs over lines as one mask, and shows what follows its closer', () => {
        expect(excerpt('a ||secret\nmore secret|| after')).toBe(`a ${MASK} after`)
        expect(excerpt('> a ||secret\n> more secret|| after')).toBe(`a ${MASK} after`)
      })

      it('masks to the end from a spoiler over lines the readings of Discord pair differently, closed at the last bar', () => {
        expect(excerpt('a ||secret\nmore secret|| and ||open')).toBe(`a ${MASK}`)
        expect(excerpt('a ||secret\nmore ||secret|| tail')).toBe(`a ${MASK}`)
        expect(excerpt('a ||secret\n`code||` tail')).toBe(`a ${MASK}`)
        expect(excerpt('a ||secret\n> quoted secret\n- listed secret\n```\ncode secret\n```\nlast secret|| after\nnext')).toBe(`a ${MASK}`)
        expect(excerpt('a ||secret\n`x||` ||more secret\nlast secret|| after')).toBe(`a ${MASK}`)
      })

      it('keeps the spoilers that closed before it, masked, and the text before it', () => {
        expect(excerpt('||a|| and ||b')).toBe(`${MASK} and ${MASK}`)
        expect(excerpt('plain ||a|| mid ||b|| and ||c secret')).toBe(`plain ${MASK} mid ${MASK} and ${MASK}`)
      })

      it('masks from the unmatched `||` inside nested formatting, and drops what follows the formatting too', () => {
        expect(excerpt('**bold ||secret** tail')).toBe(`bold ${MASK}`)
        expect(excerpt('**bold __under ~~strike ||secret~~ x__ x** tail')).toBe(`bold under strike ${MASK}`)
        expect(excerpt('*it ||secret* tail')).toBe(`it ${MASK}`)
        expect(excerpt('***both ||secret*** tail')).toBe(`both ${MASK}`)
        expect(excerpt('> quoted **bold ||secret** after\nnext line')).toBe(`quoted bold ${MASK}`)
        expect(excerpt('# Title ||secret\nbody')).toBe(`Title ${MASK}`)
        expect(excerpt('-# small ||secret\nbody')).toBe(`small ${MASK}`)
        expect(excerpt('[go ||secret](https://example.org/a) after')).toBe(`go ${MASK}`)
        expect(excerpt('[go ||secret](https://example.org/a) after\nmore')).toBe(`go ${MASK}`)
      })

      it('masks from the unmatched `||` inside a list, and drops the items after it', () => {
        expect(excerpt('- one\n- two ||secret\n- three')).toBe(`one two ${MASK}`)
        expect(excerpt('- one\n  - deeper ||secret\n  - deeper still\n- three')).toBe(`one deeper ${MASK}`)
        expect(excerpt('1. first\n2. second ||secret\n3. third')).toBe(`first second ${MASK}`)
        expect(excerpt('- # heading ||secret\n- three')).toBe(`heading ${MASK}`)
        expect(excerpt('> - in a quote ||secret\n> - more')).toBe(`in a quote ${MASK}`)
      })

      it('masks an address that swallowed the opener, from the `||` on', () => {
        expect(excerpt('see https://example.org/x||secret|| now')).toBe(`see https://example.org/x${MASK}`)
        expect(excerpt('see <https://example.org/x||secret> now')).toBe(`see https://example.org/x${MASK}`)
      })

      it('does not take a `||` in the address behind a link\'s words, which is never shown', () => {
        expect(excerpt('[words](https://example.org/a||b) tail')).toBe('words tail')
        expect(excerpt('[words](https://example.org/a||b||c) tail')).toBe('words tail')
      })

      it('treats an escaped `||` as an opener too, since a preview cannot tell it from one', () => {
        expect(excerpt('escaped \\||not a spoiler\\|| tail')).toBe(`escaped ${MASK}`)
      })

      it('still cuts to the length asked for, after the mask', () => {
        expect(excerpt(`${'a'.repeat(117)} ||secret and more`)).toBe(`${'a'.repeat(117)} ▒…`)
        expect(excerpt('abc ||secret', 6)).toBe('abc ▒…')
        expect(excerpt('abc ||secret', 7)).toBe(`abc ${MASK}`)
        expect(excerpt('||secret', 1)).toBe('…')
      })

      it('shows nothing that comes after an unmatched `||`, for any text before and after it, and any length', () => {
        // What follows the opener holds ZQ in every word and no `|`, so nothing can close the opener and any ZQ in the
        // excerpt came from after it. What comes before is digits.
        const word = fc.stringMatching(/^[a-z]{3,8}$/).map((w) => `ZQ${w}`)
        const mark = fc.constantFrom('', '', '**', '__', '~~', '*', '`', '> ', '- ', '# ', '-# ', '[', ']( https://example.org', '<', ':', '\\')
        const after = fc.array(fc.tuple(mark, word), { minLength: 1, maxLength: 8 }).map((parts) => parts.map(([m, w]) => m + w).join(' '))
        const lines = fc.array(after, { minLength: 1, maxLength: 4 }).map((ls) => ls.join('\n'))
        const before = fc.array(fc.stringMatching(/^[0-9]{1,6}$/), { maxLength: 5 }).map((ws) => ws.join(' '))
        fc.assert(
          fc.property(before, lines, fc.integer({ min: 1, max: 200 }), (lead, rest, max) => {
            const content = `${lead} ||${rest}`
            expect(excerpt(content, max)).not.toMatch(/ZQ|zq/)
            expect(excerpt(content, 100_000)).toBe(`${lead} ${MASK}`.trim())
          }),
          { numRuns: 300 },
        )
      })
    })

    it('is quick on a hostile run of spoilers', () => {
      const run = '||x||'.repeat(800)
      expect(fastest(() => excerpt(run))).toBeLessThan(200)
      expect(excerpt(run)).toBe('▒'.repeat(119) + '…')
    })
  })
})

describe('firstUnread', () => {
  const messages = () => [message(1), message(2), message(3), message(4)]

  it('is null when nothing has been read', () => {
    expect(firstUnread(messages(), null)).toBeNull()
    expect(firstUnread([], null)).toBeNull()
  })

  it('is null for a position that was never set, as for null', () => {
    expect(firstUnread(messages(), undefined)).toBeNull()
  })

  it('is null for no messages', () => {
    expect(firstUnread([], ID(2))).toBeNull()
  })

  it('is the first message after the one that was read last', () => {
    expect(firstUnread(messages(), ID(2))).toBe(ID(3))
    expect(firstUnread(messages(), ID(1))).toBe(ID(2))
    expect(firstUnread(messages(), ID(3))).toBe(ID(4))
  })

  it('is the first message when the last read is before them all', () => {
    expect(firstUnread(messages(), '200000000000000100')).toBe(ID(1))
    expect(firstUnread(messages(), '0')).toBe(ID(1))
  })

  it('is null when the last read is the newest, or past it', () => {
    expect(firstUnread(messages(), ID(4))).toBeNull()
    expect(firstUnread(messages(), '200000000000000999')).toBeNull()
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
    expect(typeof firstUnread(messages(), ID(1))).toBe('string')
  })

  it('refuses a position that is no id, and a message with no id', () => {
    for (const bad of ['', 'abc', '12x', '-5', '1.5', ' 7', '7 ', 7, 0, {}, [], true, '1'.repeat(21)]) {
      expect(() => firstUnread(messages(), bad), String(bad)).toThrow(/string of 1 to 20 digits/)
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

describe('isSpoilerFile', () => {
  it.each([
    ['SPOILER_a.png', true],
    ['spoiler_a.png', true],
    ['Spoiler_A.PNG', true],
    ['SpOiLeR_x', true],
    ['SPOILER_', true],
    ['SPOILER_#1.png', true],
    ['SPOILER_what?.png', true],
    ['https://cdn.discordapp.com/attachments/200000000000000401/200000000000000460/SPOILER_a.png', true],
    ['https://cdn.discordapp.com/attachments/200000000000000401/200000000000000460/spoiler_a.png?ex=65f0&is=65e0&hm=ab12', true],
    ['https://cdn.discordapp.com/attachments/1/2/SPOILER_a.png#frag', true],
    ['https://cdn.discordapp.com/attachments/1/2/SPOILER_a.png?next=/b/c.png', true],
    ['a.png', false],
    ['photo.png', false],
    ['', false],
    ['SPOILER', false],
    ['SPOILERa.png', false],
    ['SPOILER-a.png', false],
    ['SPOILER a.png', false],
    [' SPOILER_a.png', false],
    ['xSPOILER_a.png', false],
    ['a_SPOILER_b.png', false],
    ['a#SPOILER_b.png', false],
    ['a?SPOILER_b.png', false],
    ['https://cdn.discordapp.com/attachments/1/SPOILER_dir/a.png', false],
    ['https://cdn.discordapp.com/attachments/1/2/a.png?name=SPOILER_a.png', false],
    ['https://cdn.discordapp.com/attachments/1/2/a.png#SPOILER_a.png', false],
    ['https://cdn.discordapp.com/attachments/1/2/a.png?next=/SPOILER_b.png', false],
    ['https://cdn.discordapp.com/attachments/1/2/SPOILER_a.png/', false],
    ['https://SPOILER_x.example/a.png', false],
  ])('%j → %s', (nameOrUrl, expected) => {
    expect(isSpoilerFile(nameOrUrl)).toBe(expected)
  })

  it('is false for what is no text', () => {
    for (const value of [null, undefined, 5, true, {}, [], ['SPOILER_a.png'], { toString: () => 'SPOILER_a.png' }]) {
      expect(isSpoilerFile(value), String(value)).toBe(false)
    }
  })

  it('is true for any name that begins with the word in any case, and for any address that ends in one', () => {
    const name = fc.stringMatching(/^[A-Za-z0-9._ -]{0,12}$/)
    const cased = fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }).map((flips) => [...'spoiler_'].map((c, i) => (flips[i] ? c.toUpperCase() : c)).join(''))
    fc.assert(
      fc.property(cased, name, name, (word, rest, dir) => {
        expect(isSpoilerFile(word + rest)).toBe(true)
        expect(isSpoilerFile(`https://cdn.discordapp.com/attachments/${dir.replace(/[?#/]/g, '')}/${word + rest}?ex=1#x`)).toBe(true)
        expect(isSpoilerFile(`${word}${rest}/tail`)).toBe(false)
        expect(isSpoilerFile(`x${word}${rest}`)).toBe(false)
      }),
    )
  })
})

describe('ago', () => {
  const NOW = Date.parse('2026-11-10T10:02:00.000Z')
  const before = (ms) => new Date(NOW - ms).toISOString()
  const SEC = 1000
  const MIN = 60 * SEC
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it.each([
    [-DAY, 'just now'],
    [-1, 'just now'],
    [0, 'just now'],
    [59 * SEC, 'just now'],
    [MIN - 1, 'just now'],
    [MIN, '1m ago'],
    [90 * SEC, '1m ago'],
    [2 * MIN, '2m ago'],
    [HOUR - 1, '59m ago'],
    [HOUR, '1h ago'],
    [90 * MIN, '1h ago'],
    [2 * HOUR, '2h ago'],
    [DAY - 1, '23h ago'],
    [DAY, '1d ago'],
    [36 * HOUR, '1d ago'],
    [6 * DAY, '6d ago'],
    [30 * DAY - 1, '29d ago'],
  ])('reads %i ms as "%s"', (ms, text) => {
    expect(ago(before(ms), NOW)).toBe(text)
  })

  it('writes the date, in the reader\'s own style, for a month or more', () => {
    for (const ms of [30 * DAY, 31 * DAY, 400 * DAY]) {
      const then = NOW - ms
      expect(ago(before(ms), NOW), String(ms)).toBe(new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))
    }
    expect(ago(before(30 * DAY), NOW)).toMatch(/2026/)
    expect(ago(before(30 * DAY), NOW)).not.toContain('ago')
  })

  it('writes nothing for a time that is no time', () => {
    for (const bad of ['', 'yesterday-ish', 'Invalid Date', null, undefined, 5, {}, [], new Date(NOW)]) {
      expect(ago(bad, NOW), String(bad)).toBe('')
    }
  })

  it('refuses a clock that is no time', () => {
    for (const bad of [NaN, Infinity, -Infinity, '5', null, undefined, new Date(NOW), {}]) {
      expect(() => ago(before(0), bad), String(bad)).toThrow(TypeError)
      expect(() => ago(before(0), bad), String(bad)).toThrow(/now must be a number of milliseconds/)
    }
  })

  it('reads any age in the biggest unit that fits, whatever the age', () => {
    fc.assert(
      fc.property(fc.integer({ min: -DAY, max: 29 * DAY }), (ms) => {
        const text = ago(before(ms), NOW)
        if (ms < MIN) expect(text).toBe('just now')
        else if (ms < HOUR) expect(text).toBe(`${Math.floor(ms / MIN)}m ago`)
        else if (ms < DAY) expect(text).toBe(`${Math.floor(ms / HOUR)}h ago`)
        else expect(text).toBe(`${Math.floor(ms / DAY)}d ago`)
      }),
    )
  })
})

describe('sortPosts', () => {
  const day = (n) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`
  const post = (id, activity, created, over = {}) => ({ id, pinned: false, lastActivityAt: day(activity), createdAt: day(created), ...over })
  const ids = (posts) => posts.map((p) => p.id)

  it('puts the pinned posts first, then the newest activity first', () => {
    const posts = [post('a', 2, 1), post('b', 9, 2), post('c', 5, 3, { pinned: true }), post('d', 7, 4), post('e', 1, 5, { pinned: true })]
    expect(ids(sortPosts(posts, 'activity'))).toEqual(['c', 'e', 'b', 'd', 'a'])
  })

  it('orders by the day a post was made for "created", pinned ones still first', () => {
    const posts = [post('a', 2, 1), post('b', 9, 2), post('c', 5, 3, { pinned: true }), post('d', 7, 4), post('e', 1, 5, { pinned: true })]
    expect(ids(sortPosts(posts, 'created'))).toEqual(['e', 'c', 'd', 'b', 'a'])
  })

  it('keeps the order it was given for posts that are level', () => {
    const posts = [post('a', 3, 1), post('b', 3, 2), post('c', 3, 3), post('d', 4, 4), post('e', 3, 5, { pinned: true }), post('f', 3, 6, { pinned: true })]
    expect(ids(sortPosts(posts, 'activity'))).toEqual(['e', 'f', 'd', 'a', 'b', 'c'])
    expect(ids(sortPosts([post('x', 1, 4), post('y', 2, 4), post('z', 3, 4)], 'created'))).toEqual(['x', 'y', 'z'])
  })

  it('puts a post whose date is no date after the dated ones, and keeps those in the order given', () => {
    const posts = [post('a', 1, 1, { lastActivityAt: 'later than never' }), post('b', 2, 1), post('c', 3, 1, { lastActivityAt: undefined }), post('d', 4, 1, { lastActivityAt: 7 }), post('e', 5, 1)]
    expect(ids(sortPosts(posts, 'activity'))).toEqual(['e', 'b', 'a', 'c', 'd'])
    expect(ids(sortPosts([post('a', 1, 1, { createdAt: null }), post('b', 2, 2)], 'created'))).toEqual(['b', 'a'])
  })

  it('counts only a pinned that is true', () => {
    const posts = [post('a', 1, 1, { pinned: 'yes' }), post('b', 2, 1, { pinned: 1 }), post('c', 3, 1, { pinned: undefined }), post('d', 1, 1, { pinned: true })]
    expect(ids(sortPosts(posts, 'activity'))).toEqual(['d', 'c', 'b', 'a'])
  })

  it('answers a new list, and changes neither the list nor the posts', () => {
    const posts = [post('a', 1, 1), post('b', 2, 2)]
    const copy = JSON.parse(JSON.stringify(posts))
    const out = sortPosts(posts, 'activity')
    expect(out).not.toBe(posts)
    expect(posts).toEqual(copy)
    expect(out[0]).toBe(posts[1])
    expect(sortPosts([], 'activity')).toEqual([])
  })

  it('refuses what is no list, or a sort it does not know', () => {
    for (const bad of [null, undefined, {}, 'abc', 5]) expect(() => sortPosts(bad, 'activity')).toThrow(/takes a list of posts/)
    for (const bad of ['', 'Activity', 'latest', undefined, null, 'lastActivityAt', '__proto__']) expect(() => sortPosts([], bad), String(bad)).toThrow(/activity.*created/)
  })

  it('orders any posts: pinned first, then by the chosen date, newest first, level ones as given', () => {
    const one = fc.record({ pinned: fc.boolean(), activity: fc.integer({ min: 1, max: 6 }), created: fc.integer({ min: 1, max: 6 }) })
    fc.assert(
      fc.property(fc.array(one, { maxLength: 20 }), fc.constantFrom('activity', 'created'), (specs, by) => {
        const posts = specs.map((s, i) => post(`p${i}`, s.activity, s.created, { pinned: s.pinned }))
        const out = sortPosts(posts, by)
        expect(ids(out).sort()).toEqual(ids(posts).sort())
        const key = (p) => Date.parse(by === 'activity' ? p.lastActivityAt : p.createdAt)
        for (let i = 1; i < out.length; i++) {
          const a = out[i - 1]
          const b = out[i]
          expect(Number(a.pinned) >= Number(b.pinned)).toBe(true)
          if (a.pinned === b.pinned) {
            expect(key(a) >= key(b)).toBe(true)
            if (key(a) === key(b)) expect(posts.indexOf(a) < posts.indexOf(b)).toBe(true)
          }
        }
      }),
    )
  })
})

describe('repliesText', () => {
  it.each([
    [0, '0 replies'],
    [1, '1 reply'],
    [2, '2 replies'],
    [999, '999 replies'],
    [1000, '1,000 replies'],
    [7931, '7,931 replies'],
    [1234567, '1,234,567 replies'],
    [Number.MAX_SAFE_INTEGER, '9,007,199,254,740,991 replies'],
  ])('writes %i as "%s"', (n, text) => {
    expect(repliesText(n)).toBe(text)
  })

  it('writes nothing for what is no count', () => {
    for (const bad of ['3', '', null, undefined, NaN, Infinity, -Infinity, -1, 1.5, 2 ** 53, {}, [], [3], true, 3n]) {
      expect(repliesText(bad), String(bad)).toBe('')
    }
  })
})

describe('sizeText', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1048575, '1024.0 KB'],
    [1048576, '1.0 MB'],
    [5 * 1048576, '5.0 MB'],
    [26214400, '25.0 MB'],
    [1073741823, '1024.0 MB'],
    [1073741824, '1.0 GB'],
    [5 * 1073741824, '5.0 GB'],
    [1024 * 1073741824, '1024.0 GB'],
    [2 ** 50, '1048576.0 GB'],
  ])('writes %i bytes as "%s"', (bytes, text) => {
    expect(sizeText(bytes)).toBe(text)
  })

  it('writes nothing for what is no size', () => {
    for (const bad of ['5', '', null, undefined, NaN, Infinity, -Infinity, -1, 1.5, 0.5, 2 ** 53, {}, [], [5], true, 5n]) {
      expect(sizeText(bad), String(bad)).toBe('')
    }
  })

  it('counts in 1024s with one decimal, whatever the size', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 40 }), (bytes) => {
        const text = sizeText(bytes)
        if (bytes < 1024) expect(text).toBe(`${bytes} B`)
        else if (bytes < 1024 ** 2) expect(text).toBe(`${(bytes / 1024).toFixed(1)} KB`)
        else if (bytes < 1024 ** 3) expect(text).toBe(`${(bytes / 1024 ** 2).toFixed(1)} MB`)
        else expect(text).toBe(`${(bytes / 1024 ** 3).toFixed(1)} GB`)
      }),
    )
  })
})

describe('groupMessages with its own way to tell an article', () => {
  it('asks it once for each message, in order, with that message alone, and uses its answers', () => {
    const input = [message(1), message(2, { createdAt: at(MIN) }), message(3, { createdAt: at(2 * MIN) })]
    const asked = []
    const out = groupMessages(input, (...args) => {
      asked.push(args)
      return args[0].id === ID(2)
    })
    expect(asked).toEqual(input.map((m) => [m]))
    // The second is an article, so the third does not sit under it, and it does not sit under the first.
    expect(out.map((x) => x.grouped)).toEqual([false, false, false])
  })

  it('takes the article\'s answer as the one that counts, not the message\'s own words', () => {
    const input = [message(1, { content: '# Heading' }), message(2, { createdAt: at(MIN) })]
    expect(groupMessages(input, () => false).map((x) => x.grouped)).toEqual([false, true])
    expect(groupMessages([message(1), message(2, { createdAt: at(MIN) })], () => true).map((x) => x.grouped)).toEqual([false, false])
  })

  it('asks nothing for no messages, and refuses a list that is no list or a way that is no function', () => {
    let asked = 0
    expect(groupMessages([], () => asked++)).toEqual([])
    expect(asked).toBe(0)
    expect(() => groupMessages('abc', () => false)).toThrow(/takes a list of messages/)
    for (const bad of [null, 'yes', 7, {}]) expect(() => groupMessages([message(1)], bad), String(bad)).toThrow(TypeError)
  })

  it('works as it did when no way is given', () => {
    const input = [message(1, { content: '# H' }), message(2, { createdAt: at(MIN) }), message(3, { createdAt: at(2 * MIN) })]
    expect(groupMessages(input).map((x) => x.grouped)).toEqual(groupMessages(input, article).map((x) => x.grouped))
  })
})

describe('articleMemo', () => {
  /** A message that counts how many times its content is read, which is how many times someone looks at its words. */
  const counted = (n, content, over = {}) => {
    const reads = { n: 0 }
    const m = message(n, over)
    Object.defineProperty(m, 'content', {
      get() {
        reads.n++
        return content
      },
    })
    return { m, reads }
  }

  it('answers as isArticle does, for every kind of message', () => {
    const answer = articleMemo()
    const cases = [
      message(1),
      message(2, { content: '## Heading' }),
      message(3, { content: 'x'.repeat(600) }),
      message(4, { content: 'x'.repeat(599) }),
      message(5, { attachments: [image(1), image(2)] }),
      message(6, { attachments: [image(1), video(2)] }),
    ]
    expect(cases.map((m) => answer(m))).toEqual(cases.map(article))
  })

  it('looks at a message\'s words once, however many times it is asked', () => {
    const answer = articleMemo()
    const { m, reads } = counted(1, '## A heading')
    expect(answer(m)).toBe(true)
    const after = reads.n
    expect(after).toBeGreaterThan(0)
    expect(answer(m)).toBe(true)
    expect(answer(m)).toBe(true)
    expect(reads.n).toBe(after)
  })

  it('keeps the answer false too: a plain message is not looked at twice', () => {
    const answer = articleMemo()
    const { m, reads } = counted(1, 'plain words')
    expect(answer(m)).toBe(false)
    const after = reads.n
    expect(answer(m)).toBe(false)
    expect(reads.n).toBe(after)
  })

  it('tells one message from another by the object, not by its id: an edit is a new object', () => {
    const answer = articleMemo()
    expect(answer(message(1, { content: 'plain' }))).toBe(false)
    expect(answer(message(1, { content: '# now a heading' }))).toBe(true)
  })

  it('keeps nothing between two memos', () => {
    const m = message(1)
    const first = articleMemo()
    const second = articleMemo()
    first(m)
    const { m: other, reads } = counted(2, 'plain')
    second(other)
    expect(reads.n).toBeGreaterThan(0)
    const seen = reads.n
    first(other)
    expect(reads.n).toBeGreaterThan(seen)
  })

  it('refuses what is no message, as isArticle does, and keeps no answer for it', () => {
    const answer = articleMemo()
    for (const bad of [null, undefined, 'abc', 7, {}, { content: 5, attachments: [] }, { content: 'x', attachments: null }]) {
      expect(() => answer(bad), String(bad)).toThrow(TypeError)
    }
    const m = { content: 5, attachments: [] }
    expect(() => answer(m)).toThrow(TypeError)
    m.content = '# fixed'
    expect(answer(m)).toBe(true)
  })

  it('groups a list through it the same as without, and parses a list that comes again only for what is new', () => {
    const answer = articleMemo()
    const held = Array.from({ length: 8 }, (_, i) => counted(i + 1, i % 3 === 0 ? '# heading' : 'plain', { createdAt: at(i * MIN) }))
    const first = groupMessages(held.map((h) => h.m), answer)
    const reads = held.map((h) => h.reads.n)
    const fresh = counted(9, 'new words', { createdAt: at(9 * MIN) })
    const second = groupMessages([...held.map((h) => h.m), fresh.m], answer)
    expect(held.map((h) => h.reads.n)).toEqual(reads)
    expect(second.slice(0, 8).map((x) => x.grouped)).toEqual(first.map((x) => x.grouped))
    expect(fresh.reads.n).toBeGreaterThan(0)
    expect(groupMessages(held.map((h) => h.m)).map((x) => x.grouped)).toEqual(first.map((x) => x.grouped))
  })
})

describe('samePeople', () => {
  const person = (name, avatar = null) => ({ name, avatar })

  it('is true for a table and itself, and for two with the same people', () => {
    const a = { [ID(1)]: person('Tor', 'https://cdn.discordapp.com/avatars/1/a.png'), [ID(2)]: person('Ixen') }
    expect(samePeople(a, a)).toBe(true)
    expect(samePeople(a, { [ID(2)]: person('Ixen'), [ID(1)]: person('Tor', 'https://cdn.discordapp.com/avatars/1/a.png') })).toBe(true)
    expect(samePeople({}, {})).toBe(true)
  })

  it('is false when a name, an avatar or a person differs, or one has a person the other has not', () => {
    const a = { [ID(1)]: person('Tor') }
    expect(samePeople(a, { [ID(1)]: person('Tor B') })).toBe(false)
    expect(samePeople(a, { [ID(1)]: person('Tor', 'https://cdn.discordapp.com/avatars/1/a.png') })).toBe(false)
    expect(samePeople(a, { [ID(2)]: person('Tor') })).toBe(false)
    expect(samePeople(a, { ...a, [ID(2)]: person('Ixen') })).toBe(false)
    expect(samePeople({ ...a, [ID(2)]: person('Ixen') }, a)).toBe(false)
    expect(samePeople(a, {})).toBe(false)
    expect(samePeople({}, a)).toBe(false)
  })

  it('compares each person\'s name and avatar as written, so a name that only looks alike is another', () => {
    expect(samePeople({ [ID(1)]: person('1') }, { [ID(1)]: person(1) })).toBe(false)
    expect(samePeople({ [ID(1)]: person('Tor', null) }, { [ID(1)]: { name: 'Tor', avatar: undefined } })).toBe(false)
    expect(samePeople({ [ID(1)]: person('Tor', null) }, { [ID(1)]: { name: 'Tor' } })).toBe(false)
  })

  it('treats a key that is a name on Object.prototype as any other, and __proto__ as a key', () => {
    const a = JSON.parse('{"__proto__":{"name":"A","avatar":null},"constructor":{"name":"B","avatar":null}}')
    const b = JSON.parse('{"constructor":{"name":"B","avatar":null},"__proto__":{"name":"A","avatar":null}}')
    expect(samePeople(a, b)).toBe(true)
    expect(samePeople(a, JSON.parse('{"__proto__":{"name":"X","avatar":null},"constructor":{"name":"B","avatar":null}}'))).toBe(false)
    expect(samePeople({ toString: person('T') }, {})).toBe(false)
    expect(samePeople({}, { toString: person('T') })).toBe(false)
    // An answer that has no person of that name does not borrow one from the prototype.
    expect(samePeople({ a: person('A') }, { b: person('A') })).toBe(false)
  })

  it('is false for what is no table, unless it is the very same thing', () => {
    expect(samePeople(null, null)).toBe(true)
    expect(samePeople(undefined, undefined)).toBe(true)
    for (const bad of [null, undefined, 'abc', 7, [], [person('x')]]) {
      expect(samePeople(bad, {}), String(bad)).toBe(false)
      expect(samePeople({}, bad), String(bad)).toBe(false)
    }
    const list = []
    expect(samePeople(list, list)).toBe(true)
  })

  it('is false for a person that is no table, and true for the very same thing in both', () => {
    const odd = 'x'
    expect(samePeople({ [ID(1)]: odd }, { [ID(1)]: odd })).toBe(true)
    expect(samePeople({ [ID(1)]: 'x' }, { [ID(1)]: 'y' })).toBe(false)
    expect(samePeople({ [ID(1)]: null }, { [ID(1)]: person('Tor') })).toBe(false)
    expect(samePeople({ [ID(1)]: person('Tor') }, { [ID(1)]: null })).toBe(false)
    expect(samePeople({ [ID(1)]: null }, { [ID(1)]: null })).toBe(true)
  })

  it('agrees with a deep comparison of the two, for any two tables (property)', () => {
    const entry = fc.record({ name: fc.constantFrom('Tor', 'Ixen', 'Mara'), avatar: fc.constantFrom(null, 'a', 'b') })
    const table = fc.dictionary(fc.constantFrom('1', '2', '3', 'a', 'b'), entry)
    fc.assert(
      fc.property(table, table, (a, b) => {
        const sorted = (t) => JSON.stringify(Object.entries(t).sort(([x], [y]) => (x < y ? -1 : 1)))
        expect(samePeople(a, b)).toBe(sorted(a) === sorted(b))
        expect(samePeople(a, { ...a })).toBe(true)
        expect(samePeople(a, b)).toBe(samePeople(b, a))
      }),
    )
  })
})

describe('isRead', () => {
  const viewport = { top: 72, bottom: 872 }
  /** What an IntersectionObserver says: a message at [top, bottom] on a viewport that begins under the site's header. */
  const seen = (top, bottom, over = {}) => {
    const visible = Math.max(0, Math.min(bottom, viewport.bottom) - Math.max(top, viewport.top))
    return {
      isIntersecting: visible > 0 || (bottom >= viewport.top && top <= viewport.bottom),
      intersectionRatio: bottom === top ? 0 : visible / (bottom - top),
      boundingClientRect: { top, bottom },
      rootBounds: viewport,
      ...over,
    }
  }

  it('counts a message that is wholly in view', () => {
    expect(isRead(seen(200, 400))).toBe(true)
  })

  it('counts a message at least 60% of which is in view, at 60% exactly and not at less', () => {
    // 100 high, 60 of it in view at the bottom of the viewport, and 59 of it.
    expect(isRead(seen(812, 912))).toBe(true)
    expect(isRead(seen(813, 913))).toBe(false)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.6, boundingClientRect: { top: 0, bottom: 5000 }, rootBounds: viewport })).toBe(true)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.5999, boundingClientRect: { top: 0, bottom: 5000 }, rootBounds: viewport })).toBe(false)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.7, boundingClientRect: { top: 800, bottom: 5000 }, rootBounds: viewport })).toBe(true)
  })

  it('counts a message whose bottom edge is in view though less than 60% of it is: a long one read to its end', () => {
    // 3000 high, the last 800 of it in view.
    const e = seen(-2128, 872)
    expect(e.intersectionRatio).toBeLessThan(0.6)
    expect(isRead(e)).toBe(true)
    expect(isRead(seen(-2128, 500))).toBe(true)
    expect(isRead(seen(-2128, 73))).toBe(true)
  })

  it('does not count a long message that has only just come into view at the top of it', () => {
    const e = seen(700, 3700)
    expect(e.intersectionRatio).toBeLessThan(0.6)
    expect(isRead(e)).toBe(false)
  })

  it('counts a bottom edge exactly at the foot of the viewport, and not one exactly at its top (or above)', () => {
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.1, boundingClientRect: { top: -3000, bottom: 872 }, rootBounds: viewport })).toBe(true)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.1, boundingClientRect: { top: -3000, bottom: 873 }, rootBounds: viewport })).toBe(false)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0, boundingClientRect: { top: -3000, bottom: 72 }, rootBounds: viewport })).toBe(false)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0, boundingClientRect: { top: -3000, bottom: 73 }, rootBounds: viewport })).toBe(true)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0, boundingClientRect: { top: -3000, bottom: 10 }, rootBounds: viewport })).toBe(false)
  })

  it('counts nothing that is not intersecting, however its numbers read', () => {
    expect(isRead({ ...seen(200, 400), isIntersecting: false })).toBe(false)
    expect(isRead({ ...seen(200, 400), isIntersecting: undefined })).toBe(false)
    expect(isRead({ ...seen(200, 400), isIntersecting: 'true' })).toBe(false)
    expect(isRead({ ...seen(200, 400), isIntersecting: 1 })).toBe(false)
  })

  it('judges by the ratio alone when the viewport is not known (no root bounds)', () => {
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.9, boundingClientRect: { top: 0, bottom: 10 }, rootBounds: null })).toBe(true)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.2, boundingClientRect: { top: 0, bottom: 10 }, rootBounds: null })).toBe(false)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.2, boundingClientRect: { top: 0, bottom: 10 } })).toBe(false)
  })

  it('counts nothing for numbers that are no numbers, and does not fall over for entries that are not entries', () => {
    const base = { isIntersecting: true, intersectionRatio: 0.1, boundingClientRect: { top: 0, bottom: 500 }, rootBounds: viewport }
    for (const bad of [NaN, Infinity, -Infinity, '500', null, undefined, {}, [500]]) {
      expect(isRead({ ...base, boundingClientRect: { top: 0, bottom: bad } }), String(bad)).toBe(false)
      expect(isRead({ ...base, rootBounds: { top: bad, bottom: 872 } }), String(bad)).toBe(false)
      expect(isRead({ ...base, rootBounds: { top: 72, bottom: bad } }), String(bad)).toBe(false)
    }
    for (const bad of ['0.9', null, undefined, NaN, {}, [0.9], true]) {
      expect(isRead({ isIntersecting: true, intersectionRatio: bad, boundingClientRect: { top: 0, bottom: 5000 }, rootBounds: viewport }), String(bad)).toBe(false)
    }
    for (const bad of [null, undefined, 'abc', 7, [], {}, () => {}]) expect(isRead(bad), String(bad)).toBe(false)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.1 })).toBe(false)
    expect(isRead({ isIntersecting: true, intersectionRatio: 0.1, boundingClientRect: null, rootBounds: viewport })).toBe(false)
  })

  it('agrees with the rule, for any message and viewport (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: 1, max: 6000 }), fc.integer({ min: 0, max: 400 }), fc.integer({ min: 100, max: 2000 }), (top, height, rootTop, rootHeight) => {
        const bottom = top + height
        const root = { top: rootTop, bottom: rootTop + rootHeight }
        const visible = Math.max(0, Math.min(bottom, root.bottom) - Math.max(top, root.top))
        const intersecting = bottom >= root.top && top <= root.bottom
        const entry = { isIntersecting: intersecting, intersectionRatio: visible / height, boundingClientRect: { top, bottom }, rootBounds: root }
        const expected = intersecting && (visible / height >= 0.6 || (bottom > root.top && bottom <= root.bottom))
        expect(isRead(entry)).toBe(expected)
      }),
    )
  })
})
