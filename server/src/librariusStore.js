/**
 * Postgres side of the Librarius (the guild's Discord forum, read on the site): the only module that talks to the
 * librarius_* tables, which are in schema.sql. The tables are a copy of what Discord holds, so every write here is
 * Discord's doing (the import, the gateway events), and a delete in Discord is a delete here.
 *
 * Ids are Discord snowflakes. Postgres holds them as bigint and pg hands them back as strings, and so does this
 * module, in and out: a number would lose digits. A caller's id that is not a snowflake that fits a bigint is a
 * TypeError before any query, since a bad id inside a batch would otherwise fail the whole transaction.
 *
 * Every message write, and every delete, is stamped with a number of the librarius_rev sequence (rev). A transaction takes
 * ONE number as it begins and stamps every row it writes with it: a batch of messages (upsertMessages) or of deletes
 * (deleteMessages) shares one, and a reaction change takes its own. A reader that holds the highest rev it has seen asks
 * changes() for what came after it. A write takes its number before it commits, so a reader that polls while a write is
 * still open can hold a number above the one the write then commits with; the numbers are the sequence's, shared by every
 * post, and that window is as short as the write. A reader covers it by having changes() send again the newest rows just at
 * or below the number it holds (the routes ask for at most 100 rows, within 100 numbers of it; the numbers count
 * transactions, not rows, since a batch shares its number), and a reader that reopens the post starts clean.
 *
 * Every caller value goes in as a $n parameter. The only text built into a statement is a fixed fragment or a
 * librarius_sync column name taken from SYNC_COLUMNS.
 */
import { createInTx } from './inTx.js'
import { applyReaction, attachmentUrl } from './librariusParse.js'

const SNOWFLAKE = /^\d{17,20}$/
// The digits of a rev: it is a bigint, so at most 19 of them.
const REV = /^\d{1,19}$/
const BIGINT_MAX = 9223372036854775807n
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
// setSync accepts exactly these keys; they are the only column names that ever reach its statement.
const SYNC_COLUMNS = ['import_done', 'last_run_at', 'last_ok_at', 'last_error']

const MESSAGE_COLUMNS =
  'id, post_id, author_id, author_name, author_avatar, webhook_id, kind, content, embeds, stickers, reactions, reply_to, created_at, edited_at, rev'
const ATTACHMENT_COLUMNS = 'id, message_id, position, filename, content_type, size, width, height, url, proxy_url, expires_at'
// One post's messages: the pages and the changes add their own where and order.
const POST_MESSAGES = `select ${MESSAGE_COLUMNS} from librarius_messages where post_id = $1`

const REPLIES = '(select count(*)::int from librarius_messages m where m.post_id = p.id and m.id <> p.id)'

/**
 * Insert a message, or update what Discord can change on it, stamping the rev it is given ($15) either way. → { id } when
 * written. `reactions` is the one column a caller may ask to leave alone on an update: see UPSERT_KEEPING_REACTIONS.
 */
const upsertMessageSql = (updatesReactions) => `insert into librarius_messages
    (id, post_id, author_id, author_name, author_avatar, webhook_id, kind, content, embeds, stickers, reactions, reply_to, created_at, edited_at, rev)
  select $1::bigint, $2::bigint, $3::bigint, $4::text, $5::text, $6::bigint, $7::smallint, $8::text, $9::jsonb, $10::jsonb, $11::jsonb, $12::bigint, $13::timestamptz, $14::timestamptz, $15::bigint
  where exists (select 1 from librarius_posts where id = $2)
  on conflict (id) do update set
    author_id = excluded.author_id, author_name = excluded.author_name, author_avatar = excluded.author_avatar,
    webhook_id = excluded.webhook_id, kind = excluded.kind, content = excluded.content, embeds = excluded.embeds,
    stickers = excluded.stickers, ${updatesReactions ? 'reactions = excluded.reactions, ' : ''}reply_to = excluded.reply_to,
    edited_at = excluded.edited_at, rev = excluded.rev
  returning id`

