import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Root-absolute: the site now lives at buildforge.armorybot.win's root,
  // not a GitHub-Pages-project subpath, and history-mode routing (see
  // router.js) needs an absolute base to match against location.pathname.
  // Override with SITE_BASE if that ever changes.
  base: process.env.SITE_BASE || '/',
  plugins: [vue(), tailwindcss()],
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
})
