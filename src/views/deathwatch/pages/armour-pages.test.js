// @vitest-environment jsdom
// The rebuilt Armouring Hall: each tab shows the uniform its address names, with the old site's parts, paints and
// notes; the picker and the Company Heraldry links keep a dev ?scene=; a part card and its hotspot light up together.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
vi.mock('../../../lib/deathwatch/api', () => ({ getData: vi.fn(async () => null), writeDoc: vi.fn() }))
import { getData } from '../../../lib/deathwatch/api'
import { useDeathwatchData } from '../../../stores/deathwatchData'

const PAGES = import.meta.glob('./armouringhall/*.vue', { eager: true })

// The page texts (cfg.tx) are already loaded unless `status` says otherwise; `tx` holds what the data has.
async function mountPage(tab, sub = '', query = {}, { tx, status = 'ready' } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useDeathwatchData().$patch({ status, cfg: { tx } })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/deathwatch/:area/:tab?/:sub?', component: { render: () => null } }],
  })
  await router.push({ path: `/deathwatch/armouringhall/${tab}${sub ? `/${sub}` : ''}`, query })
  const w = mount(PAGES[`./armouringhall/${tab}.vue`].default, { global: { plugins: [pinia, router] }, attachTo: document.body })
  await flushPromises()
  return w
}
const texts = (w, sel) => w.findAll(sel).map((e) => e.text())
const card = (w, title) => w.findAll('.ah-part').find((c) => c.get('h4').text() === title)
const spot = (w, title) => w.get(`.ah-hs[aria-label="Show ${title}"]`)
// Which cards and hotspots are lit right now, by name.
const lit = (w) => ({
  cards: w.findAll('.ah-part.on').map((c) => c.get('h4').text()),
  spots: w.findAll('.ah-hs.on').map((h) => h.attributes('aria-label')),
})

// jsdom has no scrollIntoView: stand one in for each test, and take it away again after.
const scrollIntoView = Element.prototype.scrollIntoView
beforeEach(() => {
  document.body.innerHTML = ''
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
  vi.unstubAllGlobals()
})

