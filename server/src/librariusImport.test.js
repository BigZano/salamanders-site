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

/** Timers that run nothing by themselves: a test fires the live ones, as librariusLinks.test.js does. */
function fakeTimers() {
  const jobs = []
  return {
    jobs,
    setTimeout: (fn, ms) => jobs.push({ fn, ms, over: false }) - 1,
    clearTimeout: (id) => {
      if (jobs[id]) jobs[id].over = true
    },
    live: () => jobs.filter((j) => !j.over),
  }
}

/** A world: the fake Discord, the fake store, a clock that moves a second with every call to Discord, and the importer. */
function setup({ active, archived, channels, pageSize, archivedAnswer, windowSize, store: storeOptions, ...over } = {}) {
  const clock = { t: T0, now: () => clock.t }
  const discord = fakeDiscord({ active, archived, channels, pageSize, archivedAnswer, clock })
  const store = fakeStore(storeOptions)
  const logs = []
  const timers = fakeTimers()
  const imp = createImport({ discord, store, forumId: FORUM, windowSize, now: clock.now, timers, log: (...a) => logs.push(a.join(' ')), ...over })
  return { clock, discord, store, logs, timers, imp }
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
      expect(status.lastError).toBe('Error: Discord is down.')
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
      lastError: 'Error: Discord answered 500 for a page of messages.',
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
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastError: 'Error: connection lost' })
  })

  it('deletes no posts when the archived list fails, on any page, or when the active list fails', async () => {
    const stale = { posts: [known(77)], messages: stored(77, 1, 2) }
    const down = new Upstream('Discord answered 500 for the archived threads.')

    const first = setup({ active: [thread(1)], store: stale })
    first.discord.failWhen('archivedThreads', () => true, down)
    await first.imp.run()
    expect(first.store.posts.has(postId(77))).toBe(true)
    expect(idsOf(first, 77)).toHaveLength(2)
    expect((await first.imp.status()).lastError).toBe('Error: Discord answered 500 for the archived threads.')

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
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastOkAt: null, lastError: 'Error: Discord answered 503 for a page of messages.' })
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
    expect(await w.imp.status()).toEqual({ importDone: true, lastRunAt: iso(start), lastOkAt: ok.lastOkAt, lastError: 'Error: Discord is unreachable.' })

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
    expect(linked.error).toBe('Error: Discord answered 403 for [link] and [link] today.')
    expect(linked.error).not.toMatch(LINK)
    expect(linked.logs.join('\n')).not.toMatch(LINK)

    expect((await run(new Upstream('HTTPS://CDN.TEST/x?sig=secret'))).error).toBe('Error: [link]')
    // A Discord CDN link with no scheme is a link too.
    const bare = await run(new Upstream('Discord answered 403 for cdn.discordapp.com/attachments/1/2/a.png?ex=1&hm=secret and MEDIA.discordapp.net/a?hm=secret today.'))
    expect(bare.error).toBe('Error: Discord answered 403 for [link] and [link] today.')
    expect(bare.logs.join('\n')).not.toMatch(/discordapp|secret/i)
    expect((await run(new Upstream('wss://gateway.test/?v=10'))).error).toBe('Error: [link]')
    // The name and its colon take 7 of the 200 characters.
    expect((await run(new Upstream('a'.repeat(192)))).error).toBe(`Error: ${'a'.repeat(192)}`)
    expect((await run(new Upstream('a'.repeat(193)))).error).toBe(`Error: ${'a'.repeat(193)}`)
    expect((await run(new Upstream('a'.repeat(194)))).error).toBe(`Error: ${'a'.repeat(193)}`)
    expect((await run(new Upstream('b'.repeat(5000)))).error).toBe(`Error: ${'b'.repeat(193)}`)
    expect((await run(new Upstream())).error).toBe('Error: ')
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
    ['an Error', new Error('connect ECONNREFUSED 10.0.0.5:5432 https://x.test/secret'), 'Error: connect ECONNREFUSED 10.0.0.5:5432 [link]'],
    ['a RangeError', new RangeError('limit'), 'RangeError: limit'],
    ['a TypeError from Discord', new TypeError('afterId must be a message id, or 0.'), 'TypeError: afterId must be a message id, or 0.'],
    ['something that is no error', 'a plain string https://x.test/secret', 'Error: '],
    ['nothing', undefined, 'Error: '],
    ['a link in the name', Object.assign(new Error('x'), { name: 'Bad https://x.test/secret' }), 'Bad [link] x'],
    ['a name that is a Symbol', Object.assign(new Error('x'), { name: Symbol('name'), message: 'it broke' }), 'Symbol(name): it broke'],
    ['a message that is a Symbol', Object.assign(new Error('x'), { message: Symbol('message') }), 'Error: Symbol(message)'],
    ['a name that cannot be read', Object.defineProperty(new Error('it broke'), 'name', { get: () => { throw new Error('no name') } }), 'Error: it broke'],
    ['a message that cannot be read', Object.defineProperty(new RangeError('x'), 'message', { get: () => { throw new Error('no message') } }), 'RangeError: '],
    ['neither name nor message readable', Object.defineProperties(new Error('x'), { name: { get: () => { throw new Error('no name') } }, message: { get: () => { throw new Error('no message') } } }), 'Error: '],
    ['an object that cannot be read at all', new Proxy({}, { get: () => { throw new Error('trap') } }), 'Error: '],
    ['an object with no prototype', Object.create(null), 'Error: '],
  ])('records what describe() says of %s, and never loses the record', async (_, thrown, said) => {
    const w = setup({ active: [thread(1)] })
    w.discord.failWhen('activeThreads', () => true, thrown)
    await expect(w.imp.run()).resolves.toBeUndefined()
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastOkAt: null, lastError: said })
    expect(w.logs.join('\n')).not.toMatch(LINK)
  })

  it('records an Upstream the same way: describe() names an Upstream an Error, as it is one', async () => {
    const w = setup({ active: [thread(1)] })
    w.discord.failWhen('activeThreads', () => true, new Upstream('Discord is down.'))
    await w.imp.run()
    expect((await w.imp.status()).lastError).toBe('Error: Discord is down.')
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
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastError: 'TypeError: refused' })
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

  it('logs what the store refused without any link, a Discord CDN one with no scheme too, and without being stopped by an unreadable message', async () => {
    const unreadable = Object.defineProperty(new TypeError('x'), 'message', { get: () => { throw new Error('no message') } })
    for (const refusal of [new TypeError('refused cdn.discordapp.com/attachments/1/2/a.png?sig=secret'), new TypeError('refused HTTPS://MEDIA.test/x?sig=secret'), unreadable]) {
      const w = setup({ active: [thread(1), thread(2)], channels: { [postId(1)]: channel(1, 1, 2) } })
      w.store.failWhen('upsertPost', (post) => post.id === postId(2), refusal)
      await w.imp.run()
      expect(w.logs.join('\n')).not.toMatch(/discordapp|secret|HTTPS/i)
      expect(await w.imp.status()).toMatchObject({ importDone: true })
      expect([...w.store.posts.keys()]).toEqual([postId(1)])
    }
  })

  it('ends the run for a refusal that is not a TypeError', async () => {
    const w = setup({ active: [thread(1), thread(2)], channels: { [postId(2)]: channel(2, 1, 2) } })
    w.store.failWhen('upsertPost', (post) => post.id === postId(2), Object.assign(new Error('deadlock'), { code: '40P01' }))
    await w.imp.run()
    expect(await w.imp.status()).toMatchObject({ importDone: false, lastError: 'Error: deadlock' })
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

/** Make every call to Discord's active threads wait until the test lets that one go. → the list of waiting calls. */
function gateActive(w) {
  const gates = []
  const activeThreads = w.discord.activeThreads
  w.discord.activeThreads = async () => {
    const gate = Promise.withResolvers()
    gates.push(gate)
    // Letting a call go with `false` makes it fail.
    if ((await gate.promise) === false) throw new Upstream('Discord is unreachable.')
    return activeThreads()
  }
  return gates
}
const settle = () => new Promise((r) => setTimeout(r, 0))
const passes = (w) => w.discord.calls.filter((c) => c[0] === 'activeThreads').length

describe('overlap', () => {
  it('queues exactly one follow-up for the calls made during a run, and starts it after that run', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    const gates = gateActive(w)
    const done = []
    const a = w.imp.run().then(() => done.push('a'))
    const b = w.imp.run().then(() => done.push('b'))
    await Promise.resolve()
    const c = w.imp.run().then(() => done.push('c'))
    await settle()
    // One pass is going, and the follow-up has not started.
    expect(gates).toHaveLength(1)
    expect(done).toEqual([])

    gates[0].resolve()
    await settle()
    // The first pass is over, and its caller is told; the follow-up is going, and its callers wait for it.
    expect(done).toEqual(['a'])
    expect(gates).toHaveLength(2)

    gates[1].resolve()
    await Promise.all([a, b, c])
    expect(done).toEqual(['a', 'b', 'c'])
    expect(passes(w)).toBe(2)
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it('makes one pass, and queues nothing, for a call made when none is going', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    await w.imp.run()
    await settle()
    expect(passes(w)).toBe(1)
  })

  it('queues another follow-up for a call made during the follow-up, and never runs two passes at once', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    const gates = gateActive(w)
    const first = w.imp.run()
    const second = w.imp.run()
    await settle()
    gates[0].resolve()
    await settle()
    expect(gates).toHaveLength(2)
    const third = w.imp.run()
    const fourth = w.imp.run()
    await settle()
    expect(gates).toHaveLength(2)
    gates[1].resolve()
    await settle()
    expect(gates).toHaveLength(3)
    gates[2].resolve()
    await expect(Promise.all([first, second, third, fourth])).resolves.toEqual([undefined, undefined, undefined, undefined])
    expect(passes(w)).toBe(3)
  })

  it('makes a fresh pass for a call made after everything has ended', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    await w.imp.run()
    await w.imp.run()
    expect(passes(w)).toBe(2)
  })

  it('runs the follow-up after a pass that failed, resolves every caller, and goes on to the next call', async () => {
    const w = setup({ active: [thread(1)] })
    const gates = gateActive(w)
    let broken = true
    const original = w.discord.activeThreads
    w.discord.activeThreads = async () => {
      const found = await original()
      if (broken) throw new Upstream('Discord is unreachable.')
      return found
    }
    const a = w.imp.run()
    const b = w.imp.run()
    await settle()
    gates[0].resolve()
    await settle()
    expect((await w.imp.status()).lastError).toBe('Error: Discord is unreachable.')
    broken = false
    gates[1].resolve()
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined])
    expect(await w.imp.status()).toMatchObject({ importDone: true, lastError: null })
    expect(passes(w)).toBe(2)
  })

  it('still resolves every caller, and can run again, when the log itself throws', async () => {
    const w = setup({
      active: [thread(1)],
      channels: { [postId(1)]: channel(1, 1, 2) },
      log: () => {
        throw new Error('the log is closed')
      },
    })
    let broken = true
    w.discord.failWhen('activeThreads', () => broken, new Upstream('Discord is unreachable.'))
    const gates = gateActive(w)
    const a = w.imp.run()
    const b = w.imp.run()
    await settle()
    gates[0].resolve()
    await settle()
    broken = false
    gates[1].resolve()
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined])
    expect(passes(w)).toBe(2)

    w.discord.activeThreads = async () => []
    await expect(w.imp.run()).resolves.toBeUndefined()
    expect(await w.imp.status()).toMatchObject({ importDone: true })
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

