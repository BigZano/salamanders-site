/**
 * The Librarius's write routes (batch 2): what a member does from the site that reaches Discord. librariusHandler.js owns the gates
 * (the route table, who is signed in and may read, a fresh verdict for every write, 503 while the webhook is unset or refused) and
 * hands each route here; the routes answer the rest. Nothing here talks to Discord: a reply, an edit and a delete are written to
 * the outbox (librariusOutboxStore.js enqueueOutbox), whose worker (librariusOutbox.js) sends them, and `outbox.kick()` tells it
 * one is waiting. A refused request writes nothing.
 *
 * createLibrariusWrites({ store, guild, roster, outbox, limits, guildId, forumId, form = 'v2', siteUrl, now = Date.now,
 *   newKey = crypto.randomUUID }) → { reply, pending, edit, remove, upload, search }, each → a Response, and `form`, the form
 *   ('v2' or 'plain') that a reply is checked and queued in, for /librarius/me to tell the site.
 *   `siteUrl` is the site's address (https, no path): the button of a reply and "Delete on site" link to it. `outbox` may be null: the
 *   routes queue all the same and tell no one (the handler never runs a write route without one).
 *
 * Every refusal is { error } in plain words that blame nobody, and no text of Discord's reaches the browser. The request is read
 * after its gates, never before, and never more than 64 KB of JSON or 10 MB and a form of a picture (librariusBody.js).
 *
 * Refused work is not free. The first thing a reply, an edit, a delete or an upload does is take a place in a window of TRIES of its member
 * (librariusLimits.js): 20 writes a minute (all three JSON writes share it) and 10 upload tries a minute, 429 over them, whatever the try
 * comes to (a 403, a 404 or a body that is refused all count; an upload first makes sure its member has a place in flight, below, and is
 * given its try back when the site is too busy to work it). That is before any lookup and before the body is read, and it is on top of
 * the windows that count what is let through (3 replies and 20 edits a minute, 30 uploads an hour), which a refused try does not use. A
 * member has no more than 2 pictures in flight, from the moment one starts to arrive (429, before the try is taken, so it costs none).
 * A picture on its way holds no more than its own bytes, and it has 120 seconds from the request's start to come (400). Once it has
 * come it is held in memory several times over while it is read as a form, judged and stripped, so only 4 are worked at a time in
 * all (503, and the try is given back). What a member holds of pictures that are not sent yet is capped at 100 MiB (413).
 *
 * reply(postId, request, verdict): POST /librarius/posts/:id/messages with { source, replyTo?, pingReply?, mentions[], uploads[] }
 *   → 202 { pending: { key, state: 'sending' } }. In this order: 404 for a post the store does not hold; 403 for a member who is
 *   timed out ("You're timed out in the server until 21:14 UTC on 20 November 2026.") or may not reply ("You can't reply in this post."), and for a
 *   locked post without Manage Threads ("This post is locked."); 429 over 3 replies a minute (Retry-After says when); then the
 *   body (415, 413, and `source` that is no text: 400 "Write something first."); 403 "You can't attach pictures here." for `uploads`
 *   that holds anything from a member who may not attach (pictures held from before they lost the right are not sent, and nothing is
 *   looked up for them); `replyTo` is the id of a message of this post
 *   (else 400); the AutoMod rules (an Upstream from guild.automodRules() is the handler's 503: a write is never let through
 *   unchecked); `mentions` are the ids picked through the member search, and only those who are members who may read the forum
 *   count, so that nobody outside it is ever pinged; validateReply(), whose refusals pass through as they are ({ error }, and
 *   `rule` and `match` for AutoMod); and the pictures, which must be the member's own, held and not sent. `pingReply: true` also
 *   pings the author of the message replied to, when that stays within the mention cap and the author is a member of the roster who may
 *   read the forum, as every mention must be (else the ping is dropped, and the reply still goes). The name and picture it goes under are the
 *   roster's (cleanName), else the member's Discord name. The 3-a-minute slot is taken only for a reply that is queued. The queued
 *   reply's payload carries `form` ('v2' or 'plain'), the form it was checked in, which the outbox sends it in (contract 1, rB2 m1).
 * pending(postId, verdict): GET /librarius/posts/:id/pending → { pending: [{ key, kind, state, error, source, createdAt }] }: the
 *   member's own outbox entries for the post of the last day that are not done, oldest first. `state` is 'sending' (waiting or
 *   being sent), 'blocked' or 'failed'; `error` is what the member is told, only once the entry has ended, else null; `source` is
 *   the text of a reply, null for an edit or a delete.
 * edit(messageId, request, verdict): PATCH /librarius/messages/:id with { source, mentions[], uploads? }: the author of a reply
 *   written on the site, and no one else. 404, 403 for another's message or one written in Discord, the same 403s as a reply for
 *   timed out, no right to reply and a locked post, 409 while the message is being changed already, 429 over 20 a minute (edits and
 *   deletes share it), then the same checks as a reply. Pictures are fixed when a reply is sent: `uploads` is absent, or lists the
 *   file names the message has (`picture-N.ext`, in order), and an edit that would move or change a picture, as the form's
 *   placement() says, is 400 "That edit would move or change a picture...". → 202 { pending: { key: the message id, state } }.
 * remove(messageId, verdict): DELETE /librarius/messages/:id by its author (timed out or not), or anyone with Manage Messages (mayDelete), a message of Discord's
 *   or the site's alike (the outbox deletes it from Discord by the webhook or the bot). A whole post is never deleted here (the
 *   message that opens it is 403), and nothing in a locked post but by a member who manages threads (403 "This post is locked.",
 *   as in Discord, the author included). 404, 403, 409 while it is being changed, 429 as for an edit. → 202.
 * upload(request, verdict): POST /librarius/uploads, multipart, one picture of 10 MB at most → 201 { id }. In this order: 429 "One
 *   picture at a time, please." for a member's third in flight (no try is taken); 429 over 10 tries a minute; 403 without the right
 *   to attach; 429 over 30 an hour (checked before the body is read, counted when the picture is held); 415, 413, and 400 "That
 *   picture took too long to arrive." for one that has not all come 120 s after the request's start (librariusBody.js receivePicture,
 *   which says why it is not 408);
 *   503 "The site is busy with pictures; try again in a moment." when 4 are being worked already (the try is given back); 413, 400
 *   for a form that is not one picture or a file that is no PNG, JPEG, WebP or GIF by its bytes (librariusUploads.js sniff, then
 *   strip: a file strip refuses is never held), and 413 "You're holding too many pictures; send or remove some first." when the
 *   member would hold more than 100 MiB of pictures that are not sent. What is held is the stripped bytes, under a name of our own,
 *   never the file's. Every place is given up on every way out, a body that breaks and a store that fails included.
 * search(url, verdict): GET /librarius/members?q= → { members: [{ id, name, avatar }] }, at most 10 of the roster whose name has `q`
 *   or whose id is `q` (searchMembers of deathwatchPeople.js), who may read the forum by Discord's rules (permissionsIn). `q` is 1 to
 *   32 characters, else 400. It takes a place of a window of its own (30 a minute), once the query is known to be one and the roster is
 *   loaded (503 until it is), so it cannot be used to sweep the roster.
 */
