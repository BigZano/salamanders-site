/**
 * Discord-flavoured markdown → AST, for the site and the server alike (this file has no imports, so the site bundles it
 * as it is). Rendering is done elsewhere with Vue render functions (never v-html), so this module never produces markup.
 * Unrecognised syntax stays literal text, the way Discord shows it. Every scan is memoised, bounded or sticky-anchored,
 * so hostile input stays linear.
 *
 * parse(src, { dialect = 'discord', oneLine = false }) → block nodes. parseInline(s, { dialect }) → inline nodes.
 * plainText(nodes, { raw }) → text. walk(nodes, visit) visits every node, in document order. maskSpoilers(src) → the text
 * with SPOILER_MASK in place of all a spoiler may hide in it (see the end of this comment). A dialect other than these two
 * is a RangeError, and so is `oneLine: true` in the extended dialect; options that are no object, or a `oneLine` that is
 * no boolean, are a TypeError.
 *
 * The `discord` dialect is what Discord itself shows, for every message written in Discord: bold, italic, underline,
 * strike, spoilers, code, quotes, headings 1-3, subtext, lists, masked links, mentions and custom emoji.
 *
 * Its lines are read one by one (and only so with `{ oneLine: true }`, the Legion Archive's reading, exactly as the
 * site's parser read them at 22b6793), but by default a spoiler can run over them, and Discord may read the bars of a
 * message in more ways than one. Its spoiler rule may match bars as text, across lines and through code; its bold,
 * italics and code may run over lines or end mid-line, and its code blocks may open and close mid-line; a quote, a
 * heading or a list item may be read alone. So the site fails closed by construction, without choosing among them:
 *   - A line is certain when it has no `||`, or when its bars pair within it under every reading: it is no code, its
 *     pipes come in runs of one or two, it has an even number of bars with words (not blank) between each pair, it holds
 *     none of `` ` \ * _ ~ [ < ``, `://` or another line break, and none of `) > ]` from its first `||` on. A Discord
 *     mention, channel, role, emoji, timestamp or slash command (TOKEN) is a word there when it comes before the first
 *     `||`, or after it with a space before its `>` and past the line's leading spaces, tabs and `>`, and no `_` in it.
 *   - The lines before the first line that is not certain parse as they always did. From the first `||` of that line to
 *     the last `||` of the message, when that is on a later line, all is one `spoiler` node (`lastBar: true`, so a
 *     preview masks from it to the end).
 * Why that hides all any reading hides. A reading hides only between two bars it pairs. (1) Before the first line U that
 * is not certain, no reading has a spoiler open when a line starts. That holds at the start; a line with no bars opens
 * none; and nothing can hold the bars of a certain line but a construct that covers all of it, so a reading either shows
 * them (as code, an address, a title) or pairs them within the line, each bar with the next, as the site's one-line
 * parse does, and ends the line with none open. So before U a reading hides at most what the site hides there. Nothing
 * else can, as a certain line has no mark that starts a construct (but in a token, below), nor one that ends one after
 * its first bar (what ends before it held none of the line's bars):
 *   code and code blocks start and end at `` ` ``; spans at `*`, `_` (`__`), `~` (`~~`); an escape is `\`; a link or an
 *   image starts at `[` (`![`) and ends at `)`, its title and its `( … )` address lying between the brackets and that
 *   `)`, so `"`, `'` and `(` need no place; an angle form (autolink, mailto) starts at `<` and ends at `>`; a reference
 *   link would end at `]`; a bare address starts at `://`, cannot cross a line break, but may hold bars; a quote,
 *   heading, subtext or list item is a block of whole lines, which ends no spoiler a line leaves closed; a quote's or a
 *   list item's text is read again without the leading spaces, tabs (read as spaces) and `>` of its lines, and an
 *   item's, a heading's or a subtext's without its marker, but such a text starts at that marker's line.
 *   A token lies on one line and holds no bar, and of those marks only `<`, `>` and, in a name, `_`. Read whole, it is a
 *   word. A reading that reads into it may start an angle form at its `<`, which ends at its own `>` and is neither (no
 *   `:/`, nothing before its `@`), or a span at a `_`; a `_` may end a span, and its `>` an angle form, begun before it.
 *   Before the first bar, what it ends held none of the bars, and a span it starts ends before them too, or covers the
 *   rest of the line, inside which they pair as above (no `_` comes after the first bar). After the first bar it has no
 *   `_`, and an angle form ending at its `>` would hold the space before that `>` in every text that reads the line,
 *   which no autolink or mailto can: no reading cuts a space past the leading run, and a marker's space is cut only from
 *   a text that starts on its line, which holds no earlier `<`.
 * (2) No reading hides anything after the last `||` L: a hidden stretch ends at a bar. (3) Nor anything on U before its
 * first `||`, by (1). So all a reading hides lies before U, where the site hides as much, or from the first `||` of U to
 * L. When L is on U, every other bar is on a certain line, and the old one-line parse stands.
 * The node's children are blocks. The words before its first bar and after its last are lines of their own. A quote cut
 * by the bars goes on, as a quote, on both sides; what a cut leaves after the bars is read as words; markers alone before
 * the first bar (`- `, `# `, `1. `) are words at the start of the node. A text with every bar on one line, or only on
 * certain lines, parses exactly as it did when lines were read alone.
 * Where this dialect differs from the parser of 22b6793 it is in none of that. Its paragraphs are runs of lines (see
 * joinRuns), but it never joins their lines into one spoiler, as the extended dialect does (below): each line is read
 * alone, so the one-line parse the proof leans on is the same, and the extended dialect's constructs are never read here.
 *
 * The `extended` dialect is for messages written on the site. It is the Discord set, plus:
 * - a spoiler over lines: a `||` opened on one line closes on a later line of the same paragraph (no blank line, heading,
 *   list, quote or code block between), which makes one `line` node, its spoiler holding the lines with a { type: 'br' }
 *   between them. Bars this leaves open (over a blank line, say) are text, in the composer's Preview as here, and the form
 *   sends them escaped. None of the Discord dialect's fail-closed reading is done here: what a member writes on the site
 *   is shown as they previewed it;
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
 *
 * maskSpoilers(src) is how the site quotes a message: a quote is read again in the extended dialect and sent to Discord as
 * that reads it, so nothing hidden may go into one. It gives the text with SPOILER_MASK in place of each pair of bars on a
 * certain line before U, with what is between them, and of all from the first `||` of U to the last `||` (of U alone, when
 * it holds the last): what any reading of Discord's may hide (above). What is left holds no `||`, so no reading of it in
 * either dialect hides anything, and it holds only words that every reading shows. It masks all the extended dialect hides
 * too: a spoiler over lines opens only at a `||` its line leaves open, which a certain line never does, and the dialect's
 * own constructs start at a mark a certain line has not (`[` for a picture or a note), or are whole lines with no bars (a
 * divider), or read a line's pipes as the borders of cells (a table), which hides nothing. So a reply of the site's is
 * quoted through it as well. A source that is no string is a TypeError.
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

const linesOf = (src) => src.replace(/\r\n?/g, '\n').split('\n')

/**
 * → the blocks of a message. In the Discord dialect a spoiler may run over lines, read so that it fails closed (see the
 * comment at the top); `{ oneLine: true }` reads each line alone, exactly as the site's parser did at 22b6793: the Legion
 * Archive's reading, whose formatting never changes. The extended dialect has no such reading.
 */
