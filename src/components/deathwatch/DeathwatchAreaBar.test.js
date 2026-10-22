// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import DeathwatchAreaBar from './DeathwatchAreaBar.vue'

const mountBar = (props = {}) => mount(DeathwatchAreaBar, { props: { areaLabel: 'Event Tracker', tabLabel: 'Players', open: false, ...props } })

describe('DeathwatchAreaBar', () => {
  it('says where you are: the area and the view that is open', () => {
    const w = mountBar()
    expect(w.text()).toContain('Event Tracker')
    expect(w.text()).toContain('Players')
  })

  it('is a button that opens a dialog, and says whether it is open', async () => {
    const w = mountBar()
    const button = w.find('button')
    expect(button.classes()).toContain('dw-areabar')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-haspopup')).toBe('dialog')
    expect(button.attributes('aria-expanded')).toBe('false')
    await w.setProps({ open: true })
    expect(button.attributes('aria-expanded')).toBe('true')
  })

  it('asks to open when pressed', async () => {
    const w = mountBar()
    await w.find('button').trigger('click')
    expect(w.emitted('open')).toHaveLength(1)
  })

  it('shows its keyboard focus ring inside its clipped corners (an outline outside them is cut off)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.vue'), 'utf8')
    const rule = src.match(/\.dw-areabar:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/outline:\s*2px solid var\(--dw-accent\)/)
    expect(rule).toMatch(/outline-offset:\s*-6px/)
  })

  it('hides its chevron from assistive technology', () => {
    expect(mountBar().find('[aria-hidden="true"]').exists()).toBe(true)
  })
})
