// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import companies from '../../data/companies.json'
import CompanyArticle from './CompanyArticle.vue'

const render = (company, slots) => mount(CompanyArticle, { props: { company }, slots })
const first = companies[0]
const withList = companies.find((c) => c.sections.some((s) => s.list))
const withNotables = companies.find((c) => c.sections.some((s) => s.notables))

describe('CompanyArticle: the story', () => {
  it('is an article with the company id, sigil, title and subtitle', () => {
    const w = render(first)
    expect(w.find('article.company').attributes('id')).toBe(first.id)
    expect(w.find('.sigil').text()).toBe(first.sigil)
    expect(w.find('h2.company-title').text()).toBe(first.title)
    expect(w.find('.company-sub').text()).toBe(first.subtitle)
  })

  it('renders each section as a block on the readable surface, with its heading and paragraphs', () => {
    const w = render(first)
    const blocks = w.findAll('.block')
    expect(blocks).toHaveLength(first.sections.length)
    expect(blocks.every((b) => b.classes().includes('surface'))).toBe(true)
    expect(blocks[0].find('.block-h').text()).toBe(first.sections[0].h)
    expect(blocks[0].findAll('.block-p')).toHaveLength(first.sections[0].p.length)
  })

  it('renders a list section as list items', () => {
    const section = withList.sections.find((s) => s.list)
    const items = render(withList).findAll('.block-list li')
    expect(items.length).toBeGreaterThanOrEqual(section.list.length)
    expect(items.map((i) => i.text())).toContain(section.list[0])
  })

  it('renders notable members as cards with initials, a name and blurbs, sized by their text', () => {
    const section = withNotables.sections.find((s) => s.notables)
    const w = render(withNotables)
    const cards = w.findAll('.member')
    expect(cards.length).toBeGreaterThanOrEqual(section.notables.length)
    const card = cards[0]
    expect(card.find('.member-name').text()).toBe(section.notables[0][0])
    expect(card.find('.avatar').text()).toMatch(/^[A-Z]{1,2}$/)
    expect(card.findAll('.member-blurb')).toHaveLength(section.notables[0].length - 1)
    expect(card.attributes('style')).toContain('--bio')
    expect(w.find('.notables').attributes('data-count')).toBe(String(section.notables.length))
  })

  it('takes the first and last word of a name for the initials, ignoring quotes and commas', () => {
    const company = { id: 'x', sigil: 'X', title: 'X', subtitle: '', sections: [{ h: 'H', notables: [['Chapter "Big" Master, Jones', 'A line.'], ['Solo', 'Another line.']] }] }
    const avatars = render(company).findAll('.avatar').map((a) => a.text())
    expect(avatars).toEqual(['CJ', 'S'])
  })
})

describe('CompanyArticle: the ranks slot and the way back up', () => {
  it('puts the ranks slot between the header and the story', () => {
    const html = render(first, { ranks: '<div class="r">RANKS</div>' }).html()
    expect(html.indexOf('company-head')).toBeLessThan(html.indexOf('class="r"'))
    expect(html.indexOf('class="r"')).toBeLessThan(html.indexOf('class="block'))
  })

  it('has no ranks wrapper when the slot is empty', () => {
    expect(render(first).find('.company-ranks').exists()).toBe(false)
  })

  it('has an ↑ Index button that says index to a screen reader too, and emits index', async () => {
    const w = render(first)
    const button = w.find('button.c-top')
    expect(button.text()).toContain('Index')
    expect(button.attributes('aria-label').toLowerCase()).toContain('index')
    await button.trigger('click')
    expect(w.emitted('index')).toHaveLength(1)
  })
})
