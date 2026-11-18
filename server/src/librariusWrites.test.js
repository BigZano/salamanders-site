import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createLibrariusWrites } from './librariusWrites.js'
import { createLimits } from './librariusLimits.js'
import { COPY as OUTBOX_COPY } from './librariusOutbox.js'
import { Upstream } from './discordRoles.js'
import { P } from './librariusPerms.js'
import { toDiscord } from './librariusForm.js'
import { MAX_PICTURE_BYTES } from './librariusBody.js'

// Invented ids, all in the 400-499 range (members 300000000000000xxx). None of them is a real guild, member or message.
const GUILD = '200000000000000400'
const FORUM = '200000000000000420'
const POST = '200000000000000410'
const LOCKED_POST = '200000000000000411'
const GONE_POST = '200000000000000412'
const M_SITE = '200000000000000430' // a reply of the site, by ME
const M_DISCORD = '200000000000000431' // a message written in Discord, by ME
const M_OTHER = '200000000000000432' // a message written in Discord, by OTHER
const M_PICS = '200000000000000433' // a reply of the site, by ME, whose picture falls in its second part
const M_OTHER_SITE = '200000000000000434' // a reply of the site, by OTHER
const M_LOCKED = '200000000000000435' // a reply of the site, by ME, in the locked post
const M_ORPHAN = '200000000000000436' // a message whose post is gone
const M_BAD_LAYOUT = '200000000000000437' // a reply of the site with no layout
const ME = '300000000000000101'
const OTHER = '300000000000000102'
const OUTSIDER = '300000000000000103' // a member who may not read the forum
const NEWBIE = '300000000000000104' // not in the roster yet
const OWNER = '300000000000000199'
const READER = '200000000000000401' // the role the forum lets in
const EXEMPT = '200000000000000402' // a role an AutoMod rule exempts
const SITE = 'https://site.test'
const POST_URL = `${SITE}/reliquarium/librarius/${POST}`
const AVATAR = 'https://cdn.discordapp.com/avatars/300000000000000101/abcdef.png?size=64'
const KEY = 'a1b2c3d4-0000-4000-8000-000000000001'

const BASE = P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY | P.SEND_MESSAGES_IN_THREADS
const facts = () => ({
  ownerId: OWNER,
  roles: [
    { id: GUILD, permissions: String(BASE), name: '@everyone', color: null },
    { id: READER, permissions: '0', name: 'invented reader', color: null },
  ],
  overwrites: [
    { id: GUILD, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) },
    { id: READER, type: 0, allow: String(P.VIEW_CHANNEL), deny: '0' },
  ],
  tags: [],
})

const member = (id, name, roles = [READER], avatar = null) => ({ id, name, avatar, joinedAt: null, roles })
const roster = () => [member(ME, 'Mira Invented', [READER], AVATAR), member(OTHER, 'Orin Test'), member(OUTSIDER, 'Orson Outsider', []), member('300000000000000105', 'Orla Second')]

const verdictOf = (over = {}) => ({
  user: { id: ME, username: 'mira_user' },
  read: true,
  perms: BASE,
  roleIds: [READER],
  admin: false,
  timedOut: false,
  timeoutUntil: null,
  reply: true,
  attach: true,
  manageMessages: false,
  manageThreads: false,
  ...over,
})

const layoutOf = (over = {}) => ({ form: 'v2', replyTo: null, siteUrl: POST_URL, username: 'Mira Invented', avatarUrl: AVATAR, images: [], ...over })
const stored = (id, over = {}) => ({
  id,
  postId: POST,
  authorId: ME,
  authorName: 'Mira Invented',
  authorAvatar: AVATAR,
  origin: 'site',
  source: 'Hello **there**',
  layout: layoutOf(),
  state: null,
  parts: [id],
  ...over,
})

// A long reply with a picture at its end falls in its second part; short, it falls in the first. An edit between the two moves it.
const LONG = `${'A'.repeat(3000)}\n\n${'B'.repeat(3000)}\n\n![a](upload:1)`
const PIC_LAYOUT = layoutOf({ images: [{ ref: 1, name: 'picture-1.png' }] })

/** The world the routes see: what the store holds, what the guild says, the roster, and what has been written to the outbox. */
function world(over = {}) {
  const w = {
    clock: { t: Date.parse('2026-11-18T12:00:00.000Z') },
    posts: new Map([
      [POST, { id: POST, ownerId: OTHER, title: 'invented', locked: false, archived: false }],
      [LOCKED_POST, { id: LOCKED_POST, ownerId: OTHER, title: 'locked', locked: true, archived: false }],
    ]),
    messages: new Map([
      [POST, stored(POST, { authorId: OTHER, origin: 'discord', source: null, layout: null })],
      [M_SITE, stored(M_SITE)],
      [M_DISCORD, stored(M_DISCORD, { origin: 'discord', source: null, layout: null })],
      [M_OTHER, stored(M_OTHER, { authorId: OTHER, origin: 'discord', source: null, layout: null })],
      [M_PICS, stored(M_PICS, { source: LONG, layout: PIC_LAYOUT, parts: [M_PICS, '200000000000000438'] })],
      [M_OTHER_SITE, stored(M_OTHER_SITE, { authorId: OTHER })],
      [M_LOCKED, stored(M_LOCKED, { postId: LOCKED_POST })],
      [M_ORPHAN, stored(M_ORPHAN, { postId: GONE_POST })],
      [M_BAD_LAYOUT, stored(M_BAD_LAYOUT, { layout: null })],
    ]),
    uploads: new Map(),
    rules: [],
    facts: facts(),
    people: roster(),
    queue: [],
    kicks: 0,
    asked: { quoted: [], held: [], outboxFor: [], rules: 0, people: [] },
    outboxRows: [],
    failures: {},
    keys: [KEY],
    ...over,
  }
  const store = {
    getPost: async (id) => {
      const post = w.posts.get(id)
      return post === undefined ? null : { post, lastRead: null }
    },
    quotedMessages: async (postId, ids) => {
      w.asked.quoted.push([postId, ids])
      return ids.map((id) => w.messages.get(id)).filter((m) => m !== undefined && m.postId === postId).map((m) => ({ id: m.id, authorId: m.authorId, authorName: m.authorName, authorAvatar: m.authorAvatar, content: '' }))
    },
    outboxMessage: async (id) => w.messages.get(id) ?? null,
    heldUploadIds: async (authorId, ids) => {
      w.asked.held.push([authorId, ids])
      return new Set(ids.filter((id) => w.uploads.get(id)?.authorId === authorId))
    },
    addUpload: async (upload) => {
      if (w.failures.addUpload) throw new Error('the table is gone')
      const id = String(w.uploads.size + 1)
      w.uploads.set(id, upload)
      return { id }
    },
    enqueueOutbox: async (entry) => {
      if (w.failures.enqueue) throw new Error('the table is gone')
      w.queue.push(structuredClone(entry))
      return { id: String(w.queue.length) }
    },
    outboxFor: async (...args) => {
      w.asked.outboxFor.push(args)
      return w.outboxRows
    },
  }
  const guild = {
    facts: async () => structuredClone(w.facts),
    automodRules: async () => {
      w.asked.rules++
      if (w.failures.rules) throw new Upstream('Discord answered 403 for the AutoMod rules.')
      return structuredClone(w.rules)
    },
  }
  const rosterFake = {
    members: async (options) => {
      w.asked.people.push(options)
      return w.people === null ? null : structuredClone(w.people)
    },
  }
  const outbox = { kick: () => w.kicks++ }
  const limits = createLimits({ now: () => w.clock.t })
  const writes = createLibrariusWrites({
    store,
    guild,
    roster: rosterFake,
    outbox,
    limits,
    guildId: GUILD,
    forumId: FORUM,
    siteUrl: SITE,
    now: () => w.clock.t,
    newKey: () => w.keys.shift() ?? `key-${w.queue.length}`,
    ...(w.options ?? {}),
  })
  return { ...w, w, writes, limits, store }
}

const URL_ = 'https://api.test/librarius/x'
const json = (body, headers = {}) => new Request(URL_, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } })
const out = async (response) => ({ status: response.status, body: await response.json(), headers: response.headers })

/** A request whose body is a stream of `chunks`, pulled one at a time; `seen.pulled` says how many were pulled. */
function streamed(chunks, headers) {
  const seen = { pulled: 0 }
  let i = 0
  const body = new ReadableStream({ pull(c) { if (i >= chunks.length) return c.close(); seen.pulled++; c.enqueue(chunks[i++]) } }, { highWaterMark: 0 })
  return { request: new Request(URL_, { method: 'POST', body, headers, duplex: 'half' }), seen }
}

describe('createLibrariusWrites: what it needs', () => {
  const parts = () => ({ store: {}, guild: {}, roster: {}, outbox: {}, limits: createLimits(), guildId: GUILD, forumId: FORUM, siteUrl: SITE })

  it('takes a form of v2 or plain, and v2 by default', () => {
    expect(() => createLibrariusWrites({ ...parts(), form: 'plain' })).not.toThrow()
    expect(() => createLibrariusWrites(parts())).not.toThrow()
    for (const form of ['v3', '', null, 'V2', 5]) expect(() => createLibrariusWrites({ ...parts(), form }), String(form)).toThrow(new RangeError('form must be "v2" or "plain".'))
  })

  it('takes the site as an https address with no path, and a trailing slash is no matter', () => {
    for (const siteUrl of ['https://site.test', 'https://site.test/', 'https://site.test///', 'https://sm2salamanders.site']) expect(() => createLibrariusWrites({ ...parts(), siteUrl }), siteUrl).not.toThrow()
    const message = "siteUrl must be an https address with no path, short enough for a button (200 characters with a post's path)."
    const bad = [undefined, null, '', 'http://site.test', 'site.test', 'xhttps://site.test', ' https://site.test', 'https://', 'https://site.test/x', 'https://site .test', 'https://site.test>', `https://${'a'.repeat(150)}`, 5, ['https://site.test'], {}]
    for (const siteUrl of bad) {
      let error = null
      try {
        createLibrariusWrites({ ...parts(), siteUrl })
      } catch (e) {
        error = e
      }
      expect(error, String(siteUrl)).toBeInstanceOf(RangeError)
      expect(error.message, String(siteUrl)).toBe(message)
    }
  })

  it('takes a site whose post links come to exactly 200 characters, and no longer', () => {
    // '/reliquarium/librarius/' and a 20-digit id are 43 characters.
    expect(() => createLibrariusWrites({ ...parts(), siteUrl: `https://${'a'.repeat(149)}` })).not.toThrow()
    expect(() => createLibrariusWrites({ ...parts(), siteUrl: `https://${'a'.repeat(150)}` })).toThrow(RangeError)
  })

  it('uses the site as given, without its trailing slash, in what it sends', async () => {
    const t = world({ options: { siteUrl: 'https://site.test//' } })
    await t.writes.reply(POST, json({ source: 'hello' }), verdictOf())
    expect(t.queue[0].payload.siteUrl).toBe(POST_URL)
  })
})