describe('Armouring Hall', () => {
  it('Standard opens on the Watch Brother, with every part and the Armour Set to come', async () => {
    const w = await mountPage('standard')
    expect(w.get('h2').text()).toBe('Standard')
    // The original had no heading here: kept for assistive technology, hidden on screen.
    expect(w.get('h2').classes()).toContain('dw-sr-only')
    expect(w.get('h2').classes()).not.toContain('dw-plaque')
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

  it('lights a part card and its hotspot together under the pointer, and puts them out when it leaves', async () => {
    const w = await mountPage('standard')
    await spot(w, 'Breastplate').trigger('mouseenter')
    expect(lit(w)).toEqual({ cards: ['Breastplate'], spots: ['Show Breastplate'] })
    await spot(w, 'Breastplate').trigger('mouseleave')
    expect(lit(w)).toEqual({ cards: [], spots: [] })
    await card(w, 'Helm').trigger('mouseenter')
    expect(lit(w)).toEqual({ cards: ['Helm'], spots: ['Show Helm'] })
    await card(w, 'Helm').trigger('mouseleave')
    expect(lit(w)).toEqual({ cards: [], spots: [] })
  })

  it('lights a card and its hotspot while either has focus, and puts them out when focus leaves', async () => {
    const w = await mountPage('standard')
    spot(w, 'Wargear').element.focus()
    await w.vm.$nextTick()
    expect(lit(w)).toEqual({ cards: ['Wargear'], spots: ['Show Wargear'] })
    spot(w, 'Wargear').element.blur()
    await w.vm.$nextTick()
    expect(lit(w)).toEqual({ cards: [], spots: [] })
    card(w, 'Gauntlets').element.focus()
    await w.vm.$nextTick()
    expect(lit(w)).toEqual({ cards: ['Gauntlets'], spots: ['Show Gauntlets'] })
    card(w, 'Gauntlets').element.blur()
    await w.vm.$nextTick()
    expect(lit(w)).toEqual({ cards: [], spots: [] })
  })

  it('a hotspot scrolls to its card, moves focus to it and lights it, with no pointer ever over it', async () => {
    const w = await mountPage('standard')
    await spot(w, 'Greaves').trigger('click')
    const greaves = card(w, 'Greaves').element
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce()
    expect(Element.prototype.scrollIntoView.mock.contexts[0]).toBe(greaves)
    expect(document.activeElement).toBe(greaves)
    await w.vm.$nextTick()
    expect(lit(w)).toEqual({ cards: ['Greaves'], spots: ['Show Greaves'] })
  })

  it('flashes the card a hotspot scrolled to, afresh on each click, until its animation ends', async () => {
    const frames = []
    vi.stubGlobal('requestAnimationFrame', (run) => frames.push(run))
    const nextFrame = async (w) => {
      frames.splice(0).forEach((run) => run(0))
      await w.vm.$nextTick()
    }
    const flashing = (w) => w.findAll('.ah-part.flash').map((c) => c.get('h4').text())
    const w = await mountPage('standard')
    await spot(w, 'Helm').trigger('click')
    expect(flashing(w)).toEqual([])
    await nextFrame(w)
    expect(flashing(w)).toEqual(['Helm'])
    // The same marker again: the flash goes out until the next frame, so the animation starts over.
    await spot(w, 'Helm').trigger('click')
    expect(flashing(w)).toEqual([])
    await nextFrame(w)
    expect(flashing(w)).toEqual(['Helm'])
    await spot(w, 'Pauldrons').trigger('click')
    await nextFrame(w)
    expect(flashing(w)).toEqual(['Pauldrons'])
    await card(w, 'Pauldrons').trigger('animationend')
    expect(flashing(w)).toEqual([])
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
    expect(s.get('.ah-lead a').attributes('href')).toBe('/deathwatch/armouringhall/specialist/apothecarion')
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

// What the Watch Commander wrote under "Edit page" (cfg.tx) in place of the texts the pages ship with. Invented texts.
describe('Armouring Hall page texts', () => {
  it('shows a uniform’s introduction from the page texts, its marks and area links included', async () => {
    const tx = { ah_librarium_lead: 'Only **Librarians** may wear this; see the [Watch Brother](/deathwatch/armouringhall/standard/watchbrother).' }
    const w = await mountPage('specialist', 'librarium', {}, { tx })
    expect(w.get('.ah-lead').text()).toBe('Only Librarians may wear this; see the Watch Brother.')
    expect(w.get('.ah-lead b').text()).toBe('Librarians')
    expect(w.get('.ah-lead a').attributes('href')).toBe('/deathwatch/armouringhall/standard/watchbrother')
  })

  it('hides an emptied introduction', async () => {
    const w = await mountPage('specialist', 'librarium', {}, { tx: { ah_librarium_lead: ' ' } })
    expect(w.find('.ah-lead').exists()).toBe(false)
  })

  it('shows a part’s notes from the page texts, one a line, with their marks and the Company Heraldry link', async () => {
    const tx = { ah_watchbrother_greaves: 'Left: a *new* marking.\n\nA plain note (see Company Heraldry).' }
    const w = await mountPage('standard', '', {}, { tx })
    const greaves = card(w, 'Greaves')
    expect(texts(greaves, '.ah-nt b')).toEqual(['Left'])
    expect(greaves.get('.ah-nt i').text()).toBe('new')
    expect(greaves.text()).toContain('A plain note')
    expect(greaves.text()).not.toContain('(see Company Heraldry)')
    expect(greaves.find('.ah-chl').exists()).toBe(true)
    // The other parts keep the notes they ship with.
    expect(card(w, 'Helm').text()).toContain('Mask Pattern.')
  })

  it('loads the page texts when they are not there yet, and not again when they are', async () => {
    vi.mocked(getData).mockClear()
    await mountPage('specialist')
    expect(getData).not.toHaveBeenCalled()
    await mountPage('specialist', '', {}, { status: 'idle' })
    expect(getData).toHaveBeenCalled()
  })

  it('Company Heraldry: a note under each section from the page texts, the defaults elsewhere', async () => {
    const tx = { ah_companyheraldry_companies1: 'First *note*\nSecond note', ah_companyheraldry_markings: '' }
    const w = await mountPage('standard', 'companyheraldry', {}, { tx })
    const section = (title) => w.findAll('.ah-part').find((s) => s.get('h4').text() === title)
    expect(texts(section('Battle Companies I–IV'), ':scope > p')).toEqual(['First note', 'Second note'])
    expect(section('Battle Companies I–IV').get('p i').text()).toBe('note')
    expect(section('Watch Company Markings').findAll(':scope > p')).toHaveLength(0)
    expect(section('Battle Companies V–VII').text()).toContain("own Company and also appear in the regular uniform guidelines")
    expect(section('Alternative Colors').findAll(':scope > p')).toHaveLength(0)
  })

  it('Company Heraldry: loads the page texts when they are not there yet, and not again when they are', async () => {
    vi.mocked(getData).mockClear()
    await mountPage('standard', 'companyheraldry')
    expect(getData).not.toHaveBeenCalled()
    await mountPage('standard', 'companyheraldry', {}, { status: 'idle' })
    expect(getData).toHaveBeenCalled()
  })

  it('Restricted Wargear: shows the page texts, drops an emptied card, and hides emptied lines', async () => {
    const tx = { rw_h: 'Locked Gear', rw_i: 'Ask the **Watch Commander**.', rw_c1: '', rw_c2: 'A Set\nA Piece\nEarned by a tour.\nProof: a role.', rw_f: '' }
    const w = await mountPage('restricted-wargear', '', {}, { tx })
    expect(w.get('.rw h3').text()).toBe('Locked Gear')
    expect(w.find('.rw h4').exists()).toBe(false)
    expect(w.findAll('.rw > .rw-f')).toHaveLength(0)
    expect(w.get('.rw > p b').text()).toBe('Watch Commander')
    expect(texts(w, '.rw-card > b')).toEqual(['A Piece'])
    expect(w.get('.rw-proof').text()).toBe('Proof: a role.')
  })

  it('Restricted Wargear: no cards, no grid; a card of two lines has no unlock or proof', async () => {
    const none = await mountPage('restricted-wargear', '', {}, { tx: { rw_c1: '', rw_c2: '' } })
    expect(none.find('.rw-grid').exists()).toBe(false)
    const short = await mountPage('restricted-wargear', '', {}, { tx: { rw_c1: 'A Set\nA Piece', rw_c2: '', rw_i: '' } })
    expect(short.get('.rw-card').findAll('p')).toHaveLength(0)
    expect(short.find('.rw > p:not(.rw-f)').exists()).toBe(false)
  })

  it('Restricted Wargear: loads the page texts when they are not there yet, and not again when they are', async () => {
    vi.mocked(getData).mockClear()
    await mountPage('restricted-wargear')
    expect(getData).not.toHaveBeenCalled()
    await mountPage('restricted-wargear', '', {}, { status: 'idle' })
    expect(getData).toHaveBeenCalled()
  })
})
