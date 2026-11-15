/**
 * The links to the Librarius's attachments. Discord signs them and they stop working at the time in their `ex`
 * parameter, so the Librarius asks Discord for new ones before that, and stores them.
 *
 * createLinkRefresh({ discord, store, intervalMs = 600_000, aheadMs = 7_200_000, viewedWithinMs = 86_400_000,
 *   now = Date.now, timers = { setTimeout, clearTimeout }, log = console.error })
 *   → { start(), stop(), runOnce() → Promise<void>, refresh(attachments) → Promise<Map> }
 *
 * runOnce() takes the time once, then does two things that do not depend on each other, so one failing does not stop
 * the other:
 * 1. Takes the attachments that expire within `aheadMs` and belong to a post viewed within `viewedWithinMs` (at most
 *    200, soonest expiry first), asks Discord for new links to them 50 at a time, and stores each new link with the
 *    expiry it carries (null when it carries none). Each chunk is stored as soon as it is refreshed, and the first chunk
 *    that fails ends this step: what the earlier ones stored is kept, and the next run takes up from there. A link
 *    Discord did not refresh is left as it was, and is due again next run. Refreshing a link does not touch the message
 *    it belongs to, so it is no change a client has to hear about (the rev stays where it was).
 * 2. Deletes the delete notes older than a day.
 * runOnce() never rejects: a failure is logged, with every link in what it said cut out. Calls made while a run is
 * going share it.
 *
 * start() makes one timer chain: the first run is due at once (after a delay of 0), each later one `intervalMs` after
 * the one before it ended, so runs never overlap. Starting twice is one chain. stop() ends the chain, and a run that is
 * going finishes without scheduling another.
 *
 * refresh(attachments) → Map of attachment id → { url, expiresAt }, for the read path: `attachments` is a list of at
 * most 50 of { id, url } (anything else they carry is ignored). An attachment whose link Discord did not refresh is not
 * in the Map. Discord being unreachable (Upstream) gives an empty Map, so the caller keeps the link it has; anything
 * else is thrown. It writes nothing: the caller borrows the new links for one answer.
 */
import { Upstream } from './discordRoles.js'
import { linkExpiry } from './librariusParse.js'

// Discord's most links for one refresh call.
const CHUNK = 50
// The most one run refreshes: four calls to Discord.
const DUE_LIMIT = 200
const TOMBSTONE_KEEP_MS = 86_400_000
const MAX_TIMER_MS = 2_147_483_647
// The longest a window may be: a year, far past anything Discord's links last.
const MAX_SPAN_MS = 31_536_000_000
const MAX_ERROR = 200
const STORE_METHODS = ['attachmentsToRefresh', 'updateAttachmentUrls', 'pruneTombstones']

// For the log: the name and what the error says, with any link (a signed CDN one, say) cut out.
// Stryker disable next-line StringLiteral: the stand-in for a link only words a log line, and no test asserts the log
const withoutLinks = (text) => text.replace(/https?:\/\/\S*/gi, '[link]')
// Stryker disable next-line StringLiteral,LogicalOperator: this only words a log line, and no test asserts the log; the link cut and the length are asserted
const describe = (err) => withoutLinks(`${err?.name ?? 'Error'}: ${err?.message ?? ''}`).slice(0, MAX_ERROR)

function needMs(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be a whole number of milliseconds from 1 to ${max}.`)
}

function needAttachments(attachments) {
  if (!Array.isArray(attachments)) throw new TypeError('attachments must be a list.')
  if (attachments.length > CHUNK) throw new RangeError(`At most ${CHUNK} links can be refreshed at once.`)
  for (const a of attachments) {
    if (typeof a?.id !== 'string' || typeof a.url !== 'string') throw new TypeError('each attachment must have an id and a url, as text.')
  }
}

export function createLinkRefresh({
  discord,
  store,
  intervalMs = 600_000,
  aheadMs = 7_200_000,
  viewedWithinMs = 86_400_000,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  log = console.error,
} = {}) {
  if (typeof discord?.refreshUrls !== 'function') throw new TypeError('discord.refreshUrls must be a function.')
  for (const name of STORE_METHODS) if (typeof store?.[name] !== 'function') throw new TypeError(`store.${name} must be a function.`)
  if (typeof now !== 'function') throw new TypeError('now must be a function.')
  if (typeof log !== 'function') throw new TypeError('log must be a function.')
  if (typeof timers?.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new TypeError('timers must have a setTimeout and a clearTimeout function.')
  }
  needMs(intervalMs, 'intervalMs', MAX_TIMER_MS)
  needMs(aheadMs, 'aheadMs', MAX_SPAN_MS)
  needMs(viewedWithinMs, 'viewedWithinMs', MAX_SPAN_MS)

  // Stryker disable next-line ArrowFunction,StringLiteral: what is logged is for the owner to read, and no test asserts it
  const report = (what, err) => log(`Librarius links: ${what}: ${describe(err)}`)
  let current = null
  // The chain of timers start() made, or null when there is none. A timer answers only for the chain that set it, so a
  // run that outlives a stop() and a start() does not leave two chains.
  let chain = null
  let timer

  /** Do `work`; a failure of any kind is logged, never thrown. */
  async function attempt(what, work) {
    // Stryker disable next-line BlockStatement: what is logged is for the owner to read, and no test asserts it
    try { await work() } catch (err) { report(what, err) }
  }

  /** Ask Discord for new links to these attachments → [{ id, url, expiresAt }] for those it refreshed. */
  async function renew(attachments) {
    const refreshed = await discord.refreshUrls(attachments.map((a) => a.url))
    const updates = []
    for (const { id, url } of attachments) {
      const fresh = refreshed.get(url)
      if (fresh !== undefined) updates.push({ id, url: fresh, expiresAt: linkExpiry(fresh) })
    }
    return updates
  }

  async function renewDue(t) {
    const due = await store.attachmentsToRefresh({ expiringBefore: t + aheadMs, viewedSince: t - viewedWithinMs, limit: DUE_LIMIT })
    for (let i = 0; i < due.length; i += CHUNK) {
      const updates = await renew(due.slice(i, i + CHUNK))
      if (updates.length > 0) await store.updateAttachmentUrls(updates)
    }
  }

  async function pass() {
    const t = now()
    // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
    await attempt('could not refresh the links', () => renewDue(t))
    // Stryker disable next-line StringLiteral: as above
    await attempt('could not delete the old delete notes', () => store.pruneTombstones(t - TOMBSTONE_KEEP_MS))
  }

  function runOnce() {
    if (current === null) {
      // Stryker disable next-line StringLiteral: as above
      current = attempt('the run failed', pass).finally(() => {
        current = null
      })
    }
    return current
  }

  function schedule(mine, delay) {
    timer = timers.setTimeout(async () => {
      if (chain !== mine) return
      await runOnce()
      if (chain === mine) schedule(mine, intervalMs)
    }, delay)
  }

  return {
    runOnce,

    async refresh(attachments) {
      needAttachments(attachments)
      let updates
      try {
        updates = await renew(attachments)
      } catch (err) {
        if (err instanceof Upstream) return new Map()
        throw err
      }
      return new Map(updates.map(({ id, url, expiresAt }) => [id, { url, expiresAt }]))
    },

    start() {
      if (chain !== null) return
      chain = {}
      schedule(chain, 0)
    },

    stop() {
      chain = null
      timers.clearTimeout(timer)
    },
  }
}
