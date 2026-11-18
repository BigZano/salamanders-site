// What the stores that ask the API for things (gallery.js, librarius.js) share: how a failure maps to a status, how an
// answer that arrives late is told from one that is current, and how an action keeps its failure for the page to show.

// A counter of calls moves on when what an answer would land in has been left (a sign-out, a newer call), and an answer
// that was asked for before then must not land. This marks one that must not.
export const STALE = Symbol('stale')

// → the status of a page whose request failed with `err`: a 401 is signin, a 403 is denied, anything else (a 5xx, a network
// failure, something that is no error) is unavailable.
export const statusOf = (err) => (err?.status === 401 ? 'signin' : err?.status === 403 ? 'denied' : 'unavailable')

// → what `ask` answers, or STALE if `now()` (a counter of load()s and reset()s, or of one list's generations) moved while it
// was asked for. A failure that arrives then is dropped too, not thrown.
export async function unlessStale(now, ask) {
  const then = now()
  try {
    const got = await ask()
    return then === now() ? got : STALE
  } catch (err) {
    if (then === now()) throw err
    return STALE
  }
}

// Runs one action: the message of a failure is kept in `error` for the page to show, and the failure goes on to the caller.
// `error` is always text: a failure with no message, or one whose message is not text (a number, an object), is reported
// with a plain one.
export async function attempt(store, run) {
  store.error = ''
  try {
    return await run()
  } catch (err) {
    const message = err?.message
    store.error = typeof message === 'string' && message !== '' ? message : 'Something went wrong.'
    throw err
  }
}
