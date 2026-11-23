/**
 * A site reply, written in the extended markdown of librariusMarkdown.js, as the Discord messages it is sent as. Pure, and
 * shared: the composer's meter and Discord view run it in the browser, the outbox on the server, and the two agree to the
 * character, so a reply the meter accepts never fails in Discord for its length. Its one import is the parser.
 *
 * toDiscord(source, { form, authorId, replyTo, siteUrl, images, thread }) → { parts, length, overBudget }
 *   form: 'v2' (the default, Discord's Components V2) or 'plain' (messages of text). authorId: the member who wrote it.
 *   replyTo: { authorId, url } or null. siteUrl: the link of the "Open On Site" button. images: [{ ref, name }], the file
 *   name each `upload:N` of the source is attached as. thread: optional { urlBase, partIds }, the links of markers(): the
 *   ids of the parts already sent (null for one not sent yet; fewer ids than parts is fine), so that the outbox can send
 *   part 1, then each later part with its link back, then edit part 1 with the links forward. The parts are cut in the same
 *   places whatever `thread` holds, because the room for those links is reserved either way.
 *   Each part is { text, components, files }: `components` is null in the plain form, where `text` is the message; in the
 *   V2 form `components` is the message (one Container) and `text` its Text Displays joined by a line end, the nearest a V2
 *   message has to a content. `files` are the names of the images to attach, once each. `length` is the characters of the
 *   reply itself (its text and the footnotes), without the markers, the reply line or the footer. `overBudget` is true when
 *   it needs more than MAX_PARTS parts: the parts are still all answered, but must not be sent. It is `overBudget`, not
 *   `length`, that tells whether a reply fits: a reply is cut at paragraphs, so it can need a fourth part with room to spare.
 *   Bad options are a TypeError (a wrong kind of value) or a RangeError (a wrong value); a source of any text is fine.
 *
 * What a part holds, top to bottom: the reply line `-# ↪ <@id> [jump](<url>)` (part 1), the link back `-# [↑ from 1/N](<url>)`
 * (parts after the first), the reply with `**k/N** ` before its first line when there is more than one part, the footnotes
 * its text cites, the links forward `-# continues: [2/N](<url>) · [3/N](<url>)` (part 1), and on the last part the footer
 * `-# <@authorId>` with a link button "Open On Site" in V2, or `-# <@authorId> · [Open On Site](<siteUrl>)` in plain.
 * Flattening of what Discord has no syntax for:
 * - headings 4 to 6 are a bold line, a table a code block of cells padded to the width of their column, a divider a
 *   Separator (a blank line in plain), and a footnote reference stays as written and its note is listed in each part that
 *   cites it (a note that no text cites goes at the end of the reply, as do the notes of a line that cites more than 400
 *   characters of them);
 * - an image is a Media Gallery item where it was written, and in the plain form is attached to its part. One written
 *   inside a line is shown after the line. An image with no file in `images` shows its alt text, as the site does;
 * - a code block cut by a part is closed at the cut and opened again after it, so each part shows it as code;
 * - so is a spoiler, or bold, italic, underline, strike or inline code, that a cut falls in: its mark ends the part (after the
 *   last word, not a space) and opens again where the next part starts, after the mark of the part and a quote's mark. A
 *   spoiler is never left open at the end of a part, for Discord would show the bars and hide nothing. A cut between the
 *   lines of a spoiler is one of the last choices among the line ends, the way one inside a code block is, and none falls
 *   inside a mark or an escape. None falls right before the mark that closes one that is open (spaces left out), for the next
 *   part would open it again and start with bars that close nothing, which Discord pairs with the next ones, showing every
 *   spoiler between them; nor right after the mark that opens one, for its part would end with bars that hide nothing. Where no
 *   other place is left (a spoiler of spaces), the mark that a cut leaves with nothing in it is given something to hold: a space
 *   for a spoiler (`|| ||`, which pairs with itself), a zero-width space for any other, as Discord takes no italic or strike of
 *   a space;
 * - an italic that comes right after another is written as one, since `*a**b*` is not two italics, and one inside another as its
 *   text, since `**a**` is bold; so is a bold inside a bold, which `***` makes (a bold that holds an italic), since Discord would
 *   read `***||**a**||***` as an italic of two bolds and show `a`; two marks of one character that touch (`*a*` then `**b**`,
 *   `**a**` then `**b**`, `__`, code) have a zero-width space between them, else Discord's lazy rules would read their marks
 *   together and pair them with later ones;
 * - an italic or a strike that starts or ends with a space has the space written outside its marks (`*a* ` for an italic of `a `
 *   and a picture), since Discord takes neither so, and would pair its marks with later ones;
 * - a line of a spoiler, but its first and its last, that shows nothing but spaces (a picture that is attached, a mark of spaces)
 *   is left out, since a blank line would end the block, and the spoiler's bars would pair with no other;
 * - the text that starts a line is escaped (`\#`, `\-`, `1\.`) after a line break inside a spoiler too, and at the start of a part
 *   that starts inside a line, where its mark is followed by a space and not a line end: what was in the middle of a line is no
 *   heading, list item or quote.
 *
 * Limits. Discord counts every displayable character of a V2 message, button label included, against 4000 (measured), and
 * the content of a plain message against 2000. The body of a part is cut at the lesser of PRIMARY_LIMIT (PLAIN_LIMIT)
 * and what is left of 4000 (2000) once the reply line, the marker, the links, the footnotes and the footer are counted
 * at the longest they can be, so no part is over, whatever the links. A V2 message may also hold 40 components, counted
 * with the ones inside others, so a part keeps to MAX_SPECIALS dividers and image breaks. Lengths are in UTF-16 code
 * units, which is never fewer than the characters Discord counts.
 *
 * split(text, limit) → string[]: the text as parts no longer than `limit`, each with its `**k/N** ` mark when there is more
 * than one, and put back together once the marks are off. A part ends at the latest blank line that fits; else at the latest
 * line end outside a code fence, list or table; else between the lines of one; else at a sentence end (`. `, `! ` or `? `),
 * else after a space, else anywhere, but never inside a surrogate pair. The mark is followed by a line end rather than a
 * space when its part starts with block syntax (a heading, list, quote or fence), which a space would turn into text, but
 * only where the part starts at the start of a line: one that starts inside a line has its text after a space, as it was.
 * A split of text that is no reply closes and opens nothing again.
 *
 * markers(partIds, threadUrlBase) → one line for each part: part 1's links forward and the others' link back, null where
 * a line needs a message id that is null (not sent yet), '' for a reply in one part.
 * budget(source, options) → { used, limit, parts }, for the composer's meter: `used` is toDiscord's `length`, `limit` the
 * body room of MAX_PARTS parts, `parts` how many parts the reply needs.
 * displayableLength(part) → the characters of a part that Discord counts against its limit.
 * limitFor(form) → the body budget of a part of that form.
 * placement(source, options) → number[][]: for each part, the refs of the pictures it carries (the N of each `upload:N` that
 *   has a file in `images`), in the order the part shows them, each once. The empty parts that end the list are left off, so
 *   that two placements are the same when `JSON.stringify` says so. It takes the options of toDiscord and cuts the reply as it
 *   does (`thread` changes nothing), so it says where a reply's pictures fell when it was sent, and where an edit of its text
 *   would put them. Pictures are fixed when a reply is sent, since a webhook cannot change the files of a message: an edit
 *   that would move or change one is refused (the outbox does, and so does the route). Two refs may not share a file name. It
 *   answers for a reply that is over budget too: it only says where the pictures fall.
 */
