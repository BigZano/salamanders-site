import { describe, it, expect } from 'vitest'
import source from './DeathwatchArea.vue?raw'

// jsdom lays nothing out, so the wide-screen rail is held by its rules: the measured widths (892px at every window
// from 1500 to 2560px, the view centred from 1640px) are in the PR.
const style = source.slice(source.indexOf('<style'))
const rule = (selector, at = 0) => {
  const from = style.indexOf(`${selector} {`, at)
  return from < 0 ? '' : style.slice(from, style.indexOf('}', from))
}
const rem = (decl, css) => css.match(new RegExp(`${decl}:\\s*([^;]+);`))?.[1].trim()

describe('the wide-screen rail', () => {
  const wide = style.indexOf('@media (min-width: 1640px)')

  it('docks the rail at the left edge from 1640px, with an empty column the rail\'s width on the right', () => {
    expect(wide).toBeGreaterThan(0)
    const area = rule('.dw-area', wide)
    expect(rem('grid-template-columns', area)).toBe('18.75rem minmax(0, 1fr) 18.75rem')
    expect(rem('max-width', area)).toBe('none')
    expect(rule('.dw-area-main', wide)).toContain('justify-self: center')
  })

  // The view must not narrow or widen across the step: its cap is the width it has in the two-column layout below.
  it('keeps the view as wide as below the step', () => {
    const narrow = style.indexOf('@media (min-width: 900px)')
    const base = rule('.dw-area')
    const twoColumns = rule('.dw-area', narrow)
    expect(rem('max-width', base)).toBe('78rem')
    expect(rem('padding', base)).toMatch(/^\S+ 1rem /)
    expect(rem('grid-template-columns', twoColumns)).toBe('18.75rem minmax(0, 1fr)')
    expect(rem('gap', twoColumns)).toBe('1.5rem')
    expect(rem('max-width', rule('.dw-area-main', wide))).toBe('calc(78rem - 2rem - 18.75rem - 1.5rem)')
  })
})
