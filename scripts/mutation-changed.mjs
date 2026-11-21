/**
 * Mutation testing on the lines a piece of work changed, and on nothing else: `bun run test:mutation:changed <base-ref>`
 * (or `node scripts/mutation-changed.mjs <base-ref> [--related]`), run once, when the work is finished. It is not part of
 * the push hook. `bun run test:mutation` is still there for a deliberate run over every file the gate mutates.
 *
 * It takes the lines that the commits since the merge base of <base-ref> and HEAD added, in the files that
 * stryker.config.mjs mutates (a deleted line gives nothing to mutate), and runs Stryker on those lines only, with
 * those files' own test files (see runOptions in scripts/lib/changed-lines.mjs for what that costs, and --related for
 * the slower run that does not pay it), at a 100% break on two runners. The temporary config it writes for that, which
 * imports stryker.config.mjs, lives outside the repository and is deleted afterwards, whatever happened.
 *
 * The tree must be clean, since Stryker mutates the files as they are on disk and the lines come from the commits. A bad
 * base ref or a dirty tree is an error (exit 1) before anything runs; with nothing to mutate it says so and exits 0;
 * otherwise it exits with Stryker's code. What it does is scripts/lib/changed-lines.mjs's, which is tested; this file only
 * asks git and runs Stryker.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { changedRanges, configText, diffArgs, mutatePatterns, ownTestFiles, parseArgs, runOptions } from './lib/changed-lines.mjs'

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })

function fail(message) {
  console.error(message)
  process.exit(1)
}

function tryGit(args, cwd, message) {
  try {
    return git(args, cwd)
  } catch {
    return fail(message)
  }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (err) {
  fail(err.message)
}
const root = tryGit(['rev-parse', '--show-toplevel'], process.cwd(), 'This is not a git checkout.').trim()
const dirty = tryGit(['status', '--porcelain'], root, 'git status failed.')
if (dirty !== '') {
  fail(`The working tree has changes (git status --porcelain):\n${dirty}Commit or stash them first: the lines to mutate are read from the commits, and Stryker mutates the files as they are on disk.`)
}
const base = tryGit(['rev-parse', '--verify', '--quiet', `${options.base}^{commit}`], root, `${options.base} is not a commit git knows.`).trim()
const from = tryGit(['merge-base', base, 'HEAD'], root, `${options.base} and HEAD have no commit in common.`).trim()

const baseConfig = join(root, 'stryker.config.mjs')
const { default: config } = await import(pathToFileURL(baseConfig).href)
const ranges = changedRanges(git(diffArgs(from, 'HEAD'), root), config.mutate)
if (ranges.size === 0) {
  console.log(`Nothing to mutate: the commits since ${options.base} (merge base ${from.slice(0, 12)}) add no lines to the files stryker.config.mjs mutates.`)
  process.exit(0)
}

let testFiles = null
if (!options.related) {
  const tracked = git(['ls-files', '-z'], root).split('\0').filter(Boolean)
  const own = ownTestFiles([...ranges.keys()], tracked)
  if (own.without.length > 0) {
    fail(`These changed files have no test file of their own (name.test.js or name.*.test.js beside them):\n  ${own.without.join('\n  ')}\nRun with --related to judge them by every test file that imports them.`)
  }
  testFiles = own.testFiles
}

const patterns = mutatePatterns(ranges)
const lines = [...ranges.values()].flat().reduce((sum, [start, end]) => sum + end - start + 1, 0)
console.log(`Mutating ${lines} changed line(s) since ${options.base} (merge base ${from.slice(0, 12)}):\n  ${patterns.join('\n  ')}`)
console.log(testFiles === null ? 'Tests: every test file that imports a changed file (--related).' : `Tests: ${testFiles.join(', ')}`)

const dir = mkdtempSync(join(tmpdir(), 'stryker-changed-'))
let code = 1
try {
  const file = join(dir, 'stryker.changed.config.mjs')
  writeFileSync(file, configText(pathToFileURL(baseConfig).href, runOptions({ patterns, testFiles })))
  const child = spawn(join(root, 'node_modules', '.bin', 'stryker'), ['run', file], { cwd: root, stdio: 'inherit' })
  // A stop (Ctrl-C, a closed terminal, a kill) goes to Stryker, which cleans up its sandboxes; the config goes below.
  const forward = (signal) => child.kill(signal)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward)
  code = await new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(`Stryker could not be started: ${err.message}`)
      resolve(1)
    })
    child.on('close', (exit) => resolve(exit ?? 1))
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(code)
