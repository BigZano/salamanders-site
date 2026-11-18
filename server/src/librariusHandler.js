/**
 * The Librarius routes (the guild's Discord forum, read on the site; see docs/superpowers/specs/2026-11-15-librarius-design.md).
 * Modeled on galleryHandler.js. Every route is read-only but one, which records how far a member has read.
 *
 * Gates, in order: a path that is not /librarius or under it is none of this handler's (null); an unknown route is 404; an
 * unconfigured Librarius is 503; then librariusAccess.js gives a verdict: none is 401, Discord down is 503. /librarius/me
 * answers any signed-in user, and tells someone who may not read the forum only that (`access: false`); every other route
 * needs a reader (403). The read routes use the short-lived cached verdict, the PUT too: it writes only the caller's own read
 * mark. The write routes (batch 2: a reply, an edit, a delete, a picture, which librariusWrites.js answers) ask for a
 * fresh verdict (never older than 3 seconds, and one lookup of Discord for writes that come together), so that a role taken away or a
 * timeout that has begun stops a write within that, and they are 503 while there is no
 * outbox (the webhook is not set up) or the outbox says Discord has refused the webhook for good. No route reads its body before
 * those checks, and no error message echoes what was sent. Responses are never cached.
 *
 * Routes (the GETs are for readers): /me, /emoji, /posts, /posts/:id, /posts/:id/messages, /posts/:id/changes, /posts/:id/pending
 * (the caller's own queued replies), /members?q= (the member search for a mention); PUT /posts/:id/read; and the writes: POST
 * /posts/:id/messages (a reply: there is no route that creates a post), PATCH and DELETE /messages/:id (never a whole post), POST
 * /uploads. A write whose Discord rules cannot be read (the AutoMod rules) is 503 as any Discord outage is, never let through.
 * The handler takes `outbox` (librariusOutbox.js: kick, sendingPausedUntil, webhookRefused; null while LIBRARIUS_WEBHOOK_URL is
 * unset), `limits` (a createLimits() by default), `form` ('v2' or 'plain'), `siteUrl` (https://sm2salamanders.site) and `newKey`.
 *
 * /librarius/me adds, for a reader, `can: { reply, attach, manageMessages, manageThreads }`, which are what the verdict says and
 * false for all of them while no write is possible, and `limits` (librariusLimits.js snapshot: what the member has left of each).
 * For a member who may manage messages it also says `sendingPausedUntil` (ISO time while the outbox's breaker holds all sending,
 * else null), `sendingFatal` (Discord has refused the webhook) and `automodUnchecked` (the names of the server's AutoMod rules with a
 * regular expression the site cannot run, so that it cannot check a reply against them; [] for none, null when the rules cannot be read
 * just now): what a Librarian needs to see why replies are not going, and what the site does not stand guard over.
 *
 * A post or message id that is no snowflake that fits a bigint never reaches the store: a post is 404, a cursor 400. A post
 * the store no longer holds is 404 too, for a poll for its changes as for the post itself: a post deleted in Discord is
 * gone from the store, and a page left open learns that from its next poll.
 *
 * Reading messages. A page, or a poll for changes, answers `rev`, the number a poll asks from next: the highest of this
 * post's own. It is read from the store BEFORE the messages are, so a write that lands while they are read is sent again
 * by the next poll rather than missed. A write takes its number before it commits, so a poll is also sent again the
 * newest 100 rows and deletes at or below the number it was given (CHANGES_SLACK): the numbers are the sequence's, shared
 * by every post, and a transaction (a batch of messages, say) takes one for all its rows, so a write that commits late
 * is still found. The client replaces a message by its id, so a message sent twice does no harm. Only what is NEW, after
 * the number given, counts toward the limit (CHANGES_LIMIT): a poll that finds the limit filled is told to start over,
 * `{ reset: true }`. What is sent again never does, or a quiet post whose newest rows lie within 100 numbers of its top
 * would send every poll of it back to the start, for ever.
 *
 * Attachment links expire, and the link refresh (librariusLinks.js) keeps them ahead of that for posts that are read.
 * Any that lapse within five minutes of a read are renewed there and then (the first 50 shown), stored, and answered
 * renewed: those of a page's messages, and the thumbnails of the topic list, which no one need have opened. One that
 * cannot be renewed keeps the link the store has.
 *
 * Names and avatars: the roster's now, else the ones stored with the message. `people` answers them by member id for
 * everyone a page names: its authors, those a message mentions, and the authors of the messages it replies to.
 */
