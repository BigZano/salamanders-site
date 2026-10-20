import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TEXT, contrast, over } from './test-utils/contrast'

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
// The declarations of the `body { … }` rule (not body::before).
const bodyRule = () => css.match(/\n\s*body\s*\{([^}]*)\}/)?.[1] ?? ''

describe('style.css', () => {
  it('defines the roster tokens', () => {
    expect(css).toContain('--color-whitehot: #f2d27a;')
    expect(css).toContain('--color-vacant: #ff9a7a;')
    expect(css).toContain('--ease-forge: cubic-bezier(0.2, 0.8, 0.2, 1);')
  })

  it('.surface keeps body text readable over the brightest lava', () => {
    const rule = css.match(/\.surface\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    const [, r, g, b, a] = rule[1].match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)
    expect(contrast(over([r, g, b], Number(a)), TEXT)).toBeGreaterThanOrEqual(4.5)
  })

  it('guards reduced motion without breaking transitionend', () => {
    const at = css.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(at).toBeGreaterThan(-1)
    const block = css.slice(at, at + 700)
    expect(block).toContain('animation-duration: 0.01ms !important')
    expect(block).toContain('transition-duration: 0.01ms !important')
    expect(block).toContain('animation-iteration-count: 1 !important')
    expect(block).toContain('scroll-behavior: auto !important')
    // a staggered pour is delays, not durations: with delays left in, ranks still light one by one
    expect(block).toContain('transition-delay: 0s !important')
    expect(block).toContain('animation-delay: 0s !important')
  })
})

// The platform layer that makes the site feel installed on a phone (see docs/handoff/2026-10-20-mobile-baseline.md).
describe('mobile baseline', () => {
  it('lets the page paint under the notch', () => {
    // Fails if viewport-fit=cover is dropped from the viewport meta.
    const content = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/)?.[1]
    expect(content).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover')
  })

  it('never disables zoom', () => {
    // Fails if someone "fixes" input zoom with user-scalable=no or maximum-scale instead of a 16px field.
    expect(html).not.toContain('user-scalable')
    expect(html).not.toContain('maximum-scale')
  })

  it('removes the tap flash and font inflation', () => {
    expect(css).toContain('-webkit-tap-highlight-color: transparent;')
    expect(css).toContain('-webkit-text-size-adjust: 100%;')
  })

  it('makes controls tap immediately', () => {
    const rule = css.match(/button,\s*a,\s*\[role='button'\]\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule[1]).toContain('touch-action: manipulation;')
  })

  it('keeps text fields at 16px on touch screens', () => {
    // Below 16px iOS zooms the page on focus and does not zoom back out.
    const at = css.indexOf('@media (pointer: coarse)')
    expect(at).toBeGreaterThan(-1)
    expect(css.slice(at)).toMatch(/input[^{]*textarea[^{]*select[^{]*\{[^}]*font-size:\s*16px/)
  })

  it('pads for the notch and home indicator', () => {
    // viewport-fit=cover alone would slide content under the notch in landscape.
    const body = bodyRule()
    expect(body).toContain('env(safe-area-inset-left, 0px)')
    expect(body).toContain('env(safe-area-inset-right, 0px)')
    expect(body).toContain('env(safe-area-inset-bottom, 0px)')
  })

  it('keeps bottom toasts clear of the home indicator', () => {
    // A toast anchored 1.4rem from the bottom would sit in the indicator's zone once the page paints under it.
    for (const view of ['Armoury', 'Builds', 'Planner']) {
      const src = readFileSync(new URL(`./views/${view}.vue`, import.meta.url), 'utf8')
      const toast = src.match(/\.toast\s*\{([^}]*)\}/)?.[1] ?? ''
      expect(toast, view).toContain('bottom: calc(1.4rem + env(safe-area-inset-bottom, 0px))')
    }
  })

  it('leaves pull-to-refresh and text selection alone', () => {
    expect(css).not.toContain('overscroll-behavior: none')
    expect(bodyRule()).not.toContain('user-select: none')
  })
})
