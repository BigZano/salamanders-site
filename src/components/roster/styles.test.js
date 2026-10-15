import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { compileStyle } from '@vue/compiler-sfc'

// Unit tests do not process component CSS, so a bad stylesheet passes every
// behaviour test and only shows up on screen. These read the SFC styles directly.
const dir = new URL('./', import.meta.url)
// the roster pieces here, and the page and company pieces elsewhere that carry roster styles too
const outside = [
  ['Companies.vue', '../../views/Companies.vue'],
  ['CompanyArticle.vue', '../company/CompanyArticle.vue'],
  ['MusterSection.vue', '../company/MusterSection.vue'],
  ['RanksPlaceholder.vue', '../company/RanksPlaceholder.vue'],
].map(([name, path]) => [name, new URL(path, import.meta.url)])
const files = [...readdirSync(dir).filter((f) => f.endsWith('.vue')).map((f) => [f, new URL(f, dir)]), ...outside]
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

  it('head chips let clicks through to the stretched bar button', () => {
    // The button's ::after covers the whole bar. A chip raised above it (z-index) swallows the
    // tap, and on a phone the head row is most of the bar. pointer-events: none lets it through.
    const source = readFileSync(new URL('RosterBranch.vue', dir), 'utf8')
    const at = source.indexOf('.rs-head :deep(.rs-member)')
    expect(at, 'a rule for head chips').toBeGreaterThan(-1)
    const rule = source.slice(at, source.indexOf('}', at))
    expect(rule).toContain('pointer-events: none')
    expect(rule).not.toContain('z-index')
  })

  it('the open-state spine rules are present and keyed to the branch panel', () => {
    const ladder = readFileSync(new URL('RosterLadder.vue', dir), 'utf8')
    for (const sel of ['.rs-panel[data-open] .rs-step::before', '.rs-panel[data-open] .rs-node', '.rs-panel[data-open] .rs-lateral .rs-node']) {
      expect(ladder).toContain(sel)
    }
    expect(readFileSync(new URL('RosterBranch.vue', dir), 'utf8')).toContain('.rs-instant .rs-body')
  })
})
