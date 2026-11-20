import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createLibrariusHandler } from './librariusHandler.js'
import { Upstream } from './discordRoles.js'

// Invented ids only (the 400-499 range): none of these is a real guild, forum, post, member or message.
const GUILD = '200000000000000400'
const FORUM = '200000000000000401'
const POST = '200000000000000410'
const POST_2 = '200000000000000411'
const READER = Object.freeze({ id: '200000000000000420', username: 'reader' })
const OUTSIDER = Object.freeze({ id: '200000000000000421', username: 'outsider' })
const ALICE = '200000000000000430'
const BOB = '200000000000000431'
const CARA = '200000000000000432'
const DAN = '200000000000000433'
const STRANGER = '200000000000000499'
const M1 = '200000000000000440'
const M2 = '200000000000000441'
const M3 = '200000000000000442'
const M4 = '200000000000000443'
const M5 = '200000000000000444'
const ATT = '200000000000000450'
const ATT_2 = '200000000000000451'
const ATT_3 = '200000000000000452'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const at = (ms) => new Date(NOW + ms).toISOString()
const MINUTE = 60_000
const BIGINT_MAX = 9223372036854775807n

// Deep-frozen, so a handler that changed a verdict would throw. `perms` is a bigint, which JSON cannot hold.
const WRITING = { roleIds: [], admin: false, timedOut: false, timeoutUntil: null, reply: true, attach: false, manageMessages: false, manageThreads: false }
const VERDICTS = {
  reader: Object.freeze({ user: READER, read: true, perms: 3072n, ...WRITING }),
  outsider: Object.freeze({ user: OUTSIDER, read: false, perms: 0n, ...WRITING, reply: false }),
  librarian: Object.freeze({ user: READER, read: true, perms: 3072n, ...WRITING, attach: true, manageMessages: true, manageThreads: true }),
}

const FRESH_LIMITS = {
  reply: { limit: 3, windowSeconds: 60, remaining: 3 },
  edit: { limit: 20, windowSeconds: 60, remaining: 20 },
  upload: { limit: 30, windowSeconds: 3600, remaining: 30 },
}
const NOT_FOUND = { error: 'Not found.' }
const NOT_CONFIGURED = { error: 'The Librarius is not configured.' }
const SIGN_IN = { error: 'Sign in with Discord.' }
const RESTRICTED = { error: 'Restricted to those who can read the Librarius in Discord.' }
const UNREACHABLE = { error: 'Discord could not be reached. Try again.' }
const NO_SUCH_POST = { error: 'No such post.' }
const BAD_CURSOR = { error: 'That page cursor is not valid.' }

const FACTS = {
  ownerId: ALICE,
  roles: [
    { id: GUILD, permissions: '1071698660929', name: '@everyone', color: null },
    { id: '200000000000000460', permissions: '8', name: 'Chaplain', color: '#aa3322' },
  ],
  overwrites: [{ id: GUILD, type: 0, allow: '0', deny: '1024' }],
  tags: [
    { id: '200000000000000470', name: 'Lore' },
    { id: '200000000000000471', name: 'Fleet' },
  ],
}

const avatar = (id) => `https://cdn.example.test/avatars/${id}.png`

const row = (id, over = {}) => ({
  id,
  postId: POST,
  authorId: ALICE,
  authorName: 'Test Alice',
  authorAvatar: avatar(ALICE),
  webhookId: null,
  kind: 0,
  content: `hello ${id}`,
  embeds: [],
  stickers: [],
  reactions: [],
  replyTo: null,
  createdAt: '2026-11-02T18:30:00.000Z',
  editedAt: null,
  rev: '120',
  attachments: [],
  ...over,
})

const attachment = (id, over = {}) => ({
  id,
  filename: 'map.png',
  contentType: 'image/png',
  size: 2048,
  width: 640,
  height: 480,
  url: `https://cdn.example.test/attachments/${id}/map.png?ex=old`,
  proxyUrl: `https://proxy.example.test/attachments/${id}/map.png`,
  expiresAt: at(10 * 60 * MINUTE),
  position: 0,
  ...over,
})

// What a message looks like on the wire, built from the same values the row was made with.
const view = (id, over = {}) => ({
  id,
  authorId: ALICE,
  authorName: 'Test Alice',
  authorAvatar: avatar(ALICE),
  content: `hello ${id}`,
  createdAt: '2026-11-02T18:30:00.000Z',
  editedAt: null,
  replyTo: null,
  attachments: [],
  embeds: [],
  stickers: [],
  reactions: [],
  origin: 'discord',
  ...over,
})

const member = (id, name, over = {}) => ({ id, name, avatar: avatar(`now-${id}`), joinedAt: '2024-01-01T00:00:00.000Z', ...over })

// The post of the routes under test, as the store holds it.
const foundPost = () => ({ post: { id: POST, ownerId: ALICE, title: 'A test post', tagIds: [], pinned: false, locked: false, archived: false, createdAt: '2026-11-01T10:00:00.000Z', replies: 7 }, lastRead: M2 })

/** A store that notes each call (its name and a copy of the arguments), then answers from `over` or with nothing. */
function fakeStore(over = {}) {
  const log = []
  const base = {
    currentRev: () => '500',
    listPosts: () => [],
    getPost: () => foundPost(),
    markViewed: () => undefined,
    listMessages: () => ({ rows: [], hasOlder: false, hasNewer: false }),
    changes: () => ({ rows: [], deleted: [], rev: '0' }),
    quotedMessages: () => [],
    setRead: () => undefined,
    updateAttachmentUrls: () => undefined,
    outboxMessage: () => null,
    outboxFor: () => [],
    heldUploadIds: () => new Set(),
    addUpload: () => ({ id: '1' }),
    enqueueOutbox: () => ({ id: '1' }),
  }
  const store = {}
  for (const [name, impl] of Object.entries({ ...base, ...over })) {
    store[name] = async (...args) => {
      log.push({ name, args: structuredClone(args) })
      return impl(...args)
    }
  }
  return { store, log, calls: (name) => log.filter((c) => c.name === name).map((c) => c.args), names: () => log.map((c) => c.name) }
}

