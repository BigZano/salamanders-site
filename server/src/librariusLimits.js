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
 * createLimits({ now = Date.now }) → { check, take, snapshot, size, holding, working, hold }. `now` is the clock, in milliseconds.
 *   check(kind, key) → { ok: true } | { ok: false, retryAfter, error }: whether a try of that kind by that member (`key`, the
 *     member's id) would be let through now. It takes nothing.
 *   take(kind, key) → { ok: true, refund } | the same refusal: as check, and a try that is let through is counted. A refused try
 *     is not counted, so asking again and again does not push the wait out. `retryAfter` is the whole seconds to wait, at least
 *     1, until the oldest try inside the window leaves it; `error` is the copy for the member (tooFast). `refund()` gives that
 *     try back, as if it had never been taken, for a try that turned out to cost nothing: once, however often it is called. A
 *     try that has left its window already is gone, and giving it back changes nothing.
 *   snapshot(key) → { reply, edit, upload }, each { limit, windowSeconds, remaining }: what a member has left, for /librarius/me.
 *   size() → how many (kind, member) pairs it holds a try for. A pair is dropped as soon as it is looked at with every one of
 *     its tries a window old, so it holds at most what the members who are writing now have done.
 *   holding() → how many members hold a place in flight now, which is none once every place is released: a member is forgotten with their last.
 *   working() → how many places for all are taken now (see work()), which is none once every place is released.
 *   hold(key) → { ok: true, work, release } | { ok: false, status: 429, error: BUSY.member }: a member's place for a picture, from
 *     the moment it starts to arrive to its end, at most IN_FLIGHT.perMember at a time. A refused hold takes nothing. A picture on
 *     its way holds no more than its own bytes, so a hold takes none of the places for all: a slow arrival keeps nobody else waiting.
 *   work() → { ok: true } | { ok: false, status: 503, error: BUSY.site }: one of the IN_FLIGHT.total places for all, taken once
 *     the picture has arrived, for the work that holds it in memory several times over (it is read as a form, judged and
 *     stripped). Asked again by a hold that has one, it takes no other. A refused work() takes nothing and leaves the member's
 *     place as it was; a hold that has been released cannot work (an Error), since nothing would free that place.
 *   release() frees the member's place, and the place for all if it took one: once, however often it is called.
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

/** How many pictures may be in flight at once: a member's, from the moment one starts to arrive; and everyone's being worked (read as a form, judged and stripped). */
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
  // The pictures in flight: how many each member has, and how many are being worked in all.
  const flying = new Map()
  let inWork = 0

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
    if (!record) return { ok: true }
    const id = slot(kind, key)
    held.set(id, [...live, t])
    let given = false
    return {
      ok: true,
      refund() {
        if (given) return
        given = true
        // The pair may have been dropped, or its tries filtered into a new list, since: the one counted now is what is changed.
        const times = held.get(id) ?? []
        const at = times.lastIndexOf(t)
        if (at === -1) return
        times.splice(at, 1)
        if (times.length === 0) held.delete(id)
      },
    }
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

    working: () => inWork,

    hold(key) {
      needKey(key)
      const mine = flying.get(key) ?? 0
      if (mine >= IN_FLIGHT.perMember) return { ok: false, status: 429, error: BUSY.member }
      flying.set(key, mine + 1)
      let freed = false
      let worked = false
      return {
        ok: true,
        work() {
          if (freed) throw new Error('A place that was released cannot be worked.')
          if (worked) return { ok: true }
          if (inWork >= IN_FLIGHT.total) return { ok: false, status: 503, error: BUSY.site }
          worked = true
          inWork += 1
          return { ok: true }
        },
        release() {
          if (freed) return
          freed = true
          if (worked) inWork -= 1
          const left = flying.get(key) - 1
          if (left === 0) flying.delete(key)
          else flying.set(key, left)
        },
      }
    },
  }
}
