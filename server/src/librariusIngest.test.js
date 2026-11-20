import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createIngest } from './librariusIngest.js'
import { Upstream } from './discordRoles.js'
import { applyReaction, parseEmoji, parseMessage, parseThread } from './librariusParse.js'

// Every id, name and time here is invented. The edges of the ingest are in memory: a store with the contract of the real
// one (ids that do not fit a bigint are a TypeError before anything is written, a message needs its post, keepReactions
// leaves the stored counts alone), a guild and an access that only remember what was forgotten, and a fetch that keeps
// the argument checks of discord.message. A test reads what is left in them, not what was called.
const FORUM = '200000000000000400'
const OWNER = '200000000000000401'
const AUTHOR = '200000000000000402'
const BOT = '200000000000000403'
const OTHER_FORUM = '200000000000000404'
const MEMBER = '200000000000000405'
const MEMBER_2 = '200000000000000406'
const POST = '200000000000000410'
const POST_2 = '200000000000000411'
const POST_3 = '200000000000000412'
const STRANGER = '200000000000000413' // a channel the store has never heard of
const MSG = '200000000000000430'
const MSG_2 = '200000000000000431'
const MSG_3 = '200000000000000432'
const MSG_4 = '200000000000000433'
const CUSTOM = '200000000000000440'
const OUT_OF_RANGE = '99999999999999999999' // a snowflake by shape, but larger than a bigint
const SNOWFLAKE = /^\d{17,20}$/
const BIGINT_MAX = 9223372036854775807n
const KINDS = ['guild', 'forum', 'emoji', 'rules']

const FIRE = { id: null, name: '🔥' }
const FIRE_KEY = 'u:🔥'
const WAVE = { id: null, name: '👋' }
const WAVE_KEY = 'u:👋'
const BLOB = { id: CUSTOM, name: 'invented_blob', animated: false }
const BLOB_KEY = `c:${CUSTOM}`

const flush = () => new Promise((resolve) => setImmediate(resolve))

const rawThread = (id, over = {}) => ({
  id,
  parent_id: FORUM,
  owner_id: OWNER,
  name: `Invented topic ${String(id).slice(-3)}`,
  applied_tags: [],
  flags: 0,
  thread_metadata: { archived: false, locked: false, create_timestamp: '2026-09-01T10:00:00.000000+00:00' },
  ...over,
})
const storedPost = (id, over = {}) => ({ ...parseThread(rawThread(id), FORUM), ...over })

// A message as the gateway sends it in MESSAGE_CREATE: the REST shape, plus the guild it came from.
const gw = (over = {}) => ({
  id: MSG,
  channel_id: POST,
  guild_id: '200000000000000499',
  type: 0,
  content: 'invented words',
  timestamp: '2026-11-15T12:00:00.000000+00:00',
  edited_timestamp: null,
  author: { id: AUTHOR, username: 'invented-member' },
  attachments: [],
  embeds: [],
  mentions: [],
  ...over,
})
const storedMessage = (over = {}) => ({ ...parseMessage(gw()), rev: 1, ...over })
const reaction = (emoji, key, count) => ({ key, id: emoji.id, name: emoji.name, animated: emoji.animated === true, count })

const needId = (value, what) => {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value) || BigInt(value) > BIGINT_MAX) throw new TypeError(`${what} must be a snowflake that fits a bigint`)
}
const needIdOrNull = (value, what) => {
  if (value !== null) needId(value, what)
}

/**
 * The Librarius store in memory, with the contract of the real one where the ingest leans on it: ids that do not fit a
 * bigint are a TypeError before any write, a message is only stored with its post, keepReactions leaves the stored
 * reactions as they are (and a new message gets the row's), and every write to a stored message takes the next rev.
 */
function fakeStore({ posts = [], messages = [], parts = [], hooks = [] } = {}) {
  const plans = []
  let rev = 100
  const s = {
    posts: new Map(posts.map((p) => [p.id, p])),
    messages: new Map(messages.map((m) => [m.id, m])),
    // The webhooks that sent a stored part (store.ownWebhookIds answers them), and the ids knownPartIds was asked about.
    hooks: new Set(hooks),
    asked: [],
    // The Discord id of each part of a reply of the site, and the id of the reply it belongs to.
    parts: new Map(parts),
    // What the store queued for the outbox: the parts of a reply that are left to delete, as { messageKey, postId, partIds }.
    queued: [],
    failWhen: (method, when, error) => plans.push({ method, when, error }),
    snapshot: () => JSON.stringify([[...s.posts], [...s.messages], [...s.parts], s.queued]),
  }
  const enter = (method, ...args) => {
    for (const p of plans) if (p.method === method && p.when(...args)) throw p.error
  }
  const touch = (id, change) => s.messages.set(id, { ...s.messages.get(id), ...change, rev: ++rev })

  return Object.assign(s, {
    async knownPostIds() {
      enter('knownPostIds')
      return new Set(s.posts.keys())
    },
    async upsertPost(post) {
      enter('upsertPost', post)
      needId(post.id, 'id')
      needIdOrNull(post.ownerId, 'ownerId')
      if (!Array.isArray(post.tagIds)) throw new TypeError('tagIds must be a list')
      s.posts.set(post.id, { ...post })
    },
    async deletePost(id) {
      enter('deletePost', id)
      needId(id, 'postId')
      s.posts.delete(id)
      for (const [mId, m] of s.messages) if (m.postId === id) s.messages.delete(mId)
    },
    async upsertMessages(rows, { keepReactions = false } = {}) {
      enter('upsertMessages', rows, keepReactions)
      if (!Array.isArray(rows)) throw new TypeError('rows must be a list')
      if (typeof keepReactions !== 'boolean') throw new TypeError('keepReactions must be true or false')
      for (const m of rows) {
        needId(m.id, 'id')
        needId(m.postId, 'postId')
        needId(m.authorId, 'authorId')
        needIdOrNull(m.webhookId, 'webhookId')
        needIdOrNull(m.replyTo, 'replyTo')
        for (const field of ['embeds', 'stickers', 'reactions', 'attachments']) if (!Array.isArray(m[field])) throw new TypeError(`${field} must be a list`)
      }
      for (const m of rows) {
        if (!s.posts.has(m.postId)) continue
        const old = s.messages.get(m.id)
        s.messages.set(m.id, { ...m, reactions: keepReactions && old ? old.reactions : m.reactions, rev: ++rev })
      }
    },
    async deleteMessages(ids) {
      enter('deleteMessages', ids)
      if (!Array.isArray(ids)) throw new TypeError('ids must be a list')
      for (const id of ids) needId(id, 'messageId')
      for (const id of ids) s.messages.delete(id)
    },
    async siteDeleted(ids, postId) {
      enter('siteDeleted', ids, postId)
      if (!Array.isArray(ids)) throw new TypeError('ids must be a list')
      for (const id of ids) needId(id, 'a part id')
      needId(postId, 'postId')
      const plain = ids.filter((id) => !s.parts.has(id))
      for (const messageId of new Set(ids.filter((id) => s.parts.has(id)).map((id) => s.parts.get(id)))) {
        const all = [...s.parts].filter(([, m]) => m === messageId).map(([part]) => part)
        const left = all.filter((part) => !ids.includes(part))
        s.messages.delete(messageId)
        for (const part of all) s.parts.delete(part)
        if (left.length > 0) s.queued.push({ messageKey: messageId, postId, partIds: left })
      }
      return { plain }
    },
    async ownWebhookIds() {
      enter('ownWebhookIds')
      return new Set(s.hooks)
    },
    async knownPartIds(ids) {
      enter('knownPartIds', ids)
      if (!Array.isArray(ids)) throw new TypeError('ids must be a list')
      for (const id of ids) needId(id, 'a part id')
      s.asked.push([...ids])
      return new Set(ids.filter((id) => s.parts.has(id)))
    },
    async messageOfPart(id) {
      enter('messageOfPart', id)
      needId(id, 'id')
      return s.parts.get(id) ?? id
    },
    async adjustReaction(messageId, emoji, delta) {
      enter('adjustReaction', messageId, emoji, delta)
      needId(messageId, 'messageId')
      if (!Number.isSafeInteger(delta)) throw new TypeError('delta must be a whole number')
      if (s.messages.has(messageId)) touch(messageId, { reactions: applyReaction(s.messages.get(messageId).reactions, emoji, delta) })
    },
    async clearReactions(messageId, key) {
      enter('clearReactions', messageId, key)
      needId(messageId, 'messageId')
      if (key !== null && (typeof key !== 'string' || key === '')) throw new TypeError('key must be an emoji key or null')
      if (s.messages.has(messageId)) touch(messageId, { reactions: key === null ? [] : s.messages.get(messageId).reactions.filter((r) => r.key !== key) })
    },
  })
}

/** What the guild cache and the verdict cache hold: only what has been dropped or replaced since the start. */
function fakeGuild() {
  const g = { held: new Set(KINDS), emoji: null }
  g.invalidate = (kind) => {
    if (!KINDS.includes(kind)) throw new TypeError("kind must be 'guild', 'forum', 'emoji' or 'rules'.")
    g.held.delete(kind)
  }
  g.setEmoji = (list) => {
    if (!Array.isArray(list)) return g.invalidate('emoji')
    g.emoji = parseEmoji(list)
    g.held.add('emoji')
  }
  return g
}
function fakeAccess() {
  const a = { verdicts: new Set(['a', 'b']) }
  a.forget = () => a.verdicts.clear()
  return a
}

/** discord.message in memory: the message by id, null for one that is gone, and the argument checks of the real one. */
function fakeFetch(answers = new Map()) {
  const f = { answers, calls: [] }
  f.message = async (channelId, id) => {
    f.calls.push([channelId, id])
    needId(channelId, 'channelId')
    needId(id, 'messageId')
    if (f.fail) throw f.fail
    return answers.has(id) ? answers.get(id) : null
  }
  return f
}

/** A world: the store with `posts` and `messages` in it, a loaded ingest, and the edges it writes to. */
async function rig({ posts = [POST], messages = [], parts = [], hooks = [], load = true, answers, ...over } = {}) {
  const store = fakeStore({ posts: posts.map((p) => storedPost(p)), messages, parts, hooks })
  const guild = fakeGuild()
  const access = fakeAccess()
  const fetch = fakeFetch(answers)
  const readies = { count: 0 }
  // Each time the ingest tells the outbox to look, what the store had queued for it by then (the keys of the deletions).
  const told = []
  const ingest = createIngest({
    store,
    guild,
    access,
    forumId: FORUM,
    fetchMessage: fetch.message,
    onReady: () => {
      readies.count += 1
    },
    kickOutbox: () => {
      told.push(store.queued.map((q) => q.messageKey))
    },
    log: () => {},
    ...over,
  })
  if (load) await ingest.load()
  return { ingest, store, guild, access, fetch, readies, told, send: ingest.dispatch }
}

const reactionsOf = (w, id = MSG) => w.store.messages.get(id).reactions
// A stored message without its rev, which every write moves on.
const bare = ({ rev, ...rest }) => rest
const mapOf = (reactions) => new Map(reactions.map((r) => [r.key, r.count]))

