/**
 * The Librarius's outbox worker (batch 2): it sends a member's reply from the site to Discord through the webhook, edits it
 * there and deletes it, and it never loses a reply and never posts one twice. A reply is a row of the outbox (see
 * librariusOutboxStore.js) before anything is sent, so a restart finds it, and the worker writes down what it has done to
 * Discord as it does it (payload.progress), so that a restart picks up where it stopped.
 *
 * createOutbox({ store, webhook, discord, form = 'v2', guildId, now = Date.now, timers = { setTimeout, clearTimeout }, log })
 *   → { start(), stop() → Promise, kick(), sendingPausedUntil(), webhookRefused(), webhookId }
 *   `store` is the Librarius store (the outbox methods of librariusOutboxStore.js), `webhook` the client of librariusWebhook.js
 *   and `discord` the bot client of librariusDiscord.js (setArchived, deleteMessage, messagesAfter). `form`
 *   is the form a new reply is sent in ('v2' or 'plain'); a reply keeps the one it began with. `guildId` makes the links
 *   between the parts of a reply. `now` is the clock, in milliseconds, and `timers` its timers: tests give it their own.
 *   start() begins the work, and takes up the entries a stop or a crash left half-done. kick() tells it that an entry was
 *   queued. stop() ends it at the next safe point, which is between two steps and never inside one, and answers when it has.
 *   sendingPausedUntil() is the time (ms) sending is paused until, by the breaker, or null. webhookRefused() is null, or
 *   { status, text } once Discord has refused the webhook itself: the worker has stopped for good (until a restart) and the
 *   routes should answer 503 to writes. `webhookId` is the id of the webhook it sends through: a reply of another webhook (one
 *   that was replaced since) cannot be edited, and a route may say so before it queues anything (COPY.olderWebhook).
 *
 * One worker sends at a time: start() takes a Postgres advisory lock (store.takeWorkerLock), and a worker that does not get it
 * does not send, says so once, and asks again every 30 s (the one that holds it may have stopped). stop() lets it go.
 *
 * The worker runs one entry at a time, the oldest due first (a resumed one before them).
 * - A reply (kind 'send'): payload { postId, source, replyTo: { messageId, authorId, url } | null, mentions: [ids], uploads:
 *   [upload ids], username, avatarUrl | null, siteUrl }. It is cut into parts by toDiscord, and the parts are sent in order,
 *   each carrying the link back to the first; once the last is sent, the first is edited to carry the links forward. Then, in
 *   one transaction, the message is stored (origin 'site', its source and its layout, which an edit needs), its parts are
 *   written and the uploads are deleted. A message has no id of its own: its id is its first part's. Every part is built, and
 *   checked by sendBody, before the first is sent, so that a reply that cannot go fails before any of it is in Discord. If the
 *   store learns, when it stores the reply, that a part was deleted in Discord meanwhile, the reply is not stored: the rest of its
 *   parts are removed, as when the links edit finds the first deleted. If its post is not stored, the reply fails.
 * - An edit (kind 'edit'): payload { postId, source, mentions }, the key the id of the message. The text is cut again; the
 *   parts that are there are edited in place, parts that are not needed are deleted and new ones added, and the first is
 *   edited last to carry the links. Pictures are fixed when a reply is sent: the webhook cannot change the files of a message,
 *   so an edit that would put a picture in another part, or take one away, or add one (placement() of the form says) is
 *   refused: "That edit would move or change a picture...". An edit sends no `attachments`, so Discord keeps each part's files.
 *   An edit that ends for good (failed or blocked) after it began to change Discord queues an edit of its own, { postId, mentions:
 *   [], restore: true }, that puts the message back as the store has it (it takes the text from the store, and is never put back
 *   in its turn). That is queued for any edit that was tried more than once, too: an earlier try may have changed Discord.
 * - A delete (kind 'delete'): payload { postId, partIds? }, the key the id of the message. A reply of the site is removed from
 *   Discord part by part, through the webhook; a message a person wrote in Discord, by the bot. Then the message is deleted
 *   from the store.
 * The parts the worker has sent are in payload.progress: { form, parts: [{ id, at, attachments }], inflight, images, linked,
 * done }. `parts` are the parts this entry made (for an edit, only the ones it added), `inflight` the index of a part it was
 * sending when it stopped, or null: it is written BEFORE a part is sent and cleared once the part's id is written, so a restart
 * knows when a part may or may not be in Discord. `images` are the names the reply's pictures are sent under, `linked` whether
 * the links forward were added (false: the reply goes without them) and `done` the other calls to Discord an entry has made
 * (an edit of a part, a removal), written when each is done: a run of the entry after a failure of the store, a try of the
 * ladder or a restart goes on from there, and does not make a call twice.
 *
 * Never twice. A part is only sent again when it is certain that it did not land: a refusal of Discord (a 4xx, a 429) is
 * certain; a timeout, a reset, a 5xx or an answer with no message is not (`unknown` of the webhook client). After an
 * unknown, and after a restart with `inflight` set, the worker waits until 5 s after the send began (Discord may take a moment to show a
 * message it has made), then reads the thread's messages from 5 s before the send began (progress.inflightAt is written with `inflight`,
 * and the read is messagesAfter of the snowflake of that time) and looks, among those of our webhook, for one whose text is the part's
 * and which no reply has taken as its part yet. (A part's text names the part before it, so no part matches another's.) One found is
 * adopted as the part. Only when there is none is the part sent again, once. A second unknown is looked for in the same way,
 * because no attempt may come after it (the ladder's last): a part it made is adopted, so that an end for good removes it with the
 * rest. When that look finds none, the attempt ends, and the next attempt looks again before it sends. A failed look is a failed
 * attempt, never a resend. (So the one part the worker cannot know of is one that a look which failed, on the ladder's last attempt,
 * could not find: an end for good cannot remove what it has no id for.)
 *
 * Another webhook. A reply keeps the id of the webhook that sent it (progress.webhookId while it is sent, then the message's webhook_id,
 * and each part's). The webhook of an address that was made again is another one, and Discord lets a webhook edit and delete only its own
 * messages. So, for a message of another webhook: a delete removes its parts through the bot (deleteMessage); an edit is refused ("This reply
 * was sent through an older webhook..."), the way a route refuses it before it is queued; and a send that was interrupted with parts of the
 * old webhook in Discord removes them through the bot and begins again from the first part.
 *
 * The limits (the spec's "no strikes" numbers):
 * - every webhook call (send, edit or delete), whichever entry it is for, goes out at least 1500 ms after the one before it;
 * - at most 20 sends in any 60 s, counted when they land (they end), not when they begin; the worker waits until the oldest has left
 *   the window. The window is built again at start from the parts the entries have sent (store.sendTimesSince);
 * - a 429 sets the entry's next try to its Retry-After: it is not an attempt of the ladder, and not a block. A 429 that is
 *   global pauses every webhook call until then;
 * - blocked (what the webhook client calls `blocked`: Discord code 200000, "Message was blocked by automatic moderation", 200001,
 *   "Title was blocked by automatic moderation", or 240000, "Message was blocked because it contains harmful links"): the entry is
 *   'blocked' and never tried again. Two blocks within an hour pause all work for an hour (the breaker); the blocks are noted in
 *   librarius_events (the block of the edit that adds the links too), and the pause itself and a global 429's time are kept with them
 *   (store.outboxHold), so a restart is no pardon;
 * - fatal (the webhook is refused or gone): the worker stops, the entry goes back to 'pending', and webhookRefused() says so;
 * - any other failure (of Discord's, the webhook's or the bot's, or of the store under this entry) is tried again after 5 s, 30 s,
 *   2 min and 10 min, and then the entry is 'failed'. Something that cannot succeed (a TypeError or RangeError: a bad entry)
 *   fails at once. When the store fails under the write that settles an entry, the write is made again every 5 s, and that is
 *   not counted: only an entry that fails each time it is run is.
 * - a thread that is archived (400, code 50083) is unarchived through the bot, the call is made again, and the thread is archived
 *   again when the entry is done. If the bot may not (403), or the webhook is refused with a 403, the entry fails with "This post
 *   is locked in Discord.", and is not tried again.
 * - an entry that ends for good (failed or blocked) leaves nothing of itself in Discord: in the same transaction that writes its
 *   end, a delete of the parts it sent is queued (for a reply, the parts that landed; for an edit, the ones it added), and, for an
 *   edit that may have changed the parts that were there, an edit that puts them back as the store has them.
 * - a thread that is gone: a reply fails with "This post is gone from Discord."; for an edit or a delete the message goes from
 *   the store and the entry is done. A part of a reply that an edit finds deleted in Discord takes the whole reply with it
 *   (the other parts are deleted through the webhook), as when the gateway says a part was deleted.
 */
