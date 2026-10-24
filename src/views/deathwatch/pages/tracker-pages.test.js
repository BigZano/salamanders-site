// @vitest-environment jsdom
// The rebuilt Event Tracker views, mounted on the invented fixture data: each shows the original's
// headings and its data, and links between the views carry the dev ?scene=.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
vi.mock('../../../lib/deathwatch/api', () => ({ getMe: vi.fn(), getData: vi.fn(), writeDoc: vi.fn() }))
import { getData } from '../../../lib/deathwatch/api'
import { fixtureData } from '../../../lib/deathwatch/fixtureData'
import { calc } from '../../../lib/deathwatch/tracker'
import { useDeathwatch } from '../../../stores/deathwatch'
import { useDeathwatchData } from '../../../stores/deathwatchData'

const PAGES = import.meta.glob('./*/*.vue', { eager: true })
let pinia

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  // Fresh and in-memory, so the views neither fetch nor reach a server.
  useDeathwatchData().$patch({ status: 'ready', ...fixtureData(), local: true })
  useDeathwatch().$patch({ status: 'allowed', commander: true })
})

async function mountPage(key, query = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] })
  await router.push({ path: `/deathwatch/${key}`, query })
  const w = mount(PAGES[`./${key}.vue`].default, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { w, router }
}
const h2 = (w) => w.findAll('h2').map((h) => h.text())
const R = () => calc(useDeathwatchData().teams)

describe('Event Tracker', () => {
  it('Standings: podium, table, chart and companies, leader first', async () => {
    const { w } = await mountPage('eventtracker/standings', { scene: 'commander' })
    expect(h2(w)).toEqual(['Standings', 'Points progression', 'Watch Companies'])
    expect(w.findAll('.pod-card')).toHaveLength(3)
    expect(w.find('tbody tr').text()).toContain(R().ts[0].n)
    expect(w.find('.pc-svg').exists()).toBe(true)
    // A team link opens its profile and keeps the dev scene.
    expect(w.find('tbody a').attributes('href')).toMatch(/^\/deathwatch\/eventtracker\/kill-teams\?scene=commander&t=\d+$/)
  })

  it('Standings: the chart turns into a table', async () => {
    const { w } = await mountPage('eventtracker/standings')
    await w.findAll('.pc-modes button').at(3).trigger('click')
    expect(w.findAll('table')).toHaveLength(3)
  })

  it('Standings: the Watch Commander can copy the standings for Discord', async () => {
    const { w } = await mountPage('eventtracker/standings')
    await w.findAll('button').find((b) => b.text() === 'Share to Discord').trigger('click')
    expect(w.find('textarea').element.value).toContain('Deathwatch Event – Standings')
  })

  it('Standings: with no running event, points to the Archive', async () => {
    useDeathwatchData().teams = {}
    const { w } = await mountPage('eventtracker/standings')
    expect(w.find('.dw-empty').text()).toContain('No event is running')
  })

  it('Kill Teams: the team in ?t, with its players, weeks and missions', async () => {
    const { w } = await mountPage('eventtracker/kill-teams', { t: '2' })
    expect(h2(w)).toEqual(['Kill Team profile', 'Players', 'Points per week', 'Missions'])
    expect(w.find('select').element.value).toBe('2')
    expect(w.findAll('table')).toHaveLength(3)
  })

  it('Kill Teams: picking another team changes ?t', async () => {
    const { w, router } = await mountPage('eventtracker/kill-teams')
    await w.find('select').setValue('3')
    await flushPromises()
    expect(router.currentRoute.value.query.t).toBe('3')
  })

  it('Players: ranked by MVP, and a profile in ?p', async () => {
    const { w } = await mountPage('eventtracker/players')
    expect(w.find('tbody tr').text()).toContain(R().pl[0].n)
    const name = R().pl[0].n
    const { w: p } = await mountPage('eventtracker/players', { p: name })
    expect(p.find('.ppn').text()).toBe(name)
    expect(h2(p)).toEqual(['Player profile', 'Missions'])
  })

  it('Players: a fallen player carries the KIA tag', async () => {
    const { w } = await mountPage('eventtracker/kill-teams', { t: '4' })
    expect(w.find('.dw-tag.kia').text()).toBe('KIA W2')
  })

  it('Honour Roll: the champion and every award', async () => {
    const { w } = await mountPage('eventtracker/honour-roll')
    expect(h2(w)).toEqual(['Honour Roll', 'Kill Team awards'])
    expect(w.find('.dw-tile-who').text()).toBe(R().ts[0].n)
    expect(w.findAll('.dw-tile')).toHaveLength(1 + 8 + 8)
  })

  it('Game Stats: totals, per team and classes', async () => {
    const { w } = await mountPage('eventtracker/game-stats')
    expect(h2(w)).toEqual(['Game Stats', 'Per Kill Team', 'Classes', 'Class mix per Kill Team'])
  })

  it('Scoring: the rules from the weights, best mission included', async () => {
    useDeathwatchData().$patch({ cfg: { s: { base: 400 } } })
    const { w } = await mountPage('eventtracker/scoring')
    expect(h2(w)).toEqual(['Event points per mission', 'Best possible mission', 'MVP score per objective'])
    expect(w.find('.total').text()).toContain('875') // 400 + 200 + 100 + 75 + 100
  })

  it('Archive: the list, then an event with its own views', async () => {
    const { w } = await mountPage('eventtracker/archive')
    expect(w.findAll('.ev')).toHaveLength(1)
    const { w: e } = await mountPage('eventtracker/archive', { e: 'e1', v: 'honour-roll' })
    expect(h2(e)[0]).toBe('Deathwatch Tour — Ash Season')
    expect(e.find('nav [aria-current="page"]').text()).toBe('Honour Roll')
    expect(e.findAll('nav a').map((a) => a.attributes('href'))[1]).toBe('/deathwatch/eventtracker/archive?e=e1&v=kill-teams')
  })

  it('Archive: an unknown event shows the list', async () => {
    const { w } = await mountPage('eventtracker/archive', { e: '__proto__' })
    expect(h2(w)).toEqual(['Archive'])
  })

  it('shows the error with a retry when the data could not be loaded', async () => {
    getData.mockRejectedValueOnce(new Error('Restricted to the Deathwatch.'))
    useDeathwatchData().$patch({ status: 'idle', local: false })
    const { w } = await mountPage('eventtracker/players')
    expect(w.get('[role="alert"]').text()).toContain('Restricted to the Deathwatch.')
  })
})
