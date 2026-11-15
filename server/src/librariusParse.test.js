import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  MESSAGE_KINDS,
  applyReaction,
  emojiKey,
  linkExpiry,
  parseEmoji,
  parseMessage,
  parseThread,
  snowflakeTime,
} from './librariusParse.js'

// Invented ids, all in the 400-499 range. None of them is a real channel, member or message.
const FORUM = '200000000000000401'
const THREAD = '200000000000000410'
const OWNER = '200000000000000411'
const AUTHOR = '200000000000000412'
const HOOK = '200000000000000413'
const TAG_A = '200000000000000420'
const TAG_B = '200000000000000421'
const MSG = '200000000000000430'
const PARENT_MSG = '200000000000000431'
const ATT = '200000000000000440'
const ATT_2 = '200000000000000441'
const STICKER = '200000000000000450'
const EMOJI = '200000000000000460'

const AVATAR_HASH = '0123456789abcdef0123456789abcdef'
const ATT_URL = `https://cdn.discordapp.com/attachments/${THREAD}/${ATT}/map.png?ex=6540a0b3&is=653e2bb3&hm=0a1b2c`
const ATT_PROXY = `https://media.discordapp.net/attachments/${THREAD}/${ATT}/map.png?ex=6540a0b3&width=640&height=480`
const ATT_EXPIRES = '2023-10-31T06:37:39.000Z' // 0x6540a0b3 seconds
const PROXY_IMG = 'https://images-ext-1.discordapp.net/external/AbC123/https/example.test/pic.png'
const CREATED = '2026-11-02T18:30:00.123000+00:00'

const FFFD = String.fromCharCode(0xfffd) // the replacement character
const NUL = String.fromCharCode(0)
const LONE_HIGH = String.fromCharCode(0xd83d)
const LONE_LOW = String.fromCharCode(0xde00)
const FIRE = '\u{1F525}' // two UTF-16 units

const thread = (over = {}) => ({
  id: THREAD,
  parent_id: FORUM,
  owner_id: OWNER,
  name: 'A test post',
  applied_tags: [TAG_A, TAG_B],
  flags: 0,
  thread_metadata: {
    archived: false,
    locked: false,
    create_timestamp: '2026-11-01T10:00:00.123000+00:00',
    archive_timestamp: '2026-11-02T10:00:00.000000+00:00',
  },
  ...over,
})

const message = (over = {}) => ({
  id: MSG,
  channel_id: THREAD,
  type: 0,
  author: { id: AUTHOR, username: 'brother_test', global_name: 'Brother Test', avatar: AVATAR_HASH },
  content: 'Hello, brothers.',
  timestamp: CREATED,
  edited_timestamp: null,
  attachments: [],
  embeds: [],
  sticker_items: [],
  reactions: [],
  ...over,
})

const attachment = (over = {}) => ({
  id: ATT,
  filename: 'map.png',
  size: 2048,
  url: ATT_URL,
  proxy_url: ATT_PROXY,
  content_type: 'image/png',
  width: 640,
  height: 480,
  ...over,
})

const embed = (over = {}) => ({
  type: 'article',
  url: 'https://example.test/post',
  title: 'A title',
  description: 'A description',
  provider: { name: 'Example' },
  thumbnail: { url: 'https://example.test/t.png', proxy_url: PROXY_IMG, width: 100, height: 50 },
  image: { url: 'https://example.test/i.png', proxy_url: PROXY_IMG, width: 400, height: 200 },
  ...over,
})

const reaction = (over = {}) => ({ count: 3, me: false, emoji: { id: null, name: FIRE }, ...over })

/** Every string anywhere in a value. */
const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out)
  return out
}

describe('MESSAGE_KINDS', () => {
  it('holds default, reply, slash-command and context-command results and nothing else', () => {
    expect([...MESSAGE_KINDS].sort((a, b) => a - b)).toEqual([0, 19, 20, 23])
    const members = []
    for (let k = -2; k <= 60; k++) if (MESSAGE_KINDS.has(k)) members.push(k)
    expect(members).toEqual([0, 19, 20, 23])
  })
})

describe('snowflakeTime', () => {
  it('reads the time out of a snowflake', () => {
    // Made up from a chosen time: the milliseconds since 2015-01-01 shifted left 22 bits, with the low 22 bits
    // (worker, process and counter) first all clear, then all set, then one millisecond on.
    expect(snowflakeTime('661720242585600000').toISOString()).toBe('2020-01-01T00:00:00.000Z')
    expect(snowflakeTime('661720242589794303').toISOString()).toBe('2020-01-01T00:00:00.000Z')
    expect(snowflakeTime('661720242589794304').toISOString()).toBe('2020-01-01T00:00:00.001Z')
    expect(snowflakeTime(THREAD).toISOString()).toBe('2016-07-05T21:28:35.820Z')
    expect(snowflakeTime(THREAD)).toBeInstanceOf(Date)
  })

  it('takes the shortest and the longest snowflake there is', () => {
    expect(snowflakeTime('10000000000000000').toISOString()).toBe('2015-01-28T14:16:25.791Z')
    expect(snowflakeTime('99999999999999999999').toISOString()).toBe('2770-07-09T10:18:30.156Z')
  })

  it.each([
    ['an empty string', ''],
    ['16 digits', '1234567890123456'],
    ['21 digits', '123456789012345678901'],
    ['letters', 'abcdefghijklmnopqr'],
    ['a trailing letter', '20000000000000041x'],
    ['a leading space', ' 200000000000000410'],
    ['a trailing newline', '200000000000000410\n'],
    ['a sign', '+200000000000000410'],
    ['a decimal point', '20000000000000041.0'],
    ['full-width digits', '２００００００００００００００４１０'],
    ['a number', 200000000000000410],
    ['a bigint', 200000000000000410n],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['a String object', new String('200000000000000410')],
    ['an array holding one', ['200000000000000410']],
  ])('refuses %s', (_, id) => {
    expect(() => snowflakeTime(id)).toThrow(TypeError)
    expect(() => snowflakeTime(id)).toThrow(/snowflake/)
  })

  it('answers a real, ordered time for every snowflake', () => {
    const snowflake = fc.bigInt({ min: 10n ** 16n, max: 10n ** 20n - 1n }).map(String)
    fc.assert(
      fc.property(snowflake, snowflake, (a, b) => {
        const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a]
        const t = snowflakeTime(lo).getTime()
        expect(Number.isNaN(t)).toBe(false)
        expect(t).toBeGreaterThanOrEqual(1420070400000)
        expect(t).toBeLessThanOrEqual(snowflakeTime(hi).getTime())
      }),
    )
  })
})

describe('linkExpiry', () => {
  it('reads the ex parameter, hex seconds, as an ISO time', () => {
    expect(linkExpiry(ATT_URL)).toBe(ATT_EXPIRES)
    expect(linkExpiry('https://cdn.discordapp.com/attachments/1/2/a.png?ex=0')).toBe('1970-01-01T00:00:00.000Z')
  })

  it('finds ex wherever it sits in the query, in either case of hex', () => {
    const base = 'https://cdn.discordapp.com/attachments/1/2/a.png'
    expect(linkExpiry(`${base}?ex=6540a0b3`)).toBe(ATT_EXPIRES)
    expect(linkExpiry(`${base}?is=1&ex=6540a0b3`)).toBe(ATT_EXPIRES)
    expect(linkExpiry(`${base}?is=1&ex=6540a0b3&hm=2`)).toBe(ATT_EXPIRES)
    expect(linkExpiry(`${base}?ex=6540A0B3&`)).toBe(ATT_EXPIRES)
  })

  it('answers the first ex when there are two, and null when that first one is unusable', () => {
    const base = 'https://cdn.discordapp.com/attachments/1/2/a.png'
    expect(linkExpiry(`${base}?ex=6540a0b3&ex=0`)).toBe(ATT_EXPIRES)
    expect(linkExpiry(`${base}?ex=zz&ex=6540a0b3`)).toBeNull()
  })

  it('stops at the top of what an ISO year of four digits can hold', () => {
    const base = 'https://cdn.discordapp.com/attachments/1/2/a.png'
    expect(linkExpiry(`${base}?ex=3afff4417f`)).toBe('9999-12-31T23:59:59.000Z')
    expect(linkExpiry(`${base}?ex=3afff44180`)).toBeNull()
    expect(linkExpiry(`${base}?ex=${'f'.repeat(400)}`)).toBeNull()
  })

  it.each([
    ['no query', 'https://cdn.discordapp.com/attachments/1/2/a.png'],
    ['a query without ex', 'https://cdn.discordapp.com/attachments/1/2/a.png?is=6540a0b3&hm=ab'],
    ['an empty ex', 'https://cdn.discordapp.com/a.png?ex='],
    ['a bare ex', 'https://cdn.discordapp.com/a.png?ex'],
    ['an ex that is not hex', 'https://cdn.discordapp.com/a.png?ex=zz'],
    ['an ex with a hex prefix', 'https://cdn.discordapp.com/a.png?ex=0x6540a0b3'],
    ['an ex with a trailing letter', 'https://cdn.discordapp.com/a.png?ex=6540a0b3g'],
    ['an ex with a space in it', 'https://cdn.discordapp.com/a.png?ex=6540%20a0b3'],
    ['an ex with a minus sign', 'https://cdn.discordapp.com/a.png?ex=-6540a0b3'],
    ['an ex with a decimal point', 'https://cdn.discordapp.com/a.png?ex=65.40'],
    ['an ex that is percent-encoded', 'https://cdn.discordapp.com/a.png?ex=%36540a0b3'],
    ['a parameter that merely ends in ex', 'https://cdn.discordapp.com/a.png?hex=6540a0b3'],
    ['a parameter that merely starts with ex', 'https://cdn.discordapp.com/a.png?ex2=6540a0b3'],
    ['ex only in the fragment', 'https://cdn.discordapp.com/a.png#a&ex=6540a0b3'],
    ['ex only in the path', 'https://cdn.discordapp.com/ex=6540a0b3/a.png'],
    ['a relative link', '/attachments/1/2/a.png?ex=6540a0b3'],
    ['a bare query', '?ex=6540a0b3'],
    ['not a url', 'not a url'],
    ['an empty string', ''],
  ])('is null for %s', (_, url) => {
    expect(linkExpiry(url)).toBeNull()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 6540],
    ['an array', ['https://cdn.discordapp.com/a.png?ex=6540a0b3']],
    ['an object that prints as a link', { toString: () => 'https://cdn.discordapp.com/a.png?ex=6540a0b3' }],
    ['a URL object', new URL('https://cdn.discordapp.com/a.png?ex=6540a0b3')],
  ])('does not read %s', (_, url) => {
    expect(linkExpiry(url)).toBeNull()
  })

  it('never throws, and anything it answers is an ISO time', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const out = linkExpiry(v)
        expect(out === null || /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(out)).toBe(true)
      }),
    )
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(() => linkExpiry(`https://cdn.discordapp.com/a.png?${s}`)).not.toThrow()
      }),
    )
  })

  it('round-trips any second a four-digit year can hold', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 253402300799 }), (sec) => {
        const out = linkExpiry(`https://cdn.discordapp.com/a.png?is=1&ex=${sec.toString(16)}`)
        expect(Date.parse(out)).toBe(sec * 1000)
      }),
    )
  })
})