describe('reply: a reply is queued for Discord', () => {
  it('queues the reply, tells the outbox, and answers 202 with the key the member watches it by', async () => {
    const t = world()
    const got = await out(await t.writes.reply(POST, json({ source: 'Hello **there**' }), verdictOf()))
    expect(got).toMatchObject({ status: 202, body: { pending: { key: KEY, state: 'sending' } } })
    expect(got.headers.get('Cache-Control')).toBe('no-store')
    expect(t.queue).toStrictEqual([
      {
        kind: 'send',
        messageKey: KEY,
        authorId: ME,
        payload: {
          postId: POST,
          source: 'Hello **there**',
          replyTo: null,
          mentions: [],
          uploads: [],
          username: 'Mira Invented',
          avatarUrl: AVATAR,
          siteUrl: POST_URL,
        },
      },
    ])
    expect(t.w.kicks).toBe(1)
  })

  it('sends it under the name and picture the roster has for the member, cleaned of the words Discord refuses in a name', async () => {
    const t = world()
    t.people[0].name = 'Discord Mira'
    await t.writes.reply(POST, json({ source: 'hello' }), verdictOf())
    expect(t.queue[0].payload.username).toBe('Mira')
    expect(t.queue[0].payload.avatarUrl).toBe(AVATAR)
  })

  it("falls back on the member's Discord name and no picture when the roster does not know them yet, or has not loaded", async () => {
    for (const people of [roster().filter((p) => p.id !== ME), null]) {
      const t = world({ people })
      await t.writes.reply(POST, json({ source: 'hello' }), verdictOf())
      expect(t.queue[0].payload.username).toBe('mira_user')
      expect(t.queue[0].payload.avatarUrl).toBeNull()
    }
  })

  it('reads the roster with the roles, once', async () => {
    const t = world()
    await t.writes.reply(POST, json({ source: 'hello' }), verdictOf())
    expect(t.asked.people).toStrictEqual([{ roles: true }])
  })

  it('writes the form it was made with, and holds the reply to that form', async () => {
    const seven = 'x'.repeat(7000) // two parts of the primary form, four of the plain one
    const primary = world()
    expect((await primary.writes.reply(POST, json({ source: seven }), verdictOf())).status).toBe(202)
    const plain = world({ options: { form: 'plain' } })
    expect(await out(await plain.writes.reply(POST, json({ source: seven }), verdictOf()))).toMatchObject({ status: 413, body: { error: "That's longer than Discord can carry in 3 messages." } })
    expect(plain.queue).toStrictEqual([])
  })

  it('does not tell the outbox of a reply that was refused, nor queue it', async () => {
    const t = world()
    for (const source of ['', '   ', undefined, 7, null]) await t.writes.reply(POST, json({ source }), verdictOf())
    expect(t.queue).toStrictEqual([])
    expect(t.w.kicks).toBe(0)
  })

  it('queues all the same when it has no outbox to tell, and tells no one', async () => {
    const t = world({ options: { outbox: null } })
    expect((await t.writes.reply(POST, json({ source: 'hello' }), verdictOf())).status).toBe(202)
    expect((await t.writes.edit(M_SITE, json({ source: 'edited' }), verdictOf())).status).toBe(202)
    expect((await t.writes.remove(M_SITE, verdictOf())).status).toBe(202)
    expect(t.queue.map((e) => e.kind)).toStrictEqual(['send', 'edit', 'delete'])
    expect(t.w.kicks).toBe(0)
  })

  it('lets a failure of the queue through, and tells the outbox of nothing', async () => {
    const t = world({ failures: { enqueue: true } })
    await expect(t.writes.reply(POST, json({ source: 'hello' }), verdictOf())).rejects.toThrow('the table is gone')
    expect(t.w.kicks).toBe(0)
  })

  it('takes the key from the clock-free generator it is given, one for each reply', async () => {
    const t = world({ keys: ['one', 'two'] })
    const a = await out(await t.writes.reply(POST, json({ source: 'a' }), verdictOf()))
    const b = await out(await t.writes.reply(POST, json({ source: 'b' }), verdictOf()))
    expect([a.body.pending.key, b.body.pending.key]).toStrictEqual(['one', 'two'])
    expect(t.queue.map((e) => e.messageKey)).toStrictEqual(['one', 'two'])
  })

  it('makes its own random key when it is given no generator', async () => {
    const t = world({ options: { newKey: undefined } })
    const got = await out(await t.writes.reply(POST, json({ source: 'hello' }), verdictOf()))
    expect(got.body.pending.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.queue[0].messageKey).toBe(got.body.pending.key)
  })

  it('stores the source as the member wrote it, with only what Postgres cannot hold put right', async () => {
    const t = world()
    await t.writes.reply(POST, json({ source: 'a\u0000b' }), verdictOf())
    expect(t.queue[0].payload.source).toBe('a�b')
  })
})

describe('reply: who may', () => {
  it('is 404 for a post the store does not hold, before anything else', async () => {
    const t = world()
    for (const verdict of [verdictOf(), verdictOf({ reply: false }), verdictOf({ timedOut: true, timeoutUntil: '2026-11-19T00:00:00.000Z' })]) {
      expect(await out(await t.writes.reply(GONE_POST, json({ source: 'hello' }), verdict))).toStrictEqual({ status: 404, body: { error: 'No such post.' }, headers: expect.anything() })
    }
  })

  it('is 403 for a member who is timed out, who is told until when', async () => {
    const t = world()
    const got = await out(await t.writes.reply(POST, json({ source: 'hello' }), verdictOf({ reply: false, timedOut: true, timeoutUntil: '2026-11-19T10:20:30.000Z' })))
    expect(got).toMatchObject({ status: 403, body: { error: "You're timed out in the server until 2026-11-19T10:20:30.000Z." } })
    expect(t.queue).toStrictEqual([])
  })

  it('is 403 for a member who may not reply in the forum', async () => {
    const t = world()
    const got = await out(await t.writes.reply(POST, json({ source: 'hello' }), verdictOf({ reply: false })))
    expect(got).toMatchObject({ status: 403, body: { error: "You can't reply in this post." } })
    expect(t.queue).toStrictEqual([])
  })

  it('is 403 for a locked post, unless the member may manage threads', async () => {
    const t = world()
    const got = await out(await t.writes.reply(LOCKED_POST, json({ source: 'hello' }), verdictOf()))
    expect(got).toMatchObject({ status: 403, body: { error: 'This post is locked.' } })
    expect(t.queue).toStrictEqual([])
    const librarian = await out(await t.writes.reply(LOCKED_POST, json({ source: 'hello' }), verdictOf({ manageThreads: true })))
    expect(librarian.status).toBe(202)
    expect(t.queue[0].payload.postId).toBe(LOCKED_POST)
  })

  it('tells a member who is timed out of that before it tells them a post is locked, and one who may not reply of that', async () => {
    const t = world()
    const timed = await out(await t.writes.reply(LOCKED_POST, json({ source: 'hello' }), verdictOf({ reply: false, timedOut: true, timeoutUntil: '2026-11-19T00:00:00.000Z' })))
    expect(timed.body.error).toBe("You're timed out in the server until 2026-11-19T00:00:00.000Z.")
    const barred = await out(await t.writes.reply(LOCKED_POST, json({ source: 'hello' }), verdictOf({ reply: false })))
    expect(barred.body.error).toBe("You can't reply in this post.")
  })

  it('reads no body for any of those: the request is left unread', async () => {
    const t = world()
    for (const [postId, verdict] of [[GONE_POST, verdictOf()], [POST, verdictOf({ reply: false })], [LOCKED_POST, verdictOf()], [POST, verdictOf({ reply: false, timedOut: true, timeoutUntil: '2026-11-19T00:00:00.000Z' })]]) {
      const { request, seen } = streamed([new TextEncoder().encode('{"source":"hello"}')], { 'Content-Type': 'application/json' })
      await t.writes.reply(postId, request, verdict)
      expect(seen.pulled, `${postId}`).toBe(0)
    }
  })
})

