/**
 * Perk corrections, the version history, and privilege revocation. See
 * docs/superpowers/specs/2026-09-27-perk-corrections-design.md.
 *
 * GET /perk-corrections is public (the site renders from it). Everything else
 * identifies the caller with Discord and checks privileges live
 * (privileges.js) on every request; uncertain paths fail closed. Storage sits
 * behind `store` (historyStore.js in production) so this file is testable
 * without Postgres.
 */
import { Upstream } from './discordRoles.js'
import { QUALITIES, OPS, LIMITS, PERK_NAME, applyWeaponCorrections, hasWeaponPerk, toDocument, sanitizeText } from './perkCorrectionsCore.js'
import { mayRevoke } from './privileges.js'

const REVERT = /^\/perk-corrections\/(\d{1,15})\/revert$/
const PRIVILEGE = /^\/privileges\/(\d{17,20})\/(revoke|reinstate)$/
const SUBJECTS = ['perk_correction', 'build', 'privilege']
const PREFIXES = ['/perk-corrections', '/history', '/privileges']
const PAST = { add: 'added', remove: 'removed', edit: 'edited' }

const label = (c) => `${c.target}${c.quality ? ` / ${c.quality}` : ''} — ${PAST[c.op]} ${c.perkName}`

export function createPerksHandler({ roles, privileges, store, loadBake, notify = () => {} }) {
  const doc = async () => toDocument(await store.listActive())

  /** → null when the correction's target (and, for remove/edit, its perk) exists; else a 404 message. */
  async function missingTarget(c) {
    const bake = await loadBake()
    if (c.kind === 'class') {
      if (!Object.hasOwn(bake.classes, c.target)) return `Unknown class: ${c.target}.`
      const cls = bake.classes[c.target]
      return cls.perks && Object.hasOwn(cls.perks, c.perkName) ? null : `${c.target} has no perk named ${c.perkName}.`
    }
    if (!Object.hasOwn(bake.weapons, c.target)) return `Unknown weapon: ${c.target}.`
    const tree = bake.weapons[c.target]
    if (c.op === 'add') return null
    const active = (await store.listActive()).filter((x) => x.kind === 'weapon' && x.target === c.target)
    return hasWeaponPerk(applyWeaponCorrections(tree, active), c.quality, c.perkName)
      ? null
      : `${c.target} has no ${c.quality} perk named ${c.perkName}.`
  }

  async function route(request, url) {
    const { pathname } = url
    const method = request.method

    if (pathname === '/perk-corrections' && method === 'GET') return reply(200, await doc(), 'public, max-age=30')

    const user = await roles.identify(request)
    if (!user) return reply(401, { error: 'Sign in with Discord.' })
    const me = await privileges.forUser(user)
    const refuse = () =>
      reply(403, { error: me.revoked ? 'Your site privileges have been revoked.' : 'Restricted to the forge and Legion leadership.' })

    if (pathname === '/privileges/me' && method === 'GET') {
      const { editor, historyViewer, moderator, revoked, revoker } = me
      return reply(200, { editor, historyViewer, moderator, revoked, revoker })
    }

    if (pathname === '/perk-corrections' && method === 'POST') {
      if (!me.editor) return refuse()
      const c = validateCorrection(await request.json().catch(() => null))
      if (typeof c === 'string') return reply(400, { error: c })
      const missing = await missingTarget(c)
      if (missing) return reply(404, { error: missing })
      const saved = await store.insertCorrection(c, user)
      notify(`Perk correction by ${user.username}: ${label(saved)}${saved.note ? ` ("${saved.note}")` : ''}`)
      return reply(201, await doc())
    }

    const rv = REVERT.exec(pathname)
    if (rv && method === 'POST') {
      if (!me.editor) return refuse()
      const note = sanitizeText(((await request.json().catch(() => null)) || {}).note)
      if (note.length > LIMITS.note) return reply(400, { error: 'Note is too long (200 characters max).' })
      const result = await store.revertCorrection(Number(rv[1]), user, note || null)
      if (result === 'missing') return reply(404, { error: 'Correction not found.' })
      if (result === 'conflict') return reply(409, { error: 'That correction was already reverted — refresh.' })
      notify(`${user.username} reverted perk correction #${result.id} (${label(result)})${note ? `: ${note}` : ''}`)
      return reply(200, await doc())
    }

    if (pathname === '/history' && method === 'GET') {
      if (!me.historyViewer) return refuse()
      const subject = url.searchParams.get('subject') || null
      if (subject && !SUBJECTS.includes(subject)) return reply(400, { error: 'Unknown history filter.' })
      const qText = sanitizeText(url.searchParams.get('q'))
      if (qText.length > LIMITS.target) return reply(400, { error: 'Search is too long.' })
      const q = qText || null
      const beforeRaw = url.searchParams.get('before') || ''
      const before = /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : null
      const page = await store.history({ subject, q, before, limit: 50 })
      return reply(200, { ...page, revocations: me.revoker ? await store.listOpenRevocations() : [] })
    }

    const pm = PRIVILEGE.exec(pathname)
    if (pm && method === 'POST') {
      const [, targetId, action] = pm
      if (!me.revoker) return refuse()
      const target = await privileges.target(targetId)
      if (!target) return reply(404, { error: 'That member is not in the server.' })
      if (!mayRevoke(me, target)) return reply(403, { error: "You can't change that member's privileges." })
      const body = (await request.json().catch(() => null)) || {}
      const reason = sanitizeText(body.reason)
      if (reason.length > LIMITS.note) return reply(400, { error: 'Reason is too long (200 characters max).' })
      if (action === 'revoke') {
        if (!reason) return reply(400, { error: 'Give a reason.' })
        const usernameText = sanitizeText(body.username)
        if (usernameText.length > 100) return reply(400, { error: 'Username is too long.' })
        const username = usernameText || targetId
        const r = await store.revoke({ id: targetId, username }, user, reason)
        if (r === 'conflict') return reply(409, { error: 'Already revoked.' })
        notify(`${user.username} revoked site privileges for ${username}: ${reason}`)
        return reply(201, r)
      }
      const r = await store.reinstate(targetId, user, reason || null)
      if (r === 'conflict') return reply(409, { error: 'That member is not revoked.' })
      notify(`${user.username} reinstated site privileges for ${r.username}`)
      return reply(200, r)
    }
    return null
  }

  return async function handle(request, url) {
    if (!PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return null
    try {
      return (await route(request, url)) ?? reply(404, { error: 'Not found.' })
    } catch (err) {
      if (err instanceof Upstream) return reply(503, { error: 'Discord or the perk data could not be reached. Try again.' })
      throw err
    }
  }
}

/** → clean correction, or an error message string. */
export function validateCorrection(b) {
  if (!b || typeof b !== 'object') return 'Malformed correction.'
  const c = {
    kind: sanitizeText(b.kind),
    target: sanitizeText(b.target),
    quality: sanitizeText(b.quality) || null,
    op: sanitizeText(b.op),
    perkName: sanitizeText(b.perkName),
    description: sanitizeText(b.description) || null,
    note: sanitizeText(b.note) || null,
  }
  if (!['weapon', 'class'].includes(c.kind)) return 'Pick weapon or class.'
  if (!c.target || c.target.length > LIMITS.target) return 'Name the weapon or class.'
  if (c.kind === 'class') {
    if (c.op !== 'edit') return 'Class perks can only have their text corrected.'
    c.quality = null
  } else {
    if (!QUALITIES.includes(c.quality)) return 'Pick a tier.'
    if (!OPS.includes(c.op)) return 'Pick add, remove or edit.'
  }
  if (!c.perkName || c.perkName.length > LIMITS.perkName) return 'Name the perk (80 characters max).'
  if (!PERK_NAME.test(c.perkName)) return 'Perk names can only use letters, numbers and basic punctuation.'
  if (c.op === 'remove') c.description = null
  else if (!c.description || c.description.length > LIMITS.description) return 'Describe the perk (500 characters max).'
  if (c.note && c.note.length > LIMITS.note) return 'Note is too long (200 characters max).'
  return c
}

function reply(status, body, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  })
}
