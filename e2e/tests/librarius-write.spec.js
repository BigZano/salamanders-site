import { test, expect } from '@playwright/test'

// Replying from the site against the e2e stack, with no page in the way: the api's write routes, its outbox and the Librarius's
// webhook, which discord-mock stands in for. The mock keeps what reached the webhook (GET /__test/librarius/webhook), and it is
// Discord's side of every check here: what a reply became there, and that a refused one never got there. Tokens, ids and words are
// the invented ones in e2e/discord-mock/server.js.
//
// librarius-compose.spec.js may run at the same time, in another worker, and it writes in the compose post (...413) as the illuminator.
// This file writes in the write post (...412), as writers of its own, and finds what it made by its own text. The two share one outbox,
// which makes a webhook call at most every 1.5 s, so a wait for Discord is long. A member may send 3 replies a minute: the replies here
// are shared out between three writers. Both files lock the locked post (...414), and neither opens it again. librarius-api.spec.js may
// drop the gateway for a few seconds; a check that needs it waits for it, and the catch-up that follows a drop covers the rest.
const API = process.env.API_URL || 'http://api:8787'
const MOCK = process.env.DISCORD_MOCK_URL || 'http://discord-mock:4400'

const GUILD = '1322056087792521269'
const WRITE = '200000000000000412'
const LOCKED = '200000000000000414'
const WEBHOOK = '200000000000000460'
const LIBRARIAN = 'test-librarian-token'
const SCRIVENER = { token: 'test-scrivener-token', id: '200000000000000404', name: 'scrivener-tester' }
const RUBRICATOR = { token: 'test-rubricator-token', id: '200000000000000405', name: 'rubricator-tester' }
const COPYIST = { token: 'test-copyist-token', id: '200000000000000406', name: 'copyist-tester' }

const RUN = Date.now().toString(36)
// The button of a reply, and the links between the parts of one.
const SITE = `https://sm2salamanders.site/reliquarium/librarius/${WRITE}`
const THREAD = `https://discord.com/channels/${GUILD}/${WRITE}`
const BUTTON_ROW = { type: 1, components: [{ type: 2, style: 5, label: 'Open On Site', url: SITE }] }
const V2 = 32768
const NO_PINGS = { parse: [], users: [] }
// How long a reply, an edit or a delete may take to reach Discord: it may queue behind the other spec's calls, 1.5 s apart.
const SENT = { timeout: 60_000, intervals: [500] }

const as = (token) => ({ Authorization: `Bearer ${token}` })

/** A GET of the api that must answer 200. → its JSON. */
async function json(request, path, token) {
  const res = await request.get(`${API}${path}`, { headers: as(token) })
  expect(res.status(), path).toBe(200)
  return res.json()
}

const replyIn = (request, postId, who, data) => request.post(`${API}/librarius/posts/${postId}/messages`, { headers: as(who.token), data })
const editOf = (request, messageId, who, data) => request.patch(`${API}/librarius/messages/${messageId}`, { headers: as(who.token), data })
const deleteOf = (request, messageId, who) => request.delete(`${API}/librarius/messages/${messageId}`, { headers: as(who.token) })

/** A reply the api took: 202, and the key of its outbox entry. */
async function queued(res) {
  expect(res.status(), await res.text()).toBe(202)
  const { pending } = await res.json()
  expect(pending).toEqual({ key: expect.stringMatching(/^[0-9a-f-]{36}$/), state: 'sending' })
  return pending.key
}

/** One of the mock's Librarius hooks. → what it answered. */
async function hook(request, name, data) {
  const res = await request.post(`${MOCK}/__test/librarius/${name}`, { data })
  expect(res.status(), name).toBe(200)
  return res.json()
}

const mock = async (request, path) => (await request.get(`${MOCK}${path}`)).json()
/** What reached the webhook: { executes, refused, edits, deletes, bot }. */
const webhook = (request) => mock(request, '/__test/librarius/webhook')
const gateway = (request) => mock(request, '/__test/librarius/gateway')
const gatewayUp = (request) =>
  expect.poll(async () => (await gateway(request)).ready, { timeout: 30_000, message: 'the api is on the gateway' }).toBeGreaterThan(0)