describe('reply: the limit of 3 a minute', () => {
  it('lets 3 through and refuses the 4th with 429, the wait in Retry-After and in the copy', async () => {
    const t = world()
    for (let i = 0; i < 3; i++) {
      expect((await t.writes.reply(POST, json({ source: `reply ${i}` }), verdictOf())).status).toBe(202)
      t.w.clock.t += 1_000
    }
    const got = await out(await t.writes.reply(POST, json({ source: 'a fourth' }), verdictOf()))
    expect(got.status).toBe(429)
    expect(got.body).toStrictEqual({ error: 'Slow down a little: try again in 57 seconds.' })
    expect(got.headers.get('Retry-After')).toBe('57')
    expect(t.queue).toHaveLength(3)
  })

  it('counts a member of its own: another is not held up, and a minute later it is the same one again', async () => {
    const t = world()
    for (let i = 0; i < 3; i++) await t.writes.reply(POST, json({ source: `r${i}` }), verdictOf())
    expect((await t.writes.reply(POST, json({ source: 'x' }), verdictOf())).status).toBe(429)
    expect((await t.writes.reply(POST, json({ source: 'y' }), verdictOf({ user: { id: OTHER, username: 'orin' } }))).status).toBe(202)
    t.w.clock.t += 60_000
    expect((await t.writes.reply(POST, json({ source: 'z' }), verdictOf())).status).toBe(202)
  })

  it('is looked at before the body is read, so a member over it is not made to send a body', async () => {
    const t = world()
    for (let i = 0; i < 3; i++) await t.writes.reply(POST, json({ source: `r${i}` }), verdictOf())
    const { request, seen } = streamed([new TextEncoder().encode('{"source":"hello"}')], { 'Content-Type': 'application/json' })
    expect((await t.writes.reply(POST, request, verdictOf())).status).toBe(429)
    expect(seen.pulled).toBe(0)
  })

  it('counts only a reply that is queued: refused ones leave every place of the minute', async () => {
    const t = world()
    for (let i = 0; i < 10; i++) await t.writes.reply(POST, json({ source: '' }), verdictOf())
    await t.writes.reply(POST, json('{nope'), verdictOf())
    await t.writes.reply(POST, json({ source: 'x'.repeat(16_001) }), verdictOf())
    for (let i = 0; i < 3; i++) expect((await t.writes.reply(POST, json({ source: `ok ${i}` }), verdictOf())).status).toBe(202)
  })

  it('is not shared with the edit limit or the upload limit', async () => {
    const t = world()
    for (let i = 0; i < 20; i++) t.limits.take('edit', ME)
    for (let i = 0; i < 30; i++) t.limits.take('upload', ME)
    expect((await t.writes.reply(POST, json({ source: 'hello' }), verdictOf())).status).toBe(202)
  })

  it('takes the place just before it queues the reply, so two replies sent together are not both let through', async () => {
    const t = world()
    for (let i = 0; i < 2; i++) await t.writes.reply(POST, json({ source: `r${i}` }), verdictOf())
    const results = await Promise.all([t.writes.reply(POST, json({ source: 'a' }), verdictOf()), t.writes.reply(POST, json({ source: 'b' }), verdictOf())])
    expect(results.map((r) => r.status).sort()).toStrictEqual([202, 429])
    expect(t.queue).toHaveLength(3)
  })
})

describe('reply: the request', () => {
  it('is 415 for a request that is not JSON, 413 past 64 KB, and what is not a reply is 400 "Write something first."', async () => {
    const t = world()
    const text = new Request(URL_, { method: 'POST', body: '{"source":"x"}', headers: { 'Content-Type': 'text/plain' } })
    expect(await out(await t.writes.reply(POST, text, verdictOf()))).toMatchObject({ status: 415, body: { error: 'Send JSON (Content-Type: application/json).' } })
    const big = json({ source: 'x'.repeat(66_000) })
    expect(await out(await t.writes.reply(POST, big, verdictOf()))).toMatchObject({ status: 413, body: { error: 'The request is too large (64 KB at most).' } })
    for (const body of ['{nope', 'null', '7', '"text"', '[]', '[{"source":"x"}]', '{}', '{"source":null}', '{"source":7}', '{"source":["x"]}', '{"source":{}}']) {
      expect(await out(await t.writes.reply(POST, json(body), verdictOf())), body).toMatchObject({ status: 400, body: { error: 'Write something first.' } })
    }
    expect(t.queue).toStrictEqual([])
  })

  it('takes a body of 64 KB, which is the byte cap ahead of the 16,000-character one', async () => {
    const t = world()
    const exact = JSON.stringify({ source: 'x'.repeat(100) })
    const pad = ' '.repeat(65_536 - exact.length)
    expect((await t.writes.reply(POST, json(exact + pad), verdictOf())).status).toBe(202)
    expect((await t.writes.reply(POST, json(`${exact}${pad} `), verdictOf())).status).toBe(413)
  })

  it('refuses a source of more than 16,000 characters with 413, whatever the bytes of it', async () => {
    const t = world()
    expect(await out(await t.writes.reply(POST, json({ source: 'x'.repeat(16_001) }), verdictOf()))).toMatchObject({ status: 413, body: { error: "That's longer than Discord can carry in 3 messages." } })
  })

  it("passes validateReply's refusals as they are: its copy, its status, and the rule with where it matched", async () => {
    const t = world({ rules: [{ id: '200000000000000470', name: 'invented keywords', enabled: true, trigger_type: 1, trigger_metadata: { keyword_filter: ['zorp'], allow_list: [] }, exempt_roles: [], exempt_channels: [] }] })
    expect(await out(await t.writes.reply(POST, json({ source: 'a [link](ftp://x)' }), verdictOf()))).toMatchObject({ status: 400, body: { error: 'Links must start with http:// or https://.' } })
    const blocked = await out(await t.writes.reply(POST, json({ source: 'say zorp here' }), verdictOf()))
    expect(blocked.status).toBe(422)
    expect(blocked.body).toStrictEqual({ error: 'Blocked by the server\'s AutoMod rule "invented keywords".', rule: 'invented keywords', match: { start: 4, end: 8 } })
    expect(t.queue).toStrictEqual([])
  })
})

describe('reply: the AutoMod rules', () => {
  const keyword = (extra = {}) => ({ id: '200000000000000470', name: 'invented keywords', enabled: true, trigger_type: 1, trigger_metadata: { keyword_filter: ['zorp'], allow_list: [] }, exempt_roles: [], exempt_channels: [], ...extra })

  it('refuses a reply a rule blocks, and queues one it does not', async () => {
    const t = world({ rules: [keyword()] })
    expect((await t.writes.reply(POST, json({ source: 'ZORP' }), verdictOf())).status).toBe(422)
    expect((await t.writes.reply(POST, json({ source: 'a calm reply' }), verdictOf())).status).toBe(202)
  })

  it('answers with an Upstream, never a reply let through, when the rules cannot be read', async () => {
    const t = world({ failures: { rules: true } })
    await expect(t.writes.reply(POST, json({ source: 'hello' }), verdictOf())).rejects.toBeInstanceOf(Upstream)
    expect(t.queue).toStrictEqual([])
    expect(t.w.kicks).toBe(0)
  })

  it('applies a rule to the roles of the member who writes, not to those an exemption names', async () => {
    const t = world({ rules: [keyword({ exempt_roles: [EXEMPT] })] })
    expect((await t.writes.reply(POST, json({ source: 'zorp' }), verdictOf())).status).toBe(422)
    t.w.clock.t += 60_000
    expect((await t.writes.reply(POST, json({ source: 'zorp' }), verdictOf({ roleIds: [READER, EXEMPT] }))).status).toBe(202)
  })

  it('applies none of them to an Administrator or a member who manages the server', async () => {
    const t = world({ rules: [keyword()] })
    expect((await t.writes.reply(POST, json({ source: 'zorp' }), verdictOf({ admin: true }))).status).toBe(202)
  })

  it('exempts the forum and the post when a rule exempts them as channels, and no other channel', async () => {
    for (const channel of [FORUM, POST]) {
      const t = world({ rules: [keyword({ exempt_channels: [channel] })] })
      expect((await t.writes.reply(POST, json({ source: 'zorp' }), verdictOf())).status, channel).toBe(202)
    }
    const t = world({ rules: [keyword({ exempt_channels: ['200000000000000499'] })] })
    expect((await t.writes.reply(POST, json({ source: 'zorp' }), verdictOf())).status).toBe(422)
  })

  it('keeps the mentions under what a mention-spam rule leaves, and says so', async () => {
    const t = world({ rules: [{ id: '200000000000000471', name: 'invented mentions', enabled: true, trigger_type: 5, trigger_metadata: { mention_total_limit: 2 }, exempt_roles: [], exempt_channels: [] }] })
    t.people.push(member('300000000000000106', 'Third Person'))
    const mention = (id) => `<@${id}>`
    const one = await out(await t.writes.reply(POST, json({ source: `hi ${mention(OTHER)}`, mentions: [OTHER] }), verdictOf()))
    expect(one.status).toBe(202)
    const two = await out(await t.writes.reply(POST, json({ source: `hi ${mention(OTHER)} ${mention('300000000000000105')}`, mentions: [OTHER, '300000000000000105'] }), verdictOf()))
    expect(two).toMatchObject({ status: 400, body: { error: 'Pick people to mention from the list (1 at most).' } })
  })
})

