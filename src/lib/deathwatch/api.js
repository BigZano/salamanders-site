/**
 * Client for the Deathwatch routes (server/src/deathwatchHandler.js). Every call needs a live Discord token and
 * the server re-checks the roles each time, so nothing is served from the HTTP cache. Each throws a BuildsApiError
 * carrying the status.
 */
import { request } from '../buildsApi'

/** → { access: boolean, watchCommander: boolean } */
export const getMe = (token) => request('/deathwatch/me', { token, cache: 'no-store' })

/** → { teams, cfg, archive }: every document, by collection and id. */
export const getData = (token) => request('/deathwatch/data', { token, cache: 'no-store' })

/** Sets (doc is an object) or deletes (doc is null) one document. Watch Commander only. → { ok, changed } */
export const writeDoc = (token, col, id, doc) =>
  request('/deathwatch/doc', { method: 'POST', token, body: doc === null ? { col, id: String(id), op: 'delete' } : { col, id: String(id), op: 'set', doc } })
