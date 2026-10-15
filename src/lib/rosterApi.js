/**
 * Client for GET /roster and GET /roster/infirmary (server/src/rosterHandler.js).
 * Both need a live Discord token; the server re-checks roles on every call.
 * Never served from the HTTP cache: a roster is only as good as its freshness.
 */
import { request } from './buildsApi'

export const getRoster = (token) => request('/roster', { token, cache: 'no-store' })
export const getInfirmary = (token) => request('/roster/infirmary', { token, cache: 'no-store' })
// The public projection (leaders by name, ranks as counts): no sign-in, and the browser may cache it for the minute the server allows.
export const getPublicRoster = () => request('/roster/public')
