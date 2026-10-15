import { describe, it, expect } from 'vitest'
import { SCENES, sceneOf } from './rosterScenes'

const FX = {
  _fixture: true,
  roster: {
    fetchedAt: 'f',
    stale: false,
    viewer: { infirmary: true },
    highCommand: [{ rank: { key: 'a' }, members: [{ id: '1' }] }],
    branches: [
      {
        key: 'company-1',
        kind: 'company',
        head: { rank: { key: 'captain' }, members: [{ id: '2' }], vacant: false },
        aside: [{ id: '3' }],
        rows: [{ rank: { key: 'scout' }, members: [{ id: '4' }] }],
      },
    ],
    unassigned: { rows: [{ rank: { key: 'scout' }, members: [{ id: '5' }] }] },
    servitors: [{ id: '6' }],
  },
  infirmary: { fetchedAt: 'f', stale: false, count: 1, members: [{ id: '7' }] },
}

describe('sceneOf', () => {
  it('lists the scenes the handoff names', () => {
    expect(SCENES).toEqual(['full', 'stale', 'empty', 'loading', 'signin', 'denied', 'error'])
  })

  it('full gives the fixture as it is', () => {
    expect(sceneOf(FX, 'full')).toEqual({ _fixture: true, scene: 'full', roster: FX.roster, infirmary: FX.infirmary })
  })

  it('falls back to full for an unknown or missing scene', () => {
    for (const name of ['nope', '', undefined, null, '1', 'constructor', '__proto__']) expect(sceneOf(FX, name).scene).toBe('full')
  })

  it('stale marks both documents out of date and leaves everything else', () => {
    const s = sceneOf(FX, 'stale')
    expect(s.roster).toEqual({ ...FX.roster, stale: true })
    expect(s.infirmary).toEqual({ ...FX.infirmary, stale: true })
  })

  it('empty vacates every head and clears everyone, keeping the structure', () => {
    const s = sceneOf(FX, 'empty')
    expect(s.roster.highCommand).toEqual([])
    expect(s.roster.branches).toEqual([
      { key: 'company-1', kind: 'company', head: { rank: { key: 'captain' }, members: [], vacant: true }, aside: [], rows: [] },
    ])
    expect(s.roster.unassigned).toEqual({ rows: [] })
    expect(s.roster.servitors).toEqual([])
    expect(s.roster).toMatchObject({ fetchedAt: 'f', stale: false, viewer: { infirmary: true } })
    expect(s.infirmary).toEqual({ fetchedAt: 'f', stale: false, count: 0, members: [] })
  })

  it('does not alter the fixture it was given', () => {
    const before = JSON.stringify(FX)
    for (const name of SCENES) sceneOf(FX, name)
    expect(JSON.stringify(FX)).toBe(before)
  })

  it.each([
    ['loading', {}],
    ['signin', {}],
    ['denied', { message: 'The roster is open to the XVIIIth Legion.' }],
    ['error', { message: 'Could not reach the roster server.' }],
  ])('%s is a state scene with no roster', (name, extra) => {
    expect(sceneOf(FX, name)).toEqual({ _fixture: true, scene: name, status: name, ...extra })
  })
})
