/**
 * Discord-flavoured markdown → AST. Rendering is done elsewhere with Vue
 * render functions (never v-html), so this module never produces markup.
 * Unrecognised syntax stays literal text, the way Discord shows it. Every
 * scan is memoised or sticky-anchored, so hostile input stays linear.
 *
 * Lines are read one by one, but a spoiler can run over them. A `||` that its
 * line leaves as text (no `||` closes it there, and it is in no code) opens a
 * spoiler when a later line holds a `||`. It fails closed: the site hides all
 * that Discord may hide, and more where Discord's reading is unclear.
 *   - It closes at the first `||` a later line leaves as text. A one-line
 *     spoiler or code on the lines between sits inside it (nesting: Discord
 *     may read two spoilers with words shown between them; one hides more).
 *   - With no such `||`, it closes at the last `||` of the message, even one
 *     in inline code or a fence (a closer inside code: Discord may take it or
 *     skip it; this hides the most either way). Such a node has `lastBar:
 *     true`: that bar may instead open a spoiler whose close a cut took, so a
 *     preview masks from it to the end.
 *   - Bars in inline code or a fence never open one: Discord reads code first,
 *     and an opener there would pair the bars after it the other way round.
 *   - An opener in a quote, a list item or a heading cuts that line there. The
 *     spoiler runs to its closer, out of the quote if the closer is (an opener
 *     on a quote's last line: Discord may end it with the quote), and a quote
 *     cut by its bars goes on, as a quote, on both sides. What a cut leaves
 *     after the bars is read as words; markers alone before an opener (`- `,
 *     `# `, `1. `) are words at the start of the spoiler.
 * It is one `spoiler` node among the blocks, whose children are blocks. The
 * words before its opener and after its closer are lines of their own. A `||`
 * that nothing closes stays text, and a text with no spoiler over lines parses
 * exactly as it did when lines were read alone.
 */
