/**
 * Named states of the roster page for design work, derived from the full
 * synthetic fixture (scripts/roster-fixture.mjs). Dev only; see rosterFixture.js.
 *   full     every case at once
 *   stale    the server's "out of date" flag set
 *   empty    nobody on the roster: every head vacant
 *   loading  the page before anything has arrived (never resolves)
 *   signin   signed out
 *   denied   signed in, but not in the Legion
 *   error    the server could not be reached, and nothing is cached
 */
export const SCENES = ['full', 'stale', 'empty', 'loading', 'signin', 'denied', 'error']

const STATES = {
  loading: {},
  signin: {},
  denied: { message: 'The roster is open to the XVIIIth Legion.' },
  error: { message: 'Could not reach the roster server.' },
}

const emptied = (roster) => ({
  ...roster,
  highCommand: [],
  branches: roster.branches.map((b) => ({ ...b, head: { ...b.head, members: [], vacant: true }, aside: [], rows: [] })),
  unassigned: { rows: [] },
  servitors: [],
})

/** The fixture as the named scene, in the shape the roster store reads. An unknown name gives 'full'. */
export function sceneOf(fixture, name) {
  const scene = SCENES.includes(name) ? name : 'full'
  if (scene in STATES) return { _fixture: true, scene, status: scene, ...STATES[scene] }
  const { roster, infirmary } = fixture
  if (scene === 'stale') {
    return { _fixture: true, scene, roster: { ...roster, stale: true }, infirmary: { ...infirmary, stale: true } }
  }
  if (scene === 'empty') {
    return { _fixture: true, scene, roster: emptied(roster), infirmary: { ...infirmary, count: 0, members: [] } }
  }
  return { _fixture: true, scene, roster, infirmary }
}
