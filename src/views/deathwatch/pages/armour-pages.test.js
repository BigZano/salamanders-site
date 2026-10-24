// @vitest-environment jsdom
// The rebuilt Armouring Hall: each tab shows the uniform its address names, with the old site's parts, paints and
// notes; the picker and the Company Heraldry links keep a dev ?scene=; a part card and its hotspot light up together.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

const PAGES = import.meta.glob('./armouringhall/*.vue', { eager: true })

async function mountPage(tab, sub = '', query = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/deathwatch/:area/:tab?/:sub?', component: { render: () => null } }],
  })
  await router.push({ path: `/deathwatch/armouringhall/${tab}${sub ? `/${sub}` : ''}`, query })
  const w = mount(PAGES[`./armouringhall/${tab}.vue`].default, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}
const texts = (w, sel) => w.findAll(sel).map((e) => e.text())

beforeEach(() => {
  document.body.innerHTML = ''
  Element.prototype.scrollIntoView = vi.fn()
})

describe('Armouring Hall', () => {
  it('Standard opens on the Watch Brother, with every part and the Armour Set to come', async () => {
    const w = await mountPage('standard')
    expect(w.get('h2').text()).toBe('Standard')
    expect(w.get('.ah-title').text()).toBe('Watch Brother')
    expect(texts(w, '.ah-part h4')).toEqual(['Helm', 'Pauldrons', 'Wargear', 'Breastplate', 'Gauntlets', 'Greaves'])
    expect(w.text()).toContain('Armour Set')
    expect(w.findAll('.ah-hs')).toHaveLength(6)
  })

  it('shows the uniform the address names, and marks it in the picker', async () => {
    const w = await mountPage('specialist', 'librarium', { scene: 'allowed' })
    expect(w.get('.ah-title').text()).toBe('Librarium')
    expect(w.get('.ah-pick [aria-current="page"]').text()).toBe('Librarium')
    expect(w.findAll('.ah-pick a').map((a) => a.attributes('href'))).toEqual([
      '/deathwatch/armouringhall/specialist/apothecarion?scene=allowed',
      '/deathwatch/armouringhall/specialist/librarium?scene=allowed',
      '/deathwatch/armouringhall/specialist/mechanicus?scene=allowed',
      '/deathwatch/armouringhall/specialist/reclusiarc?scene=allowed',
    ])
    expect(w.text()).toContain('Librarians and higher-ranking members of the Librarium may use the following colors and markings')
  })

  it('lists each paint with its role, and leads each note with its side', async () => {
    const w = await mountPage('specialist', 'mechanicus')
    const helm = w.findAll('.ah-part')[0]
    expect(texts(helm, '.ah-sw span')).toEqual(['PrimaryMephiston Red', 'SecondaryAbaddon Black', 'TertiarySilver', 'LensesMephiston Red'])
    const greaves = w.findAll('.ah-part')[5]
    expect(texts(greaves, '.ah-nt b')).toEqual(['Left', 'Right'])
  })

  it('links a note about Company Heraldry there, without the aside', async () => {
    const w = await mountPage('standard')
    const pauldrons = w.findAll('.ah-part')[1]
    expect(pauldrons.text()).not.toContain('(see Company Heraldry)')
    expect(pauldrons.get('.ah-chl').attributes('href')).toBe('/deathwatch/armouringhall/standard/companyheraldry')
  })

  it('lights a part card and its hotspot together, and a hotspot scrolls to its card', async () => {
    const w = await mountPage('standard')
    const hs = w.findAll('.ah-hs')[3]
    await hs.trigger('mouseenter')
    expect(w.findAll('.ah-part.on').map((c) => c.get('h4').text())).toEqual(['Breastplate'])
    await hs.trigger('click')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    await w.findAll('.ah-part')[0].trigger('mouseenter')
    expect(w.findAll('.ah-hs.on').map((h) => h.attributes('aria-label'))).toEqual(['Show Helm'])
  })

  it('Company Heraldry shows every company, the Watch Company markings and the alternative colors', async () => {
    const w = await mountPage('standard', 'companyheraldry')
    expect(w.get('.ah-title').text()).toBe('Company Heraldry')
    expect(texts(w, '.ah-part h4')).toEqual(['Battle Companies I–IV', 'Watch Company Markings', 'Battle Companies V–VII', 'Alternative Colors'])
    expect(texts(w, '.co b')).toEqual(['1st Company', '2nd Company', '3rd Company', '4th Company', '5th Company', '6th Company', '7th Company', '5th Company', '6th Company'])
    expect(w.findAll('.wm .ah-tile')).toHaveLength(5)
  })

  it('Watch Command: the Sergeant is still WIP; the Specialist links no Watch-Brother uniform', async () => {
    const w = await mountPage('watch-command')
    expect(w.get('.ah-title').text()).toBe('Watch Sergeant')
    expect(w.text()).not.toContain('Reserved')
    expect(w.find('.ah-head .ah-wip').exists()).toBe(true)
    const s = await mountPage('watch-command', 'watchspecialist')
    expect(s.get('.ah-lead').text()).not.toContain('Watch-Brother')
    expect(s.get('.ah-lead a').attributes('href')).toBe('/deathwatch/armouringhall/specialist')
  })

  it('Restricted Wargear: the two locked pieces and how each is unlocked', async () => {
    const w = await mountPage('restricted-wargear')
    expect(w.get('h2').text()).toBe('Restricted Wargear')
    expect(texts(w, '.rw-card > b')).toEqual(['L. Pauldron', 'L. Gauntlet (Heroic)'])
    expect(w.text()).toContain('Previous Tours of Duty also count')
    // No Discord link: its ids may not be in the repo.
    expect(w.find('a').exists()).toBe(false)
  })
})
