import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

// The hall's two stylesheets are imported unscoped (review of #53): every rule must sit under .dw, or it reaches the
// whole site once the hall's chunk has loaded. Keyframe steps are not selectors.
const selectors = (name) => {
  const css = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')
  const out = []
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
    out.push(...rule.selectors)
  })
  return out
}

describe.each(['armour.css', 'armour-view.css'])('%s', (name) => {
  it('puts every rule under .dw', () => {
    const all = selectors(name)
    expect(all.length).toBeGreaterThan(0)
    expect(all.filter((s) => !s.startsWith('.dw '))).toEqual([])
  })
})