/** The texts a message of the webhook shows: the Text Displays of its components, at any depth, and its content. */
function textsOf(body) {
  const texts = typeof body.content === 'string' ? [body.content] : []
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.type === 10) texts.push(c.content)
      walk(c.components)
    }
  }
  walk(body.components)
  return texts
}
const says = (body, words) => textsOf(body).some((text) => text.includes(words))

/** The messages the webhook made in a post whose text holds `words`, oldest first. */
const madeWith = async (request, postId, words) => (await webhook(request)).executes.filter((e) => e.threadId === postId && says(e.body, words))

/** The messages Discord (the mock) holds in a post, by id. */
const inDiscord = async (request, postId) => (await mock(request, `/v10/channels/${postId}/messages?limit=100`)).map((m) => m.id)

/** The messages of the write post as the site gives them (the newest 100: the post holds fewer). */
const onSite = async (request, who = SCRIVENER) => (await json(request, `/librarius/posts/${WRITE}/messages?limit=100`, who.token)).messages
const siteMessage = async (request, id, who) => (await onSite(request, who)).find((m) => m.id === id)

// A paragraph of about 2,900 characters: a reply of three needs three Discord messages, as one message holds about 3,950.
const paragraph = (lead) => `${lead}: ${'quill ink vellum '.repeat(170).trim()}`

/**
 * A JPEG whose EXIF holds an invented location, as the bytes a phone would send: the JFIF header, the EXIF (APP1), the tables, the frame,
 * one scan and the end. `stripped` is what must reach Discord: the same bytes, the EXIF gone, as librariusUploads.js strips it.
 */
function photo() {
  const ascii = (text) => Array.from(text, (c) => c.charCodeAt(0))
  const segment = (code, payload) => [0xff, code, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]
  const jfif = segment(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const exif = segment(0xe1, [...ascii('Exif\0\0'), 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, ...ascii('GPSLatitude=12/1,34/1,56/1;an invented place')])
  const tables = [
    ...segment(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]),
    ...segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...segment(0xc4, [0, ...new Array(16).fill(0), 0]),
  ]
  const scan = [...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0x34, 0x56]
  const start = [0xff, 0xd8]
  const end = [0xff, 0xd9]
  return {
    bytes: Buffer.from([...start, ...jfif, ...exif, ...tables, ...scan, ...end]),
    stripped: Buffer.from([...start, ...jfif, ...tables, ...scan, ...end]),
  }
}

/**
 * A member picks "Delete on site" on a message, and → the answer the api gave. An interaction sent while the gateway is down reaches
 * no one, as in Discord, so it is sent again until a connection of the api's has heard one; then that one's answer is waited for.
 */
async function deleteOnSite(request, targetId, userId) {
  let sent
  await expect
    .poll(async () => (sent = await hook(request, 'interaction', { targetId, userId })).heard, { timeout: 30_000, message: 'the api hears the interaction' })
    .toBeGreaterThan(0)
  let answer
  await expect
    .poll(async () => (answer = (await mock(request, '/__test/librarius/interactions')).answers.find((a) => a.id === sent.id)), { timeout: 10_000, message: 'the api answers it' })
    .toBeTruthy()
  // Within Discord's three seconds, and with the interaction's own token: the bot's is never sent with it.
  expect(answer.token).toBe(sent.token)
  expect(answer.authorized).toBe(false)
  return answer.body
}

const ephemeral = (content) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } })

test.describe('Librarius replies from the site', () => {
  test.describe.configure({ mode: 'serial' })

  // What the tests below pass from one to the next: the ids of the replies they made.
  const made = {}

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90_000)
    const request = await playwright.request.newContext()
    try {
      const done = async () => {
        const res = await request.get(`${API}/librarius/me`, { headers: as(LIBRARIAN) })
        return res.status() === 200 && (await res.json()).ready
      }
      await expect.poll(done, { timeout: 75_000, intervals: [500], message: 'the import is done' }).toBe(true)
    } finally {
      await request.dispose()
    }
  })

  test('the api asks the gateway for message content, makes "Delete on site" in the guild, and tells a writer what they may do', async ({ request }) => {
    await gatewayUp(request)
    // The gateway refuses an IDENTIFY without Message Content (close 4014), and the api is on it: every IDENTIFY asked for that, and
    // for the AutoMod rules' events, which keep the rules a reply is checked against up to date.
    const { identified } = await gateway(request)
    expect(identified.length).toBeGreaterThan(0)
    for (const intents of identified) {
      expect(intents & (1 << 15), 'Message Content').toBe(1 << 15)
      expect(intents & (1 << 20), 'AutoMod configuration').toBe(1 << 20)
    }
    // READY named the application, and the api made the message command there, once.
    await expect
      .poll(async () => (await mock(request, '/__test/librarius/commands')).commands.map(({ name, type }) => ({ name, type })), { timeout: 10_000 })
      .toEqual([{ name: 'Delete on site', type: 3 }])

    const me = await json(request, '/librarius/me', SCRIVENER.token)
    expect(me).toMatchObject({ access: true, form: 'v2', can: { reply: true, attach: true, manageMessages: false, manageThreads: false } })
    // Nothing for those who manage messages: the writer is not one.
    expect(me).not.toHaveProperty('sendingPausedUntil')
  })

  test('a reply goes to Discord as one Components V2 message, with the footer and no pings, and comes back to the site as the site\'s', async ({ request }) => {
    test.setTimeout(90_000)
    const source = `E2E site reply ${RUN}, with **bold** words`
    const key = await queued(await replyIn(request, WRITE, SCRIVENER, { source, mentions: [] }))

    await expect.poll(async () => (await madeWith(request, WRITE, `E2E site reply ${RUN}`)).length, SENT).toBe(1)
    const [sent] = await madeWith(request, WRITE, `E2E site reply ${RUN}`)
    // Through the forum's webhook, into the post, asked to answer with the message and to take components.
    expect(sent).toMatchObject({ webhookId: WEBHOOK, multipart: false, query: { wait: 'true', thread_id: WRITE, with_components: 'true' }, files: [] })
    // The whole message: V2 (no content), under the writer's name, the text with the footer that names them, the button to the site, and
    // mentions that ping nobody, whatever the text says.
    expect(sent.body).toEqual({
      flags: V2,
      components: [{ type: 17, components: [{ type: 10, content: `${source}\n-# <@${SCRIVENER.id}>` }, BUTTON_ROW] }],
      username: SCRIVENER.name,
      allowed_mentions: NO_PINGS,
    })
    made.simple = sent.messageId

    // Stored once it is sent: one message, the site's, with its source, under the id Discord gave it.
    await expect.poll(async () => (await siteMessage(request, sent.messageId, SCRIVENER))?.origin, SENT).toBe('site')
    expect(await siteMessage(request, sent.messageId, SCRIVENER)).toMatchObject({
      authorId: SCRIVENER.id,
      authorName: SCRIVENER.name,
      origin: 'site',
      source,
      content: source,
      replyTo: null,
      editedAt: null,
      attachments: [],
    })
    // And the writer's queue no longer holds it.
    await expect.poll(async () => (await json(request, `/librarius/posts/${WRITE}/pending`, SCRIVENER.token)).pending.map((p) => p.key), SENT).not.toContain(key)
  })

  test('a reply that needs three messages goes as three, at least 1.5 s apart, and the first is edited to link the other two', async ({ request }) => {
    test.setTimeout(120_000)
    const lead = `E2E long reply ${RUN}`
    const parts = [1, 2, 3].map((n) => paragraph(`${lead} part ${n}`))
    await queued(await replyIn(request, WRITE, SCRIVENER, { source: parts.join('\n\n'), mentions: [] }))

    await expect.poll(async () => (await madeWith(request, WRITE, lead)).length, SENT).toBe(3)
    const sent = await madeWith(request, WRITE, lead)
    const [id1, id2, id3] = sent.map((e) => e.messageId)
    // Each part has its mark, the later ones a link back to the first, and only the last the footer and the button.
    expect(sent.map((e) => e.body.components)).toEqual([
      [{ type: 17, components: [{ type: 10, content: `**1/3** ${parts[0]}` }] }],
      [{ type: 17, components: [{ type: 10, content: `-# [↑ from 1/3](<${THREAD}/${id1}>)\n**2/3** ${parts[1]}` }] }],
      [{ type: 17, components: [{ type: 10, content: `-# [↑ from 1/3](<${THREAD}/${id1}>)\n**3/3** ${parts[2]}\n-# <@${SCRIVENER.id}>` }, BUTTON_ROW] }],
    ])
    for (const e of sent) expect(e.body).toMatchObject({ flags: V2, username: SCRIVENER.name, allowed_mentions: NO_PINGS })
    // Spaced as the "no strikes" numbers say: a webhook call at least 1.5 s after the one before it.
    expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(1500)
    expect(sent[2].at - sent[1].at).toBeGreaterThanOrEqual(1500)

    // Then the first is edited to carry the links forward, which it could not before the others had ids.
    const linksOf = async () => (await webhook(request)).edits.filter((e) => e.messageId === id1)
    await expect.poll(async () => (await linksOf()).length, SENT).toBe(1)
    const [links] = await linksOf()
    expect(links.body).toEqual({
      flags: V2,
      components: [{ type: 17, components: [{ type: 10, content: `**1/3** ${parts[0]}\n-# continues: [2/3](<${THREAD}/${id2}>) · [3/3](<${THREAD}/${id3}>)` }] }],
      allowed_mentions: NO_PINGS,
    })
    expect(links.at - sent[2].at).toBeGreaterThanOrEqual(1500)

    // The site has one message, the first part's, with the whole of what was written; the other parts are no messages of their own.
    await expect.poll(async () => (await siteMessage(request, id1, SCRIVENER))?.source, SENT).toBe(parts.join('\n\n'))
    const ids = (await onSite(request)).map((m) => m.id)
    expect(ids).not.toContain(id2)
    expect(ids).not.toContain(id3)
    made.long = [id1, id2, id3]
  })

  test('an edit that needs one message where there were three keeps the reply, and takes the other two out of Discord', async ({ request }) => {
    test.setTimeout(120_000)
    const [id1, id2, id3] = made.long
    const source = `E2E long reply ${RUN}, now short`
    const res = await editOf(request, id1, SCRIVENER, { source, mentions: [] })
    expect(res.status()).toBe(202)
    expect((await res.json()).pending).toEqual({ key: id1, state: 'sending' })

    const shortened = async () => (await webhook(request)).edits.filter((e) => e.messageId === id1 && says(e.body, 'now short'))
    await expect.poll(async () => (await shortened()).length, SENT).toBe(1)
    const [edit] = await shortened()
    // One part now: no mark, no links, and the footer and the button.
    expect(edit.body).toEqual({
      flags: V2,
      components: [{ type: 17, components: [{ type: 10, content: `${source}\n-# <@${SCRIVENER.id}>` }, BUTTON_ROW] }],
      allowed_mentions: NO_PINGS,
    })
    // The parts it no longer needs are removed once the edit is stored, through the webhook.
    const removed = async () => (await webhook(request)).deletes.filter((d) => d.messageId === id2 || d.messageId === id3)
    await expect.poll(async () => (await removed()).map((d) => d.messageId).sort(), SENT).toEqual([id2, id3].sort())
    for (const d of await removed()) expect(d.at).toBeGreaterThan(edit.at)
    const held = await inDiscord(request, WRITE)
    expect(held).toContain(id1)
    expect(held).not.toContain(id2)
    expect(held).not.toContain(id3)

    // The reply is still the one message on the site, under the same id, with the new text and an edit time.
    await expect.poll(async () => (await siteMessage(request, id1, SCRIVENER))?.source, SENT).toBe(source)
    expect(await siteMessage(request, id1, SCRIVENER)).toMatchObject({ origin: 'site', content: source, editedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
  })

  test('an edit changes the reply in Discord and on the site', async ({ request }) => {
    test.setTimeout(90_000)
    const source = `E2E site reply ${RUN}, edited on the site`
    expect((await editOf(request, made.simple, SCRIVENER, { source, mentions: [] })).status()).toBe(202)

    const edits = async () => (await webhook(request)).edits.filter((e) => e.messageId === made.simple)
    await expect.poll(async () => (await edits()).length, SENT).toBe(1)
    expect((await edits())[0].body).toEqual({
      flags: V2,
      components: [{ type: 17, components: [{ type: 10, content: `${source}\n-# <@${SCRIVENER.id}>` }, BUTTON_ROW] }],
      allowed_mentions: NO_PINGS,
    })
    await expect.poll(async () => (await siteMessage(request, made.simple, SCRIVENER))?.source, SENT).toBe(source)
    expect((await siteMessage(request, made.simple, SCRIVENER)).editedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    // Only its author may edit it.
    const other = await editOf(request, made.simple, COPYIST, { source: `E2E not mine ${RUN}`, mentions: [] })
    expect(other.status()).toBe(403)
    expect(await other.json()).toEqual({ error: 'Only the author can edit this reply.' })
  })

  test('"Delete on site" in the Apps menu answers only the one who asked, with the link to the reply for its author', async ({ request }) => {
    test.setTimeout(90_000)
    await gatewayUp(request)
    // The author, about their own reply: the link to it on the site.
    expect(await deleteOnSite(request, made.simple, SCRIVENER.id)).toEqual(
      ephemeral(`This was written on the site. Delete it there: https://sm2salamanders.site/reliquarium/librarius/${WRITE}#m-${made.simple}`),
    )
    // Someone else, about the same reply.
    expect(await deleteOnSite(request, made.simple, COPYIST.id)).toEqual(ephemeral('Only the author can delete this, on the site.'))
    // Anyone, about a message written in Discord.
    const fromDiscord = (await onSite(request)).find((m) => m.content === 'E2E Write Post: a reply written in Discord')
    expect(fromDiscord).toMatchObject({ origin: 'discord' })
    expect(await deleteOnSite(request, fromDiscord.id, SCRIVENER.id)).toEqual(ephemeral("Written in Discord: use Discord's own Delete."))
    // However many READYs there were by now, the command was made once.
    expect((await mock(request, '/__test/librarius/commands')).made).toBe(1)
  })

  test('a delete on the site takes the reply out of Discord, and off the site', async ({ request }) => {
    test.setTimeout(90_000)
    const res = await deleteOf(request, made.simple, SCRIVENER)
    expect(res.status()).toBe(202)
    const removed = async () => (await webhook(request)).deletes.filter((d) => d.messageId === made.simple)
    await expect.poll(async () => (await removed()).some((d) => d.found), SENT).toBe(true)
    expect(await inDiscord(request, WRITE)).not.toContain(made.simple)
    await expect.poll(async () => (await onSite(request)).map((m) => m.id), SENT).not.toContain(made.simple)
  })

  test('a picture reaches Discord without its EXIF, and the reply shows it on the site', async ({ request }) => {
    test.setTimeout(90_000)
    const { bytes, stripped } = photo()
    const up = await request.post(`${API}/librarius/uploads`, {
      headers: as(RUBRICATOR.token),
      multipart: { file: { name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: bytes } },
    })
    expect(up.status(), await up.text()).toBe(201)
    const { id } = await up.json()
    expect(id).toMatch(/^\d+$/)

    const lead = `E2E picture ${RUN}`
    await queued(await replyIn(request, WRITE, RUBRICATOR, { source: `${lead}\n\n![an invented map](upload:1)`, uploads: [id], mentions: [] }))
    await expect.poll(async () => (await madeWith(request, WRITE, lead)).length, SENT).toBe(1)
    const [sent] = await madeWith(request, WRITE, lead)
    // Multipart: the message names its one file, which the gallery shows where the picture was written.
    expect(sent.multipart).toBe(true)
    expect(sent.body.attachments).toEqual([{ id: 0, filename: 'picture-1.jpg' }])
    expect(sent.body.components[0].components).toContainEqual({ type: 12, items: [{ media: { url: 'attachment://picture-1.jpg' } }] })
    expect(sent.files.map(({ field, name, type }) => ({ field, name, type }))).toEqual([{ field: 'files[0]', name: 'picture-1.jpg', type: 'image/jpeg' }])
    // What arrived is the picture with its EXIF gone, byte for byte: no location, and nothing else changed.
    const arrived = Buffer.from(sent.files[0].base64, 'base64')
    expect(arrived.equals(stripped), `arrived ${arrived.toString('hex')}`).toBe(true)
    expect(arrived.includes('Exif')).toBe(false)
    expect(arrived.includes('GPSLatitude')).toBe(false)

    await expect.poll(async () => (await siteMessage(request, sent.messageId, RUBRICATOR))?.origin, SENT).toBe('site')
    const shown = await siteMessage(request, sent.messageId, RUBRICATOR)
    expect(shown.attachments).toEqual([
      expect.objectContaining({ filename: 'picture-1.jpg', contentType: 'image/jpeg', size: stripped.length, url: expect.stringMatching(/^https:\/\/cdn\.discordapp\.com\/attachments\//) }),
    ])
  })

  test('a reply with the server\'s AutoMod word is refused with 422, and nothing of it reaches Discord', async ({ request }) => {
    const lead = `E2E refused reply ${RUN}`
    const source = `${lead}: a Grimbleflax here`
    const res = await replyIn(request, WRITE, SCRIVENER, { source, mentions: [] })
    expect(res.status()).toBe(422)
    const start = source.indexOf('Grimbleflax')
    expect(await res.json()).toEqual({ error: 'Blocked by the server\'s AutoMod rule "E2E Banned Word".', rule: 'E2E Banned Word', match: { start, end: start + 'Grimbleflax'.length } })
    // An edit with the word is refused the same way, and the reply stays as it was.
    const [id1] = made.long
    const edit = await editOf(request, id1, SCRIVENER, { source: `E2E long reply ${RUN}, a grimbleflax`, mentions: [] })
    expect(edit.status()).toBe(422)
    expect((await edit.json()).rule).toBe('E2E Banned Word')

    // Nothing was queued, so nothing can come later; and nothing came.
    const pending = (await json(request, `/librarius/posts/${WRITE}/pending`, SCRIVENER.token)).pending
    expect(pending.filter((p) => p.source?.includes(lead))).toEqual([])
    const log = await webhook(request)
    expect([...log.executes, ...log.refused].filter((e) => says(e.body, lead))).toEqual([])
    expect(log.edits.filter((e) => says(e.body, 'grimbleflax'))).toEqual([])
    expect((await siteMessage(request, id1, SCRIVENER)).source).toBe(`E2E long reply ${RUN}, now short`)
  })

  test('a reply with a link the server\'s regex rule is against is refused with 422', async ({ request }) => {
    const lead = `E2E shady reply ${RUN}`
    const res = await replyIn(request, WRITE, SCRIVENER, { source: `${lead}: the map is at https://maps.e2e-shady.invalid/keep`, mentions: [] })
    expect(res.status()).toBe(422)
    expect(await res.json()).toEqual({ error: 'Blocked by the server\'s AutoMod rule "E2E Shady Links".', rule: 'E2E Shady Links', match: null })
    // The same words with no link go.
    await queued(await replyIn(request, WRITE, SCRIVENER, { source: `${lead}: the map is in the vault`, mentions: [] }))
    await expect.poll(async () => (await madeWith(request, WRITE, lead)).map((e) => textsOf(e.body)[0]), SENT).toEqual([
      `${lead}: the map is in the vault\n-# <@${SCRIVENER.id}>`,
    ])
  })

  test('a fourth reply within a minute is refused with 429, and only three reach Discord', async ({ request }) => {
    test.setTimeout(120_000)
    const lead = `E2E counted reply ${RUN}`
    for (const n of [1, 2, 3]) await queued(await replyIn(request, WRITE, COPYIST, { source: `${lead} ${n}`, mentions: [] }))
    const fourth = await replyIn(request, WRITE, COPYIST, { source: `${lead} 4`, mentions: [] })
    expect(fourth.status()).toBe(429)
    const wait = Number(fourth.headers()['retry-after'])
    expect(Number.isInteger(wait) && wait >= 1 && wait <= 60, `Retry-After ${wait}`).toBe(true)
    expect(await fourth.json()).toEqual({ error: expect.any(String) })

    await expect.poll(async () => (await madeWith(request, WRITE, lead)).map((e) => textsOf(e.body)[0].split('\n')[0]).sort(), SENT).toEqual([1, 2, 3].map((n) => `${lead} ${n}`))
    // The refused one was never queued.
    const pending = (await json(request, `/librarius/posts/${WRITE}/pending`, COPYIST.token)).pending
    expect(pending.filter((p) => p.source === `${lead} 4`)).toEqual([])
  })

  test('nobody without Manage Threads may reply in a locked post', async ({ request }) => {
    test.setTimeout(60_000)
    await gatewayUp(request)
    await hook(request, `lock/${LOCKED}`, { locked: true })
    await expect.poll(async () => (await json(request, `/librarius/posts/${LOCKED}`, SCRIVENER.token)).post.locked, { timeout: 30_000 }).toBe(true)
    const res = await replyIn(request, LOCKED, SCRIVENER, { source: `E2E locked out ${RUN}`, mentions: [] })
    expect(res.status()).toBe(403)
    expect(await res.json()).toEqual({ error: 'This post is locked.' })
    const log = await webhook(request)
    expect(log.executes.filter((e) => e.threadId === LOCKED)).toEqual([])
    // Not one of this file's writes was refused by Discord: the site refused what Discord would have.
    expect(log.refused.filter((e) => e.threadId === WRITE)).toEqual([])
  })

  test('a part deleted in Discord takes the whole reply off the site, and the rest of it out of Discord', async ({ request }) => {
    test.setTimeout(120_000)
    const lead = `E2E doomed reply ${RUN}`
    const parts = [1, 2].map((n) => paragraph(`${lead} part ${n}`))
    await queued(await replyIn(request, WRITE, RUBRICATOR, { source: parts.join('\n\n'), mentions: [] }))
    await expect.poll(async () => (await madeWith(request, WRITE, lead)).length, SENT).toBe(2)
    const [id1, id2] = (await madeWith(request, WRITE, lead)).map((e) => e.messageId)
    // Stored, links and all, before anything is deleted.
    await expect.poll(async () => (await siteMessage(request, id1, RUBRICATOR))?.origin, SENT).toBe('site')

    // A moderator deletes part 2 in Discord.
    await gatewayUp(request)
    await hook(request, `delete/${id2}`, {})
    // The reply goes from the site, and its first part from Discord, through the webhook.
    await expect.poll(async () => (await onSite(request, RUBRICATOR)).map((m) => m.id), SENT).not.toContain(id1)
    await expect.poll(async () => (await webhook(request)).deletes.some((d) => d.messageId === id1 && d.found), SENT).toBe(true)
    const held = await inDiscord(request, WRITE)
    expect(held).not.toContain(id1)
    expect(held).not.toContain(id2)
  })
})
