/**
 * What the Librarius forum's Discord objects turn into. Pure: one Discord thread, message or emoji object in, the
 * row the store keeps out; no network, no storage, no imports (the site may bundle this file later).
 *
 * Discord's text is untrusted, so each row holds only what the Librarius shows, cut to a length and checked to a
 * shape:
 *
 * - ids are snowflakes (strings of 17 to 20 digits) or the row is null, or the field is null;
 * - text is cut to its limit in UTF-16 units and is always something Postgres can store: U+0000 is dropped, a lone
 *   surrogate becomes U+FFFD, and a cut never leaves half of an emoji;
 * - links are the ones the site may load: attachments from Discord's CDN, embed images through Discord's media
 *   proxy only (an outside image address is never kept), and embed links over https;
 * - timestamps are ISO times Postgres will take, from Discord's own epoch on, else the time inside the snowflake.
 *
 * A parser never throws, whatever it is given: what it cannot read is null, or it is left out of the row.
 */

/** The message types the Librarius keeps: default, reply, slash-command result and context-command result. */
export const MESSAGE_KINDS = new Set([0, 19, 20, 23])

const DISCORD_EPOCH = 1420070400000n
const EPOCH_MS = 1420070400000
// The last second an ISO time of four year digits can hold, 9999-12-31T23:59:59Z.
const LAST_SECOND = 253402300799
// The largest value of a Postgres integer column.
const INT_MAX = 2147483647

const SNOWFLAKE = /^\d{17,20}$/
const HEX = /^[0-9a-f]+$/i
const EX_PARAM = /[?&]ex=([^&]*)/
const AVATAR_HASH = /^(?:a_)?[0-9a-f]{32}$/
const EMOJI_NAME = /^\w{1,32}$/
const HIGH_SURROGATE_END = /[\uD800-\uDBFF]$/
// Discord's own shape, to the second, with a zone Postgres takes. The day of the month is checked apart, since
// 31 February is a shape that passes.
const ISO_TIME =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/
const MEDIA_PROXY = /^https:\/\/(?:media|images-ext-\d+)\.discordapp\.net\//

const CDN_ATTACHMENTS = 'https://cdn.discordapp.com/attachments/'
const MEDIA_ATTACHMENTS = 'https://media.discordapp.net/attachments/'

const isId = (v) => typeof v === 'string' && SNOWFLAKE.test(v)
// A plain object, not null and not a list.
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = (v) => (Array.isArray(v) ? v : [])
// A whole number from 1 to INT_MAX, else null: what a width or a height may be.
const dimension = (n) => (Number.isSafeInteger(n) && n > 0 && n <= INT_MAX ? n : null)

/**
 * The text cut to `max` UTF-16 units, always something Postgres can store, or '' when it is no string. U+0000 goes
 * first, then any lone surrogate becomes U+FFFD, then the cut, which never leaves the first half of a pair.
 */
function clean(v, max) {
  if (typeof v !== 'string') return ''
  const cut = v.replaceAll('\u0000', '').toWellFormed().slice(0, max)
  return HIGH_SURROGATE_END.test(cut) ? cut.slice(0, -1) : cut
}

/** The link as a URL, or null when it is no string or no URL. */
function parseUrl(v) {
  if (typeof v !== 'string') return null
  try {
    return new URL(v)
  } catch {
    return null
  }
}

/**
 * The link, normalised, when it starts with `prefix` both as written and once parsed, else null. The parsed check
 * is what stops `/attachments/../avatars/`. The prefix names the scheme and host, so what follows can be any text
 * and `new URL` cannot throw.
 */
function under(v, prefix) {
  if (typeof v !== 'string' || !v.startsWith(prefix)) return null
  const href = new URL(v).href
  return href.startsWith(prefix) ? href : null
}

/**
 * The link, normalised, when it is on Discord's CDN attachments path, else null. This is the check the url of an attachment
 * passes when a message is parsed, and a caller that holds a link of its own, a refreshed one say, must pass the same
 * one before it keeps it.
 */
export const attachmentUrl = (v) => under(v, CDN_ATTACHMENTS)

/**
 * The text when it is an ISO time Postgres will take, a real day and not before Discord began, else null. The text
 * itself comes back, not a rewrite of it.
 */
function isoTime(v) {
  const m = typeof v === 'string' ? ISO_TIME.exec(v) : null
  if (m === null) return null
  // A day that does not exist, 31 February, rolls over into the next month when it is made into a date.
  const real = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDate() === Number(m[3])
  return real && Date.parse(v) >= EPOCH_MS ? v : null
}

