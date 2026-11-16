/**
 * How a Librarius post is laid out: which messages are articles, which sit under the one before them, the first line of
 * a message for a list, where the reader stopped, and the months of the date rail. Everything here is pure.
 *
 * A message is what the Librarius routes answer: { id, authorId, content, createdAt (ISO), replyTo, attachments, ... }.
 * Ids are strings of digits and are compared as BigInts: one is wider than a Number holds exactly. A message or a list
 * that is no such thing is a TypeError. A time that is no time never groups a message, so the header shows.
 *
 * isImage(attachment) → whether it is an image: its content type is image/anything.
 * isArticle(message, nodes) → boolean. `nodes` is the parse of the message's content. It is an article, laid out wide,
 *   when its content is 600 characters (UTF-16 units) or more, or has a heading at any depth, or has two images.
 * groupMessages(messages) → [{ message, grouped }], in the same order. `grouped` is true for a message that sits under
 *   the one before it, with no header of its own: the same author id, no more than 7 minutes after it (exactly 7 counts,
 *   and a message dated before it does not), neither an article, and not itself a reply.
 * excerpt(content, max = 120) → the plain text of the content with every run of white space made one space, and cut
 *   with "…" so that it is no more than `max` characters (code points: no pair is cut in two). `max` is a whole number
 *   from 1; anything else is a RangeError. An excerpt is a preview, and a preview never shows a spoiler: each spoiler,
 *   wherever it sits (in bold, a quote, a list, a link's label), is "▒▒▒" whatever it hides, and the cut is made after.
 *   It fails closed: a `||` that no `||` closes (a preview cut the spoiler open, or it runs over lines, or it was escaped
 *   or is a lone bar) is masked from there to the end, and nothing after it is shown. In code a `||` is only text.
 * firstUnread(messages, lastRead) → the id of the first message in the list that is newer than `lastRead`, or null.
 *   `lastRead` null or undefined means the reader has read nothing: null, and there is no divider.
 * isSpoilerFile(nameOrUrl) → whether a file name, or the last segment of an address's path (before any ? or #), begins
 *   with SPOILER_ in any case: Discord's mark for a file its sender hid. Anything but a string is false.
 * ago(iso, now) → how long before `now` (milliseconds) a time was, in the biggest unit that fits: "just now" (under a
 *   minute, or in the future), "5m ago", "3h ago", "12d ago", and from 30 days on a date in the reader's style. A time
 *   that is no ISO string is "". `now` that is no finite number is a TypeError.
 * sortPosts(posts, by) → a new list of the posts, pinned ones first (`pinned` true), then the newest first by
 *   `lastActivityAt` (by 'activity') or `createdAt` (by 'created'); posts that are level, or have no date, keep the
 *   order given, the undated after the dated. Another `by` is a RangeError.
 * repliesText(n) → "1 reply", "7,931 replies"; "" when `n` is no whole number from 0.
 * sizeText(bytes) → "812 B", "1.5 KB", "5.0 MB", "1.1 GB" (1024s, one decimal above bytes); "" when it is no whole
 *   number of bytes from 0.
 * articleMemo() → a function (message) → boolean that answers as isArticle does from the message's own words, once for each
 *   message object. groupMessages(messages, articleOf) takes it (or any such function) in place of reading each message again.
 * samePeople(a, b) → whether two tables { member id: { name, avatar } } name the same people with the same name and avatar.
 * isRead(entry) → whether an IntersectionObserver entry says a message was read: it is in view and at least 60% of it is, or
 *   its bottom edge lies in the viewport (the entry's root bounds), so that a long message counts once it is read to its end.
 * railMonths(createdAt, lastAt) → [{ label: 'Nov 2026', at: Date }], one for each UTC month from the one of `createdAt`
 *   to the one of `lastAt`, oldest first; `at` is the first instant of the month. Each is a Date or an ISO string, on
 *   or after the Discord epoch (a RangeError before it, and for a string that is no date). A `lastAt` before `createdAt`
 *   gives the month of `createdAt` alone. More than 1200 months is a RangeError.
 */
import { parse, plainText, walk } from '../archive/markdown'

