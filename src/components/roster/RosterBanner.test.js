// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import fixture from '../../data/roster.fixture.json'
import { buildRosterView } from '../../lib/rosterView'
import RosterBanner from './RosterBanner.vue'

const { banner } = buildRosterView(fixture.roster)
const render = (b = banner) => mount(RosterBanner, { props: { banner: b } })

describe('RosterBanner', () => {
  it('is the High Command section, jumpable', () => {
    const root = render().find('section.rs-high-command')
    expect(root.exists()).toBe(true)
    expect(root.attributes('data-jump')).toBe('high-command')
    expect(root.attributes('aria-label')).toBe('High Command')
  })

  it('puts the hero first, with its rank label and id', () => {
    const w = render()
    const first = w.find('li.rs-member')
    expect(first.attributes('data-id')).toBe(banner.hero.member.id)
    expect(first.classes()).toContain('rs-hero')
    expect(w.text()).toContain(banner.hero.rank.label)
  })

  it('renders the court as rank rows with data-rank and no data-tier', () => {
    const rows = render().findAll('.rs-row')
    expect(rows.length).toBe(1 + banner.court.length)
    expect(rows.every((r) => r.attributes('data-rank') && r.attributes('data-tier') === undefined)).toBe(true)
    expect(render().text()).toContain('Lord Chaplain')
  })

  it('renders nothing when nobody holds High Command', () => {
    expect(render({ hero: null, court: [] }).find('.rs-high-command').exists()).toBe(false)
  })
})