import { Upstream } from './discordRoles.js'
import { DEFAULT_FORM, FORMS, placement, toDiscord } from './librariusForm.js'
import { parseMessage, snowflakeTime } from './librariusParse.js'
import { describe, isId } from './librariusText.js'
import { WebhookError, sendBody } from './librariusWebhook.js'

const SPACING_MS = 1500
const CEILING = 20
const CEILING_WINDOW_MS = 60_000
const BREAKER_BLOCKS = 2
const BREAKER_WINDOW_MS = 3_600_000
const BREAKER_PAUSE_MS = 3_600_000
const LADDER_MS = [5_000, 30_000, 120_000, 600_000]
const STORE_RETRY_MS = 5_000
// How long a worker that did not get the lock waits to ask again.
const LOCK_RETRY_MS = 30_000
// Discord may take a moment to show a message it has made: a look for a send that may have landed waits until this long after the send began,
// and reads the thread from this long before it began.
const LOOK_WAIT_MS = 5_000
const LOOK_MARGIN_MS = 5_000
// When a send that was interrupted does not say when it began, the look goes back this far.
const LOOK_FALLBACK_MS = 3_600_000
const LOOK_PAGE = 100
const DISCORD_EPOCH_MS = 1420070400000
// A longer wait than this is waited in steps, since a timer holds 24 days at most.
const MAX_WAKE_MS = 3_600_000
const ARCHIVED_CODE = 50083
const CONTENT_MAX = 4000
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

const STORE_METHODS = [
  'takeWorkerLock',
  'releaseWorkerLock',
  'outboxHold',
  'noteBlock',
  'sendTimesSince',
  'outboxInterrupted',
  'claimOutbox',
  'outboxNextAt',
  'outboxProgress',
  'outboxSet',
  'finishSend',
  'finishEdit',
  'finishDelete',
  'outboxMessage',
  'uploadsFor',
  'knownPartIds',
  'blockedSince',
]

