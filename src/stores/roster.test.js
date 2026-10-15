// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const FX = vi.hoisted(() => ({
  _fixture: true,
  roster: { fetchedAt: 'f', stale: false, viewer: { infirmary: true }, highCommand: [], branches: [], unassigned: { rows: [] }, servitors: [] },
  infirmary: { fetchedAt: 'f', stale: false, count: 1, members: [{ id: '1', name: 'A' }] },
}))
vi.mock('../data/roster.fixture.json', () => ({ default: FX }))
vi.mock('../lib/rosterApi', () => ({ getRoster: vi.fn(), getInfirmary: vi.fn() }))
// Count how often the view model is built; the real function still runs.
const real = vi.hoisted(() => ({ build: null }))
vi.mock('../lib/rosterView', async (importOriginal) => {
  const actual = await importOriginal()
  real.build = actual.buildRosterView
  return { ...actual, buildRosterView: vi.fn((r) => real.build(r)) }
})
import * as api from '../lib/rosterApi'
import { buildRosterView } from '../lib/rosterView'
import { useRoster } from './roster'
// The dev fixture loader pulls the server's public projection in on demand. Load it up front, so its
// module-level code is not first run inside a test: mutation testing (stryker.config.mjs) would count
// that as these tests covering it, and they do not test it.
import '../../server/src/rosterPublic.js'

const ROSTER = { fetchedAt: 'x', stale: false, viewer: { infirmary: true }, highCommand: [], branches: [], unassigned: { rows: [] }, servitors: [] }
const INFIRMARY = { fetchedAt: 'x', stale: false, count: 1, members: [{ id: '1', name: 'A' }] }
const apiError = (status, message = 'nope') => Object.assign(new Error(message), { status })
const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
// Let a call that is already running get as far as its API request.
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})
afterEach(() => vi.unstubAllEnvs())

describe('roster store: load', () => {
  it('starts idle with nothing', () => {
    const s = useRoster()
    expect(s).toMatchObject({ status: 'idle', roster: null, infirmary: null, infirmaryStatus: 'idle', message: '' })
  })

  it('goes loading, then ready with the roster', async () => {
    const d = deferred()
    api.getRoster.mockReturnValue(d.promise)
    const s = useRoster()
    const p = s.load('tok')
    await tick()
    expect(s.status).toBe('loading')
    d.resolve(ROSTER)
    await p
    expect(s.status).toBe('ready')
    expect(s.roster).toEqual(ROSTER)
    expect(api.getRoster).toHaveBeenCalledWith('tok')
  })

  it('does not flash back to loading when a poll refreshes a roster already on screen', async () => {
    api.getRoster.mockResolvedValue(ROSTER)
    const s = useRoster()
    await s.load('tok')
    const d = deferred()
    api.getRoster.mockReturnValue(d.promise)
    const p = s.load('tok')
    await tick()
    expect(s.status).toBe('ready')
    d.resolve({ ...ROSTER, fetchedAt: 'y' })
    await p
    expect(s.roster.fetchedAt).toBe('y')
  })

  it('asks to sign in without a token, without calling the API', async () => {
    const s = useRoster()
    await s.load(null)
    expect(s.status).toBe('signin')
    expect(api.getRoster).not.toHaveBeenCalled()
  })

  it('never makes the request for a call that was superseded before it got that far', async () => {
    api.getRoster.mockResolvedValue(ROSTER)
    const s = useRoster()
    const p1 = s.load('tok')
    const p2 = s.load('tok')
    await Promise.all([p1, p2])
    expect(api.getRoster).toHaveBeenCalledTimes(1)
    expect(s.status).toBe('ready')
  })

  it('maps 401 to signin and 403 to denied, clearing any roster and Infirmary list it held', async () => {
    api.getRoster.mockResolvedValue(ROSTER)
    api.getInfirmary.mockResolvedValue(INFIRMARY)
    const s = useRoster()
    await s.load('tok')
    await s.loadInfirmary('tok')
    api.getRoster.mockRejectedValue(apiError(403, 'The roster is open to the XVIIIth Legion.'))
    await s.load('tok')
    expect(s).toMatchObject({ status: 'denied', roster: null, infirmary: null, infirmaryStatus: 'idle', message: 'The roster is open to the XVIIIth Legion.' })
    api.getRoster.mockResolvedValue(ROSTER)
    await s.load('tok')
    api.getRoster.mockRejectedValue(apiError(401))
    await s.load('tok')
    expect(s).toMatchObject({ status: 'signin', roster: null })
  })

  it('keeps the last roster on screen when a later poll fails with a server error', async () => {
    api.getRoster.mockResolvedValue(ROSTER)
    const s = useRoster()
    await s.load('tok')
    api.getRoster.mockRejectedValue(apiError(503, 'down'))
    await s.load('tok')
    expect(s.status).toBe('error')
    expect(s.roster).toEqual(ROSTER)
    expect(s.message).toBe('down')
  })

  it('treats a network failure as an error, with a default message', async () => {
    api.getRoster.mockRejectedValue(new Error(''))
    const s = useRoster()
    await s.load('tok')
    expect(s.status).toBe('error')
    expect(s.message).toBe('Could not reach the roster server.')
  })

  it('drops a stale response: the later call wins even if it resolves first', async () => {
    const first = deferred()
    const second = deferred()
    api.getRoster.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const s = useRoster()
    const p1 = s.load('tok')
    await tick()
    const p2 = s.load('tok')
    second.resolve({ ...ROSTER, fetchedAt: 'new' })
    await p2
    first.resolve({ ...ROSTER, fetchedAt: 'old' })
    await p1
    expect(s.roster.fetchedAt).toBe('new')
  })

  it('drops a stale failure too', async () => {
    const first = deferred()
    api.getRoster.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ROSTER)
    const s = useRoster()
    const p1 = s.load('tok')
    await tick()
    await s.load('tok')
    first.resolve(Promise.reject(apiError(403)))
    await p1
    expect(s.status).toBe('ready')
  })

  it('reset() forgets everything and invalidates calls in flight', async () => {
    const d = deferred()
    api.getRoster.mockReturnValue(d.promise)
    const s = useRoster()
    const p = s.load('tok')
    await tick()
    s.reset()
    d.resolve(ROSTER)
    await p
    expect(s).toMatchObject({ status: 'idle', roster: null, infirmary: null, infirmaryStatus: 'idle', message: '' })
  })
})

