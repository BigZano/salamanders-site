/**
 * The Librarius's upload sweeper (batch 2): the timer that finds the pictures held for replies and deletes the ones nobody will
 * send. A picture is held (librarius_uploads) from the moment a member uploads it until the reply that names it is sent, and the
 * outbox deletes it then. What is left is swept here:
 *   - a picture held for more than an hour (`maxAgeMs`), which was never sent;
 *   - the pictures of a reply that ended for good ('failed' or 'blocked'): nothing will send them now;
 * and never a picture that a reply still on its way ('pending' or 'sending') names, however old it is. A reply held up by the
 * outbox's one-hour pause (the breaker) would otherwise lose its pictures, and fail, in the middle of being sent. The outbox deletes
 * them after sending. All of that is one statement of the store (sweepUploads), which this module only times.
 *
 * The same timer prunes the outbox (store.pruneOutbox), once an hour (and at the first sweep): the entries that are done ('sent') and
 * more than a day old, which hold the full text of replies that may have been deleted since. The events (librarius_events) are never
 * pruned: they are the Librarians' record of what was done from the site and by whom, for which the spec sets no end. A prune that
 * fails is logged and tried again at the next sweep; it never fails the sweep.
 *
 * createUploadSweeper({ store, now = Date.now, timers = { setTimeout, clearTimeout }, intervalMs = 60000, maxAgeMs = 3600000,
 *   log = console.error }) → { start(), stop() → Promise, sweep() → Promise<number> }
 *   sweep() deletes at once and answers how many it deleted. It never rejects: a store that fails is logged (without a link or a
 *   token: describe() of librariusText) and counts as nothing swept, since the next sweep finds the same. Sweeps asked for at the
 *   same time share one trip to the store.
 *   start() sweeps now, and again `intervalMs` after the end of each sweep, so no two overlap. It does nothing when it has been
 *   started or stopped already. stop() clears the timer and answers once a sweep that is running is over; it is for good.
 * Pictures are held at most an hour and a minute: an hour of age, and the sweep that finds it comes within the interval.
 */
import { describe } from './librariusText.js'

const MAX_TIMER_MS = 2 ** 31 - 1
const DAY_MS = 86_400_000
// What the prune keeps: a done entry for a day (an event for ever); and how often it looks.
const SENT_KEEP_MS = DAY_MS
const PRUNE_EVERY_MS = 3_600_000

export function createUploadSweeper({ store, now = Date.now, timers = { setTimeout, clearTimeout }, intervalMs = 60_000, maxAgeMs = 3_600_000, log = console.error }) {
  if (typeof store?.sweepUploads !== 'function') throw new TypeError('store.sweepUploads must be a function.')
  if (typeof store.pruneOutbox !== 'function') throw new TypeError('store.pruneOutbox must be a function.')
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_MS) throw new RangeError(`intervalMs must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}.`)
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) throw new RangeError('maxAgeMs must be a whole number of milliseconds of at least 1.')

  let started = false
  let stopped = false
  let timer = null
  let running = null // the sweep in progress
  let prunedAt = -Infinity // when the last prune that worked was

  /** Prunes the outbox when it is time, and never fails: what could not be pruned now is found at the next sweep. */
  async function prune() {
    const t = now()
    if (t - prunedAt < PRUNE_EVERY_MS) return
    try {
      await store.pruneOutbox({ sentBefore: t - SENT_KEEP_MS })
      prunedAt = t
    } catch (err) {
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      log(`Librarius outbox prune failed: ${describe(err)}`)
    }
  }

  async function once() {
    let swept = 0
    try {
      swept = await store.sweepUploads({ olderThan: now() - maxAgeMs })
    } catch (err) {
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      log(`Librarius upload sweep failed: ${describe(err)}`)
    }
    await prune()
    return swept
  }

  function sweep() {
    if (running === null) {
      const done = once().finally(() => {
        running = null
      })
      running = done
    }
    return running
  }

  function schedule() {
    timer = timers.setTimeout(tick, intervalMs)
  }

  async function tick() {
    timer = null
    if (stopped) return
    await sweep()
    if (!stopped) schedule()
  }

  return {
    sweep,

    start() {
      if (started || stopped) return
      started = true
      sweep().then(() => {
        if (!stopped) schedule()
      })
    },

    async stop() {
      stopped = true
      if (timer !== null) timers.clearTimeout(timer)
      timer = null
      await running
    },
  }
}
