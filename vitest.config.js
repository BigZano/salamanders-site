import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

const FULL = { lines: 100, branches: 100, functions: 100, statements: 100 }
const GATED = [
  'src/lib/archive/crypto.js',
  'src/lib/archive/links.js',
  'src/lib/archive/markdown.js',
  'src/lib/archive/audit.js',
  'server/src/archiveKey.js',
]

export default defineConfig({
  // Archive components are .vue SFCs (src/components/archive/archive.test.js).
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'scripts/**/*.test.mjs', 'server/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: GATED,
      thresholds: Object.fromEntries(GATED.map((f) => [f, FULL])),
    },
  },
})