/**
 * → the time inside a snowflake, as a Date. Throws TypeError unless `id` is a string of 17 to 20 digits: every
 * parser below checks its ids first, so this only throws for a caller that did not.
 */
export function snowflakeTime(id) {
  if (!isId(id)) throw new TypeError('snowflakeTime needs a snowflake: a string of 17 to 20 digits')
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH))
}

/**
 * → the ISO time a signed Discord link expires at, from its `ex` query parameter (hex seconds), else null: for no
 * link, no `ex`, one that is not plain hex, or one a four-digit year cannot hold. When `ex` is given twice, the
 * first one counts.
 */
export function linkExpiry(url) {
  const link = parseUrl(url)
  if (link === null) return null
  const found = EX_PARAM.exec(link.search)
  if (found === null || !HEX.test(found[1])) return null
  const seconds = parseInt(found[1], 16)
  return seconds > LAST_SECOND ? null : new Date(seconds * 1000).toISOString()
}

/**
 * → { id, ownerId, title, tagIds, pinned, locked, archived, createdAt } for a thread of the forum `forumId`, else
 * null: for anything that is not an object, a thread under another parent, a thread without a snowflake id, or a
 * `forumId` that is not itself a snowflake (so an unset forum never matches a thread with no parent).
 */
export function parseThread(raw, forumId) {
  if (!isObj(raw) || !isId(forumId) || raw.parent_id !== forumId || !isId(raw.id)) return null
  const meta = raw.thread_metadata
  return {
    id: raw.id,
    ownerId: isId(raw.owner_id) ? raw.owner_id : null,
    title: clean(raw.name, 100),
    tagIds: list(raw.applied_tags).filter(isId).slice(0, 5),
    // The PINNED flag. A flags value that is no whole number, a string "2" included, pins nothing.
    pinned: Number.isInteger(raw.flags) && (raw.flags & 2) !== 0,
    locked: meta?.locked === true,
    archived: meta?.archived === true,
    createdAt: isoTime(meta?.create_timestamp) ?? snowflakeTime(raw.id).toISOString(),
  }
}

/**
 * → { key, id, name, animated } for an emoji as Discord names it (a reaction's, or an emoji object's), else null.
 * Custom emoji have a snowflake `id`, and a `name` of word characters, which Discord leaves null for one that was
 * deleted. Unicode emoji have no id and a `name` of the emoji itself, 1 to 32 units, as Discord sent it.
 */
function emojiOf(e) {
  if (!isObj(e)) return null
  const animated = e.animated === true
  if (e.id === null || e.id === undefined) {
    // Cleaning leaves a good name as it is, so any change means it was not one.
    const name = clean(e.name, 32)
    return name !== '' && name === e.name ? { key: `u:${name}`, id: null, name, animated } : null
  }
  if (!isId(e.id)) return null
  const named = typeof e.name === 'string' && EMOJI_NAME.test(e.name)
  return { key: `c:${e.id}`, id: e.id, name: named ? e.name : null, animated }
}

/** → the key a reaction is counted under: `c:<id>` for a custom emoji, `u:<name>` for a unicode one, else null. */
export function emojiKey(emoji) {
  return emojiOf(emoji)?.key ?? null
}

/**
 * → [{ id, name, animated }] for the guild's custom emoji, from Discord's list of them. Emoji without a snowflake
 * id and a name of 1 to 32 word characters are left out, and so is anything that is not a list.
 */
export function parseEmoji(emoji) {
  const out = []
  for (const raw of list(emoji)) {
    const e = emojiOf(raw)
    if (e !== null && e.id !== null && e.name !== null) out.push({ id: e.id, name: e.name, animated: e.animated })
  }
  return out
}

/**
 * → the reactions with one emoji's count changed by `delta`, as a new list; the one given is not touched. An emoji
 * already in the list is changed in place, a new one is added at the end, and one that reaches zero is dropped, so
 * a count is never below one and taking from an emoji that is not there changes nothing. An emoji that cannot be
 * keyed, which a gateway event could send, changes nothing. Throws TypeError unless `delta` is a whole number:
 * that is the caller's own mistake and no data.
 */
export function applyReaction(reactions, emoji, delta) {
  if (!Number.isSafeInteger(delta)) throw new TypeError('applyReaction needs a whole number for delta')
  const rows = list(reactions)
  const e = emojiOf(emoji)
  if (e === null) return [...rows]
  const at = rows.findIndex((r) => r?.key === e.key)
  if (at === -1) return delta > 0 ? [...rows, { ...e, count: delta }] : [...rows]
  const had = Number.isSafeInteger(rows[at].count) ? rows[at].count : 0
  const count = had + delta
  if (count < 1) return rows.filter((_, i) => i !== at)
  return rows.map((r, i) => (i === at ? { ...r, count } : r))
}

