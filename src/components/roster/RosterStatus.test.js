// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RosterStatus from './RosterStatus.vue'

const summary = (over = {}) => ({ total: 142, vacant: ['company-6'], acting: ['company-2'], mismatch: ['company-3'], ...over })
const render = (props = {}) =>
  mount(RosterStatus, { props: { summary: summary(), updated: '4:00 PM', stale: false, openable: true, allOpen: false, canInfirmary: false, infirmaryOpen: false, message: '', ...props } })
const link = (w, text) => w.findAll('.rs-status button').find((b) => b.text().includes(text))

describe('RosterStatus: the status line', () => {
  it('says how many are on the roll', () => {
    expect(render().find('.rs-status').text()).toContain('142 on the roll')
  })

  it('pluralises each gap', () => {
    const one = render().find('.rs-status').text()
    expect(one).toContain('1 vacant post')
    expect(one).toContain('1 acting head')
    expect(one).toContain('1 branch with a name to check')
    const many = render({ summary: summary({ vacant: ['a', 'b'], acting: ['a', 'b', 'c'], mismatch: ['a', 'b'] }) }).find('.rs-status').text()
    expect(many).toContain('2 vacant posts')
    expect(many).toContain('3 acting heads')
    expect(many).toContain('2 branches with names to check')
  })

  it('hides a gap that is zero', () => {
    const text = render({ summary: summary({ vacant: [], acting: [], mismatch: [] }) }).find('.rs-status').text()
    expect(text).not.toMatch(/vacant|acting|check/)
  })

  it('emits jump with the first key of a gap', async () => {
    const w = render({ summary: summary({ vacant: ['company-6', 'forge'] }) })
    await link(w, 'vacant posts').trigger('click')
    await link(w, 'acting head').trigger('click')
    await link(w, 'name to check').trigger('click')
    expect(w.emitted('jump')).toEqual([['company-6'], ['company-2'], ['company-3']])
  })

  it('shows when it was updated, and when it is out of date', () => {
    expect(render().find('.rs-meta').text()).toBe('Updated 4:00 PM')
    expect(render({ stale: true }).find('.rs-meta').text()).toContain('out of date')
  })
})

describe('RosterStatus: the actions', () => {
  it('emits find, toggle-all and toggle-infirmary', async () => {
    const w = render({ canInfirmary: true })
    await w.find('.rs-find').trigger('click')
    await w.find('.rs-expand-all').trigger('click')
    await w.find('.rs-infirmary-toggle').trigger('click')
    expect(w.emitted('find')).toHaveLength(1)
    expect(w.emitted('toggle-all')).toHaveLength(1)
    expect(w.emitted('toggle-infirmary')).toHaveLength(1)
  })

  it('flips Expand all and Collapse all, and hides it when nothing can open', () => {
    expect(render().find('.rs-expand-all').text()).toBe('Expand all')
    expect(render({ allOpen: true }).find('.rs-expand-all').text()).toBe('Collapse all')
    expect(render({ openable: false }).find('.rs-expand-all').exists()).toBe(false)
  })

  it('shows the Infirmary button to command only, and reflects whether it is on', () => {
    expect(render().find('.rs-infirmary-toggle').exists()).toBe(false)
    const w = render({ canInfirmary: true, infirmaryOpen: true })
    expect(w.find('.rs-infirmary-toggle').text()).toBe('Infirmary')
    expect(w.find('.rs-infirmary-toggle').attributes('aria-pressed')).toBe('true')
  })

  it('always has a status region, and shows the message in it', () => {
    expect(render().find('[role="status"]').exists()).toBe(true)
    expect(render({ message: 'You are not on the roll.' }).find('[role="status"]').text()).toBe('You are not on the roll.')
  })
})