import { randomUUID } from 'node:crypto'
import { searchMembers } from './deathwatchPeople.js'
import { reply } from './httpReply.js'
import { pictureOf, readJsonWithin, receivePicture } from './librariusBody.js'
import { DEFAULT_FORM, FORMS, placement } from './librariusForm.js'
import { COPY as OUTBOX_COPY } from './librariusOutbox.js'
import { canRead, permissionsIn } from './librariusPerms.js'
import { MENTION_CAP, automodMatcher, cleanName, validateReply } from './librariusSend.js'
import { isStoreId } from './librariusText.js'
import { sniff, strip } from './librariusUploads.js'

const JSON_MAX_BYTES = 65_536
// How long a picture has to arrive, from the request's start. Bun ends a body that stalls (its idleTimeout of 10 s, which index.js
// leaves as it is), but not one that keeps coming slowly: this is what bounds how long a picture on its way keeps its member's place.
// A picture on its way holds only its member's own 2 places: the place for all is taken once the bytes have come (place.work), so a
// slow one keeps no one else waiting, and the time can be long. 10 MB and the form around it in 120 s is about 0.7 Mbit/s.
const ARRIVAL_MS = 120_000
// What a member may hold of pictures that are not sent yet, in all: 100 MiB, ten of the biggest there can be.
const MAX_HELD_BYTES = 100 * 1024 * 1024
const PENDING_WINDOW_MS = 86_400_000
const SEARCH_MIN = 1
const SEARCH_MAX = 32
const SEARCH_SHOWN = 10
// How many people to mention, and how many pictures, are looked up for a reply at most: more is the member's mistake, or a
// client's, and the lookups that follow need a bound.
const LOOKUPS_MAX = 50
const SERIAL = /^\d{1,19}$/
const WORST_ID = '9'.repeat(20)
const MAX_URL = 200
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
// The states of an outbox entry that is on its way, and those that ended for good without being sent.
const ON_ITS_WAY = new Set(['pending', 'sending'])