describe('parseThread', () => {
  it('reads a forum post into its row', () => {
    expect(parseThread(thread(), FORUM)).toEqual({
      id: THREAD,
      ownerId: OWNER,
      title: 'A test post',
      tagIds: [TAG_A, TAG_B],
      pinned: false,
      locked: false,
      archived: false,
      createdAt: '2026-11-01T10:00:00.123000+00:00',
    })
  })

  it('gives exactly the documented fields, and nothing JSON would drop', () => {
    const row = parseThread(thread(), FORUM)
    expect(Object.keys(row).sort()).toEqual(
      ['archived', 'createdAt', 'id', 'locked', 'ownerId', 'pinned', 'tagIds', 'title'].sort(),
    )
    expect(JSON.parse(JSON.stringify(row))).toStrictEqual(row)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['a string', THREAD],
    ['true', true],
    ['an array', [thread()]],
  ])('is null for %s', (_, raw) => {
    expect(parseThread(raw, FORUM)).toBeNull()
  })

  it('is null unless the thread sits under the forum asked for', () => {
    expect(parseThread(thread({ parent_id: '200000000000000402' }), FORUM)).toBeNull()
    expect(parseThread(thread({ parent_id: undefined }), FORUM)).toBeNull()
    expect(parseThread(thread({ parent_id: null }), FORUM)).toBeNull()
    expect(parseThread(thread({ parent_id: Number(FORUM) }), FORUM)).toBeNull()
    expect(parseThread(thread({ parent_id: `${FORUM} ` }), FORUM)).toBeNull()
    expect(parseThread(thread({ parent_id: FORUM }), '200000000000000402')).toBeNull()
  })

  it('is null when the forum id it is given is no snowflake, even if the thread says the same', () => {
    const bad = [undefined, null, '', 'abc', 0, 401, '1234', 200000000000000401n, {}]
    for (const forumId of bad) {
      expect(parseThread(thread({ parent_id: forumId }), forumId), String(forumId)).toBeNull()
    }
    const { parent_id: _gone, ...noParent } = thread()
    expect(parseThread(noParent, undefined)).toBeNull()
  })

  it('is null unless the thread has a snowflake id', () => {
    for (const id of [undefined, null, '', 'abc', THREAD.slice(2), `${THREAD}0000`, Number(THREAD), 410, ` ${THREAD}`]) {
      expect(parseThread(thread({ id }), FORUM), String(id)).toBeNull()
    }
  })

  it('takes a snowflake of 17 to 20 digits, and no other length', () => {
    const at = (digits) => parseThread(thread({ id: '3'.repeat(digits), owner_id: '4'.repeat(digits) }), FORUM)
    expect(at(16)).toBeNull()
    expect(at(17)).toMatchObject({ id: '3'.repeat(17), ownerId: '4'.repeat(17) })
    expect(at(18)).toMatchObject({ id: '3'.repeat(18), ownerId: '4'.repeat(18) })
    expect(at(20)).toMatchObject({ id: '3'.repeat(20), ownerId: '4'.repeat(20) })
    expect(at(21)).toBeNull()
    const owner = (digits) => parseThread(thread({ owner_id: '4'.repeat(digits) }), FORUM).ownerId
    expect(owner(16)).toBeNull()
    expect(owner(21)).toBeNull()
  })

  it('keeps owner_id only when it is a snowflake', () => {
    expect(parseThread(thread({ owner_id: undefined }), FORUM).ownerId).toBeNull()
    expect(parseThread(thread({ owner_id: null }), FORUM).ownerId).toBeNull()
    expect(parseThread(thread({ owner_id: 'abc' }), FORUM).ownerId).toBeNull()
    expect(parseThread(thread({ owner_id: Number(OWNER) }), FORUM).ownerId).toBeNull()
  })

  it('cuts the title to 100 characters and no further', () => {
    expect(parseThread(thread({ name: 'a'.repeat(99) }), FORUM).title).toBe('a'.repeat(99))
    expect(parseThread(thread({ name: 'a'.repeat(100) }), FORUM).title).toBe('a'.repeat(100))
    expect(parseThread(thread({ name: 'a'.repeat(101) }), FORUM).title).toBe('a'.repeat(100))
    expect(parseThread(thread({ name: 'a'.repeat(5000) }), FORUM).title).toBe('a'.repeat(100))
  })

  it('leaves the title a string Postgres can store', () => {
    const title = (name) => parseThread(thread({ name }), FORUM).title
    // A cut never leaves half of an emoji.
    expect(title('a'.repeat(99) + FIRE + 'b')).toBe('a'.repeat(99))
    expect(title('a'.repeat(98) + FIRE + 'b')).toBe('a'.repeat(98) + FIRE)
    expect(title(FIRE.repeat(60))).toBe(FIRE.repeat(50))
    // U+0000 goes, and a lone surrogate becomes U+FFFD.
    expect(title(`a${NUL}b`)).toBe('ab')
    expect(title(`a${LONE_HIGH}b`)).toBe(`a${FFFD}b`)
    expect(title(`a${LONE_LOW}b`)).toBe(`a${FFFD}b`)
    // Taking the NULs out comes before the cut, so they never cost the title any room.
    expect(title(NUL.repeat(50) + 'a'.repeat(100))).toBe('a'.repeat(100))
    expect(title(FIRE)).toBe(FIRE)
  })

  it('has an empty title when the name is no string', () => {
    for (const name of [undefined, null, 5, {}, ['a'], true]) {
      expect(parseThread(thread({ name }), FORUM).title, String(name)).toBe('')
    }
  })

  it('keeps tag ids that are snowflakes, in order, at most five', () => {
    const ids = (n) => Array.from({ length: n }, (_, i) => `2000000000000005${String(i).padStart(2, '0')}`)
    expect(parseThread(thread({ applied_tags: ids(5) }), FORUM).tagIds).toEqual(ids(5))
    expect(parseThread(thread({ applied_tags: ids(4) }), FORUM).tagIds).toEqual(ids(4))
    expect(parseThread(thread({ applied_tags: ids(7) }), FORUM).tagIds).toEqual(ids(5))
    expect(parseThread(thread({ applied_tags: [] }), FORUM).tagIds).toEqual([])
  })

  it('drops bad tag ids before it counts to five', () => {
    const good = ['200000000000000500', '200000000000000501', '200000000000000502', '200000000000000503', '200000000000000504', '200000000000000505']
    const bad = [null, undefined, '', 'abc', 7, 200000000000000500, '1234', `${good[0]}x`, {}, [good[0]], true]
    expect(parseThread(thread({ applied_tags: [...bad, ...good] }), FORUM).tagIds).toEqual(good.slice(0, 5))
    expect(parseThread(thread({ applied_tags: [good[0], ...bad, good[1]] }), FORUM).tagIds).toEqual([good[0], good[1]])
  })

  it('has no tags when applied_tags is no list', () => {
    for (const applied_tags of [undefined, null, 'abc', TAG_A, 5, { 0: TAG_A, length: 1 }]) {
      expect(parseThread(thread({ applied_tags }), FORUM).tagIds, String(applied_tags)).toEqual([])
    }
  })

  it('is pinned exactly when the PINNED flag, bit 2, is set', () => {
    const pinned = (flags) => parseThread(thread({ flags }), FORUM).pinned
    for (const flags of [2, 3, 6, 7, 18, 1 << 20 | 2]) expect(pinned(flags), String(flags)).toBe(true)
    for (const flags of [0, 1, 4, 5, 16, 1 << 20]) expect(pinned(flags), String(flags)).toBe(false)
  })

  it('is not pinned when flags is anything but a whole number', () => {
    const pinned = (flags) => parseThread(thread({ flags }), FORUM).pinned
    for (const flags of ['2', '3', 2.5, 3.5, 2n, true, null, undefined, NaN, Infinity, [2], { valueOf: () => 2 }]) {
      expect(pinned(flags), String(flags)).toBe(false)
    }
    const { flags: _gone, ...noFlags } = thread()
    expect(parseThread(noFlags, FORUM).pinned).toBe(false)
  })

  it('reads locked and archived from thread_metadata, true only when exactly true', () => {
    const meta = (over) => thread({ thread_metadata: { create_timestamp: CREATED, ...over } })
    expect(parseThread(meta({ locked: true, archived: false }), FORUM)).toMatchObject({ locked: true, archived: false })
    expect(parseThread(meta({ locked: false, archived: true }), FORUM)).toMatchObject({ locked: false, archived: true })
    expect(parseThread(meta({ locked: true, archived: true }), FORUM)).toMatchObject({ locked: true, archived: true })
    for (const v of ['true', 1, 'yes', {}, [true], null, undefined]) {
      expect(parseThread(meta({ locked: v, archived: v }), FORUM), String(v)).toMatchObject({ locked: false, archived: false })
    }
  })

  it('survives thread_metadata that is missing or is no object', () => {
    for (const thread_metadata of [undefined, null, 'x', 5, true, []]) {
      const row = parseThread(thread({ thread_metadata }), FORUM)
      expect(row, String(thread_metadata)).toMatchObject({ locked: false, archived: false, createdAt: '2016-07-05T21:28:35.820Z' })
    }
  })

  it('takes createdAt from create_timestamp, else from the snowflake', () => {
    const at = (create_timestamp) => parseThread(thread({ thread_metadata: { create_timestamp } }), FORUM).createdAt
    expect(at('2026-11-01T10:00:00.123000+00:00')).toBe('2026-11-01T10:00:00.123000+00:00')
    expect(at('2026-11-01T10:00:00Z')).toBe('2026-11-01T10:00:00Z')
    // Threads made before Discord stamped them have null here.
    expect(at(null)).toBe('2016-07-05T21:28:35.820Z')
    expect(at(undefined)).toBe('2016-07-05T21:28:35.820Z')
    expect(at('')).toBe('2016-07-05T21:28:35.820Z')
    expect(at('yesterday')).toBe('2016-07-05T21:28:35.820Z')
    expect(at(1793644200123)).toBe('2016-07-05T21:28:35.820Z')
    expect(at('2026-02-31T10:00:00Z')).toBe('2016-07-05T21:28:35.820Z')
    expect(at({ toString: () => CREATED })).toBe('2016-07-05T21:28:35.820Z')
  })

  it('never throws, and what it answers is a well-formed row', () => {
    const idish = fc.oneof(fc.constant(FORUM), fc.constant(THREAD), fc.stringMatching(/^\d{17,20}$/), fc.anything())
    const raw = fc.oneof(
      fc.anything(),
      fc.record(
        {
          id: idish,
          parent_id: idish,
          owner_id: idish,
          name: fc.oneof(fc.string({ unit: 'binary', maxLength: 300 }), fc.anything()),
          applied_tags: fc.oneof(fc.array(idish, { maxLength: 12 }), fc.anything()),
          flags: fc.oneof(fc.integer(), fc.anything()),
          thread_metadata: fc.oneof(
            fc.record({ locked: fc.anything(), archived: fc.anything(), create_timestamp: fc.anything() }, { requiredKeys: [] }),
            fc.anything(),
          ),
        },
        { requiredKeys: [] },
      ),
    )
    let answered = 0
    fc.assert(
      fc.property(raw, fc.oneof(fc.constant(FORUM), idish), (r, forumId) => {
        const row = parseThread(r, forumId)
        if (row === null) return
        answered++
        expect(r.parent_id).toBe(forumId)
        expect(row.id).toMatch(/^\d{17,20}$/)
        expect(row.ownerId === null || /^\d{17,20}$/.test(row.ownerId)).toBe(true)
        expect(row.title.length).toBeLessThanOrEqual(100)
        expect(row.tagIds.length).toBeLessThanOrEqual(5)
        for (const t of row.tagIds) expect(t).toMatch(/^\d{17,20}$/)
        expect(typeof row.pinned + typeof row.locked + typeof row.archived).toBe('booleanbooleanboolean')
        expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false)
        for (const s of strings(row)) {
          expect(s).not.toContain(NUL)
          expect(s).toBe(s.toWellFormed())
        }
        expect(JSON.parse(JSON.stringify(row))).toStrictEqual(row)
      }),
      { numRuns: 400 },
    )
    // A property that never saw a row proves nothing.
    expect(answered).toBeGreaterThan(0)
  })

  it('answers for every plausible thread, so the property above is not vacuous', () => {
    const idish = fc.stringMatching(/^\d{17,20}$/)
    fc.assert(
      fc.property(idish, idish, fc.string({ unit: 'binary', maxLength: 300 }), (id, forum, name) => {
        const row = parseThread({ id, parent_id: forum, name }, forum)
        expect(row).not.toBeNull()
        expect(row.id).toBe(id)
        expect(row.title.length).toBeLessThanOrEqual(100)
      }),
    )
  })
})

