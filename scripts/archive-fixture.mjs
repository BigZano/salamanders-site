/**
 * Writes a synthetic, content-free Legion Archive export for tests and e2e.
 * Shaped like the real exporter's output; never contains real data.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { makeIndex, IDS } from '../src/lib/archive/testIndex.js'

export const SENTINEL = 'FIXTURE-PLAINTEXT-SENTINEL'
// 1x1 PNG and 1x1 GIF, real image bytes so magic-byte scanners see them.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')

export async function writeFixture(dir) {
  const index = makeIndex()
  // Plant the sentinel in visible content of both collections.
  for (const key of ['accolades', 'ranks']) {
    const toc = index.collections[key].tocThreadId
    const f = `threads/${toc}.json`
    const t = JSON.parse(index.collections[key].files[f])
    // As a live link label: the ToC view shows only live links.
    t.messages[t.messages.length - 1].content += `\n[${SENTINEL}-${key}](https://discord.com/channels/${IDS.GUILD}/${toc})`
    index.collections[key].files[f] = JSON.stringify(t)
  }
  const exportDirs = { accolades: 'accolades', ranks: 'rank-requirements' }
  for (const [key, col] of Object.entries(index.collections)) {
    const base = join(dir, exportDirs[key])
    await mkdir(join(base, 'data', 'threads'), { recursive: true })
    await mkdir(join(base, 'assets'), { recursive: true })
    const assets = JSON.parse(col.files['assets.json'])
    for (const entry of Object.values(assets)) {
      const bytes = entry.file.endsWith('.gif') ? GIF : PNG
      entry.sha256 = createHash('sha256').update(bytes).digest('hex')
      entry.bytes = bytes.length
      await writeFile(join(base, 'assets', entry.file), bytes)
    }
    col.files['assets.json'] = JSON.stringify(assets, null, 1)
    for (const [name, text] of Object.entries(col.files)) await writeFile(join(base, 'data', name), text)
  }
  await writeFile(join(dir, 'collections.json'), JSON.stringify({
    accolades: { tocThreadId: index.collections.accolades.tocThreadId },
    ranks: { tocThreadId: index.collections.ranks.tocThreadId },
  }, null, 2))
  await writeFile(join(dir, 'link-fixes.json'), JSON.stringify(index.fixes, null, 2))
  const key = randomBytes(32).toString('base64')
  await writeFile(join(dir, '.env'), `ARCHIVE_KEY=${key}\n`)
  return { key, ids: IDS }
}
