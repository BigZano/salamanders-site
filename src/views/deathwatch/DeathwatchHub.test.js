// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useDeathwatch } from '../../stores/deathwatch'
import DeathwatchHub from './DeathwatchHub.vue'

function mountHub({ commander = false } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useDeathwatch().$patch({ status: 'allowed', commander })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { template: '<div />' } }] })
  return mount(DeathwatchHub, { global: { plugins: [pinia, router] } })
}
const cards = (w) => w.findAll('a.dw-card').map((a) => ({ title: a.find('.dw-card-title').text(), href: a.attributes('href') }))

beforeEach(() => setActivePinia(createPinia()))

describe('DeathwatchHub', () => {
  it('introduces the fortress', () => {
    const w = mountHub()
    expect(w.find('h1').text()).toBe('Watch Fortress Ebonhold')
    expect(w.text()).toContain('XVIIIth Legiones Astartes, The Salamanders')
    expect(w.text()).toContain('Suffer not the alien to live.')
  })

  it('offers the three areas, each straight to its first tab, and a way back to the Salamanders', () => {
    expect(cards(mountHub())).toEqual([
      { title: 'Event Tracker', href: '/deathwatch/eventtracker/standings' },
      { title: 'Armouring Hall', href: '/deathwatch/armouringhall/standard' },
      { title: 'Chronicles of Valor', href: '/deathwatch/chronicles/hall-of-champions' },
      { title: 'Return to the Salamanders', href: '/' },
    ])
  })

  it("describes each area in the old site's words", () => {
    const text = mountHub().text()
    expect(text).toContain('Standings, Kill Teams, players and honours')
    expect(text).toContain('Specialist armour, standard uniform and heraldry')
    expect(text).toContain('Deeds and honours of the Watch Fortress')
  })

  it('shows the Manage card to the Watch Commander only', () => {
    expect(cards(mountHub({ commander: false })).map((c) => c.title)).not.toContain('Manage')
    const commander = cards(mountHub({ commander: true }))
    expect(commander.map((c) => c.title)).toEqual(['Event Tracker', 'Armouring Hall', 'Chronicles of Valor', 'Manage', 'Return to the Salamanders'])
    expect(commander.find((c) => c.title === 'Manage').href).toBe('/deathwatch/manage/enter-mission')
  })
})
