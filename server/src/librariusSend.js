/**
 * What a reply written on the site must pass before it is sent to Discord, and the name it is sent under. Server side only.
 *
 * Discord's AutoMod does not filter what a webhook posts (measured by the probe, in both forms of a reply), so nothing in
 * Discord stops a reply that the server's own rules would have blocked. automodMatcher() is that filter, which makes a "no
 * match" that should have been a match the one costly mistake of this file. Where Discord's documentation says nothing, the
 * answer is the one that refuses more: a message is refused that Discord might have let through, and never the other way.
 *
 * validateReply({ source, replyTo, mentions, uploads }, { form, automod, mentionCap, ownUploadIds, authorId, siteUrl })
 *   → Promise of { ok: true, clean } | { ok: false, status, error, rule?, match? }. It is async because the regular expressions of the
 *   rules run in a thread of their own (see scanInWorker), which it waits for without holding up the server.
 *   The first argument is what the writer sent, and may be anything: a body that is not a reply, or a field of the wrong kind,
 *   is refused like any other reply that cannot be sent, never thrown. The options are the caller's, and a wrong one is a
 *   TypeError (a wrong kind of value) or a RangeError (a wrong value), before the reply is looked at (a rejection of the promise).
 *   - `source` is the extended markdown of the reply. `replyTo` is { authorId, url } of the message it answers, as the server
 *     worked it out, or null: the form checks it, so a wrong one throws. `mentions` lists the ids of the people picked through
 *     the member search. `uploads` lists the ids of the files of the reply, the one at place N being `upload:N` of the source.
 *   - `form`: 'v2' (the default) or 'plain'. `automod`: the function of automodMatcher(), with its `mentionCap` and its `regex` (a
 *     plain function has no `regex`, and no pattern is run for it). `mentionCap`:
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
 *   6. The server's AutoMod, 422, over the source and then over what is sent: `error` is "Blocked by the server's AutoMod rule
 *      \"<rule name>\"." and `rule` the name, and `match` is { start, end } in `clean.source`, which is as long as the source
 *      that was sent, so it points into the text the writer sees. What is sent is not the text that was written (a picture
 *      written inside a line is sent as a file and leaves nothing in the line, so `zo![](upload:1)rp` is "zorp" in the message,
 *      and in the cell of a table or a note the same), and Discord's own AutoMod does not filter what a webhook posts, so the
 *      rules are run over each message of the reply too: over the contents of the Text Displays of a V2 message (each on its
 *      own, as they are shown apart), or the text of a plain one, without the lines that the site writes there (the line of the
 *      message it answers, the mark `**2/3**` of a part, the footer) and the label of the button. A hit there that the source did
 *      not have is the same refusal with `match: null`: the text it is in is not the writer's, so the source has no place for it
 *      (the AST has no positions to say which picture it was). Then the regular expressions, over the source and the messages
 *      together, in the one budget of REGEX_BUDGET_MS. A pattern that matches is the same refusal, `match` the place in the source
 *      when it was found in the source and null when in a message. A reply that could not be checked, because a pattern was not
 *      done in the budget or the source is over 10,000 characters and a pattern has to run, is 422 with the error "This reply
 *      couldn't be checked against the server's rules. Try a shorter one." and no `rule`.
 *   `clean` is { source, replyTo, mentions, uploads }, all copies: the source with every NUL and every lone half of a pair
 *   replaced by U+FFFD (Postgres cannot store them), one for one; `replyTo` as { authorId, url } or null; `mentions` the ids
 *   of the people mentioned, in the order they are first mentioned; `uploads` as it was.
 *
 * automodMatcher(rules, { memberRoleIds, channelIds, isAdmin, log }) → (text) => null | { rule, start, end }, with `.regex` and `.mentionCap`
 *   `rules` are the guild's AutoMod rules as Discord gives them. `memberRoleIds` are the roles of the member, `channelIds` the
 *   ids of the places the reply goes to (the forum, and its category and post if they are known), `isAdmin` that the member
 *   holds Administrator or Manage Server, for whom Discord applies no rule (so no rule is applied here). `log` (console.error)
 *   is given a line, once for each rule and never with a pattern or a text, when a regular expression of the rule is skipped. The
 *   function that comes back answers for one text, by the keywords of the rules only: the first rule, in the order given, that
 *   blocks it, as its name and where in `text` (the text is a string and `start` < `end` ≤ its length). Its `regex(texts)` answers
 *   for the regular expressions, async: for a list of texts (the source first), null when no pattern matches one, { rule, text,
 *   start, end } for the first that does (`text` the place of the text in the list, the first text that any pattern matches, and
 *   in it the first rule), or { unchecked: true } when it could not be told: a text is over 10,000 characters, or the patterns were
 *   not done within REGEX_BUDGET_MS (250 ms) for all the texts together, or an answer came in later than that, even one that said
 *   "no match". The first such answer ends the work: no other pattern, rule or text is tried. Its `mentionCap` is the most
 *   mentions that the rules leave, 10 unless the rule against mention spam is lower.
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
 *       are upper and lower case (lower, upper and lower again, so that U+1E9E and `ß` and `ss` are one), before the two are
 *       compared; a keyword is read the same way;
 *     - a `*` in the middle of a keyword stands for up to 60 characters that are not whitespace;
 *     - space round a keyword is not part of it (the documentation does not say that it is trimmed, and a suffix finds more than
 *       the whole word does): ` *cat` is `*cat`, so it finds "bobcat";
 *     - a keyword with something in it that folds to nothing (`||`, `~~`, a fence of backticks, a zero-width character), which
 *       would match nothing, is looked for as it is written, anywhere in the text it is given (the text is not
 *       folded for it, and the wildcards at its ends and an allow list make no difference); a `*` inside it is a plain character;
 *     - an allow list never lets a match go that it does not wholly cover, and an entry that is empty, or only stars, lets
 *       nothing go; a keyword of nothing, or only stars, matches nothing.
 *   - Mention spam (type 5) is a cap, not a match: min(10, `mention_total_limit` - 1), or 0 if the limit is not a whole number.
 *   - `regex_patterns` are Rust's, as Discord says, and run as JavaScript's in Unicode mode and in any case, in ONE worker thread for
 *     the whole process (scanInWorker, and the file librariusRegexWorker.js, which only calls scanPatterns), so that a text made
 *     to be slow never holds up the server. A pattern is first read by translatePattern(): a leading `(?i)`, `\A`, `\z`, `\pL` and
 *     `.` are written as JavaScript has them, and a pattern that cannot be read the same way (`\b`, `\w`, `\d`, a class of POSIX, ...)
 *     is skipped, with no other reading to fall back on, and the rule is named once in the log; automodUnchecked(rules) lists those
 *     rules so that the people who manage the server can be told what the site cannot check. An empty match is no match. The allow
 *     list does not let a match of a pattern go. When the budget is over the worker is ended (and not waited for) and the next
 *     reply gets a new one, since a regular expression that runs long cannot be stopped from inside; the reply that ran over is
 *     refused, as is one with a text over the cap: failing open would let through what a rule may have blocked.
 *
 * automodUnchecked(rules) → the names of the rules that are on, each once and in the order of the rules, with a regular expression that
 *   translatePattern() gives up on, which the site cannot check (for the people who manage the server to be told of).
 * translatePattern(source) → the JavaScript source for a pattern of Rust's, or null; scanPatterns(job) and scanInWorker(job) are the
 *   job of the worker thread, run in it and handed to it. shownBy(parts, { reply, footer }) → the texts that the messages of a reply
 *   show of the reply itself (see validateReply). All four are exported for the worker file and for the tests.
 *
 * cleanName(name) → the name a reply is sent under: at most 80 characters, at least 1. Only the first 400 UTF-16 units of the
 *   name are read (the names of Discord have at most 32). Controls, format characters (zero-width ones, direction marks, the joiner
 *   of an emoji sequence) and lone halves of a pair are taken out, so a name that only shows nothing is "Member" (Discord refuses it), then "discord" and "clyde" (which Discord refuses in the name of a webhook message) wherever they are, in any
 *   case and written any way that a reader would read them (as the text of a keyword is read, with the characters that show as
 *   nothing taken out), and again for what taking them out joins, then the name is trimmed and cut to 80 UTF-16 units, never
 *   in the middle of a pair. What is left of nothing is "Member", and so is what is no text.
 */
