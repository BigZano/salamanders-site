/**
 * Member reports: XVIIIth Legion members file, Reclusiarchs review and either
 * resolve or escalate to High Command's official form, Admins watch and hold
 * a reopen failsafe. See docs/superpowers/specs/2026-09-26-member-reports-design.md.
 *
 * Every role is checked live against Discord (discordRoles.js) on every
 * request; every uncertain path fails closed. Storage sits behind `store`
 * (reportsStore.js in production) so this file is testable without Postgres.
 * Nothing here ever deletes a report.
 */
import { Upstream } from './discordRoles.js'

export const MEDIUMS = ['text', 'voice', 'dm', 'other']
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ID_ROUTE = /^\/reports\/(\d{1,15})(?:\/(claim|resolve|escalate|reopen))?$/

// action → who may, which states it leaves, what it sets
const TRANSITIONS = {
  claim: { role: 'reviewer', from: ['received'], to: 'under_review', note: 'none' },
  resolve: { role: 'reviewer', from: ['under_review'], to: 'resolved', note: 'required' },
  escalate: { role: 'reviewer', from: ['under_review'], to: 'escalated', note: 'optional' },
  reopen: { role: 'admin', from: ['resolved', 'escalated'], to: 'under_review', note: 'required' },
}
const PAST = { claim: 'claimed', resolve: 'resolved', escalate: 'escalated', reopen: 'reopened' }

export function createReportsHandler({ roles, store, reporterRoleId, reviewerRoleId, webhookUrl, siteUrl, fetchImpl = fetch, log = console.error }) {
  async function access(user) {
    const held = await roles.rolesOf(user.id)
    if (!held) return { reporter: false, reviewer: false, admin: false }
    return {
      reporter: held.includes(reporterRoleId),
      reviewer: held.includes(reviewerRoleId),
      admin: await roles.isAdmin(user.id, held),
    }
  }

  function notify(id) {
    if (!webhookUrl) return
    fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Id and link only — the report itself stays behind the role check.
      body: JSON.stringify({
        content: `New member report #${id} — review: ${siteUrl || ''}/reports/review`,
        allowed_mentions: { parse: [] },
      }),
    }).catch(log)
  }

  async function route(request, url, user) {
    const { pathname } = url
    const method = request.method
    const can = await access(user)

    if (pathname === '/reports/access' && method === 'GET') return reply(200, can)

    if (pathname === '/reports' && method === 'POST') {
      if (!can.reporter) return reply(403, { error: 'Reports are open to XVIIIth Legion members.' })
      const fields = validate(await request.json().catch(() => null))
      if (typeof fields === 'string') return reply(400, { error: fields })
      const id = await store.insert(fields, user)
      notify(id)
      return reply(201, { id })
    }

    if (pathname === '/reports/mine' && method === 'GET') {
      if (!can.reporter) return reply(403, { error: 'Reports are open to XVIIIth Legion members.' })
      const rows = await store.listByReporter(user.id)
      return reply(200, rows.map(({ id, reportedMember, status, createdAt, updatedAt }) => ({ id, reportedMember, status, createdAt, updatedAt })))
    }

    const reviewerOrAdmin = can.reviewer || can.admin
    if (pathname === '/reports' && method === 'GET') {
      if (!reviewerOrAdmin) return reply(403, { error: 'Restricted to Reclusiarchs.' })
      return reply(200, await store.listAll())
    }

    const m = ID_ROUTE.exec(pathname)
    if (!m) return null
    const id = Number(m[1])
    const action = m[2]

    if (!action && method === 'GET') {
      if (!reviewerOrAdmin) return reply(403, { error: 'Restricted to Reclusiarchs.' })
      const report = await store.get(id)
      return report ? reply(200, report) : reply(404, { error: 'Report not found.' })
    }

    if (action && method === 'POST') {
      const t = TRANSITIONS[action]
      if (!can[t.role]) return reply(403, { error: t.role === 'admin' ? 'Only an Administrator can reopen a report.' : 'Only a Reclusiarch can do that.' })
      const body = (await request.json().catch(() => null)) || {}
      const note = typeof body.note === 'string' ? body.note.trim() : ''
      if (t.note === 'required' && !note) return reply(400, { error: 'A note is required.' })
      if (note.length > 4000) return reply(400, { error: 'Note is too long.' })
      const result = await store.transition(id, {
        from: t.from,
        to: t.to,
        claim: action === 'claim',
        note: t.note === 'none' ? null : note || null,
        actor: user,
        action: PAST[action],
      })
      if (result === 'missing') return reply(404, { error: 'Report not found.' })
      if (result === 'conflict') return reply(409, { error: 'That report has already moved on — refresh.' })
      return reply(200, result)
    }
    return null
  }

  return async function handle(request, url) {
    if (url.pathname !== '/reports' && !url.pathname.startsWith('/reports/')) return null
    try {
      const user = await roles.identify(request)
      if (!user) return reply(401, { error: 'Sign in with Discord.' })
      return (await route(request, url, user)) ?? reply(404, { error: 'Not found.' })
    } catch (err) {
      if (err instanceof Upstream) return reply(503, { error: 'Discord could not be reached. Try again.' })
      throw err
    }
  }
}

/** → clean fields, or an error message string. */
export function validate(b) {
  if (!b || typeof b !== 'object') return 'Malformed report.'
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const f = {
    reportedMember: str(b.reportedMember),
    description: str(b.description),
    witnesses: str(b.witnesses),
    medium: str(b.medium),
    mediumOther: str(b.mediumOther),
    incidentDate: str(b.incidentDate) || null,
  }
  if (!f.reportedMember || f.reportedMember.length > 200) return 'Name the member being reported (200 characters max).'
  if (!f.description || f.description.length > 4000) return 'Describe what happened (4000 characters max).'
  if (f.witnesses.length > 1000) return 'Witness list is too long.'
  if (!MEDIUMS.includes(f.medium)) return 'Pick where it happened.'
  if (f.medium !== 'other') f.mediumOther = ''
  if (f.medium === 'other' && (!f.mediumOther || f.mediumOther.length > 200)) return 'Say where it happened.'
  if (f.incidentDate && (!DATE.test(f.incidentDate) || Number.isNaN(Date.parse(f.incidentDate)))) return 'Incident date is invalid.'
  return f
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
