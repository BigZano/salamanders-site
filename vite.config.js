import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readFileSync } from 'node:fs'
import { cspMetaPlugin } from './scripts/csp.mjs'

// Legion Archive: only the key id travels in the bundle (to detect a
// stale page), never the key. ARCHIVE_LOCK / VITE_ARCHIVE_BASE let the
// e2e stack point at its own throwaway sealed fixture.
const lockPath = process.env.ARCHIVE_LOCK || 'archive.lock.json'
const archiveLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // Root-absolute: the site now lives at sm2salamanders.site's root,
  // not a GitHub-Pages-project subpath, and history-mode routing (see
  // router.js) needs an absolute base to match against location.pathname.
  // Override with SITE_BASE if that ever changes.
  base: process.env.SITE_BASE || '/',
  // The Content-Security-Policy (scripts/csp.mjs), added to the built index.html only. The builds API is the one origin
  // the policy takes from the environment: it is a deploy setting (see buildsApi.js).
  plugins: [vue(), tailwindcss(), cspMetaPlugin({ apiUrl: loadEnv(mode, process.cwd(), 'VITE_').VITE_BUILDS_API_URL })],
  define: {
    __ARCHIVE_KID__: JSON.stringify(archiveLock?.kid ?? null),
    __ARCHIVE_BASE__: JSON.stringify(process.env.VITE_ARCHIVE_BASE || '/archive/'),
    // The release tag versions archive URLs: sealed files keep their names across releases,
    // and Pages caches them for 10 minutes, so without it a fresh deploy can serve the old one.
    __ARCHIVE_RELEASE__: JSON.stringify(archiveLock?.release ?? null),
  },
  server: {
    // Vite's dev server rejects requests whose Host header isn't localhost
    // by default (DNS-rebinding protection). Only the e2e/ stack needs this
    // — the browser there reaches this server via its Docker service name
    // ("web"), not localhost — so it's opt-in via env var, unset for every
    // normal `bun run dev`.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',')
      : undefined,
  },
}))