const UPSERT_MESSAGE = upsertMessageSql(true)
/**
 * The same, without `reactions` among what a conflict updates: a message already stored keeps the counts it has, and
 * a new one is still inserted with the reactions it came with.
 */
const UPSERT_KEEPING_REACTIONS = upsertMessageSql(false)

/**
 * Every post, with what the topic list shows of it, in one statement: its latest message (the newest by id, the
 * opening message when there are no replies) and that message's first image, the last three distinct authors, the
 * reply count (every message but the opening one) and the member's unread count (0 without a read mark).
 */
const LIST_POSTS = `select p.id, p.title, p.tag_ids, p.pinned, p.locked, p.archived, p.created_at,
    coalesce(lm.created_at, p.created_at) as last_activity_at,
    ${REPLIES} as replies,
    case when r.last_read is null then 0
         else (select count(*)::int from librarius_messages m where m.post_id = p.id and m.id > r.last_read) end as unread,
    lm.id as latest_id, lm.author_id as latest_author_id, lm.author_name as latest_author_name,
    lm.author_avatar as latest_author_avatar, lm.content as latest_content,
    im.id as image_id, im.url as image_url, im.expires_at as image_expires_at,
    (select coalesce(array_agg(ps.author_id::text order by ps.newest desc), '{}')
       from (select m.author_id, max(m.id) as newest from librarius_messages m where m.post_id = p.id
              group by m.author_id order by max(m.id) desc limit 3) ps) as poster_ids
  from librarius_posts p
  left join librarius_reads r on r.post_id = p.id and r.member_id = $1
  left join lateral (select m.* from librarius_messages m where m.post_id = p.id order by m.id desc limit 1) lm on true
  left join lateral (select att.id, att.url, att.expires_at from librarius_attachments att
                      where att.message_id = lm.id and att.content_type like 'image/%' order by att.position limit 1) im on true
  order by p.pinned desc, coalesce(lm.created_at, p.created_at) desc, p.id desc`

/** The next number of the librarius_rev sequence, as text: a transaction takes one, and stamps everything it writes with it. */
async function nextRev(q) {
  const { rows } = await q.query("select nextval('librarius_rev') as rev")
  return rows[0].rev
}

/** A guard for every id a statement matches or stores: a snowflake string that fits a bigint, else a TypeError. */
function needId(value, what) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value) || BigInt(value) > BIGINT_MAX) {
    throw new TypeError(`${what} must be a snowflake: 17 to 20 digits that fit a bigint`)
  }
}

/** As needId, for a column that may be empty: null passes, and undefined does not (it may be a misspelt field). */
function needIdOrNull(value, what) {
  if (value !== null) needId(value, what)
}

function needList(value, what) {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be a list`)
}

/** A count for a limit: a whole number from 1 to `max`, else a RangeError. A string or NaN is no number. */
function needCount(value, what, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${what} must be a whole number from 1 to ${max}`)
  }
}

/** A rev, as the text of a whole number that fits a bigint. */
function needRev(value) {
  if (typeof value !== 'string' || !REV.test(value) || BigInt(value) > BIGINT_MAX) {
    throw new TypeError('sinceRev must be the digits of a rev: a whole number that fits a bigint')
  }
}

/** → a time as ISO text, from a Date, ISO text or epoch milliseconds. A TypeError for anything else, or no real time. */
function needTime(value, what) {
  const known = value instanceof Date || typeof value === 'string' || typeof value === 'number'
  const time = known ? new Date(value) : null
  if (time === null || Number.isNaN(time.getTime())) {
    throw new TypeError(`${what} must be a Date, an ISO time or epoch milliseconds`)
  }
  return time.toISOString()
}

/** → a timestamp column as ISO text, or null. */
const iso = (value) => (value === null ? null : new Date(value).toISOString())