describe('onPostsListed', () => {
  const FIVE = { active: [thread(1), thread(2)], channels: { [postId(1)]: channel(1, 1, 3), [postId(2)]: channel(2, 1, 2) } }

  it('is called once after the posts are stored and the stale ones deleted, and before any message is read', async () => {
    const seen = []
    let w
    w = setup({
      ...FIVE,
      store: { posts: [known(77)], messages: stored(77, 1, 2) },
      onPostsListed: () => seen.push({ posts: [...w.store.posts.keys()].sort(), reads: reads(w).length, messages: w.store.messages.size }),
    })
    await w.imp.run()
    expect(seen).toEqual([{ posts: [postId(1), postId(2)], reads: 0, messages: 0 }])
    expect(w.store.messages.size).toBe(5)
  })

  it('is called once for each run', async () => {
    let calls = 0
    const w = setup({ ...FIVE, onPostsListed: () => calls++ })
    await w.imp.run()
    await w.imp.run()
    expect(calls).toBe(2)
  })

  it('is waited for before the first message is read', async () => {
    const gate = Promise.withResolvers()
    const w = setup({ ...FIVE, onPostsListed: () => gate.promise })
    const run = w.imp.run()
    await settle()
    expect(reads(w)).toEqual([])
    expect(w.store.posts.size).toBe(2)
    gate.resolve()
    await run
    expect(reads(w)).toHaveLength(2)
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it('is not called when the posts could not be listed or stored', async () => {
    for (const [method, error] of [
      ['activeThreads', new Upstream('Discord is down.')],
      ['archivedThreads', new Upstream('Discord is down.')],
      ['deletePostsNotIn', new Error('database is down')],
    ]) {
      let calls = 0
      const w = setup({ ...FIVE, onPostsListed: () => calls++ })
      if (method === 'deletePostsNotIn') w.store.failWhen(method, () => true, error)
      else w.discord.failWhen(method, () => true, error)
      await w.imp.run()
      expect(calls).toBe(0)
      expect(await w.imp.status()).toMatchObject({ importDone: false })
    }
  })

  it('ends the run when it throws or rejects, so the next run calls it again', async () => {
    for (const hook of [
      () => {
        throw new Error('the known set could not be loaded')
      },
      () => Promise.reject(new Error('the known set could not be loaded')),
    ]) {
      const w = setup({ ...FIVE, onPostsListed: hook })
      await expect(w.imp.run()).resolves.toBeUndefined()
      expect(reads(w)).toEqual([])
      expect(await w.imp.status()).toMatchObject({ importDone: false, lastError: 'Error: the known set could not be loaded' })
    }
  })

  it.each(['x', null, 1, {}])('must be a function: %s', (onPostsListed) => {
    expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId: FORUM, onPostsListed })).toThrow(new TypeError('onPostsListed must be a function.'))
  })
})

