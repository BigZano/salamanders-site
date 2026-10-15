// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import fixture from '../../data/roster.fixture.json'
import { buildRosterView, heatAt } from '../../lib/rosterView'
import RosterLadder from './RosterLadder.vue'

const view = buildRosterView(fixture.roster)
const company1 = view.branches.find((b) => b.key === 'company-1')
const person = (id) => ({ id, name: `Name ${id}`, avatar: null, company: null })
const row = (key, tier, extra = {}) => ({ rank: { key, label: key, tier, ...extra }, members: [person(`9000000000000000${tier}${key.length}`)] })
const heat = { h: heatAt(0.5), hp: heatAt(0.2), hn: heatAt(0.8) }
const render = (props) => mount(RosterLadder, { props })

describe('RosterLadder', () => {
  it('renders the items in order, each with its sequence and heat as CSS variables', () => {
    const w = render({ items: company1.ladder, branch: company1 })
    const steps = w.findAll('.rs-step')
    expect(steps).toHaveLength(company1.ladder.length)
    steps.forEach((step, i) => {
      const { h, hp, hn } = company1.ladder[i].heat
      expect(step.element.style.getPropertyValue('--s')).toBe(String(i))
      expect(step.element.style.getPropertyValue('--h')).toBe(h)
      expect(step.element.style.getPropertyValue('--hp')).toBe(hp)
      expect(step.element.style.getPropertyValue('--hn')).toBe(hn)
    })
  })

  it('draws one node per step, and none without a spine', () => {
    expect(render({ items: company1.ladder, branch: company1 }).findAll('i.rs-node')).toHaveLength(company1.ladder.length)
    expect(render({ items: company1.ladder, branch: company1, spine: false }).findAll('i.rs-node')).toHaveLength(0)
  })

  it('puts peers on one step, side by side', () => {
    const items = [{ type: 'group', s: 0, heat, tier: 2, rows: [row('ancient', 2), row('champion', 2)], last: true }]
    const w = render({ items })
    expect(w.findAll('.rs-step')).toHaveLength(1)
    expect(w.findAll('.rs-peers .rs-row')).toHaveLength(2)
  })

  it('marks only the lateral rank with data-lateral', () => {
    const w = render({ items: company1.ladder, branch: company1 })
    const lateral = w.findAll('[data-lateral]')
    expect(lateral).toHaveLength(1)
    expect(lateral[0].attributes('data-rank')).toBe('terminator')
    expect(w.findAll('.rs-lateral')).toHaveLength(1)
  })

  it('renders the Dreadnought aside as its own slot, not a rank row', () => {
    const w = render({ items: company1.ladder, branch: company1 })
    const aside = w.find('.rs-aside')
    expect(aside.exists()).toBe(true)
    expect(aside.text()).toContain('Honoured Dreadnoughts')
    expect(aside.findAll('li.rs-member')).toHaveLength(1)
    expect(aside.find('.rs-row').exists()).toBe(false)
  })

  it('puts data-tier on every rank row, in non-decreasing order', () => {
    const tiers = render({ items: company1.ladder, branch: company1 }).findAll('.rs-row').map((r) => Number(r.attributes('data-tier')))
    expect(tiers.length).toBeGreaterThan(1)
    tiers.forEach((t, i) => i && expect(t).toBeGreaterThanOrEqual(tiers[i - 1]))
  })

  it('leaves data-tier off when with-tier is false (Unassigned)', () => {
    const w = render({ items: view.unassigned.ladder, spine: false, withTier: false })
    expect(w.findAll('.rs-row').length).toBeGreaterThan(0)
    expect(w.findAll('.rs-row').every((r) => r.attributes('data-tier') === undefined)).toBe(true)
  })

  it('holds chip avatars back until image-ready', () => {
    const avatar = 'https://cdn.discordapp.com/avatars/1/a.png?size=64'
    const items = [{ type: 'group', s: 0, heat, tier: 7, rows: [{ rank: { key: 'bb', label: 'bb', tier: 7 }, members: [{ ...person('900000000000000009'), avatar }] }], last: true }]
    expect(render({ items, imageReady: false }).findAll('img')).toHaveLength(0)
    expect(render({ items, imageReady: true }).findAll('img')).toHaveLength(1)
  })
})
