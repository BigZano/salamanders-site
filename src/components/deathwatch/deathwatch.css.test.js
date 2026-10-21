import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { contrast } from '../../test-utils/contrast'

const css = readFileSync(new URL('./deathwatch.css', import.meta.url), 'utf8')
const token = (name) => css.match(new RegExp(`--dw-${name}:\\s*([^;]+);`))?.[1].trim()
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

describe('deathwatch.css', () => {
  it('defines the Deathwatch tokens, on .dw and not on the whole page', () => {
    const expected = {
      bg: '#060906',
      surface: '#0b110c',
      'surface-2': '#111a12',
      ink: '#e2ecdc',
      muted: '#83978a',
      line: '#1a2b1c',
      'line-2': '#2a4a2d',
      accent: '#7fd35c',
      'accent-ink': '#041004',
      silver: '#c3ccd5',
      gold: '#e0b43c',
      down: '#e5736a',
      up: '#5fcf8b',
      'font-title': "'Cinzel Variable', 'Cinzel', Georgia, serif",
    }
    for (const [name, value] of Object.entries(expected)) expect(token(name), name).toBe(value)
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '') // the rules, without the comments that explain them
    expect(rules).toMatch(/\.dw\s*\{/)
    expect(rules).not.toContain(':root')
    expect(rules).not.toMatch(/(^|\})\s*(html|body|\*)\s*[,{]/)
  })

  it('keeps every text colour readable on the surface (4.5:1)', () => {
    for (const name of ['ink', 'muted', 'silver', 'gold', 'down', 'up', 'accent']) {
      expect(contrast(rgb(token(name)), rgb(token('surface'))), name).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(rgb(token('ink')), rgb(token('surface-2')))).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the dark ink readable on the accent (4.5:1)', () => {
    expect(contrast(rgb(token('accent-ink')), rgb(token('accent')))).toBeGreaterThanOrEqual(4.5)
  })

  it('lets the volcano show through the backdrop', () => {
    // An opaque backdrop would hide the site's fire (and the sparks); it must stay translucent.
    const rule = css.match(/\.dw-backdrop\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('position: fixed')
    expect(rule).toMatch(/rgba\(6, 9, 6, 0\.\d+\)/)
  })
})