function setup(over = {}) {
  const verdict = 'verdict' in over ? over.verdict : VERDICTS.reader
  const asked = []
  const access = {
    resolve: async (_request, options) => {
      asked.push(options)
      if (verdict instanceof Error) throw verdict
      return verdict
    },
  }
  const made = fakeStore(over.store)
  const facts = over.facts ?? (() => structuredClone(FACTS))
  const guild = { facts: async () => facts(), emoji: async () => (over.emoji ?? (() => []))(), automodRules: async () => (over.rules ?? (() => []))() }
  const importer = { status: async () => (over.status ?? (() => ({ importDone: true })))() }
  const roster = { members: async (options) => (over.roster ?? (() => null))(options) }
  const kicks = { count: 0 }
  // With no outbox (the default here) the webhook is not set up and every write is 503.
  const outbox = over.outbox === undefined ? null : { kick: () => kicks.count++, sendingPausedUntil: () => over.outbox.pausedUntil ?? null, webhookRefused: () => over.outbox.refused ?? null }
  const refreshed = []
  const links = {
    refresh: async (list) => {
      refreshed.push(structuredClone(list))
      return (over.refresh ?? (() => new Map()))(list)
    },
  }
  const handler = createLibrariusHandler({
    access,
    store: made.store,
    guild,
    links,
    importer,
    roster,
    guildId: GUILD,
    forumId: FORUM,
    configured: over.configured ?? true,
    now: over.now ?? (() => NOW),
    outbox,
    ...(over.options ?? {}),
  })
  const call = (method, path, { headers = {}, body } = {}) =>
    handler(new Request(`http://api.test${path}`, { method, headers, body }), new URL(`http://api.test${path}`))
  const get = (path) => call('GET', path)
  const put = (path, text, headers = { 'Content-Type': 'application/json' }) => call('PUT', path, { headers, body: text })
  const send = (method, path, data) => call(method, path, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  return { handler, call, get, put, send, asked, refreshed, kicks, ...made }
}

const body = async (res) => res.json()
const messagesPath = (query = '') => `/librarius/posts/${POST}/messages${query}`
const changesPath = (query = '') => `/librarius/posts/${POST}/changes${query}`

// Every route that needs a reader: [method, path].
const READ_ROUTES = [
  ['GET', '/librarius/posts'],
  ['GET', `/librarius/posts/${POST}`],
  ['GET', messagesPath()],
  ['GET', changesPath('?since=0')],
  ['PUT', `/librarius/posts/${POST}/read`],
  ['GET', '/librarius/emoji'],
]

describe('createLibrariusHandler: which requests are its own', () => {
  it.each(['/', '/health', '/gallery/me', '/librariusx', '/librarius-me', '/Librarius/me', '/x/librarius/me', '//librarius/me', '/librariu'])(
    'leaves %s to the other handlers',
    async (path) => {
      const { get, asked } = setup()
      expect(await get(path)).toBeNull()
      expect(asked).toEqual([])
    },
  )

  it.each([
    ['GET', '/librarius'],
    ['GET', '/librarius/'],
    ['GET', '/librarius/nope'],
    ['GET', '/librarius/ME'],
    ['GET', '/librarius/me/'],
    ['GET', '/librarius/me/x'],
    ['GET', '/librarius/emoji/x'],
    ['GET', '/librarius/posts/'],
    ['GET', `/librarius/posts/${POST}/`],
    ['GET', `/librarius/posts/${POST}/other`],
    ['GET', `/librarius/posts/${POST}/read`],
    ['GET', `/librarius/posts/${POST}/messages/x`],
    ['GET', `/librarius/posts/${POST}/changes/x`],
    ['GET', `/librarius/posts/${POST}/x/y`],
    ['POST', '/librarius/me'],
    ['PUT', '/librarius/me'],
    ['DELETE', '/librarius/me'],
    ['POST', '/librarius/posts'],
    ['PUT', '/librarius/posts'],
    ['POST', `/librarius/posts/${POST}`],
    ['PUT', `/librarius/posts/${POST}`],
    ['DELETE', `/librarius/posts/${POST}`],
    ['PUT', messagesPath()],
    ['DELETE', messagesPath()],
    ['PATCH', messagesPath()],
    ['POST', `/librarius/posts/${POST}/pending`],
    ['PUT', `/librarius/posts/${POST}/pending`],
    ['DELETE', `/librarius/posts/${POST}/pending`],
    ['PATCH', `/librarius/posts/${POST}`],
    ['GET', `/librarius/messages/${M1}`],
    ['POST', `/librarius/messages/${M1}`],
    ['PUT', `/librarius/messages/${M1}`],
    ['GET', '/librarius/messages/'],
    ['PATCH', '/librarius/messages/'],
    ['DELETE', '/librarius/messages/'],
    ['PATCH', `/librarius/messages/${M1}/x`],
    ['DELETE', `/librarius/messages/${M1}/reactions`],
    ['GET', '/librarius/uploads'],
    ['PUT', '/librarius/uploads'],
    ['PATCH', '/librarius/uploads'],
    ['DELETE', '/librarius/uploads'],
    ['POST', '/librarius/uploads/1'],
    ['POST', '/librarius/members'],
    ['PUT', '/librarius/members'],
    ['GET', '/librarius/members/x'],
    ['POST', changesPath('?since=0')],
    ['POST', `/librarius/posts/${POST}/read`],
    ['DELETE', `/librarius/posts/${POST}/read`],
    ['PATCH', `/librarius/posts/${POST}/read`],
    ['POST', '/librarius/emoji'],
    ['PUT', '/librarius/emoji'],
    ['HEAD', '/librarius/me'],
    ['HEAD', '/librarius/posts'],
    ['OPTIONS', '/librarius/posts'],
  ])('answers 404 for %s %s, before it asks who is calling', async (method, path) => {
    const { call, asked, log } = setup({ configured: false })
    const res = await call(method, path)
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual(NOT_FOUND)
    expect(asked).toEqual([])
    expect(log).toEqual([])
  })
})

describe('createLibrariusHandler: the gates, in order', () => {
  it.each([['GET', '/librarius/me'], ...READ_ROUTES])('answers 503 for %s %s when the Librarius is not configured, asking no one', async (method, path) => {
    const { call, asked, log } = setup({ configured: false })
    const res = await call(method, path)
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual(NOT_CONFIGURED)
    expect(asked).toEqual([])
    expect(log).toEqual([])
  })

  it.each([['GET', '/librarius/me'], ...READ_ROUTES])('answers 401 for %s %s when there is no Discord identity', async (method, path) => {
    const { call, log } = setup({ verdict: null })
    const res = await call(method, path)
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual(SIGN_IN)
    expect(log).toEqual([])
  })

  it.each(READ_ROUTES)('answers 403 for %s %s to someone who cannot read the forum, and touches nothing', async (method, path) => {
    const { call, log } = setup({ verdict: VERDICTS.outsider })
    const res = await call(method, path, { headers: { 'Content-Type': 'application/json' }, body: method === 'PUT' ? JSON.stringify({ messageId: M1 }) : undefined })
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual(RESTRICTED)
    expect(log).toEqual([])
  })

  it('answers /librarius/me for someone who cannot read the forum with their access alone: nothing of the forum', async () => {
    const { get, log } = setup({
      verdict: VERDICTS.outsider,
      status: () => {
        throw new Error('the import is not for them')
      },
      facts: () => {
        throw new Error('the forum is not for them')
      },
    })
    const res = await get('/librarius/me')
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ access: false })
    expect(log).toEqual([])
  })

  it('asks for the cached verdict on every route, the PUT included: it writes only the caller\'s own read mark', async () => {
    const { get, put, asked } = setup()
    await get('/librarius/me')
    await get('/librarius/posts')
    expect(asked).toEqual([{ fresh: false }, { fresh: false }])
    const res = await put(`/librarius/posts/${POST}/read`, JSON.stringify({ messageId: M1 }))
    expect(res.status).toBe(204)
    expect(asked).toEqual([{ fresh: false }, { fresh: false }, { fresh: false }])
  })

  it('answers 503 when Discord cannot be reached while the verdict is worked out, on every route', async () => {
    for (const [method, path] of [['GET', '/librarius/me'], ...READ_ROUTES]) {
      const { call, log } = setup({ verdict: new Upstream('down') })
      const res = await call(method, path)
      expect(res.status).toBe(503)
      expect(await body(res)).toEqual(UNREACHABLE)
      expect(log).toEqual([])
    }
  })

  it('answers 503 too when Discord cannot be reached further in', async () => {
    const down = () => {
      throw new Upstream('down')
    }
    expect(await body(await setup({ facts: down }).get('/librarius/me'))).toEqual(UNREACHABLE)
    expect(await body(await setup({ emoji: down }).get('/librarius/emoji'))).toEqual(UNREACHABLE)
    expect(await body(await setup({ store: { listPosts: down } }).get('/librarius/posts'))).toEqual(UNREACHABLE)
  })

  it('lets any other failure through, rather than answering it as a Discord outage', async () => {
    await expect(setup({ verdict: new Error('boom') }).get('/librarius/me')).rejects.toThrow('boom')
    await expect(
      setup({
        store: {
          listPosts: () => {
            throw new TypeError('bad query')
          },
        },
      }).get('/librarius/posts'),
    ).rejects.toThrow('bad query')
  })

  it('reads no request body before the gates have passed', async () => {
    for (const verdict of [null, VERDICTS.outsider]) {
      const { handler } = setup({ verdict })
      const request = new Request(`http://api.test/librarius/posts/${POST}/read`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: M1 }),
      })
      await handler(request, new URL(request.url))
      expect(request.bodyUsed).toBe(false)
    }
  })

  it('never answers a response that can be cached, and names JSON when it has a body', async () => {
    const { get } = setup()
    for (const path of ['/librarius/me', '/librarius/emoji', '/librarius/nope']) {
      const res = await get(path)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(res.headers.get('Content-Type')).toBe('application/json')
    }
    const gone = await setup({ verdict: null }).get('/librarius/me')
    expect(gone.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('GET /librarius/me', () => {
  it('answers a reader with what the site needs of the forum, and nothing of what the guild grants the roles', async () => {
    const { get } = setup({ status: () => ({ importDone: true, lastRunAt: 'x', lastOkAt: 'y', lastError: 'a secret' }) })
    const res = await get('/librarius/me')
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({
      access: true,
      ready: true,
      tags: [
        { id: '200000000000000470', name: 'Lore' },
        { id: '200000000000000471', name: 'Fleet' },
      ],
      roles: [
        { id: GUILD, name: '@everyone', color: null },
        { id: '200000000000000460', name: 'Chaplain', color: '#aa3322' },
      ],
      guildId: GUILD,
      forumId: FORUM,
      form: 'v2',
      can: { reply: false, attach: false, manageMessages: false, manageThreads: false },
      limits: FRESH_LIMITS,
    })
  })

  it('says the forum is not ready until the import has finished', async () => {
    expect((await body(await setup({ status: () => ({ importDone: false }) }).get('/librarius/me'))).ready).toBe(false)
    expect((await body(await setup({ status: () => ({ importDone: true }) }).get('/librarius/me'))).ready).toBe(true)
  })

  it('answers a forum with no tags and a guild with no roles', async () => {
    const { get } = setup({ facts: () => ({ ...FACTS, tags: [], roles: [] }) })
    const out = await body(await get('/librarius/me'))
    expect(out.tags).toEqual([])
    expect(out.roles).toEqual([])
  })
})

describe('GET /librarius/emoji', () => {
  it("answers the guild's emoji", async () => {
    const list = [
      { id: '200000000000000480', name: 'ave', animated: false },
      { id: '200000000000000481', name: 'dance', animated: true },
    ]
    const res = await setup({ emoji: () => list }).get('/librarius/emoji')
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ emoji: list })
  })
})

describe('GET /librarius/posts', () => {
  const post = (id, over = {}) => ({
    id,
    title: 'A test post',
    tagIds: [],
    pinned: false,
    locked: false,
    archived: false,
    createdAt: '2026-11-01T10:00:00.000Z',
    lastActivityAt: '2026-11-02T18:30:00.000Z',
    replies: 3,
    unread: 1,
    latest: { id: M2, authorId: ALICE, authorName: 'Test Alice', authorAvatar: avatar(ALICE), content: 'the latest line', image: null },
    posterIds: [ALICE],
    ...over,
  })

  it("answers the member's topic list as the store has it, asking for their unread counts", async () => {
    const list = [post(POST), post(POST_2, { pinned: true, latest: null, posterIds: [], replies: 0 })]
    const { get, calls } = setup({ store: { listPosts: () => list } })
    const res = await get('/librarius/posts')
    expect(res.status).toBe(200)
    expect((await body(res)).posts).toEqual(list)
    expect(calls('listPosts')).toEqual([[READER.id]])
  })

  it('answers no posts, and nobody, for an empty forum', async () => {
    expect(await body(await setup().get('/librarius/posts'))).toEqual({ posts: [], people: {} })
  })

  it('names the latest authors and the posters from the roster, else from the snapshot stored with the latest message', async () => {
    const list = [
      post(POST, {
        latest: { id: M2, authorId: ALICE, authorName: 'Test Alice', authorAvatar: avatar(ALICE), content: 'x', image: null },
        posterIds: [ALICE, BOB, CARA],
      }),
      post(POST_2, {
        latest: { id: M3, authorId: DAN, authorName: 'Test Dan', authorAvatar: null, content: 'y', image: null },
        posterIds: [DAN, BOB],
      }),
    ]
    const { get } = setup({ store: { listPosts: () => list }, roster: () => [member(BOB, 'Bob Now'), member(DAN, 'Dan Now', { avatar: null }), member(STRANGER, 'Stranger')] })
    const out = await body(await get('/librarius/posts'))
    expect(out.people).toEqual({
      // Alice is not in the roster: what her latest message carried.
      [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) },
      // Bob has only the roster to go by.
      [BOB]: { name: 'Bob Now', avatar: avatar(`now-${BOB}`) },
      // Dan is in both: the roster wins, an avatar of none included.
      [DAN]: { name: 'Dan Now', avatar: null },
    })
    // Cara is in neither: left out, so the site shows its placeholder. Nobody else in the roster is named.
    expect(Object.keys(out.people)).not.toContain(CARA)
  })

  it('uses the snapshots alone while the roster has not loaded', async () => {
    const list = [post(POST, { posterIds: [ALICE, BOB] })]
    const { get } = setup({ store: { listPosts: () => list }, roster: () => null })
    expect((await body(await get('/librarius/posts'))).people).toEqual({ [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) } })
  })

  it('names whoever the latest line of a post mentions, from the roster', async () => {
    const list = [
      post(POST, { latest: { id: M2, authorId: ALICE, authorName: 'Test Alice', authorAvatar: avatar(ALICE), content: `hello <@${CARA}> and <@!${DAN}>, not <@&${BOB}> or <#${BOB}> or <@${STRANGER}>`, image: null }, posterIds: [] }),
      post(POST_2, { latest: { id: M3, authorId: ALICE, authorName: 'Test Alice', authorAvatar: avatar(ALICE), content: `again <@${CARA}>`, image: null }, posterIds: [] }),
    ]
    const { get } = setup({ store: { listPosts: () => list }, roster: () => [member(CARA, 'Cara Now'), member(DAN, 'Dan Now', { avatar: null }), member(BOB, 'Bob Now')] })
    const out = await body(await get('/librarius/posts'))
    expect(out.people).toEqual({
      [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) },
      [CARA]: { name: 'Cara Now', avatar: avatar(`now-${CARA}`) },
      [DAN]: { name: 'Dan Now', avatar: null },
    })
  })

  it('leaves out a mention nobody can name: the roster has not loaded, or does not have them', async () => {
    const list = [post(POST, { latest: { id: M2, authorId: ALICE, authorName: 'Test Alice', authorAvatar: null, content: `hello <@${CARA}>`, image: null }, posterIds: [] }), post(POST_2, { latest: null, posterIds: [] })]
    for (const roster of [() => null, () => [member(DAN, 'Dan Now')]]) {
      const out = await body(await setup({ store: { listPosts: () => list }, roster }).get('/librarius/posts'))
      expect(Object.keys(out.people)).toEqual([ALICE])
    }
  })

  it("keeps the snapshot of an author's newest message when several posts carry one", async () => {
    const older = post(POST, { latest: { id: M1, authorId: ALICE, authorName: 'Alice Then', authorAvatar: null, content: 'x', image: null }, posterIds: [] })
    const newer = post(POST_2, { latest: { id: M3, authorId: ALICE, authorName: 'Alice Later', authorAvatar: avatar('later'), content: 'y', image: null }, posterIds: [] })
    for (const list of [[older, newer], [newer, older]]) {
      const out = await body(await setup({ store: { listPosts: () => list } }).get('/librarius/posts'))
      expect(out.people).toEqual({ [ALICE]: { name: 'Alice Later', avatar: avatar('later') } })
    }
  })

  it('compares message ids as numbers when it keeps the newest snapshot', async () => {
    // 200000000000000999 is below 200000000000001000 as a number, above it as text.
    const older = post(POST, { latest: { id: '200000000000000999', authorId: ALICE, authorName: 'Alice Then', authorAvatar: null, content: 'x', image: null }, posterIds: [] })
    const newer = post(POST_2, { latest: { id: '200000000000001000', authorId: ALICE, authorName: 'Alice Later', authorAvatar: null, content: 'y', image: null }, posterIds: [] })
    for (const list of [[older, newer], [newer, older]]) {
      const out = await body(await setup({ store: { listPosts: () => list } }).get('/librarius/posts'))
      expect(out.people[ALICE].name).toBe('Alice Later')
    }
  })

  describe('the thumbnails', () => {
    const oldUrl = (id) => `https://cdn.example.test/attachments/${id}/thumb.png?ex=old`
    const newUrl = (id) => `https://cdn.example.test/attachments/${id}/thumb.png?ex=fresh`
    const nextExpiry = () => at(24 * 60 * MINUTE)
    const refreshAll = (list) => new Map(list.map(({ id }) => [id, { url: newUrl(id), expiresAt: nextExpiry() }]))
    // A post whose newest message carries an image with this id and expiry: its own post id and message id come from `n`.
    const withImage = (n, expiresAt, over = {}) => {
      const id = String(BigInt('200000000000002000') + BigInt(n))
      return post(String(BigInt('200000000000005000') + BigInt(n)), {
        latest: {
          id: String(BigInt('200000000000003000') + BigInt(n)),
          authorId: ALICE,
          authorName: 'Test Alice',
          authorAvatar: avatar(ALICE),
          content: 'a line',
          image: { id, url: oldUrl(id), expiresAt },
        },
        ...over,
      })
    }
    const imageOf = (out, n) => out.posts[n].latest.image
    const idOf = (n) => String(BigInt('200000000000002000') + BigInt(n))
    // Deep-frozen, so a handler that changed what the store gave it would throw.
    const frozen = (list) => structuredClone(list).map((p) => Object.freeze({ ...p, latest: p.latest && Object.freeze({ ...p.latest, image: p.latest.image && Object.freeze({ ...p.latest.image }) }) }))

    it.each([
      ['one that lapsed an hour ago', -60 * MINUTE, true],
      ['one that lapsed a millisecond ago', -1, true],
      ['one that lapses now', 0, true],
      ['one that lapses in 5 minutes less a millisecond', 5 * MINUTE - 1, true],
      ['one that lapses in exactly 5 minutes', 5 * MINUTE, true],
      ['one that lapses in 5 minutes and a millisecond', 5 * MINUTE + 1, false],
      ['one that lapses in an hour', 60 * MINUTE, false],
    ])('asks for a new link for %s: %s', async (_, offset, due) => {
      const list = [withImage(0, at(offset))]
      const { get, refreshed, calls } = setup({ store: { listPosts: () => list }, refresh: refreshAll })
      const out = await body(await get('/librarius/posts'))
      if (due) {
        expect(refreshed).toEqual([[{ id: idOf(0), url: oldUrl(idOf(0)) }]])
        expect(imageOf(out, 0)).toEqual({ id: idOf(0), url: newUrl(idOf(0)), expiresAt: nextExpiry() })
        expect(calls('updateAttachmentUrls')).toEqual([[[{ id: idOf(0), url: newUrl(idOf(0)), expiresAt: nextExpiry() }]]])
      } else {
        expect(refreshed).toEqual([])
        expect(imageOf(out, 0)).toEqual(list[0].latest.image)
        expect(calls('updateAttachmentUrls')).toEqual([])
      }
    })

    it('leaves an image with no expiry, and one whose expiry cannot be read, alone', async () => {
      const list = [withImage(0, null), withImage(1, 'not a time')]
      const { get, refreshed, calls } = setup({ store: { listPosts: () => list }, refresh: refreshAll })
      const out = await body(await get('/librarius/posts'))
      expect(refreshed).toEqual([])
      expect(calls('updateAttachmentUrls')).toEqual([])
      expect(out.posts).toEqual(list)
    })

    it('asks for no new link when no post has an image: none, a post with no messages, a latest with no image', async () => {
      const list = [post(POST), post(POST_2, { latest: null, posterIds: [] })]
      const { get, refreshed, calls } = setup({ store: { listPosts: () => list }, refresh: refreshAll })
      const out = await body(await get('/librarius/posts'))
      expect(refreshed).toEqual([])
      expect(calls('updateAttachmentUrls')).toEqual([])
      expect(out.posts).toEqual(list)
    })

    it('asks for all the due links in one call, in the order of the list, and renews only those that are due', async () => {
      const list = [withImage(0, at(0)), post(POST_2, { latest: null, posterIds: [] }), withImage(1, at(60 * MINUTE)), withImage(2, at(-MINUTE))]
      const { get, refreshed } = setup({ store: { listPosts: () => list }, refresh: refreshAll })
      const out = await body(await get('/librarius/posts'))
      expect(refreshed).toEqual([
        [
          { id: idOf(0), url: oldUrl(idOf(0)) },
          { id: idOf(2), url: oldUrl(idOf(2)) },
        ],
      ])
      expect(imageOf(out, 0).url).toBe(newUrl(idOf(0)))
      expect(out.posts[1].latest).toBeNull()
      expect(imageOf(out, 2)).toEqual(list[2].latest.image)
      expect(imageOf(out, 3).url).toBe(newUrl(idOf(2)))
    })

    it('asks for no more than the first 50, and shows the rest as they are stored', async () => {
      const list = Array.from({ length: 60 }, (_, n) => withImage(n, at(-MINUTE)))
      const { get, refreshed, calls } = setup({ store: { listPosts: () => list }, refresh: refreshAll })
      const out = await body(await get('/librarius/posts'))
      expect(refreshed).toHaveLength(1)
      expect(refreshed[0].map((a) => a.id)).toEqual(Array.from({ length: 50 }, (_, n) => idOf(n)))
      expect(calls('updateAttachmentUrls')[0][0]).toHaveLength(50)
      expect(out.posts.slice(0, 50).every((p) => p.latest.image.url.endsWith('?ex=fresh'))).toBe(true)
      expect(out.posts.slice(50).map((p) => p.latest.image)).toEqual(list.slice(50).map((p) => p.latest.image))
    })

    it('asks for exactly 50 when 50 are due', async () => {
      const list = Array.from({ length: 50 }, (_, n) => withImage(n, at(0)))
      const { get, refreshed } = setup({ store: { listPosts: () => list }, refresh: refreshAll })
      await get('/librarius/posts')
      expect(refreshed[0]).toHaveLength(50)
    })

    it('keeps the stored link when no new one comes, and stores nothing', async () => {
      const list = [withImage(0, at(0))]
      const { get, refreshed, calls } = setup({ store: { listPosts: () => list }, refresh: () => new Map() })
      const res = await get('/librarius/posts')
      expect(res.status).toBe(200)
      expect(refreshed).toHaveLength(1)
      expect((await body(res)).posts).toEqual(list)
      expect(calls('updateAttachmentUrls')).toEqual([])
    })

    it('uses the links that came, keeps the others, and stores only those that came', async () => {
      const list = [withImage(0, at(0)), withImage(1, at(0))]
      const only = (given) => new Map(given.filter(({ id }) => id === idOf(1)).map(({ id }) => [id, { url: 'https://cdn.example.test/new', expiresAt: null }]))
      const { get, calls } = setup({ store: { listPosts: () => list }, refresh: only })
      const out = await body(await get('/librarius/posts'))
      expect(imageOf(out, 0)).toEqual(list[0].latest.image)
      expect(imageOf(out, 1)).toEqual({ id: idOf(1), url: 'https://cdn.example.test/new', expiresAt: null })
      expect(calls('updateAttachmentUrls')).toEqual([[[{ id: idOf(1), url: 'https://cdn.example.test/new', expiresAt: null }]]])
    })

    it('changes nothing else of the post, and nothing in what the store gave it', async () => {
      const list = frozen([withImage(0, at(0), { pinned: true, unread: 4, tagIds: [] }), withImage(1, at(MINUTE * 60))])
      const { get } = setup({ store: { listPosts: () => list }, refresh: refreshAll })
      const out = await body(await get('/librarius/posts'))
      const expected = structuredClone(list)
      expected[0].latest.image = { id: idOf(0), url: newUrl(idOf(0)), expiresAt: nextExpiry() }
      expect(out.posts).toEqual(expected)
    })

    it('still names the people of the list', async () => {
      const list = [withImage(0, at(0))]
      const out = await body(await setup({ store: { listPosts: () => list }, refresh: refreshAll }).get('/librarius/posts'))
      expect(out.people).toEqual({ [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) } })
    })

    it('does not hide a failure to store the new links', async () => {
      const list = [withImage(0, at(0))]
      const { get } = setup({
        store: {
          listPosts: () => list,
          updateAttachmentUrls: () => {
            throw new Error('write failed')
          },
        },
        refresh: refreshAll,
      })
      await expect(get('/librarius/posts')).rejects.toThrow('write failed')
    })

    it('does not hide a failure of the refresh that is not Discord being unreachable', async () => {
      const list = [withImage(0, at(0))]
      const { get } = setup({
        store: { listPosts: () => list },
        refresh: () => {
          throw new TypeError('each attachment must have an id and a url, as text.')
        },
      })
      await expect(get('/librarius/posts')).rejects.toThrow('each attachment must have an id')
    })
  })
})