import { Worker } from 'node:worker_threads'
import { parse, walk } from './librariusMarkdown.js'
import { DEFAULT_FORM, limitFor, toDiscord } from './librariusForm.js'

export const MAX_SOURCE = 16_000
export const MENTION_CAP = 10
const MAX_UPLOADS = 10
// How long all the regular expressions of one reply may take together, from the moment the work is handed over to the worker.
const REGEX_BUDGET_MS = 250
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
  unchecked: "This reply couldn't be checked against the server's rules. Try a shorter one.",
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
    from.push(...Array(c.length).fill(start))
    to.push(...Array(c.length).fill(end))
  }
  let start = 0
  for (const ch of text) {
    const end = start + ch.length
    // Lower, upper, lower: U+1E9E (capital sharp s) has the lower case `ß`, which only the upper case `SS` turns into `ss`.
    for (const c of ch.normalize('NFKD').toLowerCase().toUpperCase().toLowerCase()) {
      if (SPACE.test(c) || (mode === SPACED && IGNORABLE.test(c))) {
        if (!s.endsWith(' ')) put(' ', start, end)
      } else if (!IGNORABLE.test(c) && !MARK.test(c)) put(c, start, end)
    }
    start = end
  }
  return { s, from, to }
}

const isWord = (c) => LETTER.test(c) && !UNSPACED.test(c)