const attachmentOut = (a) => ({
  id: a.id,
  filename: a.filename,
  contentType: a.content_type,
  size: a.size,
  width: a.width,
  height: a.height,
  url: a.url,
  proxyUrl: a.proxy_url,
  expiresAt: iso(a.expires_at),
  position: a.position,
})

/** → a message row in the shape librariusParse.js makes, plus its rev and the attachments it was given. */
const messageOut = (m, attachments) => ({
  id: m.id,
  postId: m.post_id,
  authorId: m.author_id,
  authorName: m.author_name,
  authorAvatar: m.author_avatar,
  webhookId: m.webhook_id,
  kind: m.kind,
  content: m.content,
  embeds: m.embeds,
  stickers: m.stickers,
  reactions: m.reactions,
  replyTo: m.reply_to,
  createdAt: iso(m.created_at),
  editedAt: iso(m.edited_at),
  rev: m.rev,
  attachments,
})

/** Everything about a message that is checked before a batch is written: its ids and the lists it carries. */
function checkMessage(m) {
  needId(m.id, 'id')
  needId(m.postId, 'postId')
  needId(m.authorId, 'authorId')
  needIdOrNull(m.webhookId, 'webhookId')
  needIdOrNull(m.replyTo, 'replyTo')
  for (const field of ['embeds', 'stickers', 'reactions', 'attachments']) needList(m[field], field)
  for (const a of m.attachments) needId(a.id, 'attachment id')
}

