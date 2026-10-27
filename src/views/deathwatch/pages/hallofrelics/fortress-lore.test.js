// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useDeathwatchData } from '../../../../stores/deathwatchData'
import FortressLore from './fortress-lore.vue'

vi.mock('../../../../lib/deathwatch/api', () => ({ getData: vi.fn(async () => null), writeDoc: vi.fn() }))

const scrollIntoView = Element.prototype.scrollIntoView
afterEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})

function mountLore(tx) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useDeathwatchData().$patch({ status: 'ready', cfg: { tx } })
  return mount(FortressLore, { global: { plugins: [pinia] }, attachTo: document.body })
}

describe('Fortress Lore', () => {
  it("shows the old site's six chapters under a hidden page heading, and no Fortress Records", () => {
    const w = mountLore()
    expect(w.get('h2').classes()).toContain('dw-sr-only')
    expect(w.findAll('.lo-c .lo-n').map((n) => n.text())).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI'])
    expect(w.get('.lo-c .lo-h').text()).toBe('The Shadow Over Nocturne')
    expect(w.findAll('.lo-sp').length).toBeGreaterThan(0)
    expect(w.findAll('.lo-cry').length).toBeGreaterThan(0)
    expect(w.text()).not.toContain('Fortress Records')
    expect(w.text()).not.toMatch(/\*/)
  })

  it('scrolls to a chapter from its button and takes the focus there, without changing the address', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const w = mountLore()
    const buttons = w.findAll('.lo-toc button')
    expect(buttons).toHaveLength(6)
    buttons[2].trigger('click')
    const chapter = w.findAll('.lo-c')[2].element
    expect(Element.prototype.scrollIntoView.mock.contexts[0]).toBe(chapter)
    expect(chapter.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(chapter)
  })

  it('shows what the data holds in place of the default', () => {
    const w = mountLore({ lo1: 'Our Own Title\nA line.' })
    expect(w.get('.lo-c .lo-h').text()).toBe('Our Own Title')
  })
})