/** → the row for one attachment, without its position, or null for one that is not safe or whole. */
function attachmentRow(a) {
  if (!isObj(a) || !isId(a.id)) return null
  const url = attachmentUrl(a.url)
  const hasProxy = a.proxy_url !== null && a.proxy_url !== undefined
  const proxyUrl = hasProxy ? under(a.proxy_url, MEDIA_ATTACHMENTS) : null
  if (url === null || (hasProxy && proxyUrl === null)) return null
  // The column is an integer that cannot be null, so an attachment with no usable size cannot be stored.
  if (!Number.isSafeInteger(a.size) || a.size < 0 || a.size > INT_MAX) return null
  return {
    id: a.id,
    filename: clean(a.filename, 200),
    contentType: clean(a.content_type, 100) || null,
    // `|| 0`: a size of minus zero is a size of zero, and is stored as one.
    size: a.size || 0,
    width: dimension(a.width),
    height: dimension(a.height),
    url,
    proxyUrl,
    expiresAt: linkExpiry(url),
  }
}

/** → { url, width, height } for an embed's image, only when it is the media proxy's copy, else null. */
function embedImage(img) {
  if (!isObj(img)) return null
  const url = parseUrl(img.proxy_url)
  return url !== null && MEDIA_PROXY.test(url.href)
    ? { url: url.href, width: dimension(img.width), height: dimension(img.height) }
    : null
}

/** → the row for one embed, or null for one that is no object. */
function embedRow(e) {
  if (!isObj(e)) return null
  const link = parseUrl(e.url)
  return {
    type: clean(e.type, 32) || null,
    url: link !== null && link.protocol === 'https:' ? link.href : null,
    title: clean(e.title, 256) || null,
    description: clean(e.description, 4096) || null,
    provider: clean(e.provider?.name, 256) || null,
    thumbnail: embedImage(e.thumbnail),
    image: embedImage(e.image),
  }
}

/** → the reaction rows of a message, minus the bot's own reaction, and without any left at zero. */
function reactionRows(raw) {
  const out = []
  for (const r of list(raw)) {
    if (!isObj(r)) continue
    const e = emojiOf(r.emoji)
    if (e === null || !Number.isSafeInteger(r.count)) continue
    const count = r.count - (r.me === true ? 1 : 0)
    if (count >= 1) out.push({ ...e, count })
  }
  return out
}

/**
 * → { id, postId, authorId, authorName, authorAvatar, webhookId, kind, content, embeds, stickers, reactions,
 * replyTo, createdAt, editedAt, attachments } for a Discord REST message of a kind in MESSAGE_KINDS, else null: for
 * anything that is not an object, a message without a snowflake id or channel, or without an author with a
 * snowflake id.
 */
export function parseMessage(raw) {
  if (!isObj(raw) || !MESSAGE_KINDS.has(raw.type) || !isId(raw.id) || !isId(raw.channel_id)) return null
  const { author } = raw
  if (!isObj(author) || !isId(author.id)) return null
  const avatar = typeof author.avatar === 'string' && AVATAR_HASH.test(author.avatar) ? author.avatar : null
  return {
    id: raw.id,
    postId: raw.channel_id,
    authorId: author.id,
    authorName: clean(author.global_name, 80) || clean(author.username, 80) || author.id,
    authorAvatar: avatar === null ? null : `https://cdn.discordapp.com/avatars/${author.id}/${avatar}.png?size=64`,
    webhookId: isId(raw.webhook_id) ? raw.webhook_id : null,
    // `|| 0`: MESSAGE_KINDS.has(-0) is true, and minus zero must not reach the row as the kind.
    kind: raw.type || 0,
    content: clean(raw.content, 4000),
    embeds: list(raw.embeds).map(embedRow).filter((e) => e !== null).slice(0, 10),
    stickers: list(raw.sticker_items)
      .filter((s) => isObj(s) && isId(s.id))
      .slice(0, 3)
      .map((s) => ({ id: s.id, name: clean(s.name, 100) })),
    reactions: reactionRows(raw.reactions),
    replyTo: raw.type === 19 && isId(raw.message_reference?.message_id) ? raw.message_reference.message_id : null,
    createdAt: isoTime(raw.timestamp) ?? snowflakeTime(raw.id).toISOString(),
    editedAt: isoTime(raw.edited_timestamp),
    attachments: list(raw.attachments)
      .map(attachmentRow)
      .filter((a) => a !== null)
      .slice(0, 10)
      .map((a, position) => ({ ...a, position })),
  }
}
