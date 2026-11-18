/**
 * How often a member may write to the Librarius from the site: the per-member limits of the spec's "No member is ever struck
 * because of the site" (3 replies a minute, so at most 9 Discord messages a minute from one member), 20 edits a minute and
 * 30 uploads an hour. Sliding windows, kept in memory: a restart gives everyone a fresh count, which is as the limits are
 * meant, since the outbox keeps its own ceiling over all members (librariusOutbox.js) and that one is rebuilt from the store.
 *
 * Besides those, which count what is let through, three windows count tries: `writeTry` (20 a minute), `uploadTry` (10 a minute)
 * and `search` (30 a minute). A write route takes its place in one of them before it reads anything, so a request that is
 * refused later, for a body that is no picture or a reply that is blocked, has still cost its member a place: refused work is
 * not free (a picture of 10 MB that is refused for what it holds took a good half second to find out). They are `take`n like any
 * other kind, and snapshot() leaves them out: a member is told of what they have left of the first three.
 *
 * createLimits({ now = Date.now }) → { check, take, snapshot, size, hold }. `now` is the clock, in milliseconds.
 *   check(kind, key) → { ok: true } | { ok: false, retryAfter, error }: whether a try of that kind by that member (`key`, the
 *     member's id) would be let through now. It takes nothing.
 *   take(kind, key): the same, and a try that is let through is counted. A refused try is not counted, so asking again and
 *     again does not push the wait out. `retryAfter` is the whole seconds to wait, at least 1, until the oldest try inside
 *     the window leaves it; `error` is the copy for the member (tooFast).
 *   snapshot(key) → { reply, edit, upload }, each { limit, windowSeconds, remaining }: what a member has left, for /librarius/me.
 *   size() → how many (kind, member) pairs it holds a try for. A pair is dropped as soon as it is looked at with every one of
 *     its tries a window old, so it holds at most what the members who are writing now have done.
 *   holding() → how many members hold a place in flight now, which is none once every place is released: a member is forgotten with their last.
 *   hold(key) → { ok: true, release } | { ok: false, status, error }: a place for a picture being received, which is held in
 *     memory several times over while it is read, judged and stripped. At most IN_FLIGHT.perMember at a time for a member (429,
 *     BUSY.member) and IN_FLIGHT.total for all (503, BUSY.site); a member who is at their own cap is told so first. `release`
 *     frees the place, once, however often it is called. A refused hold takes nothing.
 * A try counts for `windowMs` exactly: at the very millisecond it is a window old it no longer does.
 *
 * `kind` is one of LIMITS' names, else a RangeError; `key` is a non-empty string, else a TypeError, and so is a clock that gives
 * anything but a finite number. A key is a Map's, so a name like "__proto__" is a member like any other.
 */

/** The spec's numbers: how many tries of a kind in how long. */
export const LIMITS = Object.freeze({
  reply: Object.freeze({ limit: 3, windowMs: 60_000 }),
  edit: Object.freeze({ limit: 20, windowMs: 60_000 }),
  upload: Object.freeze({ limit: 30, windowMs: 3_600_000 }),
  writeTry: Object.freeze({ limit: 20, windowMs: 60_000 }),
  uploadTry: Object.freeze({ limit: 10, windowMs: 60_000 }),
  search: Object.freeze({ limit: 30, windowMs: 60_000 }),
})

/** How many pictures may be in flight (being read, judged and stripped) at once: for one member, and for everyone. */
export const IN_FLIGHT = Object.freeze({ perMember: 2, total: 4 })

/** What a member is told when a picture is turned away for want of a place in flight. */
export const BUSY = Object.freeze({
  member: 'One picture at a time, please.',
  site: 'The site is busy with pictures; try again in a moment.',
})

const KINDS = Object.keys(LIMITS)
// What snapshot() tells a member of: the windows that count what is let through, not the ones that count tries.
const SHOWN = ['reply', 'edit', 'upload']

/** → what a member is told when they are over a limit, with the seconds to wait. */
export const tooFast = (seconds) => `Slow down a little: try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`

export function createLimits({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function.')
  // 'kind key' → the times of the tries counted, oldest first. Only a pair with a try inside its window is held.
  const held = new Map()
  // The pictures in flight: how many each member has, and how many there are in all.
  const flying = new Map()
  let inFlight = 0

  const slot = (kind, key) => `${kind} ${key}`

  function needKind(kind) {
    if (!KINDS.includes(kind)) throw new RangeError(`kind must be one of ${KINDS.join(', ')}.`)
  }

  function needKey(key) {
    if (typeof key !== 'string' || key === '') throw new TypeError('key must be a non-empty string.')
  }

  function clock() {
    const t = now()
    if (!Number.isFinite(t)) throw new TypeError('The clock must give a finite number of milliseconds.')
    return t
  }

  /** The times of the tries of a kind still inside the window at `t`, oldest first. The pair is dropped when none is. */
  function inside(kind, key, t) {
    const id = slot(kind, key)
    const times = held.get(id)
    if (times === undefined) return []
    const live = times.filter((at) => at > t - LIMITS[kind].windowMs)
    if (live.length === 0) held.delete(id)
    else held.set(id, live)
    return live
  }

  function verdict(kind, key, record) {
    needKind(kind)
    needKey(key)
    const t = clock()
    const live = inside(kind, key, t)
    if (live.length >= LIMITS[kind].limit) {
      const retryAfter = Math.ceil((live[0] + LIMITS[kind].windowMs - t) / 1000)
      return { ok: false, retryAfter, error: tooFast(retryAfter) }
    }
    if (record) held.set(slot(kind, key), [...live, t])
    return { ok: true }
  }

  return {
    check: (kind, key) => verdict(kind, key, false),
    take: (kind, key) => verdict(kind, key, true),

    snapshot(key) {
      needKey(key)
      const t = clock()
      return Object.fromEntries(
        SHOWN.map((kind) => [
          kind,
          { limit: LIMITS[kind].limit, windowSeconds: LIMITS[kind].windowMs / 1000, remaining: LIMITS[kind].limit - inside(kind, key, t).length },
        ]),
      )
    },

    size: () => held.size,

    holding: () => flying.size,

    hold(key) {
      needKey(key)
      const mine = flying.get(key) ?? 0
      if (mine >= IN_FLIGHT.perMember) return { ok: false, status: 429, error: BUSY.member }
      if (inFlight >= IN_FLIGHT.total) return { ok: false, status: 503, error: BUSY.site }
      flying.set(key, mine + 1)
      inFlight += 1
      let freed = false
      return {
        ok: true,
        release() {
          if (freed) return
          freed = true
          inFlight -= 1
          const left = flying.get(key) - 1
          if (left === 0) flying.delete(key)
          else flying.set(key, left)
        },
      }
    },
  }
}