describe('reply: who it replies to', () => {
  it('quotes a message of the post, as the Discord link to it and its author, and asks the store for it in this post', async () => {
    const t = world()
    expect((await t.writes.reply(POST, json({ source: 'hello', replyTo: M_OTHER }), verdictOf())).status).toBe(202)
    expect(t.asked.quoted).toStrictEqual([[POST, [M_OTHER]]])
    expect(t.queue[0].payload.replyTo).toStrictEqual({ messageId: M_OTHER, authorId: OTHER, url: `https://discord.com/channels/${GUILD}/${POST}/${M_OTHER}` })
  })

  it('takes no replyTo, or a null one, as a reply to nothing, and asks the store nothing', async () => {
    const t = world()
    await t.writes.reply(POST, json({ source: 'a' }), verdictOf())
    await t.writes.reply(POST, json({ source: 'b', replyTo: null }), verdictOf())
    expect(t.queue.map((e) => e.payload.replyTo)).toStrictEqual([null, null])
    expect(t.asked.quoted).toStrictEqual([])
  })

  it('is 400 for a replyTo that is no message id, before the store is asked', async () => {
    const t = world()
    for (const replyTo of ['', 'abc', '123', 7, 200000000000000431, {}, [M_OTHER], true, false, 0, '99999999999999999999', ` ${M_OTHER}`]) {
      const got = await out(await t.writes.reply(POST, json({ source: 'hello', replyTo }), verdictOf()))
      expect(got, String(replyTo)).toMatchObject({ status: 400, body: { error: "That message can't be replied to." } })
    }
    expect(t.asked.quoted).toStrictEqual([])
    expect(t.queue).toStrictEqual([])
  })

  it('is 400 for a message that is not in the post, or not there any more', async () => {
    const t = world()
    t.w.messages.set('200000000000000439', stored('200000000000000439', { postId: LOCKED_POST }))
    for (const replyTo of ['200000000000000439', '200000000000000499']) {
      const got = await out(await t.writes.reply(POST, json({ source: 'hello', replyTo }), verdictOf()))
      expect(got).toMatchObject({ status: 400, body: { error: 'The message you are replying to is no longer there.' } })
    }
    expect(t.queue).toStrictEqual([])
  })

  it('pings the author of the message only for a member who asks it to, as the strict boolean', async () => {
    const t = world()
    for (const pingReply of [true]) await t.writes.reply(POST, json({ source: 'a', replyTo: M_OTHER, pingReply }), verdictOf())
    t.w.clock.t += 60_000
    for (const pingReply of [false, 'true', 1, null, undefined, [true], {}]) {
      await t.writes.reply(POST, json({ source: 'b', replyTo: M_OTHER, pingReply }), verdictOf())
      t.w.clock.t += 60_000
    }
    expect(t.queue[0].payload.mentions).toStrictEqual([OTHER])
    for (const entry of t.queue.slice(1)) expect(entry.payload.mentions).toStrictEqual([])
  })

  it('pings no one when there is no message to reply to', async () => {
    const t = world()
    await t.writes.reply(POST, json({ source: 'a', pingReply: true }), verdictOf())
    expect(t.queue[0].payload.mentions).toStrictEqual([])
  })

  it('pings the author after the people the reply mentions, and never twice', async () => {
    const t = world()
    await t.writes.reply(POST, json({ source: 'hi <@300000000000000105>', mentions: ['300000000000000105'], replyTo: M_OTHER, pingReply: true }), verdictOf())
    expect(t.queue[0].payload.mentions).toStrictEqual(['300000000000000105', OTHER])
    t.w.clock.t += 60_000
    await t.writes.reply(POST, json({ source: `hi <@${OTHER}>`, mentions: [OTHER], replyTo: M_OTHER, pingReply: true }), verdictOf())
    expect(t.queue[1].payload.mentions).toStrictEqual([OTHER])
  })

  it('keeps the author out of the pings when a mention-spam rule leaves no room for them, and lets them in when it does', async () => {
    const spam = (limit) => [{ id: '200000000000000471', name: 'invented mentions', enabled: true, trigger_type: 5, trigger_metadata: { mention_total_limit: limit }, exempt_roles: [], exempt_channels: [] }]
    const asking = { source: `hi <@300000000000000105>`, mentions: ['300000000000000105'], replyTo: M_OTHER, pingReply: true }
    const tight = world({ rules: spam(2) }) // at most 1 mention
    await tight.writes.reply(POST, json(asking), verdictOf())
    expect(tight.queue[0].payload.mentions).toStrictEqual(['300000000000000105'])
    const roomy = world({ rules: spam(3) }) // at most 2
    await roomy.writes.reply(POST, json(asking), verdictOf())
    expect(roomy.queue[0].payload.mentions).toStrictEqual(['300000000000000105', OTHER])
  })

  it('does not ping the author when that would be over the cap of mentions, and the reply still goes', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `30000000000000020${i}`.slice(0, 18))
    const t = world({ people: [...roster(), ...ids.map((id, i) => member(id, `Person ${i}`))] })
    const source = ids.map((id) => `<@${id}>`).join(' ')
    expect((await t.writes.reply(POST, json({ source, mentions: ids, replyTo: M_OTHER, pingReply: true }), verdictOf())).status).toBe(202)
    expect(t.queue[0].payload.mentions).toStrictEqual(ids)
    t.w.clock.t += 60_000
    await t.writes.reply(POST, json({ source: ids.slice(0, 9).map((id) => `<@${id}>`).join(' '), mentions: ids.slice(0, 9), replyTo: M_OTHER, pingReply: true }), verdictOf())
    expect(t.queue[1].payload.mentions).toStrictEqual([...ids.slice(0, 9), OTHER])
  })
})

/** → a source of words that is the shortest that is over the budget of 3 messages with the reply line of `replyTo`, and whether it is over without one. */
function edge(replyTo) {
  const words = (n) => `${'word '.repeat(n)}end`
  const options = (to) => ({ form: 'v2', authorId: ME, replyTo: to, siteUrl: POST_URL, images: [] })
  const over = (n, to) => toDiscord(words(n), options(to)).overBudget
  let lo = 500
  let hi = 4000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (over(mid, replyTo)) hi = mid
    else lo = mid + 1
  }
  return { source: words(lo), overWithout: over(lo, null) }
}

describe('reply: the line that says who it replies to is counted in the budget', () => {
  it('refuses a reply that is over 3 messages only because of it, and takes the same one when it replies to nobody', async () => {
    const to = { authorId: OTHER, url: `https://discord.com/channels/${GUILD}/${POST}/${M_OTHER}` }
    const { source, overWithout } = edge(to)
    expect(overWithout).toBe(false)
    const t = world()
    expect((await t.writes.reply(POST, json({ source }), verdictOf())).status).toBe(202)
    t.w.clock.t += 60_000
    expect((await t.writes.reply(POST, json({ source, replyTo: M_OTHER }), verdictOf())).status).toBe(413)
  })
})

describe('reply: who it mentions', () => {
  it('pings those picked from the list who are mentioned, in the order the text mentions them', async () => {
    const t = world()
    const got = await t.writes.reply(POST, json({ source: `hi <@300000000000000105> and <@${OTHER}>`, mentions: [OTHER, '300000000000000105'] }), verdictOf())
    expect(got.status).toBe(202)
    expect(t.queue[0].payload.mentions).toStrictEqual(['300000000000000105', OTHER])
  })

  it('drops people who were picked and not mentioned, who ping no one', async () => {
    const t = world()
    await t.writes.reply(POST, json({ source: `hi <@${OTHER}>`, mentions: [OTHER, '300000000000000105'] }), verdictOf())
    expect(t.queue[0].payload.mentions).toStrictEqual([OTHER])
  })

  it('refuses a mention of a member who may not read the forum, and of one the roster does not hold, as one that was not picked from the list', async () => {
    const t = world()
    for (const id of [OUTSIDER, NEWBIE, '300000000000000555']) {
      const got = await out(await t.writes.reply(POST, json({ source: `hi <@${id}>`, mentions: [id] }), verdictOf()))
      expect(got, id).toMatchObject({ status: 400, body: { error: 'Pick people to mention from the list (10 at most).' } })
    }
    expect(t.queue).toStrictEqual([])
  })

  it('refuses a mention nobody picked, however it is written', async () => {
    const t = world()
    for (const source of [`<@${OTHER}>`, `<@!${OTHER}>`]) {
      const got = await out(await t.writes.reply(POST, json({ source, mentions: [] }), verdictOf()))
      expect(got.status, source).toBe(400)
    }
    expect((await t.writes.reply(POST, json({ source: `<@${OTHER}>` }), verdictOf())).status).toBe(400)
  })

  it('judges who may read from the guild as it is now: the owner and an Administrator role can, a role the forum shuts out cannot', async () => {
    const t = world()
    t.people.push(member(OWNER, 'The Owner', []))
    const ADMIN_ROLE = '200000000000000403'
    t.w.facts.roles.push({ id: ADMIN_ROLE, permissions: String(P.ADMINISTRATOR), name: 'invented admin', color: null })
    t.people.push(member('300000000000000107', 'An Administrator', [ADMIN_ROLE]))
    const a = await t.writes.reply(POST, json({ source: `<@${OWNER}> <@300000000000000107>`, mentions: [OWNER, '300000000000000107'] }), verdictOf())
    expect(a.status).toBe(202)
    t.w.facts.overwrites = t.w.facts.overwrites.filter((o) => o.id !== READER)
    t.w.clock.t += 60_000
    const b = await t.writes.reply(POST, json({ source: `<@${OTHER}>`, mentions: [OTHER] }), verdictOf())
    expect(b.status).toBe(400)
  })

  it('is 503, and queues nothing, while the roster has not loaded and someone is to be looked for', async () => {
    const t = world({ people: null })
    const got = await out(await t.writes.reply(POST, json({ source: `<@${OTHER}>`, mentions: [OTHER] }), verdictOf()))
    expect(got).toMatchObject({ status: 503, body: { error: 'The member list is not ready yet. Try again.' } })
    expect(t.queue).toStrictEqual([])
  })

  it('is no trouble to the roster being down when nobody is picked, and ids that are no ids are nobody', async () => {
    const t = world({ people: null })
    for (const mentions of [undefined, null, [], [1, 'x', null, {}, '123', true]]) {
      t.w.clock.t += 60_000
      const got = await t.writes.reply(POST, json({ source: 'hello', mentions }), verdictOf())
      expect(got.status, JSON.stringify(mentions)).toBe(202)
    }
  })

  it('refuses mentions that are no list, as one that was not picked from the list', async () => {
    const t = world()
    for (const mentions of ['x', 7, {}, true]) {
      const got = await out(await t.writes.reply(POST, json({ source: 'hello', mentions }), verdictOf()))
      expect(got, JSON.stringify(mentions)).toMatchObject({ status: 400, body: { error: 'Pick people to mention from the list (10 at most).' } })
    }
  })

  it('looks at no more than the first 50 names that were picked', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `3000000000000${String(1000 + i).padStart(5, '0')}`)
    const t = world({ people: [...roster(), ...many.map((id, i) => member(id, `Crowd ${i}`))] })
    const got = await t.writes.reply(POST, json({ source: `<@${many[55]}>`, mentions: many }), verdictOf())
    expect(got.status).toBe(400)
    t.w.clock.t += 60_000
    const inside = await t.writes.reply(POST, json({ source: `<@${many[49]}>`, mentions: many }), verdictOf())
    expect(inside.status).toBe(202)
  })
})