/** → whether the character at place `i` of a text is a letter of a word, by the `start` of its words (a place outside the text is not). */
const inWord = (start, i) => i >= 0 && i < start.length && start[i] !== -1

/**
 * → { start, end } for a folded text `s` (made of whole pairs): at each place, where the word that holds the character there
 * starts and where it ends, `start` being -1 where no word is. Two passes, so that a keyword that reaches into a word of any
 * length finds its edges at once instead of walking the word again for every place it meets it.
 */
function wordsOf(s) {
  const start = new Int32Array(s.length).fill(-1)
  const end = new Int32Array(s.length)
  // Stryker disable next-line EqualityOperator: at the end of the text there is no character, so one place further reads nothing
  for (let i = 0; i < s.length; ) {
    const size = s.codePointAt(i) > 0xffff ? 2 : 1
    if (isWord(s.slice(i, i + size))) start.fill(inWord(start, i - 1) ? start[i - 1] : i, i, i + size)
    i += size
  }
  // Stryker disable next-line ArithmeticOperator,EqualityOperator,ConditionalExpression: the end of a place that is no word, or that is past the text, or of the first place of the text, is never asked for (a match is at least one character long, so it ends after the first place)
  for (let i = s.length - 1; i >= 0; i--) if (inWord(start, i)) end[i] = inWord(start, i + 1) ? end[i + 1] : i + 1
  return { start, end }
}

/** → the words of a folded text, worked out the first time they are asked for. */
const wordsIn = (folded) => (folded.words ??= wordsOf(folded.s))
/**
 * → { segments, startFree, endFree } for a keyword as Discord's filter is written, read in `mode`; null when it holds nothing.
 * Space round the keyword is not part of it: ` *cat` is the suffix `*cat` (Discord's documentation does not say whether a keyword
 * is trimmed, and a suffix finds every place the whole word does, and more).
 */
