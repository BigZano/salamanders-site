// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SectionTitle from './SectionTitle.vue'

describe('SectionTitle', () => {
  it('puts the slot text in an h2 title', () => {
    const w = mount(SectionTitle, { slots: { default: 'Verified Members' } })
    expect(w.get('.section-head').element.tagName).toBe('DIV')
    expect(w.get('h2.section-title .section-title-text').text()).toBe('Verified Members')
  })

  it('renders the count, including zero, and omits it when null', () => {
    const count = (props) => mount(SectionTitle, { props, slots: { default: 'Builds' } }).find('.section-title-count')
    expect(count({ count: 12 }).text()).toBe('12')
    expect(count({ count: 0 }).text()).toBe('0')
    expect(count({ count: '0' }).text()).toBe('0')
    expect(count({}).exists()).toBe(false)
    expect(count({ count: null }).exists()).toBe(false)
  })

  it('as="h3" renders an h3 and no h2', () => {
    const w = mount(SectionTitle, { props: { as: 'h3' }, slots: { default: 'Sub' } })
    expect(w.find('h3.section-title').exists()).toBe(true)
    expect(w.find('h2').exists()).toBe(false)
  })

  it('renders the aside slot inside .section-aside, and nothing without it', () => {
    const withAside = mount(SectionTitle, { slots: { default: 'Builds', aside: '<button class="sort">Sort</button>' } })
    expect(withAside.get('.section-aside .sort').text()).toBe('Sort')
    expect(mount(SectionTitle, { slots: { default: 'Builds' } }).find('.section-aside').exists()).toBe(false)
  })

  it('keeps the title before the aside', () => {
    const w = mount(SectionTitle, { slots: { default: 'Builds', aside: '<i class="x" />' } })
    expect([...w.get('.section-head').element.children].map((el) => el.className.split(' ')[0])).toEqual([
      'section-title',
      'section-aside',
    ])
  })
})
