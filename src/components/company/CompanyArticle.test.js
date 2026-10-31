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

  it('never carries a member in the data: a notables section is only a marker for where the cards go', () => {
    for (const c of companies) for (const s of c.sections) expect(s.notables === undefined || s.notables === true, `${c.id}: ${s.h}`).toBe(true)
  })
})

// The Notable Server Members are real names, kept on the server and passed in once it has sent them
// (useCompanyNotables). Invented names only.
const CARDS = [['Test Member One', 'First line.', 'Second line.'], ['Solo Tester', 'Only line.']]
const marked = { id: 'x', sigil: 'X', title: 'X', subtitle: '', sections: [{ h: 'Story', p: ['Prose.'] }, { h: 'Notable Server Members', notables: true }] }
const renderCards = (company, notables, notablesState) => mount(CompanyArticle, { props: { company, notables, notablesState } })

describe('CompanyArticle: the notable members', () => {
  it('is marked in the data by a section with `notables: true`, and nothing else', () => {
    expect(withNotables.sections.find((s) => s.notables).notables).toBe(true)
  })

  it('renders them as cards with initials, a name and blurbs, sized by their text', () => {
    const w = renderCards(marked, CARDS, 'ready')
    const cards = w.findAll('.member')
    expect(cards).toHaveLength(2)
    expect(cards[0].find('.member-name').text()).toBe('Test Member One')
    expect(cards[0].find('.avatar').text()).toBe('TO')
    expect(cards[0].findAll('.member-blurb').map((b) => b.text())).toEqual(['First line.', 'Second line.'])
    expect(cards[0].attributes('style')).toContain('--bio: 23')
    expect(cards[1].findAll('.member-blurb')).toHaveLength(1)
    expect(w.find('.notables').attributes('data-count')).toBe('2')
    expect(w.find('.notables-note').exists()).toBe(false)
  })

  it('takes the first and last word of a name for the initials, ignoring quotes and commas', () => {
    const w = renderCards(marked, [['Chapter "Big" Master, Jones', 'A line.'], ['Solo', 'Another line.']], 'ready')
    expect(w.findAll('.avatar').map((a) => a.text())).toEqual(['CJ', 'S'])
  })

  it('puts them in the marked section only, with the rest of the story untouched', () => {
    const w = renderCards(marked, CARDS, 'ready')
    const blocks = w.findAll('.block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].findAll('.member')).toHaveLength(0)
    expect(blocks[1].find('.block-h').text()).toBe('Notable Server Members')
    expect(blocks[1].findAll('.member')).toHaveLength(2)
  })

  it('says they are for signed-in guild members when the page is not allowed them (the default)', () => {
    const w = render(marked)
    expect(w.find('.notables-note').text()).toBe('Notable server members are shown to signed-in guild members.')
    expect(w.find('.notables-note').attributes('role')).toBeUndefined()
    expect(w.find('.member').exists()).toBe(false)
    expect(w.find('.notables').exists()).toBe(false)
    expect(w.findAll('.block')).toHaveLength(2)
  })

  it('says they are loading, announced politely', () => {
    const note = renderCards(marked, null, 'loading').get('.notables-note')
    expect(note.text()).toBe('Loading the notable server members…')
    expect(note.attributes('role')).toBe('status')
  })

  it('says they could not be loaded', () => {
    const note = renderCards(marked, null, 'error').get('.notables-note')
    expect(note.text()).toBe('The notable server members could not be loaded. Try again later.')
    expect(note.attributes('role')).toBeUndefined()
  })

  it('asks for a new sign-in when the old one has run out', () => {
    const note = renderCards(marked, null, 'expired').get('.notables-note')
    expect(note.text()).toBe('Sign in again to see the notable server members.')
    expect(note.attributes('role')).toBeUndefined()
  })

  it('shows no name unless the page says they are ready, whatever it was handed', () => {
    for (const state of ['denied', 'expired', 'loading', 'error']) {
      const w = renderCards(marked, CARDS, state)
      expect(w.find('.member').exists(), state).toBe(false)
      expect(w.text(), state).not.toContain('Test Member One')
    }
  })

  it('leaves the section out once the server has none for this company, rather than a heading over nothing', () => {
    for (const none of [null, []]) {
      const w = renderCards(marked, none, 'ready')
      expect(w.findAll('.block')).toHaveLength(1)
      expect(w.text()).not.toContain('Notable Server Members')
      expect(w.find('.notables-note').exists()).toBe(false)
    }
  })

  it('keeps a section that is not marked whatever the state', () => {
    const plain = { ...marked, sections: [{ h: 'Story', p: ['Prose.'] }] }
    for (const state of ['denied', 'expired', 'loading', 'ready', 'error']) expect(renderCards(plain, CARDS, state).findAll('.block'), state).toHaveLength(1)
    expect(renderCards(plain, CARDS, 'ready').find('.member').exists()).toBe(false)
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
