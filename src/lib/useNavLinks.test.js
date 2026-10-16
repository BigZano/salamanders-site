// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reactive } from 'vue'

const state = vi.hoisted(() => ({ auth: null, corrections: null }))
vi.mock('../stores/auth', () => ({ useAuth: () => state.auth }))
vi.mock('../stores/perkCorrections', () => ({ usePerkCorrections: () => state.corrections }))
import { useNavLinks } from './useNavLinks'

const labels = (links) => links.value.map((l) => l.label)

beforeEach(() => {
  state.auth = reactive({ member: null })
  state.corrections = reactive({ privileges: null })
})

describe('useNavLinks', () => {
  it('gives a signed-out visitor the five base links', () => {
    expect(labels(useNavLinks())).toEqual(['Home', 'Perk Builder', 'Armoury', 'Builds', 'Companies'])
  })

  it('also gives a member Accolades, Ranks and Reports, in order', () => {
    state.auth.member = { isMember: true }
    const links = useNavLinks()
    expect(labels(links)).toEqual(['Home', 'Perk Builder', 'Armoury', 'Builds', 'Companies', 'Accolades', 'Legacy Accolades', 'Ranks', 'Reports'])
    expect(links.value.find((l) => l.label === 'Reports')).toEqual({ to: '/reports', label: 'Reports', section: true })
    expect(links.value.find((l) => l.label === 'Home').section).toBeUndefined()
  })

  it('has no Roster link for anyone: the roster lives on Companies now', () => {
    for (const member of [null, { isMember: false }, { isMember: true }]) {
      state.auth.member = member
      expect(useNavLinks().value.some((l) => l.to === '/roster' || l.label === 'Roster')).toBe(false)
    }
  })

  it('adds Version History for a historyViewer', () => {
    state.auth.member = { isMember: true }
    state.corrections.privileges = { historyViewer: true }
    const links = useNavLinks()
    expect(labels(links).at(-1)).toBe('Version History')
    expect(links.value.at(-1)).toEqual({ to: '/history', label: 'Version History', section: true })
  })

  it('gives a non-member historyViewer the base links plus Version History only', () => {
    state.auth.member = { isMember: false }
    state.corrections.privileges = { historyViewer: true }
    expect(labels(useNavLinks())).toEqual(['Home', 'Perk Builder', 'Armoury', 'Builds', 'Companies', 'Version History'])
  })

  it('follows sign-in and sign-out', () => {
    const links = useNavLinks()
    expect(labels(links)).not.toContain('Reports')
    state.auth.member = { isMember: true }
    expect(labels(links)).toContain('Reports')
    state.auth.member = null
    expect(labels(links)).not.toContain('Reports')
  })

  it('puts Legacy Accolades right after Accolades for a member, and never shows it to anyone else', () => {
    state.auth.member = { isMember: true }
    const links = useNavLinks()
    expect(links.value.find((l) => l.label === 'Legacy Accolades')).toEqual({ to: '/accolades/legacy', label: 'Legacy Accolades', section: true })
    expect(labels(links).indexOf('Legacy Accolades')).toBe(labels(links).indexOf('Accolades') + 1)
    for (const member of [null, { isMember: false }]) {
      state.auth.member = member
      expect(labels(useNavLinks())).not.toContain('Legacy Accolades')
    }
  })
})
