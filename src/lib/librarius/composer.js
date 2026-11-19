/**
 * The Librarius composer's toolbar and drafts, as pure functions (Composer.vue holds the textarea and calls these).
 *
 * apply(text, selection, action) → { text, selection }
 *   text       the markdown source, a string.
 *   selection  { start, end }, whole numbers with 0 <= start <= end <= text.length, as a textarea gives them.
 *   action     one of ACTIONS by name, or { type, ...payload }. Three need their payload, so take the object only:
 *              { type: 'image', name, n } → ![name](upload:N), N a whole number from 1 to 10 and the name a string;
 *              { type: 'mention', id } → <@id>, the id a member's, as a string of 17 to 20 digits;
 *              { type: 'emoji', text } → the text: a standard emoji, or a custom one as <:name:id>. One line, not empty.
 *   A text, selection or action of the wrong kind is a TypeError; one out of range, or an action no toolbar has, a
 *   RangeError. Whatever comes back is a valid text and a selection inside it, start first, and can be given back.
 *
 * The line actions (h1, h2, h3, subtext, quote, bullet, numbered) put their mark at the start of every line the selection
 * touches (a selection that ends at the very start of a line does not touch it). A line is read as Discord reads it: a quote
 * ("> "), an indent, a list mark ("- ", "* " or "N. "), a heading or subtext mark ("#" to "######", or "-#", then spaces),
 * then the words. An action changes its own mark only, so a quoted list item keeps its quote and gets a heading inside it.
 * When every touched line has the mark already, the action takes it off them all; otherwise each gets it, one heading level
 * or kind of list taking the place of another, and a numbered list counting 1, 2, 3 down the lines. Headings, subtext and
 * lists skip blank lines when the selection touches any other; a quote takes them too, so that it holds together.
 *
 * The wrapping actions (bold, italic, underline, strike, spoiler, code) put their marks round the selection, each line of it
 * on its own (no mark spans lines in Discord), leaving the white space at its ends and a line's own marks outside. A
 * selection with nothing in it but white space is a caret at its end; a caret gets the pair with itself between them. When
 * the marks are there already, just outside the selection or at its ends, they are taken away: stars are read as Discord
 * reads them, one for italic and two for bold, so bold on italic text makes ***both***. Code that has a backtick in it is
 * put between two. Code over several lines is a fenced block round the whole of those lines, and the fence goes again when
 * the selection is just inside it or takes it in.
 *
 * The inserts never lose text: a link takes the selection as its text (or as its address, when it is one) and selects what
 * is left to type; an image, a table or a rule goes after the selection, on a line of its own; a mention or an emoji goes in
 * place of the selection, as typing it would.
 *
 * The selection that comes back is what a person would go on typing over: the words a line action or a wrap was pressed on,
 * the address or text of a new link, the first heading of a table, and otherwise a caret after what went in.
 *
 * Drafts live in the member's own browser, under draftKey(postId, replyTo): lb-draft:<postId>:<replyTo|new>. The storage is
 * given (localStorage, in the page), and one that throws (full, or blocked in a private window) never makes these throw;
 * ids that are not ids still do, since that is the caller's mistake.
 *   saveDraft(storage, postId, replyTo, text) → true when the storage took it, false when it refused. A blank text keeps no
 *     draft: it removes the one there was.
 *   loadDraft(storage, postId, replyTo) → the draft's text, or null.
 *   clearDraft(storage, postId, replyTo) removes the one draft (after a reply is sent).
 *   clearAllDrafts(storage) removes every draft and nothing else (at sign-out).
 *   draftStorage() → the browser's localStorage, to give these, or null where there is none or reading it throws (a
 *     browser that blocks storage): the helpers take null as a storage that keeps nothing.
 */

