import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
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

  it('stops the page scrolling behind an open bottom sheet, and only then', () => {
    expect(css).toMatch(/body:has\(\.dw-sheet\[open\]\)\s*\{[^}]*overflow:\s*hidden/)
  })

  it('defines the HUD fonts and the frame textures the original used', () => {
    expect(token('font-hud')).toMatch(/^'Teko Variable'/)
    expect(token('font-body')).toMatch(/^'Barlow'/)
    expect(token('font-cond')).toMatch(/^'Barlow Condensed'/)
    for (const name of ['frame', 'frame-s', 'grain', 'scan']) expect(token(name), name).toBeTruthy()
    // the green of the frame is the accent, URL-encoded
    expect(token('frame')).toContain('stroke=\'%237fd35c\'')
  })

  it('has the panel, plaque and button classes', () => {
    for (const cls of ['dw-panel', 'dw-plaque', 'dw-btn']) {
      expect(css, cls).toMatch(new RegExp(`\\.${cls}\\s*\\{`))
    }
    // the panel and the plaque are drawn with the 9-slice frames, never a plain border
    expect(css.match(/\.dw-panel\s*\{([^}]*)\}/)?.[1]).toContain('border-image: var(--dw-frame)')
    expect(css.match(/\.dw-plaque\s*\{([^}]*)\}/)?.[1]).toContain('border-image: var(--dw-frame-s)')
  })

  it('shows the keyboard focus ring of a button inside its clipped corners (an outline outside them is cut off)', () => {
    const rule = css.match(/\.dw-btn:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/outline:\s*2px solid var\(--dw-accent\)/)
    expect(rule).toMatch(/outline-offset:\s*-6px/)
  })

  it('paints a backdrop for the hub and each area, from images that exist', () => {
    const files = {
      hub: 'bg-hub.jpg',
      eventtracker: 'bg-tracker.webp',
      armouringhall: 'bg-armouring.jpg',
      chronicles: 'bg-chronicles.webp',
      hallofrelics: 'card-relics.webp',
      manage: 'bg-manage.jpg',
    }
    for (const [area, file] of Object.entries(files)) {
      const rule = css.match(new RegExp(`\\.dw\\[data-area='${area}'\\]\\s+\\.dw-backdrop::after\\s*\\{([^}]*)\\}`))?.[1] ?? ''
      expect(rule, area).toContain(`url('./img/${file}')`)
      expect(existsSync(new URL(`./img/${file}`, import.meta.url)), file).toBe(true)
    }
  })

  it('pulses the skeleton bars with opacity only, and not at all under reduced motion', () => {
    expect(css.match(/\.dw-sk-bar\s*\{([^}]*)\}/)?.[1]).toContain('animation: dw-pulse')
    const body = css.match(/@keyframes dw-pulse\s*\{([\s\S]*?\n\})/)?.[1] ?? ''
    expect(body).not.toBe('')
    for (const p of [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])) expect(p).toBe('opacity')
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\n\})/)?.[1] ?? ''
    expect(reduced).toMatch(/\.dw-sk-bar\s*\{[^}]*animation:\s*none/)
  })

  it('drifts and flickers the backdrop with transform and opacity only, and not at all under reduced motion', () => {
    for (const name of ['dw-drift', 'dw-flicker']) {
      const body = css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?\\n\\})`))?.[1] ?? ''
      expect(body, name).not.toBe('')
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
      for (const p of props) expect(['transform', 'opacity'], `${name} ${p}`).toContain(p)
    }
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\n\})/)?.[1] ?? ''
    expect(reduced).toMatch(/\.dw-backdrop::after\s*\{[^}]*animation:\s*none/)
  })

  it('lets the volcano show through the backdrop', () => {
    // An opaque backdrop would hide the site's fire (and the sparks); it must stay translucent.
    const rule = css.match(/\.dw-backdrop\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('position: fixed')
    expect(rule).toMatch(/rgba\(6, 9, 6, 0\.\d+\)/)
  })
})