const MAX_DEPTH = 16
// Leading whitespace is tolerated (Discord shows such lines literally; authors meant a heading).
// [^\n]* rather than .*$ — a stray U+2028 (common in pasted Discord text) must not break a
// match. Lines are already split on \n, so [^\n]* runs to the end of the line on its own.
const HEADING = /^[ \t]*(#{1,3}) +(\S[^\n]*)/
const SUBTEXT = /^[ \t]*-# +(\S[^\n]*)/
const LIST_ITEM = /^([ \t]*)([-*]|\d{1,9}\.) +([^\n]*)/
const FENCE_OPEN = /^```([\w+-]*)$/
const EMOJI = /<(a?):(\w{1,32}):(\d{17,20})>/y
const MENTION = /<(@!?|@&|#)(\d{17,20})>/y
const ANGLE_URL = /<(https?:\/\/[^\s<>]+)>/y
const MASKED = /\[([^[\]\n]+)\]\(\s*<?(https?:\/\/[^\s()<>]+)>?\s*\)/y
const BARE_URL = /https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_~|]/y
const ESCAPABLE = /[\\*_~|`<>#\-[\]()]/
const PAIRS = [
  ['||', 'spoiler'],
  ['**', 'strong'],
  ['__', 'underline'],
  ['~~', 'strike'],
]
const MENTION_KIND = { '@': 'user', '@!': 'user', '@&': 'role', '#': 'channel' }

export function parse(src) {
  if (typeof src !== 'string') throw new TypeError('markdown source must be a string')
  return readSpoilers(src.replace(/\r\n?/g, '\n').split('\n'))
}

// How a line sits in the message, as parseBlocks reads it: what quote it is in and whether it is code.
const PLAIN = 'plain'
const CODE = 'code'
const GROUP = 'group' // a line of a > quote
const START = 'start' // the line that opens a >>> quote
const DEEP = 'deep' // a line a >>> quote holds after it
// What a line keeps of its quote when a spoiler's bars cut it: the piece after the bars is read as words in it.
const CARRY = { [PLAIN]: 'text', [CODE]: 'text', [GROUP]: '> ', [START]: '>>> ', [DEEP]: '>>> ' }
// The quote marker written at the start of a whole line.
const OWN = { [GROUP]: '> ', [START]: '>>> ' }
// Nothing but the markers of a list item, a heading or a subtext.
const BARE = /^[ \t]*(?:(?:#{1,3}|-#|[-*]|\d{1,9}\.) +)?$/
const quoted = (line) => line.startsWith('> ') || line === '>'
const fenceEnd = (lines, i) => (FENCE_OPEN.test(lines[i]) ? lines.indexOf('```', i + 1) : -1)

/** → for each line, whether a fence holds it, in the lines of a quote (no quote opens in them). */
function codeIn(lines) {
  const code = []
  for (let i = 0; i < lines.length; ) {
    const close = fenceEnd(lines, i)
    for (const end = Math.max(close, i); i <= end; i++) code.push(close !== -1)
  }
  return code
}

/** → the role of each line of the message: the fences and quotes parseBlocks would find, in the same order. */
function rolesOf(lines) {
  const roles = []
  for (let i = 0; i < lines.length; ) {
    const close = fenceEnd(lines, i)
    if (close !== -1) {
      for (; i <= close; i++) roles.push(CODE)
    } else if (lines[i].startsWith('>>> ')) {
      codeIn([lines[i].slice(4), ...lines.slice(i + 1)]).forEach((code, k) => roles.push(code ? CODE : k === 0 ? START : DEEP))
      break
    } else if (quoted(lines[i])) {
      const from = i
      while (i < lines.length && quoted(lines[i])) i++
      for (const code of codeIn(lines.slice(from, i).map((line) => line.slice(2)))) roles.push(code ? CODE : GROUP)
    } else {
      roles.push(PLAIN)
      i++
    }
  }
  return roles
}

/** → where the first `||` that the text, read as one line, leaves as text starts; -1 when there is none. */
function openBar(text) {
  if (!text.includes('||')) return -1
  const bars = []
  parseInline(text, bars)
  return bars.length ? bars[0] : -1
}

/** → [line, column, whether it is the last bar] of the `||` that closes a spoiler opened on line i (see the top). */
function closerAfter(lines, roles, i, last) {
  for (let j = i + 1; j <= last; j++) {
    const at = roles[j] === CODE ? -1 : openBar(lines[j])
    if (at !== -1) return [j, at, false]
  }
  return [last, lines[last].lastIndexOf('||'), true]
}

/** The message's blocks, with each spoiler that runs over lines read as one node (see the comment at the top). */
function readSpoilers(lines) {
  const roles = rolesOf(lines)
  const last = lines.findLastIndex((line) => line.includes('||'))
  const out = []
  let piece = []
  let pieceLead
  const take = (text, lead) => {
    if (!piece.length) pieceLead = lead
    piece.push(text)
  }
  const flush = () => {
    if (piece.length) out.push(...parseBlocks(piece, false, pieceLead))
    piece = []
  }
  // `text` is what is left to read of line i; `lead` is undefined while it is the whole line, else how it is read.
  let text = lines[0]
  let lead
  for (let i = 0; i < lines.length; ) {
    const at = i < last && roles[i] !== CODE ? openBar(text) : -1
    if (at === -1) {
      take(text, lead)
      text = lines[++i]
      lead = undefined
      continue
    }
    const [j, c, lastBar] = closerAfter(lines, roles, i, last)
    const head = text.slice(0, at)
    const rest = head.slice((OWN[roles[i]] ?? '').length)
    // Nothing but markers before an opener that starts its line: they are words at the start of the spoiler. Anything
    // more stays a line of its own before it. (A piece after a closer always holds more: the closer's own delimiter.)
    const bare = lead === undefined && BARE.test(rest)
    if (!bare) take(head, lead)
    flush()
    const inner = [(bare ? rest : '') + text.slice(at + 2), ...lines.slice(i + 1, j)]
    const closing = lines[j].slice(0, c)
    if (closing.slice((OWN[roles[j]] ?? '').length).trim() !== '') inner.push(closing)
    const children = parseBlocks(inner, false, CARRY[roles[i]])
    out.push(lastBar ? { type: 'spoiler', children, lastBar } : { type: 'spoiler', children })
    i = j
    text = lines[j].slice(c + 2)
    lead = CARRY[roles[j]]
  }
  flush()
  return out
}

/**
 * Blocks from lines. `lead` says how the first line is read when it is the piece of a line a spoiler's bars cut:
 * 'text' as words only (never a fence, quote, heading or list), '> ' as such words going on in a > quote, '>>> ' as
 * such words in a >>> quote of all the lines. A quote the cut leaves empty is left out.
 */
function parseBlocks(lines, inQuote, lead) {
  const out = []
  let i = 0
  if (lead === '>>> ') {
    const children = parseBlocks(lines, true, 'text')
    return children.length ? [{ type: 'quote', children }] : out
  }
  if (lead === '> ') {
    for (i = 1; i < lines.length && quoted(lines[i]); ) i++
    const children = parseBlocks([lines[0], ...lines.slice(1, i).map((line) => line.slice(2))], true, 'text')
    if (children.length) out.push({ type: 'quote', children })
  } else if (lead === 'text') {
    if (lines[0].trim() !== '') out.push({ type: 'line', children: parseInline(lines[0]) })
    i = 1
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      const close = lines.indexOf('```', i + 1)
      if (close !== -1) {
        out.push({ type: 'codeblock', lang: fence[1], text: lines.slice(i + 1, close).join('\n') })
        i = close + 1
        continue
      }
    }
    if (!inQuote && line.startsWith('>>> ')) {
      out.push({ type: 'quote', children: parseBlocks([line.slice(4), ...lines.slice(i + 1)], true) })
      break
    }
    if (!inQuote && quoted(line)) {
      const inner = []
      while (i < lines.length && quoted(lines[i])) {
        inner.push(lines[i].slice(2)) // '>'.slice(2) is '' too
        i++
      }
      out.push({ type: 'quote', children: parseBlocks(inner, true) })
      continue
    }
    let m
    const titled = heading(line)
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
        const [list, next] = buildList(items, k, items[k].indent, 0)
        out.push(list)
        k = next
      }
      continue
    }
    out.push(line.trim() === '' ? { type: 'blank' } : { type: 'line', children: parseInline(line) })
    i++
  }
  return out
}

