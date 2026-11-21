/**
 * The pure half of scripts/mutation-changed.mjs, which runs Stryker on the lines a piece of work changed and on nothing
 * else.
 *
 * changedRanges(diff, mutate) → Map of path → [[start, end], …]
 *   The lines a diff adds, as ranges of whole lines of the new files (1-based, ends included, in order, apart), for the
 *   files that `mutate` (stryker.config.mjs's list of plain paths) names. A file the diff deletes, a hunk that only
 *   deletes, a rename with no change and a binary file add nothing. A renamed file is named by its new path. The diff is
 *   git's unified diff (diffArgs below asks for one with no context lines, but context lines are read too), with LF or
 *   CRLF line ends, paths as git writes them (a tab after a name with a space in it, C-style quotes around one with a
 *   quote, a backslash, a control character or, by default, a letter past ASCII), and "\ No newline at end of file".
 *   A diff it cannot read all of is a SyntaxError: a hunk header git does not write, a hunk of no file, a line that
 *   does not fit its hunk or is outside every hunk, a diff that ends inside a hunk, or a path quoted as git does not.
 * mutatePatterns(ranges) → ['path:start-end', …], Stryker's way of saying "these whole lines of this file".
 * ownTestFiles(sources, tracked) → { testFiles, without }: the tracked test files beside each source that are named
 *   for it (`name.test.js`, or `name.<anything>.test.js`, or .mjs), and the sources that have none.
 * runOptions({ patterns, testFiles }) → what the run puts over the base config. testFiles null leaves the choice of
 *   tests to the vitest runner's related mode.
 * configText(baseUrl, options) → the text of a Stryker config that imports the base config and puts options over it.
 * diffArgs(from, to) → git's arguments for the diff changedRanges reads, whatever the caller's git settings are.
 * parseArgs(args) → { base, related } from the command line.
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/
// What Stryker reads as a glob, a negation or a mutation range: the list must be plain paths to be matched to a diff's.
const NOT_PLAIN = /[*?[\]{}]|^!|:\d+(?::\d+)?-\d+(?::\d+)?$/
// A name as git quotes it: every character but a quote and a backslash as it is, and those two, the control characters
// git names by a letter and any other byte (three octal digits) escaped.
const QUOTED = /^"((?:[^"\\]|\\(?:[0-7]{3}|[abtnvfr"\\]))*)"$/
const ESCAPE = /\\([0-7]{3}|[abtnvfr"\\])|[^\\]+/g
const LETTERS = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
const TEST_FILE = /\.test\.m?js$/
const USAGE = 'usage: node scripts/mutation-changed.mjs <base-ref> [--related]'
// The file a hunk belongs to after `+++ /dev/null`: it may only take lines away.
const DELETED = Symbol('deleted')

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const isPathList = (v, { filled = false } = {}) => Array.isArray(v) && (!filled || v.length > 0) && v.every((p) => typeof p === 'string')
const isRef = (v) => typeof v === 'string' && v !== '' && !v.startsWith('-')

function unquote(text, lineNumber) {
  const bad = new SyntaxError(`Line ${lineNumber} of the diff quotes a file name in a way git does not.`)
  const inside = QUOTED.exec(text)?.[1]
  if (inside === undefined) throw bad
  const bytes = []
  for (const [part, escaped] of inside.matchAll(ESCAPE)) {
    if (escaped === undefined) bytes.push(...encoder.encode(part))
    else if (escaped in LETTERS) bytes.push(LETTERS[escaped])
    else if (Number.parseInt(escaped, 8) > 255) throw bad
    else bytes.push(Number.parseInt(escaped, 8))
  }
  return decoder.decode(Uint8Array.from(bytes))
}

// The path on a `+++ ` line (what follows the four characters), without git's b/ prefix; DELETED for /dev/null.
function newPath(rest, lineNumber) {
  if (rest === '/dev/null') return DELETED
  const name = rest.startsWith('"') ? unquote(rest, lineNumber) : rest.split('\t')[0]
  if (!name.startsWith('b/') || name === 'b/') throw new SyntaxError(`Line ${lineNumber} of the diff names a new file without git's b/ prefix.`)
  return name.slice(2)
}

// Line numbers, in any order and repeated or not, as ordered ranges that neither overlap nor touch.
function toRanges(numbers) {
  const ranges = []
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = ranges.at(-1)
    if (last !== undefined && n <= last[1] + 1) last[1] = n
    else ranges.push([n, n])
  }
  return ranges
}

export function changedRanges(diff, mutate) {
  if (typeof diff !== 'string') throw new TypeError('The diff must be text.')
  if (!isPathList(mutate) || !mutate.every((p) => p !== '' && !NOT_PLAIN.test(p))) {
    throw new TypeError('mutate must be a list of plain file paths: no globs, negations or line ranges.')
  }
  const listed = new Set(mutate)
  const added = new Map()
  const lines = diff.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  // The newline that ends the last line does not start another one.
  if (lines.at(-1) === '') lines.pop()
  // undefined before the first file and after a `diff --git` line that no `+++` line has followed yet.
  let path
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('diff --git ')) {
      path = undefined
    } else if (line.startsWith('+++ ')) {
      path = newPath(line.slice(4), i + 1)
    } else if (line.startsWith('@@')) {
      const header = HUNK.exec(line)
      const [oldStart, oldCount, newStart, newCount] = header === null ? [] : [header[1], header[2] ?? '1', header[3], header[4] ?? '1'].map(Number)
      if (header === null || ![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) || (newStart === 0 && newCount > 0)) {
        throw new SyntaxError(`Line ${i + 1} of the diff is not a hunk header git writes.`)
      }
      if (path === undefined) throw new SyntaxError(`Line ${i + 1} of the diff starts a hunk that belongs to no file.`)
      if (path === DELETED && newCount > 0) throw new SyntaxError(`Line ${i + 1} of the diff adds lines to a file it deletes.`)
      const into = typeof path === 'string' && listed.has(path) ? (added.get(path) ?? added.set(path, []).get(path)) : []
      let oldLeft = oldCount
      let newLeft = newCount
      let at = newStart
      while (oldLeft > 0 || newLeft > 0) {
        i += 1
        if (i === lines.length) throw new SyntaxError('The diff ends inside a hunk.')
        const kind = lines[i].charAt(0)
        if (kind === '\\') continue
        if (kind === '+' && newLeft > 0) {
          into.push(at)
          at += 1
          newLeft -= 1
        } else if (kind === '-' && oldLeft > 0) {
          oldLeft -= 1
        } else if ((kind === ' ' || kind === '') && oldLeft > 0 && newLeft > 0) {
          // An empty line is a blank context line, as git writes one with diff.suppressBlankEmpty.
          at += 1
          oldLeft -= 1
          newLeft -= 1
        } else {
          throw new SyntaxError(`Line ${i + 1} of the diff does not fit its hunk.`)
        }
      }
    } else if (/^[+\- ]/.test(line) && !line.startsWith('--- ')) {
      throw new SyntaxError(`Line ${i + 1} of the diff is a line of a file outside every hunk.`)
    }
  }
  return new Map([...added].filter(([, numbers]) => numbers.length > 0).map(([file, numbers]) => [file, toRanges(numbers)]))
}

export function mutatePatterns(ranges) {
  return [...ranges].flatMap(([file, list]) => list.map(([start, end]) => `${file}:${start}-${end}`))
}

export function ownTestFiles(sources, tracked) {
  if (!isPathList(sources) || !isPathList(tracked)) throw new TypeError('ownTestFiles takes two lists of paths.')
  const found = new Set()
  const without = []
  for (const source of sources) {
    const dir = source.slice(0, source.lastIndexOf('/') + 1)
    const base = source.slice(dir.length)
    const dot = base.lastIndexOf('.')
    const prefix = `${dir}${dot === -1 ? base : base.slice(0, dot)}.`
    const own = tracked.filter((file) => file.startsWith(prefix) && !file.slice(dir.length).includes('/') && TEST_FILE.test(file))
    if (own.length === 0) without.push(source)
    for (const file of own) found.add(file)
  }
  return { testFiles: [...found].sort(), without }
}

// Which tests judge the mutants. The run is held to the changed files' own test files (`testFiles`, which Stryker passes to
// the vitest runner; related mode then has nothing left to narrow, so it is off). That is what makes it fast: the dry run,
// which Stryker makes with every test it will use, is a few test files instead of every test file that imports a changed
// file, and for some files that is most of the suite (a full instrumented dry run takes 13 minutes on the dev host). The
// cost: a mutant that only another file's tests kill, say a route test that reaches the changed code through the server,
// shows as a survivor (or as having no coverage). That errs one way only: it can fail a run whose mutants are all killed
// somewhere, never pass one with a real survivor. Such a survivor is checked by hand, or the run is made again with
// --related (testFiles null), which leaves the choice to vitest's related mode, as the full run does.
export function runOptions({ patterns, testFiles }) {
  if (!isPathList(patterns, { filled: true })) throw new TypeError('patterns must be a non-empty list: with none, Stryker would mutate every file the base config lists.')
  if (testFiles !== null && !isPathList(testFiles, { filled: true })) {
    throw new TypeError('testFiles must be a non-empty list, or null for related mode: with an empty one, Stryker would run every test.')
  }
  return {
    mutate: patterns,
    ...(testFiles === null ? {} : { testFiles, vitest: { related: false } }),
    thresholds: { high: 100, low: 100, break: 100 },
    concurrency: 2,
    reporters: ['clear-text', 'progress-append-only'],
    // Stryker's default is 5 minutes, and a big test file under instrumentation can take longer.
    dryRunTimeoutMinutes: 60,
  }
}

export function configText(baseUrl, options) {
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('file:')) throw new TypeError('baseUrl must be a file: url.')
  return [
    '// Written by scripts/mutation-changed.mjs for one run, and deleted after it.',
    `import base from ${JSON.stringify(baseUrl)}`,
    `const run = ${JSON.stringify(options)}`,
    'export default { ...base, ...run, vitest: { ...base.vitest, ...run.vitest } }',
    '',
  ].join('\n')
}

export function diffArgs(from, to) {
  if (!isRef(from) || !isRef(to)) throw new TypeError('diffArgs takes two commits, and neither may start with a dash.')
  // Each option overrides a setting that would change what git writes: diff.noprefix and diff.mnemonicPrefix (the
  // prefixes), color.diff, diff.external, a textconv driver, diff.relative, diff.renames, diff.context and
  // core.quotePath (which only makes names easier to read; quoted ones are read either way).
  return [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    '--find-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    from,
    to,
    '--',
  ]
}

export function parseArgs(args) {
  const flags = args.filter((arg) => arg === '--related').length
  const refs = args.filter((arg) => arg !== '--related')
  if (flags > 1 || refs.length !== 1 || !isRef(refs[0])) {
    throw new Error(
      `${USAGE}\nMutates the lines that the commits since the merge base of <base-ref> and HEAD added. --related runs every test file that imports a changed file, not only the changed files' own.`,
    )
  }
  return { base: refs[0], related: flags === 1 }
}
