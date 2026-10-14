import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { compileStyle } from '@vue/compiler-sfc'

// Unit tests do not process component CSS, so a bad stylesheet passes every
// behaviour test and only shows up on screen. These read the SFC styles directly.
const dir = new URL('./', import.meta.url)
const files = [...readdirSync(dir).filter((f) => f.endsWith('.vue')).map((f) => [f, new URL(f, dir)]), ['Roster.vue', new URL('../../views/Roster.vue', import.meta.url)]]
const styleBlocks = (source) => [...source.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)].map((m) => ({ scoped: /\bscoped\b/.test(m[1]), css: m[2] }))

describe('roster styles', () => {
  it.each(files)('%s never puts a selector after :global() in a scoped block', (name, url) => {
    // Vue's scoped compiler drops everything after :global(...): `:global([data-open]) .rs-node`
    // became a bare `[data-open] { transform: rotate(45deg) ... }` and rotated every open panel.
    for (const { scoped, css } of styleBlocks(readFileSync(url, 'utf8'))) {
      if (scoped) expect(css, name).not.toMatch(/:global\([^)]*\)\s*[.#\[a-zA-Z>+~]/)
    }
  })

  it.each(files)('%s keeps every compiled scoped rule tied to a class or element, never a bare attribute selector', (name, url) => {
    for (const { scoped, css } of styleBlocks(readFileSync(url, 'utf8'))) {
      if (!scoped) continue
      const { code, errors } = compileStyle({ source: css, filename: name, id: 'data-v-test', scoped: true })
      expect(errors, name).toEqual([])
      const selectors = [...code.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim())
      for (const sel of selectors) expect(sel, `${name}: ${sel}`).not.toMatch(/^\[[\w-]+(=[^\]]*)?\]$/)
    }
  })

  it('the open-state spine rules are present and keyed to the branch panel', () => {
    const ladder = readFileSync(new URL('RosterLadder.vue', dir), 'utf8')
    for (const sel of ['.rs-panel[data-open] .rs-step::before', '.rs-panel[data-open] .rs-node', '.rs-panel[data-open] .rs-lateral .rs-node']) {
      expect(ladder).toContain(sel)
    }
    expect(readFileSync(new URL('RosterBranch.vue', dir), 'utf8')).toContain('.rs-instant .rs-body')
  })
})
