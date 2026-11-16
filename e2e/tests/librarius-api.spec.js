import { test, expect } from '@playwright/test'

// The Librarius API against the e2e stack (api + postgres + discord-mock), with no page in the way. discord-mock stands in
// for Discord: the forum (its permission overwrites and tags), two posts, the REST routes the api reads, and the gateway
// WebSocket the api listens to. Tokens and ids are the invented ones in e2e/discord-mock/server.js.
//
// librarius.spec.js may run at the same time, in another worker, and it reads and posts in the ACTIVE post, as the
// librarian. So this file only READS the active post, and everything it makes, edits, deletes or marks read is in the
// ARCHIVED one; and nothing here counts a whole list: every item is found by its own id or its own text.
const API = process.env.API_URL || 'http://api:8787'
const MOCK = process.env.DISCORD_MOCK_URL || 'http://discord-mock:4400'

const GUILD = '1322056087792521269'
const FORUM = '200000000000000400'
const READER_ROLE = '200000000000000401'
const LIBRARIAN_ID = '200000000000000402'
const ACTIVE = '200000000000000410'
const ARCHIVED = '200000000000000411'
const TAG = '200000000000000420'
const EMOJI = '200000000000000430'
const SCRIBE = '200000000000000440'
const ARCHIVIST = '200000000000000441'

const LIBRARIAN = 'test-librarian-token'
const SHUT_OUT = 'test-shut-out-token'
// A Legion member without the reader role; in the guild without any role; not in the guild at all.
const MEMBER = 'test-member-token'
const NOROLE = 'test-norole-token'
const NONMEMBER = 'test-nonmember-token'
// The guild's owner, and a holder of an Administrator role: Discord lets both into every channel.
const OWNER = 'test-owner-token'
const ADMIN = 'test-admin-token'

const RUN = Date.now().toString(36)

const as = (token) => ({ Authorization: `Bearer ${token}` })
const get = (request, path, token) => request.get(`${API}${path}`, { headers: as(token) })
const put = (request, path, token, data) => request.put(`${API}${path}`, { headers: as(token), data })

/** A GET that must answer 200 (as the librarian unless told otherwise). → its JSON. */
async function json(request, path, token = LIBRARIAN) {
  const res = await get(request, path, token)
  expect(res.status(), path).toBe(200)
  return res.json()
}

/** One of the mock's Librarius hooks. → what it answered. */
async function hook(request, name, data) {
  const res = await request.post(`${MOCK}/__test/librarius/${name}`, { data })
  expect(res.status(), name).toBe(200)
  return res.json()
}

/** How many gateway connections the mock has let in and made ready: the api is listening when it is at least 1. */
const gatewaySockets = async (request) => (await (await request.get(`${MOCK}/__test/librarius/gateway`)).json()).ready
const gatewayUp = (request) =>
  expect.poll(() => gatewaySockets(request), { timeout: 30_000, message: 'the api connects to the gateway' }).toBeGreaterThan(0)

/** Every message of a post, oldest first, read as the site does: the newest page, then `before` the oldest seen. */
async function everyMessage(request, postId) {
  const messages = []
  let pages = 0
  let before = null
  do {
    const page = await json(request, `/librarius/posts/${postId}/messages${before === null ? '' : `?before=${before}`}`)
    pages += 1
    // A page that never ran out would loop for ever.
    expect(pages, 'the pages of a 230-message post').toBeLessThan(20)
    messages.unshift(...page.messages)
    before = page.hasOlder ? page.messages[0].id : null
  } while (before !== null)
  return { messages, pages }
}

const newest = async (request, postId) => (await json(request, `/librarius/posts/${postId}/messages`)).messages

/** Every link the api has asked the mock (Discord) to sign again, in the order asked. */
const refreshesAsked = async (request) => (await (await request.get(`${MOCK}/__test/librarius/refreshes`)).json()).asked
/** The `ex` of a signed Discord link: when it lapses, in seconds. */
const lapse = (link) => Number.parseInt(new URL(link).searchParams.get('ex'), 16)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

