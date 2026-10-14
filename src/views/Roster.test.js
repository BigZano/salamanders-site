// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import fixture from '../data/roster.fixture.json'
import { buildRosterView } from '../lib/rosterView'
import { sceneOf } from '../lib/rosterScenes'

let auth
vi.mock('../stores/auth', () => ({ useAuth: () => auth }))
vi.mock('../lib/rosterApi', () => ({ getRoster: vi.fn(), getInfirmary: vi.fn() }))
import * as api from '../lib/rosterApi'
import Roster from './Roster.vue'
import { useRoster } from '../stores/roster'

const apiError = (status, message) => Object.assign(new Error(message), { status })
const mounted = []
const render = async () => {
  const w = mount(Roster)
  mounted.push(w)
  await flushPromises()
  return w
}
// The page polls on a timer; unmounting clears it between tests.
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.unstubAllEnvs()
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  auth = { token: 'tok', signedIn: true, signIn: vi.fn() }
  api.getRoster.mockResolvedValue(fixture.roster)
  api.getInfirmary.mockResolvedValue(fixture.infirmary)
})

describe('Roster.vue', () => {
  it('renders the order of battle: High Command, twelve branches, unassigned, servitors', async () => {
    const w = await render()
    expect(w.text()).toContain('Order of Battle')
    expect(w.find('.rs-high-command').text()).toContain('Lord of Drakes')
    expect(w.find('.rs-high-command').text()).toContain('Lord Chaplain')
    expect(w.findAll('.rs-branch')).toHaveLength(12)
    expect(w.find('.rs-unassigned').exists()).toBe(true)
    expect(w.find('.rs-servitors').text()).toContain('Servitors')
    expect(w.find('.rs-servitors').text()).toContain('Smith-Servitor')
  })

  it('shows a vacant head, an acting head, an aside slot and ordinal company tags', async () => {
    const w = await render()
    expect(w.find('[data-branch="company-6"] .rs-head').text()).toContain('Vacant')
    expect(w.find('[data-branch="company-2"] .rs-head').text()).toContain('Acting')
    expect(w.find('[data-branch="company-4"] .rs-aside').exists()).toBe(true)
    expect(w.find('[data-branch="forge"] .rs-tag').text()).toMatch(/^(1st|2nd|3rd|4th|5th|6th|7th)$/)
  })

  it('flags a name that disagrees with the roles', async () => {
    expect((await render()).text()).toContain('Check name')
  })

  it('shows the Infirmary button to command only', async () => {
    const w = await render()
    expect(w.find('button.rs-infirmary-toggle').exists()).toBe(true)
    api.getRoster.mockResolvedValue({ ...fixture.roster, viewer: { infirmary: false } })
    setActivePinia(createPinia())
    const w2 = await render()
    expect(w2.find('button.rs-infirmary-toggle').exists()).toBe(false)
  })

  it('opens the Infirmary list, marking who still holds the Legion role', async () => {
    const w = await render()
    await w.find('button.rs-infirmary-toggle').trigger('click')
    await flushPromises()
    const list = w.find('.rs-infirmary')
    expect(list.exists()).toBe(true)
    expect(list.findAll('.rs-member')).toHaveLength(fixture.infirmary.members.length)
    expect(list.text()).toContain('Still holds the Legion role')
    expect(w.find('.rs-high-command').exists()).toBe(false)
    await w.find('button.rs-infirmary-toggle').trigger('click')
    expect(w.find('.rs-infirmary').exists()).toBe(false)
    expect(w.find('.rs-high-command').exists()).toBe(true)
  })

  it('asks a signed-out visitor to sign in, without calling the API', async () => {
    auth = { token: null, signedIn: false, signIn: vi.fn() }
    const w = await render()
    expect(w.text()).toContain('Sign in with Discord')
    await w.find('button.rs-signin').trigger('click')
    expect(auth.signIn).toHaveBeenCalled()
    expect(api.getRoster).not.toHaveBeenCalled()
  })

  it('shows the sign-in prompt at once, and no roster, when the viewer signs out on the page', async () => {
    auth = reactive({ token: 'tok', member: { id: '200000000000000001' }, signedIn: true, signIn: vi.fn() })
    const w = await render()
    expect(w.findAll('.rs-branch')).toHaveLength(12)
    // what auth.signOut() does: drop the token and member, then reset the store
    auth.token = null
    auth.member = null
    useRoster().reset()
    await flushPromises()
    expect(w.text()).toContain('Sign in with Discord to see the roster.')
    expect(w.findAll('.rs-branch')).toHaveLength(0)
    expect(w.find('.rs-high-command').exists()).toBe(false)
    expect(api.getRoster).toHaveBeenCalledTimes(1)
  })

  it('shows the server’s refusal when the account is not in the Legion, and no roster', async () => {
    api.getRoster.mockRejectedValue(apiError(403, 'The roster is open to the XVIIIth Legion.'))
    const w = await render()
    expect(w.text()).toContain('The roster is open to the XVIIIth Legion.')
    expect(w.findAll('.rs-branch')).toHaveLength(0)
  })

  it('shows an error banner but keeps the last roster when a refresh fails', async () => {
    const w = await render()
    api.getRoster.mockRejectedValue(apiError(503, 'down'))
    await useRoster().load('tok')
    await flushPromises()
    expect(w.text()).toContain('could not be refreshed')
    expect(w.findAll('.rs-branch')).toHaveLength(12)
  })

  it('says so when the roster cannot be loaded at all', async () => {
    api.getRoster.mockRejectedValue(apiError(503, 'down'))
    const w = await render()
    expect(w.text()).toContain('could not be loaded')
    expect(w.findAll('.rs-branch')).toHaveLength(0)
  })

  it('says when the roster is out of date', async () => {
    api.getRoster.mockResolvedValue({ ...fixture.roster, stale: true })
    expect((await render()).text()).toContain('out of date')
  })

  it('shows a scene switcher only when the dev fixture is on', async () => {
    expect((await render()).find('.rs-dev-scenes').exists()).toBe(false)
    vi.stubEnv('VITE_ROSTER_FIXTURE', '1')
    const w = await render()
    expect(w.findAll('.rs-dev-scenes a').map((a) => a.text())).toEqual(['full', 'stale', 'empty', 'loading', 'signin', 'denied', 'error'])
    expect(w.find('.rs-dev-scenes a[href="?scene=denied"]').exists()).toBe(true)
  })

  describe('hooks for the design pass and the tests', () => {
    it('marks each rank row with data-rank, and branch rows only with data-tier', async () => {
      const w = await render()
      const forge = w.find('[data-branch="forge"] [data-rank]')
      expect(forge.attributes('data-rank')).toBeTruthy()
      const company = w.findAll('[data-branch="company-1"] .rs-row')
      expect(company.length).toBeGreaterThan(1)
      company.forEach((row, i) => {
        expect(row.attributes('data-rank')).toBeTruthy()
        expect(row.attributes('data-tier')).toMatch(/^\d+$/)
        if (i > 0) expect(Number(row.attributes('data-tier'))).toBeGreaterThanOrEqual(Number(company[i - 1].attributes('data-tier')))
      })
      expect(w.findAll('.rs-high-command .rs-row').length).toBeGreaterThan(0)
      for (const row of [...w.findAll('.rs-high-command .rs-row'), ...w.findAll('.rs-unassigned .rs-row')]) {
        expect(row.attributes('data-rank')).toBeTruthy()
        expect(row.attributes('data-tier')).toBeUndefined()
      }
      expect(w.findAll('.rs-unassigned .rs-row').length).toBeGreaterThan(0)
    })

    it('marks only the Terminator row data-lateral', async () => {
      const w = await render()
      const lateral = w.findAll('[data-lateral]')
      expect(w.find('[data-branch="company-1"] [data-lateral]').exists()).toBe(true)
      expect(lateral.length).toBeGreaterThan(0)
      for (const row of lateral) expect(row.attributes('data-rank')).toBe('terminator')
      expect(w.find('[data-branch="company-1"] .rs-row:not([data-lateral])').exists()).toBe(true)
    })

    it('marks each branch with its data-kind', async () => {
      const w = await render()
      expect(w.find('[data-branch="company-1"]').attributes('data-kind')).toBe('company')
      expect(w.find('[data-branch="venerable-dreadnoughts"]').attributes('data-kind')).toBe('dreadnoughts')
      expect(w.find('[data-branch="forge"]').attributes('data-kind')).toBe('specialty')
    })

    it('carries the member id on each member row', async () => {
      const w = await render()
      const first = fixture.roster.highCommand[0].members[0]
      expect(w.find('.rs-high-command li.rs-member').attributes('data-id')).toBe(first.id)
      const ids = w.findAll('li.rs-member').map((li) => li.attributes('data-id'))
      expect(ids.every((id) => /^\d{17,20}$/.test(id))).toBe(true)
    })
  })
})

