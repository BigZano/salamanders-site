// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import History from './History.vue'

vi.mock('../lib/perksApi', () => ({
  getHistory: vi.fn(),
  revokePrivileges: vi.fn(),
  reinstatePrivileges: vi.fn(),
}))

vi.mock('../stores/auth', () => ({
  useAuth: vi.fn(() => ({
    token: 'tok',
    signedIn: true,
    member: { id: '1', username: 'test' },
  })),
}))

vi.mock('../stores/perkCorrections', () => ({
  usePerkCorrections: vi.fn(() => ({
    privileges: { revoker: true },
    revert: vi.fn(),
  })),
}))

describe('History.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('drops stale responses: second load wins over first', async () => {
    const { getHistory } = await import('../lib/perksApi')
    let resolve1, resolve2
    const promise1 = new Promise((r) => {
      resolve1 = r
    })
    const promise2 = new Promise((r) => {
      resolve2 = r
    })

    getHistory.mockImplementation(() => promise1)
    const wrapper = mount(History)

    // Change filter to trigger second load
    await wrapper.vm.$nextTick()
    getHistory.mockImplementationOnce(() => promise2)
    wrapper.vm.subject = 'perk_correction'

    // Resolve second (newer) response first
    resolve2({
      events: [{ id: '2', subject: 'perk_correction', action: 'created', actor: { id: '1', username: 'test' }, snapshot: { perkName: 'New' } }],
      revocations: [],
      next: null,
    })
    await new Promise((r) => setTimeout(r, 0))

    // Resolve first (older) response
    resolve1({
      events: [{ id: '1', subject: 'perk_correction', action: 'created', actor: { id: '1', username: 'test' }, snapshot: { perkName: 'Old' } }],
      revocations: [],
      next: null,
    })
    await new Promise((r) => setTimeout(r, 0))

    // Second response should be displayed (ID '2', not '1')
    expect(wrapper.vm.events).toHaveLength(1)
    expect(wrapper.vm.events[0].id).toBe('2')
  })

  it('disables Older button while loading', async () => {
    const { getHistory } = await import('../lib/perksApi')
    let resolve1
    const promise1 = new Promise((r) => {
      resolve1 = r
    })

    getHistory.mockReturnValueOnce(promise1)
    const wrapper = mount(History)
    resolve1({
      events: [],
      revocations: [],
      next: 'cursor123',
    })
    await new Promise((r) => setTimeout(r, 10))
    await wrapper.vm.$nextTick()

    // Now trigger a second load with a pending promise
    let resolve2
    const promise2 = new Promise((r) => {
      resolve2 = r
    })
    getHistory.mockReturnValueOnce(promise2)

    wrapper.vm.load(true)
    await wrapper.vm.$nextTick()

    // Loading state should be true while request is pending
    expect(wrapper.vm.loading).toBe(true)

    resolve2({
      events: [],
      revocations: [],
      next: null,
    })
    await new Promise((r) => setTimeout(r, 10))
    await wrapper.vm.$nextTick()

    // Loading state should be false after request completes
    expect(wrapper.vm.loading).toBe(false)
  })
})
