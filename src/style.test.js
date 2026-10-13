import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')

const channel = (c) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

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
    const lava = [255, 176, 102]
    const alpha = Number(a)
    const blended = [r, g, b].map((c, i) => Number(c) * alpha + lava[i] * (1 - alpha))
    expect(contrast(blended, [195, 208, 198])).toBeGreaterThanOrEqual(4.5)
  })

  it('guards reduced motion without breaking transitionend', () => {
    const at = css.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(at).toBeGreaterThan(-1)
    const block = css.slice(at, at + 700)
    expect(block).toContain('animation-duration: 0.01ms !important')
    expect(block).toContain('transition-duration: 0.01ms !important')
    expect(block).toContain('animation-iteration-count: 1 !important')
    expect(block).toContain('scroll-behavior: auto !important')
  })
})