test.describe('Librarius API', () => {
  test.describe.configure({ mode: 'serial' })

  test('the import of the forum finishes', async ({ request }) => {
    test.setTimeout(90_000)
    // Three pages of the active post and one of the archived one, at the api's own rate with Discord.
    const done = async () => {
      const res = await get(request, '/librarius/me', LIBRARIAN)
      return res.status() === 200 && (await res.json()).ready
    }
    await expect.poll(done, { timeout: 75_000, intervals: [500], message: 'the import is done' }).toBe(true)
  })

  test('who may read is what Discord would say: the reader role is let in, and nobody else', async ({ request }) => {
    const me = async (token) => json(request, '/librarius/me', token)
    expect((await request.get(`${API}/librarius/me`)).status()).toBe(401)
    expect((await get(request, '/librarius/me', 'not-a-real-token')).status()).toBe(401)

    const librarian = await me(LIBRARIAN)
    expect(librarian).toMatchObject({ access: true, ready: true, guildId: GUILD, forumId: FORUM, tags: [{ id: TAG, name: 'E2E Tag' }] })
    expect(librarian.roles).toContainEqual({ id: READER_ROLE, name: 'E2E Reader', color: '#3a5246' })
    expect(librarian.roles).toContainEqual({ id: GUILD, name: '@everyone', color: null })

    // /me answers everyone who is signed in, and tells those who may not read only that. The Legion member holds no reader
    // role, and @everyone is shut out of the forum, so the Legion does not get in; the member overwrite shuts the shut-out one.
    for (const token of [MEMBER, NOROLE, NONMEMBER, SHUT_OUT]) expect(await me(token), token).toEqual({ access: false })
    for (const token of [OWNER, ADMIN]) expect((await me(token)).access, token).toBe(true)

    const closed = [
      '/librarius/posts',
      '/librarius/emoji',
      `/librarius/posts/${ACTIVE}`,
      `/librarius/posts/${ACTIVE}/messages`,
      `/librarius/posts/${ACTIVE}/changes?since=0`,
    ]
    for (const path of closed) {
      expect((await request.get(`${API}${path}`)).status(), `no token ${path}`).toBe(401)
      for (const token of [MEMBER, NOROLE, NONMEMBER, SHUT_OUT]) expect((await get(request, path, token)).status(), `${token} ${path}`).toBe(403)
      expect((await get(request, path, LIBRARIAN)).status(), `the librarian ${path}`).toBe(200)
    }
    // The one write there is, a read marker, is closed in the same way.
    expect((await put(request, `/librarius/posts/${ACTIVE}/read`, SHUT_OUT, { messageId: ACTIVE })).status()).toBe(403)
    expect((await request.put(`${API}/librarius/posts/${ACTIVE}/read`, { data: { messageId: ACTIVE } })).status()).toBe(401)
  })

  test('both posts are listed, the archived one flagged', async ({ request }) => {
    const { posts } = await json(request, '/librarius/posts')
    const active = posts.find((p) => p.id === ACTIVE)
    const archived = posts.find((p) => p.id === ARCHIVED)
    expect(active).toMatchObject({ title: 'E2E Active Post', tagIds: [TAG], archived: false, pinned: false, locked: false })
    expect(archived).toMatchObject({ title: 'E2E Archived Post', tagIds: [], archived: true, pinned: false, locked: false, replies: 2, unread: 0 })
    expect(archived.latest).toMatchObject({ content: 'E2E archived reply 2', authorName: 'E2E Archivist' })
  })

  test('the 230 messages of the active post are all there, in pages, with no duplicates', async ({ request }) => {
    const first = await json(request, `/librarius/posts/${ACTIVE}/messages`)
    expect(first.messages).toHaveLength(50)
    expect(first).toMatchObject({ hasOlder: true, hasNewer: false })
    expect(first.rev).toMatch(/^\d+$/)
    expect(first.people[SCRIBE]).toEqual({ name: 'E2E Scribe', avatar: null })
    // A page of 100 is the most there is, and a page is oldest first.
    expect((await json(request, `/librarius/posts/${ACTIVE}/messages?limit=100`)).messages).toHaveLength(100)
    const firstIds = first.messages.map((m) => BigInt(m.id))
    expect(firstIds).toEqual([...firstIds].sort((a, b) => (a < b ? -1 : 1)))

    const { messages, pages } = await everyMessage(request, ACTIVE)
    // 230 in pages of 50, and a reader of the other spec may have added a few.
    expect(pages).toBeGreaterThanOrEqual(5)
    const ids = messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.map(BigInt)).toEqual([...ids.map(BigInt)].sort((a, b) => (a < b ? -1 : 1)))
    // The first is the post's own message, which Discord gives the post's id.
    expect(messages[0]).toMatchObject({ id: ACTIVE, content: 'E2E opening message', authorName: 'E2E Scribe' })
    // Every one the mock seeded came across: replies 1 to 229, each once, in order.
    const numbered = messages.map((m) => /^E2E message (\d+)(?: |$)/.exec(m.content)?.[1]).filter((n) => n !== undefined)
    expect(numbered.map(Number)).toEqual(Array.from({ length: 229 }, (_, i) => i + 1))

    // The list says how many replies the post has: every message but its own. The count and the pages are two reads, so
    // they are read together until a write of the other spec's does not fall between them.
    await expect
      .poll(
        async () => {
          const listed = (await json(request, '/librarius/posts')).posts.find((p) => p.id === ACTIVE)
          const walked = await everyMessage(request, ACTIVE)
          return listed.replies - (walked.messages.length - 1)
        },
        { timeout: 10_000 },
      )
      .toBe(0)
    expect((await json(request, '/librarius/posts')).posts.find((p) => p.id === ACTIVE).replies).toBeGreaterThanOrEqual(229)
  })

  test('a reply to a message far off the page quotes it, from the store', async ({ request }) => {
    const page = await json(request, `/librarius/posts/${ACTIVE}/messages`)
    const quoting = page.messages.find((m) => m.content === 'E2E message 228 quoting message 3')
    expect(quoting, 'the quoting reply is on the newest page').toBeTruthy()
    const { messages } = await everyMessage(request, ACTIVE)
    const target = messages.find((m) => m.content === 'E2E message 3')
    // The target is not among the 50 the page holds, so only the store can say who wrote it and what it said.
    expect(page.messages.map((m) => m.id)).not.toContain(target.id)
    expect(quoting.replyTo).toEqual({ id: target.id, authorId: ARCHIVIST, authorName: 'E2E Archivist', content: 'E2E message 3' })
    expect(page.people[ARCHIVIST]).toEqual({ name: 'E2E Archivist', avatar: null })
    // A message that replies to nothing quotes nothing.
    expect(page.messages.find((m) => m.content === 'E2E message 229').replyTo).toBeNull()
  })

  test('an attachment that is not on Discord\'s CDN is left out', async ({ request }) => {
    const sent = (await newest(request, ACTIVE)).find((m) => m.content.startsWith('E2E message 227 '))
    expect(sent, 'the message with the attachment is on the newest page').toBeTruthy()
    expect(sent.attachments).toEqual([])
    // Discord's own copy has it, at the mock's address and not at cdn.discordapp.com: the api read it and kept the rest.
    const raw = await (await request.get(`${MOCK}/v10/channels/${ACTIVE}/messages/${sent.id}`)).json()
    expect(raw.attachments).toHaveLength(1)
    expect(raw.attachments[0].url.startsWith(`${MOCK}/cdn/`)).toBe(true)
  })

  test('an attachment on the CDN whose link is about to lapse is kept, and its link renewed through Discord', async ({ request }) => {
    const sent = (await newest(request, ACTIVE)).find((m) => m.content.startsWith('E2E message 226 '))
    expect(sent, 'the message with the expiring attachment is on the newest page').toBeTruthy()
    // Kept: it is on Discord's CDN attachments path, which is the allowlist (unlike the one on the mock's own host, above).
    expect(sent.attachments).toHaveLength(1)
    const [kept] = sent.attachments
    expect(kept).toMatchObject({ filename: 'e2e-expiring.png', contentType: 'image/png' })
    expect(kept.url.startsWith('https://cdn.discordapp.com/attachments/')).toBe(true)

    // Discord's own copy lapses within five minutes (the mock made it so, two minutes after it began), so reading it asked Discord
    // for a new link, and what came back is what the page is given: a day ahead, and not the link Discord held.
    const raw = await (await request.get(`${MOCK}/v10/channels/${ACTIVE}/messages/${sent.id}`)).json()
    const old = raw.attachments[0].url
    expect(lapse(old) * 1000).toBeLessThan(Date.now() + 5 * MINUTE)
    expect(lapse(kept.url)).toBeGreaterThan(lapse(old))
    expect(lapse(kept.url) * 1000).toBeGreaterThan(Date.now() + HOUR)
    const asked = await refreshesAsked(request)
    expect(asked, 'the api asked Discord to sign the old link again').toContain(old)

    // Stored: read again, it is the same link, and Discord is not asked about it again, since it no longer lapses within five minutes.
    const askedOfIt = asked.filter((link) => link === old).length
    const again = (await newest(request, ACTIVE)).find((m) => m.id === sent.id)
    expect(again.attachments[0].url).toBe(kept.url)
    expect((await refreshesAsked(request)).filter((link) => link === old).length).toBe(askedOfIt)
  })

  test('the topic list renews the link of a post\'s thumbnail, and says when the new one lapses', async ({ request }) => {
    // The archived post's newest message has a picture whose link is about to lapse, and no one need have opened the post.
    const { posts } = await json(request, '/librarius/posts')
    const { latest } = posts.find((p) => p.id === ARCHIVED)
    expect(latest.content).toBe('E2E archived reply 2')
    expect(latest.image).toMatchObject({ url: expect.stringMatching(/^https:\/\/cdn\.discordapp\.com\/attachments\//), expiresAt: expect.any(String) })
    const raw = await (await request.get(`${MOCK}/v10/channels/${ARCHIVED}/messages/${latest.id}`)).json()
    const old = raw.attachments[0].url
    expect(lapse(latest.image.url)).toBeGreaterThan(lapse(old))
    // It lapses where its own link says, a day ahead: the store holds the new expiry as well as the new link.
    expect(Date.parse(latest.image.expiresAt)).toBe(lapse(latest.image.url) * 1000)
    expect(Date.parse(latest.image.expiresAt)).toBeGreaterThan(Date.now() + HOUR)
    expect(await refreshesAsked(request)).toContain(old)
  })

  test('the guild\'s emoji are listed', async ({ request }) => {
    expect(await json(request, '/librarius/emoji')).toEqual({ emoji: [{ id: EMOJI, name: 'e2e_aquila', animated: false }] })
  })

  test('a request that is no page, or no post, is refused', async ({ request }) => {
    const status = async (path) => (await get(request, path, LIBRARIAN)).status()
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'before=abc', 'before=1&after=2', 'around=1&before=2']) {
      expect(await status(`/librarius/posts/${ACTIVE}/messages?${query}`), query).toBe(400)
    }
    for (const query of ['', 'since=-1', 'since=abc', 'since=1&since=2']) {
      expect(await status(`/librarius/posts/${ACTIVE}/changes?${query}`), `changes ${query}`).toBe(400)
    }
    // An id that is no id is not a post, and neither is a well-formed one that no post has.
    expect(await status('/librarius/posts/not-an-id')).toBe(404)
    expect(await status('/librarius/posts/200000000000000499')).toBe(404)
    expect(await status('/librarius/nothing-here')).toBe(404)
    expect((await put(request, `/librarius/posts/${ARCHIVED}/read`, LIBRARIAN, { messageId: 'not-an-id' })).status()).toBe(400)
  })

  test('the changes of a quiet post are never "start over", poll after poll', async ({ request }) => {
    // The post holds 230 messages, written by the import in three batches, so all of them lie within a few revs of its top.
    // What a poll sends again on that account must not count as new, or every poll would be told to reload.
    const opened = await json(request, `/librarius/posts/${ACTIVE}`)
    expect(opened.post).toMatchObject({ id: ACTIVE, title: 'E2E Active Post', archived: false })
    expect(BigInt(opened.rev)).toBeGreaterThan(0n)
    let since = opened.rev
    for (const poll of [1, 2, 3]) {
      const answer = await json(request, `/librarius/posts/${ACTIVE}/changes?since=${since}`)
      expect(answer.reset, `poll ${poll} from ${since}`).toBeUndefined()
      expect(Array.isArray(answer.messages)).toBe(true)
      // The first poll is made on the very case at issue: all 230 messages lie within a few revs of the top, so the rows sent
      // again (the newest 100 of them) are there, and they were not counted as new.
      if (poll === 1) expect(answer.messages.length, 'the rows a poll sends again').toBeGreaterThanOrEqual(100)
      expect(Array.isArray(answer.deleted)).toBe(true)
      expect(BigInt(answer.rev)).toBeGreaterThanOrEqual(BigInt(since))
      since = answer.rev
    }
    // A reader that holds nothing is far behind, and is told to start over, which shows that the answer can be given.
    expect(await json(request, `/librarius/posts/${ACTIVE}/changes?since=0`)).toEqual({ reset: true })
  })

  test('a message, an edit, a reaction and a delete reach the changes within seconds', async ({ request }) => {
    test.setTimeout(60_000)
    await gatewayUp(request)
    const { rev } = await json(request, `/librarius/posts/${ARCHIVED}`)
    const changes = () => json(request, `/librarius/posts/${ARCHIVED}/changes?since=${rev}`)
    const seen = async (id) => (await changes()).messages.find((m) => m.id === id)
    const within = { timeout: 5_000, intervals: [250] }

    const text = `E2E live message ${RUN}`
    // With an attachment of the mock's own host, which the api leaves out of what it keeps.
    const { id } = await hook(request, 'message', { post: ARCHIVED, content: text, authorId: LIBRARIAN_ID, attachments: ['art.png'] })
    await expect.poll(async () => (await seen(id))?.content, within).toBe(text)
    expect(await seen(id)).toMatchObject({
      authorId: LIBRARIAN_ID,
      authorName: 'librarian-tester',
      editedAt: null,
      replyTo: null,
      reactions: [],
      attachments: [],
      origin: 'discord',
    })

    await hook(request, `edit/${id}`, { content: `${text}, edited` })
    await expect.poll(async () => (await seen(id))?.content, within).toBe(`${text}, edited`)
    expect((await seen(id)).editedAt).toMatch(/^\d{4}-\d\d-\d\dT/)

    // A unicode emoji twice, and a custom one once: counts by emoji.
    await hook(request, `react/${id}`, { emoji: '👍', userId: SCRIBE })
    await hook(request, `react/${id}`, { emoji: '👍', userId: ARCHIVIST })
    await hook(request, `react/${id}`, { emoji: { id: EMOJI, name: 'e2e_aquila' }, userId: SCRIBE })
    await expect
      .poll(async () => (await seen(id))?.reactions, within)
      .toEqual([
        { key: 'u:👍', id: null, name: '👍', animated: false, count: 2 },
        { key: `c:${EMOJI}`, id: EMOJI, name: 'e2e_aquila', animated: false, count: 1 },
      ])

    await hook(request, `delete/${id}`, {})
    await expect.poll(async () => (await changes()).deleted, within).toContain(id)
    expect(await seen(id)).toBeUndefined()
    expect((await newest(request, ARCHIVED)).map((m) => m.id)).not.toContain(id)
  })

  test('a message made while the gateway was down is listed once it is back', async ({ request }) => {
    test.setTimeout(90_000)
    await gatewayUp(request)
    const dropped = await hook(request, 'drop', { downMs: 3_000 })
    expect(dropped.closed).toBeGreaterThanOrEqual(1)
    expect(await gatewaySockets(request)).toBe(0)

    const text = `E2E quiet message ${RUN}`
    const { id } = await hook(request, 'quiet-message', { post: ARCHIVED, content: text, authorId: SCRIBE })
    // Nothing told the api of it, and the gateway is still down.
    expect((await newest(request, ARCHIVED)).map((m) => m.id)).not.toContain(id)

    // The api resumes after a backoff, which the mock refuses until the three seconds are over; its READY starts the catch-up.
    await expect.poll(() => gatewaySockets(request), { timeout: 30_000, intervals: [250], message: 'the api is back on the gateway' }).toBeGreaterThan(0)
    await expect
      .poll(async () => (await newest(request, ARCHIVED)).find((m) => m.id === id)?.content, { timeout: 10_000, intervals: [250] })
      .toBe(text)
  })

  test('what comes after the read marker is unread', async ({ request }) => {
    test.setTimeout(60_000)
    await gatewayUp(request)
    const unread = async () => (await json(request, '/librarius/posts')).posts.find((p) => p.id === ARCHIVED).unread
    const markRead = (messageId) => put(request, `/librarius/posts/${ARCHIVED}/read`, LIBRARIAN, { messageId })

    const latest = (await newest(request, ARCHIVED)).at(-1).id
    expect((await markRead(latest)).status()).toBe(204)
    expect(await unread()).toBe(0)

    const { id } = await hook(request, 'message', { post: ARCHIVED, content: `E2E after the marker ${RUN}`, authorId: SCRIBE })
    await expect.poll(unread, { timeout: 5_000, intervals: [250] }).toBe(1)

    expect((await markRead(id)).status()).toBe(204)
    expect(await unread()).toBe(0)
    expect((await json(request, `/librarius/posts/${ARCHIVED}`)).lastRead).toBe(id)
    // A marker only moves forward: an earlier message does not bring the later one back as unread.
    expect((await markRead(latest)).status()).toBe(204)
    expect(await unread()).toBe(0)
    expect((await json(request, `/librarius/posts/${ARCHIVED}`)).lastRead).toBe(id)
  })
})
