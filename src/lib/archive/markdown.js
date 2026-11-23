/**
 * Discord-flavoured markdown → AST. Rendering is done elsewhere with Vue
 * render functions (never v-html), so this module never produces markup.
 * Unrecognised syntax stays literal text, the way Discord shows it. Every
 * scan is memoised or sticky-anchored, so hostile input stays linear.
 *
 * Lines are read one by one (and only so with `{ oneLine: true }`, the Legion
 * Archive's reading), but by default a spoiler can run over them, and Discord may
 * read the bars of a message in more ways than one. Its spoiler rule may match
 * bars as text, across lines and through code; its bold, italics and code may
 * run over lines or end mid-line, and its code blocks may open and close
 * mid-line; a quote, a heading or a list item may be read alone. So the site
 * fails closed by construction, without choosing among them:
 *   - A line is certain when it has no `||`, or when its bars pair within it
 *     under every reading: it is no code, its pipes come in runs of one or two,
 *     it has an even number of bars with words (not blank) between each pair,
 *     and it holds none of `` ` \ * _ ~ [ < ``, `://` or another line break.
 *   - The lines before the first line that is not certain parse as they always
 *     did. From the first `||` of that line to the last `||` of the message,
 *     when that is on a later line, all is one `spoiler` node (`lastBar: true`,
 *     so a preview masks from it to the end).
 * Why that hides all any reading hides. A reading hides only between two bars
 * it pairs. (1) Before the first line U that is not certain, no reading has a
 * spoiler open when a line starts. That holds at the start; a line with no
 * bars opens none; and nothing can hold the bars of a certain line but a code
 * or a span that covers all of it (it has no mark to start or end one), so a
 * reading either shows them as code or pairs them within the line, each bar
 * with the next, as the site's one-line parse does, and ends the line with
 * none open. So before U a reading hides at most what the site hides there.
 * (2) No reading hides anything after the last `||` L: a hidden stretch ends at
 * a bar. (3) Nor anything on U before its first `||`, by (1). So all a reading
 * hides lies before U, where the site hides as much, or from the first `||` of
 * U to L. When L is on U, every other bar is on a certain line, and the old
 * one-line parse stands.
 * The node's children are blocks. The words before its first bar and after its
 * last are lines of their own. A quote cut by the bars goes on, as a quote, on
 * both sides; what a cut leaves after the bars is read as words; markers alone
 * before the first bar (`- `, `# `, `1. `) are words at the start of the node.
 * A text with every bar on one line, or only on certain lines, parses exactly
 * as it did when lines were read alone.
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

/**
 * → the blocks of a message. By default a spoiler may run over lines, read so that it fails closed (see the comment at
 * the top). `{ oneLine: true }` reads each line alone, exactly as this parser did at 22b6793: the Legion Archive's
 * reading, whose formatting never changes. Options that are no object, or a `oneLine` that is no boolean, are a TypeError.
 */
export function parse(src, options) {
  if (typeof src !== 'string') throw new TypeError('markdown source must be a string')
  if (options !== undefined && (typeof options !== 'object' || options === null)) throw new TypeError('markdown options must be an object')
  if (options?.oneLine !== undefined && typeof options.oneLine !== 'boolean') throw new TypeError('oneLine must be true or false')
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  return options?.oneLine ? parseBlocks(lines, false) : readSpoilers(lines)
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

// What may change how a line's bars pair, in some reading: code, escapes, spans, links, mentions, emoji, addresses,
// and line breaks other than \n.
const UNSURE = /[`\\*_~[<\u2028\u2029\u0085\v\f]|:\/\//

/** Whether every reading pairs the line's bars within it (see the comment at the top). */
function certain(line, role) {
  if (!line.includes('||')) return true
  if (role === CODE || UNSURE.test(line) || line.includes('|||')) return false
  const pieces = line.split('||')
  return pieces.length % 2 === 1 && pieces.every((piece, k) => k % 2 === 0 || /\S/.test(piece))
}

/** The message's blocks: the lines before the first one that is not certain as they were, then one spoiler to the last `||`. */
function readSpoilers(lines) {
  const roles = rolesOf(lines)
  const last = lines.findLastIndex((line) => line.includes('||'))
  const u = lines.findIndex((line, k) => !certain(line, roles[k]))
  if (u === -1 || u === last) return parseBlocks(lines, false)
  const at = lines[u].indexOf('||')
  const c = lines[last].lastIndexOf('||')
  const head = lines[u].slice(0, at)
  const rest = head.slice((OWN[roles[u]] ?? '').length)
  // Nothing but markers before the first bar: they are words at the start of the spoiler. Anything more stays before it.
  const bare = BARE.test(rest)
  const before = bare ? lines.slice(0, u) : [...lines.slice(0, u), head]
  const inner = [(bare ? rest : '') + lines[u].slice(at + 2), ...lines.slice(u + 1, last)]
  const closing = lines[last].slice(0, c)
  if (closing.slice((OWN[roles[last]] ?? '').length).trim() !== '') inner.push(closing)
  return [
    ...parseBlocks(before, false),
    { type: 'spoiler', children: parseBlocks(inner, false, CARRY[roles[u]]), lastBar: true },
    ...parseBlocks([lines[last].slice(c + 2), ...lines.slice(last + 1)], false, CARRY[roles[last]]),
  ]
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
export function parseInline(s) {
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
      i = push({ type: 'link', href: m[2], children: parseInline(m[1]) }, i + m[0].length)
      continue
    }
    if ((m = sticky(BARE_URL, s, i))) {
      i = push({ type: 'url', href: m[0] }, i + m[0].length)
      continue
    }
    if (s.startsWith('***', i)) {
      const at = closing('***', i + 3)
      if (at > i + 3) {
        const inner = { type: 'em', children: parseInline(s.slice(i + 3, at)) }
        i = push({ type: 'strong', children: [inner] }, at + 3)
        continue
      }
    }
    const pair = PAIRS.find(([d]) => s.startsWith(d, i))
    if (pair) {
      const at = closing(pair[0], i + 2)
      if (at > i + 2) {
        i = push({ type: pair[1], children: parseInline(s.slice(i + 2, at)) }, at + 2)
        continue
      }
    }
    if ((c === '*' || c === '_') && isEmOpen(s, i, c)) {
      const at = closing(c, i + 1)
      if (at !== -1 && isEmClose(s, at, c)) {
        i = push({ type: 'em', children: parseInline(s.slice(i + 1, at)) }, at + 1)
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
