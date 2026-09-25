/** Post-build plaintext scan. CI runs signatures only; locally, --sentinels-from adds real-content strings. */
import { readdir, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLLECTIONS, GUILD_ID } from '../src/lib/archive/registry.js'

const SIGS = ['guild' + '_id', 'mention' + '_roles', 'available' + '_tags', 'applied' + '_tags', 'permission' + '_overwrites']
  .flatMap((k) => ['"' + k + '":', '\\"' + k + '\\":'])
const MAGIC = [['\u0089PNG', 'PNG'], ['GIF8', 'GIF'], ['\u00ff\u00d8\u00ff', 'JPEG'], ['RIFF', 'WEBP'], ['{', 'JSON'], ['[', 'JSON']]

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else yield p
  }
}

export async function scanDir(dir, { sentinels = [] } = {}) {
  const findings = []
  for await (const p of files(dir)) {
    const rel = relative(dir, p).replace(/\\/g, '/')
    const text = (await readFile(p)).toString('latin1')
    if (/^(accolades|rank-requirements)\//.test(rel)) findings.push(`${rel}: plaintext export directory in build`)
    if (rel.startsWith('archive')) {
      if (!/^archive(-e2e)?\/[0-9a-f]{32}\.bin$/.test(rel)) findings.push(`${rel}: non-opaque file under archive/`)
      for (const [m, kind] of MAGIC) if (text.startsWith(m)) findings.push(`${rel}: plaintext ${kind} under archive/`)
    }
    const hits = SIGS.filter((s) => text.includes(s)).length
    if (hits >= 2) findings.push(`${rel}: Discord export JSON signatures (${hits})`)
    for (const s of sentinels) if (text.includes(s)) findings.push(`${rel}: contains archive content sentinel`)
  }
  return findings
}

// publicText: text already published (tracked src/ + public/). Anything in it
// can't be a leak — e.g. rank names the Companies page shows anyway.
export async function sentinelsFrom(exportDir, { publicText = '' } = {}) {
  const out = new Set()
  for (const c of COLLECTIONS) {
    const base = join(exportDir, c.exportDir, 'data')
    for (const t of JSON.parse(await readFile(join(base, 'index.json'), 'utf8'))) if (t.name?.length >= 6) out.add(t.name)
    for (const f of await readdir(join(base, 'threads'))) {
      for (const m of JSON.parse(await readFile(join(base, 'threads', f), 'utf8')).messages) out.add(m.id)
    }
    for (const a of Object.values(JSON.parse(await readFile(join(base, 'assets.json'), 'utf8')))) out.add(a.file)
  }
  out.delete(GUILD_ID)
  return [...out].filter((s) => !publicText.includes(s))
}

function trackedPublicText() {
  const files = execFileSync('git', ['ls-files', '-z', 'src', 'public'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, flag, src] = process.argv.slice(2)
  const publicText = flag === '--sentinels-from' ? trackedPublicText() : ''
  const sentinels = flag === '--sentinels-from' ? await sentinelsFrom(src, { publicText }) : []
  const findings = await scanDir(dir, { sentinels })
  if (findings.length) {
    // Never print sentinel values themselves — only where they were found.
    console.log(findings.join('\n'))
    process.exit(1)
  }
  console.log(`scan clean: ${dir}${sentinels.length ? ` (+${sentinels.length} local sentinels)` : ''}`)
}
