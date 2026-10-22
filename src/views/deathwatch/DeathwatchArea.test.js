// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
import { deathwatchRedirect } from '../../lib/deathwatch/redirect'
import { useDeathwatch } from '../../stores/deathwatch'
import DeathwatchArea from './DeathwatchArea.vue'

// A view is loaded lazily by the registry (lib/deathwatch/pages.js). A test can make the registry fail, or find
// nothing, for the address it opens; otherwise this is the real registry.
const override = vi.hoisted(() => ({ loader: undefined }))
vi.mock('../../lib/deathwatch/pages', async (importOriginal) => {
  const real = await importOriginal()
  return { pageLoader: (area, tab) => (override.loader === undefined ? real.pageLoader(area, tab) : override.loader) }
})

// Lets the lazily imported view arrive and render.
async function settle() {
  await flushPromises()
  await vi.dynamicImportSettled()
  await flushPromises()
}

// The area route as production declares it (router.js): the view as the component, and the same global guard.
async function mountAt(path, { commander = false } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useDeathwatch().$patch({ status: 'allowed', commander })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/deathwatch/:area/:tab?/:sub?', name: 'deathwatch-area', component: DeathwatchArea },
      { path: '/:rest(.*)*', component: { template: '<div />' } },
    ],
  })
  router.beforeEach(deathwatchRedirect)
  router.push(path)
  await router.isReady()
  const w = mount({ render: () => h(RouterView) }, { global: { plugins: [pinia, router] } })
  await settle()
  return { w, router }
}

// jsdom has no modal <dialog> or matchMedia, which the bottom sheet uses (see DeathwatchNavSheet.test.js).
let reduced
beforeEach(() => {
  reduced = false
  override.loader = undefined
  HTMLDialogElement.prototype.showModal = vi.fn(function () {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function () {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  })
  window.matchMedia = vi.fn(() => ({ matches: reduced }))
})

describe('DeathwatchArea', () => {
  it('shows the area, the current view and the list of views', async () => {
    const { w } = await mountAt('/deathwatch/eventtracker/players')
    expect(w.find('h1').text()).toBe('Event Tracker')
    expect(w.find('h2').text()).toBe('Players')
    expect(w.text()).toContain('This view is being rebuilt.')
    const current = w.find('nav [aria-current="page"]')
    expect(current.text()).toBe('Players')
  })

  it('draws the view inside the framed panel, and the rail beside it', async () => {
    const { w } = await mountAt('/deathwatch/eventtracker/standings')
    expect(w.find('.dw-area-sheet.dw-panel h2.dw-plaque').text()).toBe('Standings')
    const rail = w.find('aside.dw-area-side')
    expect(rail.find('img.dw-area-crest').attributes('alt')).toBe('')
    expect(rail.text()).toContain('Watch Fortress Ebonhold')
    expect(rail.find('h1').text()).toBe('Event Tracker')
    expect(rail.find('nav [aria-current="page"]').text()).toBe('Standings')
  })

  it('carries the fan-site disclaimer under the sheet, on every area', async () => {
    for (const path of ['/deathwatch/eventtracker/standings', '/deathwatch/armouringhall/standard', '/deathwatch/chronicles/in-memoriam']) {
      const { w } = await mountAt(path)
      expect(w.find('.dw-area-main .dw-legal').text(), path).toContain('Not affiliated with or endorsed by Games Workshop')
    }
  })

  it('shows a status line, and keeps the list of views, when the view cannot be loaded', async () => {
    override.loader = () => Promise.reject(new Error('chunk failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {}) // Vue logs a failed lazy view; that is expected here
    const { w } = await mountAt('/deathwatch/eventtracker/players')
    expect(w.find('.dw-area-sheet [role="alert"]').text()).toBe('This view could not be loaded. Try again.')
    expect(w.find('aside nav [aria-current="page"]').text()).toBe('Players')
  })

  it('says the view is being rebuilt when the registry has none for the address', async () => {
    override.loader = null
    const { w } = await mountAt('/deathwatch/eventtracker/players')
    expect(w.find('.dw-area-sheet [role="status"]').text()).toBe('This view is being rebuilt.')
  })

  it('works for every area', async () => {
    for (const [path, area, tab] of [
      ['/deathwatch/armouringhall/specialist', 'Armouring Hall', 'Specialist'],
      ['/deathwatch/chronicles/in-memoriam', 'Chronicles of Valor', 'In Memoriam'],
    ]) {
      const { w } = await mountAt(path)
      expect(w.find('h1').text(), path).toBe(area)
      expect(w.find('h2').text(), path).toBe(tab)
    }
  })

  it('keeps the address canonical when only the tab changes', async () => {
    const { w, router } = await mountAt('/deathwatch/eventtracker/players')
    await router.push('/deathwatch/eventtracker/bogus')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/deathwatch/eventtracker/standings')
    expect(w.find('h2').text()).toBe('Standings')
  })

  it('keeps the query when it canonicalizes', async () => {
    const { router } = await mountAt('/deathwatch/eventtracker/players')
    await router.push('/deathwatch/eventtracker/bogus?scene=denied')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/deathwatch/eventtracker/standings?scene=denied')
  })

  it('shows Manage to the Watch Commander as any other area', async () => {
    const { w } = await mountAt('/deathwatch/manage', { commander: true })
    expect(w.find('h1').text()).toBe('Manage')
    expect(w.find('h2').text()).toBe('Enter mission')
    expect(w.find('nav').exists()).toBe(true)
  })

  it('puts the views behind a bar on a phone, with the same list in a sheet', async () => {
    const { w } = await mountAt('/deathwatch/eventtracker/players')
    const bar = w.find('button.dw-areabar')
    expect(bar.text()).toContain('Event Tracker')
    expect(bar.text()).toContain('Players')
    expect(w.findAll('nav')).toHaveLength(2) // the sidebar and the sheet's copy: the stylesheet shows one of them
    expect(w.find('dialog nav [aria-current="page"]').text()).toBe('Players')
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled()
    expect(bar.attributes('aria-expanded')).toBe('false')

    await bar.trigger('click')
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1)
    expect(bar.attributes('aria-expanded')).toBe('true')
  })

  it('closes the sheet when a view is chosen in it', async () => {
    reduced = true // so the close is immediate
    const { w } = await mountAt('/deathwatch/eventtracker/players')
    await w.find('button.dw-areabar').trigger('click')
    await w.find('dialog nav a').trigger('click')
    await settle()
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1)
    expect(w.find('button.dw-areabar').attributes('aria-expanded')).toBe('false')
  })

  it('shows anyone else a notice in place of the Manage area, with no way into its views', async () => {
    const { w } = await mountAt('/deathwatch/manage/checks', { commander: false })
    expect(w.text()).toContain('Restricted to the Watch Commander.')
    expect(w.find('nav').exists()).toBe(false)
    expect(w.text()).not.toContain('This view is being rebuilt.')
    expect(w.text()).not.toContain('Checks')
    expect(w.find('button.dw-areabar').exists()).toBe(false)
    expect(w.find('dialog').exists()).toBe(false)
  })
})