describe('reply: the pictures', () => {
  const held = (t, ...ids) => ids.forEach((id) => t.w.uploads.set(id, { authorId: ME }))

  it("takes the member's own held pictures, in the order sent, and shows the one the source places", async () => {
    const t = world()
    held(t, '7', '9')
    const got = await t.writes.reply(POST, json({ source: 'look ![a](upload:2) and ![b](upload:1)', uploads: ['7', '9'] }), verdictOf())
    expect(got.status).toBe(202)
    expect(t.queue[0].payload.uploads).toStrictEqual(['7', '9'])
    expect(t.asked.held).toStrictEqual([[ME, ['7', '9']]])
  })

  it("refuses a picture that is not the member's, or not held, or that is no id at all", async () => {
    const t = world()
    t.w.uploads.set('8', { authorId: OTHER })
    held(t, '7')
    for (const uploads of [['8'], ['99'], ['7', '8'], [7], ['x'], [null], ['7', '7x'], 'x', {}]) {
      const got = await out(await t.writes.reply(POST, json({ source: 'hello', uploads }), verdictOf()))
      expect(got, JSON.stringify(uploads)).toMatchObject({ status: 400, body: { error: "That picture isn't one of yours." } })
    }
    expect(t.queue).toStrictEqual([])
  })

  it('refuses a picture the source places that was not sent, and more than 10', async () => {
    const t = world()
    const got = await out(await t.writes.reply(POST, json({ source: 'hello ![a](upload:1)' }), verdictOf()))
    expect(got).toMatchObject({ status: 400, body: { error: "That picture isn't one of yours." } })
    const ids = Array.from({ length: 11 }, (_, i) => String(i + 1))
    ids.forEach((id) => held(t, id))
    const eleven = await out(await t.writes.reply(POST, json({ source: 'hello', uploads: ids }), verdictOf()))
    expect(eleven).toMatchObject({ status: 400, body: { error: 'A reply can hold 10 pictures at most.' } })
  })

  it('asks the store for the serial ids among the first 50 only, and asks for nothing when there are none', async () => {
    const t = world()
    await t.writes.reply(POST, json({ source: 'hello' }), verdictOf())
    await t.writes.reply(POST, json({ source: 'hello', uploads: [] }), verdictOf())
    await t.writes.reply(POST, json({ source: 'hello', uploads: 'x' }), verdictOf())
    expect(t.asked.held.map(([, ids]) => ids)).toStrictEqual([[], [], []])
    const lots = Array.from({ length: 70 }, (_, i) => String(i + 1))
    t.w.clock.t += 60_000
    await t.writes.reply(POST, json({ source: 'hello', uploads: ['x', ...lots] }), verdictOf())
    const asked = t.asked.held.at(-1)[1]
    expect(asked).toStrictEqual(lots.slice(0, 50))
  })

  it('asks the store for ids that are strings of digits that fit a bigint, and for no other', async () => {
    const t = world()
    const uploads = [7, 7.5, null, true, '9223372036854775808', '12345678901234567890', '-1', '1.5', '1e3', ' 1', '', '0x10', ['1'], '9223372036854775807', '0', '12']
    await t.writes.reply(POST, json({ source: 'hello', uploads }), verdictOf())
    expect(t.asked.held.at(-1)[1]).toStrictEqual(['9223372036854775807', '0', '12'])
  })
})

// ---- pending ---------------------------------------------------------------------------------------------------------------

describe('pending', () => {
  it("answers the member's own entries for the post, with the state as they see it, and the error only once it has ended", async () => {
    const t = world()
    t.w.outboxRows = [
      { key: 'k1', kind: 'send', state: 'pending', error: 'a technical text', source: 'one', createdAt: '2026-11-18T11:00:00.000Z' },
      { key: 'k2', kind: 'send', state: 'sending', error: 'timeout reaching Discord', source: 'two', createdAt: '2026-11-18T11:01:00.000Z' },
      { key: 'k3', kind: 'send', state: 'blocked', error: "Blocked by the server's rules.", source: 'three', createdAt: '2026-11-18T11:02:00.000Z' },
      { key: M_SITE, kind: 'edit', state: 'failed', error: 'This reply could not be sent.', source: null, createdAt: '2026-11-18T11:03:00.000Z' },
    ]
    const got = await out(await t.writes.pending(POST, verdictOf()))
    expect(got.status).toBe(200)
    expect(got.headers.get('Cache-Control')).toBe('no-store')
    expect(got.body).toStrictEqual({
      pending: [
        { key: 'k1', kind: 'send', state: 'sending', error: null, source: 'one', createdAt: '2026-11-18T11:00:00.000Z' },
        { key: 'k2', kind: 'send', state: 'sending', error: null, source: 'two', createdAt: '2026-11-18T11:01:00.000Z' },
        { key: 'k3', kind: 'send', state: 'blocked', error: "Blocked by the server's rules.", source: 'three', createdAt: '2026-11-18T11:02:00.000Z' },
        { key: M_SITE, kind: 'edit', state: 'failed', error: 'This reply could not be sent.', source: null, createdAt: '2026-11-18T11:03:00.000Z' },
      ],
    })
  })

  it('asks the store for the member, the post, and the last day, and nothing of another member', async () => {
    const t = world()
    await t.writes.pending(POST, verdictOf())
    expect(t.asked.outboxFor).toStrictEqual([[ME, POST, new Date(t.w.clock.t - 86_400_000)]])
    t.w.clock.t += 5_000
    await t.writes.pending(POST, verdictOf({ user: { id: OTHER, username: 'orin' } }))
    expect(t.asked.outboxFor[1]).toStrictEqual([OTHER, POST, new Date(t.w.clock.t - 86_400_000)])
  })

  it('answers none when there are none', async () => {
    const t = world()
    expect(await out(await t.writes.pending(POST, verdictOf()))).toMatchObject({ status: 200, body: { pending: [] } })
  })

  it('is 404 for a post the store does not hold', async () => {
    const t = world()
    expect(await out(await t.writes.pending(GONE_POST, verdictOf()))).toMatchObject({ status: 404, body: { error: 'No such post.' } })
    expect(t.asked.outboxFor).toStrictEqual([])
  })

  it('is for a member who may only read: it asks no more of them than that', async () => {
    const t = world()
    expect((await t.writes.pending(POST, verdictOf({ reply: false, attach: false }))).status).toBe(200)
  })
})

// ---- edit ------------------------------------------------------------------------------------------------------------------

