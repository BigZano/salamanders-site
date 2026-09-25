/**
 * Discord-flavoured markdown → AST. Rendering is done elsewhere with Vue
 * render functions (never v-html), so this module never produces markup.
 * Unrecognised syntax stays literal text, the way Discord shows it. Every
 * scan is memoised or sticky-anchored, so hostile input stays linear.
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
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'), false)
}

function parseBlocks(lines, inQuote) {
  const out = []
  let i = 0
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
    if (!inQuote && (line.startsWith('> ') || line === '>')) {
      const inner = []
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
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