describe('createIngest options', () => {
  const STORE = ['knownPostIds', 'upsertPost', 'deletePost', 'upsertMessages', 'deleteMessages', 'adjustReaction', 'clearReactions', 'siteDeleted', 'messageOfPart', 'ownWebhookIds', 'knownPartIds']
  const options = () => ({
    store: fakeStore(),
    guild: fakeGuild(),
    access: fakeAccess(),
    forumId: FORUM,
    fetchMessage: fakeFetch().message,
    onReady: () => {},
    log: () => {},
  })

  it.each(STORE)('needs store.%s to be a function', (name) => {
    for (const bad of [undefined, 'nope', {}]) {
      expect(() => createIngest({ ...options(), store: { ...fakeStore(), [name]: bad } })).toThrow(new TypeError(`store.${name} must be a function.`))
    }
  })

  it('needs a store at all', () => {
    for (const bad of [undefined, null]) {
      expect(() => createIngest({ ...options(), store: bad })).toThrow(new TypeError('store.knownPostIds must be a function.'))
    }
  })

  it.each([
    ['guild', 'invalidate'],
    ['guild', 'setEmoji'],
    ['access', 'forget'],
  ])('needs %s.%s to be a function', (what, name) => {
    const o = options()
    for (const bad of [undefined, 'nope']) {
      expect(() => createIngest({ ...o, [what]: { ...o[what], [name]: bad } })).toThrow(new TypeError(`${what}.${name} must be a function.`))
    }
    for (const bad of [undefined, null]) {
      expect(() => createIngest({ ...o, [what]: bad })).toThrow(new TypeError(`${what}.${what === 'guild' ? 'invalidate' : 'forget'} must be a function.`))
    }
  })

  it.each(['fetchMessage', 'onReady'])('needs %s to be a function', (name) => {
    for (const bad of [undefined, null, 'nope', {}]) {
      expect(() => createIngest({ ...options(), [name]: bad })).toThrow(new TypeError(`${name} must be a function.`))
    }
  })

  it.each([undefined, null, '', '1234567890123456', '123456789012345678901', '20000000000000040a', 200000000000000400, {}])(
    'refuses a forumId that is not a Discord id: %s',
    (forumId) => {
      expect(() => createIngest({ ...options(), forumId })).toThrow(new TypeError('forumId must be a Discord id.'))
    },
  )

  it('takes a forumId of 17 and of 20 digits', () => {
    for (const forumId of ['12345678901234567', '12345678901234567890']) {
      expect(() => createIngest({ ...options(), forumId })).not.toThrow()
    }
  })

  it.each([undefined, null, '1234567890123456', '123456789012345678901', '20000000000000045a', 200000000000000450, {}, ''])(
    'takes a webhookId that is a Discord id or null, and refuses %j',
    (webhookId) => {
      if (webhookId === undefined || webhookId === null) expect(() => createIngest({ ...options(), webhookId })).not.toThrow()
      else expect(() => createIngest({ ...options(), webhookId })).toThrow(new TypeError('webhookId must be a Discord id or null.'))
    },
  )

  it('takes a webhookId of 17 and of 20 digits', () => {
    for (const webhookId of ['12345678901234567', '12345678901234567890']) expect(() => createIngest({ ...options(), webhookId })).not.toThrow()
  })

  it('takes a kickOutbox that is a function, or none, and refuses anything else', () => {
    for (const kickOutbox of [undefined, () => {}]) expect(() => createIngest({ ...options(), kickOutbox })).not.toThrow()
    for (const kickOutbox of [null, 'kick', {}, { kick: () => {} }, 1, true]) {
      expect(() => createIngest({ ...options(), kickOutbox }), String(kickOutbox)).toThrow(new TypeError('kickOutbox must be a function.'))
    }
  })

  it('needs no kickOutbox: with the replies off there is no outbox to tell, and a reply whose part is deleted goes all the same', async () => {
    const w = await rig({ ...siteReply(), kickOutbox: undefined })
    await expect(w.send('MESSAGE_DELETE', { id: PART_2, channel_id: POST })).resolves.toBeUndefined()
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
    expect(w.store.queued).toEqual([{ messageKey: MSG, postId: POST, partIds: [MSG, PART_3] }])
    // A kickOutbox of null is no "replies off": it is refused, so that a wiring mistake is not silent.
    expect(() => createIngest({ ...options(), kickOutbox: null })).toThrow(new TypeError('kickOutbox must be a function.'))
  })

  it('needs no log: it logs to console.error when none is given', async () => {
    const { log, ...rest } = options()
    expect(log).toBeTypeOf('function')
    expect(() => createIngest(rest)).not.toThrow()
  })
})

describe('load', () => {
  it('seeds the posts the ingest listens to from the store', async () => {
    const w = await rig({ posts: [POST, POST_2] })
    await w.send('MESSAGE_CREATE', gw())
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, channel_id: POST_2 }))
    expect([...w.store.messages.keys()]).toEqual([MSG, MSG_2])
  })

  it('listens to nothing before it has loaded: a message of a post the store holds is dropped', async () => {
    const w = await rig({ load: false })
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(0)
  })

  it('resolves to nothing', async () => {
    const w = await rig({ load: false })
    expect(await w.ingest.load()).toBeUndefined()
  })

  it('gives the store error to the caller and leaves what it listens to as it was', async () => {
    const w = await rig({ load: false })
    const err = new Error('connection lost')
    w.store.failWhen('knownPostIds', () => true, err)
    await expect(w.ingest.load()).rejects.toBe(err)
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(0)
  })

  it('adds to what it knows and never forgets it: a thread created while the posts were being read is kept', async () => {
    const w = await rig({ posts: [POST], load: false })
    let release
    const slow = w.store.knownPostIds
    w.store.knownPostIds = async () => {
      const ids = await slow()
      await new Promise((resolve) => {
        release = resolve
      })
      return ids
    }
    const loading = w.ingest.load()
    await flush()
    await w.send('THREAD_CREATE', rawThread(POST_2))
    release()
    await loading
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, channel_id: POST_2 }))
    await w.send('MESSAGE_CREATE', gw())
    expect([...w.store.messages.keys()].sort()).toEqual([MSG, MSG_2])
  })

  it('may be called again: it takes up the posts stored since', async () => {
    const w = await rig()
    w.store.posts.set(POST_2, storedPost(POST_2))
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, channel_id: POST_2 }))
    expect(w.store.messages.size).toBe(0)
    await w.ingest.load()
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, channel_id: POST_2 }))
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })
})

describe('READY', () => {
  const ready = (id = BOT) => ({ user: { id, username: 'invented-bot' }, session_id: 'invented-session' })

  it('says nothing about the bot before READY comes', async () => {
    const w = await rig()
    expect(w.ingest.botUserId()).toBeNull()
  })

  it('notes the bot user id', async () => {
    const w = await rig()
    expect(await w.send('READY', ready())).toBeUndefined()
    expect(w.ingest.botUserId()).toBe(BOT)
  })

  it.each([
    ['no data', undefined],
    ['null', null],
    ['text', 'READY'],
    ['no user', {}],
    ['a null user', { user: null }],
    ['a user without an id', { user: {} }],
    ['an id that is a number', { user: { id: 200000000000000403 } }],
    ['an id that is too short', { user: { id: '1234567890123456' } }],
    ['an id that is too long', { user: { id: '123456789012345678901' } }],
    ['an id that is not digits', { user: { id: '20000000000000040a' } }],
    ['a user that is text', { user: BOT }],
  ])('keeps no bot id from READY with %s', async (_, d) => {
    const w = await rig()
    await w.send('READY', d)
    expect(w.ingest.botUserId()).toBeNull()
  })

  it('keeps the id it has when a later READY has none', async () => {
    const w = await rig()
    await w.send('READY', ready())
    await w.send('READY', { user: null })
    expect(w.ingest.botUserId()).toBe(BOT)
  })

  it('takes the new id when a later READY has one', async () => {
    const w = await rig()
    await w.send('READY', ready())
    await w.send('READY', ready(MEMBER))
    expect(w.ingest.botUserId()).toBe(MEMBER)
  })

  it('starts the catch-up, once for each READY, and not for any other event', async () => {
    const w = await rig()
    await w.send('READY', ready())
    expect(w.readies.count).toBe(1)
    await w.send('READY', ready())
    expect(w.readies.count).toBe(2)
    await w.send('RESUMED', {})
    await w.send('GUILD_CREATE', {})
    expect(w.readies.count).toBe(2)
  })

  it('does not wait for the catch-up: the dispatch is over while it is still going', async () => {
    const w = await rig({ onReady: () => new Promise(() => {}) })
    const outcome = await Promise.race([w.send('READY', ready()).then(() => 'done'), flush().then(() => flush()).then(() => 'waiting')])
    expect(outcome).toBe('done')
    expect(w.ingest.botUserId()).toBe(BOT)
  })

  it('is not stopped by a catch-up that throws or rejects', async () => {
    for (const onReady of [
      () => {
        throw new Error('no')
      },
      () => Promise.reject(new Upstream('Discord is down.')),
      async () => {
        throw new TypeError('no')
      },
      // What is thrown need not be an error, or have a name or a message.
      () => Promise.reject(undefined),
      () => Promise.reject('just text'),
      () => Promise.reject({ name: 'Odd' }),
      () => Promise.reject({ message: 'no name' }),
    ]) {
      const w = await rig({ onReady })
      await expect(w.send('READY', ready())).resolves.toBeUndefined()
      await flush()
      expect(w.ingest.botUserId()).toBe(BOT)
    }
  })

  it('leaves no failure unhandled, whether the catch-up or the loading of the posts fails', async () => {
    const seen = []
    const note = (reason) => seen.push(reason)
    process.on('unhandledRejection', note)
    try {
      const failing = await rig({ onReady: () => Promise.reject(new Upstream('Discord is down.')) })
      failing.store.failWhen('knownPostIds', () => true, new Error('connection lost'))
      await failing.send('READY', ready())
      const throwing = await rig({
        onReady: () => {
          throw new Error('no')
        },
      })
      throwing.store.failWhen('knownPostIds', () => true, new Error('connection lost'))
      await throwing.send('READY', ready())
      await flush()
      await flush()
    } finally {
      process.off('unhandledRejection', note)
    }
    expect(seen).toEqual([])
  })

  it('takes up the posts the catch-up stored, once it is over, so their live events are kept', async () => {
    let finish
    const w = await rig({
      onReady: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    await w.send('READY', ready())
    // The catch-up finds a thread the ingest has never heard of.
    w.store.posts.set(POST_2, storedPost(POST_2))
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, channel_id: POST_2 }))
    expect(w.store.messages.size).toBe(0)
    finish()
    await flush()
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, channel_id: POST_2 }))
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })

  it('takes up the posts after a catch-up that failed too, since it may have stored some before it did', async () => {
    let fail
    const w = await rig({
      onReady: () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    })
    await w.send('READY', ready())
    w.store.posts.set(POST_2, storedPost(POST_2))
    fail(new Upstream('Discord is down.'))
    await flush()
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, channel_id: POST_2 }))
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })

  it('does not wait for the store to take up the posts either, and survives its failing', async () => {
    const w = await rig()
    w.store.failWhen('knownPostIds', () => true, new Error('connection lost'))
    await expect(w.send('READY', ready())).resolves.toBeUndefined()
    await flush()
    await expect(w.send('READY', ready())).resolves.toBeUndefined()
    await flush()
    // What it knew is still known.
    await w.send('MESSAGE_CREATE', gw())
    expect([...w.store.messages.keys()]).toEqual([MSG])
  })
})

