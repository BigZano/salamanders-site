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
 *   rules run in a child process of their own (see createRegexRunner), which it waits for without holding up the server.
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
 *     On Site" button, and have no default: the budget counts them (the footer takes room), and the text that is checked is the one
 *     that is sent, which is cut the same way only for the same two (a TypeError when either is not a string; the form says whether it
 *     is a Discord id and an https link). The caller gives the ones the send will use.
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
 *      keywords are run over each message of the reply too: over the contents of the Text Displays of a V2 message (each on its
 *      own, and joined by a line end as the fallback shows them, so that the two forms refuse the same replies), or the text of a
 *      plain one, without the lines that the site writes there (the line of the
 *      message it answers, the mark `**2/3**` of a part, the footer) and the label of the button. A hit there that the source did
 *      not have is the same refusal with `match: null`: the text it is in is not the writer's, so the source has no place for it
 *      (the AST has no positions to say which picture it was). The source and each of those texts are also read with each masked
 *      link `[text](address)` put by its text (unmasked()), when that is not the same text: `[zo](https://e.com)rp` shows "zorp", and
 *      Discord's own reading of it, with the brackets, would not call it one. Those hits have `match: null` too. Then the regular
 *      expressions, over the texts that are sent only (they are at most 4,000 characters each, where the source is up to 16,000, and
 *      the time of a pattern with several `.*` grows with the 4th power of its text), each as it is sent and, when that is not the same
 *      text, as the member typed it (typed(): its links let out of the angle brackets that the form writes them in, `](<url>)` being
 *      `](url)` and `<url>` being `url`, its marks out of the escapes, `z\*rp` being `z*rp`, and without the zero-width spaces that it puts
 *      between marks), for a rule against `z[o*]rp` or the shape of a link was written for that; in the one budget of REGEX_BUDGET_MS. A
 *      pattern that matches is the same refusal, with `match: null`. A reply that could not be checked is 422 with the error "This reply
 *      couldn't be checked against the server's rules. Try a shorter one." and no `rule`: a pattern was not done in the budget (or the
 *      child it runs in did not answer, or was too busy to be asked), or a text folds to more than it may, which is to more than 4 times
 *      its length (1,000 at least), or the source and the parts of the reply together add more than 64,000
 *      characters by being folded (the other readings, which go over the same characters again, are held to the 4 times only): folding
 *      a text of characters that decompose to 18 each (U+FDFA) would hold up the server for most of a second.
 *   `clean` is { source, replyTo, mentions, uploads }, all copies: the source with every NUL and every lone half of a pair
 *   replaced by U+FFFD (Postgres cannot store them), one for one; `replyTo` as { authorId, url } or null; `mentions` the ids
 *   of the people mentioned, in the order they are first mentioned; `uploads` as it was.
 *
 * automodMatcher(rules, { memberRoleIds, channelIds, isAdmin, log }) → (text, spend) => null | { rule, start, end }, with `.regex` and `.mentionCap`
 *   `rules` are the guild's AutoMod rules as Discord gives them. `memberRoleIds` are the roles of the member, `channelIds` the
 *   ids of the places the reply goes to (the forum, and its category and post if they are known), `isAdmin` that the member
 *   holds Administrator or Manage Server, for whom Discord applies no rule (so no rule is applied here). `log` (console.error)
 *   is given a line, once for each rule and never with a pattern or a text, when a regular expression of the rule is skipped. The
 *   function that comes back answers for one text, by the keywords of the rules only: the first rule, in the order given, that
 *   blocks it, as its name and where in `text` (the text is a string and `start` < `end` ≤ its length). It throws Unfoldable for a text
 *   that folds to more than 4 times its length (1,000 at least) or to more than `spend.left` characters more than it is, where `spend`
 *   is { left } shared by the texts of one reply (64,000 for a call that is not given one), which it takes from; a rule with no keyword
 *   to look for does not fold the text. The keywords of a rule are looked for in one pass over the text, by a tree of how each starts
 *   (earliestIn), where each keyword of a rule of 1,000 was one pass of its own. Its `regex(texts)` answers
 *   for the regular expressions, async: for a list of texts, null when no pattern matches one, { rule, text,
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
 *     - a `*` in the middle of a keyword stands for up to 60 characters that are not whitespace, and every way that the pieces between
 *       the stars can follow one another counts (of those that start at one place, the one whose pieces come earliest is the match);
 *     - space round a keyword is not part of it (the documentation does not say that it is trimmed, and a suffix finds more than
 *       the whole word does): ` *cat` is `*cat`, so it finds "bobcat";
 *     - a keyword with something in it that folds to nothing (`||`, `~~`, a fence of backticks, a zero-width character), which
 *       would match nothing, is looked for as it is written, anywhere in the text it is given (the text is not
 *       folded for it, and the wildcards at its ends and an allow list make no difference); a `*` inside it is a plain character;
 *     - an allow list never lets a match go that it does not wholly cover, and an entry that is empty, or only stars, lets
 *       nothing go; a keyword of nothing, or only stars, matches nothing.
 *   - Mention spam (type 5) is a cap, not a match: min(10, `mention_total_limit` - 1), or 0 if the limit is not a whole number.
 *   - `regex_patterns` are Rust's, as Discord says, and run as JavaScript's in Unicode mode and in any case, in ONE child process for
 *     the whole server (createRegexRunner, and the file librariusRegexWorker.js, which only calls answerJob), so that a text made
 *     to be slow never holds up the server. A pattern is first read by translatePattern(): a leading `(?i)`, `\A`, `\z`, `\pL`, `.`,
 *     `\s` and `\S` are written as JavaScript has them, and a pattern that cannot be read the same way (`\b`, `\w`, `\d`, a class of
 *     POSIX, a group of flags with an `s`, ...) is skipped, with no other reading to fall back on, and the rule is named once in the
 *     log; automodUnchecked(rules) lists those rules so that the people who manage the server can be told what the site cannot check.
 *     An empty match is no match. The allow list does not let a match of a pattern go. When the budget is over the child is KILLED
 *     (SIGKILL, which stops a regular expression that is running, on Node and on Bun, where a worker thread that is terminated runs it
 *     to its end) and the next reply gets a new one; the reply that ran over is refused, as is one with a text over the cap: failing
 *     open would let through what a rule may have blocked. The child is killed when the server exits too, but a server that is itself
 *     killed with SIGKILL cannot do that: in the container the child ends with it, and outside one (a server run by hand) a child that
 *     is in the middle of a job runs it to its end, which for a pattern with several `.*` can be minutes of a core.
 *
 * automodUnchecked(rules) → the names of the rules that are on, each once and in the order of the rules, with a regular expression that
 *   translatePattern() gives up on, which the site cannot check (for the people who manage the server to be told of).
 * translatePattern(source) → the JavaScript source for a pattern of Rust's, or null; scanPatterns(job) is the job of the child
 *   process, run by answerJob(job) (for the worker file) and handed to it by scanInWorker(job), which createRegexRunner(spawnChild)
 *   makes for the child that spawnRegexWorker() starts. shownBy(parts, { reply, footer }) → the texts that the messages of a reply
 *   show of the reply itself (see validateReply); unmasked(text) → the text with its masked links put by their texts; typed(text) →
 *   the text as the member typed it, with what the form wrote for its links and its marks undone; Unfoldable is what the matcher throws
 *   for a text that folds to more than it may. All of them are exported for the worker file and for the tests.
 *
 * cleanName(name) → the name a reply is sent under: at most 80 characters, at least 1. Only the first 400 UTF-16 units of the
 *   name are read (the names of Discord have at most 32). Controls, format characters (zero-width ones, direction marks, the joiner
 *   of an emoji sequence) and lone halves of a pair are taken out, so a name that only shows nothing is "Member" (Discord refuses it), then "discord" and "clyde" (which Discord refuses in the name of a webhook message) wherever they are, in any
 *   case and written any way that a reader would read them (as the text of a keyword is read, with the characters that show as
 *   nothing taken out), and again for what taking them out joins, then the name is trimmed and cut to 80 UTF-16 units, never
 *   in the middle of a pair. What is left of nothing is "Member", and so is what is no text.
 */
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, walk } from './librariusMarkdown.js'
import { DEFAULT_FORM, limitFor, toDiscord } from './librariusForm.js'

