/**
 * Named states of the Deathwatch gate for design work, with no server. Dev only; see fixture.js.
 *   allowed      signed in, and cleared
 *   commander    signed in, cleared, and the Watch Commander
 *   denied       signed in, but not cleared
 *   signin       signed out
 *   checking     the server has not answered yet (it never does)
 *   unavailable  the server could not be reached
 * Two more pick the area's data (fixtureData.js), seen as the Watch Commander so Manage is open too:
 *   empty         no Kill Teams and no archive, as on the first day
 *   active-event  a running event and one archived tour (every other scene shows this data as well)
 * The status names are the store's (the spec's "signed-out" state is `signin`, as the roster calls it).
 */
export const SCENES = ['allowed', 'commander', 'denied', 'signin', 'checking', 'unavailable', 'empty', 'active-event']

const SHAPES = {
  allowed: { status: 'allowed', commander: false },
  commander: { status: 'allowed', commander: true },
  denied: { status: 'denied', commander: false },
  signin: { status: 'signin', commander: false },
  checking: { status: 'checking', commander: false },
  unavailable: { status: 'unavailable', commander: false },
  empty: { status: 'allowed', commander: true },
  'active-event': { status: 'allowed', commander: true },
}

/** The named scene in the shape the store reads. An unknown name gives 'allowed'. */
export function sceneOf(name) {
  const scene = SCENES.includes(name) ? name : 'allowed'
  return { _fixture: true, scene, ...SHAPES[scene] }
}