describe('THREAD_CREATE and THREAD_UPDATE', () => {
  it.each(['THREAD_CREATE', 'THREAD_UPDATE'])('%s stores a thread of the forum as parseThread reads it', async (type) => {
    const w = await rig({ posts: [] })
    const raw = rawThread(POST, { name: 'Invented title', applied_tags: [MEMBER_2], flags: 2, thread_metadata: { archived: true, locked: true, create_timestamp: '2026-09-01T10:00:00.000000+00:00' } })
    expect(await w.send(type, raw)).toBeUndefined()
    expect(w.store.posts.get(POST)).toEqual(parseThread(raw, FORUM))
    expect(w.store.posts.get(POST)).toMatchObject({ title: 'Invented title', tagIds: [MEMBER_2], pinned: true, locked: true, archived: true, ownerId: OWNER })
  })

  it.each(['THREAD_CREATE', 'THREAD_UPDATE'])('%s makes the thread one whose messages are kept', async (type) => {
    const w = await rig({ posts: [] })
    await w.send(type, rawThread(POST))
    await w.send('MESSAGE_CREATE', gw())
    expect([...w.store.messages.keys()]).toEqual([MSG])
  })

  it('an update changes what the thread was stored with', async () => {
    const w = await rig()
    await w.send('THREAD_UPDATE', rawThread(POST, { name: 'Renamed', thread_metadata: { archived: true, locked: true, create_timestamp: '2026-09-01T10:00:00.000000+00:00' } }))
    expect(w.store.posts.get(POST)).toMatchObject({ title: 'Renamed', archived: true, locked: true })
    expect(w.store.posts.size).toBe(1)
  })

  it.each(['THREAD_CREATE', 'THREAD_UPDATE'])('%s of a thread under another parent stores nothing and is not listened to', async (type) => {
    const w = await rig({ posts: [] })
    await w.send(type, rawThread(POST, { parent_id: OTHER_FORUM }))
    await w.send(type, rawThread(POST_2, { parent_id: undefined }))
    await w.send(type, rawThread(POST_3, { parent_id: null }))
    expect(w.store.posts.size).toBe(0)
    w.store.posts.set(POST, storedPost(POST))
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(0)
  })

  it('does nothing twice what it did once', async () => {
    const w = await rig({ posts: [] })
    await w.send('THREAD_CREATE', rawThread(POST))
    const once = w.store.snapshot()
    await w.send('THREAD_CREATE', rawThread(POST))
    await w.send('THREAD_UPDATE', rawThread(POST))
    expect(w.store.snapshot()).toBe(once)
  })

  it('does not listen to a thread whose write failed, and gives the error to the caller', async () => {
    const w = await rig({ posts: [POST], load: false })
    const err = new Error('connection lost')
    w.store.failWhen('upsertPost', () => true, err)
    await expect(w.send('THREAD_UPDATE', rawThread(POST, { name: 'Renamed' }))).rejects.toBe(err)
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(0)
    expect(w.store.posts.get(POST).title).not.toBe('Renamed')
  })

  it('skips a thread the store refuses with a TypeError, and does not listen to it', async () => {
    const w = await rig({ posts: [POST], load: false })
    await expect(w.send('THREAD_UPDATE', rawThread(POST, { owner_id: OUT_OF_RANGE }))).resolves.toBeUndefined()
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(0)
    expect(w.store.posts.get(POST).ownerId).toBe(OWNER)
  })

  it('gives the caller an error that is not a TypeError, whatever else it is', async () => {
    const w = await rig({ posts: [] })
    w.store.failWhen('upsertPost', () => true, new RangeError('not mine to hide'))
    await expect(w.send('THREAD_CREATE', rawThread(POST))).rejects.toThrow(RangeError)
  })

  it.each([
    ['no data', undefined],
    ['null', null],
    ['text', 'thread'],
    ['a list', [rawThread(POST)]],
    ['no id', rawThread(undefined)],
    ['an id that is not a snowflake', rawThread('abc')],
    ['an id that is a number', rawThread(200000000000000410)],
    ['a name that is not text', rawThread(POST, { name: 5 })],
  ])('does not break on a thread with %s', async (_, raw) => {
    const w = await rig({ posts: [] })
    await expect(w.send('THREAD_CREATE', raw)).resolves.toBeUndefined()
    await expect(w.send('THREAD_UPDATE', raw)).resolves.toBeUndefined()
    for (const post of w.store.posts.values()) expect(post.id).toMatch(SNOWFLAKE)
  })
})

describe('THREAD_DELETE', () => {
  it('deletes the post of the forum and its messages', async () => {
    const w = await rig({ posts: [POST, POST_2], messages: [storedMessage(), storedMessage({ id: MSG_2, postId: POST_2 })] })
    expect(await w.send('THREAD_DELETE', { id: POST, parent_id: FORUM, guild_id: OWNER, type: 11 })).toBeUndefined()
    expect([...w.store.posts.keys()]).toEqual([POST_2])
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })

  it('stops listening to it', async () => {
    const w = await rig()
    await w.send('THREAD_DELETE', { id: POST, parent_id: FORUM })
    w.store.posts.set(POST, storedPost(POST))
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(0)
  })

  it.each([
    ['another parent', { id: POST, parent_id: OTHER_FORUM }],
    ['no parent', { id: POST }],
    ['a null parent', { id: POST, parent_id: null }],
    ['a parent that is a number', { id: POST, parent_id: 200000000000000400 }],
  ])('leaves the post alone for a thread with %s', async (_, d) => {
    const w = await rig({ messages: [storedMessage()] })
    const before = w.store.snapshot()
    await w.send('THREAD_DELETE', d)
    expect(w.store.snapshot()).toBe(before)
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2 }))
    expect(w.store.messages.has(MSG_2)).toBe(true)
  })

  it('does nothing twice what it did once, and for a post it does not hold', async () => {
    const w = await rig({ messages: [storedMessage()] })
    await w.send('THREAD_DELETE', { id: POST, parent_id: FORUM })
    const once = w.store.snapshot()
    await w.send('THREAD_DELETE', { id: POST, parent_id: FORUM })
    await w.send('THREAD_DELETE', { id: POST_2, parent_id: FORUM })
    expect(w.store.snapshot()).toBe(once)
  })

  it.each([undefined, null, 5, 'abc', '', OUT_OF_RANGE, '1234567890123456', {}, [POST]])('ignores a delete of the id %j', async (id) => {
    const w = await rig({ messages: [storedMessage()] })
    const before = w.store.snapshot()
    await expect(w.send('THREAD_DELETE', { id, parent_id: FORUM })).resolves.toBeUndefined()
    expect(w.store.snapshot()).toBe(before)
  })

  it.each([undefined, null, 'x', 5, []])('does not break on the data %j', async (d) => {
    const w = await rig()
    await expect(w.send('THREAD_DELETE', d)).resolves.toBeUndefined()
    expect(w.store.posts.size).toBe(1)
  })

  it('keeps listening to the post when the delete failed, and gives the error to the caller', async () => {
    const w = await rig()
    const err = new Error('connection lost')
    w.store.failWhen('deletePost', () => true, err)
    await expect(w.send('THREAD_DELETE', { id: POST, parent_id: FORUM })).rejects.toBe(err)
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(1)
  })
})

describe('THREAD_LIST_SYNC', () => {
  it('stores each thread of the forum and listens to it, and leaves the others', async () => {
    const w = await rig({ posts: [] })
    const threads = [rawThread(POST), rawThread(POST_2, { parent_id: OTHER_FORUM }), rawThread(POST_3, { name: 'Third' })]
    expect(await w.send('THREAD_LIST_SYNC', { guild_id: OWNER, threads, members: [] })).toBeUndefined()
    expect([...w.store.posts.keys()]).toEqual([POST, POST_3])
    expect(w.store.posts.get(POST_3)).toEqual(parseThread(threads[2], FORUM))
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, channel_id: POST_3 }))
    await w.send('MESSAGE_CREATE', gw({ id: MSG_3, channel_id: POST_2 }))
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })

  it('updates a thread it holds, and does nothing twice what it did once', async () => {
    const w = await rig()
    await w.send('THREAD_LIST_SYNC', { threads: [rawThread(POST, { name: 'Renamed' })] })
    const once = w.store.snapshot()
    expect(w.store.posts.get(POST).title).toBe('Renamed')
    await w.send('THREAD_LIST_SYNC', { threads: [rawThread(POST, { name: 'Renamed' })] })
    expect(w.store.snapshot()).toBe(once)
  })

  it('goes on past a thread the store refuses', async () => {
    const w = await rig({ posts: [] })
    await w.send('THREAD_LIST_SYNC', { threads: [rawThread(POST, { owner_id: OUT_OF_RANGE }), rawThread(POST_2)] })
    expect([...w.store.posts.keys()]).toEqual([POST_2])
  })

  it('goes on past what is not a thread', async () => {
    const w = await rig({ posts: [] })
    await w.send('THREAD_LIST_SYNC', { threads: [null, 'x', 5, [], {}, rawThread(POST)] })
    expect([...w.store.posts.keys()]).toEqual([POST])
  })

  it('gives the error of a failing store to the caller', async () => {
    const w = await rig({ posts: [] })
    const err = new Error('connection lost')
    w.store.failWhen('upsertPost', () => true, err)
    await expect(w.send('THREAD_LIST_SYNC', { threads: [rawThread(POST)] })).rejects.toBe(err)
  })

  it.each([undefined, null, 'x', 5, {}, { threads: null }, { threads: 'x' }, { threads: { 0: rawThread(POST) } }, { threads: [] }])(
    'stores nothing for the data %j',
    async (d) => {
      const w = await rig({ posts: [] })
      await expect(w.send('THREAD_LIST_SYNC', d)).resolves.toBeUndefined()
      expect(w.store.posts.size).toBe(0)
    },
  )
})

describe('MESSAGE_CREATE', () => {
  it('stores a message of a post it listens to, as parseMessage reads it', async () => {
    const w = await rig()
    const d = gw({ content: 'Hello **there**', attachments: [], embeds: [] })
    expect(await w.send('MESSAGE_CREATE', d)).toBeUndefined()
    expect(w.store.messages.size).toBe(1)
    expect(w.store.messages.get(MSG)).toMatchObject(parseMessage(d))
    expect(w.store.messages.get(MSG)).toMatchObject({ id: MSG, postId: POST, authorId: AUTHOR, content: 'Hello **there**' })
  })

  it('stores nothing for a channel it does not listen to', async () => {
    const w = await rig()
    await w.send('MESSAGE_CREATE', gw({ channel_id: STRANGER }))
    await w.send('MESSAGE_CREATE', gw({ channel_id: FORUM }))
    expect(w.store.messages.size).toBe(0)
  })

  it('stores nothing for a thread it has never seen, even when it is stored: a thread event is what adds it', async () => {
    const w = await rig({ load: false, posts: [POST] })
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(0)
    await w.send('THREAD_UPDATE', rawThread(POST))
    expect(w.store.messages.size).toBe(0)
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(1)
  })

  it.each([
    ['a kind it does not keep', gw({ type: 7 })],
    ['no author', gw({ author: undefined })],
    ['an author that is null', gw({ author: null })],
    ['an author without an id', gw({ author: { username: 'x' } })],
    ['an id that is not a snowflake', gw({ id: 'abc' })],
    ['no id', gw({ id: undefined })],
  ])('stores nothing for a message with %s, and does not read it again from Discord', async (_, d) => {
    const w = await rig()
    await expect(w.send('MESSAGE_CREATE', d)).resolves.toBeUndefined()
    expect(w.store.messages.size).toBe(0)
    expect(w.fetch.calls).toEqual([])
  })

  it('does nothing twice what it did once', async () => {
    const w = await rig()
    await w.send('MESSAGE_CREATE', gw())
    const once = bare(w.store.messages.get(MSG))
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(1)
    expect(bare(w.store.messages.get(MSG))).toEqual(once)
  })

  it('leaves the reactions of a message that is stored already, and stores a new one with its own', async () => {
    const stored = [reaction(FIRE, FIRE_KEY, 3)]
    const w = await rig({ messages: [storedMessage({ reactions: stored })] })
    await w.send('MESSAGE_CREATE', gw({ content: 'again', reactions: [{ emoji: WAVE, count: 5, me: false }] }))
    expect(w.store.messages.get(MSG)).toMatchObject({ content: 'again', reactions: stored })
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, reactions: [{ emoji: WAVE, count: 5, me: false }] }))
    expect(reactionsOf(w, MSG_2)).toEqual([reaction(WAVE, WAVE_KEY, 5)])
  })

  it('skips a message the store refuses with a TypeError, and goes on to the next', async () => {
    const w = await rig()
    await expect(w.send('MESSAGE_CREATE', gw({ author: { id: OUT_OF_RANGE, username: 'x' } }))).resolves.toBeUndefined()
    expect(w.store.messages.size).toBe(0)
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2 }))
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })

  it('logs what the store refused without any link, a Discord CDN one with no scheme too, and goes on whatever the refusal can say', async () => {
    const unreadable = Object.defineProperties(new TypeError('x'), { name: { get: () => { throw new Error('no name') } }, message: { get: () => { throw new Error('no message') } } })
    const symbolic = Object.assign(new TypeError('x'), { message: Symbol('message') })
    const refusals = [new TypeError('refused cdn.discordapp.com/attachments/1/2/a.png?sig=secret'), new TypeError('refused WSS://MEDIA.test/x?sig=secret'), unreadable, symbolic]
    for (const refusal of refusals) {
      const logs = []
      const w = await rig({ log: (...line) => logs.push(line.join(' ')) })
      w.store.failWhen('upsertMessages', (rows) => rows.some((r) => r.id === MSG), refusal)
      await expect(w.send('MESSAGE_CREATE', gw())).resolves.toBeUndefined()
      expect(logs.join('\n')).not.toMatch(/discordapp|secret|WSS/i)
      expect(w.store.messages.size).toBe(0)
      await w.send('MESSAGE_CREATE', gw({ id: MSG_2 }))
      expect([...w.store.messages.keys()]).toEqual([MSG_2])
    }
  })

  it('gives the error of a failing store to the caller', async () => {
    const w = await rig()
    const err = new Error('connection lost')
    w.store.failWhen('upsertMessages', () => true, err)
    await expect(w.send('MESSAGE_CREATE', gw())).rejects.toBe(err)
  })

  it.each([undefined, null, 5, 'x', {}, [], '200000000000000410 ', 200000000000000410, { 0: POST }, ['200000000000000410'], 'constructor', '__proto__'])(
    'stores nothing for a channel_id of %j',
    async (channel_id) => {
      const w = await rig()
      await expect(w.send('MESSAGE_CREATE', gw({ channel_id }))).resolves.toBeUndefined()
      expect(w.store.messages.size).toBe(0)
    },
  )

  it.each([undefined, null, 'x', 5, [], [gw()]])('does not break on the data %j', async (d) => {
    const w = await rig()
    await expect(w.send('MESSAGE_CREATE', d)).resolves.toBeUndefined()
    expect(w.store.messages.size).toBe(0)
  })
})

