// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DeathwatchShell from './DeathwatchShell.vue'

// The stylesheet itself is tested in deathwatch.css.test.js (plain Node, where the file can be read).
describe('DeathwatchShell', () => {
  it('renders its content inside the scoped .dw wrapper', () => {
    const w = mount(DeathwatchShell, { slots: { default: '<p class="inside">hello</p>' } })
    expect(w.classes()).toContain('dw')
    expect(w.find('.dw .inside').text()).toBe('hello')
  })

  it('has a decorative backdrop that assistive technology skips', () => {
    const w = mount(DeathwatchShell)
    const backdrop = w.find('.dw-backdrop')
    expect(backdrop.exists()).toBe(true)
    expect(backdrop.attributes('aria-hidden')).toBe('true')
    expect(backdrop.text()).toBe('')
  })
})