import { Upstream } from './discordRoles.js'
import { readJson as readJsonWithin, reply, send } from './httpReply.js'
import { createLimits } from './librariusLimits.js'
import { automodUnchecked } from './librariusSend.js'
import { BIGINT_MAX, isStoreId } from './librariusText.js'
import { createLibrariusWrites } from './librariusWrites.js'

const REV = /^\d{1,19}$/
// A page's limit: 1 to 100, written without leading zeros.
const LIMIT = /^([1-9]\d?|100)$/
const MENTION = /<@!?(\d{17,20})>/g
const POST_ROUTE = /^\/librarius\/posts\/([^/]+)(?:\/(messages|changes|read|pending))?$/
const MESSAGE_ROUTE = /^\/librarius\/messages\/([^/]+)$/

const DEFAULT_LIMIT = 50
const CHANGES_LIMIT = 200
const CHANGES_SLACK = 100
const REFRESH_WITHIN_MS = 300_000
const REFRESH_MAX = 50
const QUOTE_LENGTH = 200
const JSON_MAX_BYTES = 1024

const NO_SUCH_POST = 'No such post.'
const NO_SUCH_MESSAGE = 'No such message.'
// Where the site is, for the button of a reply and the link "Delete on site" gives.
const SITE_URL = 'https://sm2salamanders.site'
const NO_WEBHOOK = "Replying from the site isn't switched on yet."
const WEBHOOK_REFUSED = 'Replying from the site is paused. Try again later.'
const BAD_CURSOR = 'That page cursor is not valid.'
const BAD_MESSAGE = 'That message id is not valid.'

/** → the ids of the members a text mentions, `<@id>` or `<@!id>`, each as often as it does. */
const mentionsIn = (text) => Array.from(text.matchAll(MENTION), (m) => m[1])

/** The first 200 characters of a message, counted as characters so that no pair is cut in two. */
const quote = (text) => Array.from(text).slice(0, QUOTE_LENGTH).join('')

/** → the 1 KB JSON request of a PUT: { body, blank } or { status, error }, as httpReply.readJson. */
const readJson = (request) => readJsonWithin(request, { maxBytes: JSON_MAX_BYTES, tooLarge: 'The request is too large (1 KB at most).' })

/**
 * → what a page needs to name the people on it. `current` is the roster's members by id. `note` takes a name and avatar
 * that a message carried and keeps those of an author's newest message; `want` asks for someone the roster alone may know.
 * `shown` is a member's name and avatar as the roster has them now, else `snapshot`. `people()` answers everyone asked for
 * that the roster or a snapshot knows, as { id: { name, avatar } }.
 */
function createDirectory(current) {
  const snapshots = new Map() // id → { name, avatar, newest: the id of the message it came from, as a bigint }
  const wanted = new Set()
  return {
    shown: (id, snapshot) => current.get(id) ?? snapshot,
    want: (id) => wanted.add(id),
    note(id, name, avatar, messageId) {
      wanted.add(id)
      const newest = BigInt(messageId)
      const held = snapshots.get(id)
      // Stryker disable next-line EqualityOperator: a message noted twice carries the same name and avatar both times
      if (held === undefined || newest > held.newest) snapshots.set(id, { name, avatar, newest })
    },
    people() {
      const out = {}
      for (const id of wanted) {
        const known = current.get(id) ?? snapshots.get(id)
        if (known !== undefined) out[id] = { name: known.name, avatar: known.avatar }
      }
      return out
    },
  }
}

