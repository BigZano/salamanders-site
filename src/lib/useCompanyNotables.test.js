// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// The REAL auth store, over a stand-in for the Discord storage (as in useCompanyRoster.auth.test.js): signing out
// changes `member`, which is what the composable watches. Invented names only.
const discord = vi.hoisted(() => ({ stored: null, isMember: true }))
vi.mock('./discordAuth', () => ({
  currentMember: () => (discord.stored ? { id: '200000000000000001', username: 'tester', isMember: discord.isMember, checkedAt: 0 } : null),
  getAccessToken: () => discord.stored?.accessToken ?? null,
  signOut: () => {
    discord.stored = null
  },
  beginSignIn: vi.fn(),
}))
vi.mock('./buildsApi', () => ({ getCompanyNotables: vi.fn() }))
import { getCompanyNotables } from './buildsApi'
import { useAuth } from '../stores/auth'
import { useCompanyNotables } from './useCompanyNotables'

const ONE = ['Test Member One', 'A line about them.']
const TWO = ['Test Member Two']
const ANSWER = { alpha: [ONE, TWO], beta: [TWO] }

const hosts = []
function host() {
  let notables
  const w = mount({ setup() { notables = useCompanyNotables(); return () => null } })
  hosts.push(w)
  return notables
}
const refused = (status) => Object.assign(new Error('refused'), { status })

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  discord.stored = { accessToken: 'invented-token' }
  discord.isMember = true
  getCompanyNotables.mockResolvedValue(ANSWER)
})
afterEach(() => hosts.splice(0).forEach((w) => w.unmount()))

describe('a signed-in guild member', () => {
  it('asks the server with their token, shows loading, then has the cards', async () => {
    let answer
    getCompanyNotables.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const n = host()
    expect(n.state.value).toBe('loading')
    expect(getCompanyNotables).toHaveBeenCalledTimes(1)
    expect(getCompanyNotables).toHaveBeenCalledWith('invented-token')
    expect(n.entriesFor('alpha')).toBeNull()
    answer(ANSWER)
    await flushPromises()
    expect(n.state.value).toBe('ready')
    expect(n.entriesFor('alpha')).toStrictEqual([ONE, TWO])
    expect(n.entriesFor('beta')).toStrictEqual([TWO])
  })

  it('keeps the names out of the browser’s storage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem')
    host()
    await flushPromises()
    expect(local).not.toHaveBeenCalled()
    local.mockRestore()
  })
})

describe('without a live sign-in the server is not asked', () => {
  it('signed out: denied, and the server is never called', async () => {
    discord.stored = null
    const n = host()
    await flushPromises()
    expect(n.state.value).toBe('denied')
    expect(getCompanyNotables).not.toHaveBeenCalled()
    expect(n.entriesFor('alpha')).toBeNull()
  })

  it('still looks signed in but the token has run out: expired, and the server is never called', async () => {
    discord.stored = { accessToken: null }
    const n = host()
    await flushPromises()
    expect(n.state.value).toBe('expired')
    expect(getCompanyNotables).not.toHaveBeenCalled()
    expect(n.entriesFor('alpha')).toBeNull()
  })
})

describe('a stored membership flag decides nothing', () => {
  it.each([
    ['false', false],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['undefined', undefined],
  ])('a flag of %s and a server that says yes: the cards', async (_label, flag) => {
    discord.isMember = flag
    const n = host()
    await flushPromises()
    expect(n.state.value).toBe('ready')
    expect(n.entriesFor('alpha')).toStrictEqual([ONE, TWO])
  })

  it('a flag of true and a server that says no: no names', async () => {
    getCompanyNotables.mockRejectedValue(refused(403))
    const n = host()
    await flushPromises()
    expect(n.state.value).toBe('denied')
    expect(n.entriesFor('alpha')).toBeNull()
  })
})

describe('when the server does not give them', () => {
  it.each([
    [401, 'expired', 'the token is no longer good'],
    [403, 'denied', 'this person is not a guild member'],
  ])('a %i is %s, not an error: %s', async (status, state) => {
    getCompanyNotables.mockRejectedValue(refused(status))
    const n = host()
    await flushPromises()
    expect(n.state.value).toBe(state)
    expect(n.entriesFor('alpha')).toBeNull()
  })

  it.each([
    ['a 503', refused(503)],
    ['a 500', refused(500)],
    ['a network failure', new Error('network down')],
    ['a rejection with nothing in it', undefined],
  ])('%s is an error', async (_label, err) => {
    getCompanyNotables.mockRejectedValue(err)
    const n = host()
    await flushPromises()
    expect(n.state.value).toBe('error')
    expect(n.entriesFor('alpha')).toBeNull()
  })
})

describe('signing out', () => {
  it('drops the names at once and goes back to denied', async () => {
    const n = host()
    await flushPromises()
    expect(n.entriesFor('alpha')).not.toBeNull()
    useAuth().signOut()
    await flushPromises()
    expect(n.state.value).toBe('denied')
    expect(n.entriesFor('alpha')).toBeNull()
  })

  it('ignores a slow answer that arrives after they have signed out', async () => {
    let answer
    getCompanyNotables.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const n = host()
    useAuth().signOut()
    await flushPromises()
    answer(ANSWER)
    await flushPromises()
    expect(n.state.value).toBe('denied')
    expect(n.entriesFor('alpha')).toBeNull()
  })

  it('ignores a slow failure that arrives after they have signed out', async () => {
    let fail
    getCompanyNotables.mockReturnValue(new Promise((_, reject) => (fail = reject)))
    const n = host()
    useAuth().signOut()
    await flushPromises()
    fail(refused(500))
    await flushPromises()
    expect(n.state.value).toBe('denied')
  })
})

describe('entriesFor', () => {
  async function ready(answer) {
    getCompanyNotables.mockResolvedValue(answer)
    const n = host()
    await flushPromises()
    return n
  }

  it('is null for a company the server has nothing for', async () => {
    const n = await ready(ANSWER)
    expect(n.entriesFor('gamma')).toBeNull()
  })

  it('is null for an empty list, and for something that is not a list', async () => {
    const n = await ready({ alpha: [], beta: 'text', gamma: { not: 'a list' }, delta: null })
    for (const id of ['alpha', 'beta', 'gamma', 'delta']) expect(n.entriesFor(id), id).toBeNull()
  })

  it('leaves out an entry that is not a name with lines, and keeps the rest', async () => {
    const n = await ready({ alpha: [ONE, 'text', null, [], [5, 'x'], {}, TWO] })
    expect(n.entriesFor('alpha')).toStrictEqual([ONE, TWO])
    const none = await ready({ alpha: ['text', null, []] })
    expect(none.entriesFor('alpha')).toBeNull()
  })

  it('does not find a company by a built-in property name', async () => {
    const n = await ready({ alpha: [ONE] })
    for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) expect(n.entriesFor(id), id).toBeNull()
  })

  it('finds a company whose id is a built-in property name when the server sent it', async () => {
    const n = await ready(JSON.parse('{"constructor": [["Test Member One"]]}'))
    expect(n.entriesFor('constructor')).toStrictEqual([['Test Member One']])
  })
})
