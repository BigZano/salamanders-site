/**
 * Refuses to let plaintext Legion Archive exports (or stray sealed files)
 * into git. The repo is public: anything committed is published for good.
 *   node scripts/archive-leak-guard.mjs --staged   (pre-commit)
 *   node scripts/archive-leak-guard.mjs --tracked  (CI)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const BLOCKED = [
  /(^|\/)archive-export[^/]*(\/|$)/i, // incl. archive-export-restored/ (unseal output), backups
  /(^|\/)public\/archive(-e2e)?\//i,
  /(^|\/)e2e\/\.archive\//i,
  /(^|\/)public\/(accolades|rank-requirements)\//i,
  /(^|\/)src\/data\/(accolades|rank-requirements)\//i,
]
// JSON-key signatures of a raw Discord export, assembled so this file never
// contains them literally.
const SIGNATURES = ['guild' + '_id', 'mention' + '_roles', 'available' + '_tags', 'applied' + '_tags', 'permission' + '_overwrites'].map(
  (k) => '"' + k + '":',
)
const SEALED_MAGIC = 'LAR\u0001'

export function checkPath(p) {
  if (typeof p !== 'string' || p === '') return 'invalid path'
  const norm = p.replace(/\\/g, '/')
  return BLOCKED.some((re) => re.test(norm)) ? `archive path must never be committed: ${p}` : null
}

export function checkContent(p, text) {
  const hits = SIGNATURES.filter((s) => text.includes(s)).length
  if (hits >= 2) return `looks like a raw Discord export (${hits} signatures): ${p}`
  if (text.startsWith(SEALED_MAGIC)) return `sealed archive file outside the release flow: ${p}`
  return null
}

export function checkHash(p, sha256, known) {
  return known.has(sha256) ? `bytes identical to a Discord export asset: ${p}` : null
}

function knownAssetHashes() {
  const known = new Set()
  for (const dir of ['accolades', 'rank-requirements']) {
    const f = `archive-export/${dir}/data/assets.json`
    if (!existsSync(f)) continue
    for (const a of Object.values(JSON.parse(readFileSync(f, 'utf8')))) known.add(a.sha256)
  }
  return known
}

function git(args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 1 << 30 })
}

function run(mode) {
  const list =
    mode === '--staged'
      ? git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
      : git(['ls-files', '-z'])
  const paths = list.toString('utf8').split('\0').filter(Boolean)
  const known = knownAssetHashes()
  const problems = []
  for (const p of paths) {
    const byPath = checkPath(p)
    if (byPath) {
      problems.push(byPath)
      continue
    }
    const blob = mode === '--staged' ? git(['show', `:${p}`]) : git(['show', `HEAD:${p}`])
    const byContent = checkContent(p, blob.subarray(0, 4 << 20).toString('latin1'))
    if (byContent) problems.push(byContent)
    const byHash = checkHash(p, createHash('sha256').update(blob).digest('hex'), known)
    if (byHash) problems.push(byHash)
  }
  if (problems.length) {
    console.log(problems.join('\n'))
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (mode !== '--staged' && mode !== '--tracked') {
    console.log('usage: archive-leak-guard.mjs --staged|--tracked')
    process.exit(2)
  }
  run(mode)
}
