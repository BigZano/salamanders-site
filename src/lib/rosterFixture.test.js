import { describe, it, expect, vi, afterEach } from 'vitest'

// The real fixture arrives in Task 9; these tests do not depend on its content.
const FX = vi.hoisted(() => ({
  _fixture: true,
  roster: { fetchedAt: 'f', stale: false, viewer: { infirmary: true }, highCommand: [], branches: [], unassigned: { rows: [] }, servitors: [] },
  infirmary: { fetchedAt: 'f', stale: false, count: 0, members: [] },
}))
vi.mock('../data/roster.fixture.json', () => ({ default: FX }))
import { loadFixture } from './rosterFixture'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('loadFixture', () => {
  it('is null unless VITE_ROSTER_FIXTURE is set', async () => {
    vi.stubEnv('VITE_ROSTER_FIXTURE', '')
    expect(await loadFixture()).toBe(null)
  })

  it('loads the full synthetic fixture for 1 or full, and for an unknown name', async () => {
    for (const v of ['1', 'full', 'bogus']) {
      vi.stubEnv('VITE_ROSTER_FIXTURE', v)
      expect(await loadFixture()).toEqual({ _fixture: true, scene: 'full', roster: FX.roster, infirmary: FX.infirmary })
    }
  })

  it('picks the scene named by the variable', async () => {
    vi.stubEnv('VITE_ROSTER_FIXTURE', 'denied')
    expect(await loadFixture()).toMatchObject({ scene: 'denied', status: 'denied' })
  })

  it('lets ?scene= on the page URL override the variable, so designers can flip scenes without a restart', async () => {
    vi.stubEnv('VITE_ROSTER_FIXTURE', '1')
    vi.stubGlobal('location', { search: '?scene=stale' })
    expect((await loadFixture()).roster.stale).toBe(true)
    vi.stubGlobal('location', { search: '?other=1' })
    expect((await loadFixture()).scene).toBe('full')
  })
})
