// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RosterRank from './RosterRank.vue'

const person = (id) => ({ id, name: `Name ${id}`, avatar: null, company: null })
const row = (key, tier, extra = {}, members = [person('900000000000000001'), person('900000000000000002')]) => ({ rank: { key, label: `Label ${key}`, tier, ...extra }, members })
const render = (props) => mount(RosterRank, { props })

describe('RosterRank', () => {
  it('always carries data-rank, and the label with its count', () => {
    const w = render({ row: row('sergeant', 4) })
    expect(w.find('.rs-row').attributes('data-rank')).toBe('sergeant')
    expect(w.find('h3').text()).toContain('Label sergeant')
    expect(w.find('h3').text()).toContain('2')
  })

  it('carries data-tier only with with-tier', () => {
    expect(render({ row: row('sergeant', 4) }).find('.rs-row').attributes('data-tier')).toBeUndefined()
    expect(render({ row: row('sergeant', 4), withTier: true }).find('.rs-row').attributes('data-tier')).toBe('4')
  })

  it('carries data-lateral only for a lateral rank', () => {
    expect(render({ row: row('sergeant', 4), withTier: true }).find('.rs-row').attributes('data-lateral')).toBeUndefined()
    expect(render({ row: row('terminator', 5, { lateral: true }), withTier: true }).find('.rs-row').attributes('data-lateral')).toBe('')
  })

  it('renders one member chip per member', () => {
    expect(render({ row: row('scout', 8) }).findAll('li.rs-member')).toHaveLength(2)
  })

  it('passes the branch down so the company tag rule applies', () => {
    const member = { ...person('900000000000000003'), company: 1 }
    const inOwn = render({ row: row('scout', 8, {}, [member]), branch: { kind: 'company', number: 1 } })
    expect(inOwn.find('.rs-tag').exists()).toBe(false)
    const elsewhere = render({ row: row('scout', 8, {}, [member]), branch: { kind: 'specialty' } })
    expect(elsewhere.find('.rs-tag').text()).toBe('1st')
  })
})