describe('edit', () => {
  it('queues the edit, tells the outbox, and answers 202 with the id of the message', async () => {
    const t = world()
    const got = await out(await t.writes.edit(M_SITE, json({ source: 'Hello **again**' }), verdictOf()))
    expect(got).toMatchObject({ status: 202, body: { pending: { key: M_SITE, state: 'sending' } } })
    expect(t.queue).toStrictEqual([{ kind: 'edit', messageKey: M_SITE, authorId: ME, payload: { postId: POST, source: 'Hello **again**', mentions: [] } }])
    expect(t.w.kicks).toBe(1)
  })

  it('pings those mentioned who were picked, and only those, as a reply does', async () => {
    const t = world()
    expect((await t.writes.edit(M_SITE, json({ source: `hi <@${OTHER}>`, mentions: [OTHER, '300000000000000105'] }), verdictOf())).status).toBe(202)
    expect(t.queue[0].payload.mentions).toStrictEqual([OTHER])
    t.w.clock.t += 1
    const bad = await out(await t.writes.edit(M_SITE, json({ source: `hi <@${OUTSIDER}>`, mentions: [OUTSIDER] }), verdictOf()))
    expect(bad).toMatchObject({ status: 400, body: { error: 'Pick people to mention from the list (10 at most).' } })
  })

  it('is 404 for a message the store does not hold, and for one whose post is gone', async () => {
    const t = world()
    expect(await out(await t.writes.edit('200000000000000499', json({ source: 'x' }), verdictOf()))).toMatchObject({ status: 404, body: { error: 'No such message.' } })
    expect(await out(await t.writes.edit(M_ORPHAN, json({ source: 'x' }), verdictOf()))).toMatchObject({ status: 404, body: { error: 'No such post.' } })
  })

  it("is 403 for anyone but the author, and for a message written in Discord, even the member's own", async () => {
    const t = world()
    expect(await out(await t.writes.edit(M_OTHER_SITE, json({ source: 'x' }), verdictOf()))).toMatchObject({ status: 403, body: { error: 'Only the author can edit this reply.' } })
    expect(await out(await t.writes.edit(M_OTHER, json({ source: 'x' }), verdictOf()))).toMatchObject({ status: 403, body: { error: 'Only the author can edit this reply.' } })
    expect(await out(await t.writes.edit(M_DISCORD, json({ source: 'x' }), verdictOf()))).toMatchObject({ status: 403, body: { error: OUTBOX_COPY.notSite } })
    expect(await out(await t.writes.edit(M_SITE, json({ source: 'x' }), verdictOf({ manageMessages: true, user: { id: OTHER, username: 'o' } })))).toMatchObject({ status: 403 })
    expect(t.queue).toStrictEqual([])
  })

  it('is 403 for a message written in Discord whatever it holds, even a layout and a source', async () => {
    const t = world()
    t.w.messages.set('200000000000000448', stored('200000000000000448', { origin: 'discord' }))
    expect(await out(await t.writes.edit('200000000000000448', json({ source: 'x' }), verdictOf()))).toMatchObject({ status: 403, body: { error: OUTBOX_COPY.notSite } })
    expect(t.queue).toStrictEqual([])
  })

  it('is 403 for a message of the site that has no layout or no source to cut again', async () => {
    const t = world()
    t.w.messages.set('200000000000000440', stored('200000000000000440', { layout: { form: 'v2', replyTo: null, siteUrl: POST_URL } }))
    t.w.messages.set('200000000000000441', stored('200000000000000441', { source: null }))
    for (const id of [M_BAD_LAYOUT, '200000000000000440', '200000000000000441']) {
      expect(await out(await t.writes.edit(id, json({ source: 'x' }), verdictOf())), id).toMatchObject({ status: 403, body: { error: OUTBOX_COPY.notSite } })
    }
  })

  it('is 403 for a member who is timed out, who may not reply, or who meets a locked post', async () => {
    const t = world()
    expect(await out(await t.writes.edit(M_SITE, json({ source: 'x' }), verdictOf({ reply: false, timedOut: true, timeoutUntil: '2026-11-19T00:00:00.000Z' })))).toMatchObject({ status: 403, body: { error: "You're timed out in the server until 2026-11-19T00:00:00.000Z." } })
    expect(await out(await t.writes.edit(M_SITE, json({ source: 'x' }), verdictOf({ reply: false })))).toMatchObject({ status: 403, body: { error: "You can't edit in this post." } })
    expect(await out(await t.writes.edit(M_LOCKED, json({ source: 'x' }), verdictOf()))).toMatchObject({ status: 403, body: { error: 'This post is locked.' } })
    expect((await t.writes.edit(M_LOCKED, json({ source: 'x' }), verdictOf({ manageThreads: true }))).status).toBe(202)
    expect(t.queue).toHaveLength(1)
  })

  it('is 409 while the message is being changed already, and goes ahead for one whose last edit was blocked', async () => {
    const t = world()
    t.w.messages.set('200000000000000442', stored('200000000000000442', { state: 'sending' }))
    t.w.messages.set('200000000000000443', stored('200000000000000443', { state: 'blocked' }))
    expect(await out(await t.writes.edit('200000000000000442', json({ source: 'x' }), verdictOf()))).toMatchObject({ status: 409, body: { error: 'This message is already being changed. Try again in a moment.' } })
    expect((await t.writes.edit('200000000000000443', json({ source: 'x' }), verdictOf())).status).toBe(202)
  })

  it('is 429 over 20 edits a minute, looked at before the body is read, and counts only an edit that is queued', async () => {
    const t = world()
    for (let i = 0; i < 25; i++) await t.writes.edit(M_SITE, json({ source: '' }), verdictOf())
    for (let i = 0; i < 20; i++) expect((await t.writes.edit(M_SITE, json({ source: `edit ${i}` }), verdictOf())).status).toBe(202)
    const { request, seen } = streamed([new TextEncoder().encode('{"source":"x"}')], { 'Content-Type': 'application/json' })
    const got = await out(await t.writes.edit(M_SITE, request, verdictOf()))
    expect(got).toMatchObject({ status: 429, body: { error: 'Slow down a little: try again in 60 seconds.' } })
    expect(got.headers.get('Retry-After')).toBe('60')
    expect(seen.pulled).toBe(0)
    t.w.clock.t += 60_000
    expect((await t.writes.edit(M_SITE, json({ source: 'again' }), verdictOf())).status).toBe(202)
  })

  it('shares the 20 a minute with deletes and with the member search', async () => {
    const t = world()
    for (let i = 0; i < 10; i++) await t.writes.remove(M_SITE, verdictOf())
    for (let i = 0; i < 10; i++) await t.writes.search(new URL('https://api.test/librarius/members?q=Or'), verdictOf())
    expect((await t.writes.edit(M_SITE, json({ source: 'x' }), verdictOf())).status).toBe(429)
  })

  it('takes the place just before it queues the edit, so two edits sent together are not both let through', async () => {
    const t = world()
    for (let i = 0; i < 19; i++) t.limits.take('edit', ME)
    const results = await Promise.all([t.writes.edit(M_SITE, json({ source: 'a' }), verdictOf()), t.writes.edit(M_SITE, json({ source: 'b' }), verdictOf())])
    expect(results.map((r) => r.status).sort()).toStrictEqual([202, 429])
    expect(t.queue).toHaveLength(1)
  })

  it("is not held up by the member's replies: the two limits are apart", async () => {
    const t = world()
    for (let i = 0; i < 3; i++) await t.writes.reply(POST, json({ source: `r${i}` }), verdictOf())
    expect((await t.writes.edit(M_SITE, json({ source: 'x' }), verdictOf())).status).toBe(202)
  })

  it('is 415 for a body that is not JSON, 413 past 64 KB, and 400 "Write something first." for no source', async () => {
    const t = world()
    expect(await out(await t.writes.edit(M_SITE, new Request(URL_, { method: 'PATCH', body: 'x', headers: { 'Content-Type': 'text/plain' } }), verdictOf()))).toMatchObject({ status: 415, body: { error: 'Send JSON (Content-Type: application/json).' } })
    expect(await out(await t.writes.edit(M_SITE, json({ source: 'x'.repeat(66_000) }), verdictOf()))).toMatchObject({ status: 413, body: { error: 'The request is too large (64 KB at most).' } })
    for (const body of ['{nope', 'null', '[]', '{}', '{"source":5}']) {
      expect(await out(await t.writes.edit(M_SITE, json(body), verdictOf())), body).toMatchObject({ status: 400, body: { error: 'Write something first.' } })
    }
  })

  it('holds the edit to the form the message was sent in, and to what the AutoMod rules say', async () => {
    const t = world({ rules: [{ id: '200000000000000470', name: 'invented keywords', enabled: true, trigger_type: 1, trigger_metadata: { keyword_filter: ['zorp'] }, exempt_roles: [], exempt_channels: [] }] })
    t.w.messages.set('200000000000000444', stored('200000000000000444', { layout: layoutOf({ form: 'plain' }) }))
    expect((await t.writes.edit('200000000000000444', json({ source: 'x'.repeat(7000) }), verdictOf())).status).toBe(413)
    expect((await t.writes.edit(M_SITE, json({ source: 'x'.repeat(7000) }), verdictOf())).status).toBe(202)
    const blocked = await out(await t.writes.edit(M_SITE, json({ source: 'zorp' }), verdictOf()))
    expect(blocked).toMatchObject({ status: 422, body: { rule: 'invented keywords', match: { start: 0, end: 4 } } })
  })

  it('answers with an Upstream, never an edit let through, when the rules cannot be read', async () => {
    const t = world({ failures: { rules: true } })
    await expect(t.writes.edit(M_SITE, json({ source: 'hello' }), verdictOf())).rejects.toBeInstanceOf(Upstream)
    expect(t.queue).toStrictEqual([])
  })

  it('reads the roster with the roles', async () => {
    const t = world()
    await t.writes.edit(M_SITE, json({ source: 'x' }), verdictOf())
    expect(t.asked.people).toStrictEqual([{ roles: true }])
  })

  it('counts the reply line of the message in the budget, as it was sent', async () => {
    const to = { messageId: M_OTHER, authorId: OTHER, url: `https://discord.com/channels/${GUILD}/${POST}/${M_OTHER}` }
    const { source, overWithout } = edge(to)
    expect(overWithout).toBe(false)
    const t = world()
    t.w.messages.set('200000000000000449', stored('200000000000000449', { layout: layoutOf({ replyTo: to }) }))
    expect((await t.writes.edit('200000000000000449', json({ source }), verdictOf())).status).toBe(413)
    expect((await t.writes.edit(M_SITE, json({ source }), verdictOf())).status).toBe(202)
  })

  it('is 503 while the roster has not loaded and someone is to be looked for', async () => {
    const t = world({ people: null })
    expect((await t.writes.edit(M_SITE, json({ source: `<@${OTHER}>`, mentions: [OTHER] }), verdictOf())).status).toBe(503)
    expect((await t.writes.edit(M_SITE, json({ source: 'no one' }), verdictOf())).status).toBe(202)
  })

  describe('pictures, which are fixed when a reply is sent', () => {
    it('takes `uploads` absent or null, or as the names the message has, in order', async () => {
      const t = world()
      const names = ['picture-1.png']
      for (const uploads of [undefined, null, names]) {
        const got = await t.writes.edit(M_PICS, json({ source: `${LONG}!`, uploads }), verdictOf())
        expect(got.status, JSON.stringify(uploads)).toBe(202)
        t.w.messages.get(M_PICS).state = null
      }
    })

    it('is 400, as an edit that would change a picture, for any other `uploads`', async () => {
      const t = world()
      for (const uploads of [[], ['picture-2.png'], ['picture-1.png', 'picture-2.png'], ['5'], 'picture-1.png', {}, 0, false, [null]]) {
        const got = await out(await t.writes.edit(M_PICS, json({ source: LONG, uploads }), verdictOf()))
        expect(got, JSON.stringify(uploads)).toMatchObject({ status: 400, body: { error: OUTBOX_COPY.pictures } })
      }
      const none = await out(await t.writes.edit(M_SITE, json({ source: 'x', uploads: ['picture-1.png'] }), verdictOf()))
      expect(none).toMatchObject({ status: 400, body: { error: OUTBOX_COPY.pictures } })
      expect((await t.writes.edit(M_SITE, json({ source: 'x', uploads: [] }), verdictOf())).status).toBe(202)
      expect(t.queue).toHaveLength(1)
    })

    it('lets an edit of the words through when the picture stays in the part it is in', async () => {
      const t = world()
      const edited = LONG.replace('AAAA', 'aaaa')
      expect((await t.writes.edit(M_PICS, json({ source: edited }), verdictOf())).status).toBe(202)
      expect(t.queue[0].payload.source).toBe(edited)
    })

    it('is 400 for an edit that would move the picture to another part, or take it away', async () => {
      const t = world()
      const moves = ['A\n\nB\n\n![a](upload:1)', `![a](upload:1)\n\n${'A'.repeat(3000)}\n\n${'B'.repeat(3000)}`, `${'A'.repeat(3000)}\n\n${'B'.repeat(3000)}`]
      for (const source of moves) {
        const got = await out(await t.writes.edit(M_PICS, json({ source }), verdictOf()))
        expect(got, source.slice(0, 20)).toMatchObject({ status: 400, body: { error: OUTBOX_COPY.pictures } })
      }
      expect(t.queue).toStrictEqual([])
    })

    it('is 400 for a picture that the source places which the message does not have', async () => {
      const t = world()
      const got = await out(await t.writes.edit(M_SITE, json({ source: 'hello ![a](upload:1)' }), verdictOf()))
      expect(got).toMatchObject({ status: 400, body: { error: "That picture isn't one of yours." } })
    })

    it('does not count a refused edit toward the 20 a minute', async () => {
      const t = world()
      for (let i = 0; i < 30; i++) await t.writes.edit(M_PICS, json({ source: 'A\n\nB' }), verdictOf())
      for (let i = 0; i < 20; i++) expect((await t.writes.edit(M_SITE, json({ source: `ok ${i}` }), verdictOf())).status).toBe(202)
    })
  })

  it('cuts the edit as the message was cut: with the reply it quotes, its footer and its link', async () => {
    const t = world()
    t.w.messages.set('200000000000000445', stored('200000000000000445', { layout: layoutOf({ replyTo: { messageId: M_OTHER, authorId: OTHER, url: `https://discord.com/channels/${GUILD}/${POST}/${M_OTHER}` } }) }))
    expect((await t.writes.edit('200000000000000445', json({ source: 'edited' }), verdictOf())).status).toBe(202)
    expect(t.queue[0].payload).toStrictEqual({ postId: POST, source: 'edited', mentions: [] })
  })

  it('takes a reply line in the layout that is no object as none', async () => {
    const t = world()
    t.w.messages.set('200000000000000446', stored('200000000000000446', { layout: layoutOf({ replyTo: 'nobody' }) }))
    expect((await t.writes.edit('200000000000000446', json({ source: 'edited' }), verdictOf())).status).toBe(202)
  })
})