import { parse } from './librariusMarkdown.js'

export const FORMS = Object.freeze(['v2', 'plain'])
export const DEFAULT_FORM = 'v2'
export const PRIMARY_LIMIT = 3950
export const PLAIN_LIMIT = 1950
export const MAX_PARTS = 3

const BODY_LIMIT = { v2: PRIMARY_LIMIT, plain: PLAIN_LIMIT }
// What Discord refuses a message over: the displayable text of a V2 message, the content of a plain one.
const HARD_LIMIT = { v2: 4000, plain: 2000 }
// The least a mark leaves room for, so that every part is made of something.
const MIN_SPLIT_LIMIT = 32
const MAX_URL = 200
// A V2 part holds 2n + 4 components for n dividers and image breaks, and Discord takes 40.
const MAX_SPECIALS = 17
// The most the notes that one line cites may take on a part. A line that cites more has them listed at the end instead.
const NOTE_ROOM = 400
const BUTTON_LABEL = 'Open On Site'
const TEXT_DISPLAY = 10
const BUTTON = 2
const MEDIA_GALLERY = 12
const GALLERY_ITEMS = 10
const SEPARATOR = 14
const CONTAINER = 17
const ACTION_ROW = 1
const LINK_STYLE = 5

const ID = /^\d{17,20}$/
const NAME = /^\w[\w.-]{0,99}$/
const LANG = /^[\w+-]{1,20}$/
const HTTPS_URL = /^https:\/\/[^\s<>]+$/
const THREAD_BASE = /^https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}$/
// A character code unit with no partner: Discord refuses it, so it becomes the replacement character.
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
// Where a part may start with its mark on the same line: block syntax there would turn into text.
const BLOCK_START = /^[ \t]*(?:#{1,6} |-# |[-*] |\d{1,9}\. |>|```)/
const MARKS = /[\\*_~|`<[\]]/g
// What at the start of a line would make it a heading, a list item, subtext or a quote, and where to put the backslash: before
// it, or between the number of an ordered list and its full stop.
const LINE_START = /^([ \t]*(?:\d{1,9}(?=\. )|(?=#{1,3} |-(?: |# )|>)))/
const FENCE = /^((?:[ \t]*>)*[ \t]*)```/
const LIST_ROW = /^(?:[ \t]*>)*[ \t]*(?:[-*]|\d{1,9}\.) /
const PIPE = /(?<!\|)\|(?!\|)/
const GAP = /\s/
const NONE = Object.freeze([])
// What Discord shows as nothing, and reads as a character: it keeps marks apart, and an empty mark from being empty.
const ZWSP = '\u200b'
// The characters of the marks that Discord reads together with a mark of the same character that touches them.
const TOUCHING = '*_`'
// What of a quote's mark a row starts with, which stands before anything that is opened again at its start.
const QUOTE = /^(?:[ \t]*>)*[ \t]*/
// The marks that show as markup in a row, and what hides one: an escaped character, a link or mention in angle brackets, a span
// of code. Text is escaped, so every other mark in a row is one of the form's own.
const MARK = /\*\*|\*|\|\||__|~~/g
const MARK_TOKEN = /\\[\s\S]|<[^>]*>|``[\s\S]+?``|`[^`]+`|\|\||\*+|__|~~/g

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** → the form, which is the default when none is given; anything else but a form is a RangeError. */
function formOf(form) {
  const chosen = form === undefined ? DEFAULT_FORM : form
  if (!FORMS.includes(chosen)) throw new RangeError('form must be "v2" or "plain"')
  return chosen
}

/** The words a reply with a picture inside a spoiler is refused in, by the server (librariusSend.js validateReply) and the composer alike. */
export const PICTURE_IN_SPOILER = "A picture can't go inside a spoiler yet: put it outside the bars."

/**
 * → whether a parsed reply (`nodes`, as parse() gives them) has a picture inside a spoiler: an `image` node anywhere under a `spoiler`
 * node, however deep, whatever the spoiler holds. The site hides such a picture, but toDiscord sends it as a Media Gallery item or a
 * file that nothing hides, which Discord shows to every reader, so a reply with one is refused until the form can send it hidden.
 * Every value of every node is looked through, not only the children the parser makes now, so that a spoiler that holds whole lines or
 * blocks is read with no change here. The walk keeps a list of what is left to look at, so no depth of nesting runs out of stack.
 */
export function pictureInSpoiler(nodes) {
  const left = [{ value: nodes, hidden: false }]
  while (left.length > 0) {
    const { value, hidden } = left.pop()
    if (typeof value !== 'object' || value === null) continue
    if (hidden && value.type === 'image') return true
    const inside = hidden || value.type === 'spoiler'
    for (const child of Object.values(value)) left.push({ value: child, hidden: inside })
  }
  return false
}

export function limitFor(form) {
  if (!FORMS.includes(form)) throw new RangeError('form must be "v2" or "plain"')
  return BODY_LIMIT[form]
}

function idOf(value, what) {
  if (typeof value !== 'string' || !ID.test(value)) throw new RangeError(`${what} must be a Discord id`)
  return value
}

function urlOf(value, what) {
  if (typeof value !== 'string' || value.length > MAX_URL || !HTTPS_URL.test(value)) {
    throw new RangeError(`${what} must be an https link of at most ${MAX_URL} characters, with no space or angle bracket`)
  }
  return value
}

function baseOf(value) {
  if (typeof value !== 'string' || !THREAD_BASE.test(value)) throw new RangeError('the thread link must be https://discord.com/channels/<guild id>/<thread id>')
  return value
}

function idsOf(partIds, what, least) {
  if (!Array.isArray(partIds)) throw new TypeError(`${what} must be a list`)
  if (partIds.length < least || partIds.length > MAX_PARTS) throw new RangeError(`${what} must hold ${least} to ${MAX_PARTS} ids`)
  return partIds.map((id) => (id === null ? null : idOf(id, `${what} entry`)))
}

function replyOf(replyTo) {
  if (replyTo === null || replyTo === undefined) return null
  if (typeof replyTo !== 'object') throw new TypeError('replyTo must be an object or null')
  return { authorId: idOf(replyTo.authorId, 'replyTo.authorId'), url: urlOf(replyTo.url, 'replyTo.url') }
}

function imagesOf(images) {
  const names = new Map()
  if (images === undefined) return names
  if (!Array.isArray(images)) throw new TypeError('images must be a list')
  for (const image of images) {
    if (!isObject(image)) throw new TypeError('images must hold objects')
    const { ref, name } = image
    if (!Number.isInteger(ref) || ref < 1 || ref > 10) throw new RangeError('an image ref must be a whole number from 1 to 10')
    if (typeof name !== 'string' || !NAME.test(name)) throw new RangeError('an image name must be a plain file name')
    if (names.has(ref)) throw new RangeError(`image ref ${ref} is given twice`)
    names.set(ref, name)
  }
  return names
}

function threadOf(thread) {
  if (thread === undefined) return null
  if (!isObject(thread)) throw new TypeError('thread must be an object')
  return { base: baseOf(thread.urlBase), ids: idsOf(thread.partIds, 'thread.partIds', 0) }
}

/** → the options, checked and in the form the rest of the module reads. */
function settle(source, options) {
  if (typeof source !== 'string') throw new TypeError('the source must be a string')
  if (!isObject(options)) throw new TypeError('the options must be an object')
  return {
    form: formOf(options.form),
    authorId: idOf(options.authorId, 'authorId'),
    replyTo: replyOf(options.replyTo),
    siteUrl: urlOf(options.siteUrl, 'siteUrl'),
    images: imagesOf(options.images),
    thread: threadOf(options.thread),
  }
}

export function markers(partIds, threadUrlBase) {
  const ids = idsOf(partIds, 'partIds', 1)
  const base = baseOf(threadUrlBase)
  const n = ids.length
  if (n === 1) return ['']
  const later = ids.slice(1)
  const continues = later.includes(null) ? null : `-# continues: ${later.map((id, i) => `[${i + 2}/${n}](<${base}/${id}>)`).join(' · ')}`
  const back = ids[0] === null ? null : `-# [↑ from 1/${n}](<${base}/${ids[0]}>)`
  return [continues, ...Array(n - 1).fill(back)]
}