describe('Roster.vue: the design pass', () => {
  const view = buildRosterView(fixture.roster)
  const company3 = fixture.roster.branches.find((b) => b.key === 'company-3')
  const brother = company3.rows.find((r) => r.rank.key === 'battle-brother').members[0].id
  const inBranches = new Set(fixture.roster.branches.flatMap((b) => [...b.head.members, ...b.aside, ...b.rows.flatMap((r) => r.members)].map((m) => m.id)))
  const bannerOnly = fixture.roster.highCommand.flatMap((r) => r.members).find((m) => !inBranches.has(m.id)).id
  let scrolled
  beforeEach(() => {
    scrolled = []
    Element.prototype.scrollIntoView = vi.fn(function () { scrolled.push(this) })
    window.scrollBy = vi.fn()
    window.history.replaceState(null, '', '/roster')
  })
  const asViewer = (id) => { auth = { token: 'tok', signedIn: true, signIn: vi.fn(), member: { id } } }
  const isOpen = (w, key) => w.find(`[data-jump="${key}"]`).attributes('data-open') !== undefined
  const openCount = (w) => w.findAll('[data-open]').length

  it("Find me opens the viewer's branch and centres their chip", async () => {
    asViewer(brother)
    const w = await render()
    await w.find('.rs-find').trigger('click')
    await flushPromises()
    expect(isOpen(w, 'company-3')).toBe(true)
    expect(w.find('[role="status"]').text()).toBe('')
    expect(scrolled.some((el) => el.dataset?.id === brother)).toBe(true)
    expect(w.find(`li[data-id="${brother}"]`).classes()).toContain('rs-me')
  })

  it('Find me with an id that is not on the roll says so, and opens nothing', async () => {
    asViewer('1')
    const w = await render()
    await w.find('.rs-find').trigger('click')
    await flushPromises()
    expect(w.find('[role="status"]').text()).toBe('You are not on the roll. Check your Legion and rank roles in Discord.')
    expect(openCount(w)).toBe(0)
  })

  it('Find me for a High Command-only member scrolls the dais and opens nothing', async () => {
    asViewer(bannerOnly)
    const w = await render()
    await w.find('.rs-find').trigger('click')
    await flushPromises()
    expect(scrolled.some((el) => el.classList.contains('rs-high-command'))).toBe(true)
    expect(openCount(w)).toBe(0)
    expect(w.find('[role="status"]').text()).toBe('')
  })

  it('Expand all opens every openable branch and Unassigned, and Collapse all closes them', async () => {
    const w = await render()
    await w.find('.rs-expand-all').trigger('click')
    await flushPromises()
    expect(openCount(w)).toBe(view.openableKeys.length)
    expect(w.find('.rs-expand-all').text()).toBe('Collapse all')
    await w.find('.rs-expand-all').trigger('click')
    await flushPromises()
    expect(openCount(w)).toBe(0)
    expect(w.find('.rs-expand-all').text()).toBe('Expand all')
  })

  it('a status link opens its branch', async () => {
    const w = await render()
    const vacant = w.findAll('.rs-status button').find((b) => b.text().includes('vacant post'))
    await vacant.trigger('click')
    await flushPromises()
    expect(isOpen(w, 'company-6')).toBe(true)
  })

  it('a #company-3 hash opens that branch after load', async () => {
    window.history.replaceState(null, '', '/roster#company-3')
    const w = await render()
    await flushPromises()
    expect(isOpen(w, 'company-3')).toBe(true)
    expect(openCount(w)).toBe(1)
  })

  it.each([
    ['the sign-in fragment', '#access_token=abc&expires_in=3600'],
    ['an unknown key', '#nope'],
    ['a branch with nothing to open', '#venerable-dreadnoughts'],
  ])('ignores %s in the URL', async (_, hash) => {
    window.history.replaceState(null, '', '/roster' + hash)
    const w = await render()
    await flushPromises()
    expect(openCount(w)).toBe(0)
    expect(w.findAll('.rs-branch')).toHaveLength(12)
  })

  it('keeps branches open when a new snapshot arrives', async () => {
    const w = await render()
    await w.find('[data-branch="company-3"] button').trigger('click')
    expect(isOpen(w, 'company-3')).toBe(true)
    api.getRoster.mockResolvedValue({ ...fixture.roster, fetchedAt: 'later' })
    await useRoster().load('tok')
    await flushPromises()
    expect(isOpen(w, 'company-3')).toBe(true)
  })

  it('shrugs off a branch that stops being openable while open', async () => {
    const w = await render()
    await w.find('[data-branch="company-1"] button').trigger('click')
    const trimmed = { ...fixture.roster, fetchedAt: 'trim', branches: fixture.roster.branches.map((b) => (b.key === 'company-1' ? { ...b, aside: [], rows: [] } : b)) }
    api.getRoster.mockResolvedValue(trimmed)
    await useRoster().load('tok')
    await flushPromises()
    expect(w.find('[data-branch="company-1"] button').exists()).toBe(false)
    expect(isOpen(w, 'company-1')).toBe(false)
    await w.find('.rs-expand-all').trigger('click')
    await flushPromises()
    expect(openCount(w)).toBe(buildRosterView(trimmed).openableKeys.length)
  })

  it('renders an empty roster: no dais, nobody on the roll, nothing to open', async () => {
    api.getRoster.mockResolvedValue(sceneOf(fixture, 'empty').roster)
    const w = await render()
    expect(w.find('.rs-high-command').exists()).toBe(false)
    expect(w.find('.rs-status').text()).toContain('0 on the roll')
    expect(w.findAll('.rs-branch')).toHaveLength(12)
    expect(w.findAll('.rs-branch button')).toHaveLength(0)
    expect(w.find('.rs-expand-all').exists()).toBe(false)
  })

  it('stops listening for the tab coming back when it unmounts', async () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const w = await render()
    w.unmount()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    remove.mockRestore()
  })
})
