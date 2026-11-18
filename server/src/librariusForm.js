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
 * - a code block cut by a part is closed at the cut and opened again after it, so each part shows it as code.
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
 * space when its part starts with block syntax (a heading, list, quote or fence), which a space would turn into text.
 *
 * markers(partIds, threadUrlBase) → one line for each part: part 1's links forward and the others' link back, null where
 * a line needs a message id that is null (not sent yet), '' for a reply in one part.
 * budget(source, options) → { used, limit, parts }, for the composer's meter: `used` is toDiscord's `length`, `limit` the
 * body room of MAX_PARTS parts, `parts` how many parts the reply needs.
 * displayableLength(part) → the characters of a part that Discord counts against its limit.
 * limitFor(form) → the body budget of a part of that form.
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
// What at the start of a line would make it a heading, a list item, subtext or a quote.
const LINE_START = /^([ \t]*)(?=#{1,3} |-(?: |# )|>)/
const FENCE = /^((?:[ \t]*>)*[ \t]*)```/
const LIST_ROW = /^(?:[ \t]*>)*[ \t]*(?:[-*]|\d{1,9}\.) /
const PIPE = /(?<!\|)\|(?!\|)/
const GAP = /\s/
const NONE = Object.freeze([])

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** → the form, which is the default when none is given; anything else but a form is a RangeError. */
function formOf(form) {
  const chosen = form === undefined ? DEFAULT_FORM : form
  if (!FORMS.includes(chosen)) throw new RangeError('form must be "v2" or "plain"')
  return chosen
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

const wrapped = (mark) => (node, ic) => {
  const text = inline(node.children, ic)
  return text.trim() === '' ? text : `${mark}${text}${mark}`
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
  // A bold heading holds no bold of its own: two pairs of asterisks in one would end it early.
  strong: (node, ic) => (ic.bold ? inline(node.children, ic) : wrapped('**')(node, ic)),
  em: wrapped('*'),
  underline: wrapped('__'),
  strike: wrapped('~~'),
  spoiler: wrapped('||'),
  br: () => '\n',
}

/** → inline nodes as Discord markdown. An image has no place in the text: `ic.images` collects it, to show after the line. */
function inline(nodes, ic, atStart = false) {
  let out = ''
  nodes.forEach((node, i) => {
    out += INLINE[node.type](node, ic, atStart && i === 0)
  })
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

/** → the text with every run of three backticks kept from closing, or opening, a code block. */
const defuse = (text) => text.replaceAll('```', '``\u200b`')

/** → { text, cites, images } of a line, heading or subtext node; the text is '' when there is nothing to show but images. */
function render(node, names) {
  const ic = { names, cites: new Set(), images: [], alt: false, bold: node.level > 3 }
  const text = inline(node.children, ic, true)
  let shown = ''
  if (text.trim() !== '') {
    if (ic.bold) shown = `**${text}**`
    else if (node.type === 'heading') shown = `${'#'.repeat(node.level)} ${text}`
    else shown = node.type === 'subtext' ? `-# ${text}` : text
  }
  return { text: shown, cites: [...ic.cites], images: ic.images }
}

