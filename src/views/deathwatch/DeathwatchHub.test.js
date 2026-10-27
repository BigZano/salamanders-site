// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useDeathwatch } from '../../stores/deathwatch'
import DeathwatchHub from './DeathwatchHub.vue'
import source from './DeathwatchHub.vue?raw'

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

  it('offers the four areas, each straight to its first tab', () => {
    expect(cards(mountHub())).toEqual([
      { title: 'Event Tracker', href: '/deathwatch/eventtracker/standings' },
      { title: 'Armouring Hall', href: '/deathwatch/armouringhall/standard/watchbrother' },
      { title: 'Chronicles of Valor', href: '/deathwatch/chronicles/hall-of-champions' },
      { title: 'Hall of Relics', href: '/deathwatch/hallofrelics/notable-members' },
    ])
  })

  it('describes each area in one line', () => {
    const text = mountHub().text()
    expect(text).toContain('Track events, standings, and your kill team’s progress.')
    expect(text).toContain('Explore armour sets, chapter colours, and heraldry.')
    expect(text).toContain('Discover the deeds, victories, and honours of the Watch.')
    expect(text).toContain('Honour the warriors who shaped the history of Ebonhold.')
  })

  it('paints each area card with its own picture, dimensioned and lazy, with no alt text (the card names it)', () => {
    const arts = mountHub().findAll('a.dw-card img.dw-card-art')
    expect(arts.map((i) => i.attributes('src').match(/card-[a-z]+/)[0])).toEqual(['card-tracker', 'card-armouring', 'card-chronicles', 'card-relics'])
    for (const img of arts) {
      expect(img.attributes('alt')).toBe('')
      expect(img.attributes('loading')).toBe('lazy')
      expect(img.attributes('width')).toBeTruthy()
      expect(img.attributes('height')).toBeTruthy()
    }
  })

  it('calls to enlist under the area cards, with a button to Recruitment', () => {
    const w = mountHub()
    const call = w.get('.dw-call')
    expect(call.get('.dw-call-t').text()).toBe('The Watch needs you')
    const btn = call.get('a.dw-call-btn')
    expect(btn.text()).toBe('Enlist now')
    expect(btn.attributes('href')).toBe('/deathwatch/recruitment/terms-of-service')
    expect(call.get('img').attributes('alt')).toBe('')
    expect(w.find('ul.dw-hub-cards').find('.dw-call').exists()).toBe(false)
  })

  it('leaves the fan-site disclaimer to the site footer', () => {
    expect(mountHub().find('.dw-legal').exists()).toBe(false)
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

// jsdom lays nothing out, so these are held by the rules; the widths were measured in a browser at 320 to 500px.
describe('DeathwatchHub styles', () => {
  const style = source.slice(source.indexOf('<style'))
  const rule = (selector, at = 0) => {
    const from = style.indexOf(`${selector} {`, at)
    return from < 0 ? '' : style.slice(from, style.indexOf('}', from))
  }

  // The cards' corners are clipped, which also clips an outline drawn outside them.
  it("shows a card's keyboard focus ring inside its clipped corners", () => {
    const ring = rule('.dw-card:focus-visible')
    expect(ring).toMatch(/outline:\s*2px solid/)
    expect(Number(ring.match(/outline-offset:\s*(-?\d+)px/)?.[1])).toBeLessThan(0)
    expect(rule('.dw-card')).toContain('clip-path')
  })

  it('gives the picture less of the card on a narrow phone, so the longest name fits beside the arrow', () => {
    const narrow = style.indexOf('@media (max-width: 420px)')
    expect(narrow).toBeGreaterThan(0)
    const wide = Number(rule('.dw-card').match(/grid-template-columns:\s*(\d+)%/)?.[1])
    const small = Number(rule('.dw-card', narrow).match(/grid-template-columns:\s*(\d+)%/)?.[1])
    expect(small).toBeLessThan(wide)
    expect(small).toBeLessThanOrEqual(38)
  })

  it('makes the Enlist button a full 44px tap target', () => {
    expect(rule('.dw-call-btn')).toMatch(/min-height:\s*44px/)
  })
})
