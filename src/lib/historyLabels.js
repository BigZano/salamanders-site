// One-line summaries for Version History entries (server/src/perks.js events).
const PAST = { add: 'added', remove: 'removed', edit: 'edited' }
const where = (s) => `${s.target}${s.quality ? ` / ${s.quality}` : ''}`

export function historyLabel(e) {
  const who = e.actor.username
  const s = e.snapshot || {}
  if (e.subject === 'perk_correction') {
    const what = `${PAST[s.op]} ${s.perkName} — ${where(s)}`
    return e.action === 'reverted' ? `${who} reverted: ${what}` : `${who} ${what}`
  }
  if (e.subject === 'build') return `${who} deleted build "${s.title}" by ${s.author?.username}`
  if (e.action === 'revoked') return `${who} revoked privileges for ${s.username}: ${s.reason}`
  return `${who} reinstated privileges for ${s.username}`
}