const ARTICLE_LENGTH = 600
const ARTICLE_IMAGES = 2
const GROUP_WINDOW_MS = 7 * 60 * 1000
const MAX_MONTHS = 1200
const DISCORD_EPOCH_MS = Date.UTC(2015, 0, 1)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ID = /^\d{1,20}$/
const IMAGE = /^image\//i
const WHITE_SPACE = /\s+/g
const SPOILER_MASK = '▒▒▒'
const SPOILER_OPENER = '||'
const SPOILER_FILE = /^spoiler_/i
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const SORTS = { activity: 'lastActivityAt', created: 'createdAt' }
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']

/** Whether an attachment is a picture, by its content type. */
export const isImage = (attachment) => typeof attachment.contentType === 'string' && IMAGE.test(attachment.contentType)

function hasHeading(nodes) {
  let found = false
  walk(nodes, (node) => {
    if (node.type === 'heading') found = true
  })
  return found
}

/** → whether the message is laid out as an article. */
export function isArticle(message, nodes) {
  if (!Array.isArray(nodes)) throw new TypeError('isArticle needs the parsed nodes of the message.')
  if (typeof message?.content !== 'string' || !Array.isArray(message.attachments)) {
    throw new TypeError('A message needs text content and a list of attachments.')
  }
  return (
    message.content.length >= ARTICLE_LENGTH ||
    message.attachments.filter(isImage).length >= ARTICLE_IMAGES ||
    hasHeading(nodes)
  )
}

const timeOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN)

