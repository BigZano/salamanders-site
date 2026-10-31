// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import * as buildsApi from '../lib/buildsApi'
import { useAuth } from '../stores/auth'
import Builds from './Builds.vue'

vi.mock('../lib/buildsApi', () => ({ listBuilds: vi.fn(), getModeratorStatus: vi.fn() }))

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)', component: { render: () => null } }] })

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.mocked(buildsApi.listBuilds).mockReset()
  vi.mocked(buildsApi.getModeratorStatus).mockReset().mockResolvedValue(false)
})

/** A visitor who is signed in when the page loads (the auth store reads this when it is created). */
function signInAs(token = 'token-abc') {
  localStorage.setItem(
    'salamanders-discord-member',
    JSON.stringify({ id: '300000000000000099', username: 'tester', isMember: false, checkedAt: Date.now(), accessToken: token, expiresAt: Date.now() + 3_600_000 }),
  )
  setActivePinia(createPinia())
}

/** A build as GET /builds returns it. `member` is left out entirely when undefined, as for a signed-out request. */
function aBuild(title, member) {
  const author = { id: '300000000000000001', displayName: 'Tester' }
  if (member !== undefined) author.member = member
  return { id: `id-${title}`, title, className: 'Tactical', level: 25, prestige: 0, perks: [], weapons: {}, author }
}

const signedOutList = () => [aBuild('Alpha'), aBuild('Beta'), aBuild('Gamma')]
const signedInList = () => [aBuild('Alpha', true), aBuild('Beta', false), aBuild('Gamma', true)]

const headings = (w) => w.findAll('.b-section-title').map((h) => h.text())
const titlesIn = (w, heading) =>
  w
    .findAll('.b-section')
    .find((s) => s.find('.b-section-title').text() === heading)
    .findAll('.b-name')
    .map((n) => n.text())

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function open() {
  const wrapper = mount(Builds, { global: { plugins: [router], stubs: { BuildsPager: true } } })
  await router.isReady()
  await flushPromises()
  return wrapper
}

describe('Builds when the server cannot be reached', () => {
  it('says so in plain words instead of showing the browser error', async () => {
    buildsApi.listBuilds.mockRejectedValue(new TypeError('Failed to fetch'))
    const w = await open()
    const error = w.find('.b-error')
    expect(error.exists()).toBe(true)
    expect(error.text()).not.toContain('Failed to fetch')
    expect(error.text()).toContain('did not answer')
  })

  it('does the same when the API answers with a failure', async () => {
    buildsApi.listBuilds.mockRejectedValue(Object.assign(new Error('Request failed (500)'), { status: 500 }))
    const w = await open()
    expect(w.find('.b-error').text()).not.toContain('Request failed')
  })

  it('offers a Retry that loads again and clears the error', async () => {
    buildsApi.listBuilds.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce([])
    const w = await open()
    await w.find('.b-error button').trigger('click')
    await flushPromises()
    expect(buildsApi.listBuilds).toHaveBeenCalledTimes(2)
    expect(w.find('.b-error').exists()).toBe(false)
    expect(w.find('.b-empty').exists()).toBe(true)
  })
})

describe('Builds groups by the server\'s member flag', () => {
  it('signed out: one Community Builds section and no badge', async () => {
    buildsApi.listBuilds.mockResolvedValue(signedOutList())
    const w = await open()
    expect(headings(w)).toEqual(['Community Builds'])
    expect(titlesIn(w, 'Community Builds')).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(w.find('.b-member-badge').exists()).toBe(false)
    expect(w.text()).not.toContain('Verified Members')
  })

  it('signed in: flagged authors are under Verified Members with the badge', async () => {
    signInAs()
    buildsApi.listBuilds.mockResolvedValue(signedInList())
    const w = await open()
    expect(headings(w)).toEqual(['Verified Members', 'Community Builds'])
    expect(titlesIn(w, 'Verified Members')).toEqual(['Alpha', 'Gamma'])
    expect(titlesIn(w, 'Community Builds')).toEqual(['Beta'])
    const [verified, community] = w.findAll('.b-section')
    expect(verified.findAll('.b-member-badge')).toHaveLength(2)
    expect(community.find('.b-member-badge').exists()).toBe(false)
  })

  it('signed in but nobody on the page is flagged: no Verified Members section', async () => {
    signInAs()
    buildsApi.listBuilds.mockResolvedValue([aBuild('Alpha', false), aBuild('Beta', false)])
    const w = await open()
    expect(headings(w)).toEqual(['Community Builds'])
    expect(w.find('.b-member-badge').exists()).toBe(false)
  })

  it('does not take a member flag that is not exactly true', async () => {
    signInAs()
    buildsApi.listBuilds.mockResolvedValue([aBuild('Alpha', 'true'), aBuild('Beta', 1), aBuild('Gamma', null)])
    const w = await open()
    expect(headings(w)).toEqual(['Community Builds'])
    expect(w.find('.b-member-badge').exists()).toBe(false)
  })

  it('signing out while the page is open reloads the list and the badges disappear', async () => {
    signInAs()
    // Like the server: the flag only comes back to a request that carries a token.
    buildsApi.listBuilds.mockImplementation(async (_className, token) => (token ? signedInList() : signedOutList()))
    const w = await open()
    expect(headings(w)).toEqual(['Verified Members', 'Community Builds'])
    expect(w.find('.b-member-badge').exists()).toBe(true)

    useAuth().signOut()
    await flushPromises()

    expect(headings(w)).toEqual(['Community Builds'])
    expect(titlesIn(w, 'Community Builds')).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(w.find('.b-member-badge').exists()).toBe(false)
    expect(w.text()).not.toContain('Verified Members')
    expect(buildsApi.listBuilds.mock.calls.at(-1)[1]).toBeFalsy()
  })

  it('the list is requested with the token when signed in', async () => {
    signInAs('token-xyz')
    buildsApi.listBuilds.mockResolvedValue(signedInList())
    await open()
    expect(buildsApi.listBuilds).toHaveBeenCalledWith(undefined, 'token-xyz')
  })
})