describe('GET /librarius/posts/:id', () => {
  it('answers the post, where the member has read to, and the number to poll from; and notes that it was opened', async () => {
    const found = foundPost()
    const { get, calls, names } = setup({ store: { getPost: () => found, currentRev: () => '812' } })
    const res = await get(`/librarius/posts/${POST}`)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ post: found.post, lastRead: M2, rev: '812' })
    expect(calls('getPost')).toEqual([[POST, READER.id]])
    expect(calls('markViewed')).toEqual([[POST]])
    expect(names().indexOf('getPost')).toBeLessThan(names().indexOf('markViewed'))
  })

  it("asks for the number to poll from of this post alone, and answers that post's", async () => {
    const revs = { [POST]: '812', [POST_2]: '3' }
    for (const [id, rev] of Object.entries(revs)) {
      const { get, calls } = setup({ store: { getPost: () => foundPost(), currentRev: (postId) => revs[postId] } })
      expect((await body(await get(`/librarius/posts/${id}`))).rev).toBe(rev)
      expect(calls('currentRev')).toEqual([[id]])
    }
  })

  it('answers a null lastRead for a post the member has not read', async () => {
    const { get } = setup({ store: { getPost: () => ({ ...foundPost(), lastRead: null }) } })
    expect((await body(await get(`/librarius/posts/${POST}`))).lastRead).toBeNull()
  })

  it('answers 404 for a post that is not stored, and does not note a view of it', async () => {
    const { get, calls } = setup({ store: { getPost: () => null } })
    const res = await get(`/librarius/posts/${POST}`)
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual(NO_SUCH_POST)
    expect(calls('markViewed')).toEqual([])
  })

  it.each(['abc', '1', '1234567890123456', '123456789012345678901', '9223372036854775808', '99999999999999999999', '-200000000000000410', '200000000000000410.5', '0x2000000000000041', '%32%30%30%30%30%30%30%30%30%30%30%30%30%30%30%34%31%30', '2000000000000004%0A', '2000000000000004%31%30%20', 'null', 'undefined'])(
    'answers 404 for the post id %s without asking the store',
    async (id) => {
      const found = foundPost()
      const { get, log } = setup({ store: { getPost: () => found } })
      const res = await get(`/librarius/posts/${id}`)
      expect(res.status).toBe(404)
      expect(await body(res)).toEqual(NO_SUCH_POST)
      expect(log).toEqual([])
    },
  )

  it('takes the ends of the id range: 17 digits up to the largest bigint', async () => {
    for (const id of ['10000000000000000', '9223372036854775807']) {
      const found = foundPost()
      const { get, calls } = setup({ store: { getPost: () => found } })
      expect((await get(`/librarius/posts/${id}`)).status).toBe(200)
      expect(calls('getPost')).toEqual([[id, READER.id]])
    }
  })

  it('lets only an id that fits a bigint reach the store, whatever the path holds (property)', async () => {
    const fits = (s) => /^\d{17,20}$/.test(s) && BigInt(s) <= BIGINT_MAX
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 24 }), async (s) => {
        const found = foundPost()
        const { get, calls } = setup({ store: { getPost: () => found } })
        const res = await get(`/librarius/posts/${encodeURIComponent(s)}`)
        if (fits(s)) {
          expect(res.status).toBe(200)
          expect(calls('getPost')).toEqual([[s, READER.id]])
        } else {
          expect(res.status).toBe(404)
          expect(calls('getPost')).toEqual([])
        }
      }),
    )
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 0n, max: 2n ** 70n }), async (n) => {
        const s = String(n)
        const found = foundPost()
        const { get, calls } = setup({ store: { getPost: () => found } })
        const res = await get(`/librarius/posts/${s}`)
        expect(res.status).toBe(fits(s) ? 200 : 404)
        expect(calls('getPost').length).toBe(fits(s) ? 1 : 0)
      }),
    )
  })
})

describe('GET /librarius/posts/:id/messages: the cursor', () => {
  const FIRST = '200000000000001000'
  const asked = async (query) => {
    const made = setup()
    const res = await made.get(messagesPath(query))
    return { res, calls: made.calls('listMessages'), made }
  }

  it('asks for the newest 50 with no cursor and no limit', async () => {
    const { res, calls } = await asked('')
    expect(res.status).toBe(200)
    expect(calls).toStrictEqual([[POST, { limit: 50 }]])
  })

  it.each(['before', 'after', 'around'])('passes a %s cursor on, with the default limit', async (name) => {
    const { res, calls } = await asked(`?${name}=${FIRST}`)
    expect(res.status).toBe(200)
    expect(calls).toStrictEqual([[POST, { [name]: FIRST, limit: 50 }]])
  })

  it.each([
    ['1', 1],
    ['9', 9],
    ['10', 10],
    ['25', 25],
    ['50', 50],
    ['99', 99],
    ['100', 100],
  ])('takes a limit of %s', async (text, limit) => {
    const { res, calls } = await asked(`?limit=${text}`)
    expect(res.status).toBe(200)
    expect(calls).toStrictEqual([[POST, { limit }]])
    const again = await asked(`?around=${FIRST}&limit=${text}`)
    expect(again.calls).toStrictEqual([[POST, { around: FIRST, limit }]])
  })

  it('takes the ends of the cursor range: 17 digits up to the largest bigint', async () => {
    for (const cursor of ['10000000000000000', '9223372036854775807']) {
      const { res, calls } = await asked(`?before=${cursor}`)
      expect(res.status).toBe(200)
      expect(calls[0][1].before).toBe(cursor)
    }
  })

  it.each([
    ['before and after', `?before=${FIRST}&after=${FIRST}`],
    ['before and around', `?before=${FIRST}&around=${FIRST}`],
    ['after and around', `?after=${FIRST}&around=${FIRST}`],
    ['all three', `?before=${FIRST}&after=${FIRST}&around=${FIRST}`],
    ['two before', `?before=${FIRST}&before=${FIRST}`],
    ['two before, one bad', `?before=${FIRST}&before=abc`],
    ['an empty one beside a good one', `?before=${FIRST}&after=`],
    ['a bad one beside a good one', `?before=${FIRST}&around=abc`],
    ['an empty before', '?before='],
    ['an empty after', '?after='],
    ['an empty around', '?around='],
    ['a word', '?before=abc'],
    ['16 digits', '?before=1234567890123456'],
    ['21 digits', '?before=123456789012345678901'],
    ['20 digits above the largest bigint', '?before=99999999999999999999'],
    ['one above the largest bigint', '?around=9223372036854775808'],
    ['a minus', '?after=-200000000000001000'],
    ['a plus', '?after=%2B200000000000001000'],
    ['a point', '?after=200000000000001000.0'],
    ['a leading space', '?before=%20200000000000001000'],
    ['a trailing space', '?before=200000000000001000%20'],
    ['a trailing newline', '?before=200000000000001000%0A'],
    ['hex', '?before=0x2000000000000010'],
    ['full-width digits', '?before=%EF%BC%92%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90'],
    ['a limit of 0', '?limit=0'],
    ['a limit of 101', '?limit=101'],
    ['a limit of 1000', '?limit=1000'],
    ['a limit of -1', '?limit=-1'],
    ['a limit of +5', '?limit=%2B5'],
    ['a limit of 1.5', '?limit=1.5'],
    ['a limit of 1e1', '?limit=1e1'],
    ['a limit of 05', '?limit=05'],
    ['a limit of 00', '?limit=00'],
    ['a limit of 0100', '?limit=0100'],
    ['a limit of 50 and a space', '?limit=50%20'],
    ['a limit with a leading space', '?limit=%2050'],
    ['a limit with a newline', '?limit=50%0A'],
    ['a limit that is a word', '?limit=abc'],
    ['an empty limit', '?limit='],
    ['two limits', '?limit=10&limit=20'],
    ['two limits, the same', '?limit=10&limit=10'],
    ['a bad limit beside a good cursor', `?around=${FIRST}&limit=0`],
    ['a good limit beside a bad cursor', '?around=abc&limit=10'],
    ['a limit that is Arabic-Indic digits', '?limit=%D9%A5'],
  ])('answers 400 for %s, asking the store nothing', async (_, query) => {
    const { res, made } = await asked(query)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual(BAD_CURSOR)
    expect(made.log).toEqual([])
  })

  it('ignores a parameter it does not know', async () => {
    const { res, calls } = await asked(`?foo=bar&before=${FIRST}&limit=7&around_=x`)
    expect(res.status).toBe(200)
    expect(calls).toStrictEqual([[POST, { before: FIRST, limit: 7 }]])
  })

  it('answers 404 for a post id that is no id, before it looks at the cursor', async () => {
    const made = setup()
    const res = await made.get('/librarius/posts/abc/messages?before=nope')
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual(NO_SUCH_POST)
    expect(made.log).toEqual([])
  })

  it('accepts a limit from 1 to 100 and refuses any other whole number (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -50, max: 1500 }), async (n) => {
        const { res, calls } = await asked(`?limit=${n}`)
        if (n >= 1 && n <= 100) {
          expect(res.status).toBe(200)
          expect(calls).toStrictEqual([[POST, { limit: n }]])
        } else {
          expect(res.status).toBe(400)
          expect(calls).toEqual([])
        }
      }),
    )
  })
})

