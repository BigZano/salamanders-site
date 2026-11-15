import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import { createImport } from './librariusImport.js'
import { Upstream } from './discordRoles.js'
import { parseMessage, parseThread } from './librariusParse.js'

// Every id, name and time here is invented. The two ends of the system are in memory: a fake Discord client that keeps
// the argument checks of the real one, and a fake store that keeps the real store's id checks (a TypeError before any
// write) and its idempotent writes.
const FORUM = '200000000000000400'
const OWNER = '200000000000000401'
const AUTHOR = '200000000000000402'
const OTHER_FORUM = '200000000000000403'
const OUT_OF_RANGE = '99999999999999999999' // a snowflake by shape, but larger than a bigint
const T0 = Date.parse('2026-11-15T12:00:00.000Z')
const SNOWFLAKE = /^\d{17,20}$/
const BIGINT_MAX = 9223372036854775807n
const LINK = /https?:\/\//i

const iso = (ms) => new Date(ms).toISOString()
const postId = (p) => String(200000000000000410n + BigInt(p))
const mid = (p, n) => String(200000010000000000n + BigInt(p) * 1000000n + BigInt(n))
const arch = (day, micro = '000000') => `2026-10-${String(day).padStart(2, '0')}T10:00:00.${micro}+00:00`

const raw = (p, n, over = {}) => ({
  id: mid(p, n),
  channel_id: postId(p),
  type: 0,
  content: `invented text ${n}`,
  timestamp: '2026-10-01T10:00:00.000000+00:00',
  edited_timestamp: null,
  author: { id: AUTHOR, username: 'invented-member' },
  attachments: [],
  embeds: [],
  reactions: [],
  ...over,
})
const channel = (p, from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => raw(p, from + i))

const thread = (p, over = {}) => ({
  id: postId(p),
  parent_id: FORUM,
  owner_id: OWNER,
  name: `Invented topic ${p}`,
  applied_tags: [],
  flags: 0,
  thread_metadata: {
    archived: false,
    locked: false,
    create_timestamp: '2026-09-01T10:00:00.000000+00:00',
    archive_timestamp: '2026-09-01T10:00:00.000000+00:00',
  },
  ...over,
})
const archivedThread = (p, at, over = {}) =>
  thread(p, {
    thread_metadata: { archived: true, locked: false, create_timestamp: '2026-09-01T10:00:00.000000+00:00', archive_timestamp: at },
    ...over,
  })

/** A Discord client in memory: the argument checks of the real one, failures on request, and the calls it was given. */
function fakeDiscord({ active = [], archived = [], channels = {}, pageSize = 100, archivedAnswer, clock } = {}) {
  const plans = []
  const d = {
    active,
    archived,
    channels,
    calls: [],
    failWhen: (method, when, error) => plans.push({ method, when, error }),
  }
  const enter = (method, args) => {
    d.calls.push([method, ...args])
    if (clock) clock.t += 1000
    for (const p of plans) if (p.method === method && p.when(...args)) throw p.error
  }
  d.activeThreads = async () => {
    enter('activeThreads', [])
    return d.active
  }
  d.archivedThreads = async (forumId, before) => {
    enter('archivedThreads', [forumId, before])
    if (!SNOWFLAKE.test(forumId)) throw new TypeError('forumId must be a Discord id.')
    if (before !== null && (typeof before !== 'string' || Number.isNaN(Date.parse(before)))) throw new TypeError('before must be a time, or null.')
    if (archivedAnswer) return archivedAnswer(before)
    const newestFirst = [...d.archived].sort((a, b) => (a.thread_metadata.archive_timestamp < b.thread_metadata.archive_timestamp ? 1 : -1))
    const older = before === null ? newestFirst : newestFirst.filter((t) => t.thread_metadata.archive_timestamp < before)
    return { threads: older.slice(0, pageSize), hasMore: older.length > pageSize }
  }
  d.messagesAfter = async (ch, after, limit = 100) => {
    enter('messagesAfter', [ch, after, limit])
    if (!SNOWFLAKE.test(ch)) throw new TypeError('channelId must be a Discord id.')
    if (typeof after !== 'string' || !/^\d{1,20}$/.test(after)) throw new TypeError('afterId must be a message id, or 0.')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be a whole number from 1 to 100.')
    return (d.channels[ch] ?? []).filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit)
  }
  d.newest = async (ch, limit = 100) => {
    enter('newest', [ch, limit])
    if (!SNOWFLAKE.test(ch)) throw new TypeError('channelId must be a Discord id.')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be a whole number from 1 to 100.')
    return [...(d.channels[ch] ?? [])].reverse().slice(0, limit)
  }
  return d
}

