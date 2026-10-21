// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
import { deathwatchRedirect } from '../../lib/deathwatch/redirect'
import { useDeathwatch } from '../../stores/deathwatch'
import DeathwatchArea from './DeathwatchArea.vue'

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
  await flushPromises()
  return { w, router }
}

describe('DeathwatchArea', () => {
  it('shows the area, the current view and the list of views', async () => {
    const { w } = await mountAt('/deathwatch/eventtracker/players')
    expect(w.find('h1').text()).toBe('Event Tracker')
    expect(w.find('h2').text()).toBe('Players')
    expect(w.text()).toContain('This view is being rebuilt.')
    const current = w.find('nav [aria-current="page"]')
    expect(current.text()).toBe('Players')
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
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/deathwatch/eventtracker/standings')
    expect(w.find('h2').text()).toBe('Standings')
  })

  it('keeps the query when it canonicalizes', async () => {
    const { router } = await mountAt('/deathwatch/eventtracker/players')
    await router.push('/deathwatch/eventtracker/bogus?scene=denied')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/deathwatch/eventtracker/standings?scene=denied')
  })

  it('shows Manage to the Watch Commander as any other area', async () => {
    const { w } = await mountAt('/deathwatch/manage', { commander: true })
    expect(w.find('h1').text()).toBe('Manage')
    expect(w.find('h2').text()).toBe('Enter mission')
    expect(w.find('nav').exists()).toBe(true)
  })

  it('shows anyone else a notice in place of the Manage area, with no way into its views', async () => {
    const { w } = await mountAt('/deathwatch/manage/checks', { commander: false })
    expect(w.text()).toContain('Restricted to the Watch Commander.')
    expect(w.find('nav').exists()).toBe(false)
    expect(w.text()).not.toContain('This view is being rebuilt.')
    expect(w.text()).not.toContain('Checks')
  })
})
