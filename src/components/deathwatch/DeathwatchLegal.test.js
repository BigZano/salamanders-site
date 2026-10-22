// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DeathwatchLegal from './DeathwatchLegal.vue'

describe('DeathwatchLegal', () => {
  it("is the original site's fan-site disclaimer, word for word", () => {
    const w = mount(DeathwatchLegal)
    expect(w.classes()).toContain('dw-legal')
    expect(w.text()).toContain('© 2026 Watch Fortress Ebonhold · A fan-run page for Warhammer 40,000: Space Marine 2.')
    expect(w.text()).toContain(
      'Not affiliated with or endorsed by Games Workshop or Focus Entertainment. Warhammer 40,000, Space Marine and all associated marks are trademarks of Games Workshop Ltd.',
    )
  })

  it('keeps the two sentences on separate lines', () => {
    const w = mount(DeathwatchLegal)
    expect(w.findAll('br')).toHaveLength(1)
    expect(w.element.innerHTML.indexOf('Space Marine 2.')).toBeLessThan(w.element.innerHTML.indexOf('<br'))
  })

  it('is plain text: no link, no landmark of its own (the site has the page footer)', () => {
    const w = mount(DeathwatchLegal)
    expect(w.element.tagName).toBe('P')
    expect(w.findAll('a')).toHaveLength(0)
  })
})