/** A heading or subtext node for the line, or null — on its own line or as a list item's text. */
function heading(text) {
  let m
  if ((m = HEADING.exec(text))) return { type: 'heading', level: m[1].length, children: parseInline(m[2]) }
  if ((m = SUBTEXT.exec(text))) return { type: 'subtext', children: parseInline(m[1]) }
  return null
}

function buildList(items, start, indent, depth) {
  const list = { type: 'list', ordered: /\d/.test(items[start].marker), items: [] }
  let k = start
  while (k < items.length && items[k].indent >= indent) {
    const it = items[k]
    if (it.indent > indent && list.items.length && depth < MAX_DEPTH) {
      const [child, next] = buildList(items, k, it.indent, depth + 1)
      list.items[list.items.length - 1].children.push(child)
      k = next
      continue
    }
    list.items.push({ marker: it.marker, children: [heading(it.text) ?? { type: 'line', children: parseInline(it.text) }] })
    k++
  }
  return [list, k]
}

function sticky(re, s, i) {
  re.lastIndex = i
  return re.exec(s)
}

// Recursion depth is bounded without a counter: a span's inner text runs up
// to the *nearest* closer of its delimiter, so no delimiter kind can recur
// inside itself (and link labels exclude brackets). Chains top out at ~8.
// `bars`, when given, gets where each `||` left as text starts, `at` on from
// where `s` starts in the line.
export function parseInline(s, bars, at = 0) {
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
      const end = closing(ticks, i + ticks.length)
      if (end > i + ticks.length) {
        i = push({ type: 'code', text: s.slice(i + ticks.length, end) }, end + ticks.length)
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
      i = push({ type: 'link', href: m[2], children: parseInline(m[1], bars, at + i + 1) }, i + m[0].length)
      continue
    }
    if ((m = sticky(BARE_URL, s, i))) {
      i = push({ type: 'url', href: m[0] }, i + m[0].length)
      continue
    }
    if (s.startsWith('***', i)) {
      const end = closing('***', i + 3)
      if (end > i + 3) {
        const inner = { type: 'em', children: parseInline(s.slice(i + 3, end), bars, at + i + 3) }
        i = push({ type: 'strong', children: [inner] }, end + 3)
        continue
      }
    }
    const pair = PAIRS.find(([d]) => s.startsWith(d, i))
    if (pair) {
      const end = closing(pair[0], i + 2)
      if (end > i + 2) {
        i = push({ type: pair[1], children: parseInline(s.slice(i + 2, end), bars, at + i + 2) }, end + 2)
        continue
      }
    }
    if ((c === '*' || c === '_') && isEmOpen(s, i, c)) {
      const end = closing(c, i + 1)
      if (end !== -1 && isEmClose(s, end, c)) {
        i = push({ type: 'em', children: parseInline(s.slice(i + 1, end), bars, at + i + 1) }, end + 1)
        continue
      }
    }
    if (bars && pair?.[0] === '||') bars.push(at + i)
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
    case 'emoji':
      return o.raw ? n.raw : `:${n.name}:`
    case 'mention':
      return o.raw ? n.raw : ''
    case 'blank':
      return '\n'
    case 'list':
      return n.items.map((it) => (o.raw ? it.marker : '') + plainText(it.children, o)).join('')
    case 'heading':
    case 'subtext':
    case 'line':
      return plainText(n.children, o) + '\n'
    default:
      return plainText(n.children, o)
  }
}