describe('GET /librarius/posts/:id/messages: the answer', () => {
  it("answers each message as the site shows it, with the page's edges and the number to poll from", async () => {
    const rows = [
      row(M1, {
        content: 'a line',
        embeds: [{ type: 'link', url: 'https://example.test/' }],
        stickers: [{ id: '200000000000000490', name: 'wave' }],
        reactions: [{ key: 'u:x', name: 'x', count: 2 }],
        createdAt: '2026-11-02T18:30:00.000Z',
        editedAt: '2026-11-02T19:00:00.000Z',
        webhookId: '200000000000000495',
        kind: 19,
        rev: '77',
        attachments: [attachment(ATT, { url: 'https://cdn.example.test/a/1?ex=zz', expiresAt: at(3 * 60 * MINUTE) })],
      }),
      row(M2, { authorId: BOB, authorName: 'Test Bob', authorAvatar: null, content: 'second' }),
    ]
    const { get } = setup({ store: { listMessages: () => ({ rows, hasOlder: true, hasNewer: false }), currentRev: () => '812' } })
    const res = await get(messagesPath())
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({
      messages: [
        view(M1, {
          content: 'a line',
          embeds: [{ type: 'link', url: 'https://example.test/' }],
          stickers: [{ id: '200000000000000490', name: 'wave' }],
          reactions: [{ key: 'u:x', name: 'x', count: 2 }],
          editedAt: '2026-11-02T19:00:00.000Z',
          attachments: [{ id: ATT, filename: 'map.png', contentType: 'image/png', size: 2048, width: 640, height: 480, url: 'https://cdn.example.test/a/1?ex=zz' }],
        }),
        view(M2, { authorId: BOB, authorName: 'Test Bob', authorAvatar: null, content: 'second' }),
      ],
      hasOlder: true,
      hasNewer: false,
      people: {
        [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) },
        [BOB]: { name: 'Test Bob', avatar: null },
      },
      rev: '812',
    })
  })

  it('answers the two edges as the store says them', async () => {
    for (const [hasOlder, hasNewer] of [[false, true], [true, true], [false, false]]) {
      const { get } = setup({ store: { listMessages: () => ({ rows: [row(M1)], hasOlder, hasNewer }) } })
      const out = await body(await get(messagesPath()))
      expect([out.hasOlder, out.hasNewer]).toEqual([hasOlder, hasNewer])
    }
  })

  it('answers an empty page', async () => {
    expect(await body(await setup().get(messagesPath()))).toEqual({ messages: [], hasOlder: false, hasNewer: false, people: {}, rev: '500' })
  })

  it('answers a message with several attachments in the order the store gave them, and with none', async () => {
    const rows = [row(M1, { attachments: [attachment(ATT, { position: 0 }), attachment(ATT_2, { position: 1, filename: 'b.png', width: null, height: null, contentType: null })] }), row(M2)]
    const out = await body(await setup({ store: { listMessages: () => ({ rows, hasOlder: false, hasNewer: false }) } }).get(messagesPath()))
    expect(out.messages[0].attachments.map((a) => [a.id, a.filename, a.width, a.height, a.contentType])).toEqual([
      [ATT, 'map.png', 640, 480, 'image/png'],
      [ATT_2, 'b.png', null, null, null],
    ])
    expect(out.messages[1].attachments).toEqual([])
  })

  it('reads the number to poll from before it reads the messages, and answers that one', async () => {
    let live = 500
    const { get, names } = setup({
      store: {
        currentRev: () => String(live),
        listMessages: () => {
          live = 530 // a write lands while the page is being read
          return { rows: [row(M1)], hasOlder: false, hasNewer: false }
        },
      },
    })
    const out = await body(await get(messagesPath()))
    expect(out.rev).toBe('500')
    expect(names().indexOf('currentRev')).toBeLessThan(names().indexOf('listMessages'))
  })

  it("asks for the number to poll from of this post alone, and answers that post's", async () => {
    const revs = { [POST]: '812', [POST_2]: '3' }
    for (const [id, rev] of Object.entries(revs)) {
      const { get, calls } = setup({ store: { currentRev: (postId) => revs[postId] } })
      expect((await body(await get(`/librarius/posts/${id}/messages`))).rev).toBe(rev)
      expect(calls('currentRev')).toEqual([[id]])
    }
  })

  it('names nobody in a message, but its author and those it mentions', async () => {
    const { get } = setup({
      roster: () => [member(CARA, 'Cara Now'), member(DAN, 'Dan Now')],
      store: { listMessages: () => ({ rows: [row(M1, { content: `hello <@${CARA}> and <@!${CARA}> and <@${BOB}>` })], hasOlder: false, hasNewer: false }) },
    })
    const out = await body(await get(messagesPath()))
    expect(out.people).toEqual({
      [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) },
      [CARA]: { name: 'Cara Now', avatar: avatar(`now-${CARA}`) },
    })
  })

  it.each([
    ['a role', `<@&${CARA}>`],
    ['a channel', `<#${CARA}>`],
    ['a short id', '<@1234567890123456>'],
    ['a long id', '<@123456789012345678901>'],
    ['text for an id', '<@abcdefghijklmnopq>'],
    ['no brackets', `@${CARA}`],
    ['no opening bracket', `<${CARA}>`],
    ['no closing bracket', `<@${CARA}`],
    ['a space', `<@ ${CARA}>`],
    ['two bangs', `<@!!${CARA}>`],
    ['an emoji', `<:name:${CARA}>`],
    ['an animated emoji', `<a:name:${CARA}>`],
  ])('does not take %s for a member mention', async (_, content) => {
    const { get } = setup({ roster: () => [member(CARA, 'Cara Now')], store: { listMessages: () => ({ rows: [row(M1, { content })], hasOlder: false, hasNewer: false }) } })
    expect(Object.keys((await body(await get(messagesPath()))).people)).toEqual([ALICE])
  })

  it('takes a mention of 17 and of 20 digits, and leaves out one the roster does not know', async () => {
    const SHORT = '10000000000000000'
    const LONG = '99999999999999999999'
    const { get } = setup({
      roster: () => [member(SHORT, 'Short Now'), member(LONG, 'Long Now')],
      store: { listMessages: () => ({ rows: [row(M1, { content: `<@${SHORT}><@${LONG}><@200000000000000999>` })], hasOlder: false, hasNewer: false }) },
    })
    const out = await body(await get(messagesPath()))
    expect(Object.keys(out.people).sort()).toEqual([ALICE, SHORT, LONG].sort())
  })

  it('finds mentions in every message of the page, once each', async () => {
    const rows = [row(M1, { content: `<@${CARA}> <@${CARA}>` }), row(M2, { content: `<@${DAN}> then <@${CARA}>` })]
    const { get } = setup({ roster: () => [member(CARA, 'Cara Now'), member(DAN, 'Dan Now')], store: { listMessages: () => ({ rows, hasOlder: false, hasNewer: false }) } })
    const out = await body(await get(messagesPath()))
    expect(Object.keys(out.people).sort()).toEqual([ALICE, CARA, DAN].sort())
  })

  it('shows a member under the name and avatar the roster has now, else those stored with the message', async () => {
    const rows = [
      row(M1),
      row(M2, { authorId: BOB, authorName: 'Test Bob', authorAvatar: avatar(BOB) }),
      row(M3, { authorId: CARA, authorName: 'Test Cara', authorAvatar: avatar(CARA) }),
    ]
    const { get } = setup({
      roster: () => [member(ALICE, 'Alice Now'), member(CARA, 'Cara Now', { avatar: null })],
      store: { listMessages: () => ({ rows, hasOlder: false, hasNewer: false }) },
    })
    const out = await body(await get(messagesPath()))
    expect(out.messages.map((m) => [m.authorName, m.authorAvatar])).toEqual([
      ['Alice Now', avatar(`now-${ALICE}`)],
      ['Test Bob', avatar(BOB)],
      ['Cara Now', null],
    ])
    expect(out.people).toEqual({
      [ALICE]: { name: 'Alice Now', avatar: avatar(`now-${ALICE}`) },
      [BOB]: { name: 'Test Bob', avatar: avatar(BOB) },
      [CARA]: { name: 'Cara Now', avatar: null },
    })
  })

  it('uses the stored name and avatar while the roster has not loaded', async () => {
    const { get } = setup({ roster: () => null, store: { listMessages: () => ({ rows: [row(M1)], hasOlder: false, hasNewer: false }) } })
    const out = await body(await get(messagesPath()))
    expect([out.messages[0].authorName, out.messages[0].authorAvatar]).toEqual(['Test Alice', avatar(ALICE)])
    expect(out.people).toEqual({ [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) } })
  })

  it("names an author by the snapshot of their newest message in the page, while the messages keep their own", async () => {
    const rows = [row(M1, { authorName: 'Alice Then', authorAvatar: null }), row(M3, { authorName: 'Alice Later', authorAvatar: avatar('later') }), row(M2, { authorName: 'Alice Between', authorAvatar: null })]
    const { get } = setup({ store: { listMessages: () => ({ rows, hasOlder: false, hasNewer: false }) } })
    const out = await body(await get(messagesPath()))
    expect(out.messages.map((m) => m.authorName)).toEqual(['Alice Then', 'Alice Later', 'Alice Between'])
    expect(out.people).toEqual({ [ALICE]: { name: 'Alice Later', avatar: avatar('later') } })
  })

  it('is the roster that decides, whoever the member is: every id, every time (property)', async () => {
    const ids = [ALICE, BOB, CARA, DAN]
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(ids),
        fc.array(fc.constantFrom(...ids), { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        async (inRoster, authors, loaded) => {
          const rows = authors.map((authorId, i) => row(String(BigInt(M1) + BigInt(i)), { authorId, authorName: `Stored ${authorId}`, authorAvatar: null }))
          const { get } = setup({
            roster: () => (loaded ? inRoster.map((id) => member(id, `Roster ${id}`)) : null),
            store: { listMessages: () => ({ rows, hasOlder: false, hasNewer: false }) },
          })
          const out = await body(await get(messagesPath()))
          const named = (id) => (loaded && inRoster.includes(id) ? `Roster ${id}` : `Stored ${id}`)
          expect(out.messages.map((m) => m.authorName)).toEqual(authors.map(named))
          expect(Object.fromEntries(Object.entries(out.people).map(([id, p]) => [id, p.name]))).toEqual(Object.fromEntries([...new Set(authors)].map((id) => [id, named(id)])))
        },
      ),
    )
  })
})