// The room kept for these lines, whatever ids they come to: the longest they can be.
const WORST_ID = '9'.repeat(20)
const WORST = markers(Array(MAX_PARTS).fill(WORST_ID), `https://discord.com/channels/${WORST_ID}/${WORST_ID}`)
const CONTINUES_RESERVE = WORST[0].length
const BACK_RESERVE = WORST[1].length

/** → the width of the mark of a part, `**k/N** `, in a reply of n parts. */
const markWidth = (n) => 2 * String(n).length + 6

const textRow = (text, cites = NONE) => ({ text, eol: true, cites, special: null })
const specialRow = (special, name) => ({ text: '', eol: false, cites: NONE, special, name })

const isBlank = (row) => row.text.trim() === ''

/** → the text as it must be written to show as it is: a mark that Discord would take for markup is escaped. */
function escape(value, atStart) {
  const marked = value.replace(MARKS, '\\$&')
  return atStart ? marked.replace(LINE_START, '$1\\') : marked
}

/**
 * → a mark round what its node holds. One inside a mark of its own kind is the text it holds, for Discord closes a mark at the first
 * chance: `**a**` in an italic is bold, and `***||**a**||***` (a bold that holds an italic, a spoiler and a bold) would be read as an
 * italic of two bolds, the one in the spoiler closing the one before it. A mark of nothing but spaces, or of a picture that is attached,
 * is what it holds. Discord takes no italic or strike (`flanked`) that starts or ends with a space, and leaves its marks to pair with
 * later ones, so the spaces at the edges of one are written outside its marks: `*a* ` for an italic of `a `.
 */
const wrapped = (mark, flanked) => (node, ic) => {
  if (ic.open.has(mark)) return inline(node.children, ic)
  ic.open.add(mark)
  const text = inline(node.children, ic)
  ic.open.delete(mark)
  if (text.trim() === '') return text
  if (!flanked) return `${mark}${text}${mark}`
  const from = text.length - text.trimStart().length
  const to = text.trimEnd().length
  return `${text.slice(0, from)}${mark}${text.slice(from, to)}${mark}${text.slice(to)}`
}

