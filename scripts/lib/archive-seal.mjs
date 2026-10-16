/** Legion Archive seal pipeline. Plaintext in → opaque ciphertext out; never mutates the export. */
import { readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { deriveKeys, seal, open, opaqueName, keyFromBase64 } from '../../src/lib/archive/crypto.js'
import { createArchive } from '../../src/lib/archive/model.js'
import { auditArchive } from '../../src/lib/archive/audit.js'
import { COLLECTIONS } from '../../src/lib/archive/registry.js'
import { LEGACY_FILE, canonicalLegacy } from '../../src/lib/archive/legacy.js'

const DATA_FILES = ['forum.json', 'index.json', 'links.json', 'resolve.json', 'assets.json']
const sha = (b) => createHash('sha256').update(b).digest('hex')
const enc = new TextEncoder()

export function readEnvKey(text) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('ARCHIVE_KEY='))
  if (!line) throw new Error('ARCHIVE_KEY not found in env file')
  return keyFromBase64(line.slice('ARCHIVE_KEY='.length).trim())
}

export async function readExport(exportDir) {
  const meta = JSON.parse(await readFile(join(exportDir, 'collections.json'), 'utf8'))
  const fixes = JSON.parse(await readFile(join(exportDir, 'link-fixes.json'), 'utf8'))
  const index = { format: 1, collections: {}, fixes }
  const assets = []
  for (const def of COLLECTIONS) {
    const base = join(exportDir, def.exportDir)
    const files = {}
    for (const f of DATA_FILES) files[f] = await readFile(join(base, 'data', f), 'utf8')
    for (const f of await readdir(join(base, 'data', 'threads'))) {
      files[`threads/${f}`] = await readFile(join(base, 'data', 'threads', f), 'utf8')
    }
    const listed = JSON.parse(files['assets.json'])
    const onDisk = new Set(await readdir(join(base, 'assets')))
    const done = new Set() // two CDN URLs may share one file; hash-check it once
    for (const entry of Object.values(listed)) {
      if (done.has(entry.file)) continue
      if (!onDisk.has(entry.file)) throw new Error(`${def.key}: asset ${entry.file} listed but missing`)
      const bytes = await readFile(join(base, 'assets', entry.file))
      if (sha(bytes) !== entry.sha256) throw new Error(`${def.key}: asset ${entry.file} does not match its sha256`)
      done.add(entry.file)
      onDisk.delete(entry.file)
      assets.push({ logicalPath: `${def.key}/assets/${entry.file}`, bytes: new Uint8Array(bytes) })
    }
    if (onDisk.size) throw new Error(`${def.key}: unlisted assets on disk: ${[...onDisk].join(', ')}`)
    if (!meta[def.key]?.tocThreadId) throw new Error(`collections.json has no tocThreadId for ${def.key}`)
    index.collections[def.key] = { tocThreadId: meta[def.key].tocThreadId, ...(meta[def.key].toc ? { toc: meta[def.key].toc } : {}), files }
  }
  const legacyText = await readFile(join(exportDir, LEGACY_FILE), 'utf8').catch((e) => {
    if (e.code === 'ENOENT') return null // no file: a bundle without legacy accolades
    throw e
  })
  if (legacyText !== null) {
    const legacy = JSON.parse(legacyText)
    // JSON `null` would read as "absent" downstream and quietly drop the page.
    if (legacy === null) throw new Error(`${LEGACY_FILE} must not be null`)
    index.legacy = legacy
  }
  return { index, assets }
}

async function prepareOut(outDir) {
  const existing = await readdir(outDir).catch(() => null)
  if (existing && existing.some((n) => !/^[0-9a-f]{32}\.bin$/.test(n))) {
    throw new Error(`refusing to write into ${outDir}: it contains non-archive files`)
  }
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
}

export async function sealExport({ exportDir, rawKey, outDir, now = new Date(), prevLock = null, dropLegacy = false }) {
  const { index, assets } = await readExport(exportDir)
  // Once a published bundle carried the legacy accolades, sealing without them would silently drop the page.
  if (prevLock?.legacy && !dropLegacy && !index.legacy) {
    throw new Error(`the last published archive carried the legacy accolades, but ${LEGACY_FILE} is missing from ${exportDir}: restore it (unseal) or pass --drop-legacy`)
  }
  const keys = await deriveKeys(rawKey)
  index.kid = keys.kid
  index.sealedAt = now.toISOString()
  const { problems } = auditArchive(createArchive(index))
  if (problems.length) {
    throw new Error(`archive audit failed (${problems.length}):\n` + problems.map((p) => `  ${p.kind} ${p.collectionKey ?? ''} ${p.threadId ?? ''} ${p.messageId ?? ''} ${p.detail}`).join('\n'))
  }
  await prepareOut(outDir)
  const files = {}
  const put = async (logicalPath, bytes) => {
    const name = `${await opaqueName(keys, logicalPath)}.bin`
    const sealed = await seal(keys, logicalPath, bytes)
    await writeFile(join(outDir, name), sealed)
    files[name] = sha(sealed)
  }
  await put('index', enc.encode(JSON.stringify(index)))
  for (const a of assets) await put(a.logicalPath, a.bytes)
  return { format: 1, kid: keys.kid, files, ...(index.legacy ? { legacy: true } : {}) }
}

export async function verifyDir(outDir, lock) {
  const names = new Set(await readdir(outDir))
  for (const [name, hash] of Object.entries(lock.files)) {
    if (!names.delete(name)) throw new Error(`sealed file missing: ${name}`)
    if (sha(await readFile(join(outDir, name))) !== hash) throw new Error(`sealed file hash mismatch: ${name}`)
  }
  if (names.size) throw new Error(`unexpected files in ${outDir}: ${[...names].join(', ')}`)
}

export async function unsealDir({ dir, rawKey, destDir }) {
  const keys = await deriveKeys(rawKey)
  const read = async (logicalPath) => open(keys, logicalPath, new Uint8Array(await readFile(join(dir, `${await opaqueName(keys, logicalPath)}.bin`))))
  const index = JSON.parse(new TextDecoder().decode(await read('index')))
  const writes = []
  for (const def of COLLECTIONS) {
    const col = index.collections[def.key]
    const base = join(destDir, def.exportDir)
    for (const [name, text] of Object.entries(col.files)) writes.push([join(base, 'data', name), enc.encode(text)])
    for (const entry of Object.values(JSON.parse(col.files['assets.json']))) {
      writes.push([join(base, 'assets', entry.file), await read(`${def.key}/assets/${entry.file}`)])
    }
  }
  writes.push([join(destDir, 'collections.json'), enc.encode(JSON.stringify(Object.fromEntries(
    Object.entries(index.collections).map(([k, c]) => [k, { tocThreadId: c.tocThreadId, ...(c.toc ? { toc: c.toc } : {}) }]),
  ), null, 2))])
  writes.push([join(destDir, 'link-fixes.json'), enc.encode(JSON.stringify(index.fixes, null, 2))])
  if (index.legacy) writes.push([join(destDir, LEGACY_FILE), enc.encode(canonicalLegacy(index.legacy))])
  // Everything decrypted and authenticated before the first byte is written.
  for (const [p, bytes] of writes) {
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, bytes)
  }
}