function keywordOf(rawKeyword, mode) {
  if (typeof rawKeyword !== 'string') return null
  const raw = rawKeyword.trim()
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
function reach(s, start, pos, segments, k, needEdge) {
  if (k === segments.length) return needEdge && inWord(start, pos) ? -1 : pos
  const segment = segments[k]
  const last = k === segments.length - 1
  for (let p = pos; p <= pos + MAX_GAP; p++) {
    if (s.startsWith(segment, p)) {
      const end = reach(s, start, p + segment.length, segments, k + 1, needEdge)
      if (end !== -1 || !last) return end
    }
    if (s[p] === ' ') break
  }
  return -1
}

/**
 * → [start, end] of each place the keyword matches in the folded text, one at a time and in order, with the whole word that a `*`
 * reaches into. A place costs what its edges cost, which is a look at the text beside it, never the length of the word.
 */
function* spansOf(folded, keyword) {
  const { s } = folded
  const { start, end } = wordsIn(folded)
  const { segments, startFree, endFree } = keyword
  const [head, ...rest] = segments
  for (let i = s.indexOf(head); i !== -1; i = s.indexOf(head, i + 1)) {
    const inside = inWord(start, i - 1)
    if (!startFree && inside) continue
    const stop = reach(s, start, i + head.length, rest, 0, !endFree)
    if (stop === -1) continue
    // The word the keyword is in or at, where a * lets it reach: with no * at that end the edge held, and nothing is added.
    yield [inside ? start[i - 1] : i, inWord(start, stop) ? end[stop] : stop]
  }
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

/** → [a, b] of the first match of the keyword that the allow list does not cover, or null. `allowOf()` is the allow list, read when the first match is found and not before, and a match found is not looked past. */
function firstUncovered(folded, keyword, allowOf) {
  for (const span of spansOf(folded, keyword)) if (!covers(allowOf(), span[0], span[1])) return span
  return null
}

// The regular expressions of the rules are Rust's, and run as JavaScript's, in Unicode mode and in any case (`giu`). What cannot be
// read the same in the two is not run: see translatePattern().
const PATTERN_FLAGS = 'giu'
// The escapes that a regular expression of Rust reads as Unicode, and JavaScript's reads as ASCII (word characters, digits, the
// edge of a word): a pattern with one would match less here than in Discord, so it is not run.
const ASCII_ONLY = new Set(['b', 'B', 'w', 'W', 'd', 'D'])
// Rust's `\s` also holds U+0085 (NEL), which JavaScript's does not.
const WHITE = String.raw`\s\u0085`

/**
 * → a regular expression of Rust's, as the JavaScript source that matches the same texts (to be run as `giu`), or null when there
 * is none that is sure to: not a string, `\b` `\B` `\w` `\W` `\d` `\D` (Unicode in Rust, ASCII in JavaScript), a class of POSIX
 * (`[[:alpha:]]`), a class inside a class or an intersection, a difference or a symmetric difference in one, `\S` in one, a
 * class that starts with `]`, and whatever else does not compile in Unicode mode (`(?P<name>...)`, a flag in the middle, `\p{Greek}`,
 * `\x{41}`, an escape of a letter that stands for nothing). Translated: a leading `(?i)` is taken off (every pattern is run in any
 * case), `\A` is `^`, `\z` is `$`, `\pL` is `\p{L}` (and `\PL`), `.` is any character but a line feed (JavaScript's would also leave
 * out a carriage return and the line and paragraph separators) and `\s` takes in U+0085.
 */
export function translatePattern(source) {
  if (typeof source !== 'string') return null
  let out = ''
  let inClass = false
  let i = source.startsWith('(?i)') ? 4 : 0
  while (i < source.length) {
    const c = source[i]
    const d = source[i + 1] ?? ''
    if (c === '\\') {
      if (ASCII_ONLY.has(d)) return null
      if (d === 'A' && !inClass) out += '^'
      else if (d === 'z' && !inClass) out += '$'
      else if (d === 's') out += inClass ? WHITE : `[${WHITE}]`
      // In a class this is a class in a class, which does not compile in Unicode mode (the `]` of the inner one leaves the outer one's alone).
      else if (d === 'S') out += `[^${WHITE}]`
      else if ((d === 'p' || d === 'P') && source[i + 2] !== '{') {
        // One letter after \p is the name of a property, as \p{L}; none makes `\p{}`, which does not compile.
        // Stryker disable next-line StringLiteral: whatever is put for no letter, `\p{...}` of it does not compile
        out += `\\${d}{${source[i + 2] ?? ''}}`
        i += 1
      } else out += c + d
      i += 2
    } else if (inClass) {
      if (c === '[' || (c === d && (c === '&' || c === '-' || c === '~'))) return null
      if (c === ']') inClass = false
      out += c
      i += 1
    } else if (c === '[') {
      inClass = true
      out += c
      i += 1
      if (source[i] === '^') {
        out += '^'
        i += 1
      }
      // A `]` that comes first is a character of the class in Rust's, and the end of an empty class in JavaScript's.
      if (source[i] === ']') return null
    } else {
      out += c === '.' ? '[^\\n]' : c
      i += 1
    }
  }
  try {
    new RegExp(out, PATTERN_FLAGS)
  } catch {
    return null
  }
  return out
}

/** → [start, end] of the first match of `re` (a global one) that is not empty, or null. */
function firstFilled(re, text) {
  // Stryker disable next-line EqualityOperator: no match that is not empty starts at the end of the text
  for (let from = 0; from < text.length; ) {
    re.lastIndex = from
    const found = re.exec(text)
    if (found === null) return null
    if (found[0] !== '') return [found.index, found.index + found[0].length]
    // Past the empty match, and past the place asked from when the match came back from before it, in the middle of a pair.
    from = Math.max(from, found.index) + 1
  }
  return null
}

/**
 * → { text, rule, start, end } of the first match of a job, or null: the first text (a place in `texts`) that a pattern matches,
 * and in it the first rule (a place in `rules`) that one of its patterns matches, at the earliest start of them. A job is
 * { rules: [[source, ...], ...], texts: [text, ...] }, the sources as translatePattern() gives them. This is what the worker runs
 * (so it is here, with the rest of the checks, and the worker file only calls it); a source that does not compile is an exception.
 */
export function scanPatterns({ rules, texts }) {
  const regexes = rules.map((sources) => sources.map((source) => new RegExp(source, PATTERN_FLAGS)))
  for (let t = 0; t < texts.length; t++) {
    for (let r = 0; r < regexes.length; r++) {
      let best = null
      for (const re of regexes[r]) {
        const found = firstFilled(re, texts[t])
        if (found !== null && (best === null || found[0] < best[0])) best = found
      }
      if (best !== null) return { text: t, rule: r, start: best[0], end: best[1] }
    }
  }
  return null
}

// The worker that runs the patterns of the rules: one for the whole process, in a thread of its own so that the work of a text that
// is made to be slow never holds up the server. The worker is started when it is first wanted, and a job that is not answered in
// its budget, or that crashes it, ends it and the next job starts another. A job waits for the one before it, so that what it is
// given is its own.
const WORKER_FILE = new URL('./librariusRegexWorker.js', import.meta.url)
let worker = null
let turn = Promise.resolve()

function startWorker() {
  const started = new Worker(WORKER_FILE)
  // It never keeps the process alive by itself.
  started.unref()
  // A worker that fails does not answer, and the budget ends the wait for it; its error is not an error of the server, which is
  // what an error with no listener would be.
  // Stryker disable next-line StringLiteral: without a listener for it, the next error of the worker is thrown and ends the process, which the runner counts as a crash and not as a kill
  started.on('error', () => {})
  return started
}

/** → what the thread of `job` answered ({ found }), or null when it did not within the budget (as a worker that failed does not). Asks `current`. */
function ask(current, job) {
  return new Promise((resolve) => {
    const asked = performance.now()
    const done = (answer) => {
      clearTimeout(timer)
      current.off('message', answered)
      resolve(answer)
    }
    // An answer that came late is as good as none, even when it says there was no match: the time is what was refused.
    const answered = (answer) => done(performance.now() - asked >= REGEX_BUDGET_MS ? null : answer)
    const timer = setTimeout(() => done(null), REGEX_BUDGET_MS)
    current.on('message', answered)
    current.postMessage(job)
  })
}

/**
 * → { found } (the answer of scanPatterns() for `job`) or null: the worker did not answer in REGEX_BUDGET_MS (a worker that crashed does not). It is
 * then ended, and never waited for, and the next job is run by a new one. Jobs run one at a time.
 */
export function scanInWorker(job) {
  const next = turn.then(async () => {
    const current = (worker ??= startWorker())
    const answer = await ask(current, job)
    if (answer === null) {
      worker = null
      // Not waited for (on Bun it comes back when the regular expression it was in is over, which can be a second), and it does not fail.
      void current.terminate()
    }
    return answer
  })
  // A job that could not be handed over rejects its caller, and must not stop the jobs after it.
  turn = next.catch(() => {})
  return next
}

/** → the ids as a Set: a list of text, or none given. */
function idSet(value, what) {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new TypeError(`${what} must be a list of ids`)
  return new Set(value)
}

const nameOf = (rule) => (typeof rule.name === 'string' && rule.name !== '' ? rule.name : 'unnamed')
const metaOf = (rule) => (isObject(rule.trigger_metadata) ? rule.trigger_metadata : {})
const UNCHECKED = () => ({ unchecked: true })

/** → the pattern of a keyword that holds no word, as one that is looked for as it is written, or null. Nothing that folds to nothing has a case, so there is none to ignore. */
function literalOf(rawKeyword) {
  if (typeof rawKeyword !== 'string' || keywordOf(rawKeyword, DROPPED) !== null) return null
  const literal = rawKeyword.trim().replace(/^\*+|\*+$/g, '').trim()
  return literal === '' ? null : new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u')
}

// The rules whose regular expressions have been told of already, by name: once for the life of the process, however many times a
// matcher is made.
const told = new Set()

/**
 * → the names of the rules that have a pattern that this file cannot run (translatePattern() gives null for it), each once, in the
 * order of the rules: for a rule that is on, so that the people who manage the server can be told which of its rules the site
 * cannot check for them.
 */
export function automodUnchecked(rules) {
  if (!Array.isArray(rules)) throw new TypeError('the rules must be a list')
  const names = new Set()
  for (const rule of rules) {
    if (isObject(rule) && rule.enabled !== false && rule.trigger_type === KEYWORD && listOf(metaOf(rule).regex_patterns).some((source) => translatePattern(source) === null)) names.add(nameOf(rule))
  }
  return [...names]
}

export function automodMatcher(rules, options = {}) {
  if (!Array.isArray(rules)) throw new TypeError('the rules must be a list')
  if (!isObject(options)) throw new TypeError('the options must be an object')
  const { memberRoleIds, channelIds, isAdmin = false, log = console.error } = options
  const roles = idSet(memberRoleIds, 'memberRoleIds')
  const channels = idSet(channelIds, 'channelIds')
  if (typeof isAdmin !== 'boolean') throw new TypeError('isAdmin must be true or false')
  if (typeof log !== 'function') throw new TypeError('log must be a function')

  // The name of a rule, once, and never with any text of a reply or of a pattern: a log that fails must not change what the reply
  // is told. What the log is given is not asserted (the answer is the same whatever it says), only that a log which throws
  // changes nothing.
  // Stryker disable BlockStatement,ConditionalExpression,BooleanLiteral,StringLiteral: the log
  const skipped = (why, name) => {
    if (told.has(name)) return
    told.add(name)
    try {
      log(`librarius: ${why} (AutoMod rule "${name}")`)
    } catch {
      // the log is broken; the answer is the same
    }
  }
  // Stryker restore BlockStatement,ConditionalExpression,BooleanLiteral,StringLiteral

  let mentionCap = MENTION_CAP
  const compiled = []
  const applying = rules.filter(
    (r) => !isAdmin && isObject(r) && r.enabled !== false && !listOf(r.exempt_roles).some((id) => roles.has(id)) && !listOf(r.exempt_channels).some((id) => channels.has(id)),
  )
  for (const rule of applying) {
    const meta = metaOf(rule)
    if (rule.trigger_type === MENTION_SPAM) {
      mentionCap = Math.min(mentionCap, Number.isInteger(meta.mention_total_limit) ? Math.max(0, meta.mention_total_limit - 1) : 0)
    } else if (rule.trigger_type === KEYWORD) {
      const read = (mode) => ({
        keywords: listOf(meta.keyword_filter).map((k) => keywordOf(k, mode)).filter((k) => k !== null),
        allow: listOf(meta.allow_list).map((k) => keywordOf(k, mode)).filter((k) => k !== null),
      })
      const patterns = listOf(meta.regex_patterns).map(translatePattern)
      // Stryker disable next-line ConditionalExpression,StringLiteral: the log
      if (patterns.includes(null)) skipped('a regular expression was skipped, which cannot be read the same here', nameOf(rule))
      compiled.push({
        name: nameOf(rule),
        [DROPPED]: read(DROPPED),
        [SPACED]: read(SPACED),
        literals: listOf(meta.keyword_filter).map(literalOf).filter((re) => re !== null),
        patterns: patterns.filter((source) => source !== null),
      })
    }
  }

  /** → { start, end } of the earliest match of the keywords of one rule in `text`, or null. */
  function firstIn(rule, text, norm) {
    let best = null
    const take = (start, end) => {
      if (best === null || start < best.start) best = { start, end }
    }
    for (const mode of MODES) {
      const folded = norm(mode)
      let allow = null
      for (const keyword of rule[mode].keywords) {
        const span = firstUncovered(folded, keyword, () => (allow ??= allowedIn(folded, rule[mode].allow)))
        if (span !== null) take(folded.from[span[0]], folded.to[span[1] - 1])
      }
    }
    for (const re of rule.literals) {
      const found = re.exec(text)
      if (found !== null) take(found.index, found.index + found[0].length)
    }
    return best
  }

  // Of keywords only: the patterns are run by matcher.regex(), which waits for a worker.
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

  const withPatterns = compiled.filter((rule) => rule.patterns.length > 0)
  /**
   * → { rule, text, start, end } of the first match of a pattern in the texts (`text` is the place of the one it is in), or null,
   * or { unchecked: true } when they could not be checked: one is over the 10,000 characters that a pattern is run over, or the
   * patterns did not finish in the budget of the whole reply.
   */
  matcher.regex = async (texts) => {
    if (!Array.isArray(texts) || !texts.every((t) => typeof t === 'string')) throw new TypeError('the texts must be a list of strings')
    if (withPatterns.length === 0) return null
    if (texts.some((t) => t.length > REGEX_MAX_INPUT)) return UNCHECKED()
    const answer = await scanInWorker({ rules: withPatterns.map((rule) => rule.patterns), texts })
    if (answer === null) return UNCHECKED()
    const { found } = answer
    return found === null ? null : { rule: withPatterns[found.rule].name, text: found.text, start: found.start, end: found.end }
  }
  // The thread starts while the keywords are being looked at, so that its start is not in the budget of the first answer.
  // Stryker disable next-line ConditionalExpression,BlockStatement,EqualityOperator,AssignmentOperator: only how soon the first answer comes
  if (withPatterns.length > 0) worker ??= startWorker()
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

// The kind of a component that is a Text Display, in the messages of the form.
const TEXT_DISPLAY = 10

/** → the contents of the Text Displays of a V2 message, in order, wherever they are in it. */
function displaysOf(components, found = []) {
  for (const component of components) {
    if (component.type === TEXT_DISPLAY) found.push(component.content)
    else if (Array.isArray(component.components)) displaysOf(component.components, found)
  }
  return found
}

const withoutFirstLine = (text, line) => (text === line ? '' : text.startsWith(`${line}\n`) ? text.slice(line.length + 1) : text)
const withoutLastLine = (text, line) => (text === line ? '' : text.endsWith(`\n${line}`) ? text.slice(0, -line.length - 1) : text)
// The mark of a part, `**2/3**`, which is followed by a space or a line end (or by nothing, in a part that starts with a picture).
const withoutMark = (text, mark) => (text.startsWith(mark) && (text.length === mark.length || ' \n'.includes(text[mark.length])) ? text.slice(mark.length + 1) : text)

/**
 * → the texts that the parts of a reply show of the reply itself, as the form built them: the Text Displays of a V2 part, or the
 * text of a plain one, each without what the site puts there (the line of the message it answers, the mark of the part, the footer,
 * which are the same whatever was written, and which the rules were never written for). A picture written inside a line is not in
 * these texts, nor is the text of one that has nothing to show, so what stood on its two sides is next to each other here.
 */
export function shownBy(parts, fixed) {
  const texts = []
  parts.forEach((part, k) => {
    const shown = part.components === null ? [part.text] : displaysOf(part.components)
    if (k === 0 && fixed.reply !== null) shown[0] = withoutFirstLine(shown[0], fixed.reply)
    if (parts.length > 1) shown[0] = withoutMark(shown[0], `**${k + 1}/${parts.length}**`)
    if (k === parts.length - 1) shown[shown.length - 1] = withoutLastLine(shown[shown.length - 1], fixed.footer)
    for (const text of shown) if (text !== '') texts.push(text)
  })
  return texts
}

export async function validateReply(input, options) {
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
  const common = { form, authorId, replyTo, siteUrl }
  const sent = toDiscord(text, { ...common, images })
  if (sent.overBudget) return refused(413, COPY.budget)

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

  const blocked = (found, at) => refused(422, COPY.blocked(found.rule), { rule: found.rule, match: at })
  const hit = automod(text)
  if (hit !== null) return blocked(hit, { start: hit.start, end: hit.end })

  // What is sent is not the text that was written: a picture written inside a line is sent as a file, and nothing of it is left in
  // the line, so `zo![](upload:1)rp` is "zorp" there. Whatever the rules find in the parts and not in the source is refused as well.
  // The match is in text the writer never sees, so it has no place in the source: it is null.
  // Stryker disable next-line ObjectLiteral,StringLiteral: a stand-in reply of one letter, of which only the lines the site adds are taken
  const stand = toDiscord('x', { ...common, images: [] }).parts[0].text.split('\n')
  const fixed = { reply: replyTo === null ? null : stand[0], footer: stand[stand.length - 1] }
  const shown = shownBy(sent.parts, fixed)
  for (const part of shown) {
    const found = automod(part)
    if (found !== null) return blocked(found, null)
  }

  if (typeof automod.regex === 'function') {
    const found = await automod.regex([text, ...shown])
    if (found !== null && found.unchecked === true) return refused(422, COPY.unchecked)
    if (found !== null) return blocked(found, found.text === 0 ? { start: found.start, end: found.end } : null)
  }

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
  let s = name.slice(0, NAME_READ).replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
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