describe('the reply line of a message', () => {
  const page = (rows, hasOlder = false) => ({ listMessages: () => ({ rows, hasOlder, hasNewer: false }) })

  it('quotes a message of the same page, without asking the store for it', async () => {
    const rows = [row(M1, { authorId: BOB, authorName: 'Test Bob', content: 'the question' }), row(M2, { replyTo: M1, content: 'the answer' })]
    const { get, calls } = setup({ store: page(rows) })
    const out = await body(await get(messagesPath()))
    expect(out.messages[0].replyTo).toBeNull()
    expect(out.messages[1].replyTo).toEqual({ id: M1, authorId: BOB, authorName: 'Test Bob', content: 'the question' })
    expect(calls('quotedMessages')).toEqual([])
  })

  it('asks the store once for the messages it quotes that are not in the page, each once', async () => {
    const rows = [row(M3, { replyTo: M1 }), row(M4, { replyTo: M2 }), row(M5, { replyTo: M1 }), row(M2, { replyTo: M3 })]
    const stored = [
      { id: M1, authorId: BOB, authorName: 'Test Bob', authorAvatar: avatar(BOB), content: 'first' },
      { id: M2, authorId: CARA, authorName: 'Test Cara', authorAvatar: null, content: 'second' },
    ]
    const { get, calls } = setup({ store: { ...page(rows), quotedMessages: () => stored } })
    const out = await body(await get(messagesPath()))
    // M2 is in the page, so only M1 is asked for.
    expect(calls('quotedMessages')).toEqual([[POST, [M1]]])
    expect(out.messages.map((m) => m.replyTo?.id ?? null)).toEqual([M1, M2, M1, M3])
  })

  it('asks for every missing id once, in the order the page quotes them', async () => {
    const rows = [row(M3, { replyTo: M1 }), row(M4, { replyTo: M2 }), row(M5, { replyTo: M1 })]
    const { get, calls } = setup({ store: { ...page(rows), quotedMessages: () => [] } })
    await get(messagesPath())
    expect(calls('quotedMessages')).toEqual([[POST, [M1, M2]]])
  })

  it('answers a reply to a message that is not stored with no reply line', async () => {
    const rows = [row(M3, { replyTo: M1 }), row(M4, { replyTo: M2 })]
    const { get } = setup({ store: { ...page(rows), quotedMessages: () => [{ id: M2, authorId: BOB, authorName: 'Test Bob', authorAvatar: null, content: 'kept' }] } })
    const out = await body(await get(messagesPath()))
    expect(out.messages[0].replyTo).toBeNull()
    expect(out.messages[1].replyTo).toEqual({ id: M2, authorId: BOB, authorName: 'Test Bob', content: 'kept' })
  })

  it('asks the store about nothing when no message is a reply', async () => {
    const { get, calls } = setup({ store: page([row(M1), row(M2)]) })
    await get(messagesPath())
    expect(calls('quotedMessages')).toEqual([])
  })

  it("names the quoted message's author from the roster when it has them, else by the quoted message's own snapshot, and lists them among the people", async () => {
    const rows = [row(M3, { replyTo: M1 }), row(M4, { replyTo: M2 })]
    const stored = [
      { id: M1, authorId: BOB, authorName: 'Bob Then', authorAvatar: avatar(BOB), content: 'one' },
      { id: M2, authorId: CARA, authorName: 'Cara Then', authorAvatar: null, content: 'two' },
    ]
    const { get } = setup({ roster: () => [member(BOB, 'Bob Now')], store: { ...page(rows), quotedMessages: () => stored } })
    const out = await body(await get(messagesPath()))
    expect(out.messages.map((m) => m.replyTo.authorName)).toEqual(['Bob Now', 'Cara Then'])
    expect(out.people).toEqual({
      [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) },
      [BOB]: { name: 'Bob Now', avatar: avatar(`now-${BOB}`) },
      [CARA]: { name: 'Cara Then', avatar: null },
    })
  })

  it('names whoever a quoted message mentions, as far as the quote shows it', async () => {
    const mention = (id) => `<@${id}>`
    const roster = () => [member(CARA, 'Cara Now'), member(DAN, 'Dan Now'), member(BOB, 'Bob Now')]
    const stored = (content) => [{ id: M1, authorId: BOB, authorName: 'Test Bob', authorAvatar: null, content }]
    const run = async (content) => body(await setup({ roster, store: { ...page([row(M3, { replyTo: M1, content: 'plain' })]), quotedMessages: () => stored(content) } }).get(messagesPath()))

    // Shown in the quote: named.
    expect(Object.keys((await run(`hi ${mention(CARA)} and <@!${DAN}>`)).people).sort()).toEqual([ALICE, BOB, CARA, DAN].sort())
    // Cut off by the 200 characters of the quote, whole or in part: not shown, so not named.
    const upTo = (n) => 'x'.repeat(n)
    expect(Object.keys((await run(`${upTo(200)}${mention(CARA)}`)).people).sort()).toEqual([ALICE, BOB].sort())
    expect(Object.keys((await run(`${upTo(190)}${mention(CARA)}`)).people).sort()).toEqual([ALICE, BOB].sort())
    // The last one that fits, 200 characters to its closing bracket: named.
    const fits = `${upTo(200 - mention(CARA).length)}${mention(CARA)}`
    expect(Array.from(fits)).toHaveLength(200)
    expect(Object.keys((await run(fits)).people).sort()).toEqual([ALICE, BOB, CARA].sort())
  })

  it('names whoever a quoted message of the page mentions, as far as the quote shows it', async () => {
    // The page's own message M1 mentions Cara past its 200th character, so the quote does not show it, but M1 itself does.
    const rows = [row(M1, { content: `${'x'.repeat(205)}<@${CARA}>` }), row(M2, { replyTo: M1 })]
    const out = await body(await setup({ roster: () => [member(CARA, 'Cara Now')], store: page(rows) }).get(messagesPath()))
    expect(out.messages[1].replyTo.content).toBe('x'.repeat(200))
    expect(Object.keys(out.people).sort()).toEqual([ALICE, CARA].sort())
  })

  it('does not list the author of a message that is quoted by nobody on the page', async () => {
    const stored = [
      { id: M1, authorId: BOB, authorName: 'Test Bob', authorAvatar: null, content: 'one' },
      { id: M2, authorId: CARA, authorName: 'Test Cara', authorAvatar: null, content: 'two' },
    ]
    const { get } = setup({ store: { ...page([row(M3, { replyTo: M1 })]), quotedMessages: () => stored } })
    expect(Object.keys((await body(await get(messagesPath()))).people).sort()).toEqual([ALICE, BOB].sort())
  })

  it('cuts the quote at 200 characters, whether the message was in the page or stored', async () => {
    const long = 'x'.repeat(250)
    const exact = 'y'.repeat(200)
    const rows = [row(M1, { content: long }), row(M2, { content: exact }), row(M3, { replyTo: M1 }), row(M4, { replyTo: M2 }), row(M5, { replyTo: '200000000000000499' })]
    const { get } = setup({ store: { ...page(rows), quotedMessages: () => [{ id: '200000000000000499', authorId: BOB, authorName: 'Test Bob', authorAvatar: null, content: long }] } })
    const out = await body(await get(messagesPath()))
    expect(out.messages[2].replyTo.content).toBe('x'.repeat(200))
    expect(out.messages[3].replyTo.content).toBe(exact)
    expect(out.messages[4].replyTo.content).toBe('x'.repeat(200))
    // The message itself is not cut.
    expect(out.messages[0].content).toBe(long)
  })

  it('keeps 199 characters whole, and cuts one past 200', async () => {
    for (const [length, expected] of [[0, 0], [1, 1], [199, 199], [200, 200], [201, 200], [202, 200]]) {
      const rows = [row(M1, { content: 'z'.repeat(length) }), row(M2, { replyTo: M1 })]
      const out = await body(await setup({ store: page(rows) }).get(messagesPath()))
      expect(out.messages[1].replyTo.content).toBe('z'.repeat(expected))
    }
  })

  it('counts characters, not UTF-16 units, and never splits a pair', async () => {
    const rows = [row(M1, { content: `${'a'.repeat(199)}\u{1F600}\u{1F600}` }), row(M2, { replyTo: M1 })]
    const out = await body(await setup({ store: page(rows) }).get(messagesPath()))
    expect(out.messages[1].replyTo.content).toBe(`${'a'.repeat(199)}\u{1F600}`)
  })

  it('cuts any text to a prefix of at most 200 characters, and keeps a short one whole (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 450 }), async (content) => {
        const rows = [row(M1, { content }), row(M2, { replyTo: M1 })]
        const out = await body(await setup({ store: page(rows) }).get(messagesPath()))
        const quoted = out.messages[1].replyTo.content
        const length = Array.from(content).length
        expect(Array.from(quoted).length).toBe(Math.min(length, 200))
        expect(content.startsWith(quoted)).toBe(true)
      }),
    )
  })
})

describe('the links of the attachments', () => {
  const page = (rows) => ({ listMessages: () => ({ rows, hasOlder: false, hasNewer: false }) })
  const fresh = (id) => ({ url: `https://cdn.example.test/attachments/${id}/map.png?ex=fresh`, expiresAt: at(24 * 60 * MINUTE) })
  const refreshAll = (list) => new Map(list.map(({ id }) => [id, fresh(id)]))
  const urls = (out) => out.messages.flatMap((m) => m.attachments.map((a) => a.url))

  it.each([
    ['one that lapsed an hour ago', -60 * MINUTE, true],
    ['one that lapsed a millisecond ago', -1, true],
    ['one that lapses now', 0, true],
    ['one that lapses in a minute', MINUTE, true],
    ['one that lapses in 5 minutes less a millisecond', 5 * MINUTE - 1, true],
    ['one that lapses in exactly 5 minutes', 5 * MINUTE, true],
    ['one that lapses in 5 minutes and a millisecond', 5 * MINUTE + 1, false],
    ['one that lapses in an hour', 60 * MINUTE, false],
    ['one with no expiry', null, false],
  ])('asks for a new link for %s: %s', async (_, offset, due) => {
    const expiresAt = offset === null ? null : at(offset)
    const rows = [row(M1, { attachments: [attachment(ATT, { expiresAt })] })]
    const { get, refreshed, calls } = setup({ store: page(rows), refresh: refreshAll })
    const out = await body(await get(messagesPath()))
    if (due) {
      expect(refreshed).toEqual([[{ id: ATT, url: `https://cdn.example.test/attachments/${ATT}/map.png?ex=old` }]])
      expect(urls(out)).toEqual([fresh(ATT).url])
      expect(calls('updateAttachmentUrls')).toEqual([[[{ id: ATT, url: fresh(ATT).url, expiresAt: fresh(ATT).expiresAt }]]])
    } else {
      expect(refreshed).toEqual([])
      expect(urls(out)).toEqual([`https://cdn.example.test/attachments/${ATT}/map.png?ex=old`])
      expect(calls('updateAttachmentUrls')).toEqual([])
    }
  })

  it('leaves an expiry it cannot read alone', async () => {
    const rows = [row(M1, { attachments: [attachment(ATT, { expiresAt: 'not a time' })] })]
    const { get, refreshed } = setup({ store: page(rows), refresh: refreshAll })
    await get(messagesPath())
    expect(refreshed).toEqual([])
  })

  it('asks for all the due links in one call, in the order they are shown, sending only the id and link of each', async () => {
    const rows = [
      row(M1, { attachments: [attachment(ATT, { expiresAt: at(0) }), attachment(ATT_2, { expiresAt: at(60 * MINUTE), position: 1 })] }),
      row(M2),
      row(M3, { attachments: [attachment(ATT_3, { expiresAt: at(MINUTE) })] }),
    ]
    const { get, refreshed } = setup({ store: page(rows), refresh: refreshAll })
    const out = await body(await get(messagesPath()))
    expect(refreshed).toEqual([
      [
        { id: ATT, url: `https://cdn.example.test/attachments/${ATT}/map.png?ex=old` },
        { id: ATT_3, url: `https://cdn.example.test/attachments/${ATT_3}/map.png?ex=old` },
      ],
    ])
    expect(urls(out)).toEqual([fresh(ATT).url, `https://cdn.example.test/attachments/${ATT_2}/map.png?ex=old`, fresh(ATT_3).url])
  })

  it('asks for no more than the first 50, and shows the rest as they are stored', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => {
      const id = String(BigInt('200000000000002000') + BigInt(i))
      return row(String(BigInt('200000000000003000') + BigInt(i)), { attachments: [attachment(id, { expiresAt: at(-MINUTE) })] })
    })
    const { get, refreshed, calls } = setup({ store: page(rows), refresh: refreshAll })
    const out = await body(await get(messagesPath()))
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).toHaveLength(50)
    expect(refreshed[0].map((a) => a.id)).toEqual(rows.slice(0, 50).map((r) => r.attachments[0].id))
    expect(calls('updateAttachmentUrls')[0][0]).toHaveLength(50)
    const shown = urls(out)
    expect(shown.slice(0, 50).every((u) => u.endsWith('?ex=fresh'))).toBe(true)
    expect(shown.slice(50).every((u) => u.endsWith('?ex=old'))).toBe(true)
  })

  it('asks for exactly 50 when 50 are due', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row(String(BigInt('200000000000003000') + BigInt(i)), { attachments: [attachment(String(BigInt('200000000000002000') + BigInt(i)), { expiresAt: at(0) })] }),
    )
    const { get, refreshed } = setup({ store: page(rows), refresh: refreshAll })
    await get(messagesPath())
    expect(refreshed[0]).toHaveLength(50)
  })

  it('keeps the stored link when no new one comes, and stores nothing', async () => {
    const rows = [row(M1, { attachments: [attachment(ATT, { expiresAt: at(0) })] })]
    const { get, refreshed, calls } = setup({ store: page(rows), refresh: () => new Map() })
    const res = await get(messagesPath())
    expect(res.status).toBe(200)
    expect(refreshed).toHaveLength(1)
    expect(urls(await body(res))).toEqual([`https://cdn.example.test/attachments/${ATT}/map.png?ex=old`])
    expect(calls('updateAttachmentUrls')).toEqual([])
  })

  it('uses the links that came, keeps the others, and stores only those that came', async () => {
    const rows = [row(M1, { attachments: [attachment(ATT, { expiresAt: at(0) }), attachment(ATT_2, { expiresAt: at(0), position: 1 })] })]
    const only = (list) => new Map(list.filter(({ id }) => id === ATT_2).map(({ id }) => [id, { url: 'https://cdn.example.test/new', expiresAt: null }]))
    const { get, calls } = setup({ store: page(rows), refresh: only })
    const out = await body(await get(messagesPath()))
    expect(urls(out)).toEqual([`https://cdn.example.test/attachments/${ATT}/map.png?ex=old`, 'https://cdn.example.test/new'])
    expect(calls('updateAttachmentUrls')).toEqual([[[{ id: ATT_2, url: 'https://cdn.example.test/new', expiresAt: null }]]])
  })

  it('stores the new links before it answers, so the next read need not refresh them again', async () => {
    const rows = [row(M1, { attachments: [attachment(ATT, { expiresAt: at(0) })] })]
    const { get, names } = setup({ store: page(rows), refresh: refreshAll })
    await get(messagesPath())
    expect(names().filter((n) => n === 'updateAttachmentUrls')).toHaveLength(1)
  })

  it('does not hide a failure to store the new links', async () => {
    const rows = [row(M1, { attachments: [attachment(ATT, { expiresAt: at(0) })] })]
    const { get } = setup({
      store: {
        ...page(rows),
        updateAttachmentUrls: () => {
          throw new Error('write failed')
        },
      },
      refresh: refreshAll,
    })
    await expect(get(messagesPath())).rejects.toThrow('write failed')
  })

  it('does not hide a failure of the refresh that is not Discord being unreachable', async () => {
    const rows = [row(M1, { attachments: [attachment(ATT, { expiresAt: at(0) })] })]
    const { get } = setup({
      store: page(rows),
      refresh: () => {
        throw new TypeError('each attachment must have an id and a url, as text.')
      },
    })
    await expect(get(messagesPath())).rejects.toThrow('each attachment must have an id')
  })

  it('does not ask about the links of a message that is only quoted', async () => {
    const rows = [row(M3, { replyTo: M1 })]
    const stored = [{ id: M1, authorId: BOB, authorName: 'Test Bob', authorAvatar: null, content: 'x', attachments: [attachment(ATT, { expiresAt: at(0) })] }]
    const { get, refreshed } = setup({ store: { ...page(rows), quotedMessages: () => stored }, refresh: refreshAll })
    const out = await body(await get(messagesPath()))
    expect(refreshed).toEqual([])
    expect(out.messages[0].replyTo).not.toHaveProperty('attachments')
  })
})

