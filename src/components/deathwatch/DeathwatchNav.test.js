// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { AREAS } from '../../lib/deathwatch/areas'
import DeathwatchNav from './DeathwatchNav.vue'

const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { template: '<div />' } }] })
const mountNav = (props) => mount(DeathwatchNav, { props, global: { plugins: [router()] } })

describe('DeathwatchNav', () => {
  it.each(Object.keys(AREAS))('lists the %s tabs in order, as links', (area) => {
    const w = mountNav({ area, current: AREAS[area].tabs[0].slug })
    const tabLinks = w.findAll('a').slice(0, -1) // the last link goes back to the hub
    expect(tabLinks.map((a) => a.text())).toEqual(AREAS[area].tabs.map((t) => t.label))
    expect(tabLinks.map((a) => a.attributes('href'))).toEqual(AREAS[area].tabs.map((t) => `/deathwatch/${area}/${t.slug}`))
  })

  it('is a labelled navigation landmark for its area', () => {
    const w = mountNav({ area: 'eventtracker', current: 'standings' })
    expect(w.find('nav').attributes('aria-label')).toBe('Event Tracker sections')
    expect(mountNav({ area: 'chronicles', current: 'in-memoriam' }).find('nav').attributes('aria-label')).toBe('Chronicles of Valor sections')
  })

  it('marks the current tab, and only that one', () => {
    const w = mountNav({ area: 'eventtracker', current: 'players' })
    const current = w.findAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0].text()).toBe('Players')
  })

  it('ends with a way back to the fortress', () => {
    const w = mountNav({ area: 'eventtracker', current: 'standings' })
    const back = w.findAll('a').at(-1)
    expect(back.text()).toBe('Back to the Fortress')
    expect(back.attributes('href')).toBe('/deathwatch')
    expect(back.attributes('aria-current')).toBeUndefined()
  })

  it('says when a link was used, so a sheet around it can close', async () => {
    const w = mountNav({ area: 'eventtracker', current: 'standings' })
    await w.findAll('a')[2].trigger('click')
    await w.findAll('a').at(-1).trigger('click')
    expect(w.emitted('navigate')).toHaveLength(2)
  })
})
