/**
 * Local Legion Archive preview with invented data: `bun run archive:dev:fixture`.
 *
 * For design work on any machine, with no archive key, no Discord and no real data: it seals the synthetic
 * fixture (the one the e2e stack uses) into the gitignored public/archive-e2e/ under a fresh throwaway key,
 * serves that key on 127.0.0.1 only, and starts Vite pointed at both. Pages: /accolades, /ranks and
 * /accolades/legacy. Sign in locally by faking a member in DevTools (see archive-dev-server.mjs for the line).
 * ARCHIVE_DEV_PORT overrides Vite's port (default 5173).
 *
 * If the docker e2e stack has run on this machine, e2e/.archive and public/archive-e2e may be root-owned and
 * this script cannot replace them; clear them first (see the e2e notes in docs/handoff).
 */
import { rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFixture } from './archive-fixture.mjs'
import { sealExport } from './lib/archive-seal.mjs'
import { keyToBase64 } from '../src/lib/archive/crypto.js'
import { createDevKeyHandler } from './archive-dev-server.mjs'

const PORT = 8799
const VITE_PORT = Number(process.env.ARCHIVE_DEV_PORT || 5173)
const WORK = 'e2e/.archive' // gitignored scratch, shared with the e2e stack
const OUT = 'public/archive-e2e' // gitignored; Vite serves public/ as-is

const rawKey = new Uint8Array(randomBytes(32))
await rm(WORK, { recursive: true, force: true })
await writeFixture(`${WORK}/export`)
const lock = await sealExport({ exportDir: `${WORK}/export`, rawKey, outDir: OUT })
await writeFile(`${WORK}/lock.json`, JSON.stringify(lock, null, 2))

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  fetch: createDevKeyHandler({ key: keyToBase64(rawKey), kid: lock.kid, origin: `http://localhost:${VITE_PORT}` }),
})
console.log(`fixture archive sealed (${Object.keys(lock.files).length} files); dev key server on http://127.0.0.1:${PORT} (local only)`)

const vite = spawn('bun', ['x', 'vite', '--port', String(VITE_PORT), '--strictPort'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    ARCHIVE_LOCK: `${WORK}/lock.json`,
    VITE_ARCHIVE_BASE: '/archive-e2e/',
    VITE_BUILDS_API_URL: `http://127.0.0.1:${PORT}`,
  },
})
vite.on('exit', (code) => process.exit(code ?? 0))