export const MAX_SOURCE = 16_000
export const MENTION_CAP = 10
const MAX_UPLOADS = 10
// How long all the regular expressions of one reply may take together, from the moment the work is handed to a child process that is ready.
const REGEX_BUDGET_MS = 250
// How long a new child process has to say that it is ready, which the budget of a job does not count; and how many jobs wait for the one that runs.
const REGEX_READY_MS = 2_000
const REGEX_MAX_WAITING = 8
const REGEX_MAX_INPUT = 10_000
// How far folding may grow a text: to FOLD_RATIO times its length (and to FOLD_FLOOR when it is short), and by FOLD_TOTAL characters in all
// the texts of one reply. Decomposing a character gives up to 18 (U+FDFA), so that a text made of them is 18 times as long to fold.
const FOLD_RATIO = 4
const FOLD_FLOOR = 1_000
const FOLD_TOTAL = 64_000
// How many characters a `*` inside a keyword may stand for.
const MAX_GAP = 60
const NAME_MAX = 80
// How much of a name is read: far more than a name has (Discord's are at most 32), and what keeps the work for a name that is
// made to be slow, a pass for each word it hides, short.
const NAME_READ = 400
const FALLBACK_NAME = 'Member'
const KEYWORD = 1
const MENTION_SPAM = 5

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
// What shows nothing, and what Discord's markdown takes out of a message when it shows it. Whitespace is looked for first. The default
// ignorables of Unicode are what a renderer is told to show as nothing, and take in the fillers of Hangul (U+115F, U+1160, U+3164 and
// U+FFA0) and the characters that are not assigned yet; the blank of Braille (U+2800) shows nothing and is not one of them.
const IGNORABLE = /[\p{Cf}\p{Cc}\p{Cs}\p{Default_Ignorable_Code_Point}\u{2800}*_~|`\\]/u
const MARK = /\p{M}/u
const LETTER = /^\p{L}$/u
// Scripts written without a space between words: a letter of one is no part of a word of another.
const UNSPACED = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]$/u

const DROPPED = 'dropped'
const SPACED = 'spaced'
const MODES = [DROPPED, SPACED]

// Decomposed (NFKD), then lower, upper, lower: U+1E9E (capital sharp s) has the lower case `ß`, which only the upper case `SS` turns into `ss`.
const decomposed = (text) => text.normalize('NFKD').toLowerCase().toUpperCase().toLowerCase()

/**
 * → { s, from, to }: the text as it is compared. Every character is decomposed (NFKD), put in one case, and left out if it
 * is a combining mark. Whitespace becomes one space for a run of it. What shows nothing (IGNORABLE) is left out in the
 * DROPPED reading and is whitespace in the SPACED one. `from[i]` and `to[i]` are where in `text` the character of `s[i]` is
 * (its first and its last place + 1), so that a match of `s` is a match of `text`.
 */
function fold(text, mode) {
  let s = ''
  // Whether `s` ends in a space, kept apart: asking the string itself flattens it, again for every character of a text made of spaces.
  let spaced = false
  const from = []
  const to = []
  const put = (c, start, end) => {
    s += c
    spaced = c === ' '
    from.push(start)
    to.push(end)
    // A character of two units has the place of its first for its second.
    if (c.length > 1) {
      from.push(start)
      to.push(end)
    }
  }
  let start = 0
  for (const ch of text) {
    const end = start + ch.length
    // Stryker disable next-line ConditionalExpression,EqualityOperator: two of the four variants answer the same, only later: `false` (always the long way) and `<=` (U+0080 is its own decomposition and its own lower case). The other two, `true` and `>=`, skip the decomposition of what is not ASCII and are NOT the same: with this disable lifted, six tests fail for each (a CAFÉ for cafe, a full-width zorp, STRAẞE), checked by hand. A disable cannot name one variant, so it holds all four
    const read = ch.charCodeAt(0) < 0x80 ? ch.toLowerCase() : decomposed(ch)
    for (const c of read) {
      // What shows nothing is a space in the SPACED reading, but a mark that shows nothing (a joiner of graphemes, a variation selector) is
      // left out in both, as every combining mark is: it is part of the character before it, and not a place between two words.
      if (SPACE.test(c) || (mode === SPACED && IGNORABLE.test(c) && !MARK.test(c))) {
        if (!spaced) put(' ', start, end)
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

/** What the matcher throws for a text that folds to more than it may (see foldBoth): validateReply says that it could not be checked. */
export class Unfoldable extends RangeError {
  constructor() {
    super('the text folds to more than it may')
  }
}

/**
 * → { dropped, spaced }, the two readings of `text` (see fold), or throws Unfoldable when folding would make the text more than FOLD_RATIO
 * times as long (FOLD_FLOOR at least), or add more than what is left in `spend.left`, which is what it takes from. The size is that of the
 * decomposed text, worked out by the runtime in one go and a fair measure of the work: it counts the marks that the folding then drops, which
 * are no growth of any script and cost nothing here. A text that is refused is never walked, so what it costs is the same whatever it is.
 */
function foldBoth(text, spend) {
  const size = decomposed(text).length
  // What it adds, and not less than nothing: a character that decomposes to fewer units than it is (a mathematical letter is two units) takes nothing from the allowance, and gives nothing back.
  const added = Math.max(0, size - text.length)
  if (size > Math.max(FOLD_RATIO * text.length, FOLD_FLOOR) || added > spend.left) throw new Unfoldable()
  spend.left -= added
  return { [DROPPED]: fold(text, DROPPED), [SPACED]: fold(text, SPACED) }
}
/**
 * → { head, rest, tails, startFree, endFree, wide } for a keyword as Discord's filter is written, read in `mode`: `head` its first segment
 * (what is between two `*`), `rest` the others, `tails` what each of those names in chainsOf(), and `wide` whether there are none; null when
 * it holds nothing.
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
  if (segments.length === 0) return null
  const [head, ...rest] = segments
  // A keyword of one piece: the skipping that eachSpan() and earliestIn() do after a match is safe for it, and for no other (see nextPlace).
  const wide = rest.length === 0
  const endFree = raw.endsWith('*')
  // What the set of the places of each later piece depends on (see chainsOf): the pieces from it to the last, and the end. No piece holds a `*`.
  const tails = rest.map((_, k) => `${endFree ? '*' : ''}${rest.slice(k).join('*')}`)
  return { head, rest, tails, startFree: raw.startsWith('*'), endFree, wide }
}

/** → for each place of a folded text, the first place at or after it that holds a space (the length of the text where none does). */
function spacesOf(s) {
  const next = new Int32Array(s.length + 1).fill(s.length)
  for (let p = s.length - 1; p >= 0; p--) next[p] = s[p] === ' ' ? p : next[p + 1]
  return next
}

/**
 * → the last place that a later piece of a keyword may start at when the piece before it ends at `a`: MAX_GAP characters on, and no further
 * than the first space, which a `*` does not stand for (a piece may start with the space itself, as `a* b` does).
 */
const gapEnd = (folded, a) => Math.min(a + MAX_GAP, (folded.spaces ??= spacesOf(folded.s))[a])

/** → an empty set of places of a text of `n` places, a bit for each, with room for the two places after its end too (which are in no set). */
const noPlaces = (n) => new Uint32Array(((n + 1) >>> 5) + 1)

/** → the first place of the set from `a` to `b`, both included, or -1 (`a` is at most one place after the end of the text): 32 places a look. */
function firstOf(set, a, b) {
  const last = b >>> 5
  let w = a >>> 5
  // The places of its first word that are before `a` are left out.
  let bits = set[w] & (-1 << (a & 31))
  while (bits === 0) {
    if (++w > last) return -1
    bits = set[w]
  }
  const p = (w << 5) + 31 - Math.clz32(bits & -bits)
  return p <= b ? p : -1
}

/** → the places of the folded text that hold `piece`, in order and overlapping where they do; worked out once for each piece in `memo`. */
function placesOf(folded, piece, memo) {
  let found = memo.places.get(piece)
  if (found === undefined) {
    found = []
    for (let p = folded.s.indexOf(piece); p !== -1; p = folded.s.indexOf(piece, p + 1)) found.push(p)
    memo.places.set(piece, found)
  }
  return found
}

/**
 * → for each later piece of a keyword (the pieces after its first), the set of the places of the folded text that hold it and from which all the
 * pieces after it can follow: the last piece where its edge holds (with no `*` at the end of the keyword, it must end a word), and any other where
 * the set of the next piece has a place within its reach (gapEnd). Worked out from the last piece to the first, so that a place of the first
 * piece is told whether the rest of the keyword can follow it, and where, by a look in a set for each piece, whatever the length of the word it
 * is in and however many times the pieces are found in it. A set is kept in `memo` for what it depends on (`tails`), so that the keywords of a
 * list that end with the same pieces (`*n*gg*r*` and `*n*g*gg*r*`) share it, and the sets of a keyword for the keyword. The sets are bits: the
 * size of the text over 8 in bytes, and only while one rule is looked for in one text.
 */
function chainsOf(folded, keyword, memo) {
  let sets = memo.keywords.get(keyword)
  if (sets === undefined) {
    const { start } = wordsIn(folded)
    const { rest, tails } = keyword
    sets = []
    for (let k = rest.length - 1; k >= 0; k--) {
      let set = memo.tails.get(tails[k])
      if (set === undefined) {
        const after = sets[0]
        set = noPlaces(folded.s.length)
        for (const p of placesOf(folded, rest[k], memo)) {
          const a = p + rest[k].length
          const kept = after === undefined ? keyword.endFree || !inWord(start, a) : firstOf(after, a, gapEnd(folded, a)) !== -1
          if (kept) set[p >>> 5] |= 1 << (p & 31)
        }
        memo.tails.set(tails[k], set)
      }
      sets.unshift(set)
    }
    memo.keywords.set(keyword, sets)
  }
  return sets
}

/**
 * → where the later pieces of a keyword end when they follow one another from `pos`, where its first piece ends, or -1 when they cannot. Each
 * follows the one before with at most MAX_GAP characters between them and no space among those, and the last ends a word when the keyword has
 * no `*` at its end. Where they can follow in more than one way, the way whose pieces come earliest is the one taken: the first place of each
 * piece from which the rest can still follow (chainsOf). So a place of a middle piece that leads nowhere (the `b` of `ab` in `abxb…c` for
 * `a*b*c`, where the `c` is more than MAX_GAP from it) is no reason to miss the way through a later one, which is what the site's model of
 * an inner `*` says is a match; and of the ways that start at one place, the match is the one that ends first.
 */
function reach(folded, keyword, pos, memo) {
  const { rest } = keyword
  if (rest.length === 0) return !keyword.endFree && inWord(wordsIn(folded).start, pos) ? -1 : pos
  const sets = chainsOf(folded, keyword, memo)
  let a = pos
  for (let k = 0; k < rest.length; k++) {
    const p = firstOf(sets[k], a, gapEnd(folded, a))
    // Past the first piece this always holds: every place in a set has a place of the next set within its reach.
    if (p === -1) return -1
    a = p + rest[k].length
  }
  return a
}

/**
 * → the first place after `i` at which a keyword that has no match at `i` could have one: the next place for a keyword of one piece, and for
 * one of several, the first place whose reach (MAX_GAP characters past its first piece) takes in the next place of the set of its second piece
 * (see chainsOf), or the end of the text when there is none. No place before that has a match: its reach ends before that place, and no place
 * of the second piece before it can be followed by the rest. A long word that holds the first piece at every place and the rest of the keyword
 * nowhere (`*n*gger*` over a word of one letter) is then looked at once, and not at every place, for each keyword of that shape.
 */
function retryAfter(folded, keyword, i, memo) {
  if (keyword.rest.length === 0) return i + 1
  const next = firstOf(chainsOf(folded, keyword, memo)[0], i + 1 + keyword.head.length, folded.s.length)
  return next === -1 ? folded.s.length : Math.max(i + 1, next - keyword.head.length - MAX_GAP)
}

/**
 * → [start, end] of the match of the keyword that starts at place `i` of the folded text (the keyword's first piece is there), or null:
 * with the whole word that a `*` reaches into. A place costs what its edges cost, which is a look at the text beside it, never the length
 * of the word.
 */
function spanAt(folded, keyword, i, memo) {
  const { start, end } = wordsIn(folded)
  const inside = inWord(start, i - 1)
  if (!keyword.startFree && inside) return null
  const stop = reach(folded, keyword, i + keyword.head.length, memo)
  if (stop === -1) return null
  // The word the keyword is in or at, where a * lets it reach: with no * at that end the edge held, and nothing is added.
  return [inside ? start[i - 1] : i, inWord(start, stop) ? end[stop] : stop]
}

/**
 * → the first place after `i` that a keyword whose match at `i` is `span` is looked for at again. A keyword of one piece ends where its
 * match does, or inside the word that the match reaches the end of; a match that starts at a later place and ends by the end of that
 * word ends there, and starts at or after where this one does, so it lies inside this one and adds nothing to an allow list nor to what
 * a rule finds. That is every place up to `span[1] - head.length`, which are not looked at: a word of a single letter that `*a*` is found
 * in at every place is one match, where looking at each place would compare the keyword with the text there again, which for 100 keywords
 * or allow entries of up to 100 letters over a word of 11,000 is 55 million comparisons. It holds for a keyword of one piece whatever its
 * ends (with no `*` at the end the match ends at the word's end and there is nothing to skip), and for no keyword of several pieces: the
 * later start of one of those can end further on than the first (`*a*b*c` in `abac-bc`: the first `a` ends at 4, the second at 7).
 */
function nextPlace(keyword, i, span) {
  // The last place that a match of the keyword could start at and end where this one does, or before.
  const latest = span[1] - keyword.head.length
  return keyword.wide ? latest + 1 : i + 1
}

/** Gives `visit(start, end)` each place the keyword matches in the folded text, one at a time and in order (see nextPlace and retryAfter). */
function eachSpan(folded, keyword, visit, memo) {
  const { s } = folded
  let next = 0
  for (let i = s.indexOf(keyword.head); i !== -1; i = s.indexOf(keyword.head, next)) {
    const span = spanAt(folded, keyword, i, memo)
    if (span === null) {
      next = retryAfter(folded, keyword, i, memo)
      continue
    }
    next = nextPlace(keyword, i, span)
    visit(span[0], span[1])
  }
}

/** → what the places of the pieces and the sets of chainsOf() are kept in while one rule is looked for in one text, and no longer. */
const memoOf = () => ({ places: new Map(), tails: new Map(), keywords: new Map() })

/**
 * → for each place of the folded text, how far the spans of an allow list reach that start at or before it (0 for none), so that whether a
 * span lies wholly inside one of them is one look. Each span is put at its start, which keeps the furthest, and the reach is then carried
 * on from place to place: no list of the spans, no sort.
 */
function allowedIn(norm, allow) {
  const reach = new Int32Array(norm.s.length + 1)
  const memo = memoOf()
  for (const keyword of allow) {
    eachSpan(
      norm,
      keyword,
      (start, end) => {
        reach[start] = Math.max(reach[start], end)
      },
      memo,
    )
  }
  // Stryker disable next-line EqualityOperator: a place past the end of the typed array is never written
  for (let i = 1; i < reach.length; i++) reach[i] = Math.max(reach[i], reach[i - 1])
  return reach
}

/** → whether [a, b) lies inside one span: of those that start at or before `a`, the furthest that any reaches (nothing is at least `b` when none starts so early). */
const covers = (reach, a, b) => reach[a] >= b

// How many keywords a node of the tree of first pieces holds as they are, and compares with the text one by one, before it sorts them by
// their next unit (see indexed).
const GROUP = 8

/**
 * → the keywords and a tree of their first pieces, which earliestIn() walks from each place of a text, so that the text is read once for all the
 * keywords of a rule, and not once for each. The root is a map from the first unit of a first piece to the node of the keywords that start with
 * it. A node is { path, ends, few, next } for the keywords whose first pieces start with the units on the way to it: the unit it is reached by
 * and then its `path`, which is all that they have in common after it (often nothing); `ends` the places (in the order of the keywords) of
 * those whose first piece is those units and no more, and of the others either `few`, when there are GROUP of them at most, whose first pieces
 * are compared with the text, or `next`, a map from the unit after those to the node of the keywords that go on with it. A place of the text
 * then costs a look at each node down the way that the text goes, and GROUP comparisons at most at the end of it, and not one for each keyword
 * that starts as the text does there: a list of 1,000 addresses that start with `di`, or of words of Hangul that start with the same syllable,
 * costs at a place that holds those units about what a list of a few does, and 200 keywords that start with the same 60 letters one node. A
 * node is made only for a group of more than GROUP, so the tree is small, about a node for every GROUP keywords, where a node for every unit of
 * every keyword was 100 MB for 6 rules of 1,000, made again for each reply.
 */
function indexed(keywords) {
  // → the map from the unit at `depth` of the first pieces of the keywords of `list` (each is longer than that) to the node of those that have it.
  const childrenOf = (list, depth) => {
    const groups = new Map()
    for (const j of list) {
      const unit = keywords[j].head.charCodeAt(depth)
      if (!groups.has(unit)) groups.set(unit, [])
      groups.get(unit).push(j)
    }
    return new Map([...groups].map(([unit, group]) => [unit, nodeOf(group, depth + 1)]))
  }
  // → the node of the keywords of `list`, whose first pieces are the same up to `depth` and at least that long.
  const nodeOf = (list, depth) => {
    const heads = list.map((j) => keywords[j].head)
    let to = depth
    while (heads.every((head) => to < head.length && head.charCodeAt(to) === heads[0].charCodeAt(to))) to++
    const node = { path: heads[0].slice(depth, to), ends: [], few: [], next: null }
    const longer = []
    for (const j of list) (keywords[j].head.length === to ? node.ends : longer).push(j)
    if (longer.length <= GROUP) node.few = longer
    else node.next = childrenOf(longer, to)
    return node
  }
  return { keywords, root: childrenOf(keywords.map((_, j) => j), 0) }
}

/**
 * → { j, a, b } for the keyword (its place `j`) and its span that start earliest in the folded text, among the spans of the keywords that
 * the allow list does not hold, or null: the first of the keywords when two start together, and of the spans of one keyword, the one found
 * first. That is the first span of each keyword that the allow list does not hold, compared by where they start, as the keywords were one by
 * one: a span starts at its place or at the start of the word that its place is in, which is no earlier at a later place. It is one pass over
 * the text for all the keywords: from each place the tree of their first pieces is walked as far as the text goes with it, and only the keywords
 * whose whole first piece is there are tried, at a place that their last try does not skip (see nextPlace and retryAfter). `allowOf()` is the
 * allow list, made when the first match is found and not before. Every place of the text is looked at, a text with a match as much as one
 * without: the work is that of a text the length of the reply, whatever is found.
 */
function earliestIn(folded, { keywords, root }, allowOf) {
  const { s, from } = folded
  const memo = memoOf()
  // For each keyword, the first place that it is compared with the text at again (see nextPlace and retryAfter).
  const skip = new Int32Array(keywords.length)
  let best = null
  const consider = (j, i) => {
    const span = spanAt(folded, keywords[j], i, memo)
    if (span === null) {
      skip[j] = retryAfter(folded, keywords[j], i, memo)
      return
    }
    skip[j] = nextPlace(keywords[j], i, span)
    if (covers(allowOf(), span[0], span[1])) return
    // No span found later starts earlier: one is only taken for one that starts at the same place, of a keyword written before. The spans of
    // one place all start together, whatever the order their keywords are tried in, and of the spans of one keyword the first is kept. (Where
    // they start is compared in the text that was given: two places of the folded text can be one character there.)
    if (best === null || (from[span[0]] === from[best.a] && j < best.j)) best = { j, a: span[0], b: span[1] }
    // So a keyword that has a span the allow list does not hold has nothing more to say, and is not tried again: a keyword of several pieces,
    // which no match lets skip a place (see nextPlace), would otherwise be tried at every place of a word that holds it everywhere.
    skip[j] = s.length
  }
  for (let i = 0; i !== s.length; i++) {
    // The text from `i` on leads down the tree, a unit and the path of a node at a time, as far as it holds them; past its end there is no unit
    // (NaN), and no node.
    for (let d = i, next = root; next !== null; ) {
      const node = next.get(s.charCodeAt(d))
      if (node === undefined || (node.path !== '' && !s.startsWith(node.path, d + 1))) break
      d += 1 + node.path.length
      const { ends, few } = node
      for (let k = 0; k !== ends.length; k++) if (i >= skip[ends[k]]) consider(ends[k], i)
      // Each of the few goes on past the node: its unit there is looked at first, and the whole of it only when that is the text's.
      for (let k = 0; k !== few.length; k++) {
        const j = few[k]
        if (i >= skip[j] && keywords[j].head.charCodeAt(d - i) === s.charCodeAt(d) && s.startsWith(keywords[j].head, i)) consider(j, i)
      }
      next = node.next
    }
  }
  return best
}

// The regular expressions of the rules are Rust's, and run as JavaScript's, in Unicode mode and in any case (`giu`). What cannot be
// read the same in the two is not run: see translatePattern().
const PATTERN_FLAGS = 'giu'
// The escapes that a regular expression of Rust reads as Unicode, and JavaScript's reads as ASCII (word characters, digits, the
// edge of a word): a pattern with one would match less here than in Discord, so it is not run.
const ASCII_ONLY = new Set(['b', 'B', 'w', 'W', 'd', 'D'])
// What Rust's `\s` is: the White_Space of Unicode, written out. JavaScript's `\s` holds U+FEFF, which is not white space, and lacks U+0085
// (NEL), so it is not used, and `\S` and `[^\s]` then match what Rust's do (a zero-width no-break space is no space to Rust).
const WHITE = String.raw`\u{9}-\u{d}\u{20}\u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`
// What follows the `(?` of a group of flags, up to its `:` or `)`, when an `s` is among them: `.` takes a line feed there.
const DOTALL_FLAGS = /^[a-zA-Z-]*s/

/**
 * → a regular expression of Rust's, as the JavaScript source that matches the same texts (to be run as `giu`), or null when there
 * is none that is sure to: not a string, `\b` `\B` `\w` `\W` `\d` `\D` (Unicode in Rust, ASCII in JavaScript), a class of POSIX
 * (`[[:alpha:]]`), a class inside a class or an intersection, a difference or a symmetric difference in one, `\S` in one, a
 * class that starts with `]`, a group of flags with an `s` (`(?s:...)`), and whatever else does not compile in Unicode mode (`(?P<name>...)`, a flag in the middle, `\p{Greek}`,
 * `\x{41}`, an escape of a letter that stands for nothing). Translated: a leading `(?i)` is taken off (every pattern is run in any
 * case), `\A` is `^`, `\z` is `$`, `\pL` is `\p{L}` (and `\PL`), `.` is any character but a line feed (JavaScript's would also leave
 * out a carriage return and the line and paragraph separators), and `\s` and `\S` are the White_Space of Unicode written out, which
 * has U+0085 and not U+FEFF (the `\s` of JavaScript has the one and lacks the other). A group of flags with an `s` among them is given up
 * on too: `.` takes a line feed in it, which the `.` written here does not.
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
      // `\S` in a class is "everything but white space" among other members, which a class of JavaScript's cannot say.
      // Stryker disable next-line ConditionalExpression,StringLiteral: the compile check below refuses it too (the class that this would write in the class leaves a `]` alone); this is what says why
      if (d === 'S' && inClass) return null
      if (d === 'A' && !inClass) out += '^'
      else if (d === 'z' && !inClass) out += '$'
      else if (d === 's') out += inClass ? WHITE : `[${WHITE}]`
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
      // A group of flags with an `s` in it would make `.` match a line feed there, which the `[^\n]` written for it does not.
      if (c === '(' && d === '?' && DOTALL_FLAGS.test(source.slice(i + 2))) return null
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
 * (so it is here, with the rest of the checks, and the worker file only calls it); a source that does not compile, and a job that is not
 * a list of lists of texts and a list of texts, are an exception: no text that was not read may be told as one with no match.
 */
export function scanPatterns({ rules, texts }) {
  // Not a text, and not a pattern, is no match for a pattern to find, and no match must not be what a text that was never read answers.
  const isList = (value, ofWhat) => Array.isArray(value) && value.every(ofWhat)
  if (!isList(texts, (text) => typeof text === 'string') || !isList(rules, (sources) => isList(sources, (source) => typeof source === 'string'))) {
    throw new TypeError('the job must be a list of lists of patterns and a list of texts')
  }
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

/**
 * → { found } (the answer of scanPatterns()) or { failed: true } for a job: what the child process says to each job it is sent. A job
 * that cannot be run (a source that does not compile, a text that is no text) must not end the child with a trace of its own on the
 * log, which would carry the pattern: it is told as a failure, and the message of the error is left out.
 */
export function answerJob(job) {
  try {
    return { found: scanPatterns(job) }
  } catch {
    return { failed: true }
  }
}

// The process that runs the patterns of the rules: one for the whole server, so that the work of a text made to be slow holds up that
// process and never the server, and so that it can be KILLED when it is not done in time. (A thread cannot be: on Bun a worker that is
// terminated runs the regular expression it is in to its end, which for a pattern with several `.*` can take minutes of a core.)
// It is started when it is first wanted, and a job that is not answered in its budget, or that ends it, kills it and the next job
// starts another. The jobs run one at a time, so that each is given the answer of its own. When this process exits (a crash that is caught,
// a signal that is handled, a normal end) the child it has is killed too. A process that is killed with SIGKILL cannot do that: outside a
// container, where the end of the first process ends all that it started, a child that is in the middle of a job runs it to its end (for
// a pattern with several `.*`, minutes of a core), and one that is idle ends by itself when the channel closes.
const WORKER_FILE = fileURLToPath(new URL('./librariusRegexWorker.js', import.meta.url))

// Told once for the whole process, for a child that cannot run is made again by every job, and would be told again each time. What it says
// is left out: a trace of it may hold a path, and a failure of the child must never carry a pattern or a text into a log. A reply that a
// pattern applies to is refused (fail closed) while it fails, so the owner is told why, once.
let workerTold = false

// What kills the child that each runner has, run when this process exits: one listener for all the runners (a test makes many), and not
// one for each child that is spawned.
const killers = new Set()
/** Kills the child that each runner has now (exported for the tests; it is what runs when this process exits). */
export function killRunners() {
  for (const kill of killers) kill()
}
process.once('exit', killRunners)

// Stryker disable BlockStatement,ConditionalExpression,BooleanLiteral,StringLiteral: the log, which no test asserts
function workerFailed() {
  if (workerTold) return
  workerTold = true
  console.error("Librarius: the process that checks AutoMod patterns failed, so a reply that a rule's pattern applies to is refused until it runs again.")
}
// Stryker restore BlockStatement,ConditionalExpression,BooleanLiteral,StringLiteral

/**
 * → a new child process that runs librariusRegexWorker.js with the runtime of the server (`node` for the tests, `bun` in the container),
 * with a channel of its own for messages that are plain JSON, and nothing else: no standard input or output, and none of the environment of
 * the server, which holds its secrets. It runs in the folder of its own file: Bun reads a `.env` of its working folder into the environment
 * of whatever it runs, so a child that started where the server was started (`server/`, on a machine that is not the container) would have
 * the secrets back. It never keeps the server alive by itself.
 */
export function spawnRegexWorker() {
  const child = spawn(process.execPath, [WORKER_FILE], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'json', env: {}, cwd: dirname(WORKER_FILE) })
  child.unref()
  // Stryker disable next-line OptionalChaining: Node's channel can be let go of and Bun's has no such call (its child does not hold the server alive); the suite runs on Node
  child.channel?.unref?.()
  return child
}

/**
 * → what `child` says that `accept` takes for the answer (any value but undefined), or null when it said nothing within `limit` ms, ended, or
 * failed first. `handOver(fail)` is called once the listening has started, to hand over the work, and `fail()` ends the wait with null.
 */
function hear(child, limit, accept, handOver) {
  return new Promise((resolve) => {
    const done = (answer) => {
      clearTimeout(timer)
      child.off('message', heard)
      child.off('exit', fail)
      child.off('error', fail)
      resolve(answer)
    }
    const heard = (message) => {
      const answer = accept(message)
      if (answer !== undefined) done(answer)
    }
    const fail = () => done(null)
    const timer = setTimeout(fail, limit)
    child.on('message', heard)
    child.once('exit', fail)
    child.once('error', fail)
    handOver(fail)
  })
}

const isAnswer = (message) => isObject(message) && message.found !== undefined

/**
 * → a function that runs a job in a child process of the kind that `spawnChild()` makes (spawnRegexWorker(), and what the tests put in its
 * place), and answers { found } (the answer of scanPatterns() for the job) or null: it was not answered in REGEX_BUDGET_MS, from the moment
 * it was handed to a child that is ready (the time a child takes to start is not counted, but a child not ready in REGEX_READY_MS is
 * failed, and so is every job that waits for it); or the child ended, or failed, or said something that is no answer; or REGEX_MAX_WAITING
 * jobs are waiting for the one that runs already. A null is never "no match": the caller must refuse the reply. A child that did not answer
 * in time is killed (SIGKILL, which stops a regular expression that is running) and forgotten, and the next job starts another. A job
 * rejects its caller when a child cannot be started at all.
 */
export function createRegexRunner(spawnChild) {
  // The child that the next job uses, or null; { child, ready } with `ready` the promise of true when it said so, and null when it did not.
  let current = null
  killers.add(() => current?.child.kill('SIGKILL'))
  const queue = []
  let busy = false

  function begin() {
    const child = spawnChild()
    const entry = { child, ready: null }
    // Without a listener, an error of the child is thrown, and ends the server.
    child.on('error', workerFailed)
    // A child that ends when no job is using it (or in the middle of one) is forgotten, so that the next job starts another.
    child.once('exit', () => {
      if (current === entry) {
        current = null
        workerFailed()
      }
    })
    entry.ready = hear(child, REGEX_READY_MS, (message) => (isObject(message) && message.ready === true ? true : undefined), () => {})
    return entry
  }

  // The job that discards a child is the one that was using it, so the child is the current one, or was forgotten already (it ended).
  function discard(entry) {
    current = null
    entry.child.kill('SIGKILL')
  }

  /** → the answer of the child that `entry` is to `job`, or null: it did not within the budget, or it failed. */
  async function ask(entry, job) {
    let asked
    // An answer that came late is as good as none, even when it says there was no match: the time is what was refused.
    const accept = (message) => {
      if (performance.now() - asked >= REGEX_BUDGET_MS) return null
      if (isAnswer(message)) return message
      workerFailed()
      return null
    }
    return hear(entry.child, REGEX_BUDGET_MS, accept, (fail) => {
      asked = performance.now()
      try {
        entry.child.send(job, (error) => {
          if (error) fail()
        })
      } catch {
        // A job that cannot be written to the child (JSON has no BigInt) is one that cannot be run.
        fail()
      }
    })
  }

  async function run(job) {
    current ??= begin()
    const entry = current
    if ((await entry.ready) !== true) {
      discard(entry)
      workerFailed()
      for (const waiting of queue.splice(0)) waiting.resolve(null)
      return null
    }
    const answer = await ask(entry, job)
    if (answer === null) discard(entry)
    return answer
  }

  async function pump() {
    if (busy) return
    busy = true
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      try {
        next.resolve(await run(next.job))
      } catch (error) {
        next.reject(error)
      }
    }
    busy = false
  }

  return (job) =>
    new Promise((resolve, reject) => {
      if (queue.length >= REGEX_MAX_WAITING) {
        resolve(null)
        return
      }
      queue.push({ job, resolve, reject })
      void pump()
    })
}

/** → what the one child process of the server answers to `job` (see createRegexRunner). */
export const scanInWorker = createRegexRunner(spawnRegexWorker)

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
        ...indexed(listOf(meta.keyword_filter).map((k) => keywordOf(k, mode)).filter((k) => k !== null)),
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
    // The two readings of a keyword hold something or both hold nothing (what is left out in one is a space in the other, and spaces at the
    // ends are cut), so a rule of no keyword that is read as it is written leaves the text alone, and is not folded.
    if (rule[DROPPED].keywords.length > 0) {
      for (const mode of MODES) {
        const folded = norm(mode)
        let allow = null
        const found = earliestIn(folded, rule[mode], () => (allow ??= allowedIn(folded, rule[mode].allow)))
        if (found !== null) take(folded.from[found.a], folded.to[found.b - 1])
      }
    }
    for (const re of rule.literals) {
      const found = re.exec(text)
      if (found !== null) take(found.index, found.index + found[0].length)
    }
    return best
  }

  // Of keywords only: the patterns are run by matcher.regex(), which waits for a child process. `spend` is what the texts of one reply may
  // add by being folded, in all (see foldBoth): the caller that asks about several texts gives them one, and a call that is given none has its own.
  const matcher = (text, spend = { left: FOLD_TOTAL }) => {
    if (typeof text !== 'string') throw new TypeError('the text must be a string')
    let readings = null
    const norm = (mode) => (readings ??= foldBoth(text, spend))[mode]
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
  matcher.mentionCap = mentionCap
  return matcher
}

// The nodes that end what a link written in the text before them could be: the text of one is no part of the text of another.
const BARRIERS = new Set(['line', 'heading', 'subtext', 'blank', 'divider', 'codeblock', 'code', 'br', 'list', 'quote', 'table', 'footnotes'])
// What follows the `](` of a masked link, as an address (with at most one level of parentheses in it) between at most a pair of
// angle brackets, and the closing parenthesis. Runs of spaces are made one first, so that this is linear.
const LINK_SHAPED = /\]\( ?<?((?:[^\s()<>[\]]|\([^\s()<>[\]]*\))*)>? ?\)/g
// A masked link as it is written, `[text](address)`, with the text of one line and no bracket in it and the address of one line with at
// most one level of parentheses in it (a title, a space and angle brackets are all characters of it). No part of it can start before another
// ends, so that finding the links of any text is a single pass.
const MASKED_LINK = /\[([^\][\n]*)\]\((?:[^()\][\n]|\([^()\][\n]*\))*\)/g
// What the form writes for what the member typed (librariusForm.js), in one pass from left to right, so that a backslash it doubled is read
// before the character after it:
// - a link: the address of a masked link and a bare address are written in angle brackets (`[text](<address>)`, `<address>`), and only an
//   address that starts with http:// or https:// is a link at all (see hasBadLink);
// - an escape: a backslash before each mark of Discord's markdown in a text (`\ * _ ~ | \` < [ ]`), and before what would start a heading,
//   a list or a quote at the start of a line (`#`, `-`, `>`, and the full stop after the number of an ordered list);
// - a zero-width space: between two marks of one character that touch (`*a*` then `**b**`, `__`, code, and after an escaped mark), in a run
//   of three backticks in a block of code or a table, and in a mark that a cut leaves with nothing to hold. Every one is taken out, the
//   member's too: the text that is sent is read as well, so that only ever finds more.
const FORM_SPELLING = /<(https?:\/\/[^\s<>]*)>|\\([\\*_~|`<>[\]#.-])|\u200b/g
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

/**
 * → the text with each masked link `[text](address)` put by its text: what a reader of the message takes for words, which the brackets and
 * the address of the link split (`[zo](https://e.com)rp` shows "zorp"). Discord's own rules read the characters that are sent, so this is
 * a reading that only the site has, for where it is not told what Discord does: it can only refuse more. Not a parse: a pattern that looks
 * like a link in code is read as one too, which gives one more reading that holds the same words.
 */
export const unmasked = (text) => text.replace(MASKED_LINK, '$1')

/**
 * → the text as the member typed it, as near as the text that is sent can say: what the form wrote for it undone (FORM_SPELLING). Each link is
 * let out of its angle brackets (`[text](<address>)` is `[text](address)` and `<address>` is `address`, for the addresses of http and https),
 * each escape is the character it escapes (`z\*rp` is `z*rp`, `free\_nitro` is `free_nitro`, `\\` is a backslash, `1\.` is `1.`), and the
 * zero-width spaces that the form puts between marks are taken out. The form writes every link and every mark so, whatever the member typed,
 * and the patterns of the server were written for what members type (`z[o*]rp` for `z*rp`, `\]\(https?://` for a link), so the patterns read
 * this copy as well as the text that is sent. It cannot tell what the form wrote from what the member did: an address that the member wrote in
 * angle brackets is let out too, and so is a backslash of the member's before one of those characters, which is what Discord would have shown a
 * rule had it been typed there, and every zero-width space goes, the member's as well; and the text that is sent is read as well, so this only
 * ever finds more. Not undone, as they are no letters of the member's: the marks of a cut, which close what is open at the end of a part and open
 * it again in the next, the space that a spoiler left empty by a cut is given (`|| ||`), the space before code that starts with a backtick, an
 * italic of `_` that the form writes with `*`, a heading that it writes in bold, and the cells of a table, which are sent as a block of code.
 * The copy is never longer than the text.
 */
export const typed = (text) => text.replace(FORM_SPELLING, (whole, link, escaped) => link ?? escaped ?? '')

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
 * → the texts that the parts of a reply show of the reply itself, as the form built them: the Text Displays of a V2 part, one by one
 * and then, when there are two or more, joined by a line end (which is what the fallback shows of the same part), or the text of a
 * plain one, each without what the site puts there (the line of the message it answers, the mark of the part, the footer, which are
 * the same whatever was written, and which the rules were never written for). Never the texts of two parts together: they are two
 * messages. A picture written inside a line is not in these texts, nor is the text of one that has nothing to show, so what stood on
 * its two sides is next to each other here.
 */
export const shownBy = (parts, fixed) => shownEach(parts, fixed).map((shown) => shown.text)

/**
 * → what shownBy() is made of: { text, joined } for each of the texts, `joined` being true for a text that is the displays of a V2 part put
 * together, which holds the characters of the displays that came before it in the list.
 */
function shownEach(parts, fixed) {
  const texts = []
  parts.forEach((part, k) => {
    const shown = part.components === null ? [part.text] : displaysOf(part.components)
    if (k === 0 && fixed.reply !== null) shown[0] = withoutFirstLine(shown[0], fixed.reply)
    if (parts.length > 1) shown[0] = withoutMark(shown[0], `**${k + 1}/${parts.length}**`)
    if (k === parts.length - 1) shown[shown.length - 1] = withoutLastLine(shown[shown.length - 1], fixed.footer)
    const kept = shown.filter((text) => text !== '')
    texts.push(...kept.map((text) => ({ text, joined: false })))
    // A V2 message is read as what the fallback shows of the same part too, its displays joined by a line end: the same reply is
    // refused in both forms. A picture on a line of its own sets two displays apart there and is only blank lines in the fallback.
    if (kept.length > 1) texts.push({ text: kept.join('\n'), joined: true })
  })
  return texts
}

export async function validateReply(input, options) {
  if (!isObject(options)) throw new TypeError('the options must be an object')
  const { form, automod, mentionCap = MENTION_CAP, ownUploadIds, authorId, siteUrl } = options
  limitFor(form === undefined ? DEFAULT_FORM : form)
  if (typeof automod !== 'function') throw new TypeError('automod must be a function')
  if (typeof authorId !== 'string') throw new TypeError('authorId must be a string')
  if (typeof siteUrl !== 'string') throw new TypeError('siteUrl must be a string')
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

  // What is sent is not the text that was written: a picture written inside a line is sent as a file, and nothing of it is left in
  // the line, so `zo![](upload:1)rp` is "zorp" there. Whatever the rules find in the parts and not in the source is refused as well.
  // The match is in text the writer never sees, so it has no place in the source: it is null.
  // Stryker disable next-line ObjectLiteral,StringLiteral: a stand-in reply of one letter, of which only the lines the site adds are taken
  const stand = toDiscord('x', { ...common, images: [] }).parts[0].text.split('\n')
  const fixed = { reply: replyTo === null ? null : stand[0], footer: stand[stand.length - 1] }
  const each = shownEach(sent.parts, fixed)
  const shown = each.map((one) => one.text)

  // The keywords read the source, and then each text that is sent, and each of them again with the masked links read as their text, when
  // that is not the same text. A text that folds to more than it may (Unfoldable) was not checked: the reply is refused, not let through.
  // What the folding of the texts adds is taken from one allowance for the whole reply (FOLD_TOTAL) for the source and each part. The
  // other readings go over the characters of those again (the displays put together, the links read as their text), and are held to the
  // size of the text that each is, as any text is: they would use the allowance up for a long reply that is no more than ordinary.
  const spend = { left: FOLD_TOTAL }
  const again = () => ({ left: Number.POSITIVE_INFINITY })
  try {
    const hit = automod(text, spend)
    if (hit !== null) return blocked(hit, { start: hit.start, end: hit.end })
    const bare = unmasked(text)
    const reads = [
      ...(bare === text ? [] : [[bare, again()]]),
      ...each.flatMap(({ text: part, joined }) => (unmasked(part) === part ? [[part, joined ? again() : spend]] : [[part, joined ? again() : spend], [unmasked(part), again()]])),
    ]
    for (const [read, allowance] of reads) {
      const found = automod(read, allowance)
      if (found !== null) return blocked(found, null)
    }
  } catch (error) {
    if (!(error instanceof Unfoldable)) throw error
    return refused(422, COPY.unchecked)
  }

  // The patterns read what is sent only (see scanInWorker): the source holds what is not sent, and is up to 16,000 characters, where
  // the time of a pattern with several `.*` grows with the 4th power of the text. Each text is read as it is sent and, when that is not the
  // same text, as the member typed it (typed()): with its links out of the angle brackets and its marks out of the escapes that the form
  // wrote them in. A rule against `z*rp` or against the shape of a link would see neither otherwise.
  if (typeof automod.regex === 'function') {
    const found = await automod.regex(
      shown.flatMap((part) => {
        const copy = typed(part)
        return copy === part ? [part] : [part, copy]
      }),
    )
    if (found !== null && found.unchecked === true) return refused(422, COPY.unchecked)
    if (found !== null) return blocked(found, null)
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
