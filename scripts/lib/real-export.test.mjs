/**
 * Local-only guarantees against the real, gitignored export. Skipped in CI
 * (where archive-export/ never exists). Never prints content.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, readdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readExport, sealExport, unsealDir, readEnvKey } from './archive-seal.mjs'
import { createArchive } from '../../src/lib/archive/model.js'
import { auditArchive } from '../../src/lib/archive/audit.js'
import { parse, plainText } from '../../src/lib/archive/markdown.js'

const EXPORT = 'archive-export'
const present = existsSync(join(EXPORT, '.env'))
const sha = (b) => createHash('sha256').update(b).digest('hex')

async function hashTree(dir, prefix = '') {
  const out = {}
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (prefix === '' && (e.name === '.env' || e.name === 'link-fixes.json' || e.name === 'collections.json')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) Object.assign(out, await hashTree(p, `${prefix}${e.name}/`))
    else out[`${prefix}${e.name}`] = [sha(await readFile(p)), (await stat(p)).mtimeMs]
  }
  return out
}

describe.skipIf(!present)('real export (local only)', () => {
  it('audits clean: every link, mention, emoji, and attachment accounted for', async () => {
    const { index } = await readExport(EXPORT)
    const { problems } = auditArchive(createArchive(index))
    expect(problems.map((p) => `${p.kind} ${p.threadId}/${p.messageId}`)).toEqual([])
  })

  it('every message keeps every letter and digit through the parser', async () => {
    const { index } = await readExport(EXPORT)
    const alnum = (s) => s.replace(/[^\p{L}\p{N}]/gu, '')
    for (const col of Object.values(index.collections)) {
      for (const [name, text] of Object.entries(col.files)) {
        if (!name.startsWith('threads/')) continue
        for (const m of JSON.parse(text).messages) {
          const s = m.content ?? ''
          expect(alnum(plainText(parse(s), { raw: true })), `message ${m.id}`).toBe(alnum(s))
        }
      }
    }
  })

  it('seal → unseal reproduces the export byte-for-byte and leaves inputs untouched (hash + mtime)', async () => {
    const before = await hashTree(EXPORT)
    const tmp = await mkdtemp(join(tmpdir(), 'real-archive-'))
    try {
      const key = readEnvKey(await readFile(join(EXPORT, '.env'), 'utf8'))
      await sealExport({ exportDir: EXPORT, rawKey: key, outDir: join(tmp, 'out') })
      await unsealDir({ dir: join(tmp, 'out'), rawKey: key, destDir: join(tmp, 'restored') })
      const restored = await hashTree(join(tmp, 'restored'))
      const strip = (t) => Object.fromEntries(Object.entries(t).map(([k, [h]]) => [k, h]))
      expect(strip(restored)).toEqual(strip(before))
      expect(await hashTree(EXPORT)).toEqual(before)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})
