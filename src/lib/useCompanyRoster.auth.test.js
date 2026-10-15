// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// The REAL auth store, over a stand-in for the Discord storage. The bug this pins lives in the store's
// `token` getter, which caches its first value; a plain-object mock of the store cannot show it, which is
// why useCompanyRoster.test.js (mocked auth) did not catch it.
const discord = vi.hoisted(() => ({ stored: null }))
vi.mock('./discordAuth', () => ({
  currentMember: () => (discord.stored ? { id: '200000000000000001', username: 'tester', isMember: true, checkedAt: 0 } : null),
  getAccessToken: () => discord.stored?.accessToken ?? null,
  signOut: () => {
    discord.stored = null
  },
  beginSignIn: vi.fn(),
}))
vi.mock('./rosterApi', () => ({ getRoster: vi.fn(), getInfirmary: vi.fn(), getPublicRoster: vi.fn() }))
import * as api from './rosterApi'
import { useAuth } from '../stores/auth'
import { useCompanyRoster } from './useCompanyRoster'

const rank = { key: 'captain', label: 'Captain', tier: 1 }
const ROSTER = {
  fetchedAt: '2026-01-01T12:00:00.000Z',
  stale: false,
  viewer: { infirmary: true },
  highCommand: [],
  branches: [{ key: 'company-3', kind: 'company', label: '3rd Battle Company', number: 3, head: { rank, members: [{ id: '900000000000000001', name: 'Cap', avatar: null, company: 3 }], vacant: false }, aside: [], rows: [] }],
  unassigned: { rows: [] },
  servitors: [],
}
const PUBLIC = {
  fetchedAt: '2026-01-01T12:00:00.000Z',
  stale: false,
  highCommand: [],
  branches: [{ key: 'company-3', kind: 'company', label: '3rd Battle Company', number: 3, head: { rank, vacant: false, members: [{ name: 'Cap' }] }, aside: 0, rows: [] }],
}

const hosts = []
function host(opts = {}) {
  let roster
  const w = mount({ setup() { roster = useCompanyRoster({ infirmaryOpen: ref(false), ...opts }); return () => null } })
  hosts.push(w)
  return roster
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  discord.stored = { accessToken: 'old-token' }
  api.getRoster.mockResolvedValue(ROSTER)
  api.getInfirmary.mockResolvedValue({ count: 0, members: [] })
  api.getPublicRoster.mockResolvedValue(PUBLIC)
})
afterEach(() => {
  hosts.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
})

describe('useCompanyRoster over the real auth store', () => {
  it('asks for the roster with the member’s token while signed in', async () => {
    const roster = host()
    roster.start()
    await flushPromises()
    expect(roster.mode.value).toBe('full')
    expect(api.getRoster).toHaveBeenCalledWith('old-token')
  })

  it('after signing out, never sends the old token again, and shows the public view (Critical)', async () => {
    vi.useFakeTimers()
    const auth = useAuth()
    const roster = host()
    roster.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(roster.mode.value).toBe('full')

    auth.signOut() // clears the stored token, the member and the roster store
    await vi.advanceTimersByTimeAsync(0)

    expect(roster.mode.value).toBe('public')
    expect(roster.view.value.branches[0].shape).toBeDefined() // counts, not ladders
    expect(api.getRoster).toHaveBeenCalledTimes(1) // no second request, with the stale token or any other
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(api.getRoster).toHaveBeenCalledTimes(1)
    expect(api.getPublicRoster).toHaveBeenCalledTimes(1)
  })

  it('does not fetch the Infirmary with a stale token after signing out either', async () => {
    const auth = useAuth()
    const roster = host()
    roster.start()
    await flushPromises()
    auth.signOut()
    await flushPromises()
    api.getInfirmary.mockClear()
    await roster.loadInfirmary()
    expect(api.getInfirmary).not.toHaveBeenCalledWith('old-token')
  })
})
