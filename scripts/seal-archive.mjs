/**
 * Legion Archive CLI (run with bun or node ≥20):
 *   keygen [--rotate]      write a new ARCHIVE_KEY to archive-export/.env
 *   audit                  list every archive problem (local terminal only — never paste output anywhere public)
 *   seal [--publish]       audit, seal into public/archive/, write archive.lock.json; --publish uploads a GitHub Release
 *   fetch                  CI: download the lock's release into public/archive/ and verify it
 *   unseal --out <dir>     recover the export from public/archive/ (or a fetched release) with the key
 */
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { sealExport, verifyDir, unsealDir, readEnvKey, readExport } from './lib/archive-seal.mjs'
import { deriveKeys } from '../src/lib/archive/crypto.js'
import { createArchive } from '../src/lib/archive/model.js'
import { auditArchive } from '../src/lib/archive/audit.js'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    export: { type: 'string', default: 'archive-export' },
    out: { type: 'string', default: 'public/archive' },
    lock: { type: 'string', default: 'archive.lock.json' },
    'env-file': { type: 'string' },
    publish: { type: 'boolean', default: false },
    rotate: { type: 'boolean', default: false },
  },
})
const cmd = positionals[0]
const envFile = values['env-file'] ?? join(values.export, '.env')
const exists = (p) => access(p).then(() => true, () => false)
const key = async () => readEnvKey(await readFile(envFile, 'utf8'))
const sh = (bin, args, opts = {}) => execFileSync(bin, args, { stdio: 'inherit', ...opts })

async function main() {
  if (cmd === 'keygen') {
    if ((await exists(envFile)) && !values.rotate) throw new Error(`${envFile} exists; pass --rotate to replace the key`)
    await writeFile(envFile, `ARCHIVE_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600 })
    console.log(`New key written to ${envFile}. Store it in your password manager now, then set it as the server's ARCHIVE_KEY.`)
    return
  }
  if (cmd === 'audit') {
    const { index } = await readExport(values.export)
    const { problems, stats } = auditArchive(createArchive(index))
    console.log(JSON.stringify(stats))
    for (const p of problems) console.log(`${p.kind}\t${p.collectionKey ?? '-'}\t${p.threadId ?? '-'}\t${p.messageId ?? '-'}\t${p.detail}`)
    process.exitCode = problems.length ? 1 : 0
    return
  }
  if (cmd === 'seal') {
    const lock = await sealExport({ exportDir: values.export, rawKey: await key(), outDir: values.out })
    const prev = (await exists(values.lock)) ? JSON.parse(await readFile(values.lock, 'utf8')) : null
    const n = prev?.release ? Number(prev.release.replace('archive-v', '')) + 1 : 1
    lock.release = values.publish ? `archive-v${n}` : prev?.release ?? null
    if (values.publish) {
      const tmp = await mkdtemp(join(tmpdir(), 'archive-pub-'))
      const tar = join(tmp, `archive-${lock.kid}.tar`)
      sh('tar', ['-cf', tar, '-C', values.out, '.'])
      sh('gh', ['release', 'create', lock.release, tar, '--title', lock.release, '--notes', 'Sealed Legion Archive (ciphertext only).'])
      await rm(tmp, { recursive: true, force: true })
    }
    await writeFile(values.lock, JSON.stringify(lock, null, 2) + '\n')
    console.log(`sealed ${Object.keys(lock.files).length} files, kid ${lock.kid}${values.publish ? `, published ${lock.release}` : ''}`)
    return
  }
  if (cmd === 'fetch') {
    if (!(await exists(values.lock))) return console.log('no archive.lock.json — archive not published yet, skipping')
    const lock = JSON.parse(await readFile(values.lock, 'utf8'))
    if (!lock.release) throw new Error('archive.lock.json has no release — run `seal --publish` first')
    const tmp = await mkdtemp(join(tmpdir(), 'archive-fetch-'))
    sh('gh', ['release', 'download', lock.release, '--pattern', '*.tar', '--dir', tmp])
    await rm(values.out, { recursive: true, force: true })
    sh('mkdir', ['-p', values.out])
    sh('tar', ['-xf', join(tmp, `archive-${lock.kid}.tar`), '-C', values.out])
    await verifyDir(values.out, lock)
    await rm(tmp, { recursive: true, force: true })
    console.log(`verified ${Object.keys(lock.files).length} sealed files from ${lock.release}`)
    return
  }
  if (cmd === 'unseal') {
    const k = await key()
    const lock = JSON.parse(await readFile(values.lock, 'utf8'))
    if ((await deriveKeys(k)).kid !== lock.kid) throw new Error('key does not match archive.lock.json kid')
    await verifyDir(values.out, lock)
    const dest = positionals[1] ?? 'archive-export-restored'
    await unsealDir({ dir: values.out, rawKey: k, destDir: dest })
    console.log(`restored export into ${dest}`)
    return
  }
  console.log('usage: seal-archive.mjs keygen|audit|seal|fetch|unseal')
  process.exitCode = 2
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