// ---- remove ----------------------------------------------------------------------------------------------------------------

describe('remove', () => {
  it('queues the delete of a reply of the site by its author, and answers 202', async () => {
    const t = world()
    const got = await out(await t.writes.remove(M_SITE, verdictOf()))
    expect(got).toMatchObject({ status: 202, body: { pending: { key: M_SITE, state: 'sending' } } })
    expect(t.queue).toStrictEqual([{ kind: 'delete', messageKey: M_SITE, authorId: ME, payload: { postId: POST } }])
    expect(t.w.kicks).toBe(1)
  })

  it('lets the author delete a message they wrote in Discord, which the outbox deletes through the bot', async () => {
    const t = world()
    expect((await t.writes.remove(M_DISCORD, verdictOf())).status).toBe(202)
    expect(t.queue[0]).toMatchObject({ kind: 'delete', messageKey: M_DISCORD, authorId: ME })
  })

  it("lets a member who manages messages delete anyone's, recorded as theirs", async () => {
    const t = world()
    for (const id of [M_OTHER, M_OTHER_SITE]) expect((await t.writes.remove(id, verdictOf({ manageMessages: true }))).status).toBe(202)
    expect(t.queue.map((e) => [e.messageKey, e.authorId])).toStrictEqual([[M_OTHER, ME], [M_OTHER_SITE, ME]])
  })

  it("is 403 for anyone else's message, with a reply, a timeout or any other right but Manage Messages", async () => {
    const t = world()
    for (const id of [M_OTHER, M_OTHER_SITE]) {
      const got = await out(await t.writes.remove(id, verdictOf({ manageThreads: true, attach: true, admin: true })))
      expect(got).toMatchObject({ status: 403, body: { error: 'Only the author, or someone who can manage messages, can delete this.' } })
    }
    expect(t.queue).toStrictEqual([])
    expect(t.w.kicks).toBe(0)
  })

  it('lets a member who is timed out delete what they wrote, for it is theirs, and the 403 of a timeout is for writing', async () => {
    const t = world()
    expect((await t.writes.remove(M_SITE, verdictOf({ reply: false, timedOut: true, timeoutUntil: '2026-11-19T00:00:00.000Z' }))).status).toBe(202)
  })

  it('never deletes a whole post: the message that opens it is 403, for its author and for a librarian', async () => {
    const t = world()
    t.w.messages.set(POST, stored(POST, { authorId: ME, origin: 'discord', source: null, layout: null }))
    for (const verdict of [verdictOf(), verdictOf({ manageMessages: true, manageThreads: true, admin: true })]) {
      expect(await out(await t.writes.remove(POST, verdict))).toMatchObject({ status: 403, body: { error: "A whole post can't be deleted here." } })
    }
    expect(t.queue).toStrictEqual([])
  })

  it('is 404 for a message the store does not hold, and for one whose post is gone', async () => {
    const t = world()
    expect(await out(await t.writes.remove('200000000000000499', verdictOf()))).toMatchObject({ status: 404, body: { error: 'No such message.' } })
    expect(await out(await t.writes.remove(M_ORPHAN, verdictOf()))).toMatchObject({ status: 404, body: { error: 'No such post.' } })
  })

  it('is 409 while the message is being changed already', async () => {
    const t = world()
    t.w.messages.set('200000000000000447', stored('200000000000000447', { state: 'sending' }))
    expect(await out(await t.writes.remove('200000000000000447', verdictOf()))).toMatchObject({ status: 409, body: { error: 'This message is already being changed. Try again in a moment.' } })
    expect(t.queue).toStrictEqual([])
  })

  it('is 429 over 20 a minute, counting deletes, and refuses before it queues anything', async () => {
    const t = world()
    for (let i = 0; i < 20; i++) expect((await t.writes.remove(M_SITE, verdictOf())).status).toBe(202)
    const got = await out(await t.writes.remove(M_SITE, verdictOf()))
    expect(got).toMatchObject({ status: 429, body: { error: 'Slow down a little: try again in 60 seconds.' } })
    expect(got.headers.get('Retry-After')).toBe('60')
    expect(t.queue).toHaveLength(20)
  })

  it('does not count a refused delete', async () => {
    const t = world()
    for (let i = 0; i < 40; i++) await t.writes.remove(M_OTHER, verdictOf())
    for (let i = 0; i < 20; i++) expect((await t.writes.remove(M_SITE, verdictOf())).status).toBe(202)
  })
})

// ---- upload ----------------------------------------------------------------------------------------------------------------

const bytesOf = (text) => Array.from(text, (c) => c.charCodeAt(0))
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const chunk = (type, data = []) => [...u32(data.length), ...bytesOf(type), ...data, 0, 0, 0, 0]
const GPS = bytesOf('Comment\u0000GPS 51.5N 0.12W')
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const IHDR = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
const IDAT = chunk('IDAT', [120, 156, 99, 0, 0, 0, 2, 0, 1])
const IEND = chunk('IEND')
const PNG_CLEAN = new Uint8Array([...PNG_SIGNATURE, ...IHDR, ...IDAT, ...IEND])
const PNG_WITH_GPS = new Uint8Array([...PNG_SIGNATURE, ...IHDR, ...chunk('tEXt', GPS), ...IDAT, ...IEND])
// A JPEG with an APP1 (where a phone keeps its location) before the scan.
const JPEG_CLEAN = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9])
const JPEG_WITH_GPS = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, ...bytesOf('GPSx'), 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9])

/** A multipart request of the given files. */
function formOf(files) {
  const form = new FormData()
  for (const { name = 'file', bytes, filename = 'x.png', type = 'image/png' } of files) form.append(name, new Blob([bytes], { type }), filename)
  return new Request(URL_, { method: 'POST', body: form })
}

describe('upload', () => {
  it('holds the picture, stripped, for the member and answers 201 with its id', async () => {
    const t = world()
    const got = await out(await t.writes.upload(formOf([{ bytes: PNG_WITH_GPS }]), verdictOf()))
    expect(got).toMatchObject({ status: 201, body: { id: '1' } })
    expect(got.headers.get('Cache-Control')).toBe('no-store')
    expect(t.uploads.size).toBe(1)
    const held = t.uploads.get('1')
    expect(held.authorId).toBe(ME)
    expect(held.contentType).toBe('image/png')
    expect(held.bytes).toStrictEqual(PNG_CLEAN)
  })

  it('holds a JPEG without its APP1, under a name of its own, whatever name and type the file came with', async () => {
    const t = world()
    const got = await t.writes.upload(formOf([{ bytes: JPEG_WITH_GPS, filename: '../../etc/passwd.png', type: 'text/html' }]), verdictOf())
    expect(got.status).toBe(201)
    const held = t.uploads.get('1')
    expect(held.contentType).toBe('image/jpeg')
    expect(held.name).toBe('picture.jpg')
    expect(held.bytes).toStrictEqual(JPEG_CLEAN)
  })

  it('names a picture by its bytes: png, jpg, webp or gif', async () => {
    const t = world()
    const webp = new Uint8Array([...bytesOf('RIFF'), 0x16, 0, 0, 0, ...bytesOf('WEBP'), ...bytesOf('VP8L'), 0x0a, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0x88, 0x88, 0x08, 0, 0])
    const gif = new Uint8Array([...bytesOf('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b])
    for (const [bytes, name] of [[PNG_CLEAN, 'picture.png'], [webp, 'picture.webp'], [gif, 'picture.gif']]) {
      t.w.clock.t += 3_600_000
      const got = await t.writes.upload(formOf([{ bytes }]), verdictOf())
      expect(got.status, name).toBe(201)
      expect([...t.uploads.values()].at(-1).name).toBe(name)
    }
  })

  it('is 403 for a member who is timed out, who may not reply, and who may not attach: each with its own words', async () => {
    const t = world()
    expect(await out(await t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf({ reply: false, attach: false, timedOut: true, timeoutUntil: '2026-11-19T00:00:00.000Z' })))).toMatchObject({ status: 403, body: { error: "You're timed out in the server until 2026-11-19T00:00:00.000Z." } })
    expect(await out(await t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf({ reply: false, attach: false })))).toMatchObject({ status: 403, body: { error: "You can't reply in this post." } })
    expect(await out(await t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf({ attach: false })))).toMatchObject({ status: 403, body: { error: "You can't attach pictures here." } })
    expect(t.uploads.size).toBe(0)
  })

  it('reads no body for a 403, and none for a member over the limit', async () => {
    const t = world()
    const type = { 'Content-Type': 'multipart/form-data; boundary=x' }
    const one = streamed([new Uint8Array(5)], type)
    await t.writes.upload(one.request, verdictOf({ attach: false }))
    expect(one.seen.pulled).toBe(0)
    for (let i = 0; i < 30; i++) t.limits.take('upload', ME)
    const two = streamed([new Uint8Array(5)], type)
    const got = await out(await t.writes.upload(two.request, verdictOf()))
    expect(got).toMatchObject({ status: 429, body: { error: 'Slow down a little: try again in 3600 seconds.' } })
    expect(got.headers.get('Retry-After')).toBe('3600')
    expect(two.seen.pulled).toBe(0)
  })

  it('takes the place just before it holds the picture, so two pictures sent together are not both let through', async () => {
    const t = world()
    for (let i = 0; i < 29; i++) t.limits.take('upload', ME)
    const results = await Promise.all([t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf()), t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf())])
    expect(results.map((r) => r.status).sort()).toStrictEqual([201, 429])
    expect(t.uploads.size).toBe(1)
  })

  it('lets 30 an hour through and refuses the 31st, and a picture that is refused is not counted', async () => {
    const t = world()
    for (let i = 0; i < 40; i++) await t.writes.upload(formOf([{ bytes: new Uint8Array([1, 2, 3]) }]), verdictOf())
    for (let i = 0; i < 30; i++) {
      expect((await t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf())).status, String(i)).toBe(201)
    }
    expect((await t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf())).status).toBe(429)
    expect(t.uploads.size).toBe(30)
    t.w.clock.t += 3_600_000
    expect((await t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf())).status).toBe(201)
  })

  it('is 415 for a request that is not a form, 400 for one that is not one picture, 413 for a picture past 10 MB', async () => {
    const t = world()
    expect((await t.writes.upload(json({ file: 'x' }), verdictOf())).status).toBe(415)
    expect(await out(await t.writes.upload(formOf([]), verdictOf()))).toMatchObject({ status: 400, body: { error: 'Send one picture at a time.' } })
    expect(await out(await t.writes.upload(formOf([{ bytes: PNG_CLEAN }, { name: 'b', bytes: PNG_CLEAN }]), verdictOf()))).toMatchObject({ status: 400 })
    const big = new Uint8Array(MAX_PICTURE_BYTES + 1)
    big.set(PNG_SIGNATURE)
    expect(await out(await t.writes.upload(formOf([{ bytes: big }]), verdictOf()))).toMatchObject({ status: 413, body: { error: 'That picture is over 10 MB.' } })
    expect(t.uploads.size).toBe(0)
  })

  it('takes a picture of exactly 10 MB', async () => {
    const t = world()
    const exact = new Uint8Array([...PNG_SIGNATURE, ...IHDR, ...chunk('IDAT', new Array(MAX_PICTURE_BYTES - PNG_SIGNATURE.length - IHDR.length - IEND.length - 12).fill(7)), ...IEND])
    expect(exact.length).toBe(MAX_PICTURE_BYTES)
    expect((await t.writes.upload(formOf([{ bytes: exact }]), verdictOf())).status).toBe(201)
  })

  it('is 400 for a file that is no PNG, JPEG, WebP or GIF by its bytes, whatever its name and type say', async () => {
    const t = world()
    const copy = "That file isn't a picture we can take (PNG, JPEG, WebP or GIF)."
    const hostile = [
      bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      bytesOf('<html><script>alert(1)</script></html>'),
      bytesOf('MZ\u0090\u0000 a program'),
      [137, 80, 78, 71], // the start of a PNG and nothing more
      [...PNG_SIGNATURE, ...IHDR, ...IDAT], // a PNG with no end
      [0xff, 0xd8, 0xff, 0xd9], // a JPEG with no picture
      bytesOf('GIF89a'),
      [...bytesOf('RIFF'), 0, 0, 0, 0, ...bytesOf('WAVE')],
    ]
    for (const bytes of hostile) {
      for (const [filename, type] of [['x.png', 'image/png'], ['x.svg', 'image/svg+xml'], ['x.exe', 'application/octet-stream']]) {
        const got = await out(await t.writes.upload(formOf([{ bytes: new Uint8Array(bytes), filename, type }]), verdictOf()))
        expect(got, `${bytes.slice(0, 8)} ${filename}`).toMatchObject({ status: 400, body: { error: copy } })
      }
    }
    expect(t.uploads.size).toBe(0)
  })

  it('lets a failure of the store through', async () => {
    const t = world({ failures: { addUpload: true } })
    await expect(t.writes.upload(formOf([{ bytes: PNG_CLEAN }]), verdictOf())).rejects.toThrow('the table is gone')
  })
})