describe('the timer chain', () => {
  const EVERY = 21_600_000
  const RETRY = [300_000, 600_000, 1_200_000, 1_800_000]
  /** Fire the one live timer and let the run it starts finish. */
  async function fire(w) {
    const [job] = w.timers.live()
    job.over = true
    job.fn()
    await settle()
  }
  const delays = (w) => w.timers.live().map((j) => j.ms)
  /** A world whose active list fails while `state.broken` is true. */
  const flaky = (options) => {
    const state = { broken: true }
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 2) }, ...options })
    w.discord.failWhen('activeThreads', () => state.broken, new Upstream('Discord is unreachable.'))
    return { w, state }
  }

  it('starts one timer, six hours out by default, and runs nothing yet', () => {
    const w = setup({ active: [thread(1)] })
    w.imp.start()
    expect(delays(w)).toEqual([EVERY])
    expect(w.discord.calls).toEqual([])
  })

  it('runs the import when the timer fires, and sets the next one the same distance after the run', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 3) } })
    w.imp.start()
    await fire(w)
    expect(await w.imp.status()).toMatchObject({ importDone: true })
    expect(idsOf(w, 1)).toHaveLength(3)
    expect(delays(w)).toEqual([EVERY])
    await fire(w)
    expect(passes(w)).toBe(2)
    expect(delays(w)).toEqual([EVERY])
  })

  it('uses the interval it is given', async () => {
    const w = setup({ active: [thread(1)], everyMs: 1234 })
    w.imp.start()
    expect(delays(w)).toEqual([1234])
    await fire(w)
    expect(delays(w)).toEqual([1234])
  })

  it('is one timer however many times it is started', async () => {
    const w = setup({ active: [thread(1)] })
    w.imp.start()
    w.imp.start()
    w.imp.start()
    expect(delays(w)).toEqual([EVERY])
    expect(w.timers.jobs).toHaveLength(1)
    await fire(w)
    w.imp.start()
    expect(delays(w)).toEqual([EVERY])
  })

  it('retries a failed run after 5, 10, 20 and then 30 minutes each time, and goes back to the catch-up after a success', async () => {
    const { w, state } = flaky()
    w.imp.start()
    await fire(w)
    expect(delays(w)).toEqual([300_000])
    await fire(w)
    expect(delays(w)).toEqual([600_000])
    await fire(w)
    expect(delays(w)).toEqual([1_200_000])
    await fire(w)
    expect(delays(w)).toEqual([1_800_000])
    await fire(w)
    expect(delays(w)).toEqual([1_800_000])
    await fire(w)
    expect(delays(w)).toEqual([1_800_000])
    state.broken = false
    await fire(w)
    expect(await w.imp.status()).toMatchObject({ importDone: true, lastError: null })
    expect(delays(w)).toEqual([EVERY])
    // The backoff starts again from the first step.
    state.broken = true
    await fire(w)
    expect(delays(w)).toEqual([300_000])
  })

  it('takes the retry steps it is given, and keeps the last one', async () => {
    const { w } = flaky({ retryMs: [10, 20, 40] })
    w.imp.start()
    const steps = []
    for (let i = 0; i < 5; i++) {
      await fire(w)
      steps.push(...delays(w))
    }
    expect(steps).toEqual([10, 20, 40, 40, 40])
  })

  it('takes one retry step as every step', async () => {
    const { w } = flaky({ retryMs: [7] })
    w.imp.start()
    await fire(w)
    await fire(w)
    expect(delays(w)).toEqual([7])
  })

  it('retries a run asked for with run() that fails, and the catch-up it replaces is cleared', async () => {
    const { w, state } = flaky()
    w.imp.start()
    await w.imp.run()
    expect(delays(w)).toEqual([300_000])
    expect(w.timers.live()).toHaveLength(1)
    state.broken = false
    await fire(w)
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it('counts the catch-up from the end of a run asked for with run(), and leaves one timer', async () => {
    const w = setup({ active: [thread(1)] })
    w.imp.start()
    const first = w.timers.jobs[0]
    await w.imp.run()
    expect(first.over).toBe(true)
    expect(delays(w)).toEqual([EVERY])
    expect(w.timers.jobs).toHaveLength(2)
  })

  it('sets no timer at all for a run when it was never started, whether it succeeded or failed', async () => {
    const { w, state } = flaky()
    await w.imp.run()
    state.broken = false
    await w.imp.run()
    expect(w.timers.jobs).toEqual([])
  })

  it('sets no timer for a run while it is going, and one when it ends, if it is started during it', async () => {
    const w = setup({ active: [thread(1)] })
    const gates = gateActive(w)
    const run = w.imp.run()
    w.imp.start()
    expect(w.timers.jobs).toEqual([])
    await settle()
    gates[0].resolve()
    await run
    expect(delays(w)).toEqual([EVERY])
  })

  it('waits the retry step, not the catch-up, when it is started after a run that failed', async () => {
    const { w } = flaky()
    await w.imp.run()
    w.imp.start()
    expect(delays(w)).toEqual([300_000])
  })

  it('waits the catch-up when it is started after a run that succeeded', async () => {
    const w = setup({ active: [thread(1)] })
    await w.imp.run()
    w.imp.start()
    expect(delays(w)).toEqual([EVERY])
  })

  it('resets the backoff when a follow-up succeeds after a run that failed, and sets one timer', async () => {
    const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 2) } })
    const gates = gateActive(w)
    let broken = true
    const original = w.discord.activeThreads
    w.discord.activeThreads = async () => {
      const found = await original()
      if (broken) throw new Upstream('Discord is unreachable.')
      return found
    }
    w.imp.start()
    const a = w.imp.run()
    const b = w.imp.run()
    await settle()
    gates[0].resolve()
    await settle()
    broken = false
    gates[1].resolve()
    await Promise.all([a, b])
    expect(await w.imp.status()).toMatchObject({ importDone: true })
    expect(delays(w)).toEqual([EVERY])
  })

  it('stops: the pending timer is cleared and nothing is scheduled', async () => {
    const w = setup({ active: [thread(1)] })
    w.imp.start()
    w.imp.stop()
    expect(w.timers.live()).toEqual([])
    await settle()
    expect(w.timers.live()).toEqual([])
    expect(w.discord.calls).toEqual([])
  })

  it('does nothing if a timer it cleared fires anyway', async () => {
    const w = setup({ active: [thread(1)] })
    w.imp.start()
    w.imp.stop()
    w.timers.jobs[0].fn()
    await settle()
    expect(w.discord.calls).toEqual([])
    expect(w.timers.live()).toEqual([])
  })

  it('does not schedule another run when it is stopped during one', async () => {
    const w = setup({ active: [thread(1)] })
    const gates = gateActive(w)
    w.imp.start()
    w.timers.live()[0].fn()
    await settle()
    w.imp.stop()
    gates[0].resolve()
    await settle()
    expect(w.timers.live()).toEqual([])
    expect(await w.imp.status()).toMatchObject({ importDone: true })
  })

  it('does not retry a failed run when it is stopped during it', async () => {
    const { w } = flaky()
    w.imp.start()
    const gates = gateActive(w)
    w.timers.live()[0].fn()
    await settle()
    w.imp.stop()
    gates[0].resolve()
    await settle()
    expect(w.timers.live()).toEqual([])
  })

  it('may be stopped when it was never started, and twice, and still runs when asked', async () => {
    const w = setup({ active: [thread(1)] })
    expect(() => w.imp.stop()).not.toThrow()
    w.imp.start()
    w.imp.stop()
    expect(() => w.imp.stop()).not.toThrow()
    await w.imp.run()
    expect(await w.imp.status()).toMatchObject({ importDone: true })
    expect(w.timers.live()).toEqual([])
  })

  it('may be started again after it was stopped', () => {
    const w = setup({ active: [thread(1)] })
    w.imp.start()
    w.imp.stop()
    w.imp.start()
    expect(delays(w)).toEqual([EVERY])
  })

  it('is one chain when it is stopped and started during a run', async () => {
    const w = setup({ active: [thread(1)] })
    const gates = gateActive(w)
    w.imp.start()
    const old = w.timers.live()[0]
    old.fn()
    await settle()
    w.imp.stop()
    w.imp.start()
    expect(w.timers.live()).toEqual([])
    gates[0].resolve()
    await settle()
    expect(delays(w)).toEqual([EVERY])
    expect(passes(w)).toBe(1)
  })

  it('ignores a timer of a chain that was stopped, even after a new one was started', async () => {
    const w = setup({ active: [thread(1)] })
    w.imp.start()
    const stale = w.timers.jobs[0]
    w.imp.stop()
    w.imp.start()
    stale.fn()
    await settle()
    expect(passes(w)).toBe(0)
    expect(delays(w)).toEqual([EVERY])
  })

  it('keeps one pass at a time and one timer, whatever order calls, timers and the end of runs come in', async () => {
    const ops = fc.array(fc.constantFrom('run', 'start', 'stop', 'fire', 'finish', 'fail'), { maxLength: 30 })
    await fc.assert(
      fc.asyncProperty(ops, async (sequence) => {
        const w = setup({ active: [thread(1)], channels: { [postId(1)]: channel(1, 1, 2) } })
        const gates = gateActive(w)
        const asked = []
        // What the importer should be doing, worked out from the calls alone.
        const model = { passes: 0, going: false, queued: false, started: false, timer: false, failures: 0 }
        const delay = () => (model.failures === 0 ? EVERY : RETRY[Math.min(model.failures, RETRY.length) - 1])
        const begin = () => {
          model.passes++
          model.going = true
          model.timer = false
        }
        const run = () => {
          if (model.going) model.queued = true
          else begin()
        }
        for (const op of sequence) {
          if (op === 'run') {
            asked.push(w.imp.run())
            run()
          } else if (op === 'start') {
            w.imp.start()
            if (!model.started) {
              model.started = true
              if (!model.going) model.timer = true
            }
          } else if (op === 'stop') {
            w.imp.stop()
            model.started = false
            model.timer = false
          } else if (op === 'fire') {
            const [job] = w.timers.live()
            if (job) {
              job.over = true
              job.fn()
              model.timer = false
              run()
            }
          } else if (model.going) {
            gates[model.passes - 1].resolve(op === 'finish')
            model.failures = op === 'finish' ? 0 : model.failures + 1
            model.going = false
            if (model.started) model.timer = true
            if (model.queued) {
              model.queued = false
              begin()
            }
          }
          await settle()
          // A pass is counted by the call it makes to Discord, which waits at its gate until the test lets it go.
          expect(gates.length).toBe(model.passes)
          const live = w.timers.live()
          expect(live.map((j) => j.ms)).toEqual(model.timer ? [delay()] : [])
        }
        // Whatever is left finishes, and every call that was made is answered.
        while (model.going) {
          gates[model.passes - 1].resolve(true)
          model.going = false
          if (model.queued) {
            model.queued = false
            model.passes++
            model.going = true
          }
          await settle()
        }
        await expect(Promise.all(asked)).resolves.toEqual(asked.map(() => undefined))
        expect(gates.length).toBe(model.passes)
      }),
      { numRuns: 150 },
    )
  })

  it('uses the global timers when it is given none', async () => {
    vi.useFakeTimers()
    try {
      const discord = fakeDiscord({ active: [thread(1)] })
      const imp = createImport({ discord, store: fakeStore(), forumId: FORUM, log: () => {} })
      imp.start()
      await vi.advanceTimersByTimeAsync(EVERY - 1)
      expect(passes({ discord })).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(passes({ discord })).toBe(1)
      imp.stop()
      await vi.advanceTimersByTimeAsync(EVERY * 2)
      expect(passes({ discord })).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([0, -1, 1.5, NaN, Infinity, '5', null, 2_147_483_648])('refuses an everyMs of %s', (everyMs) => {
    expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId: FORUM, everyMs })).toThrow(
      new RangeError('everyMs must be a whole number of milliseconds from 1 to 2147483647.'),
    )
  })

  it('takes an everyMs of 1 and of the longest a timer holds', () => {
    for (const everyMs of [1, 2_147_483_647]) {
      expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId: FORUM, everyMs })).not.toThrow()
    }
  })

  it.each([[], 'x', 300_000, null, {}, [0], [-1], [1.5], [NaN], ['5'], [300_000, 2_147_483_648], [300_000, null]])('refuses a retryMs of %j', (retryMs) => {
    expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId: FORUM, retryMs })).toThrow(
      new RangeError('retryMs must be a non-empty list of whole numbers of milliseconds from 1 to 2147483647.'),
    )
  })

  it('takes a retryMs of 1 and of the longest a timer holds, in any number of steps', () => {
    for (const retryMs of [[1], [2_147_483_647], [1, 2, 3, 4, 5, 6]]) {
      expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId: FORUM, retryMs })).not.toThrow()
    }
  })

  it.each([null, {}, { setTimeout() {} }, { clearTimeout() {} }, { setTimeout: 'x', clearTimeout() {} }, { setTimeout() {}, clearTimeout: 5 }])(
    'refuses timers of %j',
    (timers) => {
      expect(() => createImport({ discord: fakeDiscord(), store: fakeStore(), forumId: FORUM, timers })).toThrow(
        new TypeError('timers must have a setTimeout and a clearTimeout function.'),
      )
    },
  )
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
