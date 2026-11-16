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
 *   from 1; anything else is a RangeError.
 * firstUnread(messages, lastRead) → the id of the first message in the list that is newer than `lastRead`, or null.
 *   `lastRead` null or undefined means the reader has read nothing: null, and there is no divider.
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

/** → [{ message, grouped }] for the messages, oldest first. */
export function groupMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError('groupMessages takes a list of messages.')
  const articles = messages.map((message) => isArticle(message, parse(message.content)))
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

/** → the first line of a message as plain text, white space collapsed, at most `max` characters. */
export function excerpt(content, max = 120) {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('The length of an excerpt is a whole number from 1.')
  const text = plainText(parse(content)).replace(WHITE_SPACE, ' ').trim()
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