export function parse(src, options) {
  if (typeof src !== 'string') throw new TypeError('markdown source must be a string')
  if (options !== undefined && (typeof options !== 'object' || options === null)) throw new TypeError('markdown options must be an object')
  const { dialect = 'discord', oneLine } = options ?? {}
  if (oneLine !== undefined && typeof oneLine !== 'boolean') throw new TypeError('oneLine must be true or false')
  const extended = dialectOf(dialect)
  if (extended && oneLine) throw new RangeError('the one-line reading is of the discord dialect only')
  const lines = linesOf(src)
  if (!extended) return oneLine ? parseBlocks(lines, false, envOf(false, NO_LABELS)) : readSpoilers(lines, envOf(false, NO_LABELS))
  // A reference is a footnoteRef only when a note by its label is defined, and a definition may come after the reference,
  // so a document with notes is read a second time, told which labels there are. The notes it finds are the same.
  const first = envOf(true, NO_LABELS)
  const nodes = parseBlocks(lines, false, first)
  // Stryker disable next-line ConditionalExpression: a second pass over a document with no notes gives the same nodes; the check only saves the time
  if (first.notes.size === 0) return nodes
  return parseBlocks(lines, false, envOf(true, new Set(first.notes.keys())))
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

/**
 * → for each line from `i`, the index of the fence line that closes the code block opening there, or -1. A line after the
 * last fence line `ends` can close nothing, so no scan looks for one past it, and each scan stops at the close it finds.
 */
const fenceEnd = (lines, i, ends) => (i < ends && FENCE_OPEN.test(lines[i]) ? lines.indexOf('```', i + 1) : -1)

/** → for each line, whether a fence holds it, in the lines of a quote (no quote opens in them). */
function codeIn(lines) {
  const ends = lines.lastIndexOf('```')
  const code = []
  for (let i = 0; i < lines.length; ) {
    const close = fenceEnd(lines, i, ends)
    for (const end = Math.max(close, i); i <= end; i++) code.push(close !== -1)
  }
  return code
}

/** → the role of each line of the message: the fences and quotes parseBlocks would find, in the same order. */
function rolesOf(lines) {
  const ends = lines.lastIndexOf('```')
  const roles = []
  for (let i = 0; i < lines.length; ) {
    const close = fenceEnd(lines, i, ends)
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

// Marks that start, or start and end, a construct of some reading that can hold bars or run over a line break (see
// the comment at the top): code, escapes, spans, links, angle forms, addresses, and line breaks other than \n.
const UNSURE = /[`\\*_~[<\u2028\u2029\u0085\v\f]|:\/\//
// Marks that only end one: a link's `)`, an angle form's `>`, a reference link's `]`. They start with `[` or `<`.
const ENDS = /[)>\]]/
// A Discord mention, channel, role, emoji, timestamp or slash command (see the comment at the top).
const TOKEN = /<(?:@[!&]?\d{17,20}|#\d{17,20}|a?:[A-Za-z0-9_-]{1,32}:\d{17,20}|t:-?\d{1,17}(?::[tTdDfFR])?|\/[A-Za-z0-9_-]{1,32}(?: [A-Za-z0-9_-]{1,32})?:\d{17,20})>/g

/** Whether every reading pairs the line's bars within it (see the comment at the top). */
function certain(line, role) {
  if (!line.includes(SPOILER)) return true
  const at = line.indexOf(SPOILER)
  // A quote or a list item reads its lines again without their leading spaces, tabs and `>`: only a space past them counts.
  const space = line.indexOf(' ', line.search(/[^ \t>]/))
  // A token that ends by the first bar, or one after it with such a space before its `>` and no `_` in it, is read as a word.
  const read = line.replace(TOKEN, (token, from) => {
    const end = from + token.length
    return end <= at || (space !== -1 && space < end && !token.includes('_')) ? 'x' : token
  })
  if (role === CODE || UNSURE.test(read) || read.includes('|||') || ENDS.test(read.slice(read.indexOf(SPOILER)))) return false
  const pieces = read.split(SPOILER)
  return pieces.length % 2 === 1 && pieces.every((piece, k) => k % 2 === 0 || /\S/.test(piece))
}

/** → { u, last }: the first line that is not certain (-1 for none) and the last line with a `||` (-1 for none). */
function uncertainty(lines) {
  const roles = rolesOf(lines)
  return { roles, u: lines.findIndex((line, k) => !certain(line, roles[k])), last: lines.findLastIndex((line) => line.includes(SPOILER)) }
}

/** The message's blocks: the lines before the first one that is not certain as they were, then one spoiler to the last `||`. */
function readSpoilers(lines, env) {
  const { roles, u, last } = uncertainty(lines)
  if (u === -1 || u === last) return parseBlocks(lines, false, env)
  const at = lines[u].indexOf(SPOILER)
  const c = lines[last].lastIndexOf(SPOILER)
  const head = lines[u].slice(0, at)
  const rest = head.slice((OWN[roles[u]] ?? '').length)
  // Nothing but markers before the first bar: they are words at the start of the spoiler. Anything more stays before it.
  const bare = BARE.test(rest)
  const before = bare ? lines.slice(0, u) : [...lines.slice(0, u), head]
  const inner = [(bare ? rest : '') + lines[u].slice(at + 2), ...lines.slice(u + 1, last)]
  const closing = lines[last].slice(0, c)
  if (closing.slice((OWN[roles[last]] ?? '').length).trim() !== '') inner.push(closing)
  return [
    ...parseBlocks(before, false, env),
    { type: 'spoiler', children: parseBlocks(inner, false, env, CARRY[roles[u]]), lastBar: true },
    ...parseBlocks([lines[last].slice(c + 2), ...lines.slice(last + 1)], false, env, CARRY[roles[last]]),
  ]
}

/** What a quote shows in place of all a spoiler may hide (maskSpoilers), and what a preview shows for a spoiler. */
export const SPOILER_MASK = '▒▒▒'

/** → the text with SPOILER_MASK in place of all a spoiler may hide in it, under any reading (see the comment at the top). */
export function maskSpoilers(src) {
  if (typeof src !== 'string') throw new TypeError('markdown source must be a string')
  const lines = linesOf(src)
  const { u, last } = uncertainty(lines)
  // A certain line: each of its pairs, and what is between the two bars, is the mask.
  const pairs = (line) => line.split(SPOILER).map((piece, k) => (k % 2 === 0 ? piece : SPOILER_MASK)).join('')
  if (u === -1) return lines.map(pairs).join('\n')
  const from = lines[u].slice(0, lines[u].indexOf(SPOILER))
  const to = lines[last].slice(lines[last].lastIndexOf(SPOILER) + 2)
  return [...lines.slice(0, u).map(pairs), from + SPOILER_MASK + to, ...lines.slice(last + 1)].join('\n')
}

/**
 * Blocks from lines. `lead` says how the first line is read when it is the piece of a line a spoiler's bars cut (the
 * Discord dialect's spoiler over lines): 'text' as words only (never a fence, quote, heading or list), '> ' as such words
 * going on in a > quote, '>>> ' as such words in a >>> quote of all the lines. A quote the cut leaves empty is left out.
 */
function parseBlocks(lines, inQuote, env, lead) {
  const out = []
  // Set once no closing fence is left in `lines`, so that no later opener looks for one again (each look is a scan to the end).
  let fenceless = false
  let i = 0
  if (lead === '>>> ') {
    const children = parseBlocks(lines, true, env, 'text')
    return children.length ? [{ type: 'quote', children }] : out
  }
  if (lead === '> ') {
    for (i = 1; i < lines.length && quoted(lines[i]); ) i++
    const children = parseBlocks([lines[0], ...lines.slice(1, i).map((line) => line.slice(2))], true, env, 'text')
    if (children.length) out.push({ type: 'quote', children })
  } else if (lead === 'text') {
    if (lines[0].trim() !== '') out.push({ type: 'line', children: inline(lines[0], env, null) })
    i = 1
  }
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
    if (!inQuote && quoted(line)) {
      const inner = []
      while (i < lines.length && quoted(lines[i])) {
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
 * turned into line nodes: a line each, except where a spoiler of the extended dialect runs over lines.
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
 * A paragraph's lines → its line nodes. In the extended dialect each line is read with the lines after it in hand (see
 * inline), so a `||` that no `||` closes on its own line takes as many of the next lines as the spoiler needs to close,
 * into one line node.
 * A line with such a `||` and none after it in the paragraph is read as it would be alone, and a scan for a closer that
 * finds none means no later line has a `||` either, so a paragraph is scanned to its end once at most.
 */
function joinRun(run, env) {
  const lines = run.map((block) => block.src)
  const out = []
  for (let k = 0; k < lines.length; ) {
    const flow = { lines, at: k }
    // The Discord dialect reads each line alone: its spoiler over lines is readSpoilers' (see the comment at the top).
    out.push({ type: 'line', children: inline(lines[k], env, env.extended ? flow : null) })
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
// `flow` is null for a span's inner text, for text that is no line of a paragraph, and for every line of the Discord
// dialect: it never reaches past its line. For a line of a paragraph in the extended dialect it is { lines, at }, the paragraph's lines and the index of the one being read: a `||` with no
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