describe('GET /librarius/posts/:id/changes', () => {
  /**
   * A store whose `changes` answers as the real one does: what is held after the number asked from (the oldest `limit`),
   * and before it the `slack` newest at or below it that are sent again, oldest first, and `full` when what is new fills
   * the limit.
   */
  const holding = (rows, deleted = [], extra = {}) => ({
    changes: (_post, since, { limit, slack }) => {
      const after = BigInt(since)
      const byRev = (a, b) => (BigInt(a.rev) < BigInt(b.rev) ? -1 : BigInt(a.rev) > BigInt(b.rev) ? 1 : 0)
      const split = (list) => ({
        fresh: list.filter((r) => BigInt(r.rev) > after).sort(byRev).slice(0, limit),
        back: list.filter((r) => BigInt(r.rev) <= after && BigInt(r.rev) > after - BigInt(slack)).sort((a, b) => byRev(b, a)).slice(0, slack).reverse(),
      })
      const messages = split(rows)
      const gone = split(deleted)
      return {
        rows: [...messages.back, ...messages.fresh],
        deleted: [...gone.back, ...gone.fresh].map((d) => d.id),
        rev: 'unused',
        full: messages.fresh.length >= limit || gone.fresh.length >= limit,
      }
    },
    ...extra,
  })

  it('answers the messages that changed, the ids of those deleted, the number to poll from and the people', async () => {
    const rows = [row(M1, { rev: '300', content: 'edited', editedAt: '2026-11-03T10:00:00.000Z' }), row(M2, { rev: '310', authorId: BOB, authorName: 'Test Bob', authorAvatar: null })]
    const { get, calls } = setup({ store: holding(rows, [{ id: M3, rev: '305' }], { currentRev: () => '310' }) })
    const res = await get(changesPath('?since=299'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({
      messages: [view(M1, { content: 'edited', editedAt: '2026-11-03T10:00:00.000Z' }), view(M2, { authorId: BOB, authorName: 'Test Bob', authorAvatar: null })],
      deleted: [M3],
      rev: '310',
      people: { [ALICE]: { name: 'Test Alice', avatar: avatar(ALICE) }, [BOB]: { name: 'Test Bob', avatar: null } },
    })
    expect(calls('changes')).toHaveLength(1)
  })

  it('answers nothing changed', async () => {
    expect(await body(await setup({ store: { currentRev: () => '42' } }).get(changesPath('?since=42')))).toEqual({ messages: [], deleted: [], rev: '42', people: {} })
  })

  it('answers the number it read before it looked, not the one the store reports', async () => {
    let live = 500
    const { get, names } = setup({
      store: {
        currentRev: () => String(live),
        changes: () => {
          live = 560
          return { rows: [], deleted: [], rev: '999', full: false }
        },
      },
    })
    expect((await body(await get(changesPath('?since=400')))).rev).toBe('500')
    expect(names().indexOf('currentRev')).toBeLessThan(names().indexOf('changes'))
  })

  it("asks for the number to poll from of this post alone, and answers that post's", async () => {
    const revs = { [POST]: '812', [POST_2]: '3' }
    for (const [id, rev] of Object.entries(revs)) {
      const { get, calls } = setup({ store: { currentRev: (postId) => revs[postId] } })
      expect((await body(await get(`/librarius/posts/${id}/changes?since=0`))).rev).toBe(rev)
      expect(calls('currentRev')).toEqual([[id]])
    }
  })

  it('asks the store for what is new after the number it was given, 200 at a time, with the 100 before it sent again', async () => {
    for (const [since, asked] of [['250', '250'], ['101', '101'], ['0', '0'], ['007', '7'], ['00250', '250'], ['9223372036854775807', '9223372036854775807'], ['1000', '1000']]) {
      const { get, calls } = setup()
      expect((await get(changesPath(`?since=${since}`))).status).toBe(200)
      expect(calls('changes')).toEqual([[POST, asked, { limit: 200, slack: 100 }]])
    }
  })

  it('asks the store from the number it was given, whatever it is (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 0n, max: BIGINT_MAX }), async (since) => {
        const { get, calls } = setup()
        await get(changesPath(`?since=${since}`))
        expect(calls('changes')).toEqual([[POST, String(since), { limit: 200, slack: 100 }]])
      }),
    )
  })

  it('still sends a write that took a lower number than the reader had seen but committed after it read', async () => {
    // The reader holds 250. A write stamped 200 commits late, and one stamped 260 after it.
    const rows = [row(M1, { rev: '140' }), row(M2, { rev: '200' }), row(M3, { rev: '260' })]
    const { get } = setup({ store: holding(rows, [{ id: M4, rev: '180' }, { id: M5, rev: '120' }]) })
    const out = await body(await get(changesPath('?since=250')))
    expect(out.messages.map((m) => m.id)).toEqual([M2, M3])
    expect(out.deleted).toEqual([M4])
  })

  it.each([
    ['no since', ''],
    ['an empty since', '?since='],
    ['a word', '?since=abc'],
    ['a minus', '?since=-1'],
    ['a plus', '?since=%2B1'],
    ['a point', '?since=1.5'],
    ['an exponent', '?since=1e3'],
    ['hex', '?since=0x10'],
    ['a leading space', '?since=%201'],
    ['a trailing space', '?since=1%20'],
    ['a trailing newline', '?since=1%0A'],
    ['full-width digits', '?since=%EF%BC%91'],
    ['one above the largest bigint', '?since=9223372036854775808'],
    ['19 nines', '?since=9999999999999999999'],
    ['20 digits', '?since=10000000000000000000'],
    ['30 digits', '?since=100000000000000000000000000000'],
    ['two sinces', '?since=1&since=2'],
    ['two sinces, the same', '?since=1&since=1'],
    ['a bad one beside a good one', '?since=1&since=x'],
    ['the wrong name', '?after=1'],
    ['the wrong case', '?Since=1'],
  ])('answers 400 for %s, asking the store nothing', async (_, query) => {
    const { get, log } = setup()
    const res = await get(changesPath(query))
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual(BAD_CURSOR)
    expect(log).toEqual([])
  })

  // A post deleted in Discord is gone from the store, and an open page learns it from its next poll.
  it('answers 404 for a post that is no longer stored, and reads no changes of it', async () => {
    const { get, calls } = setup({ store: { getPost: () => null } })
    const res = await get(changesPath('?since=42'))
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual(NO_SUCH_POST)
    expect(calls('changes')).toEqual([])
    expect(calls('markViewed')).toEqual([])
  })

  it('asks whether the post is stored for the post of the route and the member who polls', async () => {
    const { get, calls } = setup({ store: { currentRev: () => '42' } })
    expect((await get(changesPath('?since=42'))).status).toBe(200)
    expect(calls('getPost')).toEqual([[POST, READER.id]])
    const other = setup({ store: { currentRev: () => '42' } })
    expect((await other.get(`/librarius/posts/${POST_2}/changes?since=42`)).status).toBe(200)
    expect(other.calls('getPost')).toEqual([[POST_2, READER.id]])
  })

  it('answers the changes while the post is stored, then 404 once it is not', async () => {
    let stored = true
    const { get } = setup({ store: { getPost: () => (stored ? foundPost() : null), currentRev: () => '42' } })
    expect((await get(changesPath('?since=42'))).status).toBe(200)
    stored = false
    const res = await get(changesPath('?since=42'))
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual(NO_SUCH_POST)
  })

  it('answers 400 for a bad since before it asks whether the post is stored', async () => {
    const { get, log } = setup({ store: { getPost: () => null } })
    const res = await get(changesPath('?since=nope'))
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual(BAD_CURSOR)
    expect(log).toEqual([])
  })

  it('answers 503 and nothing else when Discord being down is why the store cannot say', async () => {
    const { get } = setup({ store: { getPost: () => Promise.reject(new Upstream('Discord is unreachable.')) } })
    const res = await get(changesPath('?since=42'))
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual(UNREACHABLE)
  })

  it('answers 404 for a post id that is no id, before it looks at since', async () => {
    const { get, log } = setup()
    const res = await get('/librarius/posts/abc/changes?since=nope')
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual(NO_SUCH_POST)
    expect(log).toEqual([])
  })

  it('answers a reset, and nothing else, when the answer is as long as the store may give', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(String(BigInt('200000000000003000') + BigInt(i)), { rev: String(300 + i) }))
    const { get, refreshed } = setup({ store: holding(rows), refresh: refreshAll() })
    const res = await get(changesPath('?since=200'))
    expect(res.status).toBe(200)
    expect(await body(res)).toStrictEqual({ reset: true })
    expect(refreshed).toEqual([])
  })

  it('answers a reset for 200 deleted ids as for 200 messages', async () => {
    const gone = Array.from({ length: 200 }, (_, i) => ({ id: String(BigInt('200000000000004000') + BigInt(i)), rev: String(300 + i) }))
    expect(await body(await setup({ store: holding([], gone) }).get(changesPath('?since=200')))).toStrictEqual({ reset: true })
  })

  it('answers a reset when the store says the new changes may be more than it gave, and only then: it counts nothing itself', async () => {
    const some = { changes: () => ({ rows: [row(M1)], deleted: [M2], rev: '1', full: true }) }
    expect(await body(await setup({ store: some }).get(changesPath('?since=200')))).toStrictEqual({ reset: true })
    const lots = { changes: () => ({ rows: Array.from({ length: 350 }, (_, i) => row(String(BigInt('200000000000003000') + BigInt(i)))), deleted: Array.from({ length: 350 }, (_, i) => String(BigInt('200000000000004000') + BigInt(i))), rev: '1', full: false }) }
    const out = await body(await setup({ store: lots }).get(changesPath('?since=200')))
    expect(out.reset).toBeUndefined()
    expect(out.messages).toHaveLength(350)
    expect(out.deleted).toHaveLength(350)
  })

  it('does not reset for rows it sends again, however many: 300 at or below the number asked from answer 100, and no reset', async () => {
    // Five to a number, so that the newest 100 are the last twenty numbers, with no tie across the cut.
    const rows = Array.from({ length: 300 }, (_, i) => row(String(BigInt('200000000000003000') + BigInt(i)), { rev: String(941 + Math.floor(i / 5)) }))
    const gone = Array.from({ length: 300 }, (_, i) => ({ id: String(BigInt('200000000000004000') + BigInt(i)), rev: String(941 + Math.floor(i / 5)) }))
    const { get } = setup({ store: holding(rows, gone, { currentRev: () => '1000' }) })
    const res = await get(changesPath('?since=1000'))
    expect(res.status).toBe(200)
    const out = await body(res)
    expect(out.reset).toBeUndefined()
    // The order inside one number is the store's to choose, and the reader replaces by id: compare as sets.
    expect(out.messages.map((m) => m.id).sort()).toEqual(rows.slice(200).map((r) => r.id))
    expect(out.deleted.sort()).toEqual(gone.slice(200).map((g) => g.id))
    expect(out.rev).toBe('1000')
  })

  it('still resets for 200 new rows, whatever it sends again beside them', async () => {
    const back = Array.from({ length: 150 }, (_, i) => row(String(BigInt('200000000000003000') + BigInt(i)), { rev: String(900 + (i % 100)) }))
    const fresh = Array.from({ length: 200 }, (_, i) => row(String(BigInt('200000000000005000') + BigInt(i)), { rev: String(1001 + i) }))
    expect(await body(await setup({ store: holding([...back, ...fresh]) }).get(changesPath('?since=1000')))).toStrictEqual({ reset: true })
    expect((await body(await setup({ store: holding([...back, ...fresh.slice(1)]) }).get(changesPath('?since=1000')))).reset).toBeUndefined()
  })

  it('never resets a reader who polls with the number it was given when nothing is written, however the post was written (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 1500 }), { maxLength: 700 }),
        fc.array(fc.integer({ min: 1, max: 1500 }), { maxLength: 400 }),
        async (messageRevs, deleteRevs) => {
          const rows = messageRevs.map((rev, i) => row(String(BigInt('200000000000010000') + BigInt(i)), { rev: String(rev) }))
          const gone = deleteRevs.map((rev, i) => ({ id: String(BigInt('200000000000020000') + BigInt(i)), rev: String(rev) }))
          const top = String(Math.max(0, ...messageRevs, ...deleteRevs))
          const { get } = setup({ store: holding(rows, gone, { currentRev: () => top }) })
          // The reader opens the post, and is told the number to poll from.
          let rev = (await body(await get(messagesPath()))).rev
          expect(rev).toBe(top)
          for (let poll = 0; poll < 3; poll++) {
            const out = await body(await get(changesPath(`?since=${rev}`)))
            expect(out.reset).toBeUndefined()
            expect(out.messages.length).toBeLessThanOrEqual(100)
            rev = out.rev
            expect(rev).toBe(top)
          }
        },
      ),
      { numRuns: 40 },
    )
  })

  it('answers the changes themselves while one list is a message short of the limit', async () => {
    const rows = Array.from({ length: 199 }, (_, i) => row(String(BigInt('200000000000003000') + BigInt(i)), { rev: String(300 + i) }))
    const gone = Array.from({ length: 199 }, (_, i) => ({ id: String(BigInt('200000000000004000') + BigInt(i)), rev: String(300 + i) }))
    const out = await body(await setup({ store: holding(rows, gone) }).get(changesPath('?since=200')))
    expect(out.reset).toBeUndefined()
    expect(out.messages).toHaveLength(199)
    expect(out.deleted).toHaveLength(199)
  })

  it('shows its messages as the messages route does: quotes, links and names', async () => {
    const rows = [row(M3, { rev: '300', replyTo: M1, content: `<@${CARA}>`, attachments: [attachment(ATT, { expiresAt: at(0) })] })]
    const stored = [{ id: M1, authorId: BOB, authorName: 'Test Bob', authorAvatar: null, content: 'quoted' }]
    const { get, refreshed, calls } = setup({
      roster: () => [member(CARA, 'Cara Now')],
      store: { ...holding(rows), quotedMessages: () => stored },
      refresh: refreshAll(),
    })
    const out = await body(await get(changesPath('?since=250')))
    expect(out.messages[0].replyTo).toEqual({ id: M1, authorId: BOB, authorName: 'Test Bob', content: 'quoted' })
    expect(out.messages[0].attachments[0].url).toBe('https://cdn.example.test/fresh')
    expect(refreshed).toHaveLength(1)
    expect(calls('quotedMessages')).toEqual([[POST, [M1]]])
    expect(Object.keys(out.people).sort()).toEqual([ALICE, BOB, CARA].sort())
  })

  function refreshAll() {
    return (list) => new Map(list.map(({ id }) => [id, { url: 'https://cdn.example.test/fresh', expiresAt: null }]))
  }
})