describe('MESSAGE_UPDATE', () => {
  it('stores the new text of a message that has an author', async () => {
    const w = await rig({ messages: [storedMessage()] })
    const d = gw({ content: 'edited words', edited_timestamp: '2026-11-15T12:30:00.000000+00:00' })
    expect(await w.send('MESSAGE_UPDATE', d)).toBeUndefined()
    expect(w.store.messages.get(MSG)).toMatchObject({ content: 'edited words', editedAt: '2026-11-15T12:30:00.000000+00:00' })
    expect(w.store.messages.get(MSG)).toMatchObject(parseMessage(d))
    expect(w.fetch.calls).toEqual([])
  })

  it('keeps the reactions a message has, whatever the update says of them', async () => {
    const stored = [reaction(FIRE, FIRE_KEY, 3), reaction(BLOB, BLOB_KEY, 1)]
    const w = await rig({ messages: [storedMessage({ reactions: stored })] })
    await w.send('MESSAGE_UPDATE', gw({ content: 'edited words' }))
    expect(reactionsOf(w)).toEqual(stored)
    await w.send('MESSAGE_UPDATE', gw({ content: 'edited again', reactions: [{ emoji: WAVE, count: 9, me: false }] }))
    expect(reactionsOf(w)).toEqual(stored)
    expect(w.store.messages.get(MSG).content).toBe('edited again')
  })

  it('stores a message it has not seen with the reactions it came with', async () => {
    const w = await rig()
    await w.send('MESSAGE_UPDATE', gw({ reactions: [{ emoji: WAVE, count: 2, me: false }] }))
    expect(reactionsOf(w)).toEqual([reaction(WAVE, WAVE_KEY, 2)])
  })

  it('stores nothing for a channel it does not listen to, and does not ask Discord about it either', async () => {
    const w = await rig({ answers: new Map([[MSG, gw({ channel_id: STRANGER })]]) })
    await w.send('MESSAGE_UPDATE', gw({ channel_id: STRANGER }))
    await w.send('MESSAGE_UPDATE', { id: MSG, channel_id: STRANGER, embeds: [] })
    expect(w.store.messages.size).toBe(0)
    expect(w.fetch.calls).toEqual([])
  })

  it('stores nothing for an update with an author that parseMessage cannot use', async () => {
    const w = await rig({ answers: new Map([[MSG, gw()]]) })
    await w.send('MESSAGE_UPDATE', gw({ type: 7 }))
    await w.send('MESSAGE_UPDATE', gw({ author: { username: 'x' } }))
    await w.send('MESSAGE_UPDATE', gw({ author: {} }))
    expect(w.store.messages.size).toBe(0)
    expect(w.fetch.calls).toEqual([])
  })

  describe('that is partial', () => {
    const partial = (over = {}) => ({ id: MSG, channel_id: POST, guild_id: OWNER, embeds: [{ type: 'link', url: 'https://example.test/' }], ...over })

    it('reads the message again from Discord and stores what it answers', async () => {
      const w = await rig({ messages: [storedMessage()], answers: new Map([[MSG, gw({ content: 'the whole message', embeds: [{ type: 'link', url: 'https://example.test/', title: 'T' }] })]]) })
      expect(await w.send('MESSAGE_UPDATE', partial())).toBeUndefined()
      expect(w.fetch.calls).toEqual([[POST, MSG]])
      expect(w.store.messages.get(MSG)).toMatchObject({ content: 'the whole message', embeds: [expect.objectContaining({ title: 'T' })] })
    })

    it('stores a message it had not seen, with the reactions Discord names', async () => {
      const w = await rig({ answers: new Map([[MSG, gw({ reactions: [{ emoji: WAVE, count: 2, me: false }] })]]) })
      await w.send('MESSAGE_UPDATE', partial())
      expect(reactionsOf(w)).toEqual([reaction(WAVE, WAVE_KEY, 2)])
    })

    it('keeps the reactions of a message it holds, since a count that is read later may be older than the events', async () => {
      const stored = [reaction(FIRE, FIRE_KEY, 3)]
      const w = await rig({ messages: [storedMessage({ reactions: stored })], answers: new Map([[MSG, gw({ reactions: [{ emoji: WAVE, count: 7, me: false }] })]]) })
      await w.send('MESSAGE_UPDATE', partial())
      expect(reactionsOf(w)).toEqual(stored)
    })

    it.each([
      ['no author', partial()],
      ['an author that is null', partial({ author: null })],
      ['an author that is text', partial({ author: 'someone' })],
      ['an author that is a list', partial({ author: [] })],
    ])('is read again when it has %s', async (_, d) => {
      const w = await rig({ answers: new Map([[MSG, gw({ content: 'whole' })]]) })
      await w.send('MESSAGE_UPDATE', d)
      expect(w.fetch.calls).toEqual([[POST, MSG]])
      expect(w.store.messages.get(MSG).content).toBe('whole')
    })

    it('deletes the message when Discord says it is gone', async () => {
      const w = await rig({ messages: [storedMessage(), storedMessage({ id: MSG_2 })] })
      await w.send('MESSAGE_UPDATE', partial())
      expect(w.fetch.calls).toEqual([[POST, MSG]])
      expect([...w.store.messages.keys()]).toEqual([MSG_2])
    })

    it('has nothing to delete when it was not stored either', async () => {
      const w = await rig()
      await expect(w.send('MESSAGE_UPDATE', partial())).resolves.toBeUndefined()
      expect(w.store.messages.size).toBe(0)
    })

    it('stores nothing, and deletes nothing, when what Discord answers is not a message the Librarius keeps', async () => {
      const w = await rig({ messages: [storedMessage()], answers: new Map([[MSG, gw({ type: 7, content: 'system' })]]) })
      const before = w.store.snapshot()
      await w.send('MESSAGE_UPDATE', partial())
      expect(w.store.snapshot()).toBe(before)
    })

    it('does not take anything but null for a message that is gone', async () => {
      for (const answer of [undefined, 0, '', false, {}, []]) {
        const w = await rig({ messages: [storedMessage()], answers: new Map([[MSG, answer]]) })
        await expect(w.send('MESSAGE_UPDATE', partial())).resolves.toBeUndefined()
        expect([...w.store.messages.keys()]).toEqual([MSG])
      }
    })

    it('leaves what it holds, and gives the error to the caller, when Discord cannot be asked', async () => {
      const w = await rig({ messages: [storedMessage()] })
      w.fetch.fail = new Upstream('Discord is down.')
      await expect(w.send('MESSAGE_UPDATE', partial())).rejects.toBe(w.fetch.fail)
      expect([...w.store.messages.keys()]).toEqual([MSG])
    })

    it('does nothing twice what it did once', async () => {
      const w = await rig({ answers: new Map([[MSG, gw({ content: 'whole' })]]) })
      await w.send('MESSAGE_UPDATE', partial())
      await w.send('MESSAGE_UPDATE', partial())
      expect(w.store.messages.size).toBe(1)
      expect(w.store.messages.get(MSG).content).toBe('whole')
    })

    it.each([undefined, null, 5, 'abc', '', OUT_OF_RANGE, '1234567890123456', '200000000000000430 ', {}, [MSG]])(
      'does not ask Discord about the message id %j',
      async (id) => {
        const w = await rig({ answers: new Map([[MSG, gw()]]) })
        await expect(w.send('MESSAGE_UPDATE', partial({ id }))).resolves.toBeUndefined()
        expect(w.fetch.calls).toEqual([])
        expect(w.store.messages.size).toBe(0)
      },
    )

    it('skips a message the store refuses with a TypeError', async () => {
      const w = await rig({ answers: new Map([[MSG, gw({ author: { id: OUT_OF_RANGE, username: 'x' } })]]) })
      await expect(w.send('MESSAGE_UPDATE', partial())).resolves.toBeUndefined()
      expect(w.store.messages.size).toBe(0)
    })

    it('gives the error of a failing store to the caller', async () => {
      const w = await rig({ answers: new Map([[MSG, gw()]]) })
      const err = new Error('connection lost')
      w.store.failWhen('upsertMessages', () => true, err)
      await expect(w.send('MESSAGE_UPDATE', partial())).rejects.toBe(err)
      const gone = await rig({ messages: [storedMessage()] })
      gone.store.failWhen('deleteMessages', () => true, err)
      await expect(gone.send('MESSAGE_UPDATE', partial())).rejects.toBe(err)
    })
  })

  it.each([undefined, null, 'x', 5, []])('does not break on the data %j', async (d) => {
    const w = await rig()
    await expect(w.send('MESSAGE_UPDATE', d)).resolves.toBeUndefined()
    expect(w.fetch.calls).toEqual([])
  })
})

const HOOK = '200000000000000450'
const PART_2 = '200000000000000434'
const PART_3 = '200000000000000435'
// A reply of the site of three parts: its message is MSG, which is its first part's id, and the parts are MSG, PART_2 and PART_3.
const siteReply = () => ({
  messages: [storedMessage({ webhookId: HOOK, authorId: MEMBER, content: 'a reply of the site' }), storedMessage({ id: MSG_2 })],
  parts: [
    [MSG, MSG],
    [PART_2, MSG],
    [PART_3, MSG],
  ],
})