function noteLine(item, names) {
  const ic = { names, cites: new Set(), alt: true, bold: false }
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

// How good a place to cut a boundary is, the best first.
const PARAGRAPH = 0
const LINE_END = 1
const INSIDE = 2

function classOf(rows, inside, e) {
  if (inside[e] !== null) return INSIDE
  const prev = rows[e - 1].text
  const next = rows[e].text
  if (isBlank(rows[e - 1]) || isBlank(rows[e])) return PARAGRAPH
  if ((LIST_ROW.test(prev) && LIST_ROW.test(next)) || (PIPE.test(prev) && PIPE.test(next))) return INSIDE
  return LINE_END
}

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff

/**
 * → where to cut `text` after `from`, at most `max` characters on and at least `need` on (unless nothing is left to cut at
 * but the end of the room): after a sentence end, else after a space, else anywhere not inside a surrogate pair.
 */
function cutIn(text, from, max, need) {
  const top = from + max
  for (let i = top; i - from >= Math.max(need, 2); i--) if (GAP.test(text[i - 1]) && '.!?'.includes(text[i - 2])) return i
  for (let i = top; i - from >= Math.max(need, 1); i--) if (GAP.test(text[i - 1])) return i
  return isLow(text.charCodeAt(top)) && isHigh(text.charCodeAt(top - 1)) ? top - 1 : top
}

/**
 * Cuts rows into parts. spec: cap(p, last) the room of part p (as the last part, and as one with another after it),
 * noteCost(label), maxSpecials, and repair (whether a cut inside a code fence closes it, and opens it in the next part, for
 * which the room is kept). → [{ from, to, reopen, closer }]: from and to are { row, off } positions, `reopen` the fence to
 * open at the start of the part and `closer` the line that closes one at its end, or null.
 * A part takes the rest of the rows when they fit. Else it ends at a boundary between rows, the latest of the best kind
 * that fits and fills the part to half its room at least (blank line, line end, line end inside a fence, list or table, in
 * that order), or inside a row, the latest sentence end, else space, that fills it so, else the room's end (a row cut after
 * the rows before it). Where there is no row to cut, or it starts with a fence (a closing fence with text on its line), the
 * part ends at the latest boundary, however empty: so does the part that has to end for the limit of MAX_SPECIALS. A
 * boundary right after a fence opens or right before it closes is cut at only when nothing else can be, so that no part
 * has a fence with nothing in it. These are the parts that may be under half full. A part looks no further on than its room
 * goes, so the walk is linear.
 */
function plan(rows, spec) {
  const n = rows.length
  const inside = fenceStates(rows)
  const repairOf = (open) => (spec.repair && open !== null ? open.closer.length + 1 : 0)
  const tailOf = (row) => row.cites.reduce((sum, label) => sum + spec.noteCost(label), 0)
  const parts = []
  let at = { row: 0, off: 0 }
  let reopen = null
  for (;;) {
    const capMid = spec.cap(parts.length, false)
    const capLast = spec.cap(parts.length, true)
    const start = reopen === null ? 0 : reopen.opener.length + 1
    let cost = start
    let specials = 0
    let tail = 0
    const seen = new Set()
    // The latest boundary of each kind, with the text before it; the latest of all of them; the latest one that is next to a
    // fence's edge; the row, after the first, that the room ran out in.
    const latest = [null, null, null]
    let any = null
    let edge = null
    let over = null
    let done = at.row === n
    for (let e = at.row + 1; e <= n; e++) {
      const row = rows[e - 1]
      const before = cost
      cost += row.text.length + (row.eol ? 1 : 0) - (e - 1 === at.row ? at.off : 0)
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
        // Stryker disable next-line ConditionalExpression: the room of a part cannot run out in a row with no text, but for the last, and then the part before it is half full
        if (e - 1 > at.row && row.special === null) over = { row: e - 1, before, tail }
        break
      }
      if (total + repairOf(inside[e]) > capMid) continue
      if (inside[e] !== null && (inside[e - 1] === null || inside[e + 1] === null)) {
        edge = e
        continue
      }
      any = { e }
      latest[classOf(rows, inside, e)] = { e, fill: cost }
    }
    if (done) {
      parts.push({ from: at, to: { row: n, off: 0 }, reopen, closer: null })
      return parts
    }
    // Where the part is cut inside a row, and the room it has there for the piece, of which `need` fill it to its half.
    const room = (t) => capMid - t.before - t.tail - repairOf(inside[t.row])
    const cutRow = (t, from) => {
      const text = rows[t.row].text
      const need = Math.ceil(capMid / 2 - t.before)
      return { row: t.row, off: cutIn(text, from, Math.min(room(t), text.length - from - 1), need) }
    }
    const best = latest.find((c) => c !== null && c.fill * 2 >= capMid)
    // Stryker disable next-line EqualityOperator: with no room left (0), the cut would be right before the row, which is where the edge branch cuts
    const roomed = over !== null && room(over) >= 1
    let next
    if (best !== undefined) next = { row: best.e, off: 0 }
    else if (roomed && !FENCE.test(rows[over.row].text)) next = cutRow(over, 0)
    else if (any !== null) next = { row: any.e, off: 0 }
    else if (edge !== null) next = { row: edge, off: 0 }
    else next = cutRow({ row: at.row, before: start, tail: tailOf(rows[at.row]) }, at.off)
    const open = inside[next.row]
    const cut = spec.repair && open !== null
    parts.push({ from: at, to: next, reopen, closer: cut ? open.closer : null })
    reopen = cut ? open : null
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

const marked = (k, n, body) => `**${k}/${n}**${BLOCK_START.test(body) ? '\n' : ' '}${body}`

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
      return parts.map((part, i) => marked(i + 1, parts.length, piecesOf(rows, part.from, part.to).map((row) => row.text + (row.eol ? '\n' : '')).join('')))
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
  if (cut.reopen !== null) pieces.unshift(textRow(cut.reopen.opener))
  // Stryker disable next-line ConditionalExpression: a null line joins as an empty one, which the trim of the run takes off
  if (cut.closer !== null) pieces.push(textRow(cut.closer))

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