const COPY = {
  noPost: 'No such post.',
  noMessage: 'No such message.',
  timedOut: (until) => (until === null ? "You're timed out in the server." : `You're timed out in the server until ${until}.`),
  cantReply: "You can't reply in this post.",
  cantEdit: "You can't edit in this post.",
  cantAttach: "You can't attach pictures here.",
  locked: 'This post is locked.',
  tooLarge: 'The request is too large (64 KB at most).',
  badReplyTo: "That message can't be replied to.",
  noReplyTo: 'The message you are replying to is no longer there.',
  notAPicture: "That file isn't a picture we can take (PNG, JPEG, WebP or GIF).",
  tooManyHeld: "You're holding too many pictures; send or remove some first.",
  notAuthor: 'Only the author can edit this reply.',
  cantDelete: 'Only the author, or someone who can manage messages, can delete this.',
  wholePost: "A whole post can't be deleted here.",
  busy: 'This message is already being changed. Try again in a moment.',
  badQuery: 'Type 1 to 32 characters to search.',
  noRoster: 'The member list is not ready yet. Try again.',
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const two = (n) => String(n).padStart(2, '0')

/**
 * → when a timeout ends (the verdict's ISO time), as a member reads it, "21:14 UTC on 20 November 2026", or null for a time that is
 * none. The minute is rounded up, so that a member who tries again at the minute said is not refused once more.
 */
function untilWords(iso) {
  const ms = Math.ceil(Date.parse(iso) / 60_000) * 60_000
  if (Number.isNaN(ms)) return null
  const at = new Date(ms)
  return `${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC on ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isSerial = (v) => typeof v === 'string' && SERIAL.test(v) && BigInt(v) <= 9223372036854775807n

const SITE_MESSAGE = `siteUrl must be an https address with no path, short enough for a button (${MAX_URL} characters with a post's path).`

/** → the site's address without a trailing slash, or a RangeError for one a button cannot carry. */
export function siteBase(url) {
  if (typeof url !== 'string') throw new RangeError(SITE_MESSAGE)
  const base = url.replace(/\/+$/, '')
  if (!/^https:\/\/[^\s<>/]+$/.test(base) || `${base}/reliquarium/librarius/${WORST_ID}`.length > MAX_URL) throw new RangeError(SITE_MESSAGE)
  return base
}

/**
 * → whether the member of `verdict` may delete a message that `authorId` wrote: one who can read the forum, and is its author or may
 * manage messages. A member who is timed out, or may not reply, may still delete their own (the owner's ruling, 2026-11-22). The DELETE
 * route asks this of the message, and /librarius/me of the member's own (`can.delete`), so the site offers what the route does; the rest
 * is the message's (the opening message, a locked post, a change on its way).
 */
export const mayDelete = (verdict, authorId) => verdict.read === true && (authorId === verdict.user.id || verdict.manageMessages === true)

export function createLibrariusWrites({ store, guild, roster, outbox, limits, guildId, forumId, form = DEFAULT_FORM, siteUrl, now = Date.now, newKey = randomUUID }) {
  if (!FORMS.includes(form)) throw new RangeError('form must be "v2" or "plain".')
  const site = siteBase(siteUrl)
  const postUrl = (postId) => `${site}/reliquarium/librarius/${postId}`

  const slowDown = (result) => reply(429, { error: result.error }, { 'Retry-After': String(result.retryAfter) })

  /** → the 403 for a member who may not write, or null: timed out, or without the right to reply (`cant` is the copy). */
  function mayNotWrite(verdict, cant) {
    if (verdict.timedOut) return reply(403, { error: COPY.timedOut(untilWords(verdict.timeoutUntil)) })
    return verdict.reply ? null : reply(403, { error: cant })
  }

  /** → the 403 for a locked post that the member may not write in, or null. */
  const lockedFor = (post, verdict) => (post.locked && !verdict.manageThreads ? reply(403, { error: COPY.locked }) : null)

  /** → whether a member may read the forum, by Discord's rules, from the facts of the guild and the member's roles. */
  const mayRead = (facts, member) =>
    canRead(permissionsIn({ guildId, ownerId: facts.ownerId, roles: facts.roles, overwrites: facts.overwrites, memberId: member.id, memberRoleIds: member.roles }))

  /**
   * → { mentions } or { refusal }: the ids of `asked` (the people picked for a mention) that are members of the roster (`people`,
   * with their roles; null before it loads) who may read the forum, in order: the only ones a reply may ping. Anything in `asked`
   * that is no id, or no such member, is left out, and the reply's own check then refuses a mention of it. `asked` that is no list
   * is left as it is for that check to refuse. A refusal is the 503 for a roster that has not loaded, when there is someone to look for.
   */
  async function pickedMentions(asked, people) {
    if (!Array.isArray(asked)) return { mentions: asked }
    const wanted = new Set(asked.filter(isStoreId).slice(0, LOOKUPS_MAX))
    // Stryker disable next-line ObjectLiteral,ArrayDeclaration: nobody picked reads as an empty list or as none at all, and a stray entry is no id anyone's text can mention
    if (wanted.size === 0) return { mentions: [] }
    if (people === null) return { refusal: reply(503, { error: COPY.noRoster }) }
    const facts = await guild.facts()
    return { mentions: people.filter((p) => wanted.has(p.id) && mayRead(facts, p)).map((p) => p.id) }
  }

  /** → whether `id` is a member of the roster (`people`, with their roles; null before it loads) who may read the forum. */
  async function mayPing(id, people) {
    const author = people?.find((p) => p.id === id)
    return author !== undefined && mayRead(await guild.facts(), author)
  }

  /**
   * → { refusal } (the Response) or { clean, matcher }: `input` through validateReply() for this member, against the guild's AutoMod
   * rules as they apply to them. The rules cannot be read: Upstream, which the handler answers with 503, never a reply let through.
   */
  async function checked(verdict, postId, input, options) {
    const matcher = automodMatcher(await guild.automodRules(), { memberRoleIds: verdict.roleIds, channelIds: [forumId, postId], isAdmin: verdict.admin })
    const result = await validateReply(input, { ...options, automod: matcher })
    if (!result.ok) {
      const { ok: _ok, status, ...body } = result
      return { refusal: reply(status, body) }
    }
    return { clean: result.clean, matcher }
  }

  /** → the 429 for a member who has used their tries of a kind (`writeTry`), or null: taken before anything else is done, refused or not. */
  function triedTooOften(kind, verdict) {
    const tried = limits.take(kind, verdict.user.id)
    return tried.ok ? null : slowDown(tried)
  }

  async function replyTo(postId, request, verdict) {
    const tooOften = triedTooOften('writeTry', verdict)
    if (tooOften !== null) return tooOften
    const found = await store.getPost(postId, verdict.user.id)
    if (found === null) return reply(404, { error: COPY.noPost })
    const refusal = mayNotWrite(verdict, COPY.cantReply) ?? lockedFor(found.post, verdict)
    if (refusal !== null) return refusal
    const early = limits.check('reply', verdict.user.id)
    if (!early.ok) return slowDown(early)

    const read = await readJsonWithin(request, { maxBytes: JSON_MAX_BYTES, tooLarge: COPY.tooLarge })
    if (read.error) return reply(read.status, { error: read.error })
    // Anything that is not an object has no source: validateReply refuses it as it refuses an empty one.
    const body = isObject(read.body) ? read.body : {}
    // Pictures held from before a member lost Attach Files are not sent: the right is asked for each reply, not only for each upload.
    if (Array.isArray(body.uploads) && body.uploads.length > 0 && !verdict.attach) return reply(403, { error: COPY.cantAttach })

    let target = null
    if (body.replyTo !== undefined && body.replyTo !== null) {
      if (!isStoreId(body.replyTo)) return reply(400, { error: COPY.badReplyTo })
      const [quoted] = await store.quotedMessages(postId, [body.replyTo])
      if (quoted === undefined) return reply(400, { error: COPY.noReplyTo })
      target = { messageId: quoted.id, authorId: quoted.authorId, url: `https://discord.com/channels/${guildId}/${postId}/${quoted.id}` }
    }

    const people = await roster.members({ roles: true })
    const picked = await pickedMentions(body.mentions, people)
    if (picked.refusal) return picked.refusal

    const held = await store.heldUploadIds(verdict.user.id, Array.isArray(body.uploads) ? body.uploads.filter(isSerial).slice(0, LOOKUPS_MAX) : [])
    const outcome = await checked(
      verdict,
      postId,
      { source: body.source, replyTo: target === null ? null : { authorId: target.authorId, url: target.url }, mentions: picked.mentions, uploads: body.uploads },
      { form, ownUploadIds: held, authorId: verdict.user.id, siteUrl: postUrl(postId) },
    )
    if (outcome.refusal) return outcome.refusal
    const { clean, matcher } = outcome

    // The author of the message replied to is pinged only if the member asks, if that keeps the reply within the cap, and if the author
    // is someone a mention may ping (a member of the roster who may read the forum): else the ping is dropped and the reply still goes.
    const cap = Math.min(MENTION_CAP, matcher.mentionCap)
    const wanted = body.pingReply === true && target !== null && !clean.mentions.includes(target.authorId) && clean.mentions.length + 1 <= cap
    const pinged = wanted && (await mayPing(target.authorId, people))
    const pings = pinged ? [...clean.mentions, target.authorId] : clean.mentions

    const taken = limits.take('reply', verdict.user.id)
    if (!taken.ok) return slowDown(taken)
    const me = people?.find((p) => p.id === verdict.user.id)
    const key = newKey()
    await store.enqueueOutbox({
      kind: 'send',
      messageKey: key,
      authorId: verdict.user.id,
      payload: {
        postId,
        source: clean.source,
        replyTo: target,
        mentions: pings,
        uploads: clean.uploads,
        username: cleanName(me?.name ?? verdict.user.username),
        avatarUrl: me?.avatar ?? null,
        siteUrl: postUrl(postId),
        // The form validateReply checked it in: the outbox sends it in that one, whatever the form is by the time it is sent.
        form,
      },
    })
    outbox?.kick()
    return reply(202, { pending: { key, state: 'sending' } })
  }

  async function pending(postId, verdict) {
    if ((await store.getPost(postId, verdict.user.id)) === null) return reply(404, { error: COPY.noPost })
    const rows = await store.outboxFor(verdict.user.id, postId, new Date(now() - PENDING_WINDOW_MS))
    const entries = rows.map((r) => {
      const live = ON_ITS_WAY.has(r.state)
      return { key: r.key, kind: r.kind, state: live ? 'sending' : r.state, error: live ? null : r.error, source: r.source, createdAt: r.createdAt }
    })
    return reply(200, { pending: entries })
  }

  /** The message of `id` as the outbox store has it, and the post it is in (for its lock), or the Response to give instead. */
  async function messageAndPost(id, verdict) {
    const message = await store.outboxMessage(id)
    if (message === null) return { refusal: reply(404, { error: COPY.noMessage }) }
    const found = await store.getPost(message.postId, verdict.user.id)
    if (found === null) return { refusal: reply(404, { error: COPY.noPost }) }
    return { message, post: found.post }
  }

  async function edit(messageId, request, verdict) {
    const tooOften = triedTooOften('writeTry', verdict)
    if (tooOften !== null) return tooOften
    const { message, post, refusal } = await messageAndPost(messageId, verdict)
    if (refusal) return refusal
    if (message.authorId !== verdict.user.id) return reply(403, { error: COPY.notAuthor })
    const { layout } = message
    if (message.origin !== 'site' || !isObject(layout) || !Array.isArray(layout.images) || typeof message.source !== 'string') return reply(403, { error: OUTBOX_COPY.notSite })
    const may = mayNotWrite(verdict, COPY.cantEdit) ?? lockedFor(post, verdict)
    if (may !== null) return may
    if (message.state === 'sending') return reply(409, { error: COPY.busy })
    // Discord lets a webhook edit only its own messages: a reply of another one (the address was made again) is deleted and posted again, not edited.
    if (outbox != null && message.webhookId !== outbox.webhookId) return reply(409, { error: OUTBOX_COPY.olderWebhook })
    const early = limits.check('edit', verdict.user.id)
    if (!early.ok) return slowDown(early)

    const read = await readJsonWithin(request, { maxBytes: JSON_MAX_BYTES, tooLarge: COPY.tooLarge })
    if (read.error) return reply(read.status, { error: read.error })
    const body = isObject(read.body) ? read.body : {}

    // The message's own pictures are the only ones an edit can hold, so they are what `uploads` must say, or leave unsaid.
    const names = layout.images.map((image) => image.name)
    const replied = isObject(layout.replyTo) ? layout.replyTo : null
    if (body.uploads !== undefined && body.uploads !== null && JSON.stringify(body.uploads) !== JSON.stringify(names)) return reply(400, { error: OUTBOX_COPY.pictures })

    const people = await roster.members({ roles: true })
    const picked = await pickedMentions(body.mentions, people)
    if (picked.refusal) return picked.refusal

    const outcome = await checked(
      verdict,
      message.postId,
      { source: body.source, replyTo: replied === null ? null : { authorId: replied.authorId, url: replied.url }, mentions: picked.mentions, uploads: names },
      { form: layout.form, ownUploadIds: names, authorId: message.authorId, siteUrl: layout.siteUrl },
    )
    if (outcome.refusal) return outcome.refusal
    const { clean } = outcome

    const base = { form: layout.form, authorId: message.authorId, replyTo: replied, siteUrl: layout.siteUrl, images: layout.images }
    if (JSON.stringify(placement(message.source, base)) !== JSON.stringify(placement(clean.source, base))) return reply(400, { error: OUTBOX_COPY.pictures })

    const taken = limits.take('edit', verdict.user.id)
    if (!taken.ok) return slowDown(taken)
    await store.enqueueOutbox({ kind: 'edit', messageKey: message.id, authorId: verdict.user.id, payload: { postId: message.postId, source: clean.source, mentions: clean.mentions } })
    outbox?.kick()
    return reply(202, { pending: { key: message.id, state: 'sending' } })
  }

  async function remove(messageId, verdict) {
    const tooOften = triedTooOften('writeTry', verdict)
    if (tooOften !== null) return tooOften
    const { message, post, refusal } = await messageAndPost(messageId, verdict)
    if (refusal) return refusal
    if (message.id === message.postId) return reply(403, { error: COPY.wholePost })
    if (!mayDelete(verdict, message.authorId)) return reply(403, { error: COPY.cantDelete })
    // As in Discord, nothing is deleted in a locked post but by those who manage threads: the author of a message is no exception.
    const locked = lockedFor(post, verdict)
    if (locked !== null) return locked
    if (message.state === 'sending') return reply(409, { error: COPY.busy })
    const taken = limits.take('edit', verdict.user.id)
    if (!taken.ok) return slowDown(taken)
    await store.enqueueOutbox({ kind: 'delete', messageKey: message.id, authorId: verdict.user.id, payload: { postId: message.postId } })
    outbox?.kick()
    return reply(202, { pending: { key: message.id, state: 'sending' } })
  }

  async function upload(request, verdict) {
    // A member's place covers a picture from the moment it starts to arrive: one turned away for want of it has cost nothing, not even a try.
    const place = limits.hold(verdict.user.id)
    if (!place.ok) return reply(place.status, { error: place.error })
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), ARRIVAL_MS)
    try {
      const tried = limits.take('uploadTry', verdict.user.id)
      if (!tried.ok) return slowDown(tried)
      const may = mayNotWrite(verdict, COPY.cantReply)
      if (may !== null) return may
      if (!verdict.attach) return reply(403, { error: COPY.cantAttach })
      const early = limits.check('upload', verdict.user.id)
      if (!early.ok) return slowDown(early)

      const came = await receivePicture(request, { signal: deadline.signal })
      if (came.error) return reply(came.status, { error: came.error })
      // Only now is the picture held several times over, as it is read as a form, judged and stripped: four at a time in all. One
      // turned away for that is given its try back: it was the site that was busy, not the member who tried too often.
      const work = place.work()
      if (!work.ok) {
        tried.refund()
        return reply(work.status, { error: work.error })
      }
      const read = await pictureOf(came.form)
      if (read.error) return reply(read.status, { error: read.error })
      const type = sniff(read.bytes)
      const bytes = type === null ? null : strip(read.bytes, type)
      if (bytes === null) return reply(400, { error: COPY.notAPicture })

      const taken = limits.take('upload', verdict.user.id)
      if (!taken.ok) return slowDown(taken)
      const added = await store.addUpload({ authorId: verdict.user.id, name: `picture.${EXTENSIONS[type]}`, contentType: type, bytes, maxHeldBytes: MAX_HELD_BYTES })
      // The store holds nothing past the cap, and says so by giving no id.
      if (added === null) return reply(413, { error: COPY.tooManyHeld })
      return reply(201, { id: added.id })
    } finally {
      clearTimeout(timer)
      place.release()
    }
  }

  async function search(url, verdict) {
    const given = url.searchParams.getAll('q')
    if (given.length !== 1 || given[0].length < SEARCH_MIN || given[0].length > SEARCH_MAX) return reply(400, { error: COPY.badQuery })
    const people = await roster.members({ roles: true })
    if (people === null) return reply(503, { error: COPY.noRoster })
    // A window of its own, taken once the query is known to be one and the roster is there to be searched.
    const taken = limits.take('search', verdict.user.id)
    if (!taken.ok) return slowDown(taken)
    const facts = await guild.facts()
    const roles = new Map(people.map((p) => [p.id, p.roles]))
    const found = []
    for (const m of searchMembers(people, given[0], people.length)) {
      if (!mayRead(facts, { id: m.id, roles: roles.get(m.id) })) continue
      found.push({ id: m.id, name: m.name, avatar: m.avatar })
      if (found.length === SEARCH_SHOWN) break
    }
    return reply(200, { members: found })
  }

  return { reply: replyTo, pending, edit, remove, upload, search, form }
}