const ID = /^\d{17,20}$/
// The marks a line opens with: a quote, an indent, a list mark, a heading or subtext mark. Each may be missing, so the
// first match is always at the very start of the line, and needs no anchor.
const LINE = /(> |>$)?([ \t]*)((?:[-*]|\d{1,9}\.) +)?(#{1,6} +|-# +)?/
// A fence line, as the parser reads one.
const FENCE = /^```[\w+-]*$/
const OPEN = '```\n'
const CLOSE = '\n```'
const ADDRESS = /^https?:\/\/[^\s()<>]+$/
const NOT_LINK_TEXT = /[\n[\]]/
const LINK_TEXT = 'link text'
const LINK_ADDRESS = 'https://'
const TABLE_HEADING = 'Column'
const TABLE = `| ${TABLE_HEADING} | ${TABLE_HEADING} |\n| --- | --- |\n| Cell | Cell |`
const DRAFT = 'lb-draft:'

/** Each line action: the mark of a line it is about, and the mark it puts on. */
const LINE_ACTIONS = {
  h1: ['head', '# '],
  h2: ['head', '## '],
  h3: ['head', '### '],
  subtext: ['head', '-# '],
  quote: ['quote', '> '],
  bullet: ['list', '- '],
  numbered: ['list', null],
}

/**
 * Each wrapping action: the character its marks are made of; how many of them, run together on both sides, mean the text
 * has it; how many it takes away; and the mark it puts on round a text.
 */
const pair = (mark) => ({ ch: mark[0], has: (n) => n >= 2, take: () => mark.length, mark: () => mark })
const WRAPS = {
  bold: pair('**'),
  italic: { ch: '*', has: (n) => n % 2 === 1, take: () => 1, mark: () => '*' },
  underline: pair('__'),
  strike: pair('~~'),
  spoiler: pair('||'),
  code: { ch: '`', has: (n) => n > 0, take: (n) => n, mark: (inner) => (inner.includes('`') ? '``' : '`') },
}

const HANDLERS = {
  h1: line,
  h2: line,
  h3: line,
  bold: wrap,
  italic: wrap,
  underline: wrap,
  strike: wrap,
  spoiler: wrap,
  quote: line,
  code: wrap,
  bullet: line,
  numbered: line,
  link,
  image,
  table,
  rule,
  mention,
  emoji,
  subtext: line,
}

export const ACTIONS = Object.freeze(Object.keys(HANDLERS))

export function apply(text, selection, action) {
  if (typeof text !== 'string') throw new TypeError('the text must be a string')
  const [start, end] = bounds(text, selection)
  const payload = typeof action === 'string' ? { type: action } : action
  if (typeof payload?.type !== 'string') throw new TypeError('an action is a name, or { type, …payload }')
  if (!Object.hasOwn(HANDLERS, payload.type)) throw new RangeError('the composer has no such action')
  return HANDLERS[payload.type](text, start, end, payload)
}

function bounds(text, selection) {
  const start = selection?.start
  const end = selection?.end
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new TypeError('the selection must be { start, end }, in whole numbers')
  if (start < 0 || start > end || end > text.length) throw new RangeError('the selection must lie inside the text, its start first')
  return [start, end]
}

// --- lines ---

/** → the index the line holding position i starts at, and the index it ends at (its line break, or the end of the text). */
const lineStart = (text, i) => (i === 0 ? 0 : text.lastIndexOf('\n', i - 1) + 1)
function lineEnd(text, i) {
  const nl = text.indexOf('\n', i)
  return nl === -1 ? text.length : nl
}

/** → [from, to] of each line the range touches, `to` being where its line break is. */
function linesIn(text, start, end) {
  const out = []
  let from = lineStart(text, start)
  for (;;) {
    const nl = text.indexOf('\n', from)
    out.push([from, nl === -1 ? text.length : nl])
    if (nl === -1 || nl >= end) return out
    from = nl + 1
    // A range that ends at the very start of a line does not touch it.
    if (from === end) return out
  }
}

/** The marks the line [from, to] opens with, each as { at, len, kind }, where its words begin, and whether it is blank. */
function readLine(text, from, to) {
  const [, quote = '', indent, list = '', head = ''] = LINE.exec(text.slice(from, to))
  const listAt = from + quote.length + indent.length
  const headAt = listAt + list.length
  return {
    quote: { at: from, len: quote.length, kind: quote === '' ? null : 'quote' },
    list: { at: listAt, len: list.length, kind: list === '' ? null : /\d/.test(list) ? 'numbered' : 'bullet' },
    head: { at: headAt, len: head.length, kind: head === '' ? null : head[0] === '-' ? 'subtext' : `h${head.trimEnd().length}` },
    body: headAt + head.length,
    blank: !/\S/.test(text.slice(from + quote.length, to)),
  }
}

function line(text, start, end, { type }) {
  const [layer, mark] = LINE_ACTIONS[type]
  const touched = linesIn(text, start, end).map(([from, to]) => readLine(text, from, to))
  const written = touched.filter((read) => !read.blank)
  const acted = type === 'quote' || written.length === 0 ? touched : written
  const off = acted.every((read) => read[layer].kind === type)
  const edits = acted.map((read, k) => ({
    at: read[layer].at,
    remove: read[layer].len,
    insert: off ? '' : (mark ?? `${k + 1}. `),
  }))
  return { text: edit(text, edits), selection: { start: moved(edits, start), end: moved(edits, end) } }
}

// --- edits ---

/** The text with each edit { at, remove, insert } made. The edits are in order and do not overlap. */
function edit(text, edits) {
  let out = ''
  let from = 0
  for (const { at, remove, insert } of edits) {
    out += text.slice(from, at) + insert
    from = at + remove
  }
  return out + text.slice(from)
}

/**
 * → where position p of the text is once the edits are made. A position an edit takes away, or one where it puts text in,
 * ends up after what it puts in.
 */
function moved(edits, p) {
  let q = p
  let shift = 0
  for (const { at, remove, insert } of edits) {
    if (q < at) break
    q = Math.max(q, at + remove)
    shift += insert.length - remove
  }
  return q + shift
}

// --- wraps ---

/** → how many of ch run together just before position i, and just after it. */
function runBefore(text, i, ch) {
  let k = i
  while (text[k - 1] === ch) k--
  return i - k
}
function runAfter(text, i, ch) {
  let k = i
  while (text[k] === ch) k++
  return k - i
}

/** → [s, e], the range without the white space at its ends. */
function trimmed(text, start, end) {
  const piece = text.slice(start, end)
  const s = start + piece.length - piece.trimStart().length
  return [s, s + piece.trim().length]
}

/**
 * → the ranges a wrap is about: on each line the selection touches, the part of it after the line's own marks, without its
 * white space; those with something in them. With none, the caret at the selection's end, moved past its line's marks.
 */
function segments(text, start, end) {
  const out = []
  for (const [from, to] of linesIn(text, start, end)) {
    const [s, e] = trimmed(text, Math.max(start, readLine(text, from, to).body), Math.min(end, to))
    if (e > s) out.push([s, e])
  }
  if (out.length > 0) return out
  const p = Math.max(end, readLine(text, lineStart(text, end), lineEnd(text, end)).body)
  return [[p, p]]
}

/**
 * The range [s, e] as a wrap reads it: `from` and `to` bound its core, which is the range without the marks at its ends;
 * a range of nothing but marks has an empty core in its middle. `n` is how many marks run together round the core on both
 * sides, inside the range or out.
 */
function core(text, s, e, ch) {
  const lead = runAfter(text, s, ch)
  const mid = s + Math.floor((e - s) / 2)
  const [from, to] = lead >= e - s ? [mid, mid] : [s + lead, e - runBefore(text, e, ch)]
  return { from, to, n: Math.min(runBefore(text, from, ch), runAfter(text, to, ch)) }
}

function wrap(text, start, end, { type }) {
  const spec = WRAPS[type]
  if (type === 'code') {
    const [s, e] = trimmed(text, start, end)
    if (text.slice(s, e).includes('\n')) return fence(text, s, e)
  }
  const cores = segments(text, start, end).map(([s, e]) => core(text, s, e, spec.ch))
  const off = cores.every(({ n }) => spec.has(n))
  const edits = []
  for (const c of cores) {
    if (off) {
      const w = spec.take(c.n)
      edits.push({ at: c.from - w, remove: w, insert: '' }, { at: c.to, remove: w, insert: '' })
    } else if (!spec.has(c.n)) {
      c.mark = spec.mark(text.slice(c.from, c.to))
      edits.push({ at: c.from, remove: 0, insert: c.mark }, { at: c.to, remove: 0, insert: c.mark })
    }
  }
  // The core, inside any marks put in round it. A position where text went in ends up after it, so the end comes back
  // before its closing mark, and an empty core back between its two.
  const marked = (c) => c.mark?.length ?? 0
  const first = cores[0]
  const last = cores.at(-1)
  const startAt = moved(edits, first.from) - (first.from === first.to ? marked(first) : 0)
  return { text: edit(text, edits), selection: { start: startAt, end: moved(edits, last.to) - marked(last) } }
}

/** Code over the lines [s, e] touch: a fence round them, or away when there is one. */
function fence(text, s, e) {
  const lines = linesIn(text, s, e)
  const [from, firstEnd] = lines[0]
  const [lastFrom, to] = lines.at(-1)
  // The lines just above and below them ('' where there is none).
  const before = text.slice(0, Math.max(from - 1, 0))
  const aboveFrom = before.lastIndexOf('\n') + 1
  const above = before.slice(aboveFrom)
  const belowEnd = lineEnd(text, to + 1)
  const below = text.slice(to + 1, belowEnd)
  let edits
  let close = 0
  if (FENCE.test(above) && below === '```') {
    edits = [{ at: aboveFrom, remove: from - aboveFrom, insert: '' }, { at: to, remove: belowEnd - to, insert: '' }]
  } else if (FENCE.test(text.slice(from, firstEnd)) && text.slice(lastFrom, to) === '```') {
    // The closing fence goes with the line break before it, unless the opening one took that already (an empty block).
    const closeAt = Math.max(lastFrom - 1, firstEnd + 1)
    edits = [{ at: from, remove: firstEnd + 1 - from, insert: '' }, { at: closeAt, remove: to - closeAt, insert: '' }]
  } else {
    edits = [{ at: from, remove: 0, insert: OPEN }, { at: to, remove: 0, insert: CLOSE }]
    close = CLOSE.length
  }
  return { text: edit(text, edits), selection: { start: moved(edits, from), end: moved(edits, to) - close } }
}

// --- inserts ---

/** The text with [s, e] replaced by `insert`, and the selection [selStart, selEnd] (positions in the new text). */
function replaced(text, s, e, insert, selStart, selEnd) {
  return { text: text.slice(0, s) + insert + text.slice(e), selection: { start: selStart, end: selEnd } }
}

function link(text, start, end) {
  const [s, e] = trimmed(text, start, end)
  const label = text.slice(s, e)
  if (label === '' || NOT_LINK_TEXT.test(label)) {
    const md = `[${LINK_TEXT}](${LINK_ADDRESS})`
    return replaced(text, end, end, md, end + 1, end + 1 + LINK_TEXT.length)
  }
  if (ADDRESS.test(label)) return replaced(text, s, e, `[${LINK_TEXT}](${label})`, s + 1, s + 1 + LINK_TEXT.length)
  const addressAt = e + 3
  return replaced(text, s, e, `[${label}](${LINK_ADDRESS})`, addressAt, addressAt + LINK_ADDRESS.length)
}

/** `md` on a line of its own after the selection; [selFrom, selTo] is the selection inside `md`. */
function block(text, at, md, selFrom, selTo) {
  const before = at === 0 || text[at - 1] === '\n' ? '' : '\n'
  const after = at === text.length || text[at] === '\n' ? '' : '\n'
  const base = at + before.length
  return replaced(text, at, at, before + md + after, base + selFrom, base + selTo)
}

function image(text, start, end, { name, n }) {
  if (typeof name !== 'string') throw new TypeError('an image needs its name, as a string')
  if (!Number.isInteger(n)) throw new TypeError('an image needs its upload number, a whole number')
  if (n < 1 || n > 10) throw new RangeError('an upload number is from 1 to 10')
  // Brackets would end the image's text, and a line break the image.
  const alt = name.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()
  const md = `![${alt}](upload:${n})`
  return block(text, end, md, md.length, md.length)
}

function table(text, start, end) {
  return block(text, end, TABLE, 2, 2 + TABLE_HEADING.length)
}

function rule(text, start, end) {
  return block(text, end, '---', 3, 3)
}

function mention(text, start, end, { id }) {
  if (typeof id !== 'string') throw new TypeError('a mention needs the member\'s id, as a string')
  if (!ID.test(id)) throw new RangeError('a member\'s id is 17 to 20 digits')
  const md = `<@${id}>`
  return replaced(text, start, end, md, start + md.length, start + md.length)
}

function emoji(text, start, end, { text: md }) {
  if (typeof md !== 'string') throw new TypeError('an emoji needs its text, as a string')
  if (md === '' || /[\r\n]/.test(md)) throw new RangeError('an emoji is one line of text, not empty')
  return replaced(text, start, end, md, start + md.length, start + md.length)
}

// --- drafts ---

const isId = (value) => typeof value === 'string' && ID.test(value)

export function draftKey(postId, replyTo = null) {
  if (!isId(postId)) throw new TypeError('a draft belongs to a post: its id, as a string')
  if (replyTo !== null && !isId(replyTo)) throw new TypeError('a draft replies to a message, by its id as a string, or to none (null)')
  return `${DRAFT}${postId}:${replyTo ?? 'new'}`
}

export function saveDraft(storage, postId, replyTo, text) {
  const key = draftKey(postId, replyTo)
  if (typeof text !== 'string') throw new TypeError('a draft is text')
  try {
    if (/\S/.test(text)) storage.setItem(key, text)
    else storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export function loadDraft(storage, postId, replyTo) {
  const key = draftKey(postId, replyTo)
  try {
    const text = storage.getItem(key)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

export function clearDraft(storage, postId, replyTo) {
  const key = draftKey(postId, replyTo)
  try {
    storage.removeItem(key)
  } catch {
    // Nothing kept, or nothing that can be reached.
  }
}

export function clearAllDrafts(storage) {
  let keys
  try {
    // Every key named first, then the drafts removed: a browser may renumber its keys as one goes.
    keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key) => typeof key === 'string' && key.startsWith(DRAFT))
  } catch {
    return
  }
  for (const key of keys) {
    try {
      storage.removeItem(key)
    } catch {
      // The next one may still go.
    }
  }
}

export function draftStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