// Requests can finish in any order. Only the most recent one may touch the page.
describe('Builds when answers arrive out of order', () => {
  /** Signed in with a flagged list still in flight, then sign out so a second, newer request starts. */
  async function signOutWhileFirstIsInFlight() {
    signInAs()
    const older = deferred()
    const newer = deferred()
    buildsApi.listBuilds.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const w = await open()
    useAuth().signOut()
    await flushPromises()
    return { w, older, newer }
  }

  it('an older answer arriving late never replaces a newer one', async () => {
    const { w, older, newer } = await signOutWhileFirstIsInFlight()
    newer.resolve(signedOutList())
    await flushPromises()
    expect(headings(w)).toEqual(['Community Builds'])

    older.resolve(signedInList())
    await flushPromises()

    expect(headings(w)).toEqual(['Community Builds'])
    expect(titlesIn(w, 'Community Builds')).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(w.find('.b-member-badge').exists()).toBe(false)
    expect(w.text()).not.toContain('Verified Members')
  })

  it('an older error arriving late never replaces a newer list with an error banner', async () => {
    const { w, older, newer } = await signOutWhileFirstIsInFlight()
    newer.resolve(signedOutList())
    await flushPromises()

    older.reject(new TypeError('Failed to fetch'))
    await flushPromises()

    expect(w.find('.b-error').exists()).toBe(false)
    expect(headings(w)).toEqual(['Community Builds'])
    expect(titlesIn(w, 'Community Builds')).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('an older answer arriving while the newer one is still waiting does not end the loading state or show its list', async () => {
    const { w, older, newer } = await signOutWhileFirstIsInFlight()

    older.resolve(signedInList())
    await flushPromises()

    expect(w.text()).toContain('Loading builds')
    expect(w.findAll('.b-section')).toHaveLength(0)
    expect(w.find('.b-member-badge').exists()).toBe(false)
    expect(w.find('.b-empty').exists()).toBe(false)

    newer.resolve(signedOutList())
    await flushPromises()
    expect(w.text()).not.toContain('Loading builds')
    expect(headings(w)).toEqual(['Community Builds'])
  })

  it('an older error arriving while the newer one is still waiting does not show a banner or end the loading state', async () => {
    const { w, older, newer } = await signOutWhileFirstIsInFlight()

    older.reject(new TypeError('Failed to fetch'))
    await flushPromises()

    expect(w.text()).toContain('Loading builds')
    expect(w.find('.b-error').exists()).toBe(false)

    newer.resolve(signedOutList())
    await flushPromises()
    expect(w.find('.b-error').exists()).toBe(false)
    expect(headings(w)).toEqual(['Community Builds'])
  })

  it('the newest request failing still shows the banner, and an older good answer arriving later cannot hide it', async () => {
    const { w, older, newer } = await signOutWhileFirstIsInFlight()
    newer.reject(new TypeError('Failed to fetch'))
    await flushPromises()
    expect(w.find('.b-error').exists()).toBe(true)

    older.resolve(signedInList())
    await flushPromises()

    expect(w.find('.b-error').exists()).toBe(true)
    expect(w.find('.b-member-badge').exists()).toBe(false)
    expect(w.text()).not.toContain('Verified Members')
  })
})

// A list that carries member flags must not outlive the sign-out that made the flags stale.
describe('Builds while the list reloads after a sign-out', () => {
  async function flaggedListOnScreen() {
    signInAs()
    const refetch = deferred()
    buildsApi.listBuilds.mockResolvedValueOnce(signedInList()).mockReturnValueOnce(refetch.promise)
    const w = await open()
    expect(headings(w)).toEqual(['Verified Members', 'Community Builds'])
    expect(w.find('.b-member-badge').exists()).toBe(true)
    return { w, refetch }
  }

  it('signing out clears the flagged list at once, before the refetch answers', async () => {
    const { w } = await flaggedListOnScreen()

    useAuth().signOut()
    await flushPromises() // the refetch is still pending

    expect(w.find('.b-member-badge').exists()).toBe(false)
    expect(w.text()).not.toContain('Verified Members')
    expect(w.findAll('.b-section')).toHaveLength(0)
    expect(w.findAll('.b-name')).toHaveLength(0)
    expect(w.text()).toContain('Loading builds')
  })

  it('signing out when the refetch fails shows the error and none of the old flagged list', async () => {
    const { w, refetch } = await flaggedListOnScreen()

    useAuth().signOut()
    refetch.reject(new TypeError('Failed to fetch'))
    await flushPromises()

    expect(w.find('.b-error').exists()).toBe(true)
    expect(w.findAll('.b-name')).toHaveLength(0)
    expect(w.find('.b-member-badge').exists()).toBe(false)
    expect(w.text()).not.toContain('Verified Members')
  })
})
