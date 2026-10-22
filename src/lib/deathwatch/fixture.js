/**
 * Stand-in for GET /deathwatch/me, so the gate and the pages behind it can be designed without the server.
 * Dev only, and only when asked for: VITE_DEATHWATCH_FIXTURE=1 (or a scene name); ?scene=<name> on the page
 * URL picks a scene without a restart (see scenes.js). The literal condition below is what lets the build
 * drop this branch, so the fixture never reaches the production bundle.
 */
import { sceneOf } from './scenes'

export async function loadFixture() {
  if (import.meta.env.DEV && import.meta.env.VITE_DEATHWATCH_FIXTURE) {
    const asked =
      new URLSearchParams(globalThis.location?.search ?? '').get('scene') || String(import.meta.env.VITE_DEATHWATCH_FIXTURE)
    return sceneOf(asked)
  }
  return null
}