export function createLibrariusStore(pool) {
  const inTx = createInTx(pool)

  /** The first `size` rows of `sql`, and whether it found more than that; `newestFirst` rows come back oldest first. */
  async function page(sql, params, size, newestFirst) {
    const { rows } = await pool.query(sql, params)
    const kept = rows.slice(0, size)
    return { rows: newestFirst ? kept.reverse() : kept, more: rows.length > size }
  }

  /** Whether the one-row `select exists (...) as found` statement found anything. */
  async function exists(sql, params) {
    const { rows } = await pool.query(sql, params)
    return rows[0].found
  }

  /** → the message rows as views, each with its attachments in position order (one query for the lot). */
  async function withAttachments(rows) {
    if (rows.length === 0) return []
    const { rows: found } = await pool.query(
      `select ${ATTACHMENT_COLUMNS} from librarius_attachments where message_id = any($1::bigint[]) order by message_id, position`,
      [rows.map((m) => m.id)],
    )
    const byMessage = new Map(rows.map((m) => [m.id, []]))
    for (const a of found) byMessage.get(a.message_id)?.push(attachmentOut(a))
    return rows.map((m) => messageOut(m, byMessage.get(m.id)))
  }

  /** Lock one message, change its reactions with `change`, and write them with a new rev. Nothing for a message not stored. */
  const rewriteReactions = (messageId, change) =>
    inTx(async (q) => {
      const { rows } = await q.query('select reactions from librarius_messages where id = $1 for update', [messageId])
      if (rows.length === 0) return
      await q.query("update librarius_messages set reactions = $2::jsonb, rev = nextval('librarius_rev') where id = $1", [
        messageId,
        JSON.stringify(change(rows[0].reactions)),
      ])
    })

  return {
    /** The id of every stored post, so a gateway event can tell the forum's threads from other channels. */
    async knownPostIds() {
      const { rows } = await pool.query('select id from librarius_posts')
      return new Set(rows.map((r) => r.id))
    },

    /**
     * Insert a post, or update what Discord can change on it. The import cursor and the view time are the store's own
     * and are never touched. `post` is a parseThread row.
     */
    async upsertPost(post) {
      needId(post.id, 'id')
      needIdOrNull(post.ownerId, 'ownerId')
      needList(post.tagIds, 'tagIds')
      await pool.query(
        `insert into librarius_posts (id, owner_id, title, tag_ids, pinned, locked, archived, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set owner_id = excluded.owner_id, title = excluded.title, tag_ids = excluded.tag_ids,
           pinned = excluded.pinned, locked = excluded.locked, archived = excluded.archived,
           created_at = excluded.created_at, updated_at = now()`,
        [post.id, post.ownerId, post.title, post.tagIds, post.pinned, post.locked, post.archived, post.createdAt],
      )
    },

    /** Delete a post. Its messages, their attachments and its read marks go with it. */
    async deletePost(id) {
      needId(id, 'postId')
      await pool.query('delete from librarius_posts where id = $1', [id])
    },

    /**
     * Delete every post not in `ids`. → the ids deleted. An empty list deletes nothing: it is far likelier a listing that
     * failed to read than a forum emptied, and a thread deleted in Discord leaves through deletePost.
     */
    async deletePostsNotIn(ids) {
      needList(ids, 'ids')
      for (const id of ids) needId(id, 'postId')
      if (ids.length === 0) return []
      const { rows } = await pool.query('delete from librarius_posts where id <> all($1::bigint[]) returning id', [ids])
      return rows.map((r) => r.id)
    },

    /**
     * Write parseMessage rows, all with one new rev (taken once, as the transaction begins), and replace each one's attachments, all in one transaction. A message
     * whose post is not stored is skipped. Every row is checked before the first is written.
     *
     * With `keepReactions: true` a message that is already stored keeps the reactions it has, whatever the row says,
     * and a new one is stored with the row's: for a live update of a message, which can leave its reactions out. It is
     * true or false, else a TypeError before any query.
     */
    async upsertMessages(rows, { keepReactions = false } = {}) {
      needList(rows, 'rows')
      if (typeof keepReactions !== 'boolean') throw new TypeError('keepReactions must be true or false')
      for (const m of rows) checkMessage(m)
      if (rows.length === 0) return
      return inTx(async (q) => {
        const rev = await nextRev(q)
        for (const m of rows) {
          const { rows: written } = await q.query(keepReactions ? UPSERT_KEEPING_REACTIONS : UPSERT_MESSAGE, [
            m.id,
            m.postId,
            m.authorId,
            m.authorName,
            m.authorAvatar,
            m.webhookId,
            m.kind,
            m.content,
            JSON.stringify(m.embeds),
            JSON.stringify(m.stickers),
            JSON.stringify(m.reactions),
            m.replyTo,
            m.createdAt,
            m.editedAt,
            rev,
          ])
          if (written.length === 0) continue
          await q.query('delete from librarius_attachments where message_id = $1', [m.id])
          for (const a of m.attachments) {
            await q.query(
              `insert into librarius_attachments (id, message_id, position, filename, content_type, size, width, height, url, proxy_url, expires_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (id) do nothing`,
              [a.id, m.id, a.position, a.filename, a.contentType, a.size, a.width, a.height, a.url, a.proxyUrl, a.expiresAt],
            )
          }
        }
      })
    },

    /**
     * Delete messages, noting each stored one in the tombstones first (all with one new rev, taken once) so a reader learns
     * of it. One transaction. Their attachments go with them. An empty list sends nothing.
     */
    async deleteMessages(ids) {
      needList(ids, 'ids')
      for (const id of ids) needId(id, 'messageId')
      if (ids.length === 0) return
      return inTx(async (q) => {
        const rev = await nextRev(q)
        await q.query(
          'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
          [ids, rev],
        )
        await q.query('delete from librarius_messages where id = any($1::bigint[])', [ids])
      })
    },

    /**
     * Change one emoji's count on a message by `delta` (applyReaction), under a row lock, with a new rev. One transaction.
     * Nothing for a message not stored. `delta` must be a whole number, else a TypeError before any query.
     */
    async adjustReaction(messageId, emoji, delta) {
      needId(messageId, 'messageId')
      if (!Number.isSafeInteger(delta)) throw new TypeError('delta must be a whole number')
      return rewriteReactions(messageId, (reactions) => applyReaction(reactions, emoji, delta))
    },

    /**
     * Take one emoji off a message, by its emojiKey, or every reaction when `key` is null, with a new rev. One
     * transaction. A key that is undefined or empty is a TypeError before any query: only null clears them all, so a
     * caller whose emojiKey() found nothing must not pass its null on.
     */
    async clearReactions(messageId, key) {
      needId(messageId, 'messageId')
      if (key !== null && (typeof key !== 'string' || key === '')) throw new TypeError('key must be an emoji key or null')
      return rewriteReactions(messageId, (reactions) => (key === null ? [] : reactions.filter((r) => r.key !== key)))
    },

    /**
     * The topic list for one member: pinned posts first, then the latest activity. → [{ id, title, tagIds, pinned,
     * locked, archived, createdAt, lastActivityAt, replies, unread, latest: { id, authorId, authorName, authorAvatar,
     * content (the whole text), image: { id, url, expiresAt } | null } | null, posterIds (the last 3 distinct authors,
     * newest first) }]. One statement. The text is never cut here: the site reads a spoiler over the whole message, and
     * a cut copy can read as a spoiler closed before words the whole message hides. The site cuts the plain text it
     * shows, after reading. A Discord message is at most 4,000 characters, and what is stored is at most 65,536 UTF-16
     * units: parseMessage keeps a text whole up to that, and drops one over it, which Discord never sends.
     */
    async listPosts(memberId) {
      needId(memberId, 'memberId')
      const { rows } = await pool.query(LIST_POSTS, [memberId])
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        tagIds: r.tag_ids,
        pinned: r.pinned,
        locked: r.locked,
        archived: r.archived,
        createdAt: iso(r.created_at),
        lastActivityAt: iso(r.last_activity_at),
        replies: r.replies,
        unread: r.unread,
        latest:
          r.latest_id === null
            ? null
            : {
                id: r.latest_id,
                authorId: r.latest_author_id,
                authorName: r.latest_author_name,
                authorAvatar: r.latest_author_avatar,
                content: r.latest_content,
                image:
                  r.image_id === null ? null : { id: r.image_id, url: r.image_url, expiresAt: iso(r.image_expires_at) },
              },
        posterIds: r.poster_ids,
      }))
    },

    /**
     * One post and the newest message the member has read in it. → { post: { id, ownerId, title, tagIds, pinned,
     * locked, archived, createdAt, replies }, lastRead: string | null }, or null for a post not stored.
     */
    async getPost(id, memberId) {
      needId(id, 'postId')
      needId(memberId, 'memberId')
      const { rows } = await pool.query(
        `select p.id, p.owner_id, p.title, p.tag_ids, p.pinned, p.locked, p.archived, p.created_at, ${REPLIES} as replies, r.last_read
           from librarius_posts p left join librarius_reads r on r.post_id = p.id and r.member_id = $2
          where p.id = $1`,
        [id, memberId],
      )
      if (rows.length === 0) return null
      const r = rows[0]
      return {
        post: {
          id: r.id,
          ownerId: r.owner_id,
          title: r.title,
          tagIds: r.tag_ids,
          pinned: r.pinned,
          locked: r.locked,
          archived: r.archived,
          createdAt: iso(r.created_at),
          replies: r.replies,
        },
        lastRead: r.last_read,
      }
    },

    /**
     * A page of a post's messages, oldest first, each with its attachments. With no cursor it is the newest page; `before`
     * and `after` take the rows on one side of a message id; `around` takes floor(limit / 2) at or before it and the rest
     * after it. At most one of the three; each is a snowflake. `limit` is a whole number from 1 to 100, 50 when absent, else
     * a RangeError. hasOlder and hasNewer are true when more lies that way: the page fetches one row more than it shows.
     * → { rows, hasOlder, hasNewer }.
     */
    async listMessages(postId, { before, after, around, limit = DEFAULT_LIMIT } = {}) {
      needId(postId, 'postId')
      needCount(limit, 'limit', MAX_LIMIT)
      const given = Object.entries({ before, after, around }).filter(([, cursor]) => cursor !== undefined)
      if (given.length > 1) throw new TypeError('listMessages takes at most one of before, after and around')
      if (given.length === 1) needId(given[0][1], given[0][0])

      let rows
      let hasOlder
      let hasNewer
      if (given.length === 0) {
        const newest = await page(`${POST_MESSAGES} order by id desc limit $2`, [postId, limit + 1], limit, true)
        ;({ rows, more: hasOlder } = newest)
        hasNewer = false
      } else if (before !== undefined) {
        const older = await page(`${POST_MESSAGES} and id < $2 order by id desc limit $3`, [postId, before, limit + 1], limit, true)
        ;({ rows, more: hasOlder } = older)
        hasNewer = await exists('select exists (select 1 from librarius_messages where post_id = $1 and id >= $2) as found', [postId, before])
      } else if (after !== undefined) {
        const newer = await page(`${POST_MESSAGES} and id > $2 order by id asc limit $3`, [postId, after, limit + 1], limit, false)
        ;({ rows, more: hasNewer } = newer)
        hasOlder = await exists('select exists (select 1 from librarius_messages where post_id = $1 and id <= $2) as found', [postId, after])
      } else {
        const half = Math.floor(limit / 2)
        const older = await page(`${POST_MESSAGES} and id <= $2 order by id desc limit $3`, [postId, around, half + 1], half, true)
        const newer = await page(`${POST_MESSAGES} and id > $2 order by id asc limit $3`, [postId, around, limit - half + 1], limit - half, false)
        rows = [...older.rows, ...newer.rows]
        hasOlder = older.more
        hasNewer = newer.more
      }
      return { rows: await withAttachments(rows), hasOlder, hasNewer }
    },

    /**
     * What changed in a post, for a reader that holds `sinceRev` (the digits of a rev): { rows, deleted, rev, full }.
     * `options` is { limit, slack }, each a whole number from 1.
     *
     * Two parts are read, each of the messages written and of the ids deleted:
     * - what is NEW: after `sinceRev`, the oldest `limit`, with their attachments;
     * - what is SENT AGAIN: at or below `sinceRev` and above `sinceRev - slack`, the newest `slack` of them. A write takes its
     *   rev before it commits, so one that took a number below the reader's can commit after the reader moved past it, and
     *   only a look back finds it. The reader replaces a message by its id, so one it has already is no harm.
     *
     * `rows` and `deleted` hold what is sent again first and what is new after it, each oldest first. `full` is true when
     * what is new, messages or deletes, fills `limit`: more may be waiting than was read, and the caller who sees it should
     * start the reader afresh. What is sent again never makes it true: it is a constant few, and counting it would answer
     * a quiet post whose newest rows lie within `slack` of its top as one with too much new, to the same reader every poll.
     * `rev` is the highest number among what is answered, or `sinceRev` when nothing changed: the number to ask from next.
     */
    async changes(postId, sinceRev, options) {
      needId(postId, 'postId')
      needRev(sinceRev)
      const { limit, slack } = options ?? {}
      needCount(limit, 'limit')
      needCount(slack, 'slack')
      const { rows: fresh } = await pool.query(`${POST_MESSAGES} and rev > $2 order by rev limit $3`, [postId, sinceRev, limit])
      const { rows: back } = await pool.query(
        `${POST_MESSAGES} and rev <= $2::bigint and rev > $2::bigint - $3::bigint order by rev desc limit $3`,
        [postId, sinceRev, slack],
      )
      // The look back is read newest first, to take the newest, and is answered oldest first.
      const rows = [...back.reverse(), ...fresh]
      const shown = await withAttachments(rows)
      const { rows: freshGone } = await pool.query(
        'select message_id, rev from librarius_tombstones where post_id = $1 and rev > $2 order by rev limit $3',
        [postId, sinceRev, limit],
      )
      const { rows: backGone } = await pool.query(
        'select message_id, rev from librarius_tombstones where post_id = $1 and rev <= $2::bigint and rev > $2::bigint - $3::bigint order by rev desc limit $3',
        [postId, sinceRev, slack],
      )
      const gone = [...backGone.reverse(), ...freshGone]
      // Stryker disable next-line EqualityOperator: when two revs are equal, taking either gives the same number
      const rev = [...rows, ...gone].reduce((top, r) => (BigInt(r.rev) > top ? BigInt(r.rev) : top), BigInt(sinceRev))
      return {
        rows: shown,
        deleted: gone.map((g) => g.message_id),
        rev: String(rev),
        full: fresh.length >= limit || freshGone.length >= limit,
      }
    },

    /**
     * The messages of a post that a reply can quote: those of `ids` that are stored in the post, each as { id, authorId,
     * authorName, authorAvatar, content (the whole text, never cut, as in listPosts) }, in no order. An id that is not
     * stored is left out. An empty list sends nothing.
     */
    async quotedMessages(postId, ids) {
      needId(postId, 'postId')
      needList(ids, 'ids')
      for (const id of ids) needId(id, 'messageId')
      if (ids.length === 0) return []
      const { rows } = await pool.query(
        'select id, author_id, author_name, author_avatar, content from librarius_messages where post_id = $1 and id = any($2::bigint[])',
        [postId, ids],
      )
      return rows.map((r) => ({ id: r.id, authorId: r.author_id, authorName: r.author_name, authorAvatar: r.author_avatar, content: r.content }))
    },

    /**
     * The highest rev any stored message or delete note of the post holds, as text ('0' for a post with none): what a reader
     * asks changes() from after it loads the post. It is read from the rows, not the sequence, so a number taken by a write
     * that has not committed yet is never passed, and from the post's own rows (the (post_id, rev) indexes), so it costs
     * the size of one post, not of the forum.
     */
    async currentRev(postId) {
      needId(postId, 'postId')
      const { rows } = await pool.query(
        'select greatest(coalesce((select max(rev) from librarius_messages where post_id = $1), 0), coalesce((select max(rev) from librarius_tombstones where post_id = $1), 0)) as rev',
        [postId],
      )
      return rows[0].rev
    },

    /** Record that a member has read up to a message. It never goes down, and a post that is gone is left alone. */
    async setRead(memberId, postId, messageId) {
      needId(memberId, 'memberId')
      needId(postId, 'postId')
      needId(messageId, 'messageId')
      await pool.query(
        `insert into librarius_reads (member_id, post_id, last_read)
         select $1::bigint, $2::bigint, $3::bigint
         where exists (select 1 from librarius_posts where id = $2)
         on conflict (member_id, post_id) do update set last_read = greatest(librarius_reads.last_read, excluded.last_read)`,
        [memberId, postId, messageId],
      )
    },

    /** Stamp the time a post was opened, so the link refresh only looks after posts somebody reads. */
    async markViewed(postId) {
      needId(postId, 'postId')
      await pool.query('update librarius_posts set viewed_at = now() where id = $1', [postId])
    },

    /** → the newest message id the import has stored for a post, or null before it began (or for a post not stored). */
    async importCursor(postId) {
      needId(postId, 'postId')
      const { rows } = await pool.query('select import_cursor from librarius_posts where id = $1', [postId])
      return rows[0]?.import_cursor ?? null
    },

    async setImportCursor(postId, messageId) {
      needId(postId, 'postId')
      needId(messageId, 'messageId')
      await pool.query('update librarius_posts set import_cursor = $2 where id = $1', [postId, messageId])
    },

    /** → [{ id, editedAt }] for a post's newest `limit` messages, newest first: what the catch-up compares with Discord's. */
    async windowIds(postId, limit) {
      needId(postId, 'postId')
      needCount(limit, 'limit')
      const { rows } = await pool.query('select id, edited_at from librarius_messages where post_id = $1 order by id desc limit $2', [
        postId,
        limit,
      ])
      return rows.map((r) => ({ id: r.id, editedAt: iso(r.edited_at) }))
    },

    /** → { importDone, lastRunAt, lastOkAt, lastError } from the single sync row; the empty state before it is written. */
    async syncStatus() {
      const { rows } = await pool.query('select import_done, last_run_at, last_ok_at, last_error from librarius_sync where id = 1')
      const r = rows[0] ?? { import_done: false, last_run_at: null, last_ok_at: null, last_error: null }
      return { importDone: r.import_done, lastRunAt: iso(r.last_run_at), lastOkAt: iso(r.last_ok_at), lastError: r.last_error }
    },

    /**
     * Upsert the given sync columns only (a null clears one, e.g. last_error). Any other key, an empty patch, or an
     * undefined value is a TypeError: pg would send undefined as null and clear the column.
     */
    async setSync(patch) {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('setSync: patch must be an object')
      const keys = Object.keys(patch)
      const bad = keys.find((k) => !SYNC_COLUMNS.includes(k))
      if (bad !== undefined) throw new TypeError(`setSync: not a librarius_sync column: ${bad}`)
      if (keys.length === 0) throw new TypeError('setSync: nothing to set')
      const unset = keys.find((k) => patch[k] === undefined)
      if (unset !== undefined) throw new TypeError(`setSync: ${unset} is undefined (use null to clear it)`)
      await pool.query(
        `insert into librarius_sync (id, ${keys.join(', ')}) values (1, ${keys.map((_, i) => `$${i + 1}`).join(', ')})
         on conflict (id) do update set ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}`,
        keys.map((k) => patch[k]),
      )
    },

    /**
     * → [{ id, url }] for attachments of posts viewed since `viewedSince` whose link expires before `expiringBefore`
     * (already expired ones too), soonest first, at most `limit`. Times are a Date, ISO text or epoch milliseconds.
     */
    async attachmentsToRefresh({ expiringBefore, viewedSince, limit }) {
      const before = needTime(expiringBefore, 'expiringBefore')
      const since = needTime(viewedSince, 'viewedSince')
      needCount(limit, 'limit')
      const { rows } = await pool.query(
        `select a.id, a.url from librarius_attachments a
           join librarius_messages m on m.id = a.message_id
           join librarius_posts p on p.id = m.post_id
          where p.viewed_at >= $2 and a.expires_at < $1
          order by a.expires_at limit $3`,
        [before, since, limit],
      )
      return rows.map((r) => ({ id: r.id, url: r.url }))
    },

    /**
     * Replace the link and expiry (a time, or null) of each attachment: [{ id, url, expiresAt }], one statement. A link that
     * is not on Discord's CDN attachments path (the check a message's attachment passes when it is parsed) is a TypeError
     * before any query, so what is stored never leaves that host, whoever asked for it. The link is stored as that check
     * normalises it (as parseMessage keeps it), not as it was written.
     */
    async updateAttachmentUrls(updates) {
      needList(updates, 'updates')
      // What is stored is the link as the check normalises it, the same as parseMessage keeps, so it is the very link that was judged.
      const urls = updates.map((u) => {
        needId(u.id, 'attachment id')
        const url = attachmentUrl(u.url)
        if (url === null) throw new TypeError("url must be a link on Discord's CDN attachments path")
        return url
      })
      const expiries = updates.map((u) => (u.expiresAt === null ? null : needTime(u.expiresAt, 'expiresAt')))
      if (updates.length === 0) return
      await pool.query(
        `update librarius_attachments a set url = u.url, expires_at = u.expires_at
           from unnest($1::bigint[], $2::text[], $3::timestamptz[]) as u (id, url, expires_at)
          where a.id = u.id`,
        [updates.map((u) => u.id), urls, expiries],
      )
    },

    /** Delete the delete notes older than `before` (a Date, ISO text or epoch milliseconds). */
    async pruneTombstones(before) {
      await pool.query('delete from librarius_tombstones where deleted_at < $1', [needTime(before, 'before')])
    },
  }
}