describe('parseMessage', () => {
  const expected = (over = {}) => ({
    id: MSG,
    postId: THREAD,
    authorId: AUTHOR,
    authorName: 'Brother Test',
    authorAvatar: `https://cdn.discordapp.com/avatars/${AUTHOR}/${AVATAR_HASH}.png?size=64`,
    webhookId: null,
    kind: 0,
    content: 'Hello, brothers.',
    embeds: [],
    stickers: [],
    reactions: [],
    replyTo: null,
    createdAt: CREATED,
    editedAt: null,
    attachments: [],
    ...over,
  })

  describe('the plain message', () => {
    it('reads a message into its row', () => {
      expect(parseMessage(message())).toEqual(expected())
    })

    it('gives exactly the documented fields, and nothing JSON would drop', () => {
      const row = parseMessage(message())
      expect(Object.keys(row).sort()).toEqual(Object.keys(expected()).sort())
      expect(JSON.parse(JSON.stringify(row))).toStrictEqual(row)
    })

    it('ignores every field it was not asked for', () => {
      const row = parseMessage(
        message({ pinned: true, mentions: [{ id: OWNER }], tts: true, flags: 4, components: [], poll: { x: 1 }, nonce: 'n' }),
      )
      expect(row).toEqual(expected())
    })

    it('reads a reply, a slash-command result and a context-command result too', () => {
      expect(parseMessage(message({ type: 20 })).kind).toBe(20)
      expect(parseMessage(message({ type: 23 })).kind).toBe(23)
      expect(parseMessage(message({ type: 19, message_reference: { message_id: PARENT_MSG } })).kind).toBe(19)
    })

    it('reads a webhook message and keeps its webhook id', () => {
      const row = parseMessage(
        message({ webhook_id: HOOK, author: { id: HOOK, username: 'Site Reply', avatar: null, bot: true } }),
      )
      expect(row).toEqual(expected({ webhookId: HOOK, authorId: HOOK, authorName: 'Site Reply', authorAvatar: null }))
    })
  })

  describe('what is not stored', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 5],
      ['a string', MSG],
      ['true', true],
      ['an array', [message()]],
    ])('is null for %s', (_, raw) => {
      expect(parseMessage(raw)).toBeNull()
    })

    it('is null for every message type outside the four kept', () => {
      for (let type = -1; type <= 60; type++) {
        if (MESSAGE_KINDS.has(type)) continue
        expect(parseMessage(message({ type })), String(type)).toBeNull()
      }
      for (const type of ['0', '19', null, undefined, NaN, 0.5, 19.5, [0], '', true, {}]) {
        expect(parseMessage(message({ type })), String(type)).toBeNull()
      }
    })

    it('is null with no type at all', () => {
      const { type: _gone, ...noType } = message()
      expect(parseMessage(noType)).toBeNull()
    })

    it('is null without a snowflake id', () => {
      for (const id of [undefined, null, '', 'abc', MSG.slice(2), `${MSG}0000`, Number(MSG), ` ${MSG}`, `${MSG}\n`]) {
        expect(parseMessage(message({ id })), String(id)).toBeNull()
      }
    })

    it('is null without a snowflake channel_id, since a message belongs to a post', () => {
      for (const channel_id of [undefined, null, '', 'abc', THREAD.slice(2), Number(THREAD)]) {
        expect(parseMessage(message({ channel_id })), String(channel_id)).toBeNull()
      }
    })

    it('is null without a usable author', () => {
      const { author: _gone, ...noAuthor } = message()
      expect(parseMessage(noAuthor)).toBeNull()
      for (const author of [null, undefined, 'abc', 5, true, [], [{ id: AUTHOR }], {}, { id: 'abc' }, { id: Number(AUTHOR) }, { id: null }]) {
        expect(parseMessage(message({ author })), String(author)).toBeNull()
      }
    })
  })

  describe('who wrote it', () => {
    const named = (author) => parseMessage(message({ author: { id: AUTHOR, ...author } })).authorName

    it('shows the display name, else the username', () => {
      expect(named({ global_name: 'Brother Test', username: 'brother_test' })).toBe('Brother Test')
      expect(named({ global_name: null, username: 'brother_test' })).toBe('brother_test')
      expect(named({ username: 'brother_test' })).toBe('brother_test')
      expect(named({ global_name: '', username: 'brother_test' })).toBe('brother_test')
      expect(named({ global_name: 'Brother Test' })).toBe('Brother Test')
    })

    it('cuts the name to 80 characters and no further', () => {
      expect(named({ global_name: 'n'.repeat(79) })).toBe('n'.repeat(79))
      expect(named({ global_name: 'n'.repeat(80) })).toBe('n'.repeat(80))
      expect(named({ global_name: 'n'.repeat(81) })).toBe('n'.repeat(80))
      expect(named({ username: 'u'.repeat(81) })).toBe('u'.repeat(80))
      expect(named({ global_name: 'n'.repeat(79) + FIRE })).toBe('n'.repeat(79))
    })

    it('falls back to the author id when no name is usable, so the column is never empty', () => {
      expect(named({})).toBe(AUTHOR)
      expect(named({ global_name: 5, username: {} })).toBe(AUTHOR)
      expect(named({ global_name: NUL, username: NUL })).toBe(AUTHOR)
      expect(named({ global_name: null, username: null })).toBe(AUTHOR)
    })

    it('ignores a display name that is not a string', () => {
      expect(named({ global_name: 5, username: 'brother_test' })).toBe('brother_test')
      expect(named({ global_name: ['x'], username: 'brother_test' })).toBe('brother_test')
    })

    it('keeps the name a string Postgres can store', () => {
      expect(named({ global_name: `a${NUL}b` })).toBe('ab')
      expect(named({ global_name: `a${LONE_HIGH}b` })).toBe(`a${FFFD}b`)
    })

    const avatar = (hash) => parseMessage(message({ author: { id: AUTHOR, username: 'u', avatar: hash } })).authorAvatar
    const url = (hash) => `https://cdn.discordapp.com/avatars/${AUTHOR}/${hash}.png?size=64`

    it('builds the avatar link from a 32-digit hex hash, animated or not', () => {
      expect(avatar(AVATAR_HASH)).toBe(url(AVATAR_HASH))
      expect(avatar(`a_${AVATAR_HASH}`)).toBe(url(`a_${AVATAR_HASH}`))
      expect(avatar('f'.repeat(32))).toBe(url('f'.repeat(32)))
      expect(avatar('0'.repeat(32))).toBe(url('0'.repeat(32)))
    })

    it('has no avatar for anything that is not such a hash', () => {
      const bad = [
        undefined,
        null,
        '',
        5,
        {},
        [AVATAR_HASH],
        AVATAR_HASH.slice(1),
        `${AVATAR_HASH}0`,
        `0${AVATAR_HASH}`,
        `${AVATAR_HASH}\n`,
        `\n${AVATAR_HASH}`,
        AVATAR_HASH.toUpperCase(),
        `g${AVATAR_HASH.slice(1)}`,
        `b_${AVATAR_HASH}`,
        `a_a_${AVATAR_HASH}`,
        `x${AVATAR_HASH}`,
        `${AVATAR_HASH}/../x`,
        `${AVATAR_HASH}.png?x=`,
        { toString: () => AVATAR_HASH },
      ]
      for (const hash of bad) expect(avatar(hash), String(hash)).toBeNull()
    })
  })

  describe('the text', () => {
    it('cuts the content to 4000 characters and no further', () => {
      const content = (s) => parseMessage(message({ content: s })).content
      expect(content('c'.repeat(3999))).toBe('c'.repeat(3999))
      expect(content('c'.repeat(4000))).toBe('c'.repeat(4000))
      expect(content('c'.repeat(4001))).toBe('c'.repeat(4000))
      expect(content('c'.repeat(5000))).toBe('c'.repeat(4000))
      expect(content('c'.repeat(3999) + FIRE)).toBe('c'.repeat(3999))
    })

    it('keeps the content as written, spaces and newlines included', () => {
      expect(parseMessage(message({ content: '  hello\n\n**there**  ' })).content).toBe('  hello\n\n**there**  ')
      expect(parseMessage(message({ content: '' })).content).toBe('')
    })

    it('has empty content when there is none, or it is no string', () => {
      for (const content of [undefined, null, 5, {}, ['a'], true]) {
        expect(parseMessage(message({ content })).content, String(content)).toBe('')
      }
    })

    it('keeps the content a string Postgres can store', () => {
      const content = (s) => parseMessage(message({ content: s })).content
      expect(content(`a${NUL}b`)).toBe('ab')
      expect(content(`a${LONE_HIGH}b${LONE_LOW}c`)).toBe(`a${FFFD}b${FFFD}c`)
      expect(content(FIRE)).toBe(FIRE)
    })
  })

  describe('the times', () => {
    it('keeps the timestamps Discord stamped on it', () => {
      const row = parseMessage(message({ timestamp: '2026-11-02T18:30:00.123000+00:00', edited_timestamp: '2026-11-03T09:00:00.500000+00:00' }))
      expect(row.createdAt).toBe('2026-11-02T18:30:00.123000+00:00')
      expect(row.editedAt).toBe('2026-11-03T09:00:00.500000+00:00')
    })

    it('takes createdAt from the snowflake when the timestamp is missing or unusable', () => {
      for (const timestamp of [undefined, null, '', 'yesterday', 1793644200123, '2026-11-02', '2026-11-02 18:30:00', {}, [], '1999-01-01T00:00:00Z', { toString: () => CREATED }, new Date(CREATED)]) {
        expect(parseMessage(message({ timestamp })).createdAt, String(timestamp)).toBe('2016-07-05T21:28:35.820Z')
      }
    })

    it('has no editedAt unless the edit time is a usable timestamp', () => {
      for (const edited_timestamp of [undefined, null, '', 'never', 5, {}, '2026-13-01T00:00:00Z', { toString: () => CREATED }, new Date(CREATED)]) {
        expect(parseMessage(message({ edited_timestamp })).editedAt, String(edited_timestamp)).toBeNull()
      }
    })

    it('accepts the ISO shapes Discord sends and no others', () => {
      const ok = [
        '2026-11-02T18:30:00.123000+00:00',
        '2026-11-02T18:30:00.123+00:00',
        '2026-11-02T18:30:00+00:00',
        '2026-11-02T18:30:00Z',
        '2026-11-02T18:30:00.1Z',
        '2026-11-02T18:30:00.123456789Z',
        '2026-11-02T18:30:00+14:00',
        '2026-11-02T18:30:00-05:30',
        '2026-11-02T00:00:00Z',
        '2026-11-02T23:59:59Z',
        '2024-02-29T12:00:00Z',
        '2015-01-01T00:00:00Z',
        '2026-12-31T23:59:59Z',
        '2026-01-01T00:00:00Z',
        '2026-01-31T00:00:00Z',
        '2026-04-30T00:00:00Z',
        '9999-12-31T23:59:59Z',
      ]
      for (const edited_timestamp of ok) expect(parseMessage(message({ edited_timestamp })).editedAt, edited_timestamp).toBe(edited_timestamp)
      const bad = [
        '2014-12-31T23:59:59Z', // before Discord existed
        '2026-11-02T18:30:00', // no zone
        '2026-11-02 18:30:00Z',
        '2026-11-02T18:30Z',
        '2026-11-02T18:30:00.Z',
        '2026-11-02T18:30:00.1234567890Z',
        '2026-11-02T18:30:00z',
        '2026-11-02t18:30:00Z',
        ' 2026-11-02T18:30:00Z',
        '2026-11-02T18:30:00Z ',
        '2026-11-02T18:30:00Z\n',
        '2026-11-02T18:30:00+0000',
        '2026-11-02T18:30:00+16:00',
        '2026-11-02T18:30:00+00:60',
        '2026-11-02T24:00:00Z',
        '2026-11-02T23:60:00Z',
        '2026-11-02T23:59:60Z',
        '2026-00-02T10:00:00Z',
        '2026-13-02T10:00:00Z',
        '2026-11-00T10:00:00Z',
        '2026-11-32T10:00:00Z',
        '2026-02-29T10:00:00Z', // 2026 is no leap year
        '2026-02-30T10:00:00Z',
        '2026-04-31T10:00:00Z',
        '2026-11-31T10:00:00Z',
        '26-11-02T18:30:00Z',
        '+2026-11-02T18:30:00Z',
        '12026-11-02T18:30:00Z',
      ]
      for (const edited_timestamp of bad) expect(parseMessage(message({ edited_timestamp })).editedAt, edited_timestamp).toBeNull()
    })

    it('knows Discord started at the start of 2015, to the millisecond', () => {
      const created = (timestamp) => parseMessage(message({ timestamp })).createdAt
      expect(created('2015-01-01T00:00:00.000Z')).toBe('2015-01-01T00:00:00.000Z')
      expect(created('2014-12-31T23:59:59.999Z')).toBe('2016-07-05T21:28:35.820Z')
      expect(created('2015-01-01T00:00:00.000+00:01')).toBe('2016-07-05T21:28:35.820Z')
      expect(created('2015-01-01T00:00:00.000-00:01')).toBe('2015-01-01T00:00:00.000-00:01')
    })
  })

  describe('replies', () => {
    it('names the message a reply answers, for replies only', () => {
      const ref = { message_id: PARENT_MSG, channel_id: THREAD }
      expect(parseMessage(message({ type: 19, message_reference: ref })).replyTo).toBe(PARENT_MSG)
      for (const type of [0, 20, 23]) expect(parseMessage(message({ type, message_reference: ref })).replyTo, String(type)).toBeNull()
    })

    it('has no replyTo when a reply carries no usable reference', () => {
      for (const message_reference of [undefined, null, {}, 'x', 5, [], { message_id: null }, { message_id: 'abc' }, { message_id: Number(PARENT_MSG) }, { message_id: `${PARENT_MSG}0000` }]) {
        expect(parseMessage(message({ type: 19, message_reference })).replyTo, JSON.stringify(message_reference)).toBeNull()
      }
    })
  })

  describe('attachments', () => {
    const row = (over) => parseMessage(message({ attachments: [attachment(over)] })).attachments

    it('reads an attachment into its row', () => {
      expect(row()).toEqual([
        {
          id: ATT,
          position: 0,
          filename: 'map.png',
          contentType: 'image/png',
          size: 2048,
          width: 640,
          height: 480,
          url: ATT_URL,
          proxyUrl: ATT_PROXY,
          expiresAt: ATT_EXPIRES,
        },
      ])
      expect(Object.keys(row()[0]).sort()).toEqual(
        ['contentType', 'expiresAt', 'filename', 'height', 'id', 'position', 'proxyUrl', 'size', 'url', 'width'].sort(),
      )
    })

    it('numbers the attachments from 0, in the order they came', () => {
      const out = parseMessage(
        message({ attachments: [attachment({ id: ATT }), attachment({ id: ATT_2 }), attachment({ id: '200000000000000442' })] }),
      ).attachments
      expect(out.map((a) => [a.id, a.position])).toEqual([[ATT, 0], [ATT_2, 1], ['200000000000000442', 2]])
    })

    it('numbers the ones it keeps without gaps, and counts the cap among the ones it keeps', () => {
      const attachments = [
        attachment({ id: ATT_2, url: 'https://evil.test/attachments/x' }),
        attachment({ id: ATT }),
        attachment({ id: '200000000000000442', size: 'big' }),
        attachment({ id: '200000000000000443' }),
      ]
      expect(parseMessage(message({ attachments })).attachments.map((a) => [a.id, a.position])).toEqual([[ATT, 0], ['200000000000000443', 1]])
    })

    it('keeps at most 10', () => {
      const make = (n) => Array.from({ length: n }, (_, i) => attachment({ id: `2000000000000006${String(i).padStart(2, '0')}` }))
      expect(parseMessage(message({ attachments: make(10) })).attachments).toHaveLength(10)
      expect(parseMessage(message({ attachments: make(9) })).attachments).toHaveLength(9)
      const eleven = parseMessage(message({ attachments: make(11) })).attachments
      expect(eleven.map((a) => a.id)).toEqual(make(10).map((a) => a.id))
      expect(eleven.map((a) => a.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(parseMessage(message({ attachments: make(30) })).attachments).toHaveLength(10)
    })

    it('counts only attachments it keeps toward the 10', () => {
      const bad = Array.from({ length: 5 }, () => attachment({ url: 'https://evil.test/attachments/x' }))
      const good = Array.from({ length: 12 }, (_, i) => attachment({ id: `2000000000000006${String(i).padStart(2, '0')}` }))
      expect(parseMessage(message({ attachments: [...bad, ...good] })).attachments).toHaveLength(10)
    })

    it('drops an attachment whose url is not on the Discord CDN attachments path', () => {
      const bad = [
        'https://evil.test/attachments/1/2/a.png',
        'https://cdn.discordapp.com.evil.test/attachments/1/2/a.png',
        'https://xcdn.discordapp.com/attachments/1/2/a.png',
        'https://cdn.discordapp.com@evil.test/attachments/1/2/a.png',
        'https://cdn.discordapp.com:8443/attachments/1/2/a.png',
        'https://user:pw@cdn.discordapp.com/attachments/1/2/a.png',
        'http://cdn.discordapp.com/attachments/1/2/a.png',
        'https://media.discordapp.net/attachments/1/2/a.png',
        'https://cdn.discordapp.com/avatars/1/2.png',
        'https://cdn.discordapp.com/attachments',
        'https://cdn.discordapp.com/attachments?x=/attachments/',
        'https://cdn.discordapp.com/ephemeral-attachments/1/2/a.png',
        'https://cdn.discordapp.com/emojis/attachments/1.png',
        'HTTPS://CDN.DISCORDAPP.COM/attachments/1/2/a.png',
        ' https://cdn.discordapp.com/attachments/1/2/a.png',
        '//cdn.discordapp.com/attachments/1/2/a.png',
        '/attachments/1/2/a.png',
        'javascript:alert(1)//https://cdn.discordapp.com/attachments/',
        'data:text/html,https://cdn.discordapp.com/attachments/',
        '',
        'not a url',
      ]
      for (const url of bad) expect(row({ url }), url).toEqual([])
    })

    it('drops an attachment whose url climbs out of the attachments folder', () => {
      const bad = [
        'https://cdn.discordapp.com/attachments/../avatars/1/2.png',
        'https://cdn.discordapp.com/attachments/%2e%2e/avatars/1/2.png',
        'https://cdn.discordapp.com/attachments/%2E%2E/x',
        'https://cdn.discordapp.com/attachments/..\\x',
        'https://cdn.discordapp.com/attachments/1/../../x',
        'https://cdn.discordapp.com/attachments/./../x',
      ]
      for (const url of bad) expect(row({ url }), url).toEqual([])
      const fine = 'https://cdn.discordapp.com/attachments/1/2/a..b.png'
      expect(row({ url: fine })[0].url).toBe(fine)
    })

    it('keeps the signed url exactly as Discord sent it', () => {
      const signed = 'https://cdn.discordapp.com/attachments/1/2/a%20b.png?ex=6540a0b3&is=653e2bb3&hm=0a1b2c-D_e&'
      expect(row({ url: signed })[0].url).toBe(signed)
    })

    it('drops an attachment whose proxy url is on the wrong host, but not one that has none', () => {
      const bad = [
        'https://evil.test/attachments/1/2/a.png',
        'https://media.discordapp.net.evil.test/attachments/1/2/a.png',
        'https://xmedia.discordapp.net/attachments/1/2/a.png',
        'https://media.discordapp.net@evil.test/attachments/1/2/a.png',
        'https://cdn.discordapp.com/attachments/1/2/a.png',
        'https://media.discordapp.net/avatars/1/2.png',
        'https://media.discordapp.net/external/x/https/example.test/a.png',
        'https://media.discordapp.net/attachments/../external/x',
        'http://media.discordapp.net/attachments/1/2/a.png',
        '',
        'not a url',
        5,
        {},
        [ATT_PROXY],
        false,
        0,
      ]
      for (const proxy_url of bad) expect(row({ proxy_url }), String(proxy_url)).toEqual([])
      for (const proxy_url of [null, undefined]) expect(row({ proxy_url })[0].proxyUrl, String(proxy_url)).toBeNull()
      const { proxy_url: _gone, ...noProxy } = attachment()
      expect(parseMessage(message({ attachments: [noProxy] })).attachments[0].proxyUrl).toBeNull()
    })

    it('drops an attachment with no snowflake id, or one that is not an object', () => {
      for (const id of [undefined, null, '', 'abc', Number(ATT), ATT.slice(2)]) expect(row({ id }), String(id)).toEqual([])
      const attachments = [null, undefined, 5, 'x', [], true, [attachment()]]
      expect(parseMessage(message({ attachments })).attachments).toEqual([])
    })

    it('has no attachments when attachments is no list', () => {
      for (const attachments of [undefined, null, 'x', 5, {}, attachment(), { length: 1, 0: attachment() }]) {
        expect(parseMessage(message({ attachments })).attachments, String(attachments)).toEqual([])
      }
    })

    it('needs a size the integer column can hold, and drops the attachment without one', () => {
      expect(row({ size: 0 })[0].size).toBe(0)
      expect(row({ size: 1 })[0].size).toBe(1)
      expect(row({ size: 2147483647 })[0].size).toBe(2147483647)
      for (const size of [2147483648, -1, 1.5, '2048', NaN, Infinity, null, undefined, {}, [], 2n, 1e21]) {
        expect(row({ size }), String(size)).toEqual([])
      }
    })

    it('reads width and height when they are whole positive numbers, else null', () => {
      expect(row({ width: 1, height: 1 })[0]).toMatchObject({ width: 1, height: 1 })
      expect(row({ width: 2147483647, height: 2147483647 })[0]).toMatchObject({ width: 2147483647, height: 2147483647 })
      for (const v of [0, -1, 1.5, '640', NaN, Infinity, null, undefined, {}, 2147483648, 1e21]) {
        expect(row({ width: v, height: v })[0], String(v)).toMatchObject({ width: null, height: null })
      }
      expect(row({ width: 640, height: null })[0]).toMatchObject({ width: 640, height: null })
      expect(row({ width: null, height: 480 })[0]).toMatchObject({ width: null, height: 480 })
    })

    it('cuts the filename to 200 characters and keeps it storable', () => {
      expect(row({ filename: 'f'.repeat(199) })[0].filename).toBe('f'.repeat(199))
      expect(row({ filename: 'f'.repeat(200) })[0].filename).toBe('f'.repeat(200))
      expect(row({ filename: 'f'.repeat(201) })[0].filename).toBe('f'.repeat(200))
      expect(row({ filename: 'f'.repeat(199) + FIRE })[0].filename).toBe('f'.repeat(199))
      expect(row({ filename: `a${NUL}b${LONE_HIGH}` })[0].filename).toBe(`ab${FFFD}`)
      expect(row({ filename: undefined })[0].filename).toBe('')
      expect(row({ filename: 5 })[0].filename).toBe('')
    })

    it('keeps the content type, cut at 100, or null when there is none', () => {
      expect(row({ content_type: 'video/mp4' })[0].contentType).toBe('video/mp4')
      expect(row({ content_type: 'x'.repeat(100) })[0].contentType).toBe('x'.repeat(100))
      expect(row({ content_type: 'x'.repeat(101) })[0].contentType).toBe('x'.repeat(100))
      for (const content_type of [undefined, null, '', 5, {}, NUL]) expect(row({ content_type })[0].contentType, String(content_type)).toBeNull()
    })

    it('has no expiry when the url is not signed', () => {
      const plain = 'https://cdn.discordapp.com/attachments/1/2/a.png'
      expect(row({ url: plain })[0].expiresAt).toBeNull()
      expect(row({ url: `${plain}?ex=zz` })[0].expiresAt).toBeNull()
    })
  })

  describe('embeds', () => {
    const row = (over) => parseMessage(message({ embeds: [embed(over)] })).embeds

    it('reads an embed into its row, keeping images only as the media proxy shows them', () => {
      expect(row()).toEqual([
        {
          type: 'article',
          url: 'https://example.test/post',
          title: 'A title',
          description: 'A description',
          provider: 'Example',
          thumbnail: { url: PROXY_IMG, width: 100, height: 50 },
          image: { url: PROXY_IMG, width: 400, height: 200 },
        },
      ])
      expect(Object.keys(row()[0]).sort()).toEqual(
        ['description', 'image', 'provider', 'thumbnail', 'title', 'type', 'url'].sort(),
      )
    })

    it('ignores the parts of an embed it has no column for', () => {
      const out = row({ video: { url: 'https://example.test/v.mp4' }, author: { name: 'x' }, footer: { text: 'y' }, fields: [{ name: 'a', value: 'b' }], color: 5, timestamp: CREATED })
      expect(Object.keys(out[0]).sort()).toEqual(['description', 'image', 'provider', 'thumbnail', 'title', 'type', 'url'].sort())
    })

    it('keeps at most 10, counting only the ones that are objects', () => {
      const make = (n) => Array.from({ length: n }, (_, i) => embed({ title: `t${i}` }))
      expect(parseMessage(message({ embeds: make(10) })).embeds).toHaveLength(10)
      expect(parseMessage(message({ embeds: make(9) })).embeds).toHaveLength(9)
      expect(parseMessage(message({ embeds: make(11) })).embeds.map((e) => e.title)).toEqual(make(10).map((e) => e.title))
      const junk = [null, undefined, 5, 'x', [], true]
      expect(parseMessage(message({ embeds: [...junk, ...make(12)] })).embeds).toHaveLength(10)
      expect(parseMessage(message({ embeds: [...junk, embed()] })).embeds).toHaveLength(1)
    })

    it('has no embeds when embeds is no list', () => {
      for (const embeds of [undefined, null, 'x', 5, {}, embed()]) expect(parseMessage(message({ embeds })).embeds, String(embeds)).toEqual([])
    })

    it('links only to https pages', () => {
      expect(row({ url: 'https://example.test/a?b=1#c' })[0].url).toBe('https://example.test/a?b=1#c')
      expect(row({ url: 'HTTPS://EXAMPLE.TEST' })[0].url).toBe('https://example.test/')
      const bad = [
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        ' javascript:alert(1)',
        'jav\tascript:alert(1)',
        'http://example.test/a',
        'HTTP://example.test/a',
        'ftp://example.test/a',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        'vbscript:x',
        'blob:https://example.test/1',
        '//example.test/a',
        '/a',
        'example.test',
        'https:',
        'https://',
        '',
        'not a url',
        5,
        null,
        undefined,
        {},
        ['https://example.test/'],
        { toString: () => 'https://example.test/' },
      ]
      for (const url of bad) expect(row({ url })[0].url, String(url)).toBeNull()
    })

    it('cuts title, description, provider and type to their limits', () => {
      const cut = (over) => row(over)[0]
      expect(cut({ title: 't'.repeat(256) }).title).toBe('t'.repeat(256))
      expect(cut({ title: 't'.repeat(257) }).title).toBe('t'.repeat(256))
      expect(cut({ description: 'd'.repeat(4096) }).description).toBe('d'.repeat(4096))
      expect(cut({ description: 'd'.repeat(4097) }).description).toBe('d'.repeat(4096))
      expect(cut({ provider: { name: 'p'.repeat(256) } }).provider).toBe('p'.repeat(256))
      expect(cut({ provider: { name: 'p'.repeat(257) } }).provider).toBe('p'.repeat(256))
      expect(cut({ type: 'y'.repeat(32) }).type).toBe('y'.repeat(32))
      expect(cut({ type: 'y'.repeat(33) }).type).toBe('y'.repeat(32))
    })

    it('keeps embed text storable', () => {
      const out = row({ title: `a${NUL}b`, description: `c${LONE_LOW}d`, provider: { name: `e${LONE_HIGH}` }, type: `x${NUL}` })[0]
      expect(out).toMatchObject({ title: 'ab', description: `c${FFFD}d`, provider: `e${FFFD}`, type: 'x' })
    })

    it('has null text for text that is missing, empty or no string', () => {
      for (const v of [undefined, null, '', 5, {}, [], NUL]) {
        expect(row({ title: v, description: v, type: v })[0], String(v)).toMatchObject({ title: null, description: null, type: null })
      }
      for (const provider of [undefined, null, 'Example', 5, [], {}, { name: null }, { name: 5 }, { url: 'https://example.test' }]) {
        expect(row({ provider })[0].provider, JSON.stringify(provider)).toBeNull()
      }
    })

    it('keeps an image only when its proxy_url is on Discord media proxy hosts', () => {
      const ok = [
        'https://media.discordapp.net/external/x/https/example.test/p.png',
        'https://media.discordapp.net/attachments/1/2/p.png?width=10',
        'https://images-ext-1.discordapp.net/external/x/p.png',
        'https://images-ext-2.discordapp.net/external/x/p.png',
        'https://images-ext-17.discordapp.net/external/x/p.png',
        'https://images-ext-123456.discordapp.net/external/x/p.png',
        'HTTPS://MEDIA.DISCORDAPP.NET/external/x',
      ]
      for (const proxy_url of ok) {
        const out = row({ thumbnail: { proxy_url, width: 1, height: 1 }, image: { proxy_url, width: 1, height: 1 } })[0]
        expect(out.thumbnail, proxy_url).toEqual({ url: new URL(proxy_url).href, width: 1, height: 1 })
        expect(out.image, proxy_url).toEqual({ url: new URL(proxy_url).href, width: 1, height: 1 })
      }
      const bad = [
        undefined,
        null,
        '',
        'not a url',
        5,
        {},
        ['https://media.discordapp.net/x'],
        'https://example.test/pic.png',
        'https://cdn.discordapp.com/attachments/1/2/p.png',
        'https://media.discordapp.net.evil.test/x',
        'https://xmedia.discordapp.net/x',
        'https://media.discordapp.net@evil.test/x',
        'https://user:pw@media.discordapp.net/x',
        'https://media.discordapp.net:8443/x',
        'https://media.discordapp.net./x',
        'https://images-ext-.discordapp.net/x',
        'https://images-ext-x.discordapp.net/x',
        'https://images-ext-1.discordapp.net.evil.test/x',
        'https://images-ext-1x.discordapp.net/x',
        'https://ximages-ext-1.discordapp.net/x',
        'https://images-ext-1.discordapp.com/x',
        'https://media.discordapp.com/x',
        'https://sub.media.discordapp.net/x',
        'http://media.discordapp.net/x',
        'javascript:alert(1)',
        'data:image/png;base64,AAAA',
        '//media.discordapp.net/x',
      ]
      for (const proxy_url of bad) {
        const out = row({ thumbnail: { url: 'https://example.test/t.png', proxy_url, width: 1, height: 1 }, image: { url: 'https://example.test/i.png', proxy_url } })[0]
        expect(out.thumbnail, String(proxy_url)).toBeNull()
        expect(out.image, String(proxy_url)).toBeNull()
      }
    })

    it('never keeps the raw outside url of an image, only the proxy one', () => {
      const out = row({ thumbnail: { url: 'https://example.test/t.png', width: 1, height: 1 }, image: { url: 'https://media.discordapp.net/x', width: 1, height: 1 } })[0]
      expect(out.thumbnail).toBeNull()
      expect(out.image).toBeNull()
      const kept = row({ thumbnail: { url: 'https://example.test/t.png', proxy_url: PROXY_IMG, width: 1, height: 1 } })[0].thumbnail
      expect(kept.url).toBe(PROXY_IMG)
      expect(Object.keys(kept).sort()).toEqual(['height', 'url', 'width'])
    })

    it('has no thumbnail or image when it is missing or no object', () => {
      for (const v of [undefined, null, 'x', 5, [], true]) {
        expect(row({ thumbnail: v, image: v })[0], String(v)).toMatchObject({ thumbnail: null, image: null })
      }
    })

    it('reads each image on its own', () => {
      expect(row({ thumbnail: undefined })[0]).toMatchObject({ thumbnail: null, image: { url: PROXY_IMG } })
      expect(row({ image: undefined })[0]).toMatchObject({ thumbnail: { url: PROXY_IMG }, image: null })
    })

    it('reads image width and height as whole positive numbers, else null', () => {
      const dims = (width, height) => row({ thumbnail: { proxy_url: PROXY_IMG, width, height }, image: { proxy_url: PROXY_IMG, width, height } })[0]
      expect(dims(1, 1).thumbnail).toEqual({ url: PROXY_IMG, width: 1, height: 1 })
      expect(dims(7, 9).image).toEqual({ url: PROXY_IMG, width: 7, height: 9 })
      for (const v of [0, -1, 1.5, '10', NaN, Infinity, null, undefined, {}]) {
        expect(dims(v, v).thumbnail, String(v)).toEqual({ url: PROXY_IMG, width: null, height: null })
        expect(dims(v, v).image, String(v)).toEqual({ url: PROXY_IMG, width: null, height: null })
      }
      expect(dims(5, null).thumbnail).toEqual({ url: PROXY_IMG, width: 5, height: null })
      expect(dims(null, 6).thumbnail).toEqual({ url: PROXY_IMG, width: null, height: 6 })
    })
  })

  describe('stickers', () => {
    const row = (sticker_items) => parseMessage(message({ sticker_items })).stickers

    it('reads id and name', () => {
      expect(row([{ id: STICKER, name: 'wave', format_type: 1 }])).toEqual([{ id: STICKER, name: 'wave' }])
    })

    it('keeps at most 3, counting only the ones with a snowflake id', () => {
      const make = (n) => Array.from({ length: n }, (_, i) => ({ id: `2000000000000007${String(i).padStart(2, '0')}`, name: `s${i}` }))
      expect(row(make(3))).toEqual(make(3))
      expect(row(make(2))).toEqual(make(2))
      expect(row(make(4))).toEqual(make(3))
      expect(row([{ id: 'abc', name: 'x' }, null, ...make(5)])).toEqual(make(3))
    })

    it('drops a sticker with no snowflake id, or that is no object', () => {
      expect(row([{ id: 'abc', name: 'x' }, { name: 'y' }, { id: Number(STICKER), name: 'z' }, null, 5, 'x', [], [{ id: STICKER }]])).toEqual([])
    })

    it('keeps the name storable, cut to 100, and empty when it is no string', () => {
      expect(row([{ id: STICKER, name: 'n'.repeat(100) }])[0].name).toBe('n'.repeat(100))
      expect(row([{ id: STICKER, name: 'n'.repeat(101) }])[0].name).toBe('n'.repeat(100))
      expect(row([{ id: STICKER, name: `a${NUL}b` }])[0].name).toBe('ab')
      expect(row([{ id: STICKER, name: 5 }])[0].name).toBe('')
      expect(row([{ id: STICKER }])[0].name).toBe('')
    })

    it('has no stickers when sticker_items is no list', () => {
      for (const v of [undefined, null, 'x', 5, {}, { id: STICKER, name: 'a' }]) expect(row(v), String(v)).toEqual([])
    })
  })

  describe('reactions', () => {
    const row = (reactions) => parseMessage(message({ reactions })).reactions
    const custom = (over = {}) => reaction({ emoji: { id: EMOJI, name: 'salute', animated: false }, ...over })

    it('reads a unicode and a custom reaction', () => {
      expect(row([reaction(), custom({ count: 7 })])).toEqual([
        { key: `u:${FIRE}`, id: null, name: FIRE, animated: false, count: 3 },
        { key: `c:${EMOJI}`, id: EMOJI, name: 'salute', animated: false, count: 7 },
      ])
    })

    it('reads animated custom emoji', () => {
      expect(row([custom({ emoji: { id: EMOJI, name: 'spin', animated: true } })])[0].animated).toBe(true)
      for (const animated of [undefined, null, false, 'true', 1]) {
        expect(row([custom({ emoji: { id: EMOJI, name: 'spin', animated } })])[0].animated, String(animated)).toBe(false)
      }
    })

    it('takes the bot own reaction off the count', () => {
      expect(row([reaction({ count: 3, me: true })])[0].count).toBe(2)
      expect(row([reaction({ count: 3, me: false })])[0].count).toBe(3)
      expect(row([reaction({ count: 3, me: undefined })])[0].count).toBe(3)
      expect(row([reaction({ count: 3, me: 'true' })])[0].count).toBe(3)
      expect(row([reaction({ count: 3, me: 1 })])[0].count).toBe(3)
    })

    it('drops a reaction left at zero, or with a count that is no positive whole number', () => {
      expect(row([reaction({ count: 1, me: true })])).toEqual([])
      expect(row([reaction({ count: 1, me: false })])).toHaveLength(1)
      expect(row([reaction({ count: 2, me: true })])).toHaveLength(1)
      for (const count of [0, -1, 1.5, '3', NaN, Infinity, null, undefined, {}, [], 3n, 1e300]) {
        expect(row([reaction({ count })]), String(count)).toEqual([])
        expect(row([reaction({ count, me: true })]), String(count)).toEqual([])
      }
      expect(row([reaction({ count: 0, me: true })])).toEqual([])
    })

    it('keeps the order, dropping only the ones that are gone', () => {
      const out = row([reaction({ count: 1, me: true }), custom({ count: 4 }), reaction({ emoji: { id: null, name: '\u{1F44D}' }, count: 2, me: true })])
      expect(out.map((r) => [r.key, r.count])).toEqual([[`c:${EMOJI}`, 4], ['u:\u{1F44D}', 1]])
    })

    it('drops a reaction whose emoji cannot be keyed', () => {
      const bad = [
        undefined,
        null,
        'x',
        5,
        [],
        {},
        { id: null },
        { id: null, name: null },
        { id: null, name: '' },
        { id: null, name: 5 },
        { id: null, name: 'n'.repeat(33) },
        { id: null, name: `a${NUL}` },
        { id: null, name: `a${LONE_HIGH}` },
        { id: 'abc', name: FIRE },
        { id: 5, name: FIRE },
        { id: Number(EMOJI), name: 'x' },
        { id: '', name: FIRE },
        { id: false, name: FIRE },
        { id: 0, name: FIRE },
      ]
      for (const emoji of bad) expect(row([reaction({ emoji })]), JSON.stringify(emoji)).toEqual([])
    })

    it('keeps a unicode emoji whole at 32 units and no longer', () => {
      expect(row([reaction({ emoji: { id: null, name: 'n'.repeat(32) } })])[0].name).toBe('n'.repeat(32))
      expect(row([reaction({ emoji: { id: undefined, name: FIRE } })])[0].key).toBe(`u:${FIRE}`)
      expect(row([reaction({ emoji: { name: FIRE } })])[0].key).toBe(`u:${FIRE}`)
    })

    it('keeps a custom emoji whose name Discord no longer has, as unnamed', () => {
      for (const name of [null, undefined, '', 5, 'has space', 'n'.repeat(33), 'dash-ed', 'émoji']) {
        expect(row([reaction({ emoji: { id: EMOJI, name } })])[0], String(name)).toEqual({ key: `c:${EMOJI}`, id: EMOJI, name: null, animated: false, count: 3 })
      }
      expect(row([reaction({ emoji: { id: EMOJI, name: 'n'.repeat(32) } })])[0].name).toBe('n'.repeat(32))
    })

    it('drops reactions that are not objects, and has none when reactions is no list', () => {
      expect(row([null, undefined, 5, 'x', [], true])).toEqual([])
      for (const v of [undefined, null, 'x', 5, {}, reaction()]) expect(row(v), String(v)).toEqual([])
    })
  })

  it('never throws, and what it answers is a well-formed row', () => {
    const junk = fc.anything()
    const idish = fc.oneof({ weight: 9, arbitrary: fc.stringMatching(/^\d{17,20}$/) }, { weight: 1, arbitrary: junk })
    const textish = fc.oneof(fc.string({ unit: 'binary', maxLength: 300 }), junk)
    const longText = fc.oneof(fc.string({ unit: 'binary', minLength: 0, maxLength: 5000 }), junk)
    const hash = fc.oneof(fc.stringMatching(/^(a_)?[0-9a-f]{32}$/), fc.string(), junk)
    const urlish = fc.oneof(
      fc.constant(ATT_URL),
      fc.constant(ATT_PROXY),
      fc.constant(PROXY_IMG),
      fc.constant('https://cdn.discordapp.com/attachments/../x'),
      fc.constant('https://media.discordapp.net/attachments/1/2/a.png'),
      fc.constant('https://images-ext-3.discordapp.net/x'),
      fc.webUrl(),
      fc.string({ unit: 'binary' }).map((s) => `https://cdn.discordapp.com/attachments/${s}`),
      fc.string({ unit: 'binary' }).map((s) => `https://media.discordapp.net/attachments/${s}`),
      fc.string({ unit: 'binary' }).map((s) => `https://example.test/${s}`),
      fc.string(),
      junk,
    )
    const stamp = fc.oneof(fc.constant(CREATED), fc.date({ min: new Date('2015-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }).map((d) => d.toISOString()), textish)
    const natural = fc.oneof(fc.integer({ min: -3, max: 3000 }), junk)
    const image = fc.oneof(fc.record({ url: urlish, proxy_url: urlish, width: natural, height: natural }, { requiredKeys: [] }), junk)
    const raw = fc.oneof(
      { weight: 1, arbitrary: junk },
      {
        weight: 20,
        arbitrary: fc.record(
          {
            id: idish,
            channel_id: idish,
            type: fc.oneof({ weight: 8, arbitrary: fc.constantFrom(0, 19, 20, 23) }, { weight: 1, arbitrary: junk }),
            webhook_id: idish,
            author: fc.oneof(
              { weight: 9, arbitrary: fc.record({ id: idish, username: textish, global_name: textish, avatar: hash }, { requiredKeys: ['id'] }) },
              { weight: 1, arbitrary: junk },
            ),
            content: longText,
            timestamp: stamp,
            edited_timestamp: stamp,
            message_reference: fc.oneof(fc.record({ message_id: idish }, { requiredKeys: [] }), junk),
            attachments: fc.oneof(
              fc.array(fc.oneof(fc.record({ id: idish, filename: textish, size: natural, url: urlish, proxy_url: urlish, content_type: textish, width: natural, height: natural }, { requiredKeys: [] }), junk), { maxLength: 14 }),
              junk,
            ),
            embeds: fc.oneof(
              fc.array(fc.oneof(fc.record({ type: textish, url: urlish, title: textish, description: longText, provider: fc.oneof(fc.record({ name: textish }, { requiredKeys: [] }), junk), thumbnail: image, image }, { requiredKeys: [] }), junk), { maxLength: 14 }),
              junk,
            ),
            sticker_items: fc.oneof(fc.array(fc.oneof(fc.record({ id: idish, name: textish }, { requiredKeys: [] }), junk), { maxLength: 6 }), junk),
            reactions: fc.oneof(
              fc.array(
                fc.oneof(
                  fc.record({ count: fc.oneof(fc.integer({ min: -2, max: 50 }), junk), me: fc.oneof(fc.boolean(), junk), emoji: fc.oneof(fc.record({ id: fc.oneof(idish, fc.constant(null)), name: textish, animated: fc.oneof(fc.boolean(), junk) }, { requiredKeys: [] }), junk) }, { requiredKeys: [] }),
                  junk,
                ),
                { maxLength: 8 },
              ),
              junk,
            ),
          },
          { requiredKeys: ['id', 'channel_id', 'type', 'author'] },
        ),
      },
    )
    const SNOW = /^\d{17,20}$/
    const wellFormed = (s) => !s.includes(NUL) && s === s.toWellFormed()
    let answered = 0
    fc.assert(
      fc.property(raw, (r) => {
        const row = parseMessage(r)
        if (row === null) return
        answered++
        expect(MESSAGE_KINDS.has(row.kind)).toBe(true)
        for (const id of [row.id, row.postId, row.authorId]) expect(id).toMatch(SNOW)
        expect(row.webhookId === null || SNOW.test(row.webhookId)).toBe(true)
        expect(row.replyTo === null || (row.kind === 19 && SNOW.test(row.replyTo))).toBe(true)
        expect(row.authorName.length).toBeGreaterThan(0)
        expect(row.authorName.length).toBeLessThanOrEqual(80)
        expect(row.authorAvatar === null || row.authorAvatar === `https://cdn.discordapp.com/avatars/${row.authorId}/${r.author.avatar}.png?size=64`).toBe(true)
        expect(row.content.length).toBeLessThanOrEqual(4000)
        expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false)
        expect(row.editedAt === null || !Number.isNaN(Date.parse(row.editedAt))).toBe(true)
        expect(row.attachments.length).toBeLessThanOrEqual(10)
        row.attachments.forEach((a, i) => {
          expect(a.position).toBe(i)
          expect(a.id).toMatch(SNOW)
          expect(a.filename.length).toBeLessThanOrEqual(200)
          expect(a.url.startsWith('https://cdn.discordapp.com/attachments/')).toBe(true)
          expect(a.proxyUrl === null || a.proxyUrl.startsWith('https://media.discordapp.net/attachments/')).toBe(true)
          expect(Number.isInteger(a.size) && a.size >= 0 && a.size <= 2147483647).toBe(true)
          for (const d of [a.width, a.height]) expect(d === null || (Number.isInteger(d) && d > 0)).toBe(true)
        })
        expect(row.embeds.length).toBeLessThanOrEqual(10)
        for (const e of row.embeds) {
          expect(e.url === null || e.url.startsWith('https://')).toBe(true)
          for (const [k, max] of [['title', 256], ['description', 4096], ['provider', 256], ['type', 32]]) expect(e[k] === null || (e[k].length > 0 && e[k].length <= max)).toBe(true)
          for (const img of [e.thumbnail, e.image]) {
            if (img !== null) expect(img.url).toMatch(/^https:\/\/(?:media|images-ext-\d+)\.discordapp\.net\//)
          }
        }
        expect(row.stickers.length).toBeLessThanOrEqual(3)
        for (const s of row.stickers) expect(s.id).toMatch(SNOW)
        for (const x of row.reactions) {
          expect(Number.isInteger(x.count) && x.count >= 1).toBe(true)
          expect(x.key).toBe(x.id === null ? `u:${x.name}` : `c:${x.id}`)
        }
        for (const s of strings(row)) expect(wellFormed(s)).toBe(true)
        expect(JSON.parse(JSON.stringify(row))).toStrictEqual(row)
      }),
      { numRuns: 500 },
    )
    expect(answered).toBeGreaterThan(200)
  })
})

describe('parseEmoji', () => {
  it('reads the guild emoji into id, name and animated', () => {
    expect(
      parseEmoji([
        { id: EMOJI, name: 'salute', animated: false, roles: [], managed: false, available: true },
        { id: '200000000000000461', name: 'spin_2', animated: true },
      ]),
    ).toEqual([
      { id: EMOJI, name: 'salute', animated: false },
      { id: '200000000000000461', name: 'spin_2', animated: true },
    ])
  })

  it('treats animated as true only when it is exactly true', () => {
    for (const animated of [undefined, null, 'true', 1, {}, [true]]) {
      expect(parseEmoji([{ id: EMOJI, name: 'a', animated }])[0].animated, String(animated)).toBe(false)
    }
  })

  it('accepts names of 1 to 32 word characters', () => {
    expect(parseEmoji([{ id: EMOJI, name: 'a' }])).toHaveLength(1)
    expect(parseEmoji([{ id: EMOJI, name: 'A_9'.repeat(10) + 'ab' }])).toHaveLength(1)
    expect(parseEmoji([{ id: EMOJI, name: 'n'.repeat(32) }])).toHaveLength(1)
    expect(parseEmoji([{ id: EMOJI, name: '_' }])).toHaveLength(1)
  })

  it('drops an emoji with a bad name or a bad id', () => {
    const names = ['', 'n'.repeat(33), 'has space', 'dash-ed', 'émoji', 'a.b', 'a\n', '\na', ' a', 'a ', FIRE, 'x:y', null, undefined, 5, {}, ['a'], { toString: () => 'ok' }]
    for (const name of names) expect(parseEmoji([{ id: EMOJI, name }]), String(name)).toEqual([])
    const ids = [undefined, null, '', 'abc', EMOJI.slice(2), `${EMOJI}0000`, Number(EMOJI), ` ${EMOJI}`, 5, {}]
    for (const id of ids) expect(parseEmoji([{ id, name: 'ok' }]), String(id)).toEqual([])
  })

  it('keeps the good ones, in order, past the bad ones', () => {
    const out = parseEmoji([null, { id: 'x', name: 'a' }, { id: EMOJI, name: 'one' }, 5, { id: EMOJI, name: '' }, { id: '200000000000000462', name: 'two' }])
    expect(out.map((e) => e.name)).toEqual(['one', 'two'])
  })

  it('answers an empty list for anything that is not a list', () => {
    for (const v of [undefined, null, 'x', 5, {}, true, { 0: { id: EMOJI, name: 'a' }, length: 1 }]) expect(parseEmoji(v), String(v)).toEqual([])
    expect(parseEmoji([])).toEqual([])
  })

  it('never throws and only answers rows that are whole', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        for (const e of parseEmoji(v)) {
          expect(e.id).toMatch(/^\d{17,20}$/)
          expect(e.name).toMatch(/^\w{1,32}$/)
          expect(typeof e.animated).toBe('boolean')
          expect(Object.keys(e).sort()).toEqual(['animated', 'id', 'name'])
        }
      }),
    )
  })
})