describe('PUT /librarius/posts/:id/read', () => {
  const path = `/librarius/posts/${POST}/read`
  const send = (text, headers) => setup().put(path, text, headers)

  it('records how far the member has read, and answers 204 with no body', async () => {
    const { put, calls } = setup()
    const res = await put(path, JSON.stringify({ messageId: M2 }))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toBeNull()
    expect(calls('setRead')).toEqual([[READER.id, POST, M2]])
  })

  it('takes a media type with parameters and any case, and ignores other fields', async () => {
    for (const type of ['application/json; charset=utf-8', 'Application/JSON']) {
      const { put, calls } = setup()
      const res = await put(path, JSON.stringify({ extra: 1, messageId: M2, more: [] }), { 'Content-Type': type })
      expect(res.status).toBe(204)
      expect(calls('setRead')).toEqual([[READER.id, POST, M2]])
    }
  })

  it.each([
    ['no type', undefined],
    ['text/plain', { 'Content-Type': 'text/plain' }],
    ['a form', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['multipart', { 'Content-Type': 'multipart/form-data; boundary=x' }],
    ['json as a suffix', { 'Content-Type': 'application/vnd.api+json' }],
  ])('answers 415 for a body of %s, and leaves it unread', async (_, headers) => {
    const made = setup()
    const request = new Request(`http://api.test${path}`, { method: 'PUT', headers, body: JSON.stringify({ messageId: M2 }) })
    const res = await made.handler(request, new URL(request.url))
    expect(res.status).toBe(415)
    expect(await body(res)).toEqual({ error: 'Send JSON (Content-Type: application/json).' })
    expect(request.bodyUsed).toBe(false)
    expect(made.log).toEqual([])
  })

  it('answers 413 for more than 1 KB, and takes exactly 1 KB', async () => {
    const exactly = (bytes) => {
      const text = JSON.stringify({ messageId: M2, pad: '' })
      return JSON.stringify({ messageId: M2, pad: 'p'.repeat(bytes - text.length) })
    }
    const ok = exactly(1024)
    expect(new TextEncoder().encode(ok).length).toBe(1024)
    const accepted = setup()
    expect((await accepted.put(path, ok)).status).toBe(204)
    expect(accepted.calls('setRead')).toEqual([[READER.id, POST, M2]])

    const big = exactly(1025)
    expect(new TextEncoder().encode(big).length).toBe(1025)
    const refused = setup()
    const res = await refused.put(path, big)
    expect(res.status).toBe(413)
    expect(await body(res)).toEqual({ error: 'The request is too large (1 KB at most).' })
    expect(refused.log).toEqual([])
  })

  /** A PUT whose body is `chunks` of `size` bytes each, pulled one at a time; `seen` says how many were pulled, and whether the stream was given up. */
  function streamedPut(chunks, size, headers = {}) {
    const seen = { pulled: 0, cancelled: false }
    const body = new ReadableStream({
      pull(controller) {
        if (seen.pulled === chunks) return controller.close()
        seen.pulled++
        // Spaces: what comes is no matter, only how much of it.
        controller.enqueue(new Uint8Array(size).fill(32))
      },
      cancel() {
        seen.cancelled = true
      },
    }, { highWaterMark: 0 })
    const request = new Request(`http://api.test${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body, duplex: 'half' })
    return { request, seen }
  }

  it('refuses a body of 1 MB with 413 once it has read past 1 KB, and gives up the rest unread', async () => {
    const made = setup()
    const { request, seen } = streamedPut(16, 65_536)
    const res = await made.handler(request, new URL(request.url))
    expect(res.status).toBe(413)
    expect(await body(res)).toEqual({ error: 'The request is too large (1 KB at most).' })
    expect(seen).toStrictEqual({ pulled: 1, cancelled: true })
    expect(made.calls('setRead')).toEqual([])
  })

  it('refuses a body of 1 MB in chunks of 100 bytes after the eleventh, the first past 1 KB', async () => {
    const made = setup()
    const { request, seen } = streamedPut(10_486, 100)
    const res = await made.handler(request, new URL(request.url))
    expect(res.status).toBe(413)
    expect(seen).toStrictEqual({ pulled: 11, cancelled: true })
    expect(made.calls('setRead')).toEqual([])
  })

  it('refuses a body that says it is 1 MB with 413 before reading any of it', async () => {
    const made = setup()
    const { request, seen } = streamedPut(16, 65_536, { 'Content-Length': String(1024 * 1024) })
    const res = await made.handler(request, new URL(request.url))
    expect(res.status).toBe(413)
    expect(await body(res)).toEqual({ error: 'The request is too large (1 KB at most).' })
    expect(seen.pulled).toBe(0)
    expect(made.calls('setRead')).toEqual([])
  })

  it('counts bytes, not characters, against the limit', async () => {
    // 600 two-byte characters are 1200 bytes, in 600 characters.
    const text = JSON.stringify({ messageId: M2, pad: 'é'.repeat(600) })
    expect(text.length).toBeLessThan(1024)
    const res = await send(text)
    expect(res.status).toBe(413)
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['no text', ''],
    ['whitespace', '   '],
    ['null', 'null'],
    ['a list', '[]'],
    ['a list holding the id', JSON.stringify([M2])],
    ['a string', JSON.stringify(M2)],
    ['a number', '5'],
    ['an object with no messageId', '{}'],
    ['the wrong field', JSON.stringify({ message_id: M2 })],
    ['the wrong case', JSON.stringify({ MessageId: M2 })],
    ['a messageId of null', JSON.stringify({ messageId: null })],
    ['a messageId that is a number', JSON.stringify({ messageId: 200000000000000441 })],
    ['a messageId that is a list', JSON.stringify({ messageId: [M2] })],
    ['a messageId that is an object', JSON.stringify({ messageId: { id: M2 } })],
    ['a messageId of true', JSON.stringify({ messageId: true })],
    ['an empty messageId', JSON.stringify({ messageId: '' })],
    ['a word', JSON.stringify({ messageId: 'abc' })],
    ['16 digits', JSON.stringify({ messageId: '1234567890123456' })],
    ['21 digits', JSON.stringify({ messageId: '123456789012345678901' })],
    ['one above the largest bigint', JSON.stringify({ messageId: '9223372036854775808' })],
    ['a minus', JSON.stringify({ messageId: '-200000000000000441' })],
    ['a point', JSON.stringify({ messageId: '200000000000000441.0' })],
    ['a leading space', JSON.stringify({ messageId: ' 200000000000000441' })],
    ['a trailing newline', JSON.stringify({ messageId: '200000000000000441\n' })],
    ['full-width digits', JSON.stringify({ messageId: '２０００００００００００００４４１' })],
  ])('answers 400 for %s, recording nothing', async (_, text) => {
    const made = setup()
    const res = await made.put(path, text)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ error: 'That message id is not valid.' })
    expect(made.calls('setRead')).toEqual([])
  })

  it('does not take a messageId from the prototype chain of what it read', async () => {
    const made = setup()
    const res = await made.put(path, '{"__proto__":{"messageId":"200000000000000441"}}')
    expect(res.status).toBe(400)
    expect(made.calls('setRead')).toEqual([])
  })

  it('answers 404 for a post id that is no id, without reading the body or recording anything', async () => {
    const made = setup()
    const request = new Request('http://api.test/librarius/posts/abc/read', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: M2 }) })
    const res = await made.handler(request, new URL(request.url))
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual(NO_SUCH_POST)
    expect(request.bodyUsed).toBe(false)
    expect(made.log).toEqual([])
  })

  it('takes the ends of the id range for the message', async () => {
    for (const id of ['10000000000000000', '9223372036854775807']) {
      const made = setup()
      expect((await made.put(path, JSON.stringify({ messageId: id }))).status).toBe(204)
      expect(made.calls('setRead')).toEqual([[READER.id, POST, id]])
    }
  })

  it('lets a failure to record the mark through', async () => {
    const made = setup({
      store: {
        setRead: () => {
          throw new Error('write failed')
        },
      },
    })
    await expect(made.put(path, JSON.stringify({ messageId: M2 }))).rejects.toThrow('write failed')
  })
})

// ---- batch 2: the write routes ---------------------------------------------------------------------------------------------

const LIVE = { pausedUntil: null, refused: null }
const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, // signature
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0, // IHDR
  0, 0, 0, 9, 73, 68, 65, 84, 120, 156, 99, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, // IDAT
  0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0, // IEND
])
const upload = (bytes = PNG) => {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'x.png')
  return form
}

// Every write route: [label, method, path, how to send it].
const WRITE_ROUTES = [
  ['a reply', 'POST', `/librarius/posts/${POST}/messages`, (t) => t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'hello' })],
  ['an edit', 'PATCH', `/librarius/messages/${M1}`, (t) => t.send('PATCH', `/librarius/messages/${M1}`, { source: 'hello' })],
  ['a delete', 'DELETE', `/librarius/messages/${M1}`, (t) => t.call('DELETE', `/librarius/messages/${M1}`)],
  ['an upload', 'POST', '/librarius/uploads', (t) => t.call('POST', '/librarius/uploads', { body: upload() })],
]

const siteMessage = (over = {}) => ({
  id: M1,
  postId: POST,
  authorId: READER.id,
  authorName: 'Test Reader',
  authorAvatar: null,
  origin: 'site',
  source: 'Hello **there**',
  layout: { form: 'v2', replyTo: null, siteUrl: `https://sm2salamanders.site/reliquarium/librarius/${POST}`, username: 'Test Reader', avatarUrl: null, images: [] },
  state: null,
  parts: [M1],
  ...over,
})

describe.each(WRITE_ROUTES)('%s (%s %s): the gates', (_, method, path, send) => {
  it('answers 503 when the Librarius is not configured, asking no one', async () => {
    const t = setup({ configured: false, outbox: LIVE })
    const res = await send(t)
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual(NOT_CONFIGURED)
    expect(t.asked).toEqual([])
  })

  it('answers 401 for no identity, and asks for a fresh verdict, not the cached one', async () => {
    const t = setup({ verdict: null, outbox: LIVE })
    const res = await send(t)
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual(SIGN_IN)
    expect(t.asked).toEqual([{ fresh: true }])
    expect(t.log).toEqual([])
  })

  it('answers 403 to someone who cannot read the forum, and touches nothing', async () => {
    const t = setup({ verdict: VERDICTS.outsider, outbox: LIVE })
    const res = await send(t)
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual(RESTRICTED)
    expect(t.log).toEqual([])
    expect(t.kicks.count).toBe(0)
  })

  it('answers 503 while there is no webhook, to a reader, and touches nothing', async () => {
    const t = setup({ verdict: VERDICTS.librarian })
    const res = await send(t)
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual({ error: "Replying from the site isn't switched on yet." })
    expect(t.log).toEqual([])
    expect(t.asked).toEqual([{ fresh: true }])
  })

  it('answers 503 once Discord has refused the webhook, to a reader, and touches nothing', async () => {
    const t = setup({ verdict: VERDICTS.librarian, outbox: { ...LIVE, refused: { status: 401, text: 'refused' } } })
    const res = await send(t)
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual({ error: 'Replying from the site is paused. Try again later.' })
    expect(t.log).toEqual([])
  })

  it('answers 401 before it says anything of the webhook, and 403 too: no one learns of it who may not use it', async () => {
    for (const verdict of [null, VERDICTS.outsider]) {
      const t = setup({ verdict })
      const res = await send(t)
      expect([401, 403]).toContain(res.status)
    }
  })

  it('answers 503 when Discord cannot be reached while the verdict is worked out, and lets another failure through', async () => {
    const down = setup({ verdict: new Upstream('down'), outbox: LIVE })
    const res = await send(down)
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual(UNREACHABLE)
    await expect(send(setup({ verdict: new Error('boom'), outbox: LIVE }))).rejects.toThrow('boom')
  })
})

describe('the write routes: what they reach', () => {
  it('POST /posts/:id/messages queues a reply, tells the outbox, and answers 202', async () => {
    const t = setup({ verdict: VERDICTS.reader, outbox: LIVE, roster: () => [member(READER.id, 'Test Reader')] })
    const res = await t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'hello there' })
    expect(res.status).toBe(202)
    const out = await body(res)
    expect(out.pending.state).toBe('sending')
    const [entry] = t.calls('enqueueOutbox')[0]
    expect(entry).toMatchObject({ kind: 'send', messageKey: out.pending.key, authorId: READER.id })
    expect(entry.payload).toMatchObject({ postId: POST, source: 'hello there', username: 'Test Reader', siteUrl: `https://sm2salamanders.site/reliquarium/librarius/${POST}`, form: 'v2' })
    expect(t.kicks.count).toBe(1)
    expect(t.asked).toEqual([{ fresh: true }])
  })

  it('takes the site, the form and the key from what it was made with', async () => {
    let n = 0
    const t = setup({
      verdict: VERDICTS.reader,
      outbox: LIVE,
      options: { siteUrl: 'https://other.example', form: 'plain', newKey: () => `key-${++n}` },
    })
    const out = await body(await t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'hello' }))
    expect(out.pending.key).toBe('key-1')
    expect(t.calls('enqueueOutbox')[0][0].payload.siteUrl).toBe(`https://other.example/reliquarium/librarius/${POST}`)
    // The queued reply says the form it was checked in, for the outbox to send it in (contract 1).
    expect(t.calls('enqueueOutbox')[0][0].payload.form).toBe('plain')
    const long = await t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'x'.repeat(7000) })
    expect(long.status).toBe(413)
  })

  it('answers 404 for a post id that is no id, and for one the store does not hold', async () => {
    const t = setup({ verdict: VERDICTS.reader, outbox: LIVE })
    for (const id of ['abc', '1', `${POST}x`, '99999999999999999999', '%20']) {
      const res = await t.send('POST', `/librarius/posts/${id}/messages`, { source: 'hello' })
      expect(res.status, id).toBe(404)
      expect(await body(res), id).toEqual(NO_SUCH_POST)
    }
    expect(t.names()).toEqual([])
    const gone = setup({ verdict: VERDICTS.reader, outbox: LIVE, store: { getPost: () => null } })
    expect((await gone.send('POST', `/librarius/posts/${POST}/messages`, { source: 'hello' })).status).toBe(404)
  })

  it('PATCH and DELETE /messages/:id answer 404 for an id that is no id', async () => {
    const t = setup({ verdict: VERDICTS.reader, outbox: LIVE })
    for (const id of ['abc', '1', `${M1}x`, '99999999999999999999']) {
      for (const method of ['PATCH', 'DELETE']) {
        const res = await t.send(method, `/librarius/messages/${id}`, { source: 'x' })
        expect(res.status, `${method} ${id}`).toBe(404)
        expect(await body(res)).toEqual({ error: 'No such message.' })
      }
    }
    expect(t.names()).toEqual([])
  })

  it('PATCH /messages/:id queues an edit of the reader\'s own reply', async () => {
    const t = setup({ verdict: VERDICTS.reader, outbox: LIVE, store: { outboxMessage: () => siteMessage() } })
    const res = await t.send('PATCH', `/librarius/messages/${M1}`, { source: 'edited **now**' })
    expect(res.status).toBe(202)
    expect(await body(res)).toEqual({ pending: { key: M1, state: 'sending' } })
    expect(t.calls('enqueueOutbox')).toEqual([[{ kind: 'edit', messageKey: M1, authorId: READER.id, payload: { postId: POST, source: 'edited **now**', mentions: [] } }]])
    expect(t.kicks.count).toBe(1)
    expect(t.asked).toEqual([{ fresh: true }])
  })

  it('DELETE /messages/:id queues the delete of the reader\'s own message', async () => {
    const t = setup({ verdict: VERDICTS.reader, outbox: LIVE, store: { outboxMessage: () => siteMessage() } })
    const res = await t.call('DELETE', `/librarius/messages/${M1}`)
    expect(res.status).toBe(202)
    expect(await body(res)).toEqual({ pending: { key: M1, state: 'sending' } })
    expect(t.calls('enqueueOutbox')).toEqual([[{ kind: 'delete', messageKey: M1, authorId: READER.id, payload: { postId: POST } }]])
    expect(t.kicks.count).toBe(1)
  })

  it('POST /uploads holds a picture and answers 201 with its id', async () => {
    const t = setup({ verdict: VERDICTS.librarian, outbox: LIVE, store: { addUpload: () => ({ id: '77' }) } })
    const res = await t.call('POST', '/librarius/uploads', { body: upload() })
    expect(res.status).toBe(201)
    expect(await body(res)).toEqual({ id: '77' })
    const [held] = t.calls('addUpload')[0]
    expect(held).toMatchObject({ authorId: READER.id, name: 'picture.png', contentType: 'image/png' })
  })

  it('answers a write for which the AutoMod rules cannot be read with 503, as it answers any outage, and writes nothing', async () => {
    const down = () => {
      throw new Upstream('down')
    }
    const t = setup({ verdict: VERDICTS.reader, outbox: LIVE, rules: down })
    const res = await t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'hello' })
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual(UNREACHABLE)
    expect(t.calls('enqueueOutbox')).toEqual([])
    expect(t.kicks.count).toBe(0)
  })

  it('counts its own limits by its own clock when it is given none, so that they run out and come back by it', async () => {
    const clock = { t: NOW }
    const t = setup({ verdict: VERDICTS.reader, outbox: LIVE, now: () => clock.t })
    for (let i = 0; i < 3; i++) expect((await t.send('POST', `/librarius/posts/${POST}/messages`, { source: `r${i}` })).status).toBe(202)
    clock.t = NOW + 59_999
    expect((await t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'early' })).status).toBe(429)
    clock.t = NOW + 60_000
    expect((await t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'on time' })).status).toBe(202)
  })

  it('uses the limits it was given: a member over them is 429, and /me says so', async () => {
    const t = setup({ verdict: VERDICTS.reader, outbox: LIVE })
    for (let i = 0; i < 3; i++) expect((await t.send('POST', `/librarius/posts/${POST}/messages`, { source: `r${i}` })).status).toBe(202)
    const res = await t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'a fourth' })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect((await body(await t.get('/librarius/me'))).limits.reply.remaining).toBe(0)
  })
})