export function createLibrariusHandler({
  access,
  store,
  guild,
  links,
  importer,
  roster,
  guildId,
  forumId,
  configured,
  now = Date.now,
  outbox = null,
  limits = createLimits({ now }),
  form,
  siteUrl = SITE_URL,
  newKey,
}) {
  // No outbox is no webhook: every write is 503 before a route is asked, so nothing is queued then.
  const writes = createLibrariusWrites({ store, guild, roster, outbox, limits, guildId, forumId, form, siteUrl, now, newKey })

  /** → the guild's members by id as the roster has them now: empty before it has loaded. */
  async function members() {
    const list = await roster.members()
    if (list === null) return new Map()
    return new Map(list.map((m) => [m.id, { name: m.name, avatar: m.avatar }]))
  }

  /**
   * → Map of attachment id → { url, expiresAt }, the new link of each of `candidates` ([{ id, url, expiresAt }]) whose link
   * lapses within five minutes (the first 50 of those) and that Discord renewed. The new links are stored too.
   */
  async function renewedLinks(candidates) {
    // A link with no expiry reads as NaN, which is never due.
    const due = candidates.filter((a) => Date.parse(a.expiresAt) <= now() + REFRESH_WITHIN_MS)
    if (due.length === 0) return new Map()
    const renewed = await links.refresh(due.slice(0, REFRESH_MAX).map(({ id, url }) => ({ id, url })))
    if (renewed.size > 0) {
      await store.updateAttachmentUrls([...renewed].map(([id, { url, expiresAt }]) => ({ id, url, expiresAt })))
    }
    return renewed
  }

  /** → { messages, people } for message rows of a post: each as the site shows it, and everyone they name. */
  async function present(postId, rows) {
    const renewed = await renewedLinks(rows.flatMap((m) => m.attachments))
    const directory = createDirectory(await members())
    // What each reply quotes: a message of the page, else one the store has. A message that is not stored is not quoted.
    const quoted = new Map(rows.map((r) => [r.id, r]))
    const missing = [...new Set(rows.map((r) => r.replyTo).filter((id) => id !== null && !quoted.has(id)))]
    if (missing.length > 0) for (const q of await store.quotedMessages(postId, missing)) quoted.set(q.id, q)

    for (const m of rows) {
      directory.note(m.authorId, m.authorName, m.authorAvatar, m.id)
      const target = quoted.get(m.replyTo)
      if (target !== undefined) {
        directory.note(target.authorId, target.authorName, target.authorAvatar, target.id)
        // The quote shows only its first 200 characters, and so only the mentions in those.
        for (const id of mentionsIn(quote(target.content))) directory.want(id)
      }
      for (const id of mentionsIn(m.content)) directory.want(id)
    }

    const messages = rows.map((m) => {
      const author = directory.shown(m.authorId, { name: m.authorName, avatar: m.authorAvatar })
      const target = quoted.get(m.replyTo)
      return {
        id: m.id,
        authorId: m.authorId,
        authorName: author.name,
        authorAvatar: author.avatar,
        content: m.content,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        replyTo:
          target === undefined
            ? null
            : {
                id: target.id,
                authorId: target.authorId,
                authorName: directory.shown(target.authorId, { name: target.authorName }).name,
                content: quote(target.content),
              },
        attachments: m.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
          width: a.width,
          height: a.height,
          url: renewed.get(a.id)?.url ?? a.url,
        })),
        embeds: m.embeds,
        stickers: m.stickers,
        reactions: m.reactions,
        origin: 'discord',
      }
    })
    return { messages, people: directory.people() }
  }

  /** → the names of the AutoMod rules the site cannot check (librariusSend.js automodUnchecked), or null when the rules cannot be read just now. */
  async function uncheckedRules() {
    try {
      return automodUnchecked(await guild.automodRules())
    } catch (err) {
      // For the people who manage the server to read: a failure to read the rules is theirs to be told of, not a reason to answer nothing.
      if (err instanceof Upstream) return null
      throw err
    }
  }

  async function me(_request, verdict) {
    if (!verdict.read) return reply(200, { access: false })
    const [facts, status, unchecked] = await Promise.all([guild.facts(), importer.status(), verdict.manageMessages ? uncheckedRules() : null])
    const refused = outbox !== null && outbox.webhookRefused() !== null
    // Nothing can be written with no webhook, or one Discord has refused: the site then offers no write.
    const writable = outbox !== null && !refused
    const pausedUntil = outbox === null ? null : outbox.sendingPausedUntil()
    return reply(200, {
      access: true,
      ready: status.importDone,
      tags: facts.tags,
      roles: facts.roles.map(({ id, name, color }) => ({ id, name, color })),
      guildId,
      forumId,
      can: {
        reply: writable && verdict.reply,
        attach: writable && verdict.attach,
        manageMessages: writable && verdict.manageMessages,
        manageThreads: writable && verdict.manageThreads,
      },
      limits: limits.snapshot(verdict.user.id),
      ...(verdict.manageMessages ? { sendingPausedUntil: pausedUntil === null ? null : new Date(pausedUntil).toISOString(), sendingFatal: refused, automodUnchecked: unchecked } : {}),
    })
  }

  async function emoji() {
    return reply(200, { emoji: await guild.emoji() })
  }

  async function posts(_request, verdict) {
    const list = await store.listPosts(verdict.user.id)
    // A post with no messages has no latest, and a latest without an image has none to renew.
    const renewed = await renewedLinks(list.map((post) => post.latest?.image).filter(Boolean))
    const directory = createDirectory(await members())
    for (const post of list) {
      for (const id of post.posterIds) directory.want(id)
      if (post.latest === null) continue
      directory.note(post.latest.authorId, post.latest.authorName, post.latest.authorAvatar, post.latest.id)
      // The list shows the latest line, with the mentions in it.
      for (const id of mentionsIn(post.latest.content)) directory.want(id)
    }
    const shown = list.map((post) => {
      const fresh = renewed.get(post.latest?.image?.id)
      if (fresh === undefined) return post
      return { ...post, latest: { ...post.latest, image: { ...post.latest.image, url: fresh.url, expiresAt: fresh.expiresAt } } }
    })
    return reply(200, { posts: shown, people: directory.people() })
  }

  async function openPost(id, verdict) {
    const found = await store.getPost(id, verdict.user.id)
    if (found === null) return reply(404, { error: NO_SUCH_POST })
    await store.markViewed(id)
    return reply(200, { post: found.post, lastRead: found.lastRead, rev: await store.currentRev(id) })
  }

  /** → { limit, before | after | around } for a page request, or null when it is not one. */
  function parsePage(params) {
    const cursors = ['before', 'after', 'around'].filter((name) => params.has(name))
    const limits = params.getAll('limit')
    if (cursors.length > 1 || limits.length > 1) return null
    if (limits.length === 1 && !LIMIT.test(limits[0])) return null
    const page = { limit: limits.length === 1 ? Number(limits[0]) : DEFAULT_LIMIT }
    if (cursors.length === 1) {
      const given = params.getAll(cursors[0])
      if (given.length !== 1 || !isStoreId(given[0])) return null
      page[cursors[0]] = given[0]
    }
    return page
  }

  async function messages(postId, url) {
    const page = parsePage(url.searchParams)
    if (page === null) return reply(400, { error: BAD_CURSOR })
    const rev = await store.currentRev(postId)
    const { rows, hasOlder, hasNewer } = await store.listMessages(postId, page)
    const shown = await present(postId, rows)
    return reply(200, { messages: shown.messages, hasOlder, hasNewer, people: shown.people, rev })
  }

  /** → the rev `since` asks from as a bigint, or null when it is not the digits of one. */
  function parseSince(params) {
    const given = params.getAll('since')
    if (given.length !== 1 || !REV.test(given[0]) || BigInt(given[0]) > BIGINT_MAX) return null
    return BigInt(given[0])
  }

  async function changes(postId, url, verdict) {
    const since = parseSince(url.searchParams)
    if (since === null) return reply(400, { error: BAD_CURSOR })
    // A post deleted in Discord is gone from the store, with its messages, and an open page learns that here.
    if ((await store.getPost(postId, verdict.user.id)) === null) return reply(404, { error: NO_SUCH_POST })
    const rev = await store.currentRev(postId)
    const found = await store.changes(postId, String(since), { limit: CHANGES_LIMIT, slack: CHANGES_SLACK })
    if (found.full) return reply(200, { reset: true })
    const shown = await present(postId, found.rows)
    return reply(200, { messages: shown.messages, deleted: found.deleted, rev, people: shown.people })
  }

  async function markRead(postId, request, verdict) {
    const read = await readJson(request)
    if (read.error) return reply(read.status, { error: read.error })
    const messageId = read.body?.messageId
    if (!isStoreId(messageId)) return reply(400, { error: BAD_MESSAGE })
    await store.setRead(verdict.user.id, postId, messageId)
    return send(204, null)
  }

  /** A route on a post: a post id that is no id is 404 before anything else is looked at. */
  const onPost = (id, run) => (request, verdict, url) => (isStoreId(id) ? run(request, verdict, url) : reply(404, { error: NO_SUCH_POST }))

  /** As onPost, for a message. */
  const onMessage = (id, run) => (request, verdict, url) => (isStoreId(id) ? run(request, verdict, url) : reply(404, { error: NO_SUCH_MESSAGE }))

  /** → { me, write, run } for a known route, else null. `me` true: any signed-in user, a reader or not. `write` true: a fresh verdict, and 503 with no webhook. */
  function find(method, pathname) {
    if (method === 'GET' && pathname === '/librarius/me') return { me: true, run: me }
    if (method === 'GET' && pathname === '/librarius/emoji') return { run: emoji }
    if (method === 'GET' && pathname === '/librarius/posts') return { run: posts }
    if (method === 'GET' && pathname === '/librarius/members') return { run: (_request, verdict, url) => writes.search(url, verdict) }
    if (method === 'POST' && pathname === '/librarius/uploads') return { write: true, run: (request, verdict) => writes.upload(request, verdict) }
    const message = MESSAGE_ROUTE.exec(pathname)
    if (message !== null) {
      const [, id] = message
      if (method === 'PATCH') return { write: true, run: onMessage(id, (request, verdict) => writes.edit(id, request, verdict)) }
      if (method === 'DELETE') return { write: true, run: onMessage(id, (_request, verdict) => writes.remove(id, verdict)) }
      return null
    }
    const match = POST_ROUTE.exec(pathname)
    if (match === null) return null
    const [, id, part] = match
    if (method === 'GET' && part === undefined) return { run: onPost(id, (_request, verdict) => openPost(id, verdict)) }
    if (method === 'GET' && part === 'messages') return { run: onPost(id, (_request, _verdict, url) => messages(id, url)) }
    if (method === 'POST' && part === 'messages') return { write: true, run: onPost(id, (request, verdict) => writes.reply(id, request, verdict)) }
    if (method === 'GET' && part === 'changes') return { run: onPost(id, (_request, verdict, url) => changes(id, url, verdict)) }
    if (method === 'GET' && part === 'pending') return { run: onPost(id, (_request, verdict) => writes.pending(id, verdict)) }
    if (method === 'PUT' && part === 'read') return { run: onPost(id, (request, verdict) => markRead(id, request, verdict)) }
    return null
  }

  return async function handle(request, url) {
    const { pathname } = url
    if (pathname !== '/librarius' && !pathname.startsWith('/librarius/')) return null
    const route = find(request.method, pathname)
    if (!route) return reply(404, { error: 'Not found.' })
    if (!configured) return reply(503, { error: 'The Librarius is not configured.' })
    try {
      const verdict = await access.resolve(request, { fresh: route.write === true })
      if (!verdict) return reply(401, { error: 'Sign in with Discord.' })
      if (!verdict.read && !route.me) return reply(403, { error: 'Restricted to those who can read the Librarius in Discord.' })
      if (route.write && outbox === null) return reply(503, { error: NO_WEBHOOK })
      if (route.write && outbox.webhookRefused() !== null) return reply(503, { error: WEBHOOK_REFUSED })
      return await route.run(request, verdict, url)
    } catch (err) {
      if (err instanceof Upstream) return reply(503, { error: 'Discord could not be reached. Try again.' })
      throw err
    }
  }
}