describe('our own webhook: what it posts is the outbox\'s to store', () => {
  const hooked = (over = {}) => gw({ webhook_id: HOOK, author: { id: HOOK, username: 'Invented Name', bot: true }, ...over })

  it('stores no MESSAGE_CREATE of its own, and stores one of any other webhook, and of a person', async () => {
    const w = await rig({ webhookId: HOOK })
    await w.send('MESSAGE_CREATE', hooked())
    expect(w.store.messages.size).toBe(0)
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, webhook_id: '200000000000000451', author: { id: '200000000000000451', username: 'other hook' } }))
    await w.send('MESSAGE_CREATE', gw({ id: MSG_3 }))
    expect([...w.store.messages.keys()]).toEqual([MSG_2, MSG_3])
  })

  it('stores no MESSAGE_UPDATE of its own, whether the event has the author or not, and does not ask Discord for it when it says whose it is', async () => {
    const w = await rig({ webhookId: HOOK, messages: [storedMessage({ content: 'as it was' })], answers: new Map([[MSG, hooked({ content: 'as read again' })]]) })
    await w.send('MESSAGE_UPDATE', hooked({ content: 'edited' }))
    await w.send('MESSAGE_UPDATE', { id: MSG, channel_id: POST, webhook_id: HOOK, embeds: [] })
    expect(w.store.messages.get(MSG).content).toBe('as it was')
    expect(w.fetch.calls).toEqual([])
  })

  it('stores no message it read again that turns out to be its own, which a partial update did not say', async () => {
    const w = await rig({ webhookId: HOOK, messages: [storedMessage({ content: 'as it was' })], answers: new Map([[MSG, hooked({ content: 'as read again' })]]) })
    await w.send('MESSAGE_UPDATE', { id: MSG, channel_id: POST, embeds: [] })
    expect(w.fetch.calls).toEqual([[POST, MSG]])
    expect(w.store.messages.get(MSG).content).toBe('as it was')
  })

  it('stores what is not its own as before, an update included, whatever webhook the ingest was given', async () => {
    const w = await rig({ webhookId: HOOK, messages: [storedMessage({ content: 'as it was' })] })
    await w.send('MESSAGE_UPDATE', gw({ content: 'edited' }))
    expect(w.store.messages.get(MSG).content).toBe('edited')
    await w.send('MESSAGE_UPDATE', gw({ webhook_id: '200000000000000451', author: { id: '200000000000000451', username: 'other hook' }, content: 'edited by another' }))
    expect(w.store.messages.get(MSG).content).toBe('edited by another')
  })

  it.each([undefined, null])('has no webhook of its own to ignore when it is given %j: every message is stored', async (webhookId) => {
    const w = await rig({ webhookId })
    await w.send('MESSAGE_CREATE', hooked())
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2, webhook_id: null }))
    expect([...w.store.messages.keys()]).toEqual([MSG, MSG_2])
  })
})

describe('the site\'s own replies, whatever webhook sent them', () => {
  const OLD_HOOK = '200000000000000452'
  const OTHER_HOOK = '200000000000000451'
  const hooked = (hook, over = {}) => gw({ webhook_id: hook, author: { id: hook, username: 'Invented Name', bot: true }, ...over })

  it('stores no message of a webhook that sent a stored part, though it is not the current one, once the ingest has loaded it', async () => {
    const w = await rig({ webhookId: HOOK, hooks: [OLD_HOOK] })
    await w.send('MESSAGE_CREATE', hooked(OLD_HOOK))
    await w.send('MESSAGE_CREATE', hooked(OTHER_HOOK, { id: MSG_2 }))
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })

  it('knows the old webhooks when there is no webhook now, and the current one when the store knows none', async () => {
    const none = await rig({ webhookId: null, hooks: [OLD_HOOK] })
    await none.send('MESSAGE_CREATE', hooked(OLD_HOOK))
    await none.send('MESSAGE_UPDATE', hooked(OLD_HOOK, { content: 'edited' }))
    expect(none.store.messages.size).toBe(0)
    const live = await rig({ webhookId: HOOK, hooks: [] })
    await live.send('MESSAGE_CREATE', hooked(HOOK))
    expect(live.store.messages.size).toBe(0)
  })

  it('reads the webhooks each time it loads, so that one that sent a part since is known', async () => {
    const w = await rig({ webhookId: HOOK })
    await w.send('MESSAGE_CREATE', hooked(OLD_HOOK))
    expect(w.store.messages.size).toBe(1)
    w.store.messages.clear()
    w.store.hooks.add(OLD_HOOK)
    await w.send('MESSAGE_CREATE', hooked(OLD_HOOK))
    expect(w.store.messages.size).toBe(1)
    await w.ingest.load()
    w.store.messages.clear()
    await w.send('MESSAGE_CREATE', hooked(OLD_HOOK))
    expect(w.store.messages.size).toBe(0)
  })

  it('stores no message whose id is a stored part, whoever sent it, as a create, an update with the author, or a re-read', async () => {
    const w = await rig({ webhookId: HOOK, parts: [[MSG, MSG], [PART_2, MSG]], answers: new Map([[PART_2, gw({ id: PART_2, content: 'as read again' })]]) })
    await w.send('MESSAGE_CREATE', gw({ id: MSG }))
    await w.send('MESSAGE_UPDATE', gw({ id: PART_2, content: 'edited' }))
    await w.send('MESSAGE_UPDATE', { id: PART_2, channel_id: POST, embeds: [] })
    expect(w.store.messages.size).toBe(0)
    // The partial update is read again, as it was before (a part that Discord no longer has goes with its reply), and what is read is no one's to store.
    expect(w.fetch.calls).toEqual([[POST, PART_2]])
  })

  it('stores a message of a person, and one of a webhook it does not know, after asking the store whether it is a part', async () => {
    const w = await rig({ webhookId: HOOK, parts: [[MSG, MSG]] })
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2 }))
    await w.send('MESSAGE_CREATE', hooked(OTHER_HOOK, { id: MSG_3 }))
    expect([...w.store.messages.keys()]).toEqual([MSG_2, MSG_3])
    expect(w.store.asked).toEqual([[MSG_2], [MSG_3]])
  })

  it('does not ask the store about a message of a webhook it knows', async () => {
    const w = await rig({ webhookId: HOOK, hooks: [OLD_HOOK] })
    await w.send('MESSAGE_CREATE', hooked(HOOK))
    await w.send('MESSAGE_CREATE', hooked(OLD_HOOK, { id: MSG_2 }))
    await w.send('MESSAGE_UPDATE', hooked(OLD_HOOK, { id: MSG_3 }))
    expect(w.store.asked).toEqual([])
  })

  it('does not ask the store about an id it cannot hold, and leaves the write to refuse it', async () => {
    const w = await rig({ webhookId: HOOK })
    await w.send('MESSAGE_CREATE', gw({ id: OUT_OF_RANGE }))
    await w.send('MESSAGE_UPDATE', { id: OUT_OF_RANGE, channel_id: POST, embeds: [] })
    expect(w.store.asked).toEqual([])
    expect(w.store.messages.size).toBe(0)
    expect(w.fetch.calls).toEqual([])
  })

  it('gives the gateway the failure when the store cannot say whether a message is a part, and stores nothing', async () => {
    const w = await rig({ webhookId: HOOK })
    w.store.failWhen('knownPartIds', () => true, new Error('connection lost'))
    await expect(w.send('MESSAGE_CREATE', gw())).rejects.toThrow('connection lost')
    await expect(w.send('MESSAGE_UPDATE', gw({ content: 'edited' }))).rejects.toThrow('connection lost')
    expect(w.store.messages.size).toBe(0)
  })

  it('does not take null for a webhook of its own when it has none: a person\'s message has no webhook either', async () => {
    const w = await rig({ webhookId: null })
    await w.send('MESSAGE_CREATE', gw({ webhook_id: null }))
    await w.send('MESSAGE_CREATE', gw({ id: MSG_2 }))
    expect([...w.store.messages.keys()]).toEqual([MSG, MSG_2])
  })

  it('gives the gateway the failure when the webhooks cannot be read, and goes on listening to the posts it has', async () => {
    const w = await rig({ webhookId: HOOK, load: false })
    w.store.failWhen('ownWebhookIds', () => true, new Error('connection lost'))
    await expect(w.ingest.load()).rejects.toThrow('connection lost')
    await w.send('MESSAGE_CREATE', gw())
    expect(w.store.messages.size).toBe(1)
  })
})

describe('a part of a reply of the site, deleted in Discord', () => {
  it.each([
    ['the first part', MSG],
    ['a part after it', PART_2],
    ['the last part', PART_3],
  ])('takes the whole reply with %s: the message goes, and the deletion of the other parts is queued', async (_, part) => {
    const w = await rig({ ...siteReply() })
    expect(await w.send('MESSAGE_DELETE', { id: part, channel_id: POST })).toBeUndefined()
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
    expect(w.store.parts.size).toBe(0)
    expect(w.store.queued).toEqual([{ messageKey: MSG, postId: POST, partIds: [MSG, PART_2, PART_3].filter((p) => p !== part) }])
  })

  it('still deletes a message of Discord as before, and does not queue anything for it', async () => {
    const w = await rig({ ...siteReply() })
    await w.send('MESSAGE_DELETE', { id: MSG_2, channel_id: POST })
    expect([...w.store.messages.keys()]).toEqual([MSG])
    expect(w.store.queued).toEqual([])
    expect(w.store.parts.size).toBe(3)
  })

  it('takes the reply in a bulk delete, with the plain messages of it', async () => {
    const w = await rig({ ...siteReply() })
    await w.send('MESSAGE_DELETE_BULK', { ids: [PART_2, MSG_2, 'nope', MSG_4], channel_id: POST })
    expect(w.store.messages.size).toBe(0)
    expect(w.store.queued).toEqual([{ messageKey: MSG, postId: POST, partIds: [MSG, PART_3] }])
  })

  it('queues no second delete when every part of the reply is deleted together', async () => {
    const w = await rig({ ...siteReply() })
    await w.send('MESSAGE_DELETE_BULK', { ids: [MSG, PART_2, PART_3], channel_id: POST })
    expect(w.store.messages.size).toBe(1)
    expect(w.store.queued).toEqual([])
  })

  it('takes the reply when a re-read finds a part gone, as it deletes any other message Discord no longer has', async () => {
    const w = await rig({ ...siteReply(), answers: new Map() })
    await w.send('MESSAGE_UPDATE', { id: PART_2, channel_id: POST, embeds: [] })
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
    expect(w.store.queued).toEqual([{ messageKey: MSG, postId: POST, partIds: [MSG, PART_3] }])
  })

  it('does nothing for a delete in a channel it does not listen to, and none for an id the store cannot take', async () => {
    const w = await rig({ ...siteReply() })
    const before = w.store.snapshot()
    await w.send('MESSAGE_DELETE', { id: PART_2, channel_id: STRANGER })
    await w.send('MESSAGE_DELETE', { id: OUT_OF_RANGE, channel_id: POST })
    await w.send('MESSAGE_DELETE_BULK', { ids: [OUT_OF_RANGE, 'x'], channel_id: POST })
    await w.send('MESSAGE_DELETE_BULK', { ids: [], channel_id: POST })
    expect(w.store.snapshot()).toBe(before)
  })

  it('gives the post the delete was in, which is where the parts left are', async () => {
    const w = await rig({ ...siteReply(), posts: [POST, POST_2] })
    await w.send('MESSAGE_DELETE', { id: PART_2, channel_id: POST_2 })
    // The store's own check is what ties a part to its post; the ingest says which post the event named.
    expect(w.store.queued[0].postId).toBe(POST_2)
  })

  it('goes on with the next event when the store fails', async () => {
    const w = await rig({ ...siteReply() })
    w.store.failWhen('siteDeleted', () => true, new Error('connection lost'))
    await expect(w.send('MESSAGE_DELETE', { id: PART_2, channel_id: POST })).rejects.toThrow('connection lost')
    expect(w.store.messages.size).toBe(2)
  })
})

