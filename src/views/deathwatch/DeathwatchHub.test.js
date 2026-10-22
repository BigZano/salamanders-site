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
// The three areas' cards, then the card back to the Salamanders. The Manage entry is a separate button.
const cards = (w) => w.findAll('a.dw-card').map((a) => ({ title: a.find('.dw-card-title').text(), href: a.attributes('href') }))

beforeEach(() => setActivePinia(createPinia()))

describe('DeathwatchHub', () => {
  it('introduces the fortress under its crest', () => {
    const w = mountHub()
    expect(w.find('h1').text()).toBe('Watch Fortress Ebonhold')
    expect(w.text()).toContain('XVIIIth Legiones Astartes, The Salamanders')
    expect(w.text()).toContain('Suffer not the alien to live.')
    expect(w.text()).toContain('Choose your destination')
    const crest = w.find('img.dw-hub-crest')
    expect(crest.attributes('src')).toContain('crest-large')
    expect(crest.attributes('alt')).toBe('Deathwatch crest of Watch Fortress Ebonhold')
    expect(crest.attributes('width')).toBeTruthy()
    expect(crest.attributes('height')).toBeTruthy()
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

  it('paints each area card with its own picture, dimensioned and lazy, with no alt text (the card names it)', () => {
    const arts = mountHub().findAll('a.dw-card img.dw-card-art')
    expect(arts.map((i) => i.attributes('src').match(/card-[a-z]+/)[0])).toEqual(['card-tracker', 'card-armouring', 'card-chronicles'])
    for (const img of arts) {
      expect(img.attributes('alt')).toBe('')
      expect(img.attributes('loading')).toBe('lazy')
      expect(img.attributes('width')).toBeTruthy()
      expect(img.attributes('height')).toBeTruthy()
    }
  })

  it('shows the Salamanders card with the clan icon, below the area cards', () => {
    const w = mountHub()
    const clan = w.find('a.dw-card-home')
    expect(clan.find('img').attributes('src')).toContain('clan')
    expect(clan.find('img').attributes('alt')).toBe('')
    expect(clan.text()).toContain('Back to the main site')
    expect(w.find('ul.dw-hub-cards').find('a.dw-card-home').exists()).toBe(false)
  })

  it('carries the fan-site disclaimer', () => {
    expect(mountHub().text()).toContain('A fan-run page for Warhammer 40,000: Space Marine 2.')
  })

  it('shows the Manage button to the Watch Commander only', () => {
    expect(mountHub({ commander: false }).find('a.dw-manage').exists()).toBe(false)
    const manage = mountHub({ commander: true }).find('a.dw-manage')
    expect(manage.text()).toBe('Manage')
    expect(manage.attributes('href')).toBe('/deathwatch/manage/enter-mission')
    expect(manage.find('svg').attributes('aria-hidden')).toBe('true')
    expect(cards(mountHub({ commander: true })).map((c) => c.title)).not.toContain('Manage')
  })
})
