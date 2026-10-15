import { describe, it, expect, vi, afterEach } from 'vitest'

// A small stand-in for the synthetic fixture: one company, a head and a sergeant below.
const FX = vi.hoisted(() => ({
  _fixture: true,
  roster: {
    fetchedAt: 'f',
    stale: false,
    viewer: { infirmary: true },
    highCommand: [],
    branches: [
      {
        key: 'company-3',
        kind: 'company',
        label: '3rd Battle Company',
        number: 3,
        head: { rank: { key: 'captain', label: 'Captain', tier: 1 }, members: [{ id: '900000000000000001', name: 'Fx Captain', avatar: null }], vacant: false },
        aside: [],
        rows: [{ rank: { key: 'sergeant', label: 'Sergeant', tier: 3 }, members: [{ id: '900000000000000002', name: 'Fx Sergeant', avatar: null }] }],
      },
    ],
    unassigned: { rows: [] },
    servitors: [],
  },
  infirmary: { fetchedAt: 'f', stale: false, count: 0, members: [] },
}))
vi.mock('../data/roster.fixture.json', () => ({ default: FX }))
import { publicRoster } from '../../server/src/rosterPublic.js'
import { loadFixture } from './rosterFixture'

const publicOf = (roster) => ({ fetchedAt: roster.fetchedAt, stale: roster.stale, ...publicRoster(roster) })

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
      expect(await loadFixture()).toEqual({ _fixture: true, scene: 'full', roster: FX.roster, infirmary: FX.infirmary, public: publicOf(FX.roster) })
    }
  })

  describe('the public snapshot beside the full one', () => {
    const asScene = (name) => {
      vi.stubEnv('VITE_ROSTER_FIXTURE', name)
      return loadFixture()
    }

    it('is the server projection of the roster: the head named, the ranks below counted, no ids', async () => {
      const { public: pub } = await asScene('full')
      expect(pub.branches[0].head.members).toEqual([{ name: 'Fx Captain' }])
      expect(pub.branches[0].rows).toEqual([{ rank: { key: 'sergeant', label: 'Sergeant', tier: 3 }, count: 1 }])
      const text = JSON.stringify(pub)
      expect(text).not.toContain('Fx Sergeant')
      expect(text).not.toMatch(/\d{17,20}/)
    })

    it('follows the stale scene', async () => {
      expect((await asScene('stale')).public.stale).toBe(true)
    })

    it('follows the empty scene: every head vacant, nothing below', async () => {
      const { public: pub } = await asScene('empty')
      expect(pub.branches.every((b) => b.head.vacant && b.head.members.length === 0 && b.rows.length === 0)).toBe(true)
    })

    it('is the full roster for the signed-out and denied scenes, which the public view still shows', async () => {
      for (const name of ['signin', 'denied']) expect((await asScene(name)).public).toEqual(publicOf(FX.roster))
    })

    it('is null for the error scene and undefined for the loading scene', async () => {
      expect((await asScene('error')).public).toBeNull()
      expect((await asScene('loading')).public).toBeUndefined()
    })
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