// The outbox sleeps while it has nothing to do, and only a kick wakes it: without one, the rest of a reply whose part was deleted in
// Discord stays there until the next write from the site. Each `told` entry is what the store had queued when the outbox was told.
describe('a part of a reply of the site, deleted in Discord: the outbox is told', () => {
  const PART_4 = '200000000000000436'
  const PART_5 = '200000000000000437'

  it.each([
    ['the first part', MSG],
    ['a part after it', PART_2],
    ['the last part', PART_3],
  ])('once the store has queued the deletion of the rest, for a delete of %s', async (_, part) => {
    const w = await rig({ ...siteReply() })
    await w.send('MESSAGE_DELETE', { id: part, channel_id: POST })
    expect(w.told).toEqual([[MSG]])
  })

  it('once for a bulk delete that takes a reply, with plain messages beside it', async () => {
    const w = await rig({ ...siteReply() })
    await w.send('MESSAGE_DELETE_BULK', { ids: [MSG_2, PART_2, PART_3, MSG_4], channel_id: POST })
    expect(w.store.queued).toEqual([{ messageKey: MSG, postId: POST, partIds: [MSG] }])
    expect(w.told).toEqual([[MSG]])
  })

  it('when a re-read finds a part gone', async () => {
    const w = await rig({ ...siteReply(), answers: new Map() })
    await w.send('MESSAGE_UPDATE', { id: PART_3, channel_id: POST, embeds: [] })
    expect(w.told).toEqual([[MSG]])
  })

  it('only once the store has answered: not while its transaction is still going', async () => {
    const w = await rig({ ...siteReply() })
    const gate = Promise.withResolvers()
    const siteDeleted = w.store.siteDeleted
    w.store.siteDeleted = async (...args) => {
      await gate.promise
      return siteDeleted(...args)
    }
    const event = w.send('MESSAGE_DELETE', { id: PART_2, channel_id: POST })
    await flush()
    expect(w.told).toEqual([])
    gate.resolve()
    await event
    expect(w.told).toEqual([[MSG]])
  })

  it('before the plain messages are deleted: a store that fails there leaves the outbox told all the same', async () => {
    const w = await rig({ ...siteReply() })
    w.store.failWhen('deleteMessages', () => true, new Error('connection lost'))
    await expect(w.send('MESSAGE_DELETE_BULK', { ids: [PART_2, MSG_2], channel_id: POST })).rejects.toThrow('connection lost')
    expect(w.told).toEqual([[MSG]])
  })

  it('not when the store fails to take the reply, since nothing was queued, and then when the next delete is taken', async () => {
    const w = await rig({ ...siteReply() })
    let down = true
    w.store.failWhen('siteDeleted', () => down, new Error('connection lost'))
    await expect(w.send('MESSAGE_DELETE', { id: PART_2, channel_id: POST })).rejects.toThrow('connection lost')
    expect(w.told).toEqual([])
    down = false
    await w.send('MESSAGE_DELETE', { id: PART_2, channel_id: POST })
    expect(w.told).toEqual([[MSG]])
  })

  it('never for a message of Discord, a channel it does not listen to, an id the store cannot take, or a delete of nothing', async () => {
    const w = await rig({ ...siteReply(), answers: new Map() })
    await w.send('MESSAGE_DELETE', { id: MSG_2, channel_id: POST })
    await w.send('MESSAGE_DELETE_BULK', { ids: [MSG_3, MSG_4, MSG_3], channel_id: POST })
    await w.send('MESSAGE_UPDATE', { id: MSG_4, channel_id: POST, embeds: [] })
    await w.send('MESSAGE_DELETE', { id: PART_2, channel_id: STRANGER })
    await w.send('MESSAGE_DELETE', { id: OUT_OF_RANGE, channel_id: POST })
    await w.send('MESSAGE_DELETE_BULK', { ids: [OUT_OF_RANGE, 'x', null], channel_id: POST })
    await w.send('MESSAGE_DELETE_BULK', { ids: [], channel_id: POST })
    await w.send('MESSAGE_CREATE', gw({ id: MSG_3 }))
    await w.send('MESSAGE_UPDATE', gw({ id: MSG_3, content: 'edited' }))
    await w.send('MESSAGE_REACTION_ADD', { user_id: MEMBER, channel_id: POST, message_id: PART_2, emoji: FIRE })
    expect(w.told).toEqual([])
    // And the part that is deleted after all that is told of.
    await w.send('MESSAGE_DELETE', { id: PART_3, channel_id: POST })
    expect(w.told).toEqual([[MSG]])
    await w.send('THREAD_DELETE', { id: POST, parent_id: FORUM })
    expect(w.told).toEqual([[MSG]])
  })

  it('after every event whose store call took a reply, once, and after no other event (property)', async () => {
    const ID = fc.constantFrom(MSG, PART_2, PART_3, MSG_2, MSG_3, PART_4, PART_5, MSG_4, OUT_OF_RANGE)
    const event = fc.oneof(
      ID.map((id) => ['MESSAGE_DELETE', { id, channel_id: POST }]),
      fc.array(ID, { maxLength: 5 }).map((ids) => ['MESSAGE_DELETE_BULK', { ids, channel_id: POST }]),
      ID.map((id) => ['MESSAGE_UPDATE', { id, channel_id: POST, embeds: [] }]),
      ID.map((id) => ['MESSAGE_DELETE', { id, channel_id: STRANGER }]),
    )
    const seen = { told: 0, quiet: 0 }
    await fc.assert(
      fc.asyncProperty(fc.array(event, { minLength: 1, maxLength: 8 }), async (events) => {
        // Two replies of the site: MSG of three parts, and MSG_3 of two.
        const w = await rig({
          messages: [...siteReply().messages, storedMessage({ id: MSG_3, webhookId: HOOK, authorId: MEMBER }), storedMessage({ id: MSG_4 })],
          parts: [...siteReply().parts, [MSG_3, MSG_3], [PART_4, MSG_3], [PART_5, MSG_3]],
          answers: new Map(),
        })
        for (const [type, d] of events) {
          const parts = w.store.parts.size
          const queued = w.store.queued.length
          const told = w.told.length
          await w.send(type, d)
          const took = w.store.parts.size < parts
          expect(w.told.length - told).toBe(took ? 1 : 0)
          // Never a deletion queued that the outbox was not told of, and it was told once the store had queued it.
          if (w.store.queued.length > queued) expect(w.told.at(-1)).toEqual(w.store.queued.map((q) => q.messageKey))
          seen[took ? 'told' : 'quiet'] += 1
        }
      }),
      { numRuns: 200 },
    )
    expect(seen.told).toBeGreaterThan(50)
    expect(seen.quiet).toBeGreaterThan(50)
  })
})

describe('reactions to the parts of a reply of the site', () => {
  const on = (emoji, over = {}) => ({ user_id: MEMBER, channel_id: POST, message_id: MSG, guild_id: OWNER, emoji, ...over })
  const reply = () => ({ ...siteReply(), messages: [storedMessage({ webhookId: HOOK, reactions: [reaction(FIRE, FIRE_KEY, 2), reaction(BLOB, BLOB_KEY, 1)] })] })

  it.each([
    ['the first part', MSG],
    ['the second part', PART_2],
    ['the last part', PART_3],
  ])('counts a reaction added to %s on the reply, and takes one off it too', async (_, part) => {
    const w = await rig(reply())
    await w.send('MESSAGE_REACTION_ADD', on(FIRE, { message_id: part }))
    await w.send('MESSAGE_REACTION_ADD', on(WAVE, { message_id: part }))
    expect(mapOf(reactionsOf(w))).toEqual(new Map([[FIRE_KEY, 3], [BLOB_KEY, 1], [WAVE_KEY, 1]]))
    await w.send('MESSAGE_REACTION_REMOVE', on(FIRE, { message_id: part }))
    expect(mapOf(reactionsOf(w)).get(FIRE_KEY)).toBe(2)
  })

  it('clears every reaction of the reply when they are cleared from a part, and one emoji of them when one is', async () => {
    const w = await rig(reply())
    await w.send('MESSAGE_REACTION_REMOVE_EMOJI', { channel_id: POST, message_id: PART_2, guild_id: OWNER, emoji: FIRE })
    expect(mapOf(reactionsOf(w))).toEqual(new Map([[BLOB_KEY, 1]]))
    await w.send('MESSAGE_REACTION_REMOVE_ALL', { channel_id: POST, message_id: PART_3, guild_id: OWNER })
    expect(reactionsOf(w)).toEqual([])
  })

  it('leaves the reactions of a message that is no part as it did, and counts nothing for a message the store does not hold', async () => {
    const w = await rig({ ...reply(), messages: [...reply().messages, storedMessage({ id: MSG_2, reactions: [] })] })
    await w.send('MESSAGE_REACTION_ADD', on(FIRE, { message_id: MSG_2 }))
    expect(mapOf(reactionsOf(w, MSG_2))).toEqual(new Map([[FIRE_KEY, 1]]))
    expect(mapOf(reactionsOf(w))).toEqual(new Map([[FIRE_KEY, 2], [BLOB_KEY, 1]]))
    await w.send('MESSAGE_REACTION_ADD', on(FIRE, { message_id: MSG_4 }))
    expect(w.store.messages.has(MSG_4)).toBe(false)
  })

  it('does not look a part up for what it ignores: the bot, an emoji that cannot be keyed, another channel', async () => {
    const w = await rig(reply())
    const asked = []
    const real = w.store.messageOfPart
    w.store.messageOfPart = async (id) => {
      asked.push(id)
      return real(id)
    }
    await w.send('MESSAGE_REACTION_ADD', { ...on(FIRE, { message_id: PART_2 }), channel_id: STRANGER })
    await w.send('MESSAGE_REACTION_ADD', on({ id: null, name: null }, { message_id: PART_2 }))
    await w.send('MESSAGE_REACTION_REMOVE_EMOJI', { channel_id: POST, message_id: PART_2, emoji: { id: null, name: null } })
    expect(asked).toEqual([])
  })
})

describe('MESSAGE_DELETE and MESSAGE_DELETE_BULK', () => {
  const two = () => [storedMessage(), storedMessage({ id: MSG_2 }), storedMessage({ id: MSG_3 })]

  it('deletes one message of a post it listens to', async () => {
    const w = await rig({ messages: two() })
    expect(await w.send('MESSAGE_DELETE', { id: MSG_2, channel_id: POST, guild_id: OWNER })).toBeUndefined()
    expect([...w.store.messages.keys()]).toEqual([MSG, MSG_3])
  })

  it('leaves a message of a channel it does not listen to', async () => {
    const w = await rig({ messages: two() })
    await w.send('MESSAGE_DELETE', { id: MSG_2, channel_id: STRANGER })
    await w.send('MESSAGE_DELETE', { id: MSG_2 })
    expect(w.store.messages.size).toBe(3)
  })

  it('does nothing twice what it did once, and for a message it does not hold', async () => {
    const w = await rig({ messages: two() })
    await w.send('MESSAGE_DELETE', { id: MSG_2, channel_id: POST })
    const once = w.store.snapshot()
    await w.send('MESSAGE_DELETE', { id: MSG_2, channel_id: POST })
    await w.send('MESSAGE_DELETE', { id: MSG_4, channel_id: POST })
    expect(w.store.snapshot()).toBe(once)
  })

  it.each([undefined, null, 5, 'abc', '', OUT_OF_RANGE, '1234567890123456', '200000000000000431 ', {}, [MSG_2]])('ignores a delete of the message id %j', async (id) => {
    const w = await rig({ messages: two() })
    await expect(w.send('MESSAGE_DELETE', { id, channel_id: POST })).resolves.toBeUndefined()
    expect(w.store.messages.size).toBe(3)
  })

  it('takes the largest id a bigint holds and not the next one, so the edge of what the store can take is not off by one', async () => {
    const largest = '9223372036854775807'
    const w = await rig({ messages: [storedMessage({ id: largest }), storedMessage({ id: MSG_2 })] })
    await expect(w.send('MESSAGE_DELETE', { id: '9223372036854775808', channel_id: POST })).resolves.toBeUndefined()
    await expect(w.send('MESSAGE_DELETE_BULK', { ids: ['9223372036854775808', largest], channel_id: POST })).resolves.toBeUndefined()
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
    w.store.messages.set(largest, storedMessage({ id: largest }))
    await w.send('MESSAGE_DELETE', { id: largest, channel_id: POST })
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })

  it('gives the error of a failing store to the caller', async () => {
    const w = await rig({ messages: two() })
    const err = new Error('connection lost')
    w.store.failWhen('deleteMessages', () => true, err)
    await expect(w.send('MESSAGE_DELETE', { id: MSG_2, channel_id: POST })).rejects.toBe(err)
    await expect(w.send('MESSAGE_DELETE_BULK', { ids: [MSG_2], channel_id: POST })).rejects.toBe(err)
  })

  it('deletes a bulk of messages, and only those', async () => {
    const w = await rig({ messages: [...two(), storedMessage({ id: MSG_4 })] })
    expect(await w.send('MESSAGE_DELETE_BULK', { ids: [MSG, MSG_3], channel_id: POST, guild_id: OWNER })).toBeUndefined()
    expect([...w.store.messages.keys()]).toEqual([MSG_2, MSG_4])
  })

  it('leaves the messages of a channel it does not listen to, whatever the ids', async () => {
    const w = await rig({ messages: two() })
    await w.send('MESSAGE_DELETE_BULK', { ids: [MSG, MSG_2, MSG_3], channel_id: STRANGER })
    await w.send('MESSAGE_DELETE_BULK', { ids: [MSG, MSG_2, MSG_3] })
    expect(w.store.messages.size).toBe(3)
  })

  it('deletes the ids it can and leaves the ones it cannot, so one bad id does not keep the others', async () => {
    const w = await rig({ messages: two() })
    await w.send('MESSAGE_DELETE_BULK', { ids: [MSG, undefined, null, 5, 'abc', OUT_OF_RANGE, {}, [MSG_2], '', MSG_3], channel_id: POST })
    // The message that was named in a list of its own is not an id, so it stays.
    expect([...w.store.messages.keys()]).toEqual([MSG_2])
  })

  it('does nothing twice what it did once, for ids it does not hold, and for ids listed twice', async () => {
    const w = await rig({ messages: [...two(), storedMessage({ id: MSG_4 })] })
    await w.send('MESSAGE_DELETE_BULK', { ids: [MSG, MSG, MSG_4], channel_id: POST })
    const once = w.store.snapshot()
    await w.send('MESSAGE_DELETE_BULK', { ids: [MSG, MSG, MSG_4], channel_id: POST })
    expect(w.store.snapshot()).toBe(once)
    expect([...w.store.messages.keys()]).toEqual([MSG_2, MSG_3])
  })

  it.each([undefined, null, 'x', 5, {}, { 0: MSG }, MSG, []])('does nothing for the bulk ids %j', async (ids) => {
    const w = await rig({ messages: two() })
    await expect(w.send('MESSAGE_DELETE_BULK', { ids, channel_id: POST })).resolves.toBeUndefined()
    expect(w.store.messages.size).toBe(3)
  })

  it.each([undefined, null, 'x', 5, []])('does not break on the data %j', async (d) => {
    const w = await rig({ messages: two() })
    await expect(w.send('MESSAGE_DELETE', d)).resolves.toBeUndefined()
    await expect(w.send('MESSAGE_DELETE_BULK', d)).resolves.toBeUndefined()
    expect(w.store.messages.size).toBe(3)
  })
})

