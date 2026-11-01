// @vitest-environment jsdom
// The rebuilt Armouring Hall: each tab shows the uniform its address names, with the old site's parts, paints and
// notes; the picker and the Company Heraldry links keep a dev ?scene=; a part and its marker light up together, and
// the chosen part shows in detail (beside the figure on a wide screen, in a bottom sheet on a phone).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
vi.mock('../../../lib/deathwatch/api', () => ({ getData: vi.fn(async () => null), writeDoc: vi.fn() }))
import { getData } from '../../../lib/deathwatch/api'
import { useDeathwatch } from '../../../stores/deathwatch'
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

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('Armouring Hall', () => {
  it('heads every tab with the hall and its tabs, the open one marked; Watch Command for the Command only', async () => {
    const tabs = (w) => w.findAll('.hh-tab').map((a) => [a.text(), a.attributes('href'), a.attributes('aria-current')])
    const w = await mountPage('specialist', 'librarium', { scene: 'allowed' })
    expect(w.get('.hh-title').text()).toBe('Armouring Hall')
    expect(w.get('.hh-title').attributes('aria-level')).toBe('1')
    expect(w.get('.hh-back').attributes('href')).toBe('/deathwatch')
    expect(tabs(w)).toEqual([
      ['Standard', '/deathwatch/armouringhall/standard/watchbrother?scene=allowed', undefined],
      ['Specialist', '/deathwatch/armouringhall/specialist/reclusiarc?scene=allowed', 'page'],
      ['Restricted Wargear', '/deathwatch/armouringhall/restricted-wargear?scene=allowed', undefined],
    ])
    useDeathwatch().$patch({ command: true })
    await flushPromises()
    expect(tabs(w).map(([label]) => label)).toEqual(['Standard', 'Specialist', 'Watch Command', 'Restricted Wargear'])
    const rw = await mountPage('restricted-wargear')
    expect(rw.get('.hh-tab[aria-current="page"]').text()).toBe('Restricted Wargear')
  })

  it('Standard opens on the Watch Brother, lists every part, shows the Helm, and the Armour Set to come', async () => {
    const w = await mountPage('standard')
    expect(w.get('h2').text()).toBe('Standard')
    // The original had no heading here: kept for assistive technology, hidden on screen.
    expect(w.get('h2').classes()).toContain('dw-sr-only')
    expect(w.get('h2').classes()).not.toContain('dw-plaque')
    expect(w.get('.ah-title').text()).toBe('Watch Brother')
    expect(texts(w, '.av-part span')).toEqual(['Helm', 'Pauldrons', 'Wargear', 'Breastplate', 'Gauntlets', 'Greaves'])
    expect(w.get('.av-part[aria-current="true"]').text()).toBe('Helm')
    expect(w.findAll('.av-part[aria-current]')).toHaveLength(1)
    expect(w.get('.av-detail .ad-cls').text()).toBe('Standard Armour')
    expect(w.get('.av-detail .ad-title').text()).toBe('Helm')
    expect(w.get('.av-bar b').text()).toBe('Helm')
    expect(w.text()).toContain('Armour Set')
    expect(w.findAll('.ah-hs')).toHaveLength(6)
    expect(w.findAll('.ah-hs.on').map((h) => h.attributes('aria-label'))).toEqual(['Show Helm'])
    // The markers near the left edge open their labels inward; none sits near the right one.
    expect(w.findAll('.ah-hs.l').map((h) => h.attributes('aria-label'))).toEqual(['Show Pauldrons', 'Show Gauntlets'])
    expect(w.findAll('.ah-hs.r')).toHaveLength(0)
  })

  it('shows the uniform the address names, and marks it in the picker', async () => {
    const w = await mountPage('specialist', 'librarium', { scene: 'allowed' })
    expect(w.get('.ah-title').text()).toBe('Librarium')
    expect(w.get('.ah-pick [aria-current="page"]').text()).toBe('Librarium')
    expect(w.findAll('.ah-pick a').map((a) => a.attributes('href'))).toEqual([
      '/deathwatch/armouringhall/specialist/reclusiarc?scene=allowed',
      '/deathwatch/armouringhall/specialist/librarium?scene=allowed',
      '/deathwatch/armouringhall/specialist/apothecarion?scene=allowed',
      '/deathwatch/armouringhall/specialist/mechanicus?scene=allowed',
    ])
    expect(w.text()).toContain('Librarians and higher-ranking members of the Librarium may use the following colors and markings')
  })

  it('picks the uniform from a dropdown, which closes on a pick, on Escape and when focus leaves', async () => {
    const w = await mountPage('specialist', 'librarium')
    const dd = w.get('.ah-dd').element
    expect(texts(w, '.ah-cls')).toEqual(['Specialist'])
    expect(w.get('.ah-dd-btn').text()).toBe('Librarium')
    expect(w.get('.ah-dd-btn img').attributes('src')).toBe(w.get('.ah-icon').attributes('src'))
    dd.open = true
    await w.findAll('.ah-pick-link')[0].trigger('click')
    expect(dd.open).toBe(false)
    dd.open = true
    await w.get('.ah-dd').trigger('keydown', { key: 'Escape' })
    expect(dd.open).toBe(false)
    expect(document.activeElement).toBe(w.get('.ah-dd-btn').element)
    dd.open = true
    await w.get('.ah-dd').trigger('focusout', { relatedTarget: w.findAll('.ah-pick-link')[1].element })
    expect(dd.open).toBe(true)
    await w.get('.ah-dd').trigger('focusout', { relatedTarget: null })
    expect(dd.open).toBe(false)
  })

  // Review of #53: Safari on macOS gives a <summary> no focus on a click, so no focusout ever comes from outside.
  it('closes the dropdown on a press outside it, listening only while it is open', async () => {
    const w = await mountPage('specialist', 'librarium')
    const dd = w.get('.ah-dd').element
    const press = (el) => el.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    dd.open = true
    dd.dispatchEvent(new Event('toggle'))
    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    press(w.get('.ah-dd-btn').element)
    press(w.findAll('.ah-pick-link')[1].element)
    expect(dd.open).toBe(true)
    press(document.body)
    expect(dd.open).toBe(false)
    dd.dispatchEvent(new Event('toggle'))
    expect(remove).toHaveBeenCalledWith('pointerdown', add.mock.calls.find(([t]) => t === 'pointerdown')[1])
    w.unmount()
    press(document.body) // gone with the page, and harmless if it were not
    vi.restoreAllMocks()
  })

  it('survives the dropdown’s late toggle event when a pick has already taken the page away', async () => {
    const w = await mountPage('specialist', 'librarium')
    const dd = w.get('.ah-dd').element
    dd.open = true // the browser queues its toggle event for a task later
    w.unmount()
    await new Promise((r) => setTimeout(r, 0))
    expect(dd.open).toBe(true) // and nothing threw (Vitest fails the run on an uncaught error)
    vi.restoreAllMocks()
  })

  it('lists each paint with its role, and leads each note with its side', async () => {
    const w = await mountPage('specialist', 'mechanicus')
    expect(texts(w, '.av-detail .ad-sw li')).toEqual(['PrimaryRed', 'SecondaryAbaddon Black', 'TertiaryLiberator Gold', 'LensesLiberator Gold'])
    await w.findAll('.av-part')[5].trigger('click')
    expect(w.get('.av-detail .ad-title').text()).toBe('Greaves')
    expect(texts(w, '.av-detail .ah-nt b')).toEqual(['Left', 'Right'])
  })

  it('a part without paints or notes shows neither list', async () => {
    const w = await mountPage('standard')
    await w.findAll('.av-part')[1].trigger('click')
    expect(w.find('.av-detail .ad-sw').exists()).toBe(false)
    await w.findAll('.av-part')[3].trigger('click')
    expect(w.find('.av-detail .ad-notes').exists()).toBe(false)
  })

  it('crops each part thumbnail from its first tile in the sprite, the Wargear, the Breastplate and the Greaves nearer their top, the Gauntlets from their second tile', async () => {
    const w = await mountPage('standard')
    const pos = w.findAll('.av-part .av-thumb').map((t) => t.attributes('style').match(/background-position: ([^;]+)/)[1])
    expect(pos).toEqual(['0% 50%', '10% 50%', '30% 25%', '50% 25%', '80% 50%', '90% 12%'])
  })

  it('links a note about Company Heraldry there, without the aside', async () => {
    const w = await mountPage('standard', '', { scene: 'commander' })
    await w.findAll('.av-part')[1].trigger('click')
    const pauldrons = w.get('.av-detail')
    expect(pauldrons.text()).not.toContain('(see Company Heraldry)')
    expect(pauldrons.get('.ah-chl').attributes('href')).toBe('/deathwatch/armouringhall/standard/companyheraldry?scene=commander')
    const plain = await mountPage('standard')
    await plain.findAll('.av-part')[1].trigger('click')
    expect(plain.get('.av-detail .ah-chl').attributes('href')).toBe('/deathwatch/armouringhall/standard/companyheraldry')
  })

  it('lights a part and its marker together, and keeps the chosen part on the next uniform', async () => {
    const w = await mountPage('specialist')
    await w.findAll('.ah-hs')[3].trigger('mouseenter')
    expect(w.findAll('.av-part.on').map((c) => c.text())).toEqual(['Breastplate'])
    await w.findAll('.ah-hs')[3].trigger('mouseleave')
    expect(w.findAll('.av-part.on')).toHaveLength(0)
    await w.findAll('.ah-hs')[2].trigger('focus')
    expect(w.findAll('.av-part.on').map((c) => c.text())).toEqual(['Wargear'])
    await w.findAll('.ah-hs')[2].trigger('blur')
    expect(w.findAll('.av-part.on')).toHaveLength(0)
    await w.findAll('.av-part')[4].trigger('mouseenter')
    expect(w.findAll('.ah-hs.on').map((h) => h.attributes('aria-label'))).toEqual(['Show Helm', 'Show Gauntlets'])
    await w.findAll('.av-part')[4].trigger('mouseleave')
    await w.findAll('.av-part')[0].trigger('focus')
    expect(w.findAll('.av-part.on').map((c) => c.text())).toEqual(['Helm'])
    await w.findAll('.av-part')[0].trigger('blur')
    expect(w.findAll('.av-part.on')).toHaveLength(0)
    await w.findAll('.av-part')[4].trigger('click')
    expect(w.get('.av-detail .ad-title').text()).toBe('Gauntlets')
    await w.vm.$router.push('/deathwatch/armouringhall/specialist/librarium')
    await flushPromises()
    expect(w.get('.av-detail .ad-title').text()).toBe('Gauntlets')
    expect(w.get('.av-detail .ad-sw li').text()).toBe('Right primaryAlaitoc Blue')
  })

  describe('on a phone', () => {
    let phone
    beforeEach(() => {
      phone = true
      // jsdom applies no component styles: the narrow layout hides the detail beside the figure, stood in for here.
      const real = window.getComputedStyle
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => (phone && el.classList.contains('av-detail') ? { display: 'none' } : real(el)))
      // Reduced motion, so the sheet closes at once rather than after its slide.
      window.matchMedia = vi.fn((q) => ({ matches: q.includes('reduce') }))
      HTMLDialogElement.prototype.showModal = vi.fn(function () {
        this.setAttribute('open', '')
      })
      HTMLDialogElement.prototype.close = vi.fn(function () {
        this.removeAttribute('open')
        this.dispatchEvent(new Event('close'))
      })
    })
    afterEach(() => {
      vi.restoreAllMocks()
      delete window.matchMedia
    })
    // Two sheets: the uniforms' (in the head) and the chosen part's.
    const sheetOf = (w, sel) => w.findAll('dialog').find((d) => d.find(sel).exists())
    const partSheet = (w) => sheetOf(w, '.av-sheet')

    it('the uniforms bar names the open one and opens the others in a sheet; choosing one closes it', async () => {
      const w = await mountPage('specialist', 'librarium')
      expect(w.get('.ah-pick-bar').text()).toContain('Librarium')
      const uniforms = sheetOf(w, '.ah-pick-sheet')
      expect(uniforms.attributes('open')).toBeUndefined()
      await w.get('.ah-pick-bar').trigger('click')
      await flushPromises()
      expect(uniforms.attributes('open')).toBe('')
      expect(uniforms.findAll('.ah-pick-row').map((a) => [a.text(), a.attributes('aria-current')])).toEqual([
        ['Reclusiarc', undefined],
        ['Librarium', 'page'],
        ['Apothecarion', undefined],
        ['Mechanicus', undefined],
      ])
      await uniforms.findAll('.ah-pick-row')[3].trigger('click')
      await flushPromises()
      expect(uniforms.attributes('open')).toBeUndefined()
      expect(w.get('.ah-title').text()).toBe('Mechanicus')
    })

    it('a marker opens its part in the sheet; the close button shuts it', async () => {
      const w = await mountPage('standard')
      await w.findAll('.ah-hs')[2].trigger('click')
      await flushPromises()
      expect(partSheet(w).attributes('open')).toBe('')
      expect(partSheet(w).get('.ad-title').text()).toBe('Wargear')
      expect(partSheet(w).text()).toContain('///CLASSIFIED///')
      await w.get('.av-close').trigger('click')
      await flushPromises()
      expect(partSheet(w).attributes('open')).toBeUndefined()
    })

    it('names the part sheet by its part, as the uniforms sheet is named', async () => {
      const w = await mountPage('standard')
      expect(partSheet(w).attributes('aria-label')).toBe('Helm details')
      await w.findAll('.av-part')[3].trigger('click')
      await flushPromises()
      expect(partSheet(w).attributes('aria-label')).toBe('Breastplate details')
    })

        it('a thumbnail only chooses its part; the bar opens it', async () => {
      const w = await mountPage('standard')
      await w.findAll('.av-part')[3].trigger('click')
      await flushPromises()
      expect(partSheet(w).attributes('open')).toBeUndefined()
      expect(w.get('.av-bar b').text()).toBe('Breastplate')
      await w.get('.av-bar').trigger('click')
      await flushPromises()
      expect(partSheet(w).attributes('open')).toBe('')
      expect(partSheet(w).get('.ad-title').text()).toBe('Breastplate')
    })

    it('a marker on a wide screen only chooses its part', async () => {
      phone = false
      const w = await mountPage('standard')
      await w.findAll('.ah-hs')[5].trigger('click')
      await flushPromises()
      expect(partSheet(w).attributes('open')).toBeUndefined()
      expect(w.get('.av-detail .ad-title').text()).toBe('Greaves')
    })
  })

  it('Company Heraldry: the companies as a list, the chosen one’s pauldron and greave, the Watch Company markings', async () => {
    const w = await mountPage('standard', 'companyheraldry')
    expect(w.get('.ah-title').text()).toBe('Company Heraldry')
    expect(texts(w, '.av-part span')).toEqual(['1st Company', '2nd Company', '3rd Company', '4th Company', '5th Company', '6th Company', '7th Company'])
    expect(texts(w, '.hv-h')).toEqual(['1st Company', 'Watch Company Markings'])
    const tiles = () => w.findAll('.hv-box')[0].findAll('.ah-tile').map((t) => t.attributes('style'))
    const first = tiles()
    expect(w.get('.av-fig img').attributes('src')).toContain('co-1st.jpg')
    expect(first).toHaveLength(2)
    expect(w.find('.hv-modes').exists()).toBe(false)
    expect(w.findAll('.hv-box')[0].text()).toContain('regular uniform guidelines')
    expect(w.findAll('.wm .ah-tile')).toHaveLength(5)
    // The 5th has an alternative scheme: Standard first, the other tiles and the alternative note on a switch.
    await w.findAll('.av-part')[4].trigger('click')
    expect(w.get('.av-part[aria-current]').text()).toBe('5th Company')
    expect(w.get('.hv-h').text()).toBe('5th Company')
    expect(w.get('.hv-mode[aria-pressed="true"]').text()).toBe('Standard')
    expect(w.get('.av-fig img').attributes('src')).toContain('co-5th.jpg')
    expect(w.get('.av-fig img').attributes('alt')).toBe("Watch Brother armour in the 5th Company's colours, front view")
    const std = tiles()
    expect(std).not.toEqual(first)
    expect(w.findAll('.hv-box')[0].text()).toContain('regular uniform guidelines')
    await w.findAll('.hv-mode')[1].trigger('click')
    expect(w.get('.hv-mode[aria-pressed="true"]').text()).toBe('Alternative')
    expect(tiles()).not.toEqual(std)
    expect(w.findAll('.hv-box')[0].text()).not.toContain('regular uniform guidelines')
    expect(w.get('.av-fig img').attributes('src')).toContain('co-5thalt')
    await w.findAll('.hv-mode')[0].trigger('click')
    expect(tiles()).toEqual(std)
    // Another company starts on its standard scheme again.
    await w.findAll('.hv-mode')[1].trigger('click')
    await w.findAll('.av-part')[5].trigger('click')
    expect(w.get('.hv-mode[aria-pressed="true"]').text()).toBe('Standard')
    await w.findAll('.av-part')[6].trigger('click')
    expect(w.find('.hv-modes').exists()).toBe(false)
  })

  it('Watch Command: the Sergeant is done; its specialists link their Specialist uniform, not the Watch-Brother one', async () => {
    const w = await mountPage('watch-command')
    expect(w.get('.ah-title').text()).toBe('Watch Sergeant')
    expect(w.text()).not.toContain('Reserved')
    expect(w.find('.ah-head .ah-wip').exists()).toBe(false)
    const s = await mountPage('watch-command', 'watchapothecary')
    expect(s.get('.ah-lead').text()).not.toContain('Watch-Brother')
    expect(s.get('.ah-lead a').attributes('href')).toBe('/deathwatch/armouringhall/specialist/apothecarion')
  })

  it('Restricted Wargear: the two locked pieces and how each is unlocked', async () => {
    const w = await mountPage('restricted-wargear')
    expect(w.get('h2').text()).toBe('Restricted Wargear')
    expect(texts(w, '.rw-card > b')).toEqual(['L. Pauldron', 'L. Gauntlet (Heroic)'])
    expect(w.text()).toContain('Previous Tours of Duty also count')
    // No Discord link: its ids may not be in the repo.
    // No Discord link anywhere on the page, head and "Coming soon" included: its ids may not be in the repo.
    expect(w.findAll('a').every((a) => !(a.attributes('href') ?? '').includes('discord'))).toBe(true)
    expect(w.find('.rw a').exists()).toBe(false)
  })

  it('Restricted Wargear: Non-Active Deployment open first, Active Deployment still to come (WIP)', async () => {
    const w = await mountPage('restricted-wargear')
    const modes = () => w.findAll('.rw-mode').map((b) => [b.text(), b.attributes('aria-pressed')])
    expect(modes()).toEqual([
      ['Non-Active Deployment', 'true'],
      ['Active DeploymentWIP', 'false'],
    ])
    await w.findAll('.rw-mode')[1].trigger('click')
    expect(modes().map(([, on]) => on)).toEqual(['false', 'true'])
    expect(w.get('.rw-soon').text()).toBe('Active DeploymentComing soon')
    expect(w.find('.rw-card').exists()).toBe(false)
    await w.findAll('.rw-mode')[0].trigger('click')
    expect(w.findAll('.rw-card')).toHaveLength(2)
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
    // The other parts keep the notes they ship with.
    expect(w.get('.av-detail').text()).toContain('Mask Pattern.')
    await w.findAll('.av-part')[5].trigger('click')
    const greaves = w.get('.av-detail')
    expect(greaves.get('.ad-title').text()).toBe('Greaves')
    expect(texts(greaves, '.ah-nt b')).toEqual(['Left'])
    expect(greaves.get('.ah-nt i').text()).toBe('new')
    expect(greaves.text()).toContain('A plain note')
    expect(greaves.text()).not.toContain('(see Company Heraldry)')
    expect(greaves.find('.ah-chl').exists()).toBe(true)
  })

  it('loads the page texts when they are not there yet, and not again when they are', async () => {
    vi.mocked(getData).mockClear()
    await mountPage('specialist')
    expect(getData).not.toHaveBeenCalled()
    await mountPage('specialist', '', {}, { status: 'idle' })
    expect(getData).toHaveBeenCalled()
  })

  it('Company Heraldry: the notes from the page texts, one for every company, the defaults elsewhere', async () => {
    const tx = { ah_companyheraldry_companies: 'First *note*\nSecond note', ah_companyheraldry_markings: '', ah_companyheraldry_alternative: 'Alt note' }
    const w = await mountPage('standard', 'companyheraldry', {}, { tx })
    const box = (i) => w.findAll('.hv-box')[i]
    expect(texts(box(0), '.hv-note')).toEqual(['First note', 'Second note'])
    expect(box(0).get('.hv-note i').text()).toBe('note')
    expect(box(1).findAll('.hv-note')).toHaveLength(0)
    await w.findAll('.av-part')[4].trigger('click')
    expect(texts(box(0), '.hv-note')).toEqual(['First note', 'Second note'])
    await w.findAll('.hv-mode')[1].trigger('click')
    expect(texts(box(0), '.hv-note')).toEqual(['Alt note'])
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

// Review of #53: a pick is announced in a word, not by reading the whole detail panel out again.
describe('Armouring Hall, announced', () => {
  it('a uniform says which part shows, and its detail panel is not a live region', async () => {
    const w = await mountPage('standard')
    const live = w.findAll('[aria-live]')
    expect(live.map((e) => [e.classes(), e.text()])).toEqual([[['av-live'], 'Showing Helm']])
    await w.findAll('.av-part')[3].trigger('click')
    await flushPromises()
    expect(w.get('.av-live').text()).toBe('Showing Breastplate')
    expect(w.get('.av-detail').attributes('aria-live')).toBeUndefined()
  })

  it('Company Heraldry says which company shows, and its box is not a live region', async () => {
    const w = await mountPage('standard', 'companyheraldry')
    expect(w.findAll('[aria-live]').map((e) => e.classes())).toEqual([['av-live']])
    expect(w.get('.av-live').text()).toMatch(/^Showing the \S+ Company$/)
    expect(w.get('.hv-box').attributes('aria-live')).toBeUndefined()
  })

  it('/watch-command falls back to the Sergeant for the old Watch Specialist address and for a slug it does not know', async () => {
    for (const sub of ['watchspecialist', 'nonsense']) {
      const w = await mountPage('watch-command', sub)
      expect(w.get('.ah-title').text(), sub).toBe('Watch Sergeant')
    }
  })
})
