/**
 * Postgres side of the Librarius's outbox (batch 2): what the site sends to Discord, and the messages it made there. It
 * is the part of the store that librariusOutbox.js and the gateway ingest write through; librariusStore.js hands it out
 * with the rest, as one store. The tables are librarius_outbox, librarius_parts, librarius_uploads and librarius_events,
 * and the columns a site message adds to librarius_messages (origin, source, state, layout), all in schema.sql.
 *
 * Ids are strings, as in librariusStore.js: a Discord snowflake is 17 to 20 digits that fit a bigint, and the id of an outbox
 * row or of an upload (a bigserial) is 1 to 19 digits that do. Any other id, list or shape is a TypeError before any query.
 * Every caller value goes in as a $n parameter, and each method that writes more than one row does it in one transaction,
 * so that a restart never finds half of what it did.
 *
 * An outbox entry is { id, kind: 'send' | 'edit' | 'delete', messageKey, authorId, payload, attempts }. Its state is
 * 'pending' (waiting for next_at), 'sending' (the worker has it), and then 'sent' (done), 'blocked' (Discord refused it for
 * good) or 'failed'. `payload` is what the route made of the request, plus `payload.progress`, the worker's notes of what it
 * has already done to Discord: that is what a restart resumes from.
 *
 * enqueueOutbox({ kind, messageKey, authorId, payload }) → { id }. The payload must name its post (`postId`). For an edit or
 * a delete the key is the id of the message, whose state becomes 'sending' with the entry (and a new rev, so a reader
 * learns of it). For a reply it is the random key the route made.
 * outboxInterrupted() → the entries left 'sending' by a stop or a crash, oldest first.
 * claimOutbox(now) → the oldest entry that is due at `now` (a Date, ISO text or epoch milliseconds), now 'sending', or null.
 * outboxNextAt() → when the next pending entry is due, as ISO text, or null.
 * outboxProgress(id, progress) → writes payload.progress of an entry that is 'sending'.
 * outboxSet(id, { state, attempts, nextAt, error, messageState, event, queue }) → one transition of an entry that is 'sending'
 *   (an entry in any other state is left as it is, and nothing else is written: a write that was made once is not made again),
 *   with what goes with it: `state` is 'pending', 'sent', 'blocked' or 'failed'; `attempts` and `nextAt` are left as they are
 *   when not given; `error` (null for none) is last_error, cut to 500 characters; `messageState` (null, 'sending' or
 *   'blocked'), when given, is set on the message an edit or a delete names; `event` is { action, postId, messageId, note },
 *   noted with the entry's author; `queue` (at most 2) is the entries to queue in the same transaction, as { kind: 'edit' |
 *   'delete', messageKey, payload }, for the entry's author: what puts Discord right after an entry that ended for good (the
 *   parts of a reply that never finished, an edit put back). An edit or a delete queued puts its message in the state
 *   'sending', as enqueueOutbox does.
 * finishSend(id, { message, partIds, uploadIds, event }) → { stored, gone }. The reply is done, in one transaction: the other
 *   parts of it that an import stored as messages of their own are deleted, the message is stored (origin 'site', with its
 *   attachments), its parts are written, its uploads (the author's) are deleted, the event is noted and the entry is 'sent';
 *   `stored` is true, and an entry that was not 'sending' any more (it was done by a write that committed, whose answer was
 *   lost) is left alone, and answers true too. Nothing is written, and `stored` is false, when `gone` lists parts that Discord
 *   was told of as deleted while the reply was on its way (siteDeleted noted them in the entry), or, with `gone` null, when the
 *   reply's post is not stored: the caller deals with what is in Discord.
 * finishEdit(id, { messageId, source, content, partIds, event }) → { stored, gone }: an edit is done, in one transaction: the
 *   message has its new source and content, its edit time and no state, its parts are the new list, and the entry is 'sent'.
 *   As for finishSend, an entry that is not 'sending' is left alone (`stored` true); nothing is written, and `stored` is false,
 *   for parts noted as deleted in Discord (`gone`), and, with `gone` empty, for a message that is not there any more: it is not
 *   brought back.
 * finishDelete(id, { messageId, partIds, event }) → a delete is done, in one transaction: the message is deleted, noted in the
 *   tombstones for the readers, and its parts are forgotten, and the entry is 'sent'. An entry that is not 'sending' is left
 *   alone.
 * outboxMessage(messageId) → the message a worker acts on, or null: { id, postId, authorId, authorName, authorAvatar, origin,
 *   source, layout, state, parts: [the Discord ids of its parts, in order] }.
 * uploadsFor(authorId, ids) → [{ id, name, contentType, bytes }] for those of the author's uploads that are still held, in the
 *   order of `ids`; one that is gone is left out.
 * addUpload({ authorId, name, contentType, bytes }) → { id }: holds a picture, already judged and stripped (librariusUploads.js), for
 *   its author until a reply sends it or the sweep finds it old. `name` is 1 to 100 characters, `contentType` one of the four
 *   types of picture, `bytes` a Uint8Array of at least one byte.
 * heldUploadIds(authorId, ids) → the Set of those of `ids` (up to 50) that the author still holds, without reading a picture.
 * outboxFor(authorId, postId, since) → the author's entries for a post that are not done, made since `since`, the newest 20,
 *   oldest first, as { key, kind, state, error, source, createdAt }: `key` is the entry's message key (a reply's random key, or
 *   the id of the message an edit or a delete is for), `state` the entry's ('pending', 'sending', 'blocked' or 'failed'), `error`
 *   its last error (what the member is told once it is 'blocked' or 'failed', a technical text while it is tried again) and
 *   `source` the text of a reply (null for an edit or a delete). It is the member's own entries only.
 * sweepUploads({ olderThan }) → how many pictures it deleted: those held since before `olderThan`, and those that a reply that
 *   ended for good ('failed' or 'blocked') named, of any age, except any that a reply still on its way ('pending' or 'sending')
 *   names, of any age: that reply sends them, held up by the breaker's pause or not, and finishSend deletes them after.
 * knownPartIds(ids) → the Set of those ids that are parts of a stored reply.
 * messageOfPart(id) → the id of the reply that a part belongs to, or `id` when it is no part of one: where a reaction lands.
 * siteDeleted(ids, postId) → { plain }: for those of `ids` that are parts of a reply of the site, the whole reply goes: its
 *   message is deleted (and noted in the tombstones), its parts are forgotten, and a delete of the parts that are left is
 *   queued, unless a delete that knows what to remove (payload.partIds or progress.partIds) is on its way already. (A delete
 *   from the site's own route does not know yet: it reads the parts from the message, which is gone now. So its own delete is
 *   queued beside it: removing a part twice is harmless.) `plain` is the ids that are no part of one, which the caller deletes
 *   as messages of Discord. Of those, the ones that are parts of a reply or an edit still on its way (named in its progress,
 *   not stored yet) are noted in that entry (payload.gone), so that finishSend or finishEdit does not store what Discord lost.
 * blockedSince(since) → the times (ISO) of the blocks noted since `since`, oldest first: what the breaker is built from again
 *   after a restart.
 */