describe('roster store: loadInfirmary', () => {
  it('loads the Infirmary list', async () => {
    api.getInfirmary.mockResolvedValue(INFIRMARY)
    const s = useRoster()
    await s.loadInfirmary('tok')
    expect(s.infirmaryStatus).toBe('ready')
    expect(s.infirmary).toEqual(INFIRMARY)
    expect(api.getInfirmary).toHaveBeenCalledWith('tok')
  })

  it('maps 403 to denied and clears the list; other failures keep the last list', async () => {
    api.getInfirmary.mockResolvedValue(INFIRMARY)
    const s = useRoster()
    await s.loadInfirmary('tok')
    api.getInfirmary.mockRejectedValue(apiError(503))
    await s.loadInfirmary('tok')
    expect(s.infirmaryStatus).toBe('error')
    expect(s.infirmary).toEqual(INFIRMARY)
    api.getInfirmary.mockRejectedValue(apiError(403))
    await s.loadInfirmary('tok')
    expect(s).toMatchObject({ infirmaryStatus: 'denied', infirmary: null })
  })

  it('a 401 clears the list too', async () => {
    api.getInfirmary.mockResolvedValue(INFIRMARY)
    const s = useRoster()
    await s.loadInfirmary('tok')
    api.getInfirmary.mockRejectedValue(apiError(401))
    await s.loadInfirmary('tok')
    expect(s).toMatchObject({ infirmaryStatus: 'signin', infirmary: null })
  })

  it('a late Infirmary response cannot restore the list after a refusal', async () => {
    const d = deferred()
    api.getInfirmary.mockReturnValue(d.promise)
    api.getRoster.mockRejectedValue(apiError(403))
    const s = useRoster()
    const p = s.loadInfirmary('tok')
    await tick()
    await s.load('tok')
    d.resolve(INFIRMARY)
    await p
    expect(s).toMatchObject({ status: 'denied', infirmary: null, infirmaryStatus: 'idle' })
  })

  it('signing out (no token) drops the roster and Infirmary list, and a late response cannot restore them', async () => {
    api.getRoster.mockResolvedValue(ROSTER)
    const s = useRoster()
    await s.load('tok')
    const d = deferred()
    api.getInfirmary.mockReturnValue(d.promise)
    const p = s.loadInfirmary('tok')
    await tick()
    await s.load(null)
    d.resolve(INFIRMARY)
    await p
    expect(s).toMatchObject({ status: 'signin', roster: null, infirmary: null, infirmaryStatus: 'idle' })
  })

  it('a dev state scene also shuts out an Infirmary response already in flight', async () => {
    const d = deferred()
    api.getInfirmary.mockReturnValue(d.promise)
    const s = useRoster()
    const p = s.loadInfirmary('tok')
    await tick()
    vi.stubEnv('VITE_ROSTER_FIXTURE', 'denied')
    await s.load('tok')
    d.resolve(INFIRMARY)
    await p
    expect(s.infirmary).toBe(null)
  })

  it('drops a stale response', async () => {
    const first = deferred()
    const second = deferred()
    api.getInfirmary.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const s = useRoster()
    const p1 = s.loadInfirmary('tok')
    await tick()
    const p2 = s.loadInfirmary('tok')
    second.resolve({ ...INFIRMARY, count: 9 })
    await p2
    first.resolve({ ...INFIRMARY, count: 1 })
    await p1
    expect(s.infirmary.count).toBe(9)
  })
})

