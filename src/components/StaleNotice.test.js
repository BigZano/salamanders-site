// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StaleNotice from './StaleNotice.vue'

const replaced = { kind: 'replaced', level: 9, was: 'Signal Jammer', now: 'Tactical Reserve' }
const reworked = { kind: 'reworked', level: 25, was: 'Marked for Death', now: 'Marked for Death', note: 'Now weakens one enemy' }
const prestige = { kind: 'replaced', level: null, was: 'Exigency Charge', now: 'Passive Chambering' }

describe('StaleNotice', () => {
  it('renders nothing without notices', () => {
    expect(mount(StaleNotice, { props: { notices: [] } }).find('.stale-notice').exists()).toBe(false)
  })

  it('lists each notice and counts the replaced perks in the heading', () => {
    const w = mount(StaleNotice, { props: { notices: [replaced, reworked] } })
    expect(w.findAll('.stale-item')).toHaveLength(2)
    expect(w.find('.stale-head').text()).toContain('re-pick 1 perk')
    expect(w.find('.stale-head').text()).not.toContain('perks')
    const first = w.findAll('.stale-item')[0].text()
    expect(first).toContain('Signal Jammer')
    expect(first).toContain('Tactical Reserve')
    expect(w.findAll('.stale-item')[1].text()).toContain('Now weakens one enemy')
  })

  it('pluralises, and labels a prestige pick', () => {
    const w = mount(StaleNotice, { props: { notices: [replaced, prestige] } })
    expect(w.find('.stale-head').text()).toContain('re-pick 2 perks')
    expect(w.findAll('.stale-item')[1].text()).toContain('Prestige')
  })

  it('does not tie the heading to one patch, since the notices can come from any perk change', () => {
    const head = mount(StaleNotice, { props: { notices: [replaced] } }).find('.stale-head').text()
    expect(head).toContain('Perks changed')
    expect(head).not.toMatch(/patch/i)
  })

  it('only says perks were removed when some were', () => {
    expect(mount(StaleNotice, { props: { notices: [replaced] } }).find('.stale-lead').text()).toContain('removed')
    expect(mount(StaleNotice, { props: { notices: [reworked] } }).find('.stale-lead').text()).not.toContain('removed')
  })

  it('asks for a review, not a re-pick, when only reworked perks are flagged', () => {
    const head = mount(StaleNotice, { props: { notices: [reworked] } }).find('.stale-head').text()
    expect(head).not.toContain('re-pick')
    expect(head).toContain('review 1 perk')
  })

  it('shows what a moved perk replaced, via the note', () => {
    const w = mount(StaleNotice, { props: { notices: [{ ...replaced, level: 6, was: 'Vital Data', now: 'Improved Efficiency', note: 'Vital Data moved to level 8' }] } })
    expect(w.text()).toContain('Vital Data moved to level 8')
  })

  it('emits dismiss', async () => {
    const w = mount(StaleNotice, { props: { notices: [replaced] } })
    await w.find('.stale-dismiss').trigger('click')
    expect(w.emitted('dismiss')).toHaveLength(1)
  })
})
