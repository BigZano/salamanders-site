// @vitest-environment jsdom
// The Recruitment pages rendered: the Terms of Service with their numbering, and the Requirements with their notes.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useDeathwatchData } from '../../../../stores/deathwatchData'
import TermsOfService from './terms-of-service.vue'
import Requirements from './requirements.vue'

vi.mock('../../../../lib/deathwatch/api', () => ({ getData: vi.fn(async () => null), writeDoc: vi.fn() }))

function mountPage(page, tx) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useDeathwatchData().$patch({ status: 'ready', cfg: { tx } })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { render: () => null } }] })
  return mount(page, { global: { plugins: [pinia, router] } })
}
const texts = (w, sel) => w.findAll(sel).map((e) => e.text())

describe('Terms of Service', () => {
  it('numbers the sections, sub-sections and clauses: the fourth section is Failure Progression', () => {
    const w = mountPage(TermsOfService)
    const sections = texts(w, '.rc-s h3')
    expect(sections).toHaveLength(6)
    expect(sections[3]).toBe('Section 4 — Failure Progression')
    expect(w.findAll('.rc-s')[3].get('.rc-n').text()).toBe('4.1.1')
    expect(w.findAll('.rc-s')[3].get('h4').text()).toBe('4.1 — Formal Discipline')
  })

  // Section 3 refers to "Section 4" by number: that must stay true when an earlier section is blanked.
  it('keeps each section its number when an earlier one is blanked', () => {
    const w = mountPage(TermsOfService, { ts2: '' })
    const sections = texts(w, '.rc-s h3')
    expect(sections).toHaveLength(5)
    expect(sections[2]).toBe('Section 4 — Failure Progression')
    expect(w.findAll('.rc-s')[2].get('.rc-n').text()).toBe('4.1.1')
  })

  it('shows a sub-section title with its marks, and no empty list for a sub-section without clauses', () => {
    const w = mountPage(TermsOfService, { ts1: 'First\n## **Bold** title\n## Empty one' })
    const first = w.findAll('.rc-s')[0]
    expect(first.findAll('h4').map((h) => h.text())).toEqual(['1.1 — Bold title', '1.2 — Empty one'])
    expect(first.get('h4 b').text()).toBe('Bold')
    expect(first.findAll('ol')).toHaveLength(0)
    expect(first.text()).not.toMatch(/\*/)
  })

  it('links the Requirements in place and Discord in a new tab', () => {
    const w = mountPage(TermsOfService)
    const links = w.findAll('.rc a')
    const page = links.find((a) => a.text() === 'Requirements')
    expect(page.attributes('href')).toBe('/deathwatch/recruitment/requirements')
    expect(page.attributes('target')).toBeUndefined()
    expect(links.find((a) => a.text() === 'dw-tour-signups').attributes('target')).toBe('_blank')
  })
})

describe('Requirements', () => {
  it('shows the three blocks, each requirement with all its notes', () => {
    const w = mountPage(Requirements, { rq1: 'Ranks\nLead line\n- one\n  - first note\n  - second note\n- two' })
    expect(texts(w, '.rc-s h3')).toEqual(['Ranks', 'Accolade Requirements', 'Skill & Conduct Requirements'])
    const items = w.findAll('.rc-s')[0].findAll('.rc-req > li')
    expect(items).toHaveLength(2)
    expect(texts(items[0], '.rc-l')).toEqual(['first note', 'second note'])
    expect(items[1].findAll('.rc-l')).toHaveLength(0)
  })
})
