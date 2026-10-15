/**
 * Stand-in for the live API, so the page can be designed without the server.
 * Dev only, and only when asked for: VITE_ROSTER_FIXTURE=1 (or a scene name)
 * loads the synthetic roster from src/data/roster.fixture.json
 * (scripts/roster-fixture.mjs); ?scene=<name> on the page URL picks a scene
 * without a restart (see rosterScenes.js). The literal condition below is what
 * lets the build drop the dynamic import, so the fixture never reaches the
 * production bundle.
 */
import { sceneOf } from './rosterScenes'

export async function loadFixture() {
  if (import.meta.env.DEV && import.meta.env.VITE_ROSTER_FIXTURE) {
    const fixture = (await import('../data/roster.fixture.json')).default
    // The server's own projection, run on the synthetic roster, so the public view can never drift from the real one.
    const { publicRoster } = await import('../../server/src/rosterPublic.js')
    const asked = new URLSearchParams(globalThis.location?.search ?? '').get('scene') || String(import.meta.env.VITE_ROSTER_FIXTURE)
    const scene = sceneOf(fixture, asked)
    return { ...scene, public: publicOf(scene, fixture, publicRoster) }
  }
  return null
}

/**
 * What GET /roster/public would answer in this scene. `null` is the error scene (the request fails) and
 * `undefined` the loading scene (it never answers); the signed-out and denied scenes still show the public view.
 */
function publicOf(scene, fixture, publicRoster) {
  if (scene.scene === 'error') return null
  if (scene.scene === 'loading') return undefined
  const roster = scene.roster ?? fixture.roster
  return { fetchedAt: roster.fetchedAt, stale: roster.stale, ...publicRoster(roster) }
}
