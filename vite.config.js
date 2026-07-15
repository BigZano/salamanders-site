import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the build runs at any GitHub Pages path (user or project
  // site) with no config. Override with SITE_BASE for a fixed domain/subpath.
  base: process.env.SITE_BASE || './',
  plugins: [vue(), tailwindcss()],
})
