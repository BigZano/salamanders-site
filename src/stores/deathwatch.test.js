import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../lib/deathwatch/api', () => ({ getMe: vi.fn() }))
vi.mock('../lib/deathwatch/fixture', () => ({ loadFixture: vi.fn() }))
import { getMe } from '../lib/deathwatch/api'
import { loadFixture } from '../lib/deathwatch/fixture'
import { useDeathwatch } from './deathwatch'

const apiError = (status) => Object.assign(new Error('nope'), { status })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
// Let a call that is already running get as far as its API request.
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  loadFixture.mockResolvedValue(null)
})

describe('deathwatch store', () => {
  it('starts idle and not a commander', () => {
    expect(useDeathwatch()).toMatchObject({ status: 'idle', commander: false })
  })

  it('does not keep an earlier clearance while it checks again, not even for an instant', () => {
    const s = useDeathwatch()
    s.$patch({ status: 'allowed', commander: true, command: true })
    getMe.mockReturnValue(deferred().promise)
    s.load('tok') // not awaited: the state straight after the call is what a render would see
    expect(s).toMatchObject({ status: 'checking', commander: false, command: false })
  })

  it('sends someone with no token to sign in, without asking the server', async () => {
    const s = useDeathwatch()
    for (const token of [null, undefined, '']) {
      s.$patch({ commander: true, command: true })
      await s.load(token)
      expect(s, String(token)).toMatchObject({ status: 'signin', commander: false, command: false })
    }
    expect(getMe).not.toHaveBeenCalled()
  })

  it('shows checking while it asks, then allowed', async () => {
    const d = deferred()
    getMe.mockReturnValue(d.promise)
    const s = useDeathwatch()
    const p = s.load('tok')
    await tick()
    expect(s.status).toBe('checking')
    expect(getMe).toHaveBeenCalledWith('tok')
    d.resolve({ access: true, watchCommander: false })
    await p
    expect(s).toMatchObject({ status: 'allowed', commander: false })
  })

  it('reports a commander only for someone who has access', async () => {
    const s = useDeathwatch()
    getMe.mockResolvedValue({ access: true, watchCommander: true })
    await s.load('tok')
    expect(s).toMatchObject({ status: 'allowed', commander: true })

    // the server contradicting itself must not make a commander of someone refused
    getMe.mockResolvedValue({ access: false, watchCommander: true })
    await s.load('tok')
    expect(s).toMatchObject({ status: 'denied', commander: false })
  })

  it('fails closed on an answer that is not a plain yes', async () => {
    const s = useDeathwatch()
    for (const body of [{}, null, undefined, { access: 'yes' }, { access: 1 }, { access: 'true', watchCommander: true }]) {
      getMe.mockResolvedValue(body)
      await s.load('tok')
      expect(s, JSON.stringify(body)).toMatchObject({ status: 'denied', commander: false })
    }
    getMe.mockResolvedValue({ access: true, watchCommander: 'yes' })
    await s.load('tok')
    expect(s).toMatchObject({ status: 'allowed', commander: false })
  })

  it('answers 401 with signin, 403 with denied, and anything else with unavailable', async () => {
    const s = useDeathwatch()
    getMe.mockRejectedValue(apiError(401))
    await s.load('tok')
    expect(s.status).toBe('signin')
    getMe.mockRejectedValue(apiError(403))
    await s.load('tok')
    expect(s.status).toBe('denied')
    for (const err of [apiError(500), apiError(503), new TypeError('Failed to fetch'), undefined]) {
      getMe.mockRejectedValue(err)
      await s.load('tok')
      expect(s.status, String(err)).toBe('unavailable')
    }
  })

  it('reports Deathwatch Command for its holders and for the commander, never for someone refused', async () => {
    const s = useDeathwatch()
    getMe.mockResolvedValue({ access: true, watchCommander: false, deathwatchCommand: true })
    await s.load('t')
    expect(s).toMatchObject({ status: 'allowed', commander: false, command: true })
    getMe.mockResolvedValue({ access: true, watchCommander: true })
    await s.load('t')
    expect(s).toMatchObject({ status: 'allowed', commander: true, command: true })
    for (const body of [{ access: true, deathwatchCommand: 'true' }, { access: true }, { access: false, deathwatchCommand: true }]) {
      getMe.mockResolvedValue(body)
      await s.load('t')
      expect(s, JSON.stringify(body)).toMatchObject({ command: false })
    }
  })

  it('does not stay a commander after a failed check', async () => {
    const s = useDeathwatch()
    getMe.mockResolvedValue({ access: true, watchCommander: true, deathwatchCommand: true })
    await s.load('tok')
    getMe.mockRejectedValue(apiError(503))
    await s.load('tok')
    expect(s).toMatchObject({ status: 'unavailable', commander: false, command: false })
  })

  it('drops an answer that arrives after reset()', async () => {
    const d = deferred()
    getMe.mockReturnValue(d.promise)
    const s = useDeathwatch()
    const p = s.load('tok')
    await tick()
    s.reset()
    d.resolve({ access: true, watchCommander: true })
    await p
    expect(s).toMatchObject({ status: 'idle', commander: false })
  })

  it('drops a failure that arrives after reset()', async () => {
    const d = deferred()
    getMe.mockReturnValue(d.promise)
    const s = useDeathwatch()
    const p = s.load('tok')
    await tick()
    s.reset()
    d.reject(apiError(503))
    await p
    expect(s.status).toBe('idle')
  })

  it('drops an older answer that arrives after a newer load has finished', async () => {
    const slow = deferred()
    getMe.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ access: false, watchCommander: false })
    const s = useDeathwatch()
    const first = s.load('old')
    await tick()
    await s.load('new')
    expect(s.status).toBe('denied')
    slow.resolve({ access: true, watchCommander: true })
    await first
    expect(s).toMatchObject({ status: 'denied', commander: false })
  })

  it('reset() goes back to idle and not a commander', async () => {
    const s = useDeathwatch()
    getMe.mockResolvedValue({ access: true, watchCommander: true, deathwatchCommand: true })
    await s.load('tok')
    s.reset()
    expect(s).toMatchObject({ status: 'idle', commander: false, command: false })
  })

  it('shows a fixture scene instead of asking the server, even with no token', async () => {
    const s = useDeathwatch()
    loadFixture.mockResolvedValue({ _fixture: true, scene: 'commander', status: 'allowed', commander: true, command: true })
    await s.load(null)
    expect(s).toMatchObject({ status: 'allowed', commander: true, command: true })
    loadFixture.mockResolvedValue({ _fixture: true, scene: 'command', status: 'allowed', commander: false, command: true })
    await s.load(null)
    expect(s).toMatchObject({ status: 'allowed', commander: false, command: true })
    loadFixture.mockResolvedValue({ _fixture: true, scene: 'allowed', status: 'allowed', commander: false, command: false })
    await s.load(null)
    expect(s).toMatchObject({ status: 'allowed', commander: false, command: false })
    expect(getMe).not.toHaveBeenCalled()
  })

  it('leaves the checking scene checking', async () => {
    const s = useDeathwatch()
    loadFixture.mockResolvedValue({ _fixture: true, scene: 'checking', status: 'checking', commander: false })
    await s.load('tok')
    expect(s.status).toBe('checking')
  })

  it('drops a fixture that resolves after reset()', async () => {
    const d = deferred()
    loadFixture.mockReturnValue(d.promise)
    const s = useDeathwatch()
    const p = s.load('tok')
    await tick()
    s.reset()
    d.resolve({ _fixture: true, scene: 'commander', status: 'allowed', commander: true })
    await p
    expect(s).toMatchObject({ status: 'idle', commander: false })
  })
})