describe('roster store: dev fixture', () => {
  it('serves the synthetic fixture instead of the API, with no token needed', async () => {
    vi.stubEnv('VITE_ROSTER_FIXTURE', '1')
    const s = useRoster()
    await s.load(null)
    expect(s.status).toBe('ready')
    expect(s.roster).toEqual(FX.roster)
    await s.loadInfirmary(null)
    expect(s.infirmaryStatus).toBe('ready')
    expect(s.infirmary).toEqual(FX.infirmary)
    expect(api.getRoster).not.toHaveBeenCalled()
    expect(api.getInfirmary).not.toHaveBeenCalled()
  })

  it.each([
    ['loading', ''],
    ['signin', ''],
    ['denied', 'The roster is open to the XVIIIth Legion.'],
    ['error', 'Could not reach the roster server.'],
  ])('the %s scene shows that state with no roster', async (scene, message) => {
    vi.stubEnv('VITE_ROSTER_FIXTURE', scene)
    const s = useRoster()
    await s.load('tok')
    expect(s).toMatchObject({ status: scene, message, roster: null, infirmary: null, infirmaryStatus: 'idle' })
    await s.loadInfirmary('tok')
    expect(s.infirmary).toBe(null)
    expect(api.getRoster).not.toHaveBeenCalled()
  })

  it('the stale and empty scenes load as ready rosters', async () => {
    vi.stubEnv('VITE_ROSTER_FIXTURE', 'stale')
    const s = useRoster()
    await s.load(null)
    expect(s.status).toBe('ready')
    expect(s.roster.stale).toBe(true)
    vi.stubEnv('VITE_ROSTER_FIXTURE', 'empty')
    await s.load(null)
    expect(s.roster.highCommand).toEqual([])
  })
})

describe('roster store: snapshots and the view model', () => {
  beforeEach(() => {
    buildRosterView.mockImplementation((r) => real.build(r))
  })
  const again = (over = {}) => ({ ...ROSTER, ...over })

  it('has no view until a roster arrives', () => {
    expect(useRoster().view).toBeNull()
  })

  it('builds the view from the roster', async () => {
    api.getRoster.mockResolvedValue(ROSTER)
    const s = useRoster()
    await s.load('tok')
    expect(s.view).toMatchObject({ banner: { hero: null }, branches: [], unassigned: null })
  })

  it('an identical snapshot assigns nothing and rebuilds nothing', async () => {
    api.getRoster.mockResolvedValueOnce(again()).mockResolvedValueOnce(again())
    const s = useRoster()
    await s.load('tok')
    const first = s.roster
    void s.view
    await s.load('tok')
    void s.view
    expect(s.roster).toBe(first)
    expect(buildRosterView).toHaveBeenCalledTimes(1)
  })

  it('a new fetchedAt replaces the snapshot and rebuilds the view', async () => {
    api.getRoster.mockResolvedValueOnce(again()).mockResolvedValueOnce(again({ fetchedAt: 'y' }))
    const s = useRoster()
    await s.load('tok')
    void s.view
    await s.load('tok')
    void s.view
    expect(s.roster.fetchedAt).toBe('y')
    expect(buildRosterView).toHaveBeenCalledTimes(2)
  })

  it('a change in stale replaces the snapshot', async () => {
    api.getRoster.mockResolvedValueOnce(again()).mockResolvedValueOnce(again({ stale: true }))
    const s = useRoster()
    await s.load('tok')
    await s.load('tok')
    expect(s.roster.stale).toBe(true)
  })

  it('a change in viewer.infirmary replaces the snapshot (viewer flags are per request)', async () => {
    api.getRoster.mockResolvedValueOnce(again()).mockResolvedValueOnce(again({ viewer: { infirmary: false } }))
    const s = useRoster()
    await s.load('tok')
    await s.load('tok')
    expect(s.roster.viewer.infirmary).toBe(false)
  })

  it('still clears an error banner when an identical snapshot comes back', async () => {
    api.getRoster.mockResolvedValueOnce(again()).mockRejectedValueOnce(apiError(503, 'down')).mockResolvedValueOnce(again())
    const s = useRoster()
    await s.load('tok')
    const first = s.roster
    await s.load('tok')
    expect(s.status).toBe('error')
    await s.load('tok')
    expect(s).toMatchObject({ status: 'ready', message: '' })
    expect(s.roster).toBe(first)
  })
})
