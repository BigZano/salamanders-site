import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, rm, unlink, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFixture, SENTINEL } from '../archive-fixture.mjs'
import { readExport, sealExport, verifyDir, unsealDir, readEnvKey } from './archive-seal.mjs'
import { keyFromBase64 } from '../../src/lib/archive/crypto.js'

let root, exp, out, key
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-'))
  exp = join(root, 'export')
  out = join(root, 'sealed')
  key = keyFromBase64((await writeFixture(exp)).key)
})

async function tree(dir, prefix = '') {
  const res = {}
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) Object.assign(res, await tree(p, `${prefix}${e.name}/`))
    else res[`${prefix}${e.name}`] = createHash('sha256').update(await readFile(p)).digest('hex')
  }
  return res
}

describe('seal → verify → unseal', () => {
  it('restores every export file byte-for-byte and never touches the input', async () => {
    const before = await tree(exp)
    const lock = await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    expect(await tree(exp)).toEqual(before)
    await verifyDir(out, lock)
    const restored = join(root, 'restored')
    await unsealDir({ dir: out, rawKey: key, destDir: restored })
    const want = Object.fromEntries(Object.entries(before).filter(([p]) => p !== '.env'))
    expect(await tree(restored)).toEqual(want)
  })

  it('carries a table-of-contents overlay in collections.json through seal and unseal', async () => {
    const meta = JSON.parse(await readFile(join(exp, 'collections.json'), 'utf8'))
    const ids = (await readdir(join(exp, 'accolades', 'data', 'threads'))).map((n) => n.replace('.json', ''))
    const other = ids.find((id) => id !== meta.accolades.tocThreadId)
    meta.accolades.toc = { insert: [{ after: meta.accolades.tocThreadId, thread: other }], hide: [other] }
    await writeFile(join(exp, 'collections.json'), JSON.stringify(meta, null, 2))
    expect((await readExport(exp)).index.collections.accolades.toc).toEqual(meta.accolades.toc)
    await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    const restored = join(root, 'restored')
    await unsealDir({ dir: out, rawKey: key, destDir: restored })
    expect(await readFile(join(restored, 'collections.json'), 'utf8')).toBe(JSON.stringify(meta, null, 2))
  })

  it('sealed output has opaque names only and contains no plaintext', async () => {
    const lock = await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    const names = await readdir(out)
    expect(names.every((n) => /^[0-9a-f]{32}\.bin$/.test(n))).toBe(true)
    expect(Object.keys(lock.files).sort()).toEqual(names.sort())
    for (const n of names) {
      const bytes = await readFile(join(out, n))
      const latin = bytes.toString('latin1')
      expect(latin.startsWith('LAR\u0001')).toBe(true)
      expect(latin).not.toContain(SENTINEL)
      expect(latin).not.toContain('\u0089PNG')
      expect(latin).not.toContain('GIF89a')
    }
  })

  it('refuses to seal while the audit has problems, listing them', async () => {
    const fixes = JSON.parse(await readFile(join(exp, 'link-fixes.json'), 'utf8'))
    for (const k of Object.keys(fixes)) delete fixes[k]
    await writeFile(join(exp, 'link-fixes.json'), JSON.stringify(fixes))
    await expect(sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })).rejects.toThrow(/unaccounted-link/)
    await expect(readdir(out)).rejects.toThrow() // nothing written
  })

  it.each([
    ['an asset whose bytes changed', async () => writeFile(join(exp, 'accolades/assets/emoji-fixture.png'), 'x')],
    ['an asset listed but missing', async () => unlink(join(exp, 'accolades/assets/emoji-tag.png'))],
    ['an unlisted extra asset', async () => writeFile(join(exp, 'accolades/assets/stray.png'), 'x')],
    ['missing collections.json', async () => unlink(join(exp, 'collections.json'))],
  ])('readExport rejects %s', async (_, damage) => {
    await damage()
    await expect(readExport(exp)).rejects.toThrow()
  })

  it.each([
    ['a missing file', async (lock) => unlink(join(out, Object.keys(lock.files)[0]))],
    ['an extra file', async () => writeFile(join(out, 'ffffffffffffffffffffffffffffffff.bin'), 'x')],
    ['a tampered file', async (lock) => {
      const p = join(out, Object.keys(lock.files)[0])
      const b = await readFile(p)
      b[b.length - 1] ^= 1
      await writeFile(p, b)
    }],
  ])('verifyDir rejects %s', async (_, damage) => {
    const lock = await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    await damage(lock)
    await expect(verifyDir(out, lock)).rejects.toThrow()
  })

  it('unseal with the wrong key fails without writing anything', async () => {
    await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    const dest = join(root, 'nope')
    await expect(unsealDir({ dir: out, rawKey: new Uint8Array(32), destDir: dest })).rejects.toThrow()
    await expect(readdir(dest)).rejects.toThrow()
  })

  it('refuses to overwrite a non-empty outDir that is not a previous sealed output', async () => {
    await writeFile(join(root, 'marker'), 'x')
    await expect(sealExport({ exportDir: exp, rawKey: key, outDir: root, now: new Date(0) })).rejects.toThrow(/refusing/)
  })

  it('readEnvKey parses ARCHIVE_KEY from an env file and rejects junk', async () => {
    expect(readEnvKey(`# c\nARCHIVE_KEY=${Buffer.from(key).toString('base64')}\n`)).toEqual(key)
    expect(() => readEnvKey('ARCHIVE_KEY=short')).toThrow()
    expect(() => readEnvKey('OTHER=1')).toThrow(/ARCHIVE_KEY/)
  })
})
