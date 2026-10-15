import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TEXT, contrast, over } from './test-utils/contrast'

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')

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
