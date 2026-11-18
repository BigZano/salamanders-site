/**
 * Discord-flavoured markdown → AST, for the site and the server alike (this file has no imports, so the site bundles it
 * as it is). Rendering is done elsewhere with Vue render functions (never v-html), so this module never produces markup.
 * Unrecognised syntax stays literal text, the way Discord shows it. Every scan is memoised, bounded or sticky-anchored,
 * so hostile input stays linear.
 *
 * parse(src, { dialect = 'discord' }) → block nodes. parseInline(s, { dialect }) → inline nodes. plainText(nodes, { raw })
 * → text. walk(nodes, visit) visits every node, in document order. A dialect other than these two is a RangeError.
 *
 * The `discord` dialect is what Discord itself shows, for every message written in Discord: bold, italic, underline,
 * strike, spoilers, code, quotes, headings 1-3, subtext, lists, masked links, mentions and custom emoji. A `||` that is
 * opened on one line closes on a later line of the same paragraph (no blank line, heading, list, quote or code block
 * between): that makes one `line` node, its spoiler holding the lines with a { type: 'br' } between them.
 *
 * The `extended` dialect is for messages written on the site. It is the Discord set, plus:
 * - headings of levels 4 to 6;
 * - { type: 'divider' } for a line of three or more hyphens;
 * - { type: 'table', head: cells, rows: cells[] }, where a cell is a list of inline nodes: a header row, a rule row of
 *   hyphens (a colon at either end is allowed, and means nothing here) with as many cells, then rows up to the first line
 *   with no pipe in it. A pipe inside a cell is written \|. A short row is filled out with empty cells. At most 10
 *   columns and 50 rows; a table with more, or a row with more cells than the header has, is literal text;
 * - { type: 'image', alt, ref } for ![alt](upload:N), N from 1 to 10 and written without a leading zero. `ref` is that N
 *   as a number, and `alt` the text in the brackets as it was written. Any other image address makes no image: an https
 *   one is the masked link Discord shows after a "!", and the rest is literal text;
 * - { type: 'footnoteRef', label } for [^label] when a note by that label is defined, and, as the last block of the
 *   document, { type: 'footnotes', items: [{ label, children }] }, one item for each `[^label]: text` line at the top
 *   level (not in a quote, a list or a code block). A label is 1 to 20 word characters; the first definition of a label
 *   is the note and a later one an ordinary line; at most 20 notes, the 21st and later ones ordinary lines. The text of a
 *   note is one line of inline nodes, in which no reference is resolved: a note cannot cite itself or another.
 *   A reference to a label that no note defines is literal text.
 * parseInline has no notes to point at, so it never makes a footnoteRef.
 */
