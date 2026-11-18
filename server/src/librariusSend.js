/**
 * What a reply written on the site must pass before it is sent to Discord, and the name it is sent under. Server side only.
 *
 * Discord's AutoMod does not filter what a webhook posts (measured by the probe, in both forms of a reply), so nothing in
 * Discord stops a reply that the server's own rules would have blocked. automodMatcher() is that filter, which makes a "no
 * match" that should have been a match the one costly mistake of this file. Where Discord's documentation says nothing, the
 * answer is the one that refuses more: a message is refused that Discord might have let through, and never the other way.
 *
 * validateReply({ source, replyTo, mentions, uploads }, { form, automod, mentionCap, ownUploadIds, authorId, siteUrl })
 *   → { ok: true, clean } | { ok: false, status, error, rule?, match? }
 *   The first argument is what the writer sent, and may be anything: a body that is not a reply, or a field of the wrong kind,
 *   is refused like any other reply that cannot be sent, never thrown. The options are the caller's, and a wrong one is a
 *   TypeError (a wrong kind of value) or a RangeError (a wrong value), before the reply is looked at.
 *   - `source` is the extended markdown of the reply. `replyTo` is { authorId, url } of the message it answers, as the server
 *     worked it out, or null: the form checks it, so a wrong one throws. `mentions` lists the ids of the people picked through
 *     the member search. `uploads` lists the ids of the files of the reply, the one at place N being `upload:N` of the source.
 *   - `form`: 'v2' (the default) or 'plain'. `automod`: the function of automodMatcher(), with its `mentionCap`. `mentionCap`:
 *     the most mentions, 10 at most and 10 by default; the least of it and that of `automod` holds. `ownUploadIds`: a list or
 *     a Set of the ids of the files the writer may use. `authorId` and `siteUrl` are the writer's and the link of the "Open
 *     On Site" button, which the budget counts (the footer takes room); by default the longest they can be, so that a reply
 *     that passes never goes over once they are known.
 *   The checks run in this order, and the first to fail answers (the copy is the error):
 *   1. Nothing to send, 400: no text, or only whitespace, or only what shows nothing. "Write something first."
 *   2. Too long, 413: a source of more than MAX_SOURCE (16,000) UTF-16 units is refused before it is parsed, and so is one
 *      that Discord would need more than 3 messages for (the form's `overBudget`, not counted again here). "That's longer
 *      than Discord can carry in 3 messages."
 *   3. A link that does not start with http:// or https://, 400. That is a masked link `[text](address)`, or an angle link
 *      `<scheme:...>`, that is left as text: the parser makes a link only of an address that starts with a lower case
 *      `http://` or `https://`, so any other address is refused, and so is `HTTPS://`. `<t:...>`, `<id:...>` and `<a:...>` are
 *      what Discord writes in angle brackets, and are not links. Code is not looked at. "Links must start with http:// or
 *      https://."
 *   4. A picture that is not the writer's, 400: more files than 10, a file that is not in `ownUploadIds` (every one is
 *      looked at, shown or not), or an `upload:N` with no file at its place. "That picture isn't one of yours." (more than
 *      10: "A reply can hold 10 pictures at most.")
 *   5. Mentions, 400: a person mentioned who was not picked, a role mentioned (a role cannot be picked), or more people than
 *      the cap. People picked and not mentioned do not count. "Pick people to mention from the list (10 at most)." with the
 *      cap in place of 10 when it is lower.
 *   6. The server's AutoMod, 422: `error` is "Blocked by the server's AutoMod rule \"<rule name>\"." and `rule` the name, and
 *      `match` is { start, end } in `clean.source`, which is as long as the source that was sent, so it points into the text
 *      the writer sees.
 *   `clean` is { source, replyTo, mentions, uploads }, all copies: the source with every NUL and every lone half of a pair
 *   replaced by U+FFFD (Postgres cannot store them), one for one; `replyTo` as { authorId, url } or null; `mentions` the ids
 *   of the people mentioned, in the order they are first mentioned; `uploads` as it was.
 *
 * automodMatcher(rules, { memberRoleIds, channelIds, isAdmin, log }) → (text) => null | { rule, start, end }
 *   `rules` are the guild's AutoMod rules as Discord gives them. `memberRoleIds` are the roles of the member, `channelIds` the
 *   ids of the places the reply goes to (the forum, and its category and post if they are known), `isAdmin` that the member
 *   holds Administrator or Manage Server, for whom Discord applies no rule (so no rule is applied here). `log` (console.error)
 *   is given a line, once, without any text of a reply, when a regular expression is skipped. The function that comes back
 *   answers for one text: the first rule, in the order given, that blocks it, as its name and where in `text` (the text is
 *   a string and `start` < `end` ≤ its length). It also has `mentionCap`: the most mentions that the rules leave, 10 unless
 *   the rule against mention spam is lower.
 *   A rule applies unless it is switched off (`enabled: false`), or exempts a role of the member or a channel in `channelIds`.
 *   Whatever the rule does about a match (block, alert, time out) is not looked at: a reply a rule only alerts on is
 *   refused as well.
 *   - Keyword rules (type 1): each `keyword_filter` entry is read as Discord documents. All keywords are case insensitive. A
 *     `*` at its start or its end gives the mode: `cat*` a prefix (the word starts with it), `*cat` a suffix, `*cat*`
 *     anywhere, and `cat` a whole word (a phrase is one, and a run of whitespace in it matches any run of whitespace). The
 *     match is the keyword with the whole word that a `*` reaches into, so that `*cat*` in "location" is the 8 characters.
 *     The entries of `allow_list` are read the same way, and a match that lies inside a match of the allow list is let through.
 *     Where the documentation says nothing, the choice is the one that blocks:
 *     - a word is what is made of letters: any other character (a digit, an underscore, a punctuation or a symbol, an emoji)
 *       ends it, as does a letter of a script that is written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer,
 *       Myanmar);
 *     - the text is read twice and a match in either counts: with the characters that show as nothing (zero-width and format
 *       characters, controls) and the marks of Discord's markdown (`* _ ~ | \`` and a backslash) taken out, and with each of
 *       them taken for a space. So `ba*d*` and `ba\u200bd` are "bad", and `foo_bar` is the two words "foo bar" as well;
 *     - accents and other combining marks are left out, width, ligatures and compatibility forms are folded (NFKD), and so
 *       are upper and lower case, before the two are compared; a keyword is read the same way;
 *     - a `*` in the middle of a keyword stands for up to 60 characters that are not whitespace;
 *     - an allow list never lets a match go that it does not wholly cover, and an entry that is empty, or only stars, lets
 *       nothing go; a keyword of nothing, or only stars, matches nothing.
 *   - Mention spam (type 5) is a cap, not a match: min(10, `mention_total_limit` - 1), or 0 if the limit is not a whole number.
 *   - `regex_patterns` (none today) are tried as JavaScript regular expressions, in any case (flags `iu`, and `i` for the
 *     pattern that `u` does not take), with the text of a reply at most 10,000 characters and each run for at most 50 ms
 *     (about a second on Bun, whose timer is coarser); a pattern that cannot be compiled, a text over the cap, and a run that
 *     times out count as no match, which the log is told once. An empty match is no match. The allow list does not let a
 *     match of a pattern go. (Flagged for the day a rule has one: those three cases let a reply through that a pattern might
 *     have blocked.)
 *
 * cleanName(name) → the name a reply is sent under: at most 80 characters, at least 1. Only the first 400 UTF-16 units of the
 *   name are read (the names of Discord have at most 32). Controls and lone halves of a pair are taken out, then "discord" and "clyde" (which Discord refuses in the name of a webhook message) wherever they are, in any
 *   case and written any way that a reader would read them (as the text of a keyword is read, with the characters that show as
 *   nothing taken out), and again for what taking them out joins, then the name is trimmed and cut to 80 UTF-16 units, never
 *   in the middle of a pair. What is left of nothing is "Member", and so is what is no text.
 */