const needId = (value, what) => {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value) || BigInt(value) > BIGINT_MAX) throw new TypeError(`${what} must be a snowflake that fits a bigint`)
}
const needIdOrNull = (value, what) => {
  if (value !== null) needId(value, what)
}
const needList = (value, what) => {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be a list`)
}
const SYNC_FIELDS = { import_done: 'importDone', last_run_at: 'lastRunAt', last_ok_at: 'lastOkAt', last_error: 'lastError' }

/**
 * The Librarius store in memory, with the contract of the real one: ids that do not fit a bigint are a TypeError before
 * anything is written, a batch is checked whole first, an empty post list deletes nothing, deleting what is not there is
 * fine, and setSync takes the four columns and no undefined.
 */
function fakeStore({ posts = [], messages = [], cursors = {}, sync } = {}) {
  const plans = []
  const s = {
    posts: new Map(),
    messages: new Map(),
    writes: [],
    received: [],
    windowCalls: [],
    sync: sync ?? { importDone: false, lastRunAt: null, lastOkAt: null, lastError: null },
    failWhen: (method, when, error) => plans.push({ method, when, error }),
  }
  const enter = (method, ...args) => {
    for (const p of plans) if (p.method === method && p.when(...args)) throw p.error
  }
  for (const p of posts) s.posts.set(p.id, { ...p, cursor: cursors[p.id] ?? null })
  for (const m of messages) s.messages.set(m.id, m)

  Object.assign(s, {
    async upsertPost(post) {
      enter('upsertPost', post)
      needId(post.id, 'id')
      needIdOrNull(post.ownerId, 'ownerId')
      needList(post.tagIds, 'tagIds')
      s.posts.set(post.id, { ...post, cursor: s.posts.get(post.id)?.cursor ?? null })
    },
    async deletePostsNotIn(ids) {
      enter('deletePostsNotIn', ids)
      needList(ids, 'ids')
      for (const id of ids) needId(id, 'postId')
      if (ids.length === 0) return []
      const gone = [...s.posts.keys()].filter((id) => !ids.includes(id))
      for (const id of gone) {
        s.posts.delete(id)
        for (const [mId, m] of s.messages) if (m.postId === id) s.messages.delete(mId)
      }
      return gone
    },
    async upsertMessages(rows) {
      enter('upsertMessages', rows)
      s.received.push(rows)
      needList(rows, 'rows')
      for (const m of rows) {
        needId(m.id, 'id')
        needId(m.postId, 'postId')
        needId(m.authorId, 'authorId')
        needIdOrNull(m.webhookId, 'webhookId')
        needIdOrNull(m.replyTo, 'replyTo')
        for (const field of ['embeds', 'stickers', 'reactions', 'attachments']) needList(m[field], field)
      }
      if (rows.length === 0) return
      s.writes.push(rows.map((r) => r.id))
      for (const m of rows) if (s.posts.has(m.postId)) s.messages.set(m.id, m)
    },
    async deleteMessages(ids) {
      enter('deleteMessages', ids)
      needList(ids, 'ids')
      for (const id of ids) needId(id, 'messageId')
      for (const id of ids) s.messages.delete(id)
    },
    async importCursor(id) {
      enter('importCursor', id)
      needId(id, 'postId')
      return s.posts.get(id)?.cursor ?? null
    },
    async setImportCursor(id, messageId) {
      enter('setImportCursor', id, messageId)
      needId(id, 'postId')
      needId(messageId, 'messageId')
      if (s.posts.has(id)) s.posts.get(id).cursor = messageId
    },
    async windowIds(id, limit) {
      enter('windowIds', id, limit)
      needId(id, 'postId')
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a whole number of at least 1')
      s.windowCalls.push([id, limit])
      return [...s.messages.values()]
        .filter((m) => m.postId === id)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
        .slice(0, limit)
        .map((m) => ({ id: m.id, editedAt: m.editedAt === null ? null : new Date(m.editedAt).toISOString() }))
    },
    async syncStatus() {
      enter('syncStatus')
      return { ...s.sync }
    },
    async setSync(patch) {
      enter('setSync', patch)
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('patch must be an object')
      const keys = Object.keys(patch)
      if (keys.length === 0 || keys.some((k) => !(k in SYNC_FIELDS) || patch[k] === undefined)) throw new TypeError('not a sync column, or undefined')
      for (const k of keys) s.sync[SYNC_FIELDS[k]] = patch[k]
    },
  })
  return s
}

/** A world: the fake Discord, the fake store, a clock that moves a second with every call to Discord, and the importer. */
function setup({ active, archived, channels, pageSize, archivedAnswer, windowSize, store: storeOptions, ...over } = {}) {
  const clock = { t: T0, now: () => clock.t }
  const discord = fakeDiscord({ active, archived, channels, pageSize, archivedAnswer, clock })
  const store = fakeStore(storeOptions)
  const logs = []
  const imp = createImport({ discord, store, forumId: FORUM, windowSize, now: clock.now, log: (...a) => logs.push(a.join(' ')), ...over })
  return { clock, discord, store, logs, imp }
}

const reads = (w) => w.discord.calls.filter((c) => c[0] === 'messagesAfter')
const idsOf = (w, p) =>
  [...w.store.messages.values()]
    .filter((m) => m.postId === postId(p))
    .map((m) => m.id)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
const stored = (p, from, to) => channel(p, from, to).map(parseMessage)
const known = (p) => parseThread(thread(p), FORUM)

describe('createImport options', () => {
  const DISCORD = ['activeThreads', 'archivedThreads', 'messagesAfter', 'newest']
  const STORE = ['upsertPost', 'deletePostsNotIn', 'upsertMessages', 'deleteMessages', 'importCursor', 'setImportCursor', 'windowIds', 'syncStatus', 'setSync']

  it.each(DISCORD)('needs discord.%s to be a function', (name) => {
    const store = fakeStore()
    expect(() => createImport({ discord: { ...fakeDiscord(), [name]: undefined }, store, forumId: FORUM })).toThrow(new TypeError(`discord.${name} must be a function.`))
    expect(() => createImport({ discord: { ...fakeDiscord(), [name]: 'nope' }, store, forumId: FORUM })).toThrow(new TypeError(`discord.${name} must be a function.`))
  })

  it.each(STORE)('needs store.%s to be a function', (name) => {
    const discord = fakeDiscord()
    expect(() => createImport({ discord, store: { ...fakeStore(), [name]: undefined }, forumId: FORUM })).toThrow(new TypeError(`store.${name} must be a function.`))
    expect(() => createImport({ discord, store: { ...fakeStore(), [name]: {} }, forumId: FORUM })).toThrow(new TypeError(`store.${name} must be a function.`))
  })

  it('needs a discord and a store at all', () => {
    expect(() => createImport({ store: fakeStore(), forumId: FORUM })).toThrow(new TypeError('discord.activeThreads must be a function.'))
    expect(() => createImport({ discord: null, store: fakeStore(), forumId: FORUM })).toThrow(new TypeError('discord.activeThreads must be a function.'))
    expect(() => createImport({ discord: fakeDiscord(), forumId: FORUM })).toThrow(new TypeError('store.upsertPost must be a function.'))
    expect(() => createImport({ discord: fakeDiscord(), store: null, forumId: FORUM })).toThrow(new TypeError('store.upsertPost must be a function.'))
  })

  it.each([undefined, null, '', '1234567890123456', '123456789012345678901', '20000000000000040a', 200000000000000400, {}])(
    'refuses a forumId that is not a Discord id: %s',
    (forumId) => {
      expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId })).toThrow(new TypeError('forumId must be a Discord id.'))
    },
  )

  it('takes a forumId of 17 and of 20 digits', () => {
    for (const forumId of ['12345678901234567', '12345678901234567890']) {
      expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId })).not.toThrow()
    }
  })

  it.each([0, -1, 101, 1.5, NaN, Infinity, '5', null])('refuses a windowSize of %s', (windowSize) => {
    expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId: FORUM, windowSize })).toThrow(
      new RangeError('windowSize must be a whole number from 1 to 100.'),
    )
  })

  it('takes a windowSize of 1 and of 100', () => {
    for (const windowSize of [1, 100]) {
      expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId: FORUM, windowSize })).not.toThrow()
    }
  })

  it('asks Discord and the store for a window of 100 by default, and for windowSize when given', async () => {
    const def = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    await def.imp.run()
    expect(def.discord.calls.filter((c) => c[0] === 'newest')).toEqual([['newest', postId(1), 100]])
    expect(def.store.windowCalls).toEqual([[postId(1), 100]])

    const custom = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 30) }, windowSize: 7 })
    await custom.imp.run()
    expect(custom.discord.calls.filter((c) => c[0] === 'newest')).toEqual([['newest', postId(1), 7]])
    expect(custom.store.windowCalls).toEqual([[postId(1), 7]])
    // The import itself always reads full pages.
    expect(reads(custom).every((c) => c[3] === 100)).toBe(true)
  })

  it('stamps the real time and logs to console.error when it is given neither', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const discord = fakeDiscord()
      discord.failWhen('activeThreads', () => true, new Upstream('Discord is down.'))
      const store = fakeStore()
      const imp = createImport({ discord, store, forumId: FORUM })
      const before = Date.now()
      await imp.run()
      const after = Date.now()
      const status = await imp.status()
      expect(Date.parse(status.lastRunAt)).toBeGreaterThanOrEqual(before)
      expect(Date.parse(status.lastRunAt)).toBeLessThanOrEqual(after)
      expect(status.lastError).toBe('Discord is down.')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('the import', () => {
  it('imports a fresh forum: every message, each cursor at the newest id, the sync row done', async () => {
    const w = setup({
      active: [thread(1)],
      archived: [archivedThread(2, arch(5))],
      channels: { [postId(1)]: channel(1, 1, 230), [postId(2)]: channel(2, 1, 3) },
    })
    await expect(w.imp.run()).resolves.toBeUndefined()

    // 230 messages are three pages (100, 100, 30), 3 messages are one: the page is short, so there is no further read.
    expect(reads(w)).toEqual([
      ['messagesAfter', postId(1), '0', 100],
      ['messagesAfter', postId(1), mid(1, 100), 100],
      ['messagesAfter', postId(1), mid(1, 200), 100],
      ['messagesAfter', postId(2), '0', 100],
    ])
    for (const m of [...channel(1, 1, 230), ...channel(2, 1, 3)]) expect(w.store.messages.get(m.id)).toEqual(parseMessage(m))
    expect(w.store.messages.size).toBe(233)
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 230))
    expect(w.store.posts.get(postId(2)).cursor).toBe(mid(2, 3))
    // The posts themselves, as the parser reads them.
    expect(w.store.posts.get(postId(1))).toMatchObject(parseThread(thread(1), FORUM))
    expect(w.store.posts.get(postId(2))).toMatchObject(parseThread(archivedThread(2, arch(5)), FORUM))
    expect(w.store.posts.get(postId(2)).archived).toBe(true)
    // A page is stored whole, in one write.
    expect(w.store.writes.map((ids) => ids.length)).toEqual([100, 100, 30, 3])
    // last_run_at is the start of the run, last_ok_at its end: the clock moves with every call to Discord.
    expect(await w.imp.status()).toEqual({
      importDone: true,
      lastRunAt: iso(T0),
      lastOkAt: iso(T0 + w.discord.calls.length * 1000),
      lastError: null,
    })
  })

  it('reads one short page per post on a second run with nothing new, and writes nothing', async () => {
    const w = setup({
      active: [thread(1)],
      archived: [archivedThread(2, arch(5))],
      channels: { [postId(1)]: channel(1, 1, 230), [postId(2)]: channel(2, 1, 3) },
    })
    await w.imp.run()
    w.discord.calls.length = 0
    w.store.writes.length = 0
    w.store.received.length = 0
    await w.imp.run()
    expect(reads(w)).toEqual([
      ['messagesAfter', postId(1), mid(1, 230), 100],
      ['messagesAfter', postId(2), mid(2, 3), 100],
    ])
    expect(w.store.writes).toEqual([])
    // Nothing was even sent to the store to be written: no row, not even one it would then refuse.
    expect(w.store.received.flat()).toEqual([])
    expect(w.store.messages.size).toBe(233)
    expect((await w.imp.status()).importDone).toBe(true)
  })

  it('resumes after the stored cursor, never from the start', async () => {
    const w = setup({
      active: [thread(1)],
      channels: { [postId(1)]: channel(1, 1, 8) },
      store: { posts: [known(1)], messages: stored(1, 1, 5), cursors: { [postId(1)]: mid(1, 5) } },
    })
    await w.imp.run()
    expect(reads(w)).toEqual([['messagesAfter', postId(1), mid(1, 5), 100]])
    expect(idsOf(w, 1)).toEqual(channel(1, 1, 8).map((m) => m.id))
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 8))
  })

  it('starts a post with no cursor from 0, and leaves an empty post without one', async () => {
    const w = setup({ active: [thread(1)], channels: {} })
    await w.imp.run()
    expect(reads(w)).toEqual([['messagesAfter', postId(1), '0', 100]])
    expect(w.store.posts.get(postId(1)).cursor).toBeNull()
    expect((await w.imp.status()).importDone).toBe(true)
  })

  it('pages until a short page: 100 exactly takes one more read, and a page of messages it does not keep goes on too', async () => {
    const exact = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 100) } })
    await exact.imp.run()
    expect(reads(exact).map((c) => c[2])).toEqual(['0', mid(1, 100)])

    // Type 7 (a member joining) is not a kept kind: 150 of them are two pages, no rows, and the cursor still moves.
    const system = setup({
      active: [thread(1)],
      channels: { [postId(1)]: Array.from({ length: 150 }, (_, i) => raw(1, i + 1, { type: 7 })) },
    })
    await system.imp.run()
    expect(reads(system).map((c) => c[2])).toEqual(['0', mid(1, 100)])
    expect(system.store.messages.size).toBe(0)
    expect(system.store.posts.get(postId(1)).cursor).toBe(mid(1, 150))
  })

  it('stores the kept messages of a page and moves the cursor over the ones it does not keep', async () => {
    const chan = [raw(1, 1), raw(1, 2, { type: 7 }), raw(1, 3), raw(1, 4, { type: 7 })]
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: chan } })
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([mid(1, 1), mid(1, 3)])
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 4))
  })

  it('only takes the threads of the forum, and only once if a thread is in both lists', async () => {
    const w = setup({
      active: [thread(1), thread(3, { parent_id: OTHER_FORUM }), thread(4, { parent_id: undefined })],
      archived: [archivedThread(1, arch(2)), archivedThread(5, arch(1), { parent_id: OTHER_FORUM })],
      channels: { [postId(1)]: channel(1, 1, 2), [postId(3)]: channel(3, 1, 2), [postId(5)]: channel(5, 1, 2) },
    })
    await w.imp.run()
    expect([...w.store.posts.keys()]).toEqual([postId(1)])
    expect(reads(w).map((c) => c[1])).toEqual([postId(1)])
    expect(idsOf(w, 1)).toHaveLength(2)
  })

  it('walks every page of the archived threads, from the archive time of the oldest thread of the page before', async () => {
    const times = [arch(1, '000123'), arch(2, '123456'), arch(3), arch(4, '999999'), arch(5)]
    const w = setup({
      archived: times.map((at, i) => archivedThread(i + 1, at)),
      pageSize: 2,
      channels: Object.fromEntries([1, 2, 3, 4, 5].map((p) => [postId(p), channel(p, 1, 1)])),
    })
    await w.imp.run()
    // Newest first: [5, 4], [3, 2], [1]. The next `before` is the oldest of a page, exactly as Discord wrote it.
    expect(w.discord.calls.filter((c) => c[0] === 'archivedThreads')).toEqual([
      ['archivedThreads', FORUM, null],
      ['archivedThreads', FORUM, arch(4, '999999')],
      ['archivedThreads', FORUM, arch(2, '123456')],
    ])
    expect([...w.store.posts.keys()].sort()).toEqual([1, 2, 3, 4, 5].map(postId))
    expect(w.store.messages.size).toBe(5)
  })

  it('takes the oldest of a page whatever its order, and the later one of two in the same millisecond', async () => {
    const page = [archivedThread(3, arch(3)), archivedThread(5, arch(5)), archivedThread(4, arch(4))]
    const a = setup({
      archivedAnswer: (before) => (before === null ? { threads: page, hasMore: true } : { threads: [], hasMore: false }),
    })
    await a.imp.run()
    expect(a.discord.calls.filter((c) => c[0] === 'archivedThreads').map((c) => c[2])).toEqual([null, arch(3)])

    const sameMs = [archivedThread(3, arch(3, '123900')), archivedThread(4, arch(3, '123400'))]
    const b = setup({
      archivedAnswer: (before) => (before === null ? { threads: sameMs, hasMore: true } : { threads: [], hasMore: false }),
    })
    await b.imp.run()
    expect(b.discord.calls.filter((c) => c[0] === 'archivedThreads').map((c) => c[2])).toEqual([null, arch(3, '123400')])
  })

  it('skips an archive time it cannot read when it picks the next page, and still finishes', async () => {
    const page = [
      thread(3, { thread_metadata: { archived: true, archive_timestamp: 'garbage' } }),
      thread(4, { thread_metadata: undefined }),
      thread(5, { thread_metadata: null }),
      thread(6, { thread_metadata: { archived: true, archive_timestamp: 1 } }),
      archivedThread(7, arch(4)),
    ]
    const w = setup({
      archivedAnswer: (before) => (before === null ? { threads: page, hasMore: true } : { threads: [], hasMore: false }),
    })
    await w.imp.run()
    expect(w.discord.calls.filter((c) => c[0] === 'archivedThreads').map((c) => c[2])).toEqual([null, arch(4)])
    expect((await w.imp.status()).importDone).toBe(true)
  })

  it('finishes when the archived list is empty, and when its last page is empty', async () => {
    const w = setup({ archivedAnswer: () => ({ threads: [], hasMore: false }) })
    await w.imp.run()
    expect((await w.imp.status()).importDone).toBe(true)
  })

  it('deletes the posts Discord no longer lists, with their messages, and keeps the active and the archived ones', async () => {
    const w = setup({
      active: [thread(1)],
      archived: [archivedThread(2, arch(5))],
      channels: { [postId(1)]: channel(1, 1, 2), [postId(2)]: channel(2, 1, 2) },
      store: {
        posts: [known(1), parseThread(archivedThread(2, arch(5)), FORUM), known(77)],
        messages: [...stored(1, 1, 2), ...stored(2, 1, 2), ...stored(77, 1, 3)],
        cursors: { [postId(1)]: mid(1, 2), [postId(2)]: mid(2, 2), [postId(77)]: mid(77, 3) },
      },
    })
    await w.imp.run()
    expect([...w.store.posts.keys()].sort()).toEqual([postId(1), postId(2)])
    expect(idsOf(w, 77)).toEqual([])
    expect(idsOf(w, 1)).toHaveLength(2)
    expect(idsOf(w, 2)).toHaveLength(2)
  })

  it('imports nothing and deletes nothing from a forum Discord lists no thread of', async () => {
    const w = setup({ store: { posts: [known(77)], messages: stored(77, 1, 2) } })
    await w.imp.run()
    expect(w.store.posts.has(postId(77))).toBe(true)
    expect(idsOf(w, 77)).toHaveLength(2)
  })

  it('imports a forum of any size by pages of 100, wherever the cursor stands', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 350 }), fc.nat(), async (n, k) => {
        const have = k % (n + 1)
        const chan = channel(1, 1, n)
        const w = setup({
          active: [thread(1)],
          channels: { [postId(1)]: chan },
          store: {
            posts: [known(1)],
            messages: chan.slice(0, have).map(parseMessage),
            cursors: have > 0 ? { [postId(1)]: mid(1, have) } : {},
          },
        })
        await w.imp.run()
        expect(idsOf(w, 1)).toEqual(chan.map((m) => m.id))
        expect(w.store.posts.get(postId(1)).cursor).toBe(n === 0 ? null : mid(1, n))
        const calls = reads(w)
        expect(calls).toHaveLength(Math.floor((n - have) / 100) + 1)
        calls.forEach((c, i) => expect(c[2]).toBe(i === 0 && have === 0 ? '0' : mid(1, have + i * 100)))
      }),
      { numRuns: 60 },
    )
  })
})

describe('the catch-up window', () => {
  const EDITED = '2026-11-01T10:00:00.123456+00:00'
  const smallWindow = (over = {}) => ({ windowSize: 5, ...over })
  const world = ({ discordIds, storedIds, edits = {}, storedEdits = {}, ...over }) => {
    const chan = discordIds.map((n) => raw(1, n, { content: `discord ${n}`, edited_timestamp: edits[n] ?? null }))
    const rows = storedIds.map((n) => parseMessage(raw(1, n, { content: `stored ${n}`, edited_timestamp: storedEdits[n] ?? null })))
    const top = Math.max(0, ...discordIds, ...storedIds)
    return setup({
      active: [thread(1)],
      channels: { [postId(1)]: chan },
      store: { posts: [known(1)], messages: rows, cursors: { [postId(1)]: mid(1, top + 100) } },
      ...smallWindow(over),
    })
  }
  const contents = (w) => Object.fromEntries([...w.store.messages.values()].map((m) => [m.id, m.content]))

  it('deletes a stored message that Discord no longer has inside the window, and upserts an edited one only', async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const w = world({ discordIds: ids.filter((n) => n !== 8), storedIds: ids, edits: { 9: EDITED } })
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual(ids.filter((n) => n !== 8).map((n) => mid(1, n)))
    expect(w.store.messages.get(mid(1, 9)).content).toBe('discord 9')
    expect(w.store.messages.get(mid(1, 9)).editedAt).toBe(EDITED)
    expect(w.store.messages.get(mid(1, 10)).content).toBe('stored 10')
    // Only the edited one was written: nothing is rewritten that did not change.
    expect(w.store.writes).toEqual([[mid(1, 9)]])
    expect(w.store.received.flat().map((r) => r.id)).toEqual([mid(1, 9)])
    expect((await w.imp.status()).importDone).toBe(true)
  })

  it('leaves a stored message older than the whole window alone, though Discord shows it nowhere', async () => {
    const w = world({ discordIds: [6, 7, 8, 9, 10], storedIds: [2, 3, 4, 9, 10] })
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([2, 3, 4, 9, 10].map((n) => mid(1, n)))
  })

  it('leaves a stored message newer than the whole window alone', async () => {
    const w = world({ discordIds: [6, 7, 8, 9, 10], storedIds: [6, 7, 11] })
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([6, 7, 11].map((n) => mid(1, n)))
  })

  it('leaves a message that arrived after the window was read alone, and a message that arrived but is not stored', async () => {
    const w = world({ discordIds: [6, 7, 8, 9, 10], storedIds: [6, 7, 8, 9, 10] })
    const newest = w.discord.newest
    w.discord.newest = async (...args) => {
      const page = await newest(...args)
      // The live feed stores a message that came in just after Discord was asked.
      await w.store.upsertMessages([parseMessage(raw(1, 11, { content: 'live' }))])
      return page
    }
    await w.imp.run()
    expect(idsOf(w, 1)).toContain(mid(1, 11))
    expect(w.store.messages.get(mid(1, 11)).content).toBe('live')
  })

  it('does not store a message of the window that is not stored: only the cursor reads bring in new ones', async () => {
    const w = world({ discordIds: [6, 7, 8, 9, 10], storedIds: [6, 7, 9, 10] })
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([6, 7, 9, 10].map((n) => mid(1, n)))
  })

  it('judges an edit at the oldest and at the newest message of the window like any other', async () => {
    const w = world({ discordIds: [6, 7, 8, 9, 10], storedIds: [6, 7, 8, 9, 10], edits: { 6: EDITED, 10: EDITED } })
    await w.imp.run()
    expect(w.store.writes.flat().sort()).toEqual([mid(1, 6), mid(1, 10)])
  })

  it('catches a deleted message at the very edge of what is inside', async () => {
    const w = world({ discordIds: [6, 8, 9, 10], storedIds: [6, 7, 8, 9, 10] })
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([6, 8, 9, 10].map((n) => mid(1, n)))
  })

  it.each([
    ['both unedited', null, null, false],
    ['the same instant at a different precision', EDITED, '2026-11-01T10:00:00.123999+00:00', false],
    ['the same instant in another zone', EDITED, '2026-11-01T11:00:00.123+01:00', false],
    ['the same text', EDITED, EDITED, false],
    ['edited since it was stored', null, EDITED, true],
    ['an edit the stored copy has and Discord does not show', EDITED, null, true],
    ['a later edit', EDITED, '2026-11-01T10:05:00.000000+00:00', true],
    ['a millisecond later', EDITED, '2026-11-01T10:00:00.124000+00:00', true],
    ['a time that is not a time', null, 'not a time', false],
    ['a time that is not a time, over a stored edit', EDITED, 'not a time', true],
  ])('compares edit times as instants: %s', async (_, storedEdit, discordEdit, upserted) => {
    const w = world({ discordIds: [9], storedIds: [9], edits: { 9: discordEdit }, storedEdits: { 9: storedEdit } })
    await w.imp.run()
    expect(w.store.writes).toEqual(upserted ? [[mid(1, 9)]] : [])
    expect(w.store.received.flat().map((r) => r.id)).toEqual(upserted ? [mid(1, 9)] : [])
  })

  it('does not take a stored time of 1970 for no edit at all', async () => {
    const w = world({ discordIds: [9], storedIds: [9] })
    w.store.messages.get(mid(1, 9)).editedAt = '1970-01-01T00:00:00.000Z'
    await w.imp.run()
    expect(w.store.writes).toEqual([[mid(1, 9)]])
    expect(w.store.messages.get(mid(1, 9)).editedAt).toBeNull()
  })

  it('leaves a stored message alone when Discord shows it as a kind it does not keep', async () => {
    const w = world({ discordIds: [8, 9], storedIds: [8, 9] })
    w.discord.channels[postId(1)][1] = raw(1, 9, { type: 7, edited_timestamp: EDITED })
    await w.imp.run()
    expect(w.store.messages.get(mid(1, 9)).content).toBe('stored 9')
    expect(w.store.received.flat()).toEqual([])
    expect(await w.imp.status()).toMatchObject({ importDone: true, lastError: null })
  })

  it('ignores an entry of the window that has no usable id', async () => {
    const w = world({ discordIds: [6, 7, 9, 10], storedIds: [6, 7, 8, 9, 10] })
    const newest = w.discord.newest
    w.discord.newest = async (...args) => [
      ...(await newest(...args)),
      { id: 99999999999999999n, type: 0 },
      { id: 'abc' },
      { id: 123 },
      { id: 99999999999999999 },
      {},
    ]
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([6, 7, 9, 10].map((n) => mid(1, n)))
  })

  it('does nothing in a post whose window Discord answers with nothing', async () => {
    const w = world({ discordIds: [], storedIds: [6, 7, 8] })
    await w.imp.run()
    expect(idsOf(w, 1)).toHaveLength(3)
    expect((await w.imp.status()).importDone).toBe(true)
  })

  it('survives an old list of the window that holds a message the live feed has already deleted', async () => {
    const w = world({ discordIds: [6, 8, 9, 10], storedIds: [6, 8, 9, 10] })
    const windowIds = w.store.windowIds
    w.store.windowIds = async (...args) => [...(await windowIds(...args)), { id: mid(1, 7), editedAt: null }]
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([6, 8, 9, 10].map((n) => mid(1, n)))
    expect((await w.imp.status()).importDone).toBe(true)
  })

  it('matches a model of the window: only stored messages inside the page change, only for a missing or a re-edited one', async () => {
    const EDIT_POOL = [null, EDITED, '2026-11-01T10:00:00.123999+00:00', '2026-11-01T11:00:00.123+01:00', '2026-11-01T10:05:00.000000+00:00']
    const idSet = fc.uniqueArray(fc.integer({ min: 1, max: 25 }), { maxLength: 14 })
    const edit = fc.integer({ min: 0, max: EDIT_POOL.length - 1 })
    await fc.assert(
      fc.asyncProperty(idSet, idSet, fc.array(edit, { minLength: 25, maxLength: 25 }), fc.array(edit, { minLength: 25, maxLength: 25 }), fc.integer({ min: 1, max: 6 }), async (discordIds, storedIds, de, se, size) => {
        const edits = Object.fromEntries(discordIds.map((n) => [n, EDIT_POOL[de[n - 1]]]))
        const storedEdits = Object.fromEntries(storedIds.map((n) => [n, EDIT_POOL[se[n - 1]]]))
        const w = world({ discordIds: [...discordIds].sort((a, b) => a - b), storedIds, edits, storedEdits, windowSize: size })
        await w.imp.run()

        const page = [...discordIds].sort((a, b) => b - a).slice(0, size)
        const seen = [...storedIds].sort((a, b) => b - a).slice(0, size)
        const instant = (v) => (v === null ? null : Date.parse(v))
        const expected = Object.fromEntries(storedIds.map((n) => [mid(1, n), `stored ${n}`]))
        for (const n of seen) {
          const inside = page.some((p) => p < n) && page.some((p) => p > n)
          const edge = page.includes(n)
          if (edge) {
            if (instant(edits[n]) !== instant(storedEdits[n])) expected[mid(1, n)] = `discord ${n}`
          } else if (inside) {
            delete expected[mid(1, n)]
          }
        }
        // `page.includes(n)` also covers the oldest and newest of the page, which count as inside for an edit.
        expect(contents(w)).toEqual(expected)
      }),
      { numRuns: 150 },
    )
  })
})

describe('failures', () => {
  it('records a failure on page 2, leaves the cursor of page 1, and resumes from it', async () => {
    const w = setup({
      active: [thread(1), thread(2)],
      channels: { [postId(1)]: channel(1, 1, 230), [postId(2)]: channel(2, 1, 3) },
    })
    const down = new Upstream('Discord answered 500 for a page of messages.')
    w.discord.failWhen('messagesAfter', (ch, after) => after === mid(1, 100), down)
    await expect(w.imp.run()).resolves.toBeUndefined()

    expect(idsOf(w, 1)).toEqual(channel(1, 1, 100).map((m) => m.id))
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 100))
    // The run stopped: the next post was not touched.
    expect(idsOf(w, 2)).toEqual([])
    expect(await w.imp.status()).toEqual({
      importDone: false,
      lastRunAt: iso(T0),
      lastOkAt: null,
      lastError: 'Discord answered 500 for a page of messages.',
    })
  })

  it('resumes from the kept cursor once Discord answers again', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 230) } })
    let broken = true
    w.discord.failWhen('messagesAfter', (ch, after) => broken && after === mid(1, 100), new Upstream('Discord is unreachable.'))
    await w.imp.run()
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 100))
    broken = false
    w.discord.calls.length = 0
    await w.imp.run()
    expect(reads(w)[0]).toEqual(['messagesAfter', postId(1), mid(1, 100), 100])
    expect(idsOf(w, 1)).toHaveLength(230)
    expect(await w.imp.status()).toMatchObject({ importDone: true, lastError: null })
  })

  it('stores a page before it moves the cursor over it', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 230) } })
    w.store.failWhen('upsertMessages', (rows) => rows.some((r) => r.id === mid(1, 101)), new Error('connection lost'))
    await w.imp.run()
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 100))
    expect(idsOf(w, 1)).toHaveLength(100)
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastError: 'The Librarius import failed (Error).' })
  })

  it('deletes no posts when the archived list fails, on any page, or when the active list fails', async () => {
    const stale = { posts: [known(77)], messages: stored(77, 1, 2) }
    const down = new Upstream('Discord answered 500 for the archived threads.')

    const first = setup({ active: [thread(1)], store: stale })
    first.discord.failWhen('archivedThreads', () => true, down)
    await first.imp.run()
    expect(first.store.posts.has(postId(77))).toBe(true)
    expect(idsOf(first, 77)).toHaveLength(2)
    expect((await first.imp.status()).lastError).toBe('Discord answered 500 for the archived threads.')

    const later = setup({
      archived: [archivedThread(2, arch(1)), archivedThread(3, arch(2)), archivedThread(4, arch(3))],
      pageSize: 1,
      store: stale,
    })
    later.discord.failWhen('archivedThreads', (_, before) => before === arch(2), down)
    await later.imp.run()
    expect(later.store.posts.has(postId(77))).toBe(true)

    const active = setup({ store: stale })
    active.discord.failWhen('activeThreads', () => true, down)
    await active.imp.run()
    expect(active.store.posts.has(postId(77))).toBe(true)
    expect((await active.imp.status()).importDone).toBe(false)
  })

  it('records a failure of the catch-up window, with no import_done and the cursors kept', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    w.discord.failWhen('newest', () => true, new Upstream('Discord answered 503 for a page of messages.'))
    await w.imp.run()
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 3))
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastOkAt: null, lastError: 'Discord answered 503 for a page of messages.' })
  })

  it('stops at the first failure, in whichever post it is', async () => {
    const w = setup({
      active: [thread(1), thread(2)],
      channels: { [postId(1)]: channel(1, 1, 3), [postId(2)]: channel(2, 1, 3) },
    })
    w.discord.failWhen('messagesAfter', (ch) => ch === postId(1), new Upstream('Discord is unreachable.'))
    await w.imp.run()
    expect(idsOf(w, 2)).toEqual([])
    expect(w.discord.calls.some((c) => c[0] === 'newest')).toBe(false)
  })

  it('keeps import_done and last_ok_at of an earlier success through a later failure, and clears the error on the next success', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    await w.imp.run()
    const ok = await w.imp.status()
    expect(ok.importDone).toBe(true)

    let broken = true
    w.discord.failWhen('activeThreads', () => broken, new Upstream('Discord is unreachable.'))
    const start = w.clock.t
    await w.imp.run()
    expect(await w.imp.status()).toEqual({ importDone: true, lastRunAt: iso(start), lastOkAt: ok.lastOkAt, lastError: 'Discord is unreachable.' })

    broken = false
    await w.imp.run()
    expect(await w.imp.status()).toMatchObject({ importDone: true, lastError: null })
  })

  it('records what a failure says with any link cut out, and cuts it to 200 characters', async () => {
    const run = async (error) => {
      const w = setup({ active: [thread(1)] })
      w.discord.failWhen('activeThreads', () => true, error)
      await w.imp.run()
      return { error: (await w.imp.status()).lastError, logs: w.logs }
    }

    const linked = await run(new Upstream('Discord answered 403 for https://cdn.test/attachments/1/2/a.png?ex=1&hm=secret and http://a.test/b today.'))
    expect(linked.error).toBe('Discord answered 403 for [link] and [link] today.')
    expect(linked.error).not.toMatch(LINK)
    expect(linked.logs.join('\n')).not.toMatch(LINK)

    expect((await run(new Upstream('HTTPS://CDN.TEST/x?sig=secret'))).error).toBe('[link]')
    expect((await run(new Upstream('a'.repeat(200)))).error).toBe('a'.repeat(200))
    expect((await run(new Upstream('a'.repeat(201)))).error).toBe('a'.repeat(200))
    expect((await run(new Upstream('b'.repeat(5000)))).error).toBe('b'.repeat(200))
    expect((await run(new Upstream())).error).toBe('Discord is unavailable.')
    expect((await run(new Upstream(''))).error).toBe('Discord is unavailable.')
  })

  it('never records a link or more than 200 characters, whatever Discord says', async () => {
    const link = fc.constantFrom('https://cdn.test/a?x=1', 'http://a.b', 'HTTPS://UP.PER/x', 'https://')
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 120 }), link, fc.string({ maxLength: 300 }), async (before, url, after) => {
        const w = setup({ active: [thread(1)] })
        w.discord.failWhen('activeThreads', () => true, new Upstream(`${before}${url}${after}`))
        await w.imp.run()
        const { lastError } = await w.imp.status()
        expect(lastError).not.toMatch(LINK)
        expect(lastError.length).toBeLessThanOrEqual(200)
        expect(w.logs.join('\n')).not.toMatch(LINK)
      }),
      { numRuns: 100 },
    )
  })

  it.each([
    ['an Error', new Error('connect ECONNREFUSED 10.0.0.5:5432 https://x.test/secret'), 'The Librarius import failed (Error).'],
    ['a RangeError', new RangeError('limit'), 'The Librarius import failed (RangeError).'],
    ['a TypeError from Discord', new TypeError('afterId must be a message id, or 0.'), 'The Librarius import failed (TypeError).'],
    ['something that is no error', 'a plain string https://x.test/secret', 'The Librarius import failed (Error).'],
    ['nothing', undefined, 'The Librarius import failed (Error).'],
    ['a link in the name', Object.assign(new Error('x'), { name: 'Bad https://x.test/secret' }), 'The Librarius import failed (Bad [link]'],
  ])('records only the name of %s, never its message', async (_, thrown, note) => {
    const w = setup({ active: [thread(1)] })
    w.discord.failWhen('activeThreads', () => true, thrown)
    await expect(w.imp.run()).resolves.toBeUndefined()
    expect((await w.imp.status()).lastError).toBe(note)
    expect(w.logs.join('\n')).not.toMatch(LINK)
  })

  it('ends the run for a TypeError that comes from Discord, not from a row', async () => {
    const w = setup({
      active: [thread(1), thread(2)],
      channels: { [postId(1)]: channel(1, 1, 3), [postId(2)]: channel(2, 1, 3) },
    })
    w.discord.failWhen('messagesAfter', (ch) => ch === postId(1), new TypeError('afterId must be a message id, or 0.'))
    await w.imp.run()
    expect(idsOf(w, 2)).toEqual([])
    expect((await w.imp.status()).importDone).toBe(false)
  })

  it.each([
    ['importCursor', () => true],
    ['windowIds', () => true],
    ['deletePostsNotIn', () => true],
    ['deleteMessages', () => true],
    ['setSync', (patch) => 'import_done' in patch],
  ])('ends the run for a TypeError from the store outside a row write: %s', async (method, when) => {
    const w = setup({
      active: [thread(1)],
      channels: { [postId(1)]: channel(1, 1, 6) },
      store: { posts: [known(1)], messages: [...stored(1, 1, 6), ...stored(1, 7, 7)], cursors: { [postId(1)]: mid(1, 6) } },
      windowSize: 5,
    })
    w.store.failWhen(method, when, new TypeError('refused'))
    await expect(w.imp.run()).resolves.toBeUndefined()
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastError: 'The Librarius import failed (TypeError).' })
  })

  it('still resolves when the sync row cannot be written, at the start or to record a failure', async () => {
    const w = setup({ active: [thread(1)] })
    w.store.failWhen('setSync', () => true, new Error('database is down'))
    await expect(w.imp.run()).resolves.toBeUndefined()
    // Nothing was fetched: a run that could not stamp itself does not go on.
    expect(w.discord.calls).toEqual([])

    const v = setup({ active: [thread(1)] })
    v.discord.failWhen('activeThreads', () => true, new Upstream('Discord is unreachable.'))
    v.store.failWhen('setSync', (patch) => 'last_error' in patch, new Error('database is down'))
    await expect(v.imp.run()).resolves.toBeUndefined()
    expect((await v.imp.status()).lastRunAt).toBe(iso(T0))
  })

  it('stamps last_run_at before it asks Discord for anything', async () => {
    const w = setup({ active: [thread(1)] })
    w.discord.failWhen('activeThreads', () => true, new Upstream('Discord is unreachable.'))
    await w.imp.run()
    expect((await w.imp.status()).lastRunAt).toBe(iso(T0))
  })
})

describe('rows the store refuses', () => {
  it('skips a thread whose id does not fit a bigint, imports the rest, and does not give the id to the delete', async () => {
    const w = setup({
      active: [thread(1), thread(9, { id: OUT_OF_RANGE })],
      channels: { [postId(1)]: channel(1, 1, 3), [OUT_OF_RANGE]: channel(9, 1, 3) },
      store: { posts: [known(77)], messages: stored(77, 1, 2) },
    })
    await w.imp.run()
    expect(await w.imp.status()).toMatchObject({ importDone: true, lastError: null })
    expect([...w.store.posts.keys()]).toEqual([postId(1)])
    expect(idsOf(w, 1)).toHaveLength(3)
    // The stale post is still deleted: one refused thread does not hold the clean-up back.
    expect(w.store.posts.has(postId(77))).toBe(false)
    // And nothing was read for the thread that could not be stored.
    expect(w.discord.calls.some((c) => c[1] === OUT_OF_RANGE)).toBe(false)
  })

  it('takes a thread whose id is the largest a bigint holds, and keeps its stored post through the delete', async () => {
    const MAX = '9223372036854775807'
    const w = setup({
      active: [thread(1, { id: MAX }), thread(2)],
      channels: { [MAX]: [raw(1, 1, { channel_id: MAX })] },
      store: { posts: [{ ...known(1), id: MAX }], messages: [] },
    })
    await w.imp.run()
    expect(w.store.posts.has(MAX)).toBe(true)
    expect(reads(w).map((c) => c[1])).toEqual([MAX, postId(2)])
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it('refuses the id just past the largest a bigint holds, as it refuses a far larger one', async () => {
    const w = setup({ active: [thread(1, { id: '9223372036854775808' }), thread(2)], channels: { [postId(2)]: channel(2, 1, 2) } })
    await w.imp.run()
    expect([...w.store.posts.keys()]).toEqual([postId(2)])
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it('keeps a stored post whose refreshed row the store refuses, and does not read its messages', async () => {
    const w = setup({
      active: [thread(1), thread(2, { owner_id: OUT_OF_RANGE })],
      channels: { [postId(1)]: channel(1, 1, 2), [postId(2)]: channel(2, 1, 5) },
      store: { posts: [known(2)], messages: stored(2, 1, 2), cursors: { [postId(2)]: mid(2, 2) } },
    })
    await w.imp.run()
    expect(await w.imp.status()).toMatchObject({ importDone: true })
    expect(w.store.posts.get(postId(2)).ownerId).toBe(OWNER)
    expect(idsOf(w, 2)).toHaveLength(2)
    expect(reads(w).map((c) => c[1])).toEqual([postId(1)])
  })

  it('skips only the message the store refuses, and stores the rest of its page', async () => {
    const chan = channel(1, 1, 5)
    chan[2] = raw(1, 3, { author: { id: OUT_OF_RANGE, username: 'invented-member' } })
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: chan } })
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([1, 2, 4, 5].map((n) => mid(1, n)))
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 5))
    expect(await w.imp.status()).toMatchObject({ importDone: true, lastError: null })
  })

  it('skips a message whose own id does not fit, and the cursor it cannot take, and goes on', async () => {
    const chan = [...channel(1, 1, 99), raw(1, 0, { id: OUT_OF_RANGE })]
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: chan } })
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual(channel(1, 1, 99).map((m) => m.id))
    // The cursor could not be set to a bad id, so it stays where it was; the read went on from the bad id in memory.
    expect(w.store.posts.get(postId(1)).cursor).toBeNull()
    expect(reads(w).map((c) => c[2])).toEqual(['0', OUT_OF_RANGE])
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it('goes on to the next page and moves the cursor there when a page before it was refused one row', async () => {
    const chan = channel(1, 1, 130)
    chan[40] = raw(1, 41, { webhook_id: OUT_OF_RANGE })
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: chan } })
    await w.imp.run()
    expect(idsOf(w, 1)).toHaveLength(129)
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 130))
  })

  it('refuses an edit row of the window the same way, and goes on', async () => {
    const w = setup({
      active: [thread(1)],
      channels: {
        [postId(1)]: [
          raw(1, 8),
          raw(1, 9, { edited_timestamp: '2026-11-01T10:00:00.123456+00:00', author: { id: OUT_OF_RANGE, username: 'invented-member' } }),
          raw(1, 10, { edited_timestamp: '2026-11-01T10:00:00.123456+00:00', content: 'edited' }),
        ],
      },
      store: { posts: [known(1)], messages: stored(1, 8, 10), cursors: { [postId(1)]: mid(1, 10) } },
      windowSize: 5,
    })
    await w.imp.run()
    expect(w.store.messages.get(mid(1, 10)).content).toBe('edited')
    expect(w.store.messages.get(mid(1, 9)).content).toBe('invented text 9')
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it('logs what the store refused without a link, and the run is not ended by it', async () => {
    const w = setup({ active: [thread(1), thread(2)], channels: { [postId(1)]: channel(1, 1, 2) } })
    w.store.failWhen('upsertPost', (post) => post.id === postId(2), new TypeError('refused https://cdn.test/x?sig=secret'))
    await w.imp.run()
    expect(w.logs.join('\n')).not.toMatch(LINK)
    expect(await w.imp.status()).toMatchObject({ importDone: true })
    expect([...w.store.posts.keys()]).toEqual([postId(1)])
  })

  it('ends the run for a refusal that is not a TypeError', async () => {
    const w = setup({ active: [thread(1), thread(2)], channels: { [postId(2)]: channel(2, 1, 2) } })
    w.store.failWhen('upsertPost', (post) => post.id === postId(2), Object.assign(new Error('deadlock'), { code: '40P01' }))
    await w.imp.run()
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastError: 'The Librarius import failed (Error).' })
    expect(reads(w)).toEqual([])
  })

  it('refuses a batch whole and a row alone: the rest of the rows are written one by one', async () => {
    const chan = channel(1, 1, 4)
    chan[0] = raw(1, 1, { reply_to: undefined, author: { id: OUT_OF_RANGE, username: 'invented-member' } })
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: chan } })
    await w.imp.run()
    expect(w.store.writes).toEqual([[mid(1, 2)], [mid(1, 3)], [mid(1, 4)]])
  })
})

describe('hostile answers from Discord', () => {
  it('ends the run when the archived list says there is more but gives no time to go on from', async () => {
    const answers = [
      [],
      [thread(3, { thread_metadata: undefined })],
      [thread(3, { thread_metadata: { archived: true, archive_timestamp: 'garbage' } })],
      [thread(3, { thread_metadata: { archived: true, archive_timestamp: null } })],
      [thread(3, { thread_metadata: { archived: true, archive_timestamp: 1 } })],
    ]
    for (const threads of answers) {
      const w = setup({ archivedAnswer: () => ({ threads, hasMore: true }), store: { posts: [known(77)], messages: stored(77, 1, 1) } })
      await w.imp.run()
      expect(w.store.posts.has(postId(77))).toBe(true)
      expect(await w.imp.status()).toMatchObject({ importDone: false })
      expect((await w.imp.status()).lastError).toMatch(/archived/)
      expect(w.discord.calls.filter((c) => c[0] === 'archivedThreads')).toHaveLength(1)
    }
  })

  it('ends the run when a later page says there is more but gives no time to go on from', async () => {
    let asked = 0
    const w = setup({
      archivedAnswer: (before) => {
        if (++asked > 5) throw new Error('asked for ever')
        return before === null
          ? { threads: [archivedThread(3, arch(3))], hasMore: true }
          : { threads: [thread(4, { thread_metadata: undefined })], hasMore: true }
      },
      store: { posts: [known(77)], messages: [] },
    })
    await w.imp.run()
    expect(w.discord.calls.filter((c) => c[0] === 'archivedThreads').map((c) => c[2])).toEqual([null, arch(3)])
    expect(w.store.posts.has(postId(77))).toBe(true)
    expect((await w.imp.status()).lastError).toMatch(/archived/)
  })

  it('ends the run when the archived list gives the same page again, instead of asking for ever', async () => {
    const w = setup({
      archivedAnswer: () => ({ threads: [archivedThread(3, arch(3))], hasMore: true }),
      store: { posts: [known(77)], messages: [] },
    })
    await w.imp.run()
    expect(w.discord.calls.filter((c) => c[0] === 'archivedThreads').map((c) => c[2])).toEqual([null, arch(3)])
    expect(w.store.posts.has(postId(77))).toBe(true)
    expect((await w.imp.status()).importDone).toBe(false)
  })

  it('ends the run when a page of messages does not move on from the cursor, and stores nothing of it', async () => {
    for (const ids of [[mid(1, 3)], [mid(1, 4)], [mid(1, 1), mid(1, 4)]]) {
      const w = setup({
        active: [thread(1)],
        store: { posts: [known(1)], messages: [], cursors: { [postId(1)]: mid(1, 4) } },
      })
      w.discord.messagesAfter = async () => ids.map((id) => ({ ...raw(1, 1), id }))
      await w.imp.run()
      expect(w.store.writes).toEqual([])
      expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 4))
      expect(await w.imp.status()).toMatchObject({ importDone: false })
      expect((await w.imp.status()).lastError).toMatch(/messages/)
    }
  })

  it('takes a page whose last id is just past the cursor', async () => {
    const w = setup({
      active: [thread(1)],
      store: { posts: [known(1)], messages: [], cursors: { [postId(1)]: mid(1, 4) } },
    })
    let asked = 0
    w.discord.messagesAfter = async () => (asked++ === 0 ? [raw(1, 5)] : [])
    await w.imp.run()
    expect(w.store.posts.get(postId(1)).cursor).toBe(mid(1, 5))
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it.each([
    ['a number', 200000010000000005],
    ['a word', 'abc'],
    ['nothing', undefined],
    ['null', null],
    ['too short', '1234'],
    ['too long', '123456789012345678901'],
  ])('ends the run when the last message of a page has an id that is %s', async (_, id) => {
    const w = setup({ active: [thread(1)] })
    w.discord.messagesAfter = async () => [raw(1, 1), { ...raw(1, 2), id }]
    await w.imp.run()
    expect(w.store.writes).toEqual([])
    expect(await w.imp.status()).toMatchObject({ importDone: false })
    expect((await w.imp.status()).lastError).toMatch(/messages/)
  })

  it('does not take a message of a page that cannot be parsed, but moves past it', async () => {
    const w = setup({ active: [thread(1)] })
    let asked = 0
    w.discord.messagesAfter = async () => (asked++ === 0 ? [raw(1, 1, { author: null }), raw(1, 2, { id: 'abc' }), raw(1, 3)] : [])
    await w.imp.run()
    expect(idsOf(w, 1)).toEqual([mid(1, 3)])
  })
})

describe('overlap', () => {
  it('makes one pass for overlapping calls, and a fresh one for a call after it', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const activeThreads = w.discord.activeThreads
    w.discord.activeThreads = async () => {
      await gate
      return activeThreads()
    }
    const calls = () => w.discord.calls.filter((c) => c[0] === 'activeThreads').length

    const a = w.imp.run()
    const b = w.imp.run()
    await Promise.resolve()
    const c = w.imp.run()
    release()
    await expect(Promise.all([a, b, c])).resolves.toEqual([undefined, undefined, undefined])
    expect(calls()).toBe(1)

    await w.imp.run()
    expect(calls()).toBe(2)
  })

  it('shares a failed pass too, resolves every caller, and lets the next call try again', async () => {
    const w = setup({ active: [thread(1)] })
    let release
    const gate = new Promise((r) => {
      release = r
    })
    let broken = true
    const activeThreads = w.discord.activeThreads
    w.discord.activeThreads = async () => {
      await gate
      if (broken) throw new Upstream('Discord is unreachable.')
      return activeThreads()
    }
    const a = w.imp.run()
    const b = w.imp.run()
    release()
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined])
    expect((await w.imp.status()).lastError).toBe('Discord is unreachable.')

    broken = false
    await w.imp.run()
    expect(await w.imp.status()).toMatchObject({ importDone: true, lastError: null })
  })

  it('is idempotent: a second pass over the same Discord changes nothing', async () => {
    const w = setup({
      active: [thread(1)],
      archived: [archivedThread(2, arch(3))],
      channels: { [postId(1)]: channel(1, 1, 120), [postId(2)]: channel(2, 1, 5) },
    })
    await w.imp.run()
    const before = JSON.stringify([...w.store.messages.entries()])
    const posts = JSON.stringify([...w.store.posts.entries()])
    await w.imp.run()
    await w.imp.run()
    expect(JSON.stringify([...w.store.messages.entries()])).toBe(before)
    expect(JSON.stringify([...w.store.posts.entries()])).toBe(posts)
  })
})

describe('status', () => {
  it('is what the store says, before any run and after one', async () => {
    const sync = { importDone: false, lastRunAt: null, lastOkAt: null, lastError: null }
    const w = setup({ store: { sync } })
    expect(await w.imp.status()).toEqual(sync)
    await w.imp.run()
    expect(await w.imp.status()).toEqual({ importDone: true, lastRunAt: iso(T0), lastOkAt: iso(T0 + w.discord.calls.length * 1000), lastError: null })
  })

  it('hands on whatever the store gives, unchanged', async () => {
    const odd = { importDone: true, lastRunAt: 'x', lastOkAt: 7, lastError: { a: 1 }, extra: 'kept' }
    const w = setup({ store: { sync: odd } })
    expect(await w.imp.status()).toEqual(odd)
  })
})
