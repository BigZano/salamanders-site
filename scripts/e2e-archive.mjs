/** e2e only: synthetic fixture → sealed into public/archive-e2e/ with E2E_ARCHIVE_KEY. */
import { rm, writeFile } from 'node:fs/promises'
import { writeFixture } from './archive-fixture.mjs'
import { sealExport, readEnvKey } from './lib/archive-seal.mjs'

const rawKey = readEnvKey(`ARCHIVE_KEY=${process.env.E2E_ARCHIVE_KEY}`)
await rm('e2e/.archive', { recursive: true, force: true })
await writeFixture('e2e/.archive/export')
const lock = await sealExport({ exportDir: 'e2e/.archive/export', rawKey, outDir: 'public/archive-e2e' })
await writeFile('e2e/.archive/lock.json', JSON.stringify(lock, null, 2))
console.log(`e2e archive sealed: ${Object.keys(lock.files).length} files, kid ${lock.kid}`)