// ---- search ----------------------------------------------------------------------------------------------------------------

const searchUrl = (q) => new URL(`https://api.test/librarius/members?q=${encodeURIComponent(q)}`)

describe('search', () => {
  it('finds members by their name, as the Watch Commander search does, with their id, name and picture and nothing else', async () => {
    const t = world()
    const got = await out(await t.writes.search(searchUrl('or'), verdictOf()))
    expect(got.status).toBe(200)
    expect(got.headers.get('Cache-Control')).toBe('no-store')
    expect(got.body).toStrictEqual({
      members: [
        { id: OTHER, name: 'Orin Test', avatar: null },
        { id: '300000000000000105', name: 'Orla Second', avatar: null },
      ],
    })
  })

  it('leaves out members who may not read the forum, whatever their name', async () => {
    const t = world()
    const found = (await out(await t.writes.search(searchUrl('Orson'), verdictOf()))).body.members
    expect(found).toStrictEqual([])
    const all = (await out(await t.writes.search(searchUrl('or'), verdictOf()))).body.members.map((m) => m.id)
    expect(all).not.toContain(OUTSIDER)
    expect(all).toContain('300000000000000105')
  })

  it('finds one member by a pasted id, if they may read the forum', async () => {
    const t = world()
    expect((await out(await t.writes.search(searchUrl(OTHER), verdictOf()))).body.members.map((m) => m.id)).toStrictEqual([OTHER])
    t.w.clock.t += 60_000
    expect((await out(await t.writes.search(searchUrl(OUTSIDER), verdictOf()))).body.members).toStrictEqual([])
    t.w.clock.t += 60_000
    expect((await out(await t.writes.search(searchUrl(NEWBIE), verdictOf()))).body.members).toStrictEqual([])
  })

  it('answers at most 10, the ones who may read, not the first ten there are', async () => {
    const crowd = Array.from({ length: 30 }, (_, i) => member(`3000000000000${String(2000 + i).padStart(5, '0')}`, `Aaa Reader ${String(i).padStart(2, '0')}`, i < 12 ? [] : [READER]))
    const t = world({ people: [...roster(), ...crowd] })
    const found = (await out(await t.writes.search(searchUrl('aaa'), verdictOf()))).body.members
    expect(found).toHaveLength(10)
    expect(found.map((m) => m.name)).toStrictEqual(Array.from({ length: 10 }, (_, i) => `Aaa Reader ${String(12 + i).padStart(2, '0')}`))
  })

  it('asks the roster for the roles of each member, and the guild for what the forum allows', async () => {
    const t = world()
    await t.writes.search(searchUrl('or'), verdictOf())
    expect(t.asked.people).toStrictEqual([{ roles: true }])
  })

  it('is 400 for no q, an empty one, one of more than 32 characters, or more than one', async () => {
    const t = world()
    const bad = [new URL('https://api.test/librarius/members'), searchUrl(''), searchUrl('a'.repeat(33)), new URL('https://api.test/librarius/members?q=ab&q=cd'), new URL('https://api.test/librarius/members?Q=ab')]
    for (const url of bad) expect(await out(await t.writes.search(url, verdictOf())), url.href).toMatchObject({ status: 400, body: { error: 'Type 1 to 32 characters to search.' } })
    expect(t.asked.people).toStrictEqual([])
  })

  it('takes a q of 1 to 32 characters: one character finds no one by name, and 32 are no trouble', async () => {
    const t = world()
    expect(await out(await t.writes.search(searchUrl('o'), verdictOf()))).toMatchObject({ status: 200, body: { members: [] } })
    expect(await out(await t.writes.search(searchUrl('o'.repeat(32)), verdictOf()))).toMatchObject({ status: 200, body: { members: [] } })
  })

  it('takes whatever q holds as text to look for, and never as a pattern or a key', async () => {
    const t = world()
    for (const q of ['.*', '(', '[a-z]', '\\', '__proto__', 'constructor', '%', '\u0000', 'Or\u0000', '😀😀', '<script>', ' ', 'x'.repeat(32)]) {
      t.w.clock.t += 60_000
      const got = await out(await t.writes.search(searchUrl(q), verdictOf()))
      expect(got.status, q).toBe(200)
      expect(Array.isArray(got.body.members), q).toBe(true)
    }
  })

  it('takes a place of the 20 a minute for each search, refuses the 21st, and is looked at before the roster is read', async () => {
    const t = world()
    for (let i = 0; i < 20; i++) expect((await t.writes.search(searchUrl('or'), verdictOf())).status).toBe(200)
    const reads = t.asked.people.length
    const got = await out(await t.writes.search(searchUrl('or'), verdictOf()))
    expect(got).toMatchObject({ status: 429, body: { error: 'Slow down a little: try again in 60 seconds.' } })
    expect(got.headers.get('Retry-After')).toBe('60')
    expect(t.asked.people).toHaveLength(reads)
  })

  it('does not take a place for a q that is refused', async () => {
    const t = world()
    for (let i = 0; i < 30; i++) await t.writes.search(searchUrl(''), verdictOf())
    for (let i = 0; i < 20; i++) expect((await t.writes.search(searchUrl('or'), verdictOf())).status).toBe(200)
  })

  it('is 503 until the roster has loaded', async () => {
    const t = world({ people: null })
    expect(await out(await t.writes.search(searchUrl('or'), verdictOf()))).toMatchObject({ status: 503, body: { error: 'The member list is not ready yet. Try again.' } })
  })

  it('judges who may read by the roles the roster gives each member, never by those of the member who asks', async () => {
    const t = world()
    const asker = verdictOf({ roleIds: [] })
    expect((await out(await t.writes.search(searchUrl('Orin'), asker))).body.members.map((m) => m.id)).toStrictEqual([OTHER])
  })

  it('follows the guild: when the forum shuts the reader role out, no one is found', async () => {
    const t = world()
    t.w.facts.overwrites = t.w.facts.overwrites.filter((o) => o.id !== READER)
    expect((await out(await t.writes.search(searchUrl('Orin'), verdictOf()))).body.members).toStrictEqual([])
  })

  it('finds the same whatever the order of the roster, among those who may read (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(roster(), { minLength: 0 }), async (people) => {
        const t = world({ people })
        const found = (await out(await t.writes.search(searchUrl('or'), verdictOf()))).body.members.map((m) => m.id)
        const should = people.filter((p) => p.name.toLowerCase().includes('or') && p.roles.includes(READER)).map((p) => p.id)
        expect([...found].sort()).toStrictEqual([...should].sort())
      }),
      { numRuns: 40 },
    )
  })
})
