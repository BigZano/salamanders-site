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
    const asked = new URLSearchParams(globalThis.location?.search ?? '').get('scene') || String(import.meta.env.VITE_ROSTER_FIXTURE)
    return sceneOf(fixture, asked)
  }
  return null
}