// What a member is told. The first six are the ones the plan words.
export const COPY = Object.freeze({
  threadGone: 'This post is gone from Discord.',
  locked: 'This post is locked in Discord.',
  pictures: "That edit would move or change a picture. Pictures can't be changed after sending: delete the reply and post it again.",
  tooLong: "That's longer than Discord can carry in 3 messages.",
  uploadsGone: 'A picture of this reply is no longer held. Post it again.',
  messageGone: 'This reply is no longer there.',
  notSite: 'Only replies written on the site can be edited here.',
  olderWebhook: "This reply was sent through an older webhook, so it can't be edited from the site. Delete it and post it again.",
  unsendable: 'This reply could not be sent.',
})
const NOUN = { send: 'reply', edit: 'edit', delete: 'delete' }
const PART_DELETED = 'A part was deleted in Discord.'

/** Thrown to say a stop was asked for: the entry is left as it is, for the next start to resume. */
class Halt extends Error {}

/** Thrown for an entry that cannot succeed, with what the member is told. */
class Refusal extends Error {}

/** → the text of a message of Discord as the form made it: a plain message's content, or a V2 message's text displays. */
function textOf(message) {
  if (typeof message.content === 'string' && message.content !== '') return message.content
  const texts = []
  const walk = (components) => {
    for (const component of Array.isArray(components) ? components : []) {
      if (typeof component?.content === 'string') texts.push(component.content)
      walk(component?.components)
    }
  }
  walk(message.components)
  return texts.join('\n')
}

/** → at most CONTENT_MAX characters of the source, never cutting a pair. */
const contentOf = (source) => Array.from(source).slice(0, CONTENT_MAX).join('')

/** → the snowflake of a time (ms), as text: what messagesAfter reads from. A time before Discord's epoch is the start. */
const snowflakeAt = (ms) => String(BigInt(Math.max(ms - DISCORD_EPOCH_MS, 0)) << 22n)

