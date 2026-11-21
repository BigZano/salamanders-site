import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The maintainer's merge gate. Its order matters: the build, and the check of the policy in it, are quick and run first, so a
// bad policy is found before the slower suite and coverage runs; and the one dist they make is what the archive scan reads.
// Mutation testing is not part of it: it runs once, when a piece of work is finished, on the lines that work changed
// (scripts/mutation-changed.mjs).
const hook = readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8')
const lines = hook.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
const at = (text) => lines.findIndex((line) => line.includes(text))

describe('pre-push hook', () => {
  it('builds and checks the Content-Security-Policy before it runs the tests and the coverage', () => {
    const check = at('node scripts/check-csp.mjs dist')
    expect(check).toBeGreaterThan(-1)
    expect(lines[check]).toMatch(/bun run build.*&&.*node scripts\/check-csp\.mjs dist.*\|\|\s*exit 1/)
    for (const slow of ['bun run test', 'bun run test:coverage']) {
      expect(at(slow)).toBeGreaterThan(-1)
      expect(check).toBeLessThan(at(slow))
    }
  })

  it('runs no mutation testing', () => {
    expect(lines.filter((line) => /mutation|stryker/i.test(line))).toEqual([])
  })

  it('builds once: the archive scan reads the dist the policy check read', () => {
    expect(hook.match(/bun run build/g)).toHaveLength(1)
    const scan = lines.find((line) => line.includes('scan-dist.mjs'))
    expect(scan).toBeDefined()
    expect(scan).toContain('--sentinels-from archive-export')
    expect(scan).toMatch(/\|\| exit 1/)
    expect(at('scan-dist.mjs')).toBeGreaterThan(at('node scripts/check-csp.mjs dist'))
  })

  it('still scans only where the plaintext export is', () => {
    expect(hook).toMatch(/if \[ -d archive-export \]; then[\s\S]*scan-dist\.mjs[\s\S]*fi/)
  })

  it('stops at the first failure', () => {
    for (const run of lines.filter((line) => /^(bun run|node scripts)/.test(line.trim()))) expect(run).toMatch(/\|\| exit 1$/)
  })
})
