/**
 * Client for the member reports API (server/src/reports.js). Every call needs
 * a live Discord token; the server re-checks roles against Discord each time.
 */
import { request } from './buildsApi'

export const getAccess = (token) => request('/reports/access', { token })
export const fileReport = (report, token) => request('/reports', { method: 'POST', token, body: report })
export const listMine = (token) => request('/reports/mine', { token })
export const listAll = (token) => request('/reports', { token })
export const getReport = (id, token) => request(`/reports/${id}`, { token })
/** action: claim | resolve | escalate | reopen */
export const act = (id, action, note, token) =>
  request(`/reports/${id}/${action}`, { method: 'POST', token, body: note ? { note } : {} })

export const STATUS_LABELS = {
  received: 'Received',
  under_review: 'Under review',
  resolved: 'Resolved',
  escalated: 'Escalated to High Command',
}
