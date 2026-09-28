/**
 * Client for perk corrections, version history and privileges
 * (server/src/perks.js). Only GET /perk-corrections is public; everything
 * else needs a live Discord token and is re-checked by the server.
 */
import { request } from './buildsApi'

export const getCorrections = () => request('/perk-corrections')
export const getPrivileges = (token) => request('/privileges/me', { token })
export const submitCorrection = (correction, token) => request('/perk-corrections', { method: 'POST', token, body: correction })
export const revertCorrection = (id, note, token) =>
  request(`/perk-corrections/${id}/revert`, { method: 'POST', token, body: note ? { note } : {} })

export function getHistory({ subject, q, before } = {}, token) {
  const p = new URLSearchParams()
  if (subject) p.set('subject', subject)
  if (q) p.set('q', q)
  if (before) p.set('before', String(before))
  const qs = p.toString()
  return request(`/history${qs ? `?${qs}` : ''}`, { token })
}

export const revokePrivileges = (discordId, { reason, username }, token) =>
  request(`/privileges/${discordId}/revoke`, { method: 'POST', token, body: { reason, username } })
export const reinstatePrivileges = (discordId, note, token) =>
  request(`/privileges/${discordId}/reinstate`, { method: 'POST', token, body: note ? { reason: note } : {} })
