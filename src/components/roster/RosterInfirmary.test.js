// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import fixture from '../../data/roster.fixture.json'
import RosterInfirmary from './RosterInfirmary.vue'

const infirmary = fixture.infirmary
const render = (props) => mount(RosterInfirmary, { props })

describe('RosterInfirmary', () => {
  it('is the Infirmary section with its title', () => {
    const w = render({ status: 'ready', infirmary })
    expect(w.find('section.rs-infirmary').exists()).toBe(true)
    expect(w.find('h2').text()).toBe('Infirmary')
  })

  it('says it is loading until the list arrives', () => {
    expect(render({ status: 'idle', infirmary: null }).text()).toContain('Loading…')
  })

  it('explains a refusal and a failure, as alerts', () => {
    const denied = render({ status: 'denied', infirmary: null })
    expect(denied.find('[role="alert"]').text()).toBe('The Infirmary list is open to company command and above.')
    const failed = render({ status: 'error', infirmary: null })
    expect(failed.find('[role="alert"]').text()).toBe('The Infirmary list could not be loaded.')
  })

  it('shows the count and one member chip per person', () => {
    const w = render({ status: 'ready', infirmary })
    expect(w.text()).toContain(`${infirmary.count} on leave`)
    expect(w.findAll('.rs-member')).toHaveLength(infirmary.members.length)
  })

  it('shows a rank when there is one, and flags who still holds the Legion role', () => {
    const w = render({ status: 'ready', infirmary })
    const still = infirmary.members.find((m) => m.legion)
    const clear = infirmary.members.find((m) => !m.legion)
    expect(w.find(`[data-id="${still.id}"]`).text()).toContain('Still holds the Legion role')
    expect(w.find(`[data-id="${clear.id}"]`).text()).not.toContain('Still holds the Legion role')
    const ranked = infirmary.members.find((m) => m.rank)
    expect(w.find(`[data-id="${ranked.id}"] .rs-rank`).text()).toBe(ranked.rank.label)
  })
})