export function createOutbox({ store, webhook, discord, form = DEFAULT_FORM, guildId, now = Date.now, timers, log = console.error }) {
  for (const name of STORE_METHODS) if (typeof store?.[name] !== 'function') throw new TypeError(`store.${name} must be a function.`)
  for (const name of ['send', 'edit', 'remove']) if (typeof webhook?.[name] !== 'function') throw new TypeError(`webhook.${name} must be a function.`)
  if (!isId(webhook.id)) throw new TypeError('webhook.id must be a Discord id.')
  for (const name of ['setArchived', 'deleteMessage', 'messagesAfter']) if (typeof discord?.[name] !== 'function') throw new TypeError(`discord.${name} must be a function.`)
  if (!FORMS.includes(form)) throw new TypeError('form must be "v2" or "plain".')
  if (!isId(guildId)) throw new TypeError('guildId must be a Discord id.')
  if (typeof now !== 'function') throw new TypeError('now must be a function.')
  if (typeof log !== 'function') throw new TypeError('log must be a function.')
  // Looked up when it is used, so that a test's fake timers, installed after this is made, still count.
  const clock = timers ?? { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args) }
  for (const name of ['setTimeout', 'clearTimeout']) if (typeof clock[name] !== 'function') throw new TypeError(`timers.${name} must be a function.`)

  // Stryker disable next-line ArrowFunction,StringLiteral: what is logged is for the owner to read, and no test asserts it
  const report = (text) => log(`Librarius outbox: ${text}`)

  let started = false
  // Whether this worker has said that another one holds the lock: it says it once.
  let told = false
  // Set when the worker starts: whether it is being stopped, whether it has read what the store keeps, and whether a kick came
  // while it was working.
  let stopping
  let ready
  let again
  let running = null
  let wake = null
  // The entries a stop left half-done, read when the worker starts.
  let resumeQueue
  let refused = null
  // When the last webhook call ended (set when the worker starts), when a global 429 lets them go on, and until when the breaker has stopped everything.
  let lastCallAt
  let globalUntil = 0
  let pausedUntil = 0
  // The times of the last CEILING sends that landed, and of the blocks that count towards the breaker.
  // Stryker disable next-line ArrayDeclaration: initialise empties it before anything reads it
  const sends = []
  // Stryker disable next-line ArrayDeclaration: a text among the times is dropped by the first filter, as no time is within an hour of it
  let blocks = []
  const sleeping = new Set()

  /**
   * The breaker: a block at time `t` counts, and the second within an hour pauses everything for an hour. → the time it now pauses until
   * when this block tripped it, else null, for the caller to write down with the block: a pause that a restart forgets is no pause.
   */
  function noteBlockAt(t) {
    blocks = blocks.filter((b) => t - b < BREAKER_WINDOW_MS)
    blocks.push(t)
    if (blocks.length < BREAKER_BLOCKS) return null
    pausedUntil = Math.max(pausedUntil, t + BREAKER_PAUSE_MS)
    blocks.length = 0
    return pausedUntil
  }

  /** Waits `ms`, unless stop() is called, which ends the wait with a Halt. */
  function sleep(ms) {
    return new Promise((resolve, reject) => {
      const waiter = {}
      const timer = clock.setTimeout(() => {
        sleeping.delete(waiter)
        resolve()
      }, ms)
      waiter.cancel = () => {
        clock.clearTimeout(timer)
        sleeping.delete(waiter)
        reject(new Halt())
      }
      sleeping.add(waiter)
    })
  }

  function checkpoint() {
    if (stopping) throw new Halt()
  }

  /** How long a send must wait: the 20th send before it must be a minute old. */
  const ceilingWait = () => (sends.length < CEILING ? 0 : sends[0] + CEILING_WINDOW_MS - now())

  /** Makes one webhook call, when the limits allow it: spaced from the last call, outside a global 429, and for a send within the ceiling. */
  async function paced(call, isSend = false) {
    for (;;) {
      checkpoint()
      const t = now()
      const wait = Math.max(lastCallAt + SPACING_MS - t, globalUntil - t, isSend ? ceilingWait() : 0)
      if (wait <= 0) break
      await sleep(wait)
    }
    try {
      const out = await call()
      if (isSend) landed()
      return out
    } catch (err) {
      // A send that may have landed counts as one that did: the ceiling is for what Discord may have taken.
      if (isSend && err instanceof WebhookError && err.unknown) landed()
      throw err
    } finally {
      lastCallAt = now()
    }
  }

  /** A send ended, and may have made a message: it is counted, as of now. */
  function landed() {
    sends.push(now())
    if (sends.length > CEILING) sends.shift()
  }

  /** Makes a call to a thread. A thread that is archived is unarchived, once, and the call made again. */
  async function inThread(ctx, call) {
    try {
      return await call()
    } catch (err) {
      if (!(err instanceof WebhookError) || err.code !== ARCHIVED_CODE || ctx.unarchived) throw err
      if (!(await discord.setArchived(ctx.threadId, false))) throw new Refusal(COPY.locked)
      ctx.unarchived = true
      return call()
    }
  }

  const sendCall = (ctx, body, files) => inThread(ctx, () => paced(() => webhook.send(ctx.threadId, body, files), true))
  const editCall = (ctx, messageId, body) => inThread(ctx, () => paced(() => webhook.edit(ctx.threadId, messageId, body)))
  const removeCall = (ctx, messageId) => inThread(ctx, () => paced(() => webhook.remove(ctx.threadId, messageId)))

  const urlBase = (threadId) => `https://discord.com/channels/${guildId}/${threadId}`

  /** → the progress notes of an entry, made when it has none. They are changed in place, and written whole. */
  function progressOf(entry) {
    entry.payload.progress ??= { form: null, parts: [], inflight: null }
    return entry.payload.progress
  }

  const save = (entry) => store.outboxProgress(entry.id, entry.payload.progress)

  /**
   * Does a call to Discord once for the entry, however often the entry is run again: a call that is done is written down
   * (progress.done) when it is, so that a run after a failure of the store, or a try of the ladder, or a restart goes on from there.
   */
  async function once(entry, key, call) {
    const progress = progressOf(entry)
    progress.done ??= []
    if (progress.done.includes(key)) return
    await call()
    progress.done.push(key)
    await save(entry)
  }

  /**
   * → the message of the webhook `hook` in the thread that is this part, or null: its text, and not taken by a reply already. A part's
   * text names the part before it (its link back), so no part can match another of the reply, nor one of another reply. The look
   * waits until `settleAt` (ms), so that Discord has had the time to show a message it made, and then reads the thread from just before
   * `startedAt`, when the send began: the messages after that, and not the newest few, which a busy thread would have pushed it out of.
   */
  async function lookup(ctx, text, { hook, startedAt, settleAt }) {
    const wait = settleAt - now()
    // Stryker disable next-line EqualityOperator: a wait of nothing is the same as no wait
    if (wait > 0) await sleep(wait)
    const page = await discord.messagesAfter(ctx.threadId, snowflakeAt(startedAt - LOOK_MARGIN_MS), LOOK_PAGE)
    const ours = page.filter((m) => m?.webhook_id === hook)
    const taken = await store.knownPartIds(ours.map((m) => m.id))
    // The newest of those that match: a message of an earlier try of ours that is no part is older.
    return ours.findLast((m) => !taken.has(m.id) && textOf(m).trim() === text) ?? null
  }

  /**
   * Sends part `index` of a reply, or finds it already in Discord, and writes down its id. `known` is the ids of the parts
   * before it, and it gets this one's.
   */
  async function sendPart(entry, ctx, { index, known, built, body, files }) {
    const progress = progressOf(entry)
    const adopt = (message) => {
      progress.parts.push({ id: message.id, at: message.timestamp ?? null, attachments: message.attachments })
      progress.inflight = null
      known.push(message.id)
      return save(entry)
    }
    // The part's start time and its webhook: what the look needs, and what a restart must be able to read.
    const look = (settleAt) => ({ hook: progress.webhookId ?? webhook.id, startedAt: progress.inflightAt ?? now() - LOOK_FALLBACK_MS, settleAt })
    if (progress.inflight === index) {
      // The part may have landed before a stop: look before sending, once Discord has had its time to show it.
      const found = await lookup(ctx, built.text, look((progress.inflightAt ?? 0) + LOOK_WAIT_MS))
      if (found !== null) return adopt(found)
    }
    // Written down before the send, every time: what is in memory may be a note the store never took.
    progress.inflight = index
    progress.inflightAt = now()
    progress.webhookId ??= webhook.id
    await save(entry)
    for (let sent = 0; ; sent++) {
      try {
        return await adopt(await sendCall(ctx, body, files))
      } catch (err) {
        // Only a send that may have landed is looked for. It is looked for after every one, the second too: no attempt may come after
        // this one to look, and a part that is found is adopted, so that an end for good removes it with the rest. It is sent again once.
        if (!(err instanceof WebhookError) || !err.unknown) throw err
        const found = await lookup(ctx, built.text, look(now() + LOOK_WAIT_MS))
        if (found !== null) return adopt(found)
        if (sent === 1) throw err
      }
    }
  }

  /** The picture file names a reply's uploads are sent under: the same for every part, so that a part can name the pictures it carries. */
  const pictureName = (ref, type) => `picture-${ref}.${EXTENSIONS[type]}`

  async function heldUploads(entry, p) {
    const held = await store.uploadsFor(entry.authorId, p.uploads)
    if (held.length !== p.uploads.length) throw new Refusal(COPY.uploadsGone)
    return held
  }

  const bodyOf = (useForm, built, p) => sendBody({ form: useForm, part: built, username: p.username, avatarUrl: p.avatarUrl, mentionIds: p.mentions })

  /**
   * Whether an error of the edit that adds the links forward to a reply's first part means the reply is done without them: the
   * parts are in Discord already, and the links are a nicety, so Discord's refusing them (a block, or a locked thread) is no
   * reason to lose the reply, and the other failures are tried again like any, until the last try. What has a meaning of its own
   * (the webhook refused, a limit of Discord's, the thread gone) is not swallowed on the last try, but goes up to be decided
   * as it is for any call.
   */
  const linksLost = (entry, err) => {
    if (err instanceof WebhookError) {
      if (err.blocked || err.status === 403) return true
      if (err.fatal || err.status === 429 || err.threadGone) return false
    }
    // The last try, and a stop is not a failure.
    return !(err instanceof Halt) && entry.attempts >= LADDER_MS.length
  }

  async function runSend(entry, ctx) {
    const p = entry.payload
    const progress = progressOf(entry)
    const useForm = progress.form ?? form
    progress.form = useForm
    // The pictures are read when a part has to carry one, and their names are written down with the first part sent: a run after
    // the last part is in Discord needs no picture.
    let held = null
    const uploadsOf = async () => (held ??= await heldUploads(entry, p))
    progress.images ??= (await uploadsOf()).map((upload, i) => ({ ref: i + 1, name: pictureName(i + 1, upload.contentType) }))
    const { images } = progress
    const options = (partIds) => ({ form: useForm, authorId: entry.authorId, replyTo: p.replyTo, siteUrl: p.siteUrl, images, thread: { urlBase: urlBase(p.postId), partIds } })
    const filesOf = async (built) => {
      if (built.files.length === 0) return []
      const uploads = await uploadsOf()
      return built.files.map((name) => {
        const upload = uploads[images.findIndex((image) => image.name === name)]
        return { name, type: upload.contentType, bytes: upload.bytes }
      })
    }
    const plan = toDiscord(p.source, options([]))
    if (plan.overBudget) throw new Refusal(COPY.tooLong)
    const n = plan.parts.length
    // Every part is built and checked before the first is sent: a reply that cannot go fails before any of it is in Discord.
    for (const built of plan.parts) bodyOf(useForm, built, p)
    if (progress.webhookId !== undefined && progress.webhookId !== webhook.id) await startOver(entry, ctx, (landedIds) => toDiscord(p.source, options(landedIds)).parts)
    const known = progress.parts.map((part) => part.id)
    for (const built of plan.parts.slice(known.length)) await filesOf(built)
    for (let index = known.length; index < n; index++) {
      const built = toDiscord(p.source, options(known)).parts[index]
      await sendPart(entry, ctx, { index, known, built, body: bodyOf(useForm, built, p), files: await filesOf(built) })
    }
    if (n > 1 && progress.linked === undefined) {
      const first = toDiscord(p.source, options(known)).parts[0]
      let blocked = false
      let pause = null
      try {
        await editCall(ctx, known[0], bodyOf(useForm, first, p))
        progress.linked = true
      } catch (err) {
        // The first part was deleted in Discord, so the reply goes with it.
        if (err instanceof WebhookError && err.messageGone) return purge(entry, ctx, known[0], known, PART_DELETED)
        if (!linksLost(entry, err)) throw err
        progress.linked = false
        blocked = err instanceof WebhookError && err.blocked
        if (blocked) pause = noteBlockAt(now())
      }
      await save(entry)
      // A block of Discord's is noted, with the pause it may have caused, as any other is: the reply is stored without its links, and a restart must still know.
      if (blocked) await store.noteBlock(entry.id, { event: { action: 'blocked', postId: p.postId, messageId: known[0], note: 'links' }, hold: pause === null ? undefined : { pausedUntil: pause } })
    }
    const [head] = progress.parts
    const attachments = parseMessage({ id: head.id, channel_id: p.postId, type: 0, author: { id: entry.authorId }, attachments: progress.parts.flatMap((part) => part.attachments) }).attachments
    const done = await store.finishSend(entry.id, {
      message: {
        id: head.id,
        postId: p.postId,
        authorId: entry.authorId,
        authorName: p.username,
        authorAvatar: p.avatarUrl,
        webhookId: webhook.id,
        content: contentOf(p.source),
        replyTo: p.replyTo === null ? null : p.replyTo.messageId,
        createdAt: head.at ?? snowflakeTime(head.id),
        source: p.source,
        layout: { form: useForm, replyTo: p.replyTo, siteUrl: p.siteUrl, username: p.username, avatarUrl: p.avatarUrl, images },
        attachments,
      },
      partIds: known,
      uploadIds: p.uploads,
      event: { action: 'send', postId: p.postId, messageId: head.id, note: `${n} ${n === 1 ? 'part' : 'parts'}${progress.linked === false ? ', no links' : ''}` },
    })
    if (done.stored) return
    // Nothing is stored. With no list of lost parts the post is not stored, and the reply is failed (what landed is removed with
    // it); a part that was deleted in Discord meanwhile takes the reply with it, and the rest of it is removed.
    if (done.gone === null) throw new Refusal(COPY.threadGone)
    return purge(entry, ctx, known[0], known.filter((id) => !done.gone.includes(id)), PART_DELETED)
  }

  /**
   * A reply that was begun through a webhook that is not this one (the address was made again): what it sent is removed through the bot,
   * which may delete any message, and the reply begins again from its first part. `partsFor(ids)` → the parts of the reply, cut as they
   * were with `ids` sent, for the text of the part that may be in Discord without the worker knowing its id: it is looked for among the
   * old webhook's messages, as a send that may have landed is, and removed with the rest.
   */
  async function startOver(entry, ctx, partsFor) {
    const progress = progressOf(entry)
    const old = progress.parts.map((part) => part.id)
    if (progress.inflight !== null) {
      const found = await lookup(ctx, partsFor(old)[progress.inflight].text, { hook: progress.webhookId, startedAt: progress.inflightAt ?? now() - LOOK_FALLBACK_MS, settleAt: (progress.inflightAt ?? 0) + LOOK_WAIT_MS })
      if (found !== null) old.push(found.id)
    }
    for (const id of old) await once(entry, `bot:${id}`, () => discord.deleteMessage(ctx.threadId, id))
    progress.parts = []
    progress.inflight = null
    progress.webhookId = webhook.id
    delete progress.inflightAt
    delete progress.linked
    await save(entry)
  }

  /**
   * The message goes from the store, and so do its parts from Discord (the ones left): an edit or a delete that finds it gone ends there.
   * `byBot` removes them through the bot, for parts of a webhook that is not this one.
   */
  async function purge(entry, ctx, messageId, partIds, note, byBot = false) {
    for (const id of partIds) await once(entry, `remove:${id}`, () => (byBot ? discord.deleteMessage(ctx.threadId, id) : removeCall(ctx, id)))
    await store.finishDelete(entry.id, { messageId, partIds, event: { action: 'delete', postId: ctx.threadId, messageId, note } })
  }

  async function runEdit(entry, ctx) {
    const p = entry.payload
    const message = await store.outboxMessage(entry.messageKey)
    if (message === null) throw new Refusal(COPY.messageGone)
    if (message.origin !== 'site') throw new Refusal(COPY.notSite)
    // Discord lets a webhook edit only its own messages: a reply of another one (the address was made again) is not edited here.
    if (message.webhookId !== webhook.id) throw new Refusal(COPY.olderWebhook)
    // A restore says nothing of the text: it is what the store has.
    const source = p.restore === true ? message.source : p.source
    const { layout } = message
    const base = { form: layout.form, authorId: message.authorId, replyTo: layout.replyTo, siteUrl: layout.siteUrl, images: layout.images }
    const options = (partIds) => ({ ...base, thread: { urlBase: urlBase(p.postId), partIds } })
    // Pictures are fixed when a reply is sent: an edit may change the words, never where the pictures fall.
    if (JSON.stringify(placement(message.source, base)) !== JSON.stringify(placement(source, base))) throw new Refusal(COPY.pictures)
    const progress = progressOf(entry)
    const existing = message.parts
    const known = [...existing, ...progress.parts.map((part) => part.id)]
    const plan = toDiscord(source, options(known))
    if (plan.overBudget) throw new Refusal(COPY.tooLong)
    const wanted = plan.parts.length
    const body = (built) => bodyOf(layout.form, built, { username: layout.username, avatarUrl: layout.avatarUrl, mentions: p.mentions })
    let done
    try {
      for (let i = 0; i < Math.min(existing.length, wanted); i++) await once(entry, `edit:${existing[i]}`, () => editCall(ctx, existing[i], body(plan.parts[i])))
      for (let index = known.length; index < wanted; index++) {
        // A part that is new carries no file: placement() of the new text is the old one, so no picture falls in it.
        const built = toDiscord(source, options(known)).parts[index]
        await sendPart(entry, ctx, { index, known, built, body: body(built), files: [] })
      }
      for (let i = wanted; i < existing.length; i++) await once(entry, `remove:${existing[i]}`, () => removeCall(ctx, existing[i]))
      // A reply that grew has its first part edited last, to carry the links forward. (A conditional expression, not an `if` with no else: V8 gives
      // an implicit else no counter of its own, and the coverage report works it out by subtraction from counts that an `await` makes swing.)
      await (wanted > existing.length ? once(entry, 'links', () => editCall(ctx, known[0], body(toDiscord(source, options(known)).parts[0]))) : undefined)
      done = await store.finishEdit(entry.id, {
        messageId: message.id,
        source,
        content: contentOf(source),
        partIds: known.slice(0, wanted),
        event: { action: 'edit', postId: p.postId, messageId: message.id, note: `${wanted} ${wanted === 1 ? 'part' : 'parts'}` },
      })
    } catch (err) {
      if (!(err instanceof WebhookError) || !err.messageGone) {
        // The edit may have changed Discord, and the store may not have heard of it: if it ends for good, the message is put back as the store has it.
        entry.touched = true
        throw err
      }
      // A part was deleted in Discord: the reply goes, all of it.
      return purge(entry, ctx, message.id, known, PART_DELETED)
    }
    // Not stored: a part was deleted in Discord while the edit was on its way, or the message is gone. The reply goes, all of it, with the parts the edit added.
    if (!done.stored) return purge(entry, ctx, message.id, known.filter((id) => !done.gone.includes(id)), PART_DELETED)
  }

  async function runDelete(entry, ctx) {
    const p = entry.payload
    const progress = progressOf(entry)
    const message = await store.outboxMessage(entry.messageKey)
    if (message !== null && message.origin === 'discord') {
      await once(entry, 'bot', () => discord.deleteMessage(p.postId, message.id))
      return purge(entry, ctx, message.id, [], null)
    }
    if (progress.partIds === undefined) {
      // What to remove is written down first: the store's parts go with the message, and a restart must not lose them.
      progress.partIds = p.partIds ?? (message === null ? [] : message.parts)
      await save(entry)
    }
    // The parts of another webhook (one that was replaced) are removed through the bot: this webhook may not delete them.
    const sentBy = p.webhookId ?? message?.webhookId ?? null
    return purge(entry, ctx, entry.messageKey, progress.partIds, null, sentBy !== null && sentBy !== webhook.id)
  }

  const RUN = { send: runSend, edit: runEdit, delete: runDelete }

  /**
   * → the entries to queue with an entry that ended for good, so that it leaves nothing of itself in Discord: a delete of the
   * parts it sent (a reply's, or the ones an edit added), and, for an edit that may have changed the parts there already, an edit
   * that puts the message back as the store has it. They are written in the same transaction as the end of the entry. The message
   * stays 'sending' until the restore is done, so that no other edit of it is taken meanwhile.
   */
  function leftovers(entry) {
    const { postId } = entry.payload
    const landed = (entry.payload.progress?.parts ?? []).map((part) => part.id)
    const queue = []
    // An edit may have changed what is in Discord when it ran into trouble this time (touched), or when it ran before (attempts). A restore is not restored.
    if (entry.kind === 'edit' && entry.payload.restore !== true && (entry.touched === true || entry.attempts > 0)) {
      queue.push({ kind: 'edit', messageKey: entry.messageKey, payload: { postId, mentions: [], restore: true } })
    }
    if (landed.length > 0) queue.push({ kind: 'delete', messageKey: landed[0], payload: { postId, partIds: landed, webhookId: entry.payload.progress.webhookId } })
    return queue
  }

  /** → what to write for an entry that ended for good in `state` ('failed' or 'blocked'): the member's words, and what puts Discord right. */
  function endFor(entry, state, error, event, hold) {
    const queue = leftovers(entry)
    const messageState = state === 'blocked' ? 'blocked' : null
    return () => store.outboxSet(entry.id, { state, error, messageState, queue, hold, event: { ...event, postId: entry.payload.postId, messageId: entry.kind === 'send' ? null : entry.messageKey } })
  }

  /** The entry cannot be done, and the member is told why. */
  const fail = (entry, error) => endFor(entry, 'failed', error, { action: 'failed', note: error })

  /**
   * → what to write to the store for an entry that stopped on `err`: a function, which the worker runs, and runs again if the
   * store fails under it, without doing any of the entry's work over. What it decides of the worker itself (the breaker, a
   * global 429, a refused webhook) is decided here, once.
   */
  function settle(entry, err) {
    // A stop is not a failure: the entry is left as it is.
    if (err instanceof Halt) throw err
    if (err instanceof Refusal) return fail(entry, err.message)
    if (err instanceof TypeError || err instanceof RangeError) {
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      report(`entry ${entry.id} cannot be sent: ${describe(err)}`)
      return fail(entry, COPY.unsendable)
    }
    if (err instanceof WebhookError) {
      const decided = webhookOutcome(entry, err)
      if (decided !== null) return decided
    }
    // Anything else may pass: tried again after a wait, and failed when the waits are used up. That holds for what is not of
    // Discord's too (the store failing under this entry): an entry that fails again and again is not tried for ever.
    const attempts = entry.attempts + 1
    if (attempts > LADDER_MS.length) return fail(entry, err instanceof WebhookError || err instanceof Upstream ? `Discord did not take this ${NOUN[entry.kind]}. Try again in a little while.` : COPY.unsendable)
    const nextAt = now() + LADDER_MS[attempts - 1]
    // Stryker disable next-line StringLiteral: what is stored is for the owner to read
    return () => store.outboxSet(entry.id, { state: 'pending', attempts, nextAt, error: describe(err) })
  }

  /** → what to write for an entry that stopped on a refusal of the webhook that has a meaning of its own, or null when it has none. */
  function webhookOutcome(entry, err) {
    if (err.fatal) {
      refused = { status: err.status, text: `The Librarius webhook was refused (status ${err.status}): create it again with librariusWebhookSetupRun.` }
      report(refused.text)
      // The entry is not lost: it goes on when the webhook is made again and the site restarted.
      return () => store.outboxSet(entry.id, { state: 'pending' })
    }
    if (err.blocked) {
      // The pause the block may have caused is written with it, in one transaction.
      const pause = noteBlockAt(now())
      return endFor(entry, 'blocked', `Discord blocked this ${NOUN[entry.kind]}.`, { action: 'blocked', note: entry.kind }, pause === null ? undefined : { pausedUntil: pause })
    }
    if (err.status === 429) {
      const nextAt = now() + err.retryAfterMs
      if (err.global) globalUntil = Math.max(globalUntil, nextAt)
      // A global limit holds every call of the webhook, and a restart must not forget it.
      return () => store.outboxSet(entry.id, { state: 'pending', nextAt, hold: err.global ? { globalUntil } : undefined })
    }
    // The thread is locked (or the webhook may not write in it): no wait changes that.
    if (err.status === 403) return fail(entry, COPY.locked)
    if (err.threadGone) {
      if (entry.kind === 'send') return fail(entry, COPY.threadGone)
      // The parts of the message go with it (the store knows them by the message), and nothing is left in Discord to remove.
      return () => purge(entry, { threadId: entry.payload.postId }, entry.messageKey, [], COPY.threadGone)
    }
    return null
  }

  async function process(entry) {
    // What was decided for this entry, when the store failed under the write of it.
    if (entry.settling !== undefined) return entry.settling()
    const ctx = { threadId: entry.payload.postId, unarchived: false }
    try {
      await RUN[entry.kind](entry, ctx)
    } catch (err) {
      entry.settling = settle(entry, err)
      await entry.settling()
    } finally {
      // The thread is left as it was found.
      if (ctx.unarchived) {
        // Stryker disable next-line ArrowFunction,StringLiteral: what is logged is for the owner to read, and no test asserts it
        await discord.setArchived(ctx.threadId, true).catch((err) => report(`a post could not be archived again: ${describe(err)}`))
      }
    }
  }

  function schedule(delay) {
    clock.clearTimeout(wake)
    wake = clock.setTimeout(
      () => {
        wake = null
        kick()
      },
      Math.min(Math.max(delay, 0), MAX_WAKE_MS),
    )
  }

  /**
   * Takes the lock, and reads what only the store knows, again at each start: the pause and the global hold that were in force, the sends of the
   * last minute, the blocks of the last hour, and the entries a stop left half-done. → false when another worker holds the lock: this one does not send.
   */
  async function initialise() {
    if (!(await store.takeWorkerLock())) {
      if (!told) {
        told = true
        report('another worker holds the outbox, so this one does not send.')
      }
      return false
    }
    const t = now()
    const held = await store.outboxHold()
    const lately = await store.sendTimesSince(t - CEILING_WINDOW_MS)
    const blocked = await store.blockedSince(t - BREAKER_WINDOW_MS)
    const left = await store.outboxInterrupted()
    pausedUntil = held.pausedUntil === null ? 0 : Date.parse(held.pausedUntil)
    globalUntil = held.globalUntil === null ? 0 : Date.parse(held.globalUntil)
    sends.length = 0
    sends.push(...lately.slice(-CEILING).map((at) => Date.parse(at)))
    // Stryker disable next-line ArrayDeclaration: a text among the times is dropped by the first filter, as no time is within an hour of it
    blocks = []
    // Blocks of the last hour only: a pause is kept as it was, so no older block is needed to find it again.
    for (const at of blocked) noteBlockAt(Date.parse(at))
    resumeQueue = left
    // A call may have gone out just before the stop or the crash: the first one waits its time.
    lastCallAt = t
    ready = true
    return true
  }

  /** Works through what is due, and sets a timer for what is not yet. Never rejects. */
  async function pass() {
    try {
      if (!ready && !(await initialise())) return schedule(LOCK_RETRY_MS)
      while (!stopping && refused === null) {
        const wait = pausedUntil - now()
        if (wait > 0) return schedule(wait)
        const entry = resumeQueue.shift() ?? (await store.claimOutbox(now()))
        if (entry === null) break
        try {
          await process(entry)
        } catch (err) {
          // The store failed under it (not Discord): it is tried again, and what it had written down is still in memory.
          resumeQueue.unshift(entry)
          throw err
        }
      }
      if (stopping || refused !== null) return
      const next = await store.outboxNextAt()
      if (next !== null) schedule(Date.parse(next) - now())
    } catch (err) {
      if (err instanceof Halt) return
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      report(`the store failed: ${describe(err)}`)
      schedule(STORE_RETRY_MS)
    }
  }

  async function pump() {
    do {
      again = false
      await pass()
    } while (again)
  }

  function kick() {
    if (!started || stopping) return
    if (running !== null) {
      again = true
      return
    }
    running = pump().finally(() => {
      running = null
    })
  }

  return {
    start() {
      if (started) return
      started = true
      stopping = false
      ready = false
      kick()
    },

    async stop() {
      stopping = true
      clock.clearTimeout(wake)
      wake = null
      for (const waiter of [...sleeping]) waiter.cancel()
      await running
      started = false
      // Another worker may take the lock now, and this one may start again.
      // Stryker disable next-line ArrowFunction,StringLiteral: what is logged is for the owner to read, and no test asserts it
      await store.releaseWorkerLock().catch((err) => report(`the lock could not be let go: ${describe(err)}`))
    },

    kick,

    sendingPausedUntil: () => (pausedUntil > now() ? pausedUntil : null),

    webhookRefused: () => refused,

    webhookId: webhook.id,
  }
}