describe('reactions', () => {
  const on = (emoji, over = {}) => ({ user_id: MEMBER, channel_id: POST, message_id: MSG, guild_id: OWNER, emoji, ...over })
  const stored = () => [storedMessage({ reactions: [reaction(FIRE, FIRE_KEY, 2), reaction(BLOB, BLOB_KEY, 1)] })]

  it('MESSAGE_REACTION_ADD adds one to the count of a unicode emoji, and one of a custom emoji', async () => {
    const w = await rig({ messages: stored() })
    expect(await w.send('MESSAGE_REACTION_ADD', on(FIRE))).toBeUndefined()
    await w.send('MESSAGE_REACTION_ADD', on(BLOB))
    await w.send('MESSAGE_REACTION_ADD', on(BLOB, { user_id: MEMBER_2 }))
    expect(mapOf(reactionsOf(w))).toEqual(
      new Map([
        [FIRE_KEY, 3],
        [BLOB_KEY, 3],
      ]),
    )
  })

  it('MESSAGE_REACTION_ADD of a new emoji adds it with a count of one', async () => {
    const w = await rig({ messages: stored() })
    await w.send('MESSAGE_REACTION_ADD', on(WAVE))
    expect(reactionsOf(w)).toContainEqual(reaction(WAVE, WAVE_KEY, 1))
    expect(reactionsOf(w)).toHaveLength(3)
  })

  it('MESSAGE_REACTION_REMOVE takes one off, and takes the emoji off when none is left', async () => {
    const w = await rig({ messages: stored() })
    await w.send('MESSAGE_REACTION_REMOVE', on(FIRE))
    expect(mapOf(reactionsOf(w)).get(FIRE_KEY)).toBe(1)
    await w.send('MESSAGE_REACTION_REMOVE', on(BLOB))
    expect(mapOf(reactionsOf(w))).toEqual(new Map([[FIRE_KEY, 1]]))
    await w.send('MESSAGE_REACTION_REMOVE', on(FIRE))
    expect(reactionsOf(w)).toEqual([])
  })

  it('MESSAGE_REACTION_REMOVE of an emoji that is not there changes nothing, and never goes below none', async () => {
    const w = await rig({ messages: stored() })
    await w.send('MESSAGE_REACTION_REMOVE', on(WAVE))
    expect(mapOf(reactionsOf(w))).toEqual(
      new Map([
        [FIRE_KEY, 2],
        [BLOB_KEY, 1],
      ]),
    )
  })

  it('ignores the reactions of the bot itself, as the stored counts never held them', async () => {
    const w = await rig({ messages: stored() })
    await w.send('READY', { user: { id: BOT } })
    const before = w.store.snapshot()
    await w.send('MESSAGE_REACTION_ADD', on(FIRE, { user_id: BOT }))
    await w.send('MESSAGE_REACTION_REMOVE', on(FIRE, { user_id: BOT }))
    await w.send('MESSAGE_REACTION_ADD', on(WAVE, { user_id: BOT }))
    expect(w.store.snapshot()).toBe(before)
    await w.send('MESSAGE_REACTION_ADD', on(FIRE, { user_id: MEMBER }))
    expect(mapOf(reactionsOf(w)).get(FIRE_KEY)).toBe(3)
  })

  it('follows the bot id of the latest READY', async () => {
    const w = await rig({ messages: stored() })
    await w.send('READY', { user: { id: BOT } })
    await w.send('READY', { user: { id: MEMBER } })
    await w.send('MESSAGE_REACTION_ADD', on(FIRE, { user_id: BOT }))
    await w.send('MESSAGE_REACTION_ADD', on(FIRE, { user_id: MEMBER }))
    expect(mapOf(reactionsOf(w)).get(FIRE_KEY)).toBe(3)
  })

  it.each(['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE', 'MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI'])(
    '%s of a channel it does not listen to changes nothing',
    async (type) => {
      const w = await rig({ messages: stored() })
      const before = w.store.snapshot()
      await w.send(type, on(FIRE, { channel_id: STRANGER }))
      await w.send(type, on(FIRE, { channel_id: undefined }))
      expect(w.store.snapshot()).toBe(before)
    },
  )

  it.each(['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE', 'MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI'])(
    '%s of a message that is not stored changes nothing, and neither does one with an id that cannot be',
    async (type) => {
      const w = await rig({ messages: stored() })
      const before = w.store.snapshot()
      for (const message_id of [MSG_2, undefined, null, 5, 'abc', '', OUT_OF_RANGE, '200000000000000430 ', {}, [MSG]]) {
        await expect(w.send(type, on(FIRE, { message_id }))).resolves.toBeUndefined()
      }
      expect(w.store.snapshot()).toBe(before)
    },
  )

  it.each(['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE'])('%s with an emoji that cannot be told apart writes nothing', async (type) => {
    const w = await rig({ messages: stored() })
    const before = w.store.snapshot()
    for (const emoji of [undefined, null, 'fire', 5, [], {}, { id: null, name: null }, { id: null, name: '' }, { id: 'abc', name: 'x' }, { id: 5, name: 'x' }, { id: null, name: 'a'.repeat(33) }]) {
      await expect(w.send(type, on(emoji))).resolves.toBeUndefined()
    }
    expect(w.store.snapshot()).toBe(before)
  })

  it('MESSAGE_REACTION_REMOVE_ALL takes every reaction off', async () => {
    const w = await rig({ messages: [...stored(), storedMessage({ id: MSG_2, reactions: [reaction(WAVE, WAVE_KEY, 4)] })] })
    expect(await w.send('MESSAGE_REACTION_REMOVE_ALL', { channel_id: POST, message_id: MSG, guild_id: OWNER })).toBeUndefined()
    expect(reactionsOf(w)).toEqual([])
    expect(reactionsOf(w, MSG_2)).toEqual([reaction(WAVE, WAVE_KEY, 4)])
  })

  it('MESSAGE_REACTION_REMOVE_EMOJI takes off one emoji, whoever reacted', async () => {
    const w = await rig({ messages: stored() })
    expect(await w.send('MESSAGE_REACTION_REMOVE_EMOJI', { channel_id: POST, message_id: MSG, emoji: FIRE })).toBeUndefined()
    expect(reactionsOf(w)).toEqual([reaction(BLOB, BLOB_KEY, 1)])
    await w.send('MESSAGE_REACTION_REMOVE_EMOJI', { channel_id: POST, message_id: MSG, emoji: BLOB })
    expect(reactionsOf(w)).toEqual([])
  })

  it('MESSAGE_REACTION_REMOVE_EMOJI that cannot be told apart takes nothing off: it never clears them all', async () => {
    const w = await rig({ messages: stored() })
    const before = w.store.snapshot()
    for (const emoji of [undefined, null, 'fire', 5, [], {}, { id: null, name: null }, { id: null, name: '' }, { id: 'abc', name: 'x' }, { id: 5, name: 'x' }]) {
      await expect(w.send('MESSAGE_REACTION_REMOVE_EMOJI', { channel_id: POST, message_id: MSG, emoji })).resolves.toBeUndefined()
    }
    expect(w.store.snapshot()).toBe(before)
  })

  it('MESSAGE_REACTION_REMOVE_EMOJI of an emoji that is not there changes nothing', async () => {
    const w = await rig({ messages: stored() })
    await w.send('MESSAGE_REACTION_REMOVE_EMOJI', { channel_id: POST, message_id: MSG, emoji: WAVE })
    expect(mapOf(reactionsOf(w))).toEqual(
      new Map([
        [FIRE_KEY, 2],
        [BLOB_KEY, 1],
      ]),
    )
  })

  it('does nothing twice what it did once, for the events that clear', async () => {
    const w = await rig({ messages: stored() })
    await w.send('MESSAGE_REACTION_REMOVE_EMOJI', { channel_id: POST, message_id: MSG, emoji: FIRE })
    await w.send('MESSAGE_REACTION_REMOVE_EMOJI', { channel_id: POST, message_id: MSG, emoji: FIRE })
    expect(reactionsOf(w)).toEqual([reaction(BLOB, BLOB_KEY, 1)])
    await w.send('MESSAGE_REACTION_REMOVE_ALL', { channel_id: POST, message_id: MSG })
    await w.send('MESSAGE_REACTION_REMOVE_ALL', { channel_id: POST, message_id: MSG })
    expect(reactionsOf(w)).toEqual([])
  })

  it('gives the error of a failing store to the caller', async () => {
    const err = new Error('connection lost')
    const calls = [
      ['MESSAGE_REACTION_ADD', 'adjustReaction', on(FIRE)],
      ['MESSAGE_REACTION_REMOVE', 'adjustReaction', on(FIRE)],
      ['MESSAGE_REACTION_REMOVE_ALL', 'clearReactions', { channel_id: POST, message_id: MSG }],
      ['MESSAGE_REACTION_REMOVE_EMOJI', 'clearReactions', { channel_id: POST, message_id: MSG, emoji: FIRE }],
    ]
    for (const [type, method, d] of calls) {
      const w = await rig({ messages: stored() })
      w.store.failWhen(method, () => true, err)
      await expect(w.send(type, d)).rejects.toBe(err)
    }
  })

  it.each([undefined, null, 'x', 5, []])('does not break on the data %j', async (d) => {
    const w = await rig({ messages: stored() })
    const before = w.store.snapshot()
    for (const type of ['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE', 'MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI']) {
      await expect(w.send(type, d)).resolves.toBeUndefined()
    }
    expect(w.store.snapshot()).toBe(before)
  })

  it('keeps the counts of any run of reactions as a model that counts them one by one does (property)', async () => {
    const emojis = [
      [FIRE, FIRE_KEY],
      [WAVE, WAVE_KEY],
      [BLOB, BLOB_KEY],
    ]
    const step = fc.record({ add: fc.boolean(), emoji: fc.nat(2), user: fc.constantFrom(MEMBER, MEMBER_2, BOT) })
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 40 }), async (steps) => {
        const w = await rig({ messages: [storedMessage()] })
        await w.send('READY', { user: { id: BOT } })
        const model = new Map()
        for (const { add, emoji, user } of steps) {
          await w.send(add ? 'MESSAGE_REACTION_ADD' : 'MESSAGE_REACTION_REMOVE', on(emojis[emoji][0], { user_id: user }))
          if (user === BOT) continue
          const key = emojis[emoji][1]
          const count = Math.max(0, (model.get(key) ?? 0) + (add ? 1 : -1))
          if (count === 0) model.delete(key)
          else model.set(key, count)
        }
        expect(mapOf(reactionsOf(w))).toEqual(model)
        expect(reactionsOf(w).every((r) => Number.isSafeInteger(r.count) && r.count >= 1)).toBe(true)
      }),
    )
  })
})