const INLINE = {
  text: (node, ic, atStart) => escape(node.value, atStart),
  code: (node) => (node.text.includes('`') ? `\`\`${node.text.startsWith('`') ? ' ' : ''}${node.text}\`\`` : `\`${node.text}\``),
  emoji: (node) => node.raw,
  mention: (node) => node.raw,
  url: (node) => `<${node.href.replaceAll('>', '%3E')}>`,
  link: (node, ic) => {
    const text = inline(node.children, ic)
    return text.trim() === '' ? `<${node.href}>` : `[${text}](<${node.href}>)`
  },
  image: (node, ic, atStart) => {
    const name = ic.names.get(node.ref)
    if (name === undefined || ic.alt) return escape(node.alt, atStart)
    ic.images.push(name)
    return ''
  },
  footnoteRef: (node, ic) => {
    ic.cites.add(node.label)
    return `\\[^${escape(node.label)}]`
  },
  // A bold heading is a bold, and holds no bold of its own: two pairs of asterisks in one would end it early.
  strong: wrapped('**', false),
  // An italic inside an italic is the text it holds: Discord has no such thing, and `**a**`, or `**a* b*`, would be read as bold.
  em: wrapped('*', true),
  underline: wrapped('__', false),
  strike: wrapped('~~', true),
  spoiler: wrapped('||', false),
  br: () => '\n',
}

/** → inline nodes as Discord markdown. An image has no place in the text: `ic.images` collects it, to show after the line. */
function inline(nodes, ic, atStart = false) {
  let out = ''
  // A line starts where the first thing that is shown does, and after a line break: a picture shows nothing here, so what follows
  // it is the start.
  let start = atStart
  // Whether `out` ends with the mark that closes an italic. An italic that starts with its mark next is joined to it, since `*a**b*`
  // is not two italics but an italic with bold marks in it.
  let italic = false
  for (const node of nodes) {
    // A line of a spoiler after its first that shows nothing but spaces (a picture that is attached, a mark of spaces) is left out with
    // its line break: a blank line ends a block, and the bars on either side of it would pair with no other, showing what they hold. (The
    // first line holds the bars that open the spoiler.) Only the last line is read, so a spoiler of many lines takes the time of its length.
    const end = out.lastIndexOf('\n')
    const piece = node.type === 'br' && end !== -1 && out.slice(end + 1).trim() === '' ? '' : INLINE[node.type](node, ic, start)
    // An italic of nothing but spaces, or of a picture that is attached, is written as what it holds, with no mark, and so is one
    // inside an italic. One with a space at an edge has the space outside its marks, so it may start or end with no mark.
    const isItalic = node.type === 'em' && !ic.open.has('*') && piece.trim() !== ''
    // Any other mark that starts with the character `out` ends with has a zero-width space before it: `*a***b**` is read as an
    // italic of `a**`, and the bold left over pairs with the next one, however far on. (After an escape it changes nothing.)
    const joint = out.at(-1)
    out = isItalic && italic && piece.startsWith('*') ? out.slice(0, -1) + piece.slice(1) : out + (TOUCHING.includes(joint) && piece.startsWith(joint) ? ZWSP : '') + piece
    if (isItalic) italic = piece.endsWith('*')
    else if (piece !== '') italic = false
    start = node.type === 'br' || (start && piece === '')
  }
  return out
}

const flat = (node, cites) => cellText(node.children, cites)
// What a table cell shows in a code block, where nothing is marked up: the text, with a link's address after it.
const CELL = {
  text: (node) => node.value,
  code: (node) => node.text,
  emoji: (node) => `:${node.name}:`,
  mention: (node) => node.raw,
  url: (node) => node.href,
  link: (node, cites) => `${flat(node, cites)} (${node.href})`,
  image: (node) => node.alt,
  footnoteRef: (node, cites) => {
    cites.add(node.label)
    return `[^${node.label}]`
  },
  strong: flat,
  em: flat,
  underline: flat,
  strike: flat,
}

function cellText(nodes, cites) {
  let out = ''
  for (const node of nodes) out += CELL[node.type](node, cites)
  return out
}

/**
 * → the text with every run of three backticks kept from closing, or opening, a code block: a zero-width space after every pair of
 * backticks that another follows, so that a run of any length is pairs of two and a last one or two (five are two, two and one).
 * Writing each three as two, the space and one would not do: that ends with a backtick, which makes a run with the two that start
 * the next three.
 */
const defuse = (text) => text.replace(/``(?=`)/g, `\`\`${ZWSP}`)

/** → { text, cites, images } of a line, heading or subtext node; the text is '' when there is nothing to show but images. */
function render(node, names) {
  // `open` holds the marks that what is written is inside: a bold heading is in a bold.
  const bold = node.level > 3
  const ic = { names, cites: new Set(), images: [], alt: false, open: new Set(bold ? ['**'] : []) }
  const text = inline(node.children, ic, true)
  let shown = ''
  if (text.trim() !== '') {
    if (bold) shown = `**${text}**`
    else if (node.type === 'heading') shown = `${'#'.repeat(node.level)} ${text}`
    else shown = node.type === 'subtext' ? `-# ${text}` : text
  }
  return { text: shown, cites: [...ic.cites], images: ic.images }
}

function noteLine(item, names) {
  const ic = { names, cites: new Set(), alt: true, open: new Set() }
  return `-# \\[^${escape(item.label)}]: ${inline(item.children[0].children, ic)}`
}

/** Adds the text as rows, a row to a line, each behind the quote mark (a blank one behind it without the space). */
function put(s, prefix, text, cites = NONE) {
  for (const line of text.split('\n')) s.rows.push(textRow(line === '' ? prefix.trimEnd() : prefix + line, cites))
}

function putText(s, prefix, text, cites, images) {
  if (text !== '') put(s, prefix, text, cites)
  for (const name of images) s.rows.push(specialRow('image', name))
}

function textBlock(node, s, prefix) {
  const r = render(node, s.names)
  putText(s, prefix, r.text, r.cites, r.images)
}

function list(node, s, prefix, depth) {
  for (const item of node.items) {
    const [head, ...nested] = item.children
    const r = render(head, s.names)
    putText(s, prefix, r.text === '' ? '' : `${'  '.repeat(depth)}${item.marker} ${r.text}`, r.cites, r.images)
    for (const child of nested) list(child, s, prefix, depth + 1)
  }
}

function table(node, s, prefix) {
  const grid = [node.head, ...node.rows].map((cells) => {
    const cites = new Set()
    const texts = cells.map((cell) => defuse(cellText(cell, cites).replace(/\s+/g, ' ').trim()))
    return { texts, cites: [...cites] }
  })
  const widths = node.head.map((_, i) => Math.max(1, ...grid.map((row) => row.texts[i].length)))
  const line = (texts) => `| ${texts.map((t, i) => t.padEnd(widths[i])).join(' | ')} |`
  put(s, prefix, '```')
  put(s, prefix, line(grid[0].texts), grid[0].cites)
  put(s, prefix, line(widths.map((w) => '-'.repeat(w))))
  for (const row of grid.slice(1)) put(s, prefix, line(row.texts), row.cites)
  put(s, prefix, '```')
}

const BLOCKS = {
  blank: (node, s, prefix) => put(s, prefix, ''),
  line: textBlock,
  heading: textBlock,
  subtext: textBlock,
  list: (node, s, prefix) => list(node, s, prefix, 0),
  quote: (node, s, prefix) => blocks(node.children, s, `${prefix}> `),
  codeblock: (node, s, prefix) => {
    put(s, prefix, `\`\`\`${LANG.test(node.lang) ? node.lang : ''}`)
    put(s, prefix, defuse(node.text))
    put(s, prefix, '```')
  },
  divider: (node, s) => s.rows.push(s.form === 'v2' ? specialRow('divider') : textRow('')),
  table,
  footnotes: (node, s) => {
    for (const item of node.items) s.notes.set(item.label, noteLine(item, s.names))
  },
}

function blocks(nodes, s, prefix) {
  for (const node of nodes) BLOCKS[node.type](node, s, prefix)
}

/** Decides which notes sit on the parts that cite them: a line whose notes would take more than NOTE_ROOM cites none. */
function placeNotes(rows, notes) {
  const cited = new Set()
  for (const row of rows) {
    const cost = row.cites.reduce((sum, label) => sum + notes.get(label).length + 1, 0)
    row.cites = cost <= NOTE_ROOM ? row.cites : NONE
    for (const label of row.cites) cited.add(label)
  }
  for (const [label, line] of notes) if (!cited.has(label)) rows.push(textRow(line))
}

/** → the rows of the reply and the notes, the blank rows at its ends gone. */
function flatten(doc, form, names) {
  const s = { form, names, rows: [], notes: new Map() }
  blocks(doc, s, '')
  // A blank row is text; a divider or an image has no text, but is no blank row.
  const blank = (row) => row.special === null && isBlank(row)
  let from = 0
  let to = s.rows.length
  while (from < to && blank(s.rows[from])) from++
  while (to > from && blank(s.rows[to - 1])) to--
  const rows = s.rows.slice(from, to)
  placeNotes(rows, s.notes)
  // The last line has no line end after it, so a text of exactly the limit fits.
  if (rows.length > 0) rows.at(-1).eol = false
  return { rows, notes: s.notes }
}

/** → for each boundary between rows (and the two ends), the code fence that is open there, or null. */
function fenceStates(rows) {
  const states = []
  let open = null
  for (const row of rows) {
    states.push(open)
    const m = FENCE.exec(row.text)
    if (m) open = open === null ? { opener: row.text, closer: `${m[1]}\`\`\`` } : null
  }
  states.push(open)
  return states
}

/** → the marks that are open, in the order they were opened in, with the text that opens them again and the text that closes them. */
const stackOf = (marks) => ({ marks, open: marks.join(''), shut: [...marks].reverse().join('') })
const EMPTY = stackOf(NONE)

/** → the stack with the mark closed if it was open, else opened. */
function toggled(stack, mark) {
  const at = stack.marks.lastIndexOf(mark)
  return stackOf(at === -1 ? [...stack.marks, mark] : stack.marks.filter((_, i) => i !== at))
}

/**
 * → the tokens of a row's text that change what is open, or that a cut must not fall inside (a mark, an escape), in the order
 * they come: each is { at, end, stack } with `stack` what is open after it. What is in angle brackets or in code is read as
 * no mark. Code is one token for its opening ticks and one for its closing ones: what is between them is the code's. A row
 * that starts as a list item does not read its marker, which may be a `*`.
 */
function scan(text, stack) {
  const events = []
  let open = stack
  MARK_TOKEN.lastIndex = LIST_ROW.exec(text)?.[0].length ?? 0
  for (let m = MARK_TOKEN.exec(text); m !== null; m = MARK_TOKEN.exec(text)) {
    const at = m.index
    const end = at + m[0].length
    const first = m[0][0]
    if (first === '`') {
      const ticks = m[0][1] === '`' ? '``' : '`'
      events.push({ at, end: at + ticks.length, stack: toggled(open, ticks), shuts: false, opens: true }, { at: end - ticks.length, end, stack: open, shuts: true, opens: false })
    } else if (first === '\\') events.push({ at, end, stack: open, shuts: false, opens: false })
    else if (first !== '<') {
      let shuts = false
      let opens = false
      // A run of asterisks is bold for each pair of them and italic for one over; the run does not tell which was opened first.
      for (const mark of m[0].match(MARK)) {
        if (open.marks.includes(mark)) shuts = true
        else opens = true
        open = toggled(open, mark)
      }
      events.push({ at, end, stack: open, shuts, opens })
    }
  }
  return events
}

/**
 * → what is open at each boundary between the rows (and at the two ends) as `states`, and what each row's text holds of it as
 * `scans`: { events, stack, ends } with the stack that is open at the row's start (`ends` is visibleEnds of its text). A row
 * in a code fence, or that opens one, is code and marks nothing (a closing fence is nothing but its fence). With no `repair`
 * nothing is read, so no cut closes or opens a mark.
 */
function markStates(rows, inside, repair) {
  const states = []
  const scans = []
  let stack = EMPTY
  rows.forEach((row, i) => {
    states.push(stack)
    const events = repair && inside[i + 1] === null ? scan(row.text, stack) : NONE
    scans.push({ events, stack, ends: visibleEnds(row.text) })
    stack = events.at(-1)?.stack ?? stack
  })
  states.push(stack)
  return { states, scans }
}

/** → the index of the first token that starts at the offset or after it. */
function firstFrom(events, off) {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].at < off) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** → what is open at the offset in a row, or null where the offset falls between the characters of a token, which a cut keeps whole. */
function marksAt(scan, off) {
  const lo = firstFrom(scan.events, off)
  if (lo === 0) return scan.stack
  return scan.events[lo - 1].end > off ? null : scan.events[lo - 1].stack
}

/**
 * → for each offset of the text, where the last character before it that is no space ends (0 where there is none). Only spaces
 * lie between a token and an offset after it if it ends where that does, and between an offset and a token after it if the one
 * of the token is no later than it: a cut looks over the spaces to the next token, or the last, at each place in them, which is
 * found at once this way. Were every place to walk them, a hostile run of thousands of spaces would take the time of its square.
 */
function visibleEnds(text) {
  const ends = [0]
  for (let i = 1; i <= text.length; i++) ends.push(GAP.test(text[i - 1]) ? ends[i - 1] : i)
  return ends
}

/** → the token that comes next from the offset on if nothing but spaces lie between, else null. */
function tokenAfter(scan, off) {
  const token = scan.events[firstFrom(scan.events, off)]
  return token !== undefined && scan.ends[token.at] <= off ? token : null
}

/** → the token that comes last before the offset if nothing but spaces lie between, else null. */
function tokenBefore(scan, off) {
  const token = scan.events[firstFrom(scan.events, off) - 1]
  return token !== undefined && scan.ends[off] === token.end ? token : null
}

// How good a place to cut a boundary is, the best first.
const PARAGRAPH = 0
const LINE_END = 1
const INSIDE = 2

function classOf(rows, inside, states, e) {
  if (inside[e] !== null || states[e].open !== '') return INSIDE
  const prev = rows[e - 1].text
  const next = rows[e].text
  if (isBlank(rows[e - 1]) || isBlank(rows[e])) return PARAGRAPH
  if ((LIST_ROW.test(prev) && LIST_ROW.test(next)) || (PIPE.test(prev) && PIPE.test(next))) return INSIDE
  return LINE_END
}

/**
 * → what a mark that a cut leaves with nothing in it is given to hold, the innermost of `stack` (which are open there), so that its
 * marks pair with each other and with nothing after them: a space in a spoiler (`|| ||`), a zero-width space in any other mark,
 * for Discord takes no italic or strike of a space, and `* *` would leave a mark to open an italic with the next one.
 */
const fillOf = (stack) => (stack.marks.at(-1) === '||' ? ' ' : ZWSP)

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff

/**
 * → where to cut `text` after `from`, at most `room` characters on, counting what a cut closes (`scan` says what is open
 * where), and at least `need` on (unless nothing is left to cut at but the end of the room): after a sentence end, else after a
 * space, else anywhere not inside a surrogate pair or a token of `scan`. Null when no place leaves room for what it closes.
 * A `strict` cut is never right before the token that closes a mark that is open (spaces left out), for the next part would open
 * that mark again and be left with a pair of bars that close nothing, which pair with the next ones, and never right after the
 * token that opens one, for its part would end with a pair of bars that hide nothing. A cut that is not strict may fall there,
 * and one right after the token that opens a mark has room kept for what the mark is given to hold (fillOf).
 */
function cutIn(text, from, room, need, scan, strict) {
  const top = Math.min(from + room, text.length - 1)
  const fits = (i) => {
    const open = marksAt(scan, i)
    const bare = tokenBefore(scan, i)?.opens === true
    if (open === null || i - from + open.shut.length + (bare ? 1 : 0) > room) return false
    return !strict || !(bare || tokenAfter(scan, i)?.shuts)
  }
  for (let i = top; i - from >= Math.max(need, 2); i--) if (GAP.test(text[i - 1]) && '.!?'.includes(text[i - 2]) && fits(i)) return i
  for (let i = top; i - from >= Math.max(need, 1); i--) if (GAP.test(text[i - 1]) && fits(i)) return i
  for (let i = top; i > from; i--) if (!(isLow(text.charCodeAt(i)) && isHigh(text.charCodeAt(i - 1))) && fits(i)) return i
  return null
}

/**
 * Cuts rows into parts. spec: cap(p, last) the room of part p (as the last part, and as one with another after it),
 * noteCost(label), maxSpecials, and repair (whether a cut inside a code fence, or inside a spoiler or another mark, closes it,
 * and opens it in the next part, for which the room is kept). → [{ from, to, reopen, closing, resume, leave, lead, trail }]: from
 * and to are { row, off } positions, `reopen` the fence to open at the start of the part, or null, `closing` the lines that close
 * one at its end (none, or the line of the fence); `resume` the marks that are open at its start, to be opened again there, and
 * `leave` those open at its end, to be closed there (EMPTY for none); `lead` what goes between the marks opened again and the token
 * at the start of the part that closes one of them, and `trail` what goes between the token at its end that opens one and the
 * marks that close them ('' where the part does not start or end so; the last part, which closes nothing, has none).
 * A part takes the rest of the rows when they fit. Else it ends at a boundary between rows, the latest of the best kind
 * that fits and fills the part to half its room at least (blank line, line end, line end inside a fence, list or table, in
 * that order), or inside a row, the latest sentence end, else space, that fills it so, else the room's end (a row cut after
 * the rows before it). Where there is no row to cut, or it starts with a fence (a closing fence with text on its line), the
 * part ends at the latest boundary, however empty: so does the part that has to end for the limit of MAX_SPECIALS. A
 * boundary right after a fence opens or right before it closes is cut at only when nothing else can be, so that no part
 * has a fence with nothing in it. These are the parts that may be under half full. A part looks no further on than its room
 * goes, so the walk is linear.
 * A cut leaves no bars with nothing in them while it can: it is not made right before the token that closes a mark that is open
 * (the next part would open it again, and be left with bars that close nothing, which Discord pairs with the next ones, showing
 * every spoiler between them), nor right after the token that opens one. Where no such place is left, the last choices are, in
 * order: the first row cut where it leaves none, the row the room ran out in cut anywhere that leaves room, the first row cut so,
 * and the latest boundary that only this rule kept from being cut at. One of them is always there: where no boundary fits, the
 * first row is long enough to be cut. The mark that is left with nothing in it is given something to hold (fillOf), and the room
 * for it is kept: at the start of the part, in its room; at the end, in the cut, or in the line end a boundary leaves out.
 */
function plan(rows, spec) {
  const n = rows.length
  const inside = fenceStates(rows)
  const { states, scans } = markStates(rows, inside, spec.repair)
  const fenceCost = (e) => (spec.repair && inside[e] !== null ? inside[e].closer.length + 1 : 0)
  const tailOf = (row) => row.cites.reduce((sum, label) => sum + spec.noteCost(label), 0)
  // A boundary right before the row that starts with the token that closes a mark that is open there, or right after the row that
  // ends with the token that opens one, is no place to cut: the part that starts or ends there would have bars with nothing in.
  const shutsAt = (p) => tokenAfter(scans[p.row], p.off === 0 ? QUOTE.exec(rows[p.row].text)[0].length : p.off)?.shuts === true
  const opensBefore = (e) => tokenBefore(scans[e - 1], rows[e - 1].text.length)?.opens === true
  const opensAt = (p) => (p.off === 0 ? opensBefore(p.row) : tokenBefore(scans[p.row], p.off)?.opens === true)
  const parts = []
  let at = { row: 0, off: 0 }
  let reopen = null
  let resume = EMPTY
  let lead = ''
  for (;;) {
    const capMid = spec.cap(parts.length, false)
    const capLast = spec.cap(parts.length, true)
    const start = (reopen === null ? 0 : reopen.opener.length + 1) + resume.open.length + lead.length
    let cost = start
    let specials = 0
    let tail = 0
    const seen = new Set()
    // The latest boundary of each kind, with the text before it; the latest of all of them; the latest one that only the rule against
    // bars with nothing in kept; the latest one that is next to a fence's edge, with the text before it; the row, after the first,
    // that the room ran out in.
    const latest = [null, null, null]
    let any = null
    let loose = null
    let edge = null
    let over = null
    let done = at.row === n
    // What a row adds to the text of the part: its characters from where the part starts in it, and its line end.
    const sizeOf = (r) => rows[r].text.length + (rows[r].eol ? 1 : 0) - (r === at.row ? at.off : 0)
    for (let e = at.row + 1; e <= n; e++) {
      const row = rows[e - 1]
      const before = cost
      cost += sizeOf(e - 1)
      if (row.special !== null) specials++
      for (const label of row.cites) {
        if (!seen.has(label)) {
          seen.add(label)
          tail += spec.noteCost(label)
        }
      }
      if (specials > spec.maxSpecials) break
      const total = cost + tail
      if (e === n || total > capMid) {
        // The room of the last part is no more than that of the others, so a total over the latter is over the former too.
        done = total <= capLast
        over = { row: e - 1, before, tail }
        break
      }
      if (total + fenceCost(e) + states[e].shut.length > capMid) continue
      if (shutsAt({ row: e, off: 0 }) || opensBefore(e)) {
        loose = { row: e, off: 0 }
        continue
      }
      if (inside[e] !== null && (inside[e - 1] === null || inside[e + 1] === null)) {
        edge = { e, before: cost, tail }
        continue
      }
      any = { e }
      latest[classOf(rows, inside, states, e)] = { e, fill: cost }
    }
    if (done) {
      parts.push({ from: at, to: { row: n, off: 0 }, reopen, closing: NONE, resume, leave: EMPTY, lead })
      return parts
    }
    // Where the part is cut inside a row, and the room it has there for the piece, of which `need` fill it to its half.
    const room = (t) => capMid - t.before - t.tail - fenceCost(t.row)
    // A row is cut from where the part starts in it.
    const cutRow = (t, strict = true) => {
      const text = rows[t.row].text
      const need = Math.ceil(capMid / 2 - t.before)
      const off = cutIn(text, t.row === at.row ? at.off : 0, room(t), need, scans[t.row], strict)
      return off === null ? null : { row: t.row, off }
    }
    const best = latest.find((c) => c !== null && c.fill * 2 >= capMid)
    // The row the room ran out in is the one that is cut, but for the closing fence of a block of code: that has the line of code
    // before it cut, with the room that is left for it once the fence is to be closed.
    let spill = over
    if (over !== null && FENCE.test(rows[over.row].text)) {
      const code = over.row - 1
      spill = spec.repair && inside[over.row] !== null ? { row: code, before: over.before - sizeOf(code), tail: over.tail } : null
    }
    let next = best === undefined ? null : { row: best.e, off: 0 }
    if (next === null && spill !== null) next = cutRow(spill)
    if (next === null && any !== null) next = { row: any.e, off: 0 }
    // A fence cut right after it opens would be left with nothing in it, so the line of code that comes next is cut instead.
    if (next === null && spec.repair && edge !== null) next = cutRow({ row: edge.e, before: edge.before, tail: edge.tail + tailOf(rows[edge.e]) })
    if (next === null && edge !== null) next = { row: edge.e, off: 0 }
    // Where nothing else is left, a cut that leaves no bars with nothing in, and then one that does.
    const whole = { row: at.row, before: start, tail: tailOf(rows[at.row]) }
    next ??= cutRow(whole) ?? (spill && cutRow(spill, false)) ?? cutRow(whole, false) ?? loose
    const open = inside[next.row]
    const cut = spec.repair && open !== null
    const leave = marksAt(scans[next.row], next.off)
    parts.push({ from: at, to: next, reopen, closing: cut ? [open.closer] : NONE, resume, leave, lead, trail: opensAt(next) ? fillOf(leave) : '' })
    lead = shutsAt(next) ? fillOf(leave) : ''
    reopen = cut ? open : null
    resume = leave
    at = next
  }
}

/** → the rows of a part, the first and the last cut to where the part starts and ends in them. */
function piecesOf(rows, from, to) {
  const out = []
  for (let i = from.row; i < to.row || (i === to.row && to.off > 0); i++) {
    const row = rows[i]
    const a = i === from.row ? from.off : 0
    const b = i === to.row ? to.off : row.text.length
    out.push({ ...row, text: row.text.slice(a, b), eol: b === row.text.length && row.eol })
  }
  return out
}

// A part that starts inside a line has its mark and the text on one line, which is no start of a line.
const marked = (k, n, body, inRow) => `**${k}/${n}**${!inRow && BLOCK_START.test(body) ? '\n' : ' '}${body}`

export function split(text, limit) {
  if (typeof text !== 'string') throw new TypeError('the text must be a string')
  if (!Number.isInteger(limit) || limit < MIN_SPLIT_LIMIT) throw new RangeError(`the limit must be a whole number of at least ${MIN_SPLIT_LIMIT}`)
  if (text.length <= limit) return [text]
  const rows = text.split('\n').map((line, i, all) => ({ text: line, eol: i < all.length - 1, cites: NONE, special: null }))
  // The mark is wider for a reply of ten parts or more, which is known only once the parts are cut.
  let width = markWidth(2)
  for (;;) {
    // No row of a text cites a note, so the cost of one is never asked.
    const parts = plan(rows, { cap: () => limit - width, maxSpecials: Infinity, repair: false })
    const needed = markWidth(parts.length)
    if (needed <= width) {
      return parts.map((part, i) => marked(i + 1, parts.length, piecesOf(rows, part.from, part.to).map((row) => row.text + (row.eol ? '\n' : '')).join(''), part.from.off > 0))
    }
    width = needed
  }
}

// What each kind of element of a part is as a component, put at the end of the others.
const PLACE = {
  text: (el, components) => components.push({ type: TEXT_DISPLAY, content: el.lines.join('\n') }),
  divider: (el, components) => components.push({ type: SEPARATOR, divider: true, spacing: 1 }),
  image: (el, components) => {
    const prev = components.at(-1)
    const item = { media: { url: `attachment://${el.name}` } }
    if (prev !== undefined && prev.type === MEDIA_GALLERY && prev.items.length < GALLERY_ITEMS) prev.items.push(item)
    else components.push({ type: MEDIA_GALLERY, items: [item] })
  },
}

/** → the part as Discord's message, from the lines of its text and its images in order. */
function assemble(c, cut, k) {
  const { o, n } = c
  const pieces = piecesOf(c.rows, cut.from, cut.to)
  const first = pieces[0]
  if (cut.resume.open !== '') {
    // A quote's mark stays in front of what is opened again, and a cut inside a row starts after no mark.
    const quote = cut.from.off === 0 ? QUOTE.exec(first.text)[0] : ''
    first.text = quote + cut.resume.open + cut.lead + first.text.slice(quote.length).trimStart()
  } else if (cut.from.off > 0 && cut.reopen === null) {
    // A part that starts inside a line starts with what was in the middle of it, which was no line start and must not become one.
    first.text = first.text.replace(LINE_START, '$1\\')
  }
  if (cut.leave.shut !== '') {
    const last = pieces.at(-1)
    last.text = last.text.trimEnd() + cut.trail + cut.leave.shut
  }
  if (cut.reopen !== null) pieces.unshift(textRow(cut.reopen.opener))
  for (const line of cut.closing) pieces.push(textRow(line))

  const files = []
  const body = []
  let run = []
  const flush = () => {
    const text = run.join('\n').trim()
    run = []
    if (text !== '') body.push({ kind: 'text', text })
  }
  for (const row of pieces) {
    if (row.special === 'image') {
      if (!files.includes(row.name)) files.push(row.name)
      if (o.form === 'v2') {
        flush()
        body.push({ kind: 'image', name: row.name })
      }
    } else if (row.special === 'divider') {
      flush()
      body.push({ kind: 'divider' })
    } else run.push(row.text)
  }
  flush()
  while (body[0]?.kind === 'divider') body.shift()
  while (body.at(-1)?.kind === 'divider') body.pop()

  const els = []
  const line = (text) => {
    const prev = els.at(-1)
    if (prev !== undefined && prev.kind === 'text') prev.lines.push(text)
    else els.push({ kind: 'text', lines: [text] })
  }
  const link = c.lines === null ? null : c.lines[k]
  let length = 0
  if (k === 0 && c.reply !== '') line(c.reply)
  if (k > 0 && link !== null) line(link)
  let isMarked = n === 1
  const mark = `**${k + 1}/${n}**`
  for (const el of body) {
    if (el.kind === 'text') {
      line(isMarked ? el.text : `${mark}${BLOCK_START.test(el.text) ? '\n' : ' '}${el.text}`)
      isMarked = true
      length += el.text.length
    } else {
      if (!isMarked) line(mark)
      isMarked = true
      els.push(el)
    }
  }
  if (!isMarked) line(mark)
  if (k === 0 && link !== null) line(link)
  const cited = new Set(pieces.flatMap((row) => row.cites))
  for (const [label, note] of c.notes) {
    if (!cited.has(label)) continue
    line(note)
    length += note.length
  }
  const last = k === n - 1
  if (last) line(c.footer)

  const text = els
    .filter((el) => el.kind === 'text')
    .map((el) => el.lines.join('\n'))
    .join('\n')
  if (o.form === 'plain') return { part: { text, components: null, files }, length }
  const components = []
  for (const el of els) PLACE[el.kind](el, components)
  if (last) components.push({ type: ACTION_ROW, components: [{ type: BUTTON, style: LINK_STYLE, label: BUTTON_LABEL, url: o.siteUrl }] })
  return { part: { text, components: [{ type: CONTAINER, components }], files }, length }
}

export function toDiscord(source, options) {
  const o = settle(source, options)
  const { rows, notes } = flatten(parse(source.replace(LONE, '\ufffd'), { dialect: 'extended' }), o.form, o.images)
  const hard = HARD_LIMIT[o.form]
  const bodyLimit = BODY_LIMIT[o.form]
  const reply = o.replyTo === null ? '' : `-# ↪ <@${o.replyTo.authorId}> [jump](<${o.replyTo.url}>)`
  const footer = o.form === 'v2' ? `-# <@${o.authorId}>` : `-# <@${o.authorId}> · [${BUTTON_LABEL}](<${o.siteUrl}>)`
  // Each line of a part costs its length and the line end that goes with it; the button's label is text too.
  const replyCost = reply === '' ? 0 : reply.length + 1
  const footerCost = footer.length + 1 + (o.form === 'v2' ? BUTTON_LABEL.length : 0)
  const room = (overhead) => Math.min(bodyLimit, hard - overhead)
  const common = { noteCost: (label) => notes.get(label).length + 1, maxSpecials: o.form === 'v2' ? MAX_SPECIALS : Infinity, repair: true }

  let cuts = plan(rows, { ...common, cap: () => room(replyCost + footerCost) })
  if (cuts.length > 1) {
    let width = markWidth(2)
    for (;;) {
      const lines = (p) => (p === 0 ? replyCost + CONTINUES_RESERVE + 1 : BACK_RESERVE + 1)
      cuts = plan(rows, { ...common, cap: (p, last) => room(width + lines(p) + (last ? footerCost : 0)) })
      const needed = markWidth(cuts.length)
      if (needed <= width) break
      width = needed
    }
  }

  const n = cuts.length
  let lines = null
  if (o.thread !== null && n > 1 && n <= MAX_PARTS) {
    lines = markers(
      Array.from({ length: n }, (_, i) => o.thread.ids[i] ?? null),
      o.thread.base,
    )
  }
  const c = { o, n, rows, notes, reply, footer, lines }
  const built = cuts.map((cut, k) => assemble(c, cut, k))
  return { parts: built.map((b) => b.part), length: built.reduce((sum, b) => sum + b.length, 0), overBudget: n > MAX_PARTS }
}

export function placement(source, options) {
  const { images } = settle(source, options)
  if (new Set(images.values()).size !== images.size) throw new RangeError('two image refs share a file name')
  const refOf = new Map([...images].map(([ref, name]) => [name, ref]))
  const placed = toDiscord(source, options).parts.map((part) => part.files.map((name) => refOf.get(name)))
  while (placed.length > 0 && placed.at(-1).length === 0) placed.pop()
  return placed
}

export function budget(source, options) {
  const r = toDiscord(source, options)
  return { used: r.length, limit: MAX_PARTS * limitFor(formOf(options.form)), parts: r.parts.length }
}

function textOf(components) {
  let total = 0
  for (const component of components) {
    if (component.type === TEXT_DISPLAY) total += component.content.length
    else if (component.type === BUTTON) total += component.label.length
    if (component.components) total += textOf(component.components)
  }
  return total
}

export function displayableLength(part) {
  return part.components === null ? part.text.length : textOf(part.components)
}
