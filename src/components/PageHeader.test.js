// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PageHeader from './PageHeader.vue'

describe('PageHeader', () => {
  it('renders eyebrow, title and lede', () => {
    const w = mount(PageHeader, { props: { eyebrow: 'The Chapter', title: 'Companies', lede: 'Who we are.' } })
    expect(w.find('.eyebrow').text()).toBe('The Chapter')
    expect(w.findAll('h1')).toHaveLength(1)
    expect(w.find('h1').text()).toBe('Companies')
    expect(w.find('.page-lede').text()).toBe('Who we are.')
  })

  it('omits the eyebrow and lede when empty', () => {
    const w = mount(PageHeader, { props: { title: 'Roster' } })
    expect(w.find('.eyebrow').exists()).toBe(false)
    expect(w.find('.page-lede').exists()).toBe(false)
    expect(w.find('h1').text()).toBe('Roster')
  })

  it('puts titleId on the h1', () => {
    const w = mount(PageHeader, { props: { title: 'Roster', titleId: 'roster-title' } })
    expect(w.find('h1').attributes('id')).toBe('roster-title')
    expect(mount(PageHeader, { props: { title: 'Roster' } }).find('h1').attributes('id')).toBeUndefined()
  })

  it('renders the slot after the lede', () => {
    const w = mount(PageHeader, { props: { title: 'Roster', lede: 'Lede.' }, slots: { default: '<input class="extra" />' } })
    const kids = [...w.element.children].map((el) => el.className.split(' ')[0] || el.tagName.toLowerCase())
    expect(kids.indexOf('extra')).toBeGreaterThan(kids.indexOf('page-lede'))
  })

  it('lets the parent add a class to the header', () => {
    const w = mount(PageHeader, { props: { title: 'Roster' }, attrs: { class: 'c-head' } })
    expect(w.element.tagName).toBe('HEADER')
    expect(w.classes()).toEqual(expect.arrayContaining(['page-head', 'c-head']))
  })
})