import { createInTx } from './inTx.js'
import { BIGINT_MAX, isStoreId } from './librariusText.js'

const SERIAL = /^\d{1,19}$/
const KINDS = ['send', 'edit', 'delete']
const SET_STATES = ['pending', 'sent', 'blocked', 'failed']
const MESSAGE_STATES = [null, 'sending', 'blocked']
const MAX_ERROR = 500
const MAX_NOTE = 200
const MAX_ACTION = 40
const MAX_KEY = 64
const MAX_PARTS = 3
const QUEUE_KINDS = ['edit', 'delete']
const MAX_QUEUED = 2
const MAX_UPLOADS = 10
const MAX_HELD_ASKED = 50
const MAX_NAME = 100
const MAX_LISTED = 20
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function needId(value, what) {
  if (!isStoreId(value)) throw new TypeError(`${what} must be a snowflake: 17 to 20 digits that fit a bigint`)
}

function needSerial(value, what) {
  if (typeof value !== 'string' || !SERIAL.test(value) || BigInt(value) > BIGINT_MAX) throw new TypeError(`${what} must be 1 to 19 digits that fit a bigint`)
}

function needList(value, what) {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be a list`)
}

function needObject(value, what) {
  if (!isObject(value)) throw new TypeError(`${what} must be an object`)
}

/** → a time as ISO text, from a Date, ISO text or epoch milliseconds. A TypeError for anything else, or no real time. */
function needTime(value, what) {
  const known = value instanceof Date || typeof value === 'string' || typeof value === 'number'
  const time = known ? new Date(value) : null
  if (time === null || Number.isNaN(time.getTime())) throw new TypeError(`${what} must be a Date, an ISO time or epoch milliseconds`)
  return time.toISOString()
}

/** → the parts of a reply: one to three distinct Discord ids. */
function needParts(partIds) {
  needList(partIds, 'partIds')
  if (partIds.length < 1 || partIds.length > MAX_PARTS) throw new TypeError(`partIds must hold 1 to ${MAX_PARTS} ids`)
  for (const id of partIds) needId(id, 'a part id')
  if (new Set(partIds).size !== partIds.length) throw new TypeError('partIds must be different ids')
}

/** → the event, checked: what the site did, in a word, and where. The note is never the text of a reply. */
function needEvent(event) {
  needObject(event, 'event')
  const { action, postId = null, messageId = null, note = null } = event
  if (typeof action !== 'string' || action === '' || action.length > MAX_ACTION) throw new TypeError(`action must be a text of 1 to ${MAX_ACTION} characters`)
  if (postId !== null) needId(postId, 'event postId')
  if (messageId !== null) needId(messageId, 'event messageId')
  if (note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) throw new TypeError(`note must be text of at most ${MAX_NOTE} characters, or null`)
  return { action, postId, messageId, note }
}

/** → the entries to queue with an entry that ended, checked: edits and deletes, each naming its message and its post. */
function needQueue(queue) {
  needList(queue, 'queue')
  if (queue.length > MAX_QUEUED) throw new TypeError(`queue must hold at most ${MAX_QUEUED} entries`)
  for (const item of queue) {
    needObject(item, 'a queued entry')
    if (!QUEUE_KINDS.includes(item.kind)) throw new TypeError(`the kind of a queued entry must be one of ${QUEUE_KINDS.join(', ')}`)
    needId(item.messageKey, 'the messageKey of a queued entry')
    needObject(item.payload, 'the payload of a queued entry')
    needId(item.payload.postId, 'the payload.postId of a queued entry')
  }
  return queue
}

/** The entry as the worker reads it. */
const entryOut = (r) => ({ id: r.id, kind: r.kind, messageKey: r.message_key, authorId: r.author_id, payload: r.payload, attempts: r.attempts })

const ENTRY_COLUMNS = 'id, kind, message_key, author_id, payload, attempts'

/** The next number of the librarius_rev sequence, as text: a transaction takes one, and stamps everything it writes with it. */
async function nextRev(q) {
  const { rows } = await q.query("select nextval('librarius_rev') as rev")
  return rows[0].rev
}

/** Note what the site did, by the member whose action it was. */
function logEvent(q, actorId, event) {
  return q.query('insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)', [
    actorId,
    event.action,
    event.postId,
    event.messageId,
    event.note,
  ])
}

/** Delete messages, noting each stored one in the tombstones first, with the rev given. */
async function deleteRows(q, ids, rev) {
  await q.query('insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])', [ids, rev])
  await q.query('delete from librarius_messages where id = any($1::bigint[])', [ids])
}

/** Write the parts of a reply: the places of its Discord ids, in order, under the id of the first. */
function writeParts(q, messageId, partIds) {
  return q.query(
    'insert into librarius_parts (message_id, part_index, discord_id) select $1::bigint, (t.n - 1)::smallint, t.id from unnest($2::bigint[]) with ordinality as t (id, n)',
    [messageId, partIds],
  )
}

/** The message of a reply that is done, as it is written: every column a site message has. */
function checkMessage(m) {
  needObject(m, 'message')
  for (const field of ['id', 'postId', 'authorId', 'webhookId']) needId(m[field], field)
  if (m.replyTo !== null) needId(m.replyTo, 'replyTo')
  for (const field of ['authorName', 'content', 'source']) if (typeof m[field] !== 'string') throw new TypeError(`${field} must be text`)
  if (m.authorAvatar !== null && typeof m.authorAvatar !== 'string') throw new TypeError('authorAvatar must be text or null')
  needObject(m.layout, 'layout')
  needList(m.attachments, 'attachments')
  for (const a of m.attachments) needId(a.id, 'attachment id')
}

/** Queue an entry, in a transaction. For an edit or a delete the message shows that something is on its way, with a new rev. */
async function enqueueIn(q, { kind, messageKey, authorId, payload }) {
  const { rows } = await q.query('insert into librarius_outbox (kind, message_key, author_id, payload) values ($1, $2, $3, $4::jsonb) returning id', [
    kind,
    messageKey,
    authorId,
    JSON.stringify(payload),
  ])
  if (kind !== 'send') await q.query("update librarius_messages set state = 'sending', rev = nextval('librarius_rev') where id = $1", [messageKey])
  return { id: rows[0].id }
}

/**
 * Note in the entries still on their way that these parts were deleted in Discord: the ones of those entries that this
 * entry's progress names. finishSend and finishEdit read the note. Only the entries' payload.gone is written, never their
 * progress, which the worker writes whole.
 */
async function noteGone(q, ids) {
  const { rows } = await q.query(
    `select id, payload from librarius_outbox
      where kind in ('send', 'edit') and state in ('pending', 'sending')
        and exists (select 1 from jsonb_array_elements(coalesce(payload->'progress'->'parts', '[]'::jsonb)) as part where part->>'id' = any($1::text[]))
      order by id for update`,
    [ids],
  )
  for (const row of rows) {
    const named = row.payload.progress.parts.map((part) => part.id).filter((part) => ids.includes(part))
    const gone = [...new Set([...(row.payload.gone ?? []), ...named])]
    await q.query("update librarius_outbox set payload = jsonb_set(payload, '{gone}', $2::jsonb, true) where id = $1", [row.id, JSON.stringify(gone)])
  }
}

/** → the entry's note of parts that Discord lost, those of `partIds` only, or null when the entry is not 'sending' (it is done already). Locks the entry. */
async function goneOf(q, id, partIds) {
  const { rows } = await q.query("select coalesce(payload->'gone', '[]'::jsonb) as gone from librarius_outbox where id = $1 and state = 'sending' for update", [id])
  return rows.length === 0 ? null : rows[0].gone.filter((part) => partIds.includes(part))
}

export function createOutboxStore(pool) {
  const inTx = createInTx(pool)

  return {
    async enqueueOutbox({ kind, messageKey, authorId, payload }) {
      if (!KINDS.includes(kind)) throw new TypeError(`kind must be one of ${KINDS.join(', ')}`)
      if (typeof messageKey !== 'string' || messageKey === '' || messageKey.length > MAX_KEY) throw new TypeError(`messageKey must be a text of 1 to ${MAX_KEY} characters`)
      if (kind !== 'send') needId(messageKey, 'messageKey')
      needId(authorId, 'authorId')
      needObject(payload, 'payload')
      needId(payload.postId, 'payload.postId')
      return inTx((q) => enqueueIn(q, { kind, messageKey, authorId, payload }))
    },

    async outboxInterrupted() {
      const { rows } = await pool.query(`select ${ENTRY_COLUMNS} from librarius_outbox where state = 'sending' order by id`)
      return rows.map(entryOut)
    },

    async claimOutbox(now) {
      const at = needTime(now, 'now')
      const { rows } = await pool.query(
        `update librarius_outbox set state = 'sending'
          where id = (select id from librarius_outbox where state = 'pending' and next_at <= $1::timestamptz order by next_at, id limit 1 for update skip locked)
          returning ${ENTRY_COLUMNS}`,
        [at],
      )
      return rows.length === 0 ? null : entryOut(rows[0])
    },

    async outboxNextAt() {
      const { rows } = await pool.query("select min(next_at) as at from librarius_outbox where state = 'pending'")
      return rows[0].at === null ? null : new Date(rows[0].at).toISOString()
    },

    async outboxProgress(id, progress) {
      needSerial(id, 'id')
      needObject(progress, 'progress')
      await pool.query("update librarius_outbox set payload = jsonb_set(payload, '{progress}', $2::jsonb, true) where id = $1 and state = 'sending'", [id, JSON.stringify(progress)])
    },

    async outboxSet(id, { state, attempts, nextAt, error = null, messageState, event, queue = [] } = {}) {
      needSerial(id, 'id')
      if (!SET_STATES.includes(state)) throw new TypeError(`state must be one of ${SET_STATES.join(', ')}`)
      if (attempts !== undefined && !(Number.isSafeInteger(attempts) && attempts >= 0)) throw new TypeError('attempts must be a whole number of at least 0')
      const due = nextAt === undefined ? null : needTime(nextAt, 'nextAt')
      if (error !== null && typeof error !== 'string') throw new TypeError('error must be text or null')
      if (messageState !== undefined && !MESSAGE_STATES.includes(messageState)) throw new TypeError("messageState must be null, 'sending' or 'blocked'")
      const noted = event === undefined ? null : needEvent(event)
      const queued = needQueue(queue)
      await inTx(async (q) => {
        const { rows } = await q.query(
          `update librarius_outbox set state = $2, attempts = coalesce($3::int, attempts), next_at = coalesce($4::timestamptz, next_at), last_error = $5
            where id = $1 and state = 'sending' returning kind, message_key, author_id`,
          [id, state, attempts ?? null, due, error === null ? null : error.slice(0, MAX_ERROR)],
        )
        if (rows.length === 0) return
        const [entry] = rows
        if (messageState !== undefined && entry.kind !== 'send') {
          await q.query("update librarius_messages set state = $2, rev = nextval('librarius_rev') where id = $1", [entry.message_key, messageState])
        }
        if (noted !== null) await logEvent(q, entry.author_id, noted)
        for (const item of queued) await enqueueIn(q, { ...item, authorId: entry.author_id })
      })
    },

    async finishSend(id, { message, partIds, uploadIds, event }) {
      needSerial(id, 'id')
      checkMessage(message)
      needParts(partIds)
      if (partIds[0] !== message.id) throw new TypeError('the first part is the message')
      needList(uploadIds, 'uploadIds')
      if (uploadIds.length > MAX_UPLOADS) throw new TypeError(`at most ${MAX_UPLOADS} uploads`)
      for (const upload of uploadIds) needSerial(upload, 'an upload id')
      const created = needTime(message.createdAt, 'createdAt')
      const noted = needEvent(event)
      return inTx(async (q) => {
        const gone = await goneOf(q, id, partIds)
        // Done already, by a write that committed.
        if (gone === null) return { stored: true, gone: [] }
        if (gone.length > 0) return { stored: false, gone }
        const { rows: posts } = await q.query('select 1 from librarius_posts where id = $1', [message.postId])
        if (posts.length === 0) return { stored: false, gone: null }
        const rev = await nextRev(q)
        // An import that ran before this reply was done may have stored the later parts as messages of their own.
        if (partIds.length > 1) await deleteRows(q, partIds.slice(1), rev)
        await q.query(
          `insert into librarius_messages
             (id, post_id, author_id, author_name, author_avatar, webhook_id, kind, content, embeds, stickers, reactions, reply_to, created_at, edited_at, rev, origin, source, state, layout)
           values ($1::bigint, $2::bigint, $3::bigint, $4::text, $5::text, $6::bigint, 0, $7::text, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $8::bigint, $9::timestamptz, null, $10::bigint, 'site', $11::text, null, $12::jsonb)
           on conflict (id) do update set
             post_id = excluded.post_id, author_id = excluded.author_id, author_name = excluded.author_name, author_avatar = excluded.author_avatar,
             webhook_id = excluded.webhook_id, kind = excluded.kind, content = excluded.content, reply_to = excluded.reply_to,
             created_at = excluded.created_at, edited_at = excluded.edited_at, rev = excluded.rev, origin = excluded.origin,
             source = excluded.source, state = excluded.state, layout = excluded.layout`,
          [
            message.id,
            message.postId,
            message.authorId,
            message.authorName,
            message.authorAvatar,
            message.webhookId,
            message.content,
            message.replyTo,
            created,
            rev,
            message.source,
            JSON.stringify(message.layout),
          ],
        )
        await q.query('delete from librarius_attachments where message_id = $1', [message.id])
        for (const a of message.attachments) {
          await q.query(
            `insert into librarius_attachments (id, message_id, position, filename, content_type, size, width, height, url, proxy_url, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (id) do nothing`,
            [a.id, message.id, a.position, a.filename, a.contentType, a.size, a.width, a.height, a.url, a.proxyUrl, a.expiresAt],
          )
        }
        await q.query('delete from librarius_parts where message_id = $1', [message.id])
        await writeParts(q, message.id, partIds)
        if (uploadIds.length > 0) await q.query('delete from librarius_uploads where id = any($1::bigint[]) and author_id = $2', [uploadIds, message.authorId])
        await logEvent(q, message.authorId, noted)
        await q.query("update librarius_outbox set state = 'sent', last_error = null where id = $1", [id])
        return { stored: true, gone: [] }
      })
    },

    async finishEdit(id, { messageId, source, content, partIds, event }) {
      needSerial(id, 'id')
      needId(messageId, 'messageId')
      if (typeof source !== 'string' || typeof content !== 'string') throw new TypeError('source and content must be text')
      needParts(partIds)
      if (partIds[0] !== messageId) throw new TypeError('the first part is the message')
      const noted = needEvent(event)
      return inTx(async (q) => {
        const gone = await goneOf(q, id, partIds)
        if (gone === null) return { stored: true, gone: [] }
        if (gone.length > 0) return { stored: false, gone }
        const { rows: edited } = await q.query(
          "update librarius_messages set source = $2, content = $3, edited_at = now(), state = null, rev = nextval('librarius_rev') where id = $1 and origin = 'site' returning author_id",
          [messageId, source, content],
        )
        // A message that is gone is not brought back.
        if (edited.length === 0) return { stored: false, gone: [] }
        await q.query('delete from librarius_parts where message_id = $1', [messageId])
        await writeParts(q, messageId, partIds)
        const { rows: entry } = await q.query("update librarius_outbox set state = 'sent', last_error = null where id = $1 returning author_id", [id])
        await logEvent(q, entry[0].author_id, noted)
        return { stored: true, gone: [] }
      })
    },

    async finishDelete(id, { messageId, partIds, event }) {
      needSerial(id, 'id')
      needId(messageId, 'messageId')
      needList(partIds, 'partIds')
      for (const part of partIds) needId(part, 'a part id')
      const noted = needEvent(event)
      await inTx(async (q) => {
        const { rows: entry } = await q.query("update librarius_outbox set state = 'sent', last_error = null where id = $1 and state = 'sending' returning author_id", [id])
        // Done already, by a write that committed.
        if (entry.length === 0) return
        const rev = await nextRev(q)
        await deleteRows(q, [messageId], rev)
        await q.query('delete from librarius_parts where message_id = $1 or discord_id = any($2::bigint[])', [messageId, partIds])
        await logEvent(q, entry[0].author_id, noted)
      })
    },

    async outboxMessage(messageId) {
      needId(messageId, 'messageId')
      const { rows } = await pool.query(
        'select id, post_id, author_id, author_name, author_avatar, origin, source, layout, state from librarius_messages where id = $1',
        [messageId],
      )
      if (rows.length === 0) return null
      const [m] = rows
      const { rows: parts } = await pool.query('select discord_id from librarius_parts where message_id = $1 order by part_index', [messageId])
      return {
        id: m.id,
        postId: m.post_id,
        authorId: m.author_id,
        authorName: m.author_name,
        authorAvatar: m.author_avatar,
        origin: m.origin,
        source: m.source,
        layout: m.layout,
        state: m.state,
        parts: parts.map((p) => p.discord_id),
      }
    },

    async uploadsFor(authorId, ids) {
      needId(authorId, 'authorId')
      needList(ids, 'ids')
      for (const id of ids) needSerial(id, 'an upload id')
      if (ids.length === 0) return []
      const { rows } = await pool.query('select id, name, content_type, bytes from librarius_uploads where author_id = $1 and id = any($2::bigint[])', [authorId, ids])
      const held = new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, contentType: r.content_type, bytes: r.bytes }]))
      return ids.filter((id) => held.has(id)).map((id) => held.get(id))
    },

    async addUpload(upload) {
      needObject(upload, 'upload')
      const { authorId, name, contentType, bytes } = upload
      needId(authorId, 'authorId')
      if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME) throw new TypeError(`name must be a text of 1 to ${MAX_NAME} characters`)
      if (!PICTURE_TYPES.includes(contentType)) throw new TypeError('contentType must be image/png, image/jpeg, image/webp or image/gif')
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError('bytes must be a Uint8Array of at least one byte')
      const { rows } = await pool.query('insert into librarius_uploads (author_id, name, content_type, bytes) values ($1, $2, $3, $4) returning id', [
        authorId,
        name,
        contentType,
        // bytea goes in as a Buffer; a view of a bigger buffer is only its own bytes.
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      ])
      return { id: rows[0].id }
    },

    async heldUploadIds(authorId, ids) {
      needId(authorId, 'authorId')
      needList(ids, 'ids')
      if (ids.length > MAX_HELD_ASKED) throw new TypeError(`ids must hold at most ${MAX_HELD_ASKED} ids`)
      for (const id of ids) needSerial(id, 'an upload id')
      if (ids.length === 0) return new Set()
      const { rows } = await pool.query('select id from librarius_uploads where author_id = $1 and id = any($2::bigint[])', [authorId, ids])
      return new Set(rows.map((r) => r.id))
    },

    async outboxFor(authorId, postId, since) {
      needId(authorId, 'authorId')
      needId(postId, 'postId')
      const from = needTime(since, 'since')
      const { rows } = await pool.query(
        `select id, kind, message_key, state, last_error, case when kind = 'send' then payload->>'source' end as source, created_at
           from librarius_outbox
          where author_id = $1 and payload->>'postId' = $2 and state <> 'sent' and created_at >= $3::timestamptz
          order by id desc limit ${MAX_LISTED}`,
        [authorId, postId, from],
      )
      return rows
        .map((r) => ({ key: r.message_key, kind: r.kind, state: r.state, error: r.last_error, source: r.source, createdAt: new Date(r.created_at).toISOString() }))
        .reverse()
    },

    async sweepUploads(options) {
      needObject(options, 'options')
      const before = needTime(options.olderThan, 'olderThan')
      const { rows } = await pool.query(
        `delete from librarius_uploads u
          where not exists (select 1 from librarius_outbox o where o.kind = 'send' and o.state in ('pending', 'sending') and o.payload->'uploads' @> to_jsonb(u.id::text))
            and (u.created_at < $1::timestamptz
                 or exists (select 1 from librarius_outbox o where o.kind = 'send' and o.state in ('failed', 'blocked') and o.payload->'uploads' @> to_jsonb(u.id::text)))
          returning u.id`,
        [before],
      )
      return rows.length
    },

    async knownPartIds(ids) {
      needList(ids, 'ids')
      for (const id of ids) needId(id, 'a part id')
      if (ids.length === 0) return new Set()
      const { rows } = await pool.query('select discord_id from librarius_parts where discord_id = any($1::bigint[])', [ids])
      return new Set(rows.map((r) => r.discord_id))
    },

    async messageOfPart(id) {
      needId(id, 'id')
      const { rows } = await pool.query('select message_id from librarius_parts where discord_id = $1', [id])
      return rows.length === 0 ? id : rows[0].message_id
    },

    async siteDeleted(ids, postId) {
      needList(ids, 'ids')
      for (const id of ids) needId(id, 'a part id')
      needId(postId, 'postId')
      if (ids.length === 0) return { plain: [] }
      return inTx(async (q) => {
        const { rows: hit } = await q.query('select discord_id, message_id from librarius_parts where discord_id = any($1::bigint[])', [ids])
        const parts = new Set(hit.map((r) => r.discord_id))
        const plain = ids.filter((id) => !parts.has(id))
        if (plain.length > 0) await noteGone(q, plain)
        if (hit.length === 0) return { plain }
        const rev = await nextRev(q)
        for (const messageId of new Set(hit.map((r) => r.message_id))) {
          const { rows: all } = await q.query('select discord_id from librarius_parts where message_id = $1 order by part_index', [messageId])
          const left = all.map((r) => r.discord_id).filter((part) => !parts.has(part))
          const { rows: stored } = await q.query('select post_id, author_id from librarius_messages where id = $1', [messageId])
          await deleteRows(q, [messageId], rev)
          await q.query('delete from librarius_parts where message_id = $1', [messageId])
          const author = stored.length === 0 ? '0' : stored[0].author_id
          if (left.length > 0) {
            // A delete that knows its parts (the one an earlier call queued, or one at work) takes these; one that has yet to read them from the message, which is gone, does not.
            const { rows: queued } = await q.query("select payload from librarius_outbox where kind = 'delete' and message_key = $1 and state in ('pending', 'sending') for update", [messageId])
            const covered = queued.some(({ payload }) => payload.partIds !== undefined || payload.progress?.partIds !== undefined)
            if (!covered) {
              await q.query("insert into librarius_outbox (kind, message_key, author_id, payload) values ('delete', $1, $2, $3::jsonb)", [
                messageId,
                author,
                JSON.stringify({ postId, partIds: left }),
              ])
            }
          }
          await logEvent(q, author, { action: 'deleted-in-discord', postId, messageId, note: null })
        }
        return { plain }
      })
    },

    async blockedSince(since) {
      const at = needTime(since, 'since')
      const { rows } = await pool.query("select at from librarius_events where action = 'blocked' and at >= $1::timestamptz order by at", [at])
      return rows.map((r) => new Date(r.at).toISOString())
    },
  }
}