import vm from 'node:vm'
import { parse, walk } from './librariusMarkdown.js'
import { DEFAULT_FORM, limitFor, toDiscord } from './librariusForm.js'

export const MAX_SOURCE = 16_000
export const MENTION_CAP = 10
const MAX_UPLOADS = 10
const REGEX_BUDGET_MS = 50
const REGEX_MAX_INPUT = 10_000
// How many characters a `*` inside a keyword may stand for.
const MAX_GAP = 60
const NAME_MAX = 80
// How much of a name is read: far more than a name has (Discord's are at most 32), and what keeps the work for a name that is
// made to be slow, a pass for each word it hides, short.
const NAME_READ = 400
const FALLBACK_NAME = 'Member'
const KEYWORD = 1
const MENTION_SPAM = 5

// What a message may hold, at its longest: so that a reply that passes is not over once the real ones are known.
const WORST_ID = '9'.repeat(20)
const WORST_URL = `https://${'a'.repeat(192)}`

const COPY = {
  empty: 'Write something first.',
  budget: "That's longer than Discord can carry in 3 messages.",
  link: 'Links must start with http:// or https://.',
  upload: "That picture isn't one of yours.",
  uploads: 'A reply can hold 10 pictures at most.',
  mention: (cap) => `Pick people to mention from the list (${cap} at most).`,
  blocked: (name) => `Blocked by the server's AutoMod rule "${name}".`,
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
// Stryker disable next-line ArrayDeclaration: a stray element is never a keyword, a role, a channel or a rule that a reply can match, so every reader drops it
const listOf = (v) => (Array.isArray(v) ? v : [])

// Whitespace, the line ends included, but not the zero-width characters (which are format characters, and show nothing).
const SPACE = /[\u0009-\u000d\u0085\p{Zs}\p{Zl}\p{Zp}]/u
// What shows nothing, and what Discord's markdown takes out of a message when it shows it. Whitespace is looked for first.
const IGNORABLE = /[\p{Cf}\p{Cc}\p{Cs}*_~|`\\]/u
const MARK = /\p{M}/u
const LETTER = /^\p{L}$/u
// Scripts written without a space between words: a letter of one is no part of a word of another.
const UNSPACED = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]$/u

const DROPPED = 'dropped'
const SPACED = 'spaced'
const MODES = [DROPPED, SPACED]

/**
 * → { s, from, to }: the text as it is compared. Every character is decomposed (NFKD), put in one case, and left out if it
 * is a combining mark. Whitespace becomes one space for a run of it. What shows nothing (IGNORABLE) is left out in the
 * DROPPED reading and is whitespace in the SPACED one. `from[i]` and `to[i]` are where in `text` the character of `s[i]` is
 * (its first and its last place + 1), so that a match of `s` is a match of `text`.
 */
function fold(text, mode) {
  let s = ''
  const from = []
  const to = []
  const put = (c, start, end) => {
    s += c
    for (let k = 0; k < c.length; k++) {
      from.push(start)
      to.push(end)
    }
  }
  let start = 0
  for (const ch of text) {
    const end = start + ch.length
    for (const c of ch.normalize('NFKD').toUpperCase().toLowerCase()) {
      if (SPACE.test(c) || (mode === SPACED && IGNORABLE.test(c))) {
        if (!s.endsWith(' ')) put(' ', start, end)
      } else if (!IGNORABLE.test(c) && !MARK.test(c)) put(c, start, end)
    }
    start = end
  }
  return { s, from, to }
}

/** → the character that ends just before `i` in a text that is made of whole pairs, or '' (nothing that is not one letter is a letter, so what stands for no character need only be that). */
// Stryker disable next-line StringLiteral: no text but a single letter is a letter, so what is given for no character says the same whatever it is
const before = (s, i) => [...s.slice(Math.max(0, i - 2), i)].pop() ?? ''
/** → the character that starts at `i`, or ''. */
// Stryker disable next-line StringLiteral: as above
const after = (s, i) => [...s.slice(i, i + 2)][0] ?? ''
const isWord = (c) => LETTER.test(c) && !UNSPACED.test(c)

/** → { segments, startFree, endFree } for a keyword as Discord's filter is written, read in `mode`; null when it holds nothing. */
function keywordOf(raw, mode) {
  if (typeof raw !== 'string') return null
  const parts = raw
    .replace(/^\*+|\*+$/g, '')
    .split('*')
    .map((part) => fold(part, mode).s)
  parts[0] = parts[0].trimStart()
  parts[parts.length - 1] = parts[parts.length - 1].trimEnd()
  const segments = parts.filter((part) => part !== '')
  return segments.length === 0 ? null : { segments, startFree: raw.startsWith('*'), endFree: raw.endsWith('*') }
}

/**
 * → where the segments of a keyword are found one after the other from `pos`, as the end of the last, or -1. Each follows the
 * one before with at most MAX_GAP characters between them and no space among those. The first place of a segment is taken
 * where it is not the last, since an earlier end can only leave more room; the last is tried until its edge holds.
 */
function reach(s, pos, segments, k, needEdge) {
  if (k === segments.length) return needEdge && isWord(after(s, pos)) ? -1 : pos
  const segment = segments[k]
  const last = k === segments.length - 1
  for (let p = pos; p <= pos + MAX_GAP; p++) {
    if (s.startsWith(segment, p)) {
      const end = reach(s, p + segment.length, segments, k + 1, needEdge)
      if (end !== -1 || !last) return end
    }
    if (s[p] === ' ') break
  }
  return -1
}

/** → [start, end] of every place the keyword matches in the folded text, with the whole word that a `*` reaches into. */
function spansOf({ s }, keyword) {
  const { segments, startFree, endFree } = keyword
  const [head, ...rest] = segments
  const out = []
  for (let i = s.indexOf(head); i !== -1; i = s.indexOf(head, i + 1)) {
    if (!startFree && isWord(before(s, i))) continue
    const end = reach(s, i + head.length, rest, 0, !endFree)
    if (end === -1) continue
    // The word the keyword is in or at, where a * lets it reach: with no * at that end the edge held, and nothing is added.
    let a = i
    let b = end
    for (let c = before(s, a); isWord(c); c = before(s, a)) a -= c.length
    for (let c = after(s, b); isWord(c); c = after(s, b)) b += c.length
    out.push([a, b])
  }
  return out
}

/** → the spans of an allow list in a form that tells whether one span lies wholly inside another: sorted by start, with how far each reaches. */
function allowedIn(norm, allow) {
  const spans = []
  for (const keyword of allow) for (const span of spansOf(norm, keyword)) spans.push(span)
  spans.sort((x, y) => x[0] - y[0])
  const reach = []
  for (const [, end] of spans) reach.push(reach.length === 0 ? end : Math.max(end, reach[reach.length - 1]))
  return { spans, reach }
}

/** → whether [a, b) lies inside one span: of those that start at or before `a`, the furthest that any reaches (nothing is at least `b` when none starts so early). */
function covers({ spans, reach }, a, b) {
  let low = 0
  let high = spans.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (spans[mid][0] <= a) low = mid + 1
    else high = mid
  }
  return reach[low - 1] >= b
}

// The regular expressions run in a context of their own for each run, under the watchdog of the vm module, which stops a run
// that is still going after the time it is given. The context holds nothing but the pattern and the text of the run in hand.
const SCAN = new vm.Script(
  '(() => { let from = 0; for (;;) { re.lastIndex = from; const m = re.exec(text); if (m === null) return null; if (m[0] !== "") return [m.index, m.index + m[0].length]; from = m.index + 1 } })()',
)

/** → [start, end] of the first match of `re` (a global one) that is not empty, or null; throws when the run takes over the budget. */
function scan(re, text) {
  return SCAN.runInContext(vm.createContext({ re, text }), { timeout: REGEX_BUDGET_MS })
}

/** → the ids as a Set: a list of text, or none given. */
function idSet(value, what) {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new TypeError(`${what} must be a list of ids`)
  return new Set(value)
}

export function automodMatcher(rules, options = {}) {
  if (!Array.isArray(rules)) throw new TypeError('the rules must be a list')
  if (!isObject(options)) throw new TypeError('the options must be an object')
  const { memberRoleIds, channelIds, isAdmin = false, log = console.error } = options
  const roles = idSet(memberRoleIds, 'memberRoleIds')
  const channels = idSet(channelIds, 'channelIds')
  if (typeof isAdmin !== 'boolean') throw new TypeError('isAdmin must be true or false')
  if (typeof log !== 'function') throw new TypeError('log must be a function')

  // Once, and never with any text of a reply: a log that fails must not change what the reply is told. What the log is given
  // is not asserted (the answer is the same whatever it says), only that a log which throws changes nothing.
  // Stryker disable BlockStatement,ConditionalExpression,BooleanLiteral,StringLiteral: the log
  let told = false
  const skipped = (why) => {
    if (told) return
    told = true
    try {
      log(`librarius: an AutoMod regular expression was skipped (${why})`)
    } catch {
      // the log is broken; the answer is the same
    }
  }
  // Stryker restore BlockStatement,ConditionalExpression,BooleanLiteral,StringLiteral
  const compilePattern = (source) => {
    if (typeof source !== 'string') return null
    for (const flags of ['giu', 'gi']) {
      try {
        return new RegExp(source, flags)
      } catch {
        // not valid with this flag: the next
      }
    }
    // Stryker disable next-line StringLiteral: the log
    skipped('a pattern could not be compiled')
    return null
  }

  let mentionCap = MENTION_CAP
  const compiled = []
  const applying = rules.filter(
    (r) => !isAdmin && isObject(r) && r.enabled !== false && !listOf(r.exempt_roles).some((id) => roles.has(id)) && !listOf(r.exempt_channels).some((id) => channels.has(id)),
  )
  for (const rule of applying) {
    const meta = isObject(rule.trigger_metadata) ? rule.trigger_metadata : {}
    if (rule.trigger_type === MENTION_SPAM) {
      mentionCap = Math.min(mentionCap, Number.isInteger(meta.mention_total_limit) ? Math.max(0, meta.mention_total_limit - 1) : 0)
    } else if (rule.trigger_type === KEYWORD) {
      const read = (mode) => ({
        keywords: listOf(meta.keyword_filter).map((k) => keywordOf(k, mode)).filter((k) => k !== null),
        allow: listOf(meta.allow_list).map((k) => keywordOf(k, mode)).filter((k) => k !== null),
      })
      compiled.push({
        name: typeof rule.name === 'string' && rule.name !== '' ? rule.name : 'unnamed',
        [DROPPED]: read(DROPPED),
        [SPACED]: read(SPACED),
        // Stryker disable next-line ConditionalExpression,MethodExpression: a pattern that was not compiled (null) throws when it is run, which is caught as one that could not be run, so the answer is the same
        patterns: listOf(meta.regex_patterns).map(compilePattern).filter((re) => re !== null),
      })
    }
  }

  /** → the match of `scan`, or null when it ran over its time. */
  function timed(re, text) {
    try {
      return scan(re, text)
    } catch {
      // Stryker disable next-line StringLiteral: the log
      skipped('a pattern ran over its time')
      return null
    }
  }

  /** → { start, end } of the earliest match of one rule in `text`, or null. */
  function firstIn(rule, text, norm) {
    let best = null
    const take = (start, end) => {
      if (best === null || start < best.start) best = { start, end }
    }
    for (const mode of MODES) {
      const folded = norm(mode)
      let allow = null
      for (const keyword of rule[mode].keywords) {
        for (const [a, b] of spansOf(folded, keyword)) {
          allow ??= allowedIn(folded, rule[mode].allow)
          if (covers(allow, a, b)) continue
          take(folded.from[a], folded.to[b - 1])
          break
        }
      }
    }
    for (const re of rule.patterns) {
      if (text.length > REGEX_MAX_INPUT) {
        // Stryker disable next-line StringLiteral: the log
        skipped('the text is over the length for a pattern')
        break
      }
      const found = timed(re, text)
      if (found !== null) take(found[0], found[1])
    }
    return best
  }

  const matcher = (text) => {
    if (typeof text !== 'string') throw new TypeError('the text must be a string')
    const readings = {}
    const norm = (mode) => (readings[mode] ??= fold(text, mode))
    for (const rule of compiled) {
      const found = firstIn(rule, text, norm)
      if (found !== null) return { rule: rule.name, start: found.start, end: found.end }
    }
    return null
  }
  matcher.mentionCap = mentionCap
  return matcher
}

// The nodes that end what a link written in the text before them could be: the text of one is no part of the text of another.
const BARRIERS = new Set(['line', 'heading', 'subtext', 'blank', 'divider', 'codeblock', 'code', 'br', 'list', 'quote', 'table', 'footnotes'])
// What follows the `](` of a masked link, as an address (with at most one level of parentheses in it) between at most a pair of
// angle brackets, and the closing parenthesis. Runs of spaces are made one first, so that this is linear.
const LINK_SHAPED = /\]\( ?<?((?:[^\s()<>[\]]|\([^\s()<>[\]]*\))*)>? ?\)/g
const ANGLE_LINK = /<([a-z][a-z0-9+.-]*):[^\s<>]*>/gi
const HTTP_ADDRESS = /^https?:\/\//
// What Discord writes in angle brackets with a colon in it, and is no link: a timestamp, a slash command, an emoji, and the
// links the page itself keeps (http and https, which the parser has taken out where they work).
const ANGLE_OK = new Set(['http', 'https', 't', 'id', 'a'])
const CANON_ID = /^[1-9]\d{16,19}$/
// What shows nothing at all: a reply of only this is no reply.
const NOTHING = /^[\s\p{Cf}\p{Cc}]*$/u

/** → what the checks of a reply need of its AST: the files it shows, who it mentions, and its text with code and the line ends left as breaks. */
function inspect(blocks) {
  const refs = new Set()
  const users = new Set()
  let role = false
  // Stryker disable next-line StringLiteral: a text in front of the first line holds neither the start nor the end of a link
  let literal = ''
  walk(blocks, (node) => {
    if (BARRIERS.has(node.type)) literal += '\n'
    if (node.type === 'text') literal += node.value
    else if (node.type === 'url') literal += node.href
    else if (node.type === 'image') refs.add(node.ref)
    // Stryker disable next-line ConditionalExpression: no other node has a kind, so the kind says the same without the type
    if (node.type === 'mention') {
      if (node.kind === 'user') users.add(node.id)
      else if (node.kind === 'role') role = true
    }
  })
  return { refs, users, role, literal }
}

/** → whether the text has a link that is not to http or https. */
function hasBadLink(literal) {
  const text = literal.replace(/[ \t]+/g, ' ')
  for (const m of text.matchAll(LINK_SHAPED)) if (!HTTP_ADDRESS.test(m[1])) return true
  for (const m of text.matchAll(ANGLE_LINK)) if (!ANGLE_OK.has(m[1])) return true
  return false
}

const refused = (status, error, more = {}) => ({ ok: false, status, error, ...more })

export function validateReply(input, options) {
  if (!isObject(options)) throw new TypeError('the options must be an object')
  const { form, automod, mentionCap = MENTION_CAP, ownUploadIds, authorId = WORST_ID, siteUrl = WORST_URL } = options
  limitFor(form === undefined ? DEFAULT_FORM : form)
  if (typeof automod !== 'function') throw new TypeError('automod must be a function')
  if (!Number.isInteger(mentionCap) || mentionCap < 0 || mentionCap > MENTION_CAP) throw new RangeError(`mentionCap must be a whole number from 0 to ${MENTION_CAP}`)
  if (ownUploadIds !== undefined && !Array.isArray(ownUploadIds) && !(ownUploadIds instanceof Set)) throw new TypeError('ownUploadIds must be a list or a set')
  const own = new Set(ownUploadIds)
  const cap = Math.min(mentionCap, Number.isInteger(automod.mentionCap) ? automod.mentionCap : MENTION_CAP)

  const body = isObject(input) ? input : {}
  const { source } = body
  if (typeof source !== 'string') return refused(400, COPY.empty)
  if (source.length > MAX_SOURCE) return refused(413, COPY.budget)
  if (NOTHING.test(source)) return refused(400, COPY.empty)

  const text = source.replaceAll('\u0000', '�').toWellFormed()
  const seen = inspect(parse(text, { dialect: 'extended' }))
  const replyTo = body.replyTo ?? null
  const images = [...seen.refs].map((ref) => ({ ref, name: `image-${ref}.png` }))
  if (toDiscord(text, { form, authorId, replyTo, siteUrl, images }).overBudget) return refused(413, COPY.budget)

  if (hasBadLink(seen.literal)) return refused(400, COPY.link)

  const uploads = body.uploads ?? []
  if (!Array.isArray(uploads)) return refused(400, COPY.upload)
  if (uploads.length > MAX_UPLOADS) return refused(400, COPY.uploads)
  if (!uploads.every((id) => typeof id === 'string' && own.has(id))) return refused(400, COPY.upload)
  if ([...seen.refs].some((ref) => ref > uploads.length)) return refused(400, COPY.upload)

  const picked = body.mentions ?? null
  if ((picked !== null && !Array.isArray(picked)) || seen.role || seen.users.size > cap) return refused(400, COPY.mention(cap))
  const allowed = new Set(picked)
  for (const id of seen.users) if (!CANON_ID.test(id) || !allowed.has(id)) return refused(400, COPY.mention(cap))

  const hit = automod(text)
  if (hit !== null) return refused(422, COPY.blocked(hit.rule), { rule: hit.rule, match: { start: hit.start, end: hit.end } })

  return {
    ok: true,
    clean: {
      source: text,
      replyTo: replyTo === null ? null : { authorId: replyTo.authorId, url: replyTo.url },
      mentions: [...seen.users],
      uploads: [...uploads],
    },
  }
}

const BANNED = /discord|clyde/g

export function cleanName(name) {
  if (typeof name !== 'string') return FALLBACK_NAME
  let s = name.slice(0, NAME_READ).replace(/[\p{Cc}\p{Cs}]/gu, '')
  for (;;) {
    const folded = fold(s, DROPPED)
    const hits = [...folded.s.matchAll(BANNED)]
    if (hits.length === 0) break
    let kept = ''
    let at = 0
    for (const hit of hits) {
      kept += s.slice(at, folded.from[hit.index])
      at = folded.to[hit.index + hit[0].length - 1]
    }
    s = kept + s.slice(at)
  }
  let cut = ''
  for (const ch of s.trim()) {
    if (cut.length + ch.length > NAME_MAX) break
    cut += ch
  }
  cut = cut.trim()
  return cut === '' ? FALLBACK_NAME : cut
}