describe('emojiKey', () => {
  it('keys a custom emoji by its id and a unicode one by its name', () => {
    expect(emojiKey({ id: EMOJI, name: 'salute' })).toBe(`c:${EMOJI}`)
    expect(emojiKey({ id: null, name: FIRE })).toBe(`u:${FIRE}`)
    expect(emojiKey({ name: FIRE })).toBe(`u:${FIRE}`)
    expect(emojiKey({ id: undefined, name: '\u{1F44D}\u{1F3FD}' })).toBe('u:\u{1F44D}\u{1F3FD}')
  })

  it('keys a custom emoji whose name is gone, since the id alone names it', () => {
    expect(emojiKey({ id: EMOJI, name: null })).toBe(`c:${EMOJI}`)
    expect(emojiKey({ id: EMOJI })).toBe(`c:${EMOJI}`)
    expect(emojiKey({ id: EMOJI, name: 'x', animated: true })).toBe(`c:${EMOJI}`)
  })

  it('keeps a long family emoji whole', () => {
    const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'
    expect(emojiKey({ id: null, name: family })).toBe(`u:${family}`)
  })

  it('is null for anything it cannot key, instead of throwing', () => {
    const bad = [
      undefined,
      null,
      'x',
      5,
      true,
      [],
      [{ id: EMOJI }],
      {},
      { id: null },
      { id: null, name: '' },
      { id: null, name: null },
      { id: null, name: 5 },
      { id: null, name: 'n'.repeat(33) },
      { id: null, name: `a${NUL}` },
      { id: null, name: `${LONE_HIGH}` },
      { id: null, name: `${LONE_LOW}a` },
      { id: 'abc', name: FIRE },
      { id: 5, name: FIRE },
      { id: Number(EMOJI), name: FIRE },
      { id: '', name: FIRE },
      { id: 0, name: FIRE },
      { id: false, name: FIRE },
      { id: `${EMOJI}x`, name: FIRE },
      { id: EMOJI.slice(2), name: FIRE },
      { id: {}, name: FIRE },
    ]
    for (const emoji of bad) expect(emojiKey(emoji), JSON.stringify(emoji)).toBeNull()
  })

  it('never throws, and a key it gives is c: and a snowflake or u: and a short well-formed name', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const key = emojiKey(v)
        if (key === null) return
        expect(key).toMatch(/^(c:\d{17,20}|u:[\s\S]{1,32})$/)
        expect(key).toBe(key.toWellFormed())
        expect(key).not.toContain(NUL)
      }),
    )
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (name) => {
        const key = emojiKey({ id: null, name })
        if (key !== null) expect(key).toBe(`u:${name}`)
        else expect(name === '' || name.length > 32 || name !== name.toWellFormed() || name.includes(NUL)).toBe(true)
      }),
    )
  })
})