describe('GET /librarius/posts/:id/pending', () => {
  it('answers the reader\'s own entries for the post, with a cached verdict', async () => {
    const rows = [{ key: 'k1', kind: 'send', state: 'blocked', error: 'Blocked.', source: 'text', createdAt: '2026-11-15T11:00:00.000Z' }]
    const t = setup({ outbox: LIVE, store: { outboxFor: () => rows } })
    const res = await t.get(`/librarius/posts/${POST}/pending`)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ pending: [{ key: 'k1', kind: 'send', state: 'blocked', error: 'Blocked.', source: 'text', createdAt: '2026-11-15T11:00:00.000Z' }] })
    expect(t.asked).toEqual([{ fresh: false }])
    expect(t.calls('outboxFor')).toEqual([[READER.id, POST, new Date(NOW - 86_400_000)]])
  })

  it('works while there is no webhook, and answers 404 for a post id that is no id', async () => {
    const t = setup()
    expect((await t.get(`/librarius/posts/${POST}/pending`)).status).toBe(200)
    expect((await t.get('/librarius/posts/abc/pending')).status).toBe(404)
  })

  it('answers 403 to someone who cannot read the forum', async () => {
    const t = setup({ verdict: VERDICTS.outsider })
    expect((await t.get(`/librarius/posts/${POST}/pending`)).status).toBe(403)
    expect(t.log).toEqual([])
  })
})

describe('GET /librarius/members', () => {
  const people = () => [{ ...member('200000000000000430', 'Alice Test'), roles: [] }, { ...member('200000000000000431', 'Alicia Other'), roles: [] }]

  it('finds the members who may read the forum, with a cached verdict, and works while there is no webhook', async () => {
    const t = setup({
      roster: people,
      facts: () => ({ ...FACTS, overwrites: [] }),
    })
    const res = await t.get('/librarius/members?q=ali')
    expect(res.status).toBe(200)
    expect((await body(res)).members.map((m) => m.name)).toEqual(['Alice Test', 'Alicia Other'])
    expect(t.asked).toEqual([{ fresh: false }])
  })

  it('answers 400 for a q that is not 1 to 32 characters, and 403 to someone who cannot read the forum', async () => {
    const t = setup({ roster: people })
    expect((await t.get('/librarius/members')).status).toBe(400)
    expect((await setup({ verdict: VERDICTS.outsider, roster: people }).get('/librarius/members?q=ali')).status).toBe(403)
  })

  it('answers 503 until the roster has loaded', async () => {
    expect((await setup().get('/librarius/members?q=ali')).status).toBe(503)
  })
})

describe('GET /librarius/me: what the member may do, and what they have left', () => {
  it('says what the verdict says when the webhook is there', async () => {
    const t = setup({ verdict: VERDICTS.librarian, outbox: LIVE })
    const out = await body(await t.get('/librarius/me'))
    expect(out.can).toEqual({ reply: true, attach: true, manageMessages: true, manageThreads: true })
    const reader = await body(await setup({ outbox: LIVE }).get('/librarius/me'))
    expect(reader.can).toEqual({ reply: true, attach: false, manageMessages: false, manageThreads: false })
    const outsider = await body(await setup({ verdict: { ...VERDICTS.reader, reply: false }, outbox: LIVE }).get('/librarius/me'))
    expect(outsider.can.reply).toBe(false)
  })

  it('says a member can do nothing while there is no webhook, or Discord has refused it', async () => {
    for (const outbox of [undefined, { ...LIVE, refused: { status: 404, text: 'gone' } }]) {
      const out = await body(await setup({ verdict: VERDICTS.librarian, outbox }).get('/librarius/me'))
      expect(out.can).toEqual({ reply: false, attach: false, manageMessages: false, manageThreads: false })
    }
  })

  it('says what is left of each limit, for the member who asks', async () => {
    const t = setup({ outbox: LIVE, store: { outboxMessage: () => siteMessage() } })
    await t.send('POST', `/librarius/posts/${POST}/messages`, { source: 'one' })
    await t.send('PATCH', `/librarius/messages/${M1}`, { source: 'two' })
    const out = await body(await t.get('/librarius/me'))
    expect(out.limits).toEqual({
      reply: { limit: 3, windowSeconds: 60, remaining: 2 },
      edit: { limit: 20, windowSeconds: 60, remaining: 19 },
      upload: { limit: 30, windowSeconds: 3600, remaining: 30 },
    })
  })

  it('tells a member who manages messages whether sending is paused and whether the webhook is refused, and no one else', async () => {
    const paused = Date.parse('2026-11-15T13:30:00.000Z')
    const librarian = await body(await setup({ verdict: VERDICTS.librarian, outbox: { pausedUntil: paused, refused: null } }).get('/librarius/me'))
    expect(librarian).toMatchObject({ sendingPausedUntil: '2026-11-15T13:30:00.000Z', sendingFatal: false })
    const calm = await body(await setup({ verdict: VERDICTS.librarian, outbox: LIVE }).get('/librarius/me'))
    expect(calm).toMatchObject({ sendingPausedUntil: null, sendingFatal: false })
    const refused = await body(await setup({ verdict: VERDICTS.librarian, outbox: { pausedUntil: null, refused: { status: 401, text: 'refused' } } }).get('/librarius/me'))
    expect(refused).toMatchObject({ sendingPausedUntil: null, sendingFatal: true })
    const none = await body(await setup({ verdict: VERDICTS.librarian }).get('/librarius/me'))
    expect(none).toMatchObject({ sendingPausedUntil: null, sendingFatal: false })
    const reader = await body(await setup({ outbox: { pausedUntil: paused, refused: { status: 401, text: 'x' } } }).get('/librarius/me'))
    expect(reader).not.toHaveProperty('sendingPausedUntil')
    expect(reader).not.toHaveProperty('sendingFatal')
  })

  it('says nothing of any of it to someone who cannot read the forum', async () => {
    const out = await body(await setup({ verdict: VERDICTS.outsider, outbox: LIVE }).get('/librarius/me'))
    expect(out).toEqual({ access: false })
  })

  it('tells every reader the form replies are checked in, v2 unless it was made with plain, whatever they may do', async () => {
    const forms = [
      [{}, 'v2'],
      [{ form: 'v2' }, 'v2'],
      [{ form: 'plain' }, 'plain'],
    ]
    const verdicts = [VERDICTS.reader, VERDICTS.librarian, { ...VERDICTS.reader, reply: false }]
    for (const [options, form] of forms) {
      for (const [v, verdict] of verdicts.entries()) {
        for (const [o, outbox] of [LIVE, undefined, { ...LIVE, refused: { status: 404, text: 'gone' } }].entries()) {
          const res = await setup({ verdict, outbox, options }).get('/librarius/me')
          expect(res.status).toBe(200)
          expect((await body(res)).form, `${form}, verdict ${v}, outbox ${o}`).toBe(form)
        }
      }
    }
  })

  it('says the very form the reply route checks with: a reply too long for plain is taken in v2 and refused in plain', async () => {
    const long = { source: 'x'.repeat(7000) }
    for (const [options, status] of [[{}, 202], [{ form: 'plain' }, 413]]) {
      const t = setup({ verdict: VERDICTS.reader, outbox: LIVE, options })
      const said = (await body(await t.get('/librarius/me'))).form
      expect(said).toBe(options.form ?? 'v2')
      expect((await t.send('POST', `/librarius/posts/${POST}/messages`, long)).status, said).toBe(status)
    }
  })

  it('says no form when the Librarius is not configured, nor to someone who cannot read the forum', async () => {
    const off = await setup({ configured: false, options: { form: 'plain' } }).get('/librarius/me')
    expect(off.status).toBe(503)
    expect(await body(off)).not.toHaveProperty('form')
    const outsider = await body(await setup({ verdict: VERDICTS.outsider, outbox: LIVE, options: { form: 'plain' } }).get('/librarius/me'))
    expect(outsider).not.toHaveProperty('form')
  })

  describe('the AutoMod rules the site cannot check', () => {
    // A rule with a pattern the site cannot run (a word boundary), one it can, and one that is off.
    const rule = (id, name, patterns, over = {}) => ({ id, name, enabled: true, trigger_type: 1, trigger_metadata: { keyword_filter: [], regex_patterns: patterns }, exempt_roles: [], exempt_channels: [], ...over })
    const RULES = () => [rule('200000000000000472', 'Invented word boundary', ['\\bcat\\b']), rule('200000000000000473', 'Invented plain', ['zorp']), rule('200000000000000474', 'Invented off', ['\\bdog\\b'], { enabled: false }), rule('200000000000000475', 'Invented second', ['\\wcow'])]

    it('names them to a member who manages messages, in the order of the rules, each once', async () => {
      const out = await body(await setup({ verdict: VERDICTS.librarian, outbox: LIVE, rules: RULES }).get('/librarius/me'))
      expect(out.automodUnchecked).toEqual(['Invented word boundary', 'Invented second'])
    })

    it('gives an empty list when the site can check every rule there is', async () => {
      for (const rules of [() => [], () => [rule('200000000000000473', 'Invented plain', ['zorp'])]]) {
        const out = await body(await setup({ verdict: VERDICTS.librarian, outbox: LIVE, rules }).get('/librarius/me'))
        expect(out.automodUnchecked).toEqual([])
      }
    })

    it('says it to a member who manages messages while there is no webhook too, as it says whether sending is paused', async () => {
      const out = await body(await setup({ verdict: VERDICTS.librarian, rules: RULES }).get('/librarius/me'))
      expect(out.automodUnchecked).toEqual(['Invented word boundary', 'Invented second'])
    })

    it('says nothing of it to a reader, or to someone who cannot read the forum, and does not ask for the rules', async () => {
      let asked = 0
      const rules = () => {
        asked++
        return RULES()
      }
      expect(await body(await setup({ outbox: LIVE, rules }).get('/librarius/me'))).not.toHaveProperty('automodUnchecked')
      expect(await body(await setup({ verdict: { ...VERDICTS.reader, manageThreads: true, attach: true }, outbox: LIVE, rules }).get('/librarius/me'))).not.toHaveProperty('automodUnchecked')
      expect(await body(await setup({ verdict: VERDICTS.outsider, outbox: LIVE, rules }).get('/librarius/me'))).toEqual({ access: false })
      expect(asked).toBe(0)
    })

    it('says null, and answers the rest of /librarius/me all the same, when the rules cannot be read', async () => {
      const t = setup({
        verdict: VERDICTS.librarian,
        outbox: LIVE,
        rules: () => {
          throw new Upstream('Discord answered 403 for the AutoMod rules.')
        },
      })
      const res = await t.get('/librarius/me')
      expect(res.status).toBe(200)
      const out = await body(res)
      expect(out.automodUnchecked).toBeNull()
      expect(out).toMatchObject({ access: true, can: { manageMessages: true }, sendingFatal: false })
    })

    it('does not hide a failure that is not Discord being unreachable', async () => {
      const t = setup({
        verdict: VERDICTS.librarian,
        outbox: LIVE,
        rules: () => {
          throw new TypeError('a bug')
        },
      })
      await expect(t.get('/librarius/me')).rejects.toBeInstanceOf(TypeError)
    })
  })
})
