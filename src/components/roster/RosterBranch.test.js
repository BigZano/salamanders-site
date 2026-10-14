// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import fixture from '../../data/roster.fixture.json'
import { buildRosterView } from '../../lib/rosterView'
import RosterBranch from './RosterBranch.vue'

const roster = fixture.roster
const view = buildRosterView(roster)
const branch = (key) => view.branches.find((b) => b.key === key)
const CDN = 'https://cdn.discordapp.com/avatars/900000000000000001/abc.png?size=64'
const render = (props) => mount(RosterBranch, { props })
const person = (id, extra = {}) => ({ id, name: `Name ${id}`, avatar: null, company: null, ...extra })

describe('RosterBranch: the bar', () => {
  it('shows the sigil, title and count', () => {
    const w = render({ branch: branch('company-3'), open: false })
    expect(w.find('.rs-sigil').text()).toBe('III')
    expect(w.find('h2').text()).toBe('3rd Battle Company')
    expect(w.find('.rs-tail').text()).toContain(String(branch('company-3').count))
  })

  it('shows the head rank and up to two chips', () => {
    const w = render({ branch: branch('forge'), open: false })
    expect(w.find('.rs-head h3').text()).toBe('Master of the Forge')
    expect(w.findAll('.rs-head li.rs-member')).toHaveLength(2)
    expect(w.find('.rs-more').exists()).toBe(false)
  })

  it('counts the head members beyond two', () => {
    const three = { ...branch('company-1'), head: { ...branch('company-1').head, members: [person('1'), person('2'), person('3')], shown: [person('1'), person('2')], more: 1 } }
    const w = render({ branch: three, open: false })
    expect(w.findAll('.rs-head li.rs-member')).toHaveLength(2)
    expect(w.find('.rs-more').text()).toBe('+1')
  })

  it('says Vacant for a vacant head, with no chip', () => {
    const w = render({ branch: branch('company-6'), open: false })
    expect(w.find('.rs-head').text()).toContain('Vacant')
    expect(w.findAll('.rs-head li.rs-member')).toHaveLength(0)
  })

  it('shows Acting on an acting head', () => {
    expect(render({ branch: branch('company-2'), open: false }).find('.rs-head').text()).toContain('Acting')
  })
})

describe('RosterBranch: opening', () => {
  it('has a button that reflects aria-expanded and emits toggle', async () => {
    const w = render({ branch: branch('company-3'), open: false })
    const button = w.find('button')
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(button.attributes('aria-controls')).toBe(w.find('.rs-body').attributes('id'))
    await button.trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
    await w.setProps({ open: true })
    expect(w.find('button').attributes('aria-expanded')).toBe('true')
  })

  it('a branch with nothing to open has no button, no chevron and no body', () => {
    const w = render({ branch: branch('venerable-dreadnoughts'), open: false })
    expect(w.find('button').exists()).toBe(false)
    expect(w.find('.rs-chev').exists()).toBe(false)
    expect(w.find('.rs-body').exists()).toBe(false)
    expect(w.find('h2').text()).toBe('Venerable Dreadnoughts')
  })

  it('keeps the body in the DOM but inert while closed; open has no inert attribute at all', async () => {
    const w = render({ branch: branch('company-3'), open: false })
    expect(w.find('.rs-body').exists()).toBe(true)
    expect(w.find('.rs-body').attributes('inert')).toBeDefined()
    expect(w.findAll('.rs-row').length).toBeGreaterThan(0)
    await w.setProps({ open: true })
    expect(w.find('.rs-body').attributes('inert')).toBeUndefined()
  })

  it('does not request body avatars until first open, and keeps them after', async () => {
    const b = {
      ...branch('company-3'),
      head: { ...branch('company-3').head, shown: [person('1', { avatar: CDN })], members: [person('1', { avatar: CDN })] },
      ladder: [{ type: 'group', s: 0, tier: 7, last: true, heat: { h: 'rgb(1,1,1)', hp: 'rgb(1,1,1)', hn: 'rgb(1,1,1)' }, rows: [{ rank: { key: 'bb', label: 'bb', tier: 7 }, members: [person('2', { avatar: CDN })] }] }],
    }
    const w = render({ branch: b, open: false })
    expect(w.findAll('.rs-head img')).toHaveLength(1) // the bar's own avatar loads at once
    expect(w.findAll('.rs-body img')).toHaveLength(0)
    await w.setProps({ open: true })
    expect(w.findAll('.rs-body img')).toHaveLength(1)
    await w.setProps({ open: false })
    expect(w.findAll('.rs-body img')).toHaveLength(1)
  })

  it('carries the hooks: data-branch, data-kind, data-jump, and data-open only while open', async () => {
    const w = render({ branch: branch('forge'), open: false })
    const root = w.find('article')
    expect(root.classes()).toContain('rs-branch')
    expect(root.attributes()).toMatchObject({ 'data-branch': 'forge', 'data-kind': 'specialty', 'data-jump': 'forge' })
    expect(root.attributes('data-open')).toBeUndefined()
    await w.setProps({ open: true })
    expect(w.find('article').attributes('data-open')).toBeDefined()
  })

  it('the aside renders inside the body', () => {
    expect(render({ branch: branch('company-4'), open: false }).find('.rs-aside').exists()).toBe(true)
  })
})

describe('RosterBranch: the Unassigned variant', () => {
  const w = () => render({ branch: view.unassigned, open: true, variant: 'unassigned' })

  it('is rs-unassigned, not rs-branch, with no data-branch, and jumpable', () => {
    const root = w().find('article')
    expect(root.classes()).toContain('rs-unassigned')
    expect(root.classes()).not.toContain('rs-branch')
    expect(root.attributes('data-branch')).toBeUndefined()
    expect(root.attributes('data-jump')).toBe('unassigned')
  })

  it('has the ? sigil, a title, no head, no spine and no tiers', () => {
    const el = w()
    expect(el.find('.rs-sigil').text()).toBe('?')
    expect(el.find('h2').text()).toBe('Unassigned')
    expect(el.find('.rs-head').exists()).toBe(false)
    expect(el.find('.rs-node').exists()).toBe(false)
    expect(el.findAll('.rs-row').length).toBeGreaterThan(0)
    expect(el.findAll('.rs-row').every((r) => r.attributes('data-tier') === undefined)).toBe(true)
  })
})
