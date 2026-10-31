/**
 * Client for the Deathwatch routes (server/src/deathwatchHandler.js). Every call needs a live Discord token and
 * the server re-checks the roles each time, so nothing is served from the HTTP cache. Each throws a BuildsApiError
 * carrying the status.
 */
import { API_BASE, BuildsApiError, request } from '../buildsApi'

/** → { access: boolean, watchCommander: boolean, deathwatchCommand: boolean } */
export const getMe = (token) => request('/deathwatch/me', { token, cache: 'no-store' })

/**
 * Every document, by collection and id. With the ETag of the last answer, the server says 304 when nothing changed
 * (the server exposes ETag to the page and allows If-None-Match, see server/src/cors.js).
 * → { data: { teams, cfg, archive }, etag }, or null when nothing changed.
 */
export async function getData(token, etag) {
  const headers = { Authorization: `Bearer ${token}` }
  if (etag) headers['If-None-Match'] = etag
  const res = await fetch(`${API_BASE}/deathwatch/data`, { headers, cache: 'no-store' })
  if (res.status === 304) return null
  if (!res.ok) {
    const parsed = await res.json().catch(() => null)
    throw new BuildsApiError(parsed?.error || `Request failed (${res.status})`, res.status)
  }
  return { data: await res.json(), etag: res.headers.get('ETag') }
}

/** Sets (doc is an object) or deletes (doc is null) one document. Watch Commander only. → { ok, changed } */
export const writeDoc = (token, col, id, doc) =>
  request('/deathwatch/doc', { method: 'POST', token, body: doc === null ? { col, id: String(id), op: 'delete' } : { col, id: String(id), op: 'set', doc } })
