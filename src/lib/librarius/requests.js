/**
 * How the Librarius composer asks the server for the two things that are counted against a member: the member search behind
 * a mention, and the pictures of a reply.
 *
 * paced(search, { limit, windowMs }) → (q) → a promise of what search(q) gives
 *   The member search, kept under the server's 30 searches a minute (librariusLimits.js), however fast or slow someone types:
 *   no more than `limit` searches (SEARCHES, 20) start in any `windowMs` (a minute). A query is asked at once while the window
 *   has room. Otherwise it waits until the oldest search leaves the window, and only the newest of the queries that waited is
 *   asked then: each one it took the place of gives [] and is never asked (useMemberSearch shows the newest only, so nothing
 *   is lost). What the search gives, or the error it gives, is passed on, and a refused search still counts.
 *
 * retryDelay(retry) → ms: how long a picture waits before it is tried again, the first retry being 0. It doubles from
 *   UPLOADS.firstDelayMs up to UPLOADS.maxDelayMs and stays there.
 *
 * createUploadQueue({ upload, onRetry }) → { add(file, n), pending(), stop() }
 *   upload(file, n) is the page's (the store's): one try → { n, name } for a picture held at place N of the reply, or
 *   { status, error } with the server's copy. The queue has UPLOADS.inFlight (2) files in flight at most, the server's own
 *   cap for a member, and takes the rest in the order they were added. A file keeps its place while it waits to be tried
 *   again.
 *   add(file, n) → a promise of the outcome, which never rejects:
 *     { ok: true, n, name } once the picture is held;
 *     { ok: false, status, error } when the server refused it, `error` being its copy when that is words, else null. A 429
 *       (too many in flight, or too often) or a 503 (too many in all) is tried again after retryDelay(), and onRetry({ n,
 *       status, error }) says why, up to UPLOADS.tries tries in all; anything else (a 413 too large, a 400 for a file that is no
 *       picture or took too long to arrive, a 408, a 415) is said at once, since trying again cannot change it;
 *     { ok: false, status: null, error: null } for an answer that is neither (one that throws, or a place outside 1 to 10);
 *     { ok: false, status: null, error: null, stopped: true } once stop() was called, for every file not held before it.
 *   `n` is the place the picture is asked to take, a whole number from 1 to 10 (a TypeError or RangeError otherwise).
 *   pending() → how many files are waiting or in flight. stop() tries nothing more: the composer has closed.
 */
export const SEARCHES = Object.freeze({ limit: 20, windowMs: 60_000 })
export const UPLOADS = Object.freeze({ inFlight: 2, tries: 5, firstDelayMs: 1_000, maxDelayMs: 8_000 })

// The refusals that say "not now": too many pictures in flight or too often (429), or too many in all (503).
const AGAIN = new Set([429, 503])
const MAX_PLACE = 10
const FAILED = Object.freeze({ ok: false, status: null, error: null })
const STOPPED = Object.freeze({ ...FAILED, stopped: true })

const isCount = (value) => Number.isInteger(value) && value > 0

export function paced(search, { limit = SEARCHES.limit, windowMs = SEARCHES.windowMs } = {}) {
  if (typeof search !== 'function') throw new TypeError('paced needs the search, a function')
  if (!isCount(limit)) throw new RangeError('limit is a whole number of searches, more than 0')
  if (!isCount(windowMs)) throw new RangeError('windowMs is a whole number of milliseconds, more than 0')
  // When each search in the window started, oldest first.
  const started = []
  // The query that waits for room, { q, resolve, reject }, or null.
  let waiting = null

  function room() {
    const now = Date.now()
    while (started.length > 0 && started[0] <= now - windowMs) started.shift()
    return started.length < limit
  }
  async function ask(q) {
    started.push(Date.now())
    return search(q)
  }
  function whenRoom() {
    const { q, resolve, reject } = waiting
    waiting = null
    ask(q).then(resolve, reject)
  }

  return (q) => {
    if (waiting === null && room()) return ask(q)
    return new Promise((resolve, reject) => {
      if (waiting === null) setTimeout(whenRoom, started[0] + windowMs - Date.now())
      else waiting.resolve([])
      waiting = { q, resolve, reject }
    })
  }
}

export function retryDelay(retry) {
  if (!Number.isInteger(retry)) throw new TypeError('a retry is counted in whole numbers')
  if (retry < 0) throw new RangeError('the first retry is 0')
  return Math.min(UPLOADS.firstDelayMs * 2 ** retry, UPLOADS.maxDelayMs)
}

const isWords = (value) => typeof value === 'string' && /\S/.test(value)

/** → the outcome of one try's answer. */
function outcomeOf(answer) {
  if (typeof answer !== 'object' || answer === null) return FAILED
  if (Number.isInteger(answer.status)) return { ok: false, status: answer.status, error: isWords(answer.error) ? answer.error : null }
  const { n, name } = answer
  if (Number.isInteger(n) && n >= 1 && n <= MAX_PLACE && typeof name === 'string') return { ok: true, n, name }
  return FAILED
}

export function createUploadQueue({ upload, onRetry = () => {} } = {}) {
  if (typeof upload !== 'function') throw new TypeError('the queue needs upload, a function')
  // Files waiting for a place, in the order they were added.
  const queue = []
  // Files that hold a place and wait to be tried again, by their timer.
  const resting = new Map()
  let running = 0
  let stopped = false

  function end(job, outcome) {
    running--
    job.resolve(outcome)
    pump()
  }

  async function attempt(job, tries) {
    let answer
    try {
      answer = await upload(job.file, job.n)
    } catch {
      answer = null
    }
    if (stopped) return end(job, STOPPED)
    const outcome = outcomeOf(answer)
    if (!outcome.ok && AGAIN.has(outcome.status) && tries < UPLOADS.tries) {
      onRetry({ n: job.n, status: outcome.status, error: outcome.error })
      const timer = setTimeout(() => {
        resting.delete(timer)
        attempt(job, tries + 1)
      }, retryDelay(tries - 1))
      resting.set(timer, job)
      return
    }
    end(job, outcome)
  }

  function pump() {
    while (!stopped && running < UPLOADS.inFlight && queue.length > 0) {
      running++
      attempt(queue.shift(), 1)
    }
  }

  function add(file, n) {
    if (!Number.isInteger(n)) throw new TypeError('a picture\'s place is a whole number')
    if (n < 1 || n > MAX_PLACE) throw new RangeError(`a picture's place is from 1 to ${MAX_PLACE}`)
    if (stopped) return Promise.resolve(STOPPED)
    return new Promise((resolve) => {
      queue.push({ file, n, resolve })
      pump()
    })
  }

  function stop() {
    stopped = true
    for (const job of queue.splice(0)) job.resolve(STOPPED)
    for (const [timer, job] of resting) {
      clearTimeout(timer)
      end(job, STOPPED)
    }
    resting.clear()
  }

  return { add, pending: () => queue.length + running, stop }
}
