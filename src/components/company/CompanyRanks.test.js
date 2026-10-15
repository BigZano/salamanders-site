// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import fixture from '../../data/roster.fixture.json'
import { publicRoster } from '../../../server/src/rosterPublic.js'
import { buildRosterView } from '../../lib/rosterView'
import { buildPublicView } from '../../lib/rosterPublicView'
import CompanyRanks from './CompanyRanks.vue'

const full = buildRosterView(fixture.roster).branches
const pub = buildPublicView({ fetchedAt: 'f', stale: false, ...publicRoster(fixture.roster) }).branches
const of = (branches, key) => branches.find((b) => b.key === key)
const render = (props) => mount(CompanyRanks, { props: { branch: null, mode: 'full', loading: false, open: false, ...props } })

describe('CompanyRanks', () => {
  it('holds the place of the bar while the roster loads', () => {
    const w = render({ loading: true, mode: 'none' })
    expect(w.find('.rs-ranks-loading').exists()).toBe(true)
    expect(w.find('article').exists()).toBe(false)
  })

  it('shows nothing when there is no roster to show, or none for this company', () => {
    expect(render({ mode: 'none', branch: of(full, 'company-3') }).find('article').exists()).toBe(false)
    expect(render({ mode: 'none' }).find('.rs-ranks-loading').exists()).toBe(false)
    expect(render({ mode: 'full', branch: null }).html()).not.toContain('article')
  })

  it('in full mode, is an embedded bar over the ladder', () => {
    const w = render({ mode: 'full', branch: of(full, 'company-3') })
    expect(w.find('article').classes()).toEqual(expect.arrayContaining(['rs-branch', 'rs-embedded']))
    expect(w.find('.rs-body .rs-ladder').exists()).toBe(true)
    expect(w.find('.rs-shape').exists()).toBe(false)
  })

  it('in public mode, is an embedded bar over counts, with no ladder', () => {
    const w = render({ mode: 'public', branch: of(pub, 'company-3') })
    expect(w.find('article').classes()).toContain('rs-embedded')
    expect(w.find('.rs-body .rs-shape').exists()).toBe(true)
    expect(w.findAll('.rs-shape-row').length).toBeGreaterThan(0)
    expect(w.find('.rs-ladder').exists()).toBe(false)
  })

  it('opens only a branch that has something to open', async () => {
    const w = render({ mode: 'full', branch: of(full, 'company-3'), open: true })
    expect(w.find('article').attributes('data-open')).toBeDefined()
    const nothing = render({ mode: 'full', branch: of(full, 'venerable-dreadnoughts'), open: true })
    expect(nothing.find('article').attributes('data-open')).toBeUndefined()
  })

  it('passes the bar toggle and the public sign-in up', async () => {
    const w = render({ mode: 'public', branch: of(pub, 'company-3') })
    await w.find('button.rs-bar-btn').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
    await w.find('.rs-shape-signin button').trigger('click')
    expect(w.emitted('sign-in')).toHaveLength(1)
  })
})
