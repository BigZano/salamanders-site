/**
 * Local Legion Archive preview: `bun run archive:dev`.
 *
 * The real builds API only answers the production origin and needs a real
 * Discord sign-in, so local design work can't use it. This serves the key
 * from the gitignored archive-export/.env on 127.0.0.1 only, and starts Vite
 * pointed at it. Sign in locally by faking a member in DevTools:
 *   localStorage.setItem('salamanders-discord-member', JSON.stringify({ id: '1', username: 'dev',
 *     isMember: true, checkedAt: Date.now(), accessToken: 'dev', expiresAt: Date.now() + 864e5 }))
 * ARCHIVE_DEV_PORT overrides Vite's port (default 5173).
 * Needs public/archive/ (the sealed files: `bun run archive fetch`) matching
 * archive.lock.json, and the key that sealed them.
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readEnvKey } from './lib/archive-seal.mjs'
import { deriveKeys, keyToBase64 } from '../src/lib/archive/crypto.js'

export function createDevKeyHandler({ key, kid, origin }) {
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Cache-Control': 'no-store',
  }
  return (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const path = new URL(request.url).pathname
    if (path === '/archive/key') return Response.json({ key, kid }, { headers })
    if (path === '/builds') return Response.json([], { headers })
    return new Response('Not found', { status: 404, headers })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = 8799
  const VITE_PORT = Number(process.env.ARCHIVE_DEV_PORT || 5173)
  const raw = readEnvKey(readFileSync('archive-export/.env', 'utf8'))
  const { kid } = await deriveKeys(raw)
  const lock = JSON.parse(readFileSync('archive.lock.json', 'utf8'))
  if (lock.kid !== kid) {
    console.error(`archive-export/.env key (kid ${kid}) doesn't match archive.lock.json (kid ${lock.kid}) — pages would say "out of date".`)
    process.exit(1)
  }
  Bun.serve({ hostname: '127.0.0.1', port: PORT, fetch: createDevKeyHandler({ key: keyToBase64(raw), kid, origin: `http://localhost:${VITE_PORT}` }) })
  console.log(`archive dev key server on http://127.0.0.1:${PORT} (local only)`)
  const vite = spawn('bun', ['x', 'vite', '--port', String(VITE_PORT), '--strictPort'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, VITE_BUILDS_API_URL: `http://127.0.0.1:${PORT}` },
  })
  vite.on('exit', (code) => process.exit(code ?? 0))
}