const MAX_DEPTH = 16
const MAX_COLUMNS = 10
const MAX_ROWS = 50
const MAX_FOOTNOTES = 20
// Leading whitespace is tolerated (Discord shows such lines literally; authors meant a heading).
// [^\n]* rather than .*$ — a stray U+2028 (common in pasted Discord text) must not break a
// match. Lines are already split on \n, so [^\n]* runs to the end of the line on its own.
const HEADING = /^[ \t]*(#{1,3}) +(\S[^\n]*)/
const HEADING_EXTENDED = /^[ \t]*(#{1,6}) +(\S[^\n]*)/
const SUBTEXT = /^[ \t]*-# +(\S[^\n]*)/
const LIST_ITEM = /^([ \t]*)([-*]|\d{1,9}\.) +([^\n]*)/
const FENCE_OPEN = /^```([\w+-]*)$/
const DIVIDER = /^[ \t]*-{3,}[ \t]*$/
const RULE_CELL = /^:?-+:?$/
const FOOTNOTE_DEF = /^\[\^(\w{1,20})\]:[ \t]+(\S[^\n]*)/
const FOOTNOTE_REF = /\[\^(\w{1,20})\]/y
const IMAGE = /!\[([^[\]\n]*)\]\(upload:(10|[1-9])\)/y
const EMOJI = /<(a?):(\w{1,32}):(\d{17,20})>/y
const MENTION = /<(@!?|@&|#)(\d{17,20})>/y
const ANGLE_URL = /<(https?:\/\/[^\s<>]+)>/y
const MASKED = /\[([^[\]\n]+)\]\(\s*<?(https?:\/\/[^\s()<>]+)>?\s*\)/y
const BARE_URL = /https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_~|]/y
const ESCAPABLE = /[\\*_~|`<>#\-[\]()]/
const SPOILER = '||'
const PAIRS = [
  [SPOILER, 'spoiler'],
  ['**', 'strong'],
  ['__', 'underline'],
  ['~~', 'strike'],
]
const MENTION_KIND = { '@': 'user', '@!': 'user', '@&': 'role', '#': 'channel' }
// What a note's text is read with: no reference in it points anywhere.
const NO_LABELS = new Set()
const NOTE_ENV = { extended: true, labels: NO_LABELS, notes: null }

/** → what the parse of one document keeps: the dialect, the labels a reference may point at, and the notes found. */
const envOf = (extended, labels) => ({ extended, labels, notes: new Map() })

function dialectOf(dialect) {
  if (dialect === 'discord') return false
  if (dialect === 'extended') return true
  throw new RangeError('markdown dialect must be "discord" or "extended"')
}

export function parse(src, { dialect = 'discord' } = {}) {
  if (typeof src !== 'string') throw new TypeError('markdown source must be a string')
  const extended = dialectOf(dialect)
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  // A reference is a footnoteRef only when a note by its label is defined, and a definition may come after the reference,
  // so a document with notes is read a second time, told which labels there are. The notes it finds are the same.
  const first = envOf(extended, NO_LABELS)
  const nodes = parseBlocks(lines, false, first)
  // Stryker disable next-line ConditionalExpression: a second pass over a document with no notes gives the same nodes; the check only saves the time
  if (first.notes.size === 0) return nodes
  return parseBlocks(lines, false, envOf(true, new Set(first.notes.keys())))
}

function parseBlocks(lines, inQuote, env) {
  const out = []
  // Set once no closing fence is left in `lines`, so that no later opener looks for one again (each look is a scan to the end).
  let fenceless = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = fenceless ? null : FENCE_OPEN.exec(line)
    if (fence) {
      const close = lines.indexOf('```', i + 1)
      if (close !== -1) {
        out.push({ type: 'codeblock', lang: fence[1], text: lines.slice(i + 1, close).join('\n') })
        i = close + 1
        continue
      }
      fenceless = true
    }
    if (!inQuote && line.startsWith('>>> ')) {
      out.push({ type: 'quote', children: parseBlocks([line.slice(4), ...lines.slice(i + 1)], true, env) })
      break
    }
    if (!inQuote && (line.startsWith('> ') || line === '>')) {
      const inner = []
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        inner.push(lines[i].slice(2)) // '>'.slice(2) is '' too
        i++
      }
      out.push({ type: 'quote', children: parseBlocks(inner, true, env) })
      continue
    }
    let m
    const titled = heading(line, env)
    if (titled) {
      out.push(titled)
      i++
      continue
    }
    if (LIST_ITEM.test(line)) {
      const items = []
      // Stryker disable next-line ConditionalExpression,EqualityOperator: exec(undefined) tests "undefined", which never matches
      while (i < lines.length && (m = LIST_ITEM.exec(lines[i]))) {
        items.push({ indent: m[1].replace(/\t/g, '  ').length, marker: m[2], text: m[3] })
        i++
      }
      for (let k = 0; k < items.length; ) {
        const [list, next] = buildList(items, k, items[k].indent, 0, env)
        out.push(list)
        k = next
      }
      continue
    }
    if (env.extended) {
      if (DIVIDER.test(line)) {
        out.push({ type: 'divider' })
        i++
        continue
      }
      // Only at the top of the document, where the notes are listed; the first definition of a label is the note.
      if (!inQuote && (m = FOOTNOTE_DEF.exec(line)) && !env.notes.has(m[1]) && env.notes.size < MAX_FOOTNOTES) {
        env.notes.set(m[1], { label: m[1], children: [{ type: 'line', children: inline(m[2], NOTE_ENV, null) }] })
        i++
        continue
      }
      const table = tableAt(lines, i, env)
      if (table) {
        if (table.node) out.push(table.node)
        else for (let k = i; k < table.next; k++) out.push({ type: 'plain', src: lines[k] })
        i = table.next
        continue
      }
    }
    // A plain line stays as it was written until the lines round it are known: see joinRuns.
    out.push(line.trim() === '' ? { type: 'blank' } : { type: 'plain', src: line })
    i++
  }
  const blocks = joinRuns(out, env)
  if (!inQuote && env.notes.size > 0) blocks.push({ type: 'footnotes', items: [...env.notes.values()] })
  return blocks
}

