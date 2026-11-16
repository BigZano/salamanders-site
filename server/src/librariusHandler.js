/**
 * The Librarius routes (the guild's Discord forum, read on the site; see docs/superpowers/specs/2026-11-15-librarius-design.md).
 * Modeled on galleryHandler.js. Every route is read-only but one, which records how far a member has read.
 *
 * Gates, in order: a path that is not /librarius or under it is none of this handler's (null); an unknown route is 404; an
 * unconfigured Librarius is 503; then librariusAccess.js gives a verdict: none is 401, Discord down is 503. /librarius/me
 * answers any signed-in user, and tells someone who may not read the forum only that (`access: false`); every other route
 * needs a reader (403). Every route uses the short-lived cached verdict, the PUT too: it writes only the caller's own read
 * mark. No route reads its body before those checks, and no error message echoes what was sent. Responses are never cached.
 *
 * A post or message id that is no snowflake that fits a bigint never reaches the store: a post is 404, a cursor 400.
 *
 * Reading messages. A page, or a poll for changes, answers `rev`, the number a poll asks from next: the highest of this
 * post's own. It is read from the store BEFORE the messages are, so a write that lands while they are read is sent again
 * by the next poll rather than missed. A write takes its number before it commits, so a poll also asks from 100 numbers
 * below the one it was given: the numbers are the sequence's, shared by every post, and a transaction (a batch of
 * messages, say) takes one for all its rows, so 100 is a hundred transactions of any post. The client replaces a message
 * by its id, so a message sent twice does no harm. A poll that is more than the store may answer at once (CHANGES_LIMIT)
 * is told to start over: `{ reset: true }`.
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
import { BIGINT_MAX, isStoreId } from './librariusText.js'

const REV = /^\d{1,19}$/
// A page's limit: 1 to 100, written without leading zeros.
const LIMIT = /^([1-9]\d?|100)$/
const MENTION = /<@!?(\d{17,20})>/g
const POST_ROUTE = /^\/librarius\/posts\/([^/]+)(?:\/(messages|changes|read))?$/

const DEFAULT_LIMIT = 50
const CHANGES_LIMIT = 200
const CHANGES_SLACK = 100n
const REFRESH_WITHIN_MS = 300_000
const REFRESH_MAX = 50
const QUOTE_LENGTH = 200
const JSON_MAX_BYTES = 1024

const NO_SUCH_POST = 'No such post.'
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

export function createLibrariusHandler({ access, store, guild, links, importer, roster, guildId, forumId, configured, now = Date.now }) {
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

  async function me(_request, verdict) {
    if (!verdict.read) return reply(200, { access: false })
    const [facts, status] = await Promise.all([guild.facts(), importer.status()])
    return reply(200, {
      access: true,
      ready: status.importDone,
      tags: facts.tags,
      roles: facts.roles.map(({ id, name, color }) => ({ id, name, color })),
      guildId,
      forumId,
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

  async function changes(postId, url) {
    const since = parseSince(url.searchParams)
    if (since === null) return reply(400, { error: BAD_CURSOR })
    const rev = await store.currentRev(postId)
    // Stryker disable next-line EqualityOperator: at exactly the slack, both ways ask from 0
    const from = since > CHANGES_SLACK ? since - CHANGES_SLACK : 0n
    const found = await store.changes(postId, String(from), CHANGES_LIMIT)
    if (found.rows.length >= CHANGES_LIMIT || found.deleted.length >= CHANGES_LIMIT) return reply(200, { reset: true })
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

  /** → { me, run } for a known route, else null. `me` true: any signed-in user, a reader or not. */
  function find(method, pathname) {
    if (method === 'GET' && pathname === '/librarius/me') return { me: true, run: me }
    if (method === 'GET' && pathname === '/librarius/emoji') return { run: emoji }
    if (method === 'GET' && pathname === '/librarius/posts') return { run: posts }
    const match = POST_ROUTE.exec(pathname)
    if (match === null) return null
    const [, id, part] = match
    if (method === 'GET' && part === undefined) return { run: onPost(id, (_request, verdict) => openPost(id, verdict)) }
    if (method === 'GET' && part === 'messages') return { run: onPost(id, (_request, _verdict, url) => messages(id, url)) }
    if (method === 'GET' && part === 'changes') return { run: onPost(id, (_request, _verdict, url) => changes(id, url)) }
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
      const verdict = await access.resolve(request, { fresh: false })
      if (!verdict) return reply(401, { error: 'Sign in with Discord.' })
      if (!verdict.read && !route.me) return reply(403, { error: 'Restricted to those who can read the Librarius in Discord.' })
      return await route.run(request, verdict, url)
    } catch (err) {
      if (err instanceof Upstream) return reply(503, { error: 'Discord could not be reached. Try again.' })
      throw err
    }
  }
}