describe('applyReaction', () => {
  const entry = (over = {}) => ({ key: `u:${FIRE}`, id: null, name: FIRE, animated: false, count: 3, ...over })
  const salute = (count = 2) => ({ key: `c:${EMOJI}`, id: EMOJI, name: 'salute', animated: false, count })
  const FIRE_EMOJI = { id: null, name: FIRE, animated: false }
  const SALUTE_EMOJI = { id: EMOJI, name: 'salute', animated: false }

  it('adds one to an emoji that is already there, in place', () => {
    const before = [entry({ count: 3 }), salute(2)]
    expect(applyReaction(before, FIRE_EMOJI, 1)).toEqual([entry({ count: 4 }), salute(2)])
    expect(applyReaction(before, SALUTE_EMOJI, 1)).toEqual([entry({ count: 3 }), salute(3)])
  })

  it('takes one off, in place', () => {
    const before = [salute(5), entry({ count: 3 })]
    expect(applyReaction(before, FIRE_EMOJI, -1)).toEqual([salute(5), entry({ count: 2 })])
    expect(applyReaction(before, SALUTE_EMOJI, -1)).toEqual([salute(4), entry({ count: 3 })])
  })

  it('adds a new emoji at the end', () => {
    expect(applyReaction([salute(2)], FIRE_EMOJI, 1)).toEqual([salute(2), entry({ count: 1 })])
    expect(applyReaction([], SALUTE_EMOJI, 1)).toEqual([salute(1)])
    expect(applyReaction([], { id: EMOJI, name: 'spin', animated: true }, 1)).toEqual([
      { key: `c:${EMOJI}`, id: EMOJI, name: 'spin', animated: true, count: 1 },
    ])
    expect(applyReaction([], { id: EMOJI, name: null }, 1)).toEqual([{ key: `c:${EMOJI}`, id: EMOJI, name: null, animated: false, count: 1 }])
  })

  it('starts a new emoji at the delta, whatever it is', () => {
    expect(applyReaction([], FIRE_EMOJI, 4)).toEqual([entry({ count: 4 })])
  })

  it('drops an emoji that reaches zero, and one that would go below it', () => {
    expect(applyReaction([entry({ count: 1 }), salute(2)], FIRE_EMOJI, -1)).toEqual([salute(2)])
    expect(applyReaction([entry({ count: 1 })], FIRE_EMOJI, -1)).toEqual([])
    expect(applyReaction([entry({ count: 2 })], FIRE_EMOJI, -5)).toEqual([])
    expect(applyReaction([salute(2), entry({ count: 1 })], FIRE_EMOJI, -1)).toEqual([salute(2)])
  })

  it('keeps an emoji that is left at one', () => {
    expect(applyReaction([entry({ count: 2 })], FIRE_EMOJI, -1)).toEqual([entry({ count: 1 })])
    expect(applyReaction([entry({ count: 6 })], FIRE_EMOJI, -5)).toEqual([entry({ count: 1 })])
    expect(applyReaction([entry({ count: 7 })], FIRE_EMOJI, -5)).toEqual([entry({ count: 2 })])
  })

  it('passes over a stored entry that is no object, and keeps it where it was', () => {
    for (const junk of [null, undefined, 5, 'x']) {
      expect(applyReaction([junk, entry({ count: 3 })], FIRE_EMOJI, 1), String(junk)).toEqual([junk, entry({ count: 4 })])
      expect(applyReaction([junk], FIRE_EMOJI, 1), String(junk)).toEqual([junk, entry({ count: 1 })])
    }
  })

  it('never goes negative, and never adds an emoji that was not there to take one from', () => {
    expect(applyReaction([], FIRE_EMOJI, -1)).toEqual([])
    expect(applyReaction([salute(2)], FIRE_EMOJI, -1)).toEqual([salute(2)])
    expect(applyReaction([salute(2)], FIRE_EMOJI, -9)).toEqual([salute(2)])
  })

  it('changes by any whole delta, and not at all by zero', () => {
    expect(applyReaction([entry({ count: 3 })], FIRE_EMOJI, 5)).toEqual([entry({ count: 8 })])
    expect(applyReaction([entry({ count: 8 })], FIRE_EMOJI, -5)).toEqual([entry({ count: 3 })])
    expect(applyReaction([entry({ count: 3 })], FIRE_EMOJI, 0)).toEqual([entry({ count: 3 })])
    expect(applyReaction([], FIRE_EMOJI, 0)).toEqual([])
  })

  it('finds the emoji by key alone, and keeps the name and animation it was stored with', () => {
    expect(applyReaction([salute(2)], { id: EMOJI, name: 'renamed', animated: true }, 1)).toEqual([salute(3)])
    expect(applyReaction([salute(2)], { id: EMOJI }, 1)).toEqual([salute(3)])
  })

  it('does not mix up a custom emoji with a unicode one of the same name', () => {
    const out = applyReaction([entry({ key: 'u:salute', id: null, name: 'salute', count: 1 })], SALUTE_EMOJI, 1)
    expect(out.map((r) => [r.key, r.count])).toEqual([['u:salute', 1], [`c:${EMOJI}`, 1]])
  })

  it('adjusts only the first when a key is listed twice', () => {
    const out = applyReaction([entry({ count: 1 }), entry({ count: 5 })], FIRE_EMOJI, 1)
    expect(out.map((r) => r.count)).toEqual([2, 5])
  })

  it('treats a stored count that is no whole number as nothing', () => {
    for (const count of [undefined, null, 'x', NaN, 1.5, {}]) {
      expect(applyReaction([entry({ count })], FIRE_EMOJI, 2), String(count)).toEqual([entry({ count: 2 })])
      expect(applyReaction([entry({ count })], FIRE_EMOJI, -1), String(count)).toEqual([])
    }
  })

  it('leaves the list alone, and answers a new one', () => {
    const before = Object.freeze([Object.freeze(entry({ count: 3 })), Object.freeze(salute(2))])
    const snapshot = JSON.parse(JSON.stringify(before))
    for (const delta of [1, -1, -9, 0]) {
      for (const emoji of [FIRE_EMOJI, SALUTE_EMOJI, { id: null, name: 'new' }]) {
        const out = applyReaction(before, emoji, delta)
        expect(out).not.toBe(before)
        expect(before).toEqual(snapshot)
      }
    }
    const out = applyReaction(before, FIRE_EMOJI, 1)
    expect(out[1]).toEqual(before[1])
  })

  it('answers the list unchanged for an emoji it cannot key', () => {
    const before = [entry({ count: 3 })]
    for (const emoji of [undefined, null, 'x', 5, {}, { id: 'abc', name: FIRE }, { id: null, name: '' }, { id: null, name: 'n'.repeat(33) }, { id: null, name: `${LONE_HIGH}` }]) {
      expect(applyReaction(before, emoji, 1), JSON.stringify(emoji)).toEqual(before)
      expect(applyReaction(before, emoji, -1), JSON.stringify(emoji)).toEqual(before)
    }
  })

  it('raises TypeError for a delta that is no whole number', () => {
    for (const delta of [undefined, null, '1', 1.5, NaN, Infinity, -Infinity, {}, [], 1n, 2 ** 53]) {
      expect(() => applyReaction([], FIRE_EMOJI, delta), String(delta)).toThrow(TypeError)
      expect(() => applyReaction([], FIRE_EMOJI, delta), String(delta)).toThrow(/whole number/)
    }
  })

  it('starts from nothing when the list is no list', () => {
    for (const v of [undefined, null, 'x', 5, {}, true]) {
      expect(applyReaction(v, FIRE_EMOJI, 1), String(v)).toEqual([entry({ count: 1 })])
      expect(applyReaction(v, FIRE_EMOJI, -1), String(v)).toEqual([])
    }
  })

  const unicode = fc.constantFrom(FIRE, '\u{1F44D}', '\u2764\uFE0F', 'ok')
  const emojiArb = fc.oneof(
    unicode.map((name) => ({ id: null, name })),
    fc.constantFrom(EMOJI, '200000000000000461', '200000000000000462').map((id) => ({ id, name: 'x', animated: false })),
    fc.anything(),
  )
  const entryArb = fc.record({
    key: fc.oneof(fc.constantFrom(`c:${EMOJI}`, `c:200000000000000461`, `u:${FIRE}`, 'u:\u{1F44D}', 'u:ok'), fc.string()),
    id: fc.constant(null),
    name: fc.string(),
    animated: fc.boolean(),
    count: fc.integer({ min: 1, max: 1_000_000 }),
  })
  const listArb = fc.array(entryArb, { maxLength: 8 })

  it('is undone by taking back what it added, for any list without zero counts', () => {
    fc.assert(
      fc.property(listArb, emojiArb, (r, e) => {
        expect(applyReaction(applyReaction(r, e, 1), e, -1)).toEqual(r)
      }),
      { numRuns: 500 },
    )
  })

  it('is undone the other way round too, whenever there was something to take', () => {
    fc.assert(
      fc.property(listArb, fc.integer({ min: 1, max: 9 }), (r, i) => {
        const target = r[i % Math.max(r.length, 1)]
        fc.pre(target !== undefined)
        const e = target.key.startsWith('c:') ? { id: target.key.slice(2), name: 'x' } : { id: null, name: target.key.slice(2) }
        fc.pre(emojiKey(e) === target.key)
        const first = r.findIndex((x) => x.key === target.key)
        fc.pre(r[first].count >= 2)
        expect(applyReaction(applyReaction(r, e, -1), e, 1)).toEqual(r)
      }),
    )
  })

  it('agrees with a plain model of counting, and never leaves a count below one', () => {
    fc.assert(
      fc.property(listArb, emojiArb, fc.integer({ min: -6, max: 6 }), (r, e, delta) => {
        const before = JSON.parse(JSON.stringify(r))
        const out = applyReaction(r, e, delta)
        expect(r).toEqual(before)
        for (const x of out) expect(x.count).toBeGreaterThanOrEqual(1)
        const key = emojiKey(e)
        if (key === null) {
          expect(out).toEqual(r)
          return
        }
        const had = r.find((x) => x.key === key)?.count ?? 0
        const want = Math.max(0, had + delta)
        const now = out.find((x) => x.key === key)?.count ?? 0
        const firstIsTheOnlyOne = r.filter((x) => x.key === key).length <= 1
        if (firstIsTheOnlyOne) expect(now).toBe(want)
        expect(out.length).toBeLessThanOrEqual(r.length + 1)
        // Every other entry is untouched and stays in its place.
        expect(out.filter((x) => x.key !== key)).toEqual(r.filter((x) => x.key !== key))
      }),
      { numRuns: 500 },
    )
  })
})