/**
 * The blocks, with each paragraph (a run of plain lines, no blank line, heading, list, quote or code block between them)
 * turned into line nodes: a line each, except where a spoiler runs over lines.
 */
function joinRuns(blocks, env) {
  const out = []
  let run = []
  const close = () => {
    for (const node of joinRun(run, env)) out.push(node)
    run = []
  }
  for (const block of blocks) {
    if (block.type === 'plain') run.push(block)
    else {
      close()
      out.push(block)
    }
  }
  close()
  return out
}

/**
 * A paragraph's lines → its line nodes. Each line is read with the lines after it in hand (see inline), so a `||` that no
 * `||` closes on its own line takes as many of the next lines as the spoiler needs to close, into one line node.
 * A line with such a `||` and none after it in the paragraph is read as it would be alone, and a scan for a closer that
 * finds none means no later line has a `||` either, so a paragraph is scanned to its end once at most.
 */
function joinRun(run, env) {
  const lines = run.map((block) => block.src)
  const out = []
  for (let k = 0; k < lines.length; ) {
    const flow = { lines, at: k }
    out.push({ type: 'line', children: inline(lines[k], env, flow) })
    k = flow.at + 1
  }
  return out
}

/** → the index of the first line after `at` that has a `||` in it, or -1. */
function barAfter(lines, at) {
  for (let j = at + 1; j < lines.length; j++) if (lines[j].includes(SPOILER)) return j
  return -1
}

/** A heading or subtext node for the line, or null — on its own line or as a list item's text. */
function heading(text, env) {
  let m
  if ((m = (env.extended ? HEADING_EXTENDED : HEADING).exec(text))) return { type: 'heading', level: m[1].length, children: inline(m[2], env, null) }
  if ((m = SUBTEXT.exec(text))) return { type: 'subtext', children: inline(m[1], env, null) }
  return null
}

function buildList(items, start, indent, depth, env) {
  const list = { type: 'list', ordered: /\d/.test(items[start].marker), items: [] }
  let k = start
  while (k < items.length && items[k].indent >= indent) {
    const it = items[k]
    if (it.indent > indent && list.items.length && depth < MAX_DEPTH) {
      const [child, next] = buildList(items, k, it.indent, depth + 1, env)
      list.items[list.items.length - 1].children.push(child)
      k = next
      continue
    }
    list.items.push({ marker: it.marker, children: [heading(it.text, env) ?? { type: 'line', children: inline(it.text, env, null) }] })
    k++
  }
  return [list, k]
}

/**
 * → the cells of a table row, trimmed, with the text of each (a pipe written \| is not a separator), or null when the line
 * has no pipe to separate anything or no cell. One pipe at either end is a border, not a separator.
 */
function rowCells(line) {
  const s = line.trim()
  const cells = []
  let from = 0
  let at = 0
  // A backslash hides the character after it: only \| matters here, and a cell's own text reads the rest.
  let hidden = false
  for (const c of s) {
    if (hidden) hidden = false
    else if (c === '\\') hidden = true
    else if (c === '|') {
      cells.push(s.slice(from, at))
      from = at + 1
    }
    at += c.length
  }
  if (cells.length === 0) return null
  cells.push(s.slice(from))
  if (cells[0] === '') cells.shift()
  if (cells.at(-1) === '') cells.pop()
  return cells.length === 0 ? null : cells.map((cell) => cell.trim())
}

