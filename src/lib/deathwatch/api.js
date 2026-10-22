/**
 * Client for GET /deathwatch/me (server side to come). It needs a live Discord token and the server
 * re-checks the roles on every call, so the answer is never served from the HTTP cache.
 * Resolves { access: boolean, watchCommander: boolean }; throws a BuildsApiError carrying the status.
 */
import { request } from '../buildsApi'

export const getMe = (token) => request('/deathwatch/me', { token, cache: 'no-store' })
