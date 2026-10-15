/**
 * The roster's refresh loop. One chain of setTimeouts (never setInterval), so
 * a slow request can't overlap the next. It skips ticks while the tab is
 * hidden, and refreshes at once when the tab comes back if the last run is a
 * minute old or more, so you never return to a stale page and wait for the
 * next tick. `load` is expected to report its own errors (the store does); a
 * throw here must not end the chain.
 */
export function useRosterPolling({ load, intervalMs = 60_000, now = Date.now }) {
  let running = false
  let inFlight = false
  let generation = 0 // a load that settles after stop() or a restart must not schedule
  let lastRun = -Infinity
  let timer = null

  const clear = () => {
    clearTimeout(timer)
    timer = null
  }

  async function run(gen) {
    inFlight = true
    lastRun = now()
    try {
      await load()
    } catch {
      // keep the chain alive
    } finally {
      inFlight = false
    }
    if (running && gen === generation) schedule(gen)
  }

  function schedule(gen) {
    clear()
    timer = setTimeout(() => {
      timer = null
      if (document.hidden) schedule(gen)
      else run(gen)
    }, intervalMs)
  }

  function onVisibility() {
    if (!running || document.hidden || inFlight) return
    if (now() - lastRun < intervalMs) return
    clear()
    run(generation)
  }

  function start() {
    if (running) return
    running = true
    document.addEventListener('visibilitychange', onVisibility)
    run(++generation)
  }

  function stop() {
    running = false
    clear()
    document.removeEventListener('visibilitychange', onVisibility)
  }

  return { start, stop }
}