/**
 * → { node, next } for the table that starts at line i (`next` is the line after it), or null when none does: the line has
 * no pipe, the one under it is no rule row of the same width, or there are more than 10 columns. A table that is too much
 * (more than 50 rows, or a row with more cells than the header) is { node: null, next }: its lines are literal text, all of
 * them, so none of them is read as the start of a table of its own. Every line is read once, so the time stays linear.
 */
function tableAt(lines, i, env) {
  const head = rowCells(lines[i])
  const under = lines[i + 1]
  if (head === null || head.length > MAX_COLUMNS || under === undefined) return null
  const rule = rowCells(under)
  if (rule === null || rule.length !== head.length || !rule.every((cell) => RULE_CELL.test(cell))) return null
  const rows = []
  let next = i + 2
  for (; next < lines.length; next++) {
    const cells = rowCells(lines[next])
    if (cells === null) break
    rows.push(cells)
  }
  if (rows.length > MAX_ROWS || rows.some((cells) => cells.length > head.length)) return { node: null, next }
  const read = (text) => inline(text, env, null)
  return { next, node: { type: 'table', head: head.map(read), rows: rows.map((row) => head.map((_, c) => read(row[c] ?? ''))) } }
}

function sticky(re, s, i) {
  re.lastIndex = i
  return re.exec(s)
}

export function parseInline(s, { dialect = 'discord' } = {}) {
  return inline(s, { extended: dialectOf(dialect), labels: NO_LABELS, notes: null }, null)
}

