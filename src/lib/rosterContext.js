/**
 * Injection key for the signed-in member's Discord id, provided by the roster
 * page (a Ref<string | null>) and read by each chip to mark "You". Provide/inject
 * rather than a prop, so the id does not have to be threaded through every level.
 */
export const ROSTER_VIEWER = Symbol('rosterViewer')