describe('the guild and the forum', () => {
  it('CHANNEL_UPDATE of the forum drops what is held of the forum, and the verdicts', async () => {
    const w = await rig()
    expect(await w.send('CHANNEL_UPDATE', { id: FORUM, type: 15, name: 'invented-forum', permission_overwrites: [] })).toBeUndefined()
    expect([...w.guild.held].sort()).toEqual(['emoji', 'guild', 'rules'])
    expect(w.access.verdicts.size).toBe(0)
  })

  it.each([
    ['another channel', { id: STRANGER }],
    ['a post of the forum', { id: POST, parent_id: FORUM }],
    ['no id', {}],
    ['an id that is a number', { id: 200000000000000400 }],
    ['an id that is null', { id: null }],
  ])('CHANNEL_UPDATE of %s drops nothing', async (_, d) => {
    const w = await rig()
    await w.send('CHANNEL_UPDATE', d)
    expect([...w.guild.held].sort()).toEqual([...KINDS].sort())
    expect(w.access.verdicts.size).toBe(2)
  })

  it.each(['GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE'])('%s drops what is held of the guild, and the verdicts', async (type) => {
    const w = await rig()
    expect(await w.send(type, { guild_id: OWNER, role: { id: MEMBER } })).toBeUndefined()
    expect([...w.guild.held].sort()).toEqual(['emoji', 'forum', 'rules'])
    expect(w.access.verdicts.size).toBe(0)
  })

  it.each(['GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'CHANNEL_UPDATE'])('%s with data that is no object does not break', async (type) => {
    for (const d of [undefined, null, 'x', 5, []]) {
      const w = await rig()
      await expect(w.send(type, d)).resolves.toBeUndefined()
      expect(w.guild.held.has('emoji')).toBe(true)
    }
  })

  it.each(['AUTO_MODERATION_RULE_CREATE', 'AUTO_MODERATION_RULE_UPDATE', 'AUTO_MODERATION_RULE_DELETE'])('%s drops only what is held of the AutoMod rules', async (type) => {
    const w = await rig()
    expect(await w.send(type, { id: MEMBER, guild_id: OWNER, name: 'invented rule', trigger_type: 1 })).toBeUndefined()
    expect([...w.guild.held].sort()).toEqual(['emoji', 'forum', 'guild'])
    // The verdicts are drawn from the roles and the forum, never from the rules: none of them is dropped.
    expect(w.access.verdicts.size).toBe(2)
  })

  it.each(['AUTO_MODERATION_RULE_CREATE', 'AUTO_MODERATION_RULE_UPDATE', 'AUTO_MODERATION_RULE_DELETE'])('%s with data that is no object, or none, does not break', async (type) => {
    for (const d of [undefined, null, 'x', 5, [], {}]) {
      const w = await rig()
      await expect(w.send(type, d)).resolves.toBeUndefined()
      expect([...w.guild.held].sort()).toEqual(['emoji', 'forum', 'guild'])
    }
  })

  it('AUTO_MODERATION_ACTION_EXECUTION, which says only that a rule acted, drops nothing', async () => {
    const w = await rig()
    await w.send('AUTO_MODERATION_ACTION_EXECUTION', { guild_id: OWNER, rule_id: MEMBER })
    expect(w.guild.held.size).toBe(4)
  })

  it('GUILD_EMOJIS_UPDATE gives the guild the new emoji as Discord lists them', async () => {
    const w = await rig()
    const emojis = [
      { id: CUSTOM, name: 'invented_blob', animated: false },
      { id: MEMBER, name: 'other_blob', animated: true },
      { id: null, name: 'not custom' },
    ]
    expect(await w.send('GUILD_EMOJIS_UPDATE', { guild_id: OWNER, emojis })).toBeUndefined()
    expect(w.guild.emoji).toEqual(parseEmoji(emojis))
    expect(w.guild.emoji).toEqual([
      { id: CUSTOM, name: 'invented_blob', animated: false },
      { id: MEMBER, name: 'other_blob', animated: true },
    ])
    expect(w.access.verdicts.size).toBe(2)
  })

  it('GUILD_EMOJIS_UPDATE with an empty list empties the emoji', async () => {
    const w = await rig()
    await w.send('GUILD_EMOJIS_UPDATE', { emojis: [] })
    expect(w.guild.emoji).toEqual([])
  })

  it.each([undefined, null, 'x', 5, {}, { emojis: null }, { emojis: 'x' }, { emojis: {} }])('GUILD_EMOJIS_UPDATE with %j has the guild read them again', async (d) => {
    const w = await rig()
    await expect(w.send('GUILD_EMOJIS_UPDATE', d)).resolves.toBeUndefined()
    expect(w.guild.held.has('emoji')).toBe(false)
    expect(w.guild.emoji).toBeNull()
  })
})

describe('what it does not handle', () => {
  const ignored = ['RESUMED', 'GUILD_CREATE', 'GUILD_UPDATE', 'GUILD_DELETE', 'CHANNEL_CREATE', 'CHANNEL_DELETE', 'TYPING_START', 'PRESENCE_UPDATE', 'MESSAGE_REACTION_ADD_MANY', 'message_create', 'READY ', '']

  it.each(ignored)('%s changes nothing', async (type) => {
    const w = await rig({ messages: [storedMessage()] })
    const before = w.store.snapshot()
    expect(await w.send(type, gw({ id: MSG_2, content: 'x', emojis: [], role: {}, threads: [rawThread(POST_2)], ids: [MSG] }))).toBeUndefined()
    expect(w.store.snapshot()).toBe(before)
    expect(w.guild.held.size).toBe(4)
    expect(w.access.verdicts.size).toBe(2)
    expect(w.fetch.calls).toEqual([])
    expect(w.readies.count).toBe(0)
  })

  it.each([undefined, null, 5, {}, [], ['READY'], true, 'constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'a type of %s is ignored',
    async (type) => {
      const w = await rig({ messages: [storedMessage()] })
      const before = w.store.snapshot()
      await expect(w.send(type, gw())).resolves.toBeUndefined()
      expect(w.store.snapshot()).toBe(before)
      expect(w.readies.count).toBe(0)
    },
  )
})

describe('a type that is a symbol', () => {
  it('is ignored too', async () => {
    const w = await rig({ messages: [storedMessage()] })
    const before = w.store.snapshot()
    await expect(w.send(Symbol('READY'), gw())).resolves.toBeUndefined()
    expect(w.store.snapshot()).toBe(before)
  })
})

describe('hostile events (property)', () => {
  const TYPES = [
    'READY',
    'THREAD_CREATE',
    'THREAD_UPDATE',
    'THREAD_DELETE',
    'THREAD_LIST_SYNC',
    'MESSAGE_CREATE',
    'MESSAGE_UPDATE',
    'MESSAGE_DELETE',
    'MESSAGE_DELETE_BULK',
    'MESSAGE_REACTION_ADD',
    'MESSAGE_REACTION_REMOVE',
    'MESSAGE_REACTION_REMOVE_ALL',
    'MESSAGE_REACTION_REMOVE_EMOJI',
    'CHANNEL_UPDATE',
    'GUILD_ROLE_CREATE',
    'GUILD_ROLE_UPDATE',
    'GUILD_ROLE_DELETE',
    'GUILD_EMOJIS_UPDATE',
    'AUTO_MODERATION_RULE_CREATE',
    'AUTO_MODERATION_RULE_UPDATE',
    'AUTO_MODERATION_RULE_DELETE',
  ]
  const KEYS = ['id', 'channel_id', 'message_id', 'user_id', 'parent_id', 'ids', 'threads', 'emoji', 'emojis', 'author', 'user', 'type', 'content', 'owner_id', 'name']
  const value = fc.oneof(
    fc.constantFrom(POST, POST_2, MSG, MSG_2, FORUM, BOT, STRANGER, OUT_OF_RANGE, 'abc', '', null, undefined, 5, true),
    fc.array(fc.oneof(fc.constantFrom(POST, MSG, OUT_OF_RANGE, null), fc.anything()), { maxLength: 4 }),
    fc.anything(),
  )
  const hostile = fc.dictionary(fc.constantFrom(...KEYS), value)

  it('never throws, whatever an event carries, and never stores a row of a post that is not stored', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...TYPES), fc.oneof(hostile, fc.anything()), async (type, d) => {
        const w = await rig({ messages: [storedMessage()] })
        await expect(w.send(type, d)).resolves.toBeUndefined()
        await flush()
        for (const m of w.store.messages.values()) expect(w.store.posts.has(m.postId)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it('never throws for an event of any type either', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.anything()), fc.anything(), async (type, d) => {
        const w = await rig()
        await expect(w.send(type, d)).resolves.toBeUndefined()
      }),
      { numRuns: 200 },
    )
  })

  it('stores the same rows however many times an event of a message comes (property)', async () => {
    const text = fc.string({ maxLength: 60 })
    await fc.assert(
      fc.asyncProperty(text, fc.integer({ min: 1, max: 4 }), fc.constantFrom('MESSAGE_CREATE', 'MESSAGE_UPDATE'), async (content, times, type) => {
        const w = await rig()
        const d = gw({ content })
        for (let i = 0; i < times; i += 1) await w.send(type, d)
        expect(w.store.messages.size).toBe(1)
        expect(w.store.messages.get(MSG)).toMatchObject(parseMessage(d))
      }),
    )
  })

  it('stores nothing for any channel it was not told of (property)', async () => {
    const id = fc.oneof(fc.stringMatching(/^\d{17,20}$/), fc.string(), fc.integer())
    await fc.assert(
      fc.asyncProperty(id, async (channel_id) => {
        fc.pre(channel_id !== POST)
        const w = await rig({ messages: [storedMessage()] })
        const before = w.store.snapshot()
        await w.send('MESSAGE_CREATE', gw({ channel_id }))
        await w.send('MESSAGE_UPDATE', gw({ channel_id }))
        await w.send('MESSAGE_UPDATE', { id: MSG_2, channel_id })
        await w.send('MESSAGE_DELETE', { id: MSG, channel_id })
        await w.send('MESSAGE_DELETE_BULK', { ids: [MSG], channel_id })
        await w.send('MESSAGE_REACTION_ADD', { user_id: MEMBER, channel_id, message_id: MSG, emoji: FIRE })
        await w.send('MESSAGE_REACTION_REMOVE_ALL', { channel_id, message_id: MSG })
        expect(w.store.snapshot()).toBe(before)
        expect(w.fetch.calls).toEqual([])
      }),
    )
  })
})
