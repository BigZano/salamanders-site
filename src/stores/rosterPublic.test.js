// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../lib/rosterApi', () => ({ getPublicRoster: vi.fn() }))
vi.mock('../lib/rosterFixture', () => ({ loadFixture: vi.fn() }))
import * as api from '../lib/rosterApi'
import { loadFixture } from '../lib/rosterFixture'
import { useRosterPublic } from './rosterPublic'

const SNAP = {
  fetchedAt: 'x',
  stale: false,
  highCommand: [],
  branches: [
    { key: 'company-3', kind: 'company', label: '3rd', number: 3, head: { rank: { key: 'captain', label: 'Captain', tier: 1 }, vacant: false, members: [{ name: 'Cap A' }] }, aside: 0, rows: [] },
  ],
}
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  loadFixture.mockResolvedValue(null)
})

describe('rosterPublic store', () => {
  it('starts idle with nothing', () => {
    const s = useRosterPublic()
    expect(s).toMatchObject({ status: 'idle', snapshot: null, view: null })
  })

  it('goes loading, then ready with the snapshot and its view', async () => {
    const d = deferred()
    api.getPublicRoster.mockReturnValue(d.promise)
    const s = useRosterPublic()
    const run = s.load()
    await flushPromises()
    expect(s.status).toBe('loading')
    d.resolve(SNAP)
    await run
    expect(s.status).toBe('ready')
    expect(s.snapshot).toEqual(SNAP)
    expect(s.view.branches[0].head.members[0].name).toBe('Cap A')
    expect(api.getPublicRoster).toHaveBeenCalledWith()
  })

  it('ends in error with nothing kept when the request fails', async () => {
    api.getPublicRoster.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }))
    const s = useRosterPublic()
    await s.load()
    expect(s).toMatchObject({ status: 'error', snapshot: null, view: null })
  })

  it('makes one request for concurrent loads, and a new one for the next load', async () => {
    const d = deferred()
    api.getPublicRoster.mockReturnValue(d.promise)
    const s = useRosterPublic()
    const a = s.load()
    const b = s.load()
    d.resolve(SNAP)
    await Promise.all([a, b])
    expect(api.getPublicRoster).toHaveBeenCalledTimes(1)
    api.getPublicRoster.mockResolvedValue({ ...SNAP, fetchedAt: 'y' })
    await s.load()
    expect(api.getPublicRoster).toHaveBeenCalledTimes(2)
    expect(s.snapshot.fetchedAt).toBe('y')
  })

  it('does not share loads between two stores', async () => {
    api.getPublicRoster.mockResolvedValue(SNAP)
    await useRosterPublic().load()
    setActivePinia(createPinia())
    await useRosterPublic().load()
    expect(api.getPublicRoster).toHaveBeenCalledTimes(2)
  })

  describe('with the dev fixture', () => {
    it('uses the fixture snapshot and never calls the API', async () => {
      loadFixture.mockResolvedValue({ _fixture: true, scene: 'full', public: SNAP })
      const s = useRosterPublic()
      await s.load()
      expect(s.status).toBe('ready')
      expect(s.snapshot).toEqual(SNAP)
      expect(api.getPublicRoster).not.toHaveBeenCalled()
    })

    it('treats a null public snapshot (the error scene) as a failure', async () => {
      loadFixture.mockResolvedValue({ _fixture: true, scene: 'error', public: null })
      const s = useRosterPublic()
      await s.load()
      expect(s.status).toBe('error')
    })

    it('never answers for the loading scene', async () => {
      loadFixture.mockResolvedValue({ _fixture: true, scene: 'loading', public: undefined })
      const s = useRosterPublic()
      s.load()
      await flushPromises()
      expect(s.status).toBe('loading')
      expect(s.snapshot).toBeNull()
    })
  })
})