/** Whether a file name, or the last segment of an address's path, begins SPOILER_ in any case. */
export function isSpoilerFile(nameOrUrl) {
  if (typeof nameOrUrl !== 'string') return false
  const path = nameOrUrl.split(/[?#]/, 1)[0]
  return SPOILER_FILE.test(path.slice(path.lastIndexOf('/') + 1))
}

/** → how long before `now` the time was, in the biggest unit that fits; a date from 30 days on; '' for no time. */
export function ago(iso, now) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a number of milliseconds.')
  const then = timeOf(iso)
  if (Number.isNaN(then)) return ''
  const age = now - then
  if (age < MINUTE_MS) return 'just now'
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m ago`
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h ago`
  if (age < MONTH_MS) return `${Math.floor(age / DAY_MS)}d ago`
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** → a new list: pinned posts first, then the newest first by the date `by` names, ties and undated ones as given. */
export function sortPosts(posts, by) {
  if (!Array.isArray(posts)) throw new TypeError('sortPosts takes a list of posts.')
  if (!Object.hasOwn(SORTS, by)) throw new RangeError("A sort is 'activity' or 'created'.")
  const field = SORTS[by]
  // A date that is no date counts as the oldest.
  const when = (post) => timeOf(post[field]) || 0
  return [...posts].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || when(b) - when(a))
}

/** → "1 reply", "7,931 replies"; '' for what is no count. */
export function repliesText(n) {
  if (!Number.isSafeInteger(n) || n < 0) return ''
  return `${n.toLocaleString('en')} ${n === 1 ? 'reply' : 'replies'}`
}

/** → "812 B", "1.5 KB", "5.0 MB", "1.1 GB"; '' for what is no size. */
export function sizeText(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return ''
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[unit]}`
}

const articleOfMessage = (message) => isArticle(message, parse(message.content))

/**
 * → a function that tells whether a message is an article, as isArticle does from its words, but once for each message
 * object: it keeps its answers, so a list that comes again with most of its messages unchanged is read only for the new
 * ones. A message is never changed in place (an edit is a new object), so an answer for an object stays true. A message that
 * is no message is a TypeError, and no answer is kept for it.
 */
export function articleMemo() {
  const answers = new WeakMap()
  return (message) => {
    if (!answers.has(message)) answers.set(message, articleOfMessage(message))
    return answers.get(message)
  }
}

/** → [{ message, grouped }] for the messages, oldest first. `articleOf` tells whether a message is an article. */
export function groupMessages(messages, articleOf = articleOfMessage) {
  if (!Array.isArray(messages)) throw new TypeError('groupMessages takes a list of messages.')
  const articles = messages.map((message) => articleOf(message))
  return messages.map((message, i) => {
    if (i === 0) return { message, grouped: false }
    const before = messages[i - 1]
    const gap = timeOf(message.createdAt) - timeOf(before.createdAt)
    const grouped =
      message.authorId === before.authorId &&
      gap >= 0 &&
      gap <= GROUP_WINDOW_MS &&
      !articles[i] &&
      !articles[i - 1] &&
      !message.replyTo
    return { message, grouped }
  })
}

/** → the words a text node, or the address of a bare link, shows; undefined for any other node. */
const readable = (node) => (node.type === 'text' ? node.value : node.type === 'url' ? node.href : undefined)

/** → the text up to the first `||` in `text`, then the mask. */
const maskedFrom = (text) => text.slice(0, text.indexOf(SPOILER_OPENER)) + SPOILER_MASK

/**
 * → a copy of the nodes in which every spoiler, nested ones included, is a text node of the mask, and in which the first
 * text or address that holds a `||` (one no spoiler took, so it has no closing `||`) is cut there and ends with the mask,
 * and every node after it, in the reading order, is gone.
 */
function previewNodes(nodes) {
  let closed = false
  const take = (list) => {
    const kept = []
    for (const node of list) {
      if (closed) break
      if (node.type === 'spoiler') kept.push({ type: 'text', value: SPOILER_MASK })
      else if (readable(node)?.includes(SPOILER_OPENER)) {
        closed = true
        kept.push({ type: 'text', value: maskedFrom(readable(node)) })
      } else if (node.children) kept.push({ ...node, children: take(node.children) })
      else if (node.items) kept.push({ ...node, items: node.items.map((item) => ({ ...item, children: take(item.children) })) })
      else kept.push(node)
    }
    return kept
  }
  return take(nodes)
}

/** → the first line of a message as plain text, spoilers masked, white space collapsed, at most `max` characters. */
export function excerpt(content, max = 120) {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('The length of an excerpt is a whole number from 1.')
  const text = plainText(previewNodes(parse(content))).replace(WHITE_SPACE, ' ').trim()
  const characters = Array.from(text)
  if (characters.length <= max) return text
  return characters.slice(0, max - 1).join('').trimEnd() + '…'
}

function idOf(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('An id is a string of 1 to 20 digits.')
  return BigInt(value)
}

/** → the id of the first message newer than `lastRead`, or null. */
export function firstUnread(messages, lastRead) {
  if (!Array.isArray(messages)) throw new TypeError('firstUnread takes a list of messages.')
  if (lastRead === null || lastRead === undefined) return null
  const read = idOf(lastRead)
  const next = messages.find((message) => idOf(message.id) > read)
  return next === undefined ? null : next.id
}

function monthOf(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) throw new TypeError('railMonths takes dates or ISO strings.')
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.getTime() < DISCORD_EPOCH_MS) {
    throw new RangeError('railMonths takes dates from 2015, when Discord began.')
  }
  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}

/** → [{ label, at }] for each UTC month from the one of `createdAt` to the one of `lastAt`. */
export function railMonths(createdAt, lastAt) {
  const first = monthOf(createdAt)
  const last = Math.max(first, monthOf(lastAt))
  if (last - first + 1 > MAX_MONTHS) throw new RangeError(`A date rail has at most ${MAX_MONTHS} months.`)
  const months = []
  for (let n = first; n <= last; n++) {
    const year = Math.floor(n / 12)
    const month = n % 12
    months.push({ label: `${MONTHS[month]} ${year}`, at: new Date(Date.UTC(year, month, 1)) })
  }
  return months
}

const isTable = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const samePerson = (a, b) => a === b || (isTable(a) && isTable(b) && a.name === b.name && a.avatar === b.avatar)

/** → whether two tables of people, { member id: { name, avatar } }, name the same people the same way. */
export function samePeople(a, b) {
  if (a === b) return true
  if (!isTable(a) || !isTable(b)) return false
  const ids = Object.keys(a)
  return ids.length === Object.keys(b).length && ids.every((id) => Object.hasOwn(b, id) && samePerson(a[id], b[id]))
}

const READ_RATIO = 0.6

/**
 * → whether an entry of an IntersectionObserver says the reader has read the message: it is in view, and at least 60% of it
 * is, or its bottom edge is in the viewport (so a message too long to show 60% of itself counts once it is read to its end).
 * The viewport is the observer's root bounds, which the site's header is cut from. Without them only the share counts.
 */
export function isRead(entry) {
  if (entry?.isIntersecting !== true) return false
  if (Number.isFinite(entry.intersectionRatio) && entry.intersectionRatio >= READ_RATIO) return true
  const bottom = entry.boundingClientRect?.bottom
  const root = entry.rootBounds
  return Number.isFinite(bottom) && Number.isFinite(root?.top) && Number.isFinite(root.bottom) && bottom > root.top && bottom <= root.bottom
}