// Recursion depth is bounded without a counter: a span's inner text runs up
// to the *nearest* closer of its delimiter, so no delimiter kind can recur
// inside itself (and link labels exclude brackets). Chains top out at ~8.
//
// `flow` is null for a span's inner text, and for text that is no line of a paragraph: it never reaches past its line.
// For a line of a paragraph it is { lines, at }, the paragraph's lines and the index of the one being read: a `||` with no
// closer on its line closes at the first `||` on a later line, if any, and reading goes on from there (`at` moves with it).
// Each line inside the spoiler is read on its own, so no other mark runs over lines.
function inline(s, env, flow) {
  const out = []
  let text = ''
  const flush = () => {
    if (text) out.push({ type: 'text', value: text })
    text = ''
  }
  const push = (node, next) => {
    flush()
    out.push(node)
    return next
  }
  // No memo needed: when a delimiter has no closer after i, no later opener
  // of it exists either, so each failed scan happens at most once per delimiter.
  const closing = (delim, from) => s.indexOf(delim, from)

  let i = 0
  while (i < s.length) {
    const c = s[i]
    let m
    if (c === '\\' && ESCAPABLE.test(s.charAt(i + 1))) {
      text += s[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      const ticks = s.startsWith('``', i) ? '``' : '`'
      const at = closing(ticks, i + ticks.length)
      if (at > i + ticks.length) {
        i = push({ type: 'code', text: s.slice(i + ticks.length, at) }, at + ticks.length)
        continue
      }
    }
    if ((m = sticky(EMOJI, s, i))) {
      i = push({ type: 'emoji', name: m[2], id: m[3], animated: m[1] === 'a', raw: m[0] }, i + m[0].length)
      continue
    }
    if ((m = sticky(MENTION, s, i))) {
      i = push({ type: 'mention', kind: MENTION_KIND[m[1]], id: m[2], raw: m[0] }, i + m[0].length)
      continue
    }
    if ((m = sticky(ANGLE_URL, s, i))) {
      i = push({ type: 'url', href: m[1] }, i + m[0].length)
      continue
    }
    if ((m = sticky(MASKED, s, i))) {
      i = push({ type: 'link', href: m[2], children: inline(m[1], env, null) }, i + m[0].length)
      continue
    }
    if (env.extended && (m = sticky(IMAGE, s, i))) {
      i = push({ type: 'image', alt: m[1], ref: Number(m[2]) }, i + m[0].length)
      continue
    }
    if ((m = sticky(FOOTNOTE_REF, s, i)) && env.labels.has(m[1])) {
      i = push({ type: 'footnoteRef', label: m[1] }, i + m[0].length)
      continue
    }
    if ((m = sticky(BARE_URL, s, i))) {
      i = push({ type: 'url', href: m[0] }, i + m[0].length)
      continue
    }
    if (s.startsWith('***', i)) {
      const at = closing('***', i + 3)
      if (at > i + 3) {
        const inner = { type: 'em', children: inline(s.slice(i + 3, at), env, null) }
        i = push({ type: 'strong', children: [inner] }, at + 3)
        continue
      }
    }
    const pair = PAIRS.find(([d]) => s.startsWith(d, i))
    if (pair) {
      const at = closing(pair[0], i + 2)
      if (at > i + 2) {
        i = push({ type: pair[1], children: inline(s.slice(i + 2, at), env, null) }, at + 2)
        continue
      }
      const j = at === -1 && pair[0] === SPOILER && flow ? barAfter(flow.lines, flow.at) : -1
      if (j !== -1) {
        const closer = flow.lines[j].indexOf(SPOILER)
        const parts = [s.slice(i + 2), ...flow.lines.slice(flow.at + 1, j), flow.lines[j].slice(0, closer)]
        const children = []
        parts.forEach((part, n) => {
          if (n > 0) children.push({ type: 'br' })
          for (const node of inline(part, env, null)) children.push(node)
        })
        i = push({ type: 'spoiler', children }, closer + 2)
        s = flow.lines[j]
        flow.at = j
        continue
      }
    }
    if ((c === '*' || c === '_') && isEmOpen(s, i, c)) {
      const at = closing(c, i + 1)
      if (at !== -1 && isEmClose(s, at, c)) {
        i = push({ type: 'em', children: inline(s.slice(i + 1, at), env, null) }, at + 1)
        continue
      }
    }
    text += c
    i++
  }
  flush()
  return out
}

const WORD = /[\p{L}\p{N}]/u
function isEmOpen(s, i, c) {
  const next = s.charAt(i + 1) // '' at end of input: closing() then finds no closer
  if (/\s/.test(next) || next === c) return false
  return c === '*' || i === 0 || !WORD.test(s[i - 1])
}
function isEmClose(s, at, c) {
  if (/\s/.test(s[at - 1])) return false
  return c === '*' || at + 1 >= s.length || !WORD.test(s[at + 1])
}

export function walk(nodes, visit) {
  for (const n of nodes) {
    visit(n)
    if (n.children) walk(n.children, visit)
    if (n.items) for (const it of n.items) walk(it.children, visit)
    if (n.type === 'table') for (const row of [n.head, ...n.rows]) for (const c of row) walk(c, visit)
  }
}

export function plainText(nodes, opts = {}) {
  let s = ''
  for (const n of nodes) s += nodeText(n, opts)
  return s
}

function nodeText(n, o) {
  switch (n.type) {
    case 'text':
      return n.value
    case 'code':
      return n.text
    case 'codeblock':
      return (o.raw ? n.lang : '') + n.text + '\n'
    case 'url':
      return n.href
    case 'link':
      return plainText(n.children, o) + (o.raw ? n.href : '')
    case 'image':
      return n.alt + (o.raw ? `upload:${n.ref}` : '')
    case 'emoji':
      return o.raw ? n.raw : `:${n.name}:`
    case 'mention':
      return o.raw ? n.raw : ''
    case 'footnoteRef':
      return o.raw ? `[^${n.label}]` : ''
    case 'blank':
    case 'divider':
    case 'br':
      return '\n'
    case 'list':
      return n.items.map((it) => (o.raw ? it.marker : '') + plainText(it.children, o)).join('')
    case 'footnotes':
      return n.items.map((it) => (o.raw ? it.label : '') + plainText(it.children, o)).join('')
    case 'table':
      return [n.head, ...n.rows].map((row) => row.map((c) => plainText(c, o)).join(' ') + '\n').join('')
    case 'heading':
    case 'subtext':
    case 'line':
      return plainText(n.children, o) + '\n'
    default:
      return plainText(n.children, o)
  }
}
