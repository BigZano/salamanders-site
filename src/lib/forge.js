import { reactive } from 'vue'

/**
 * The forge: dev-only controls over the volcano for the playground at /dev/forge.
 *
 * `forge` is null in a production build, so nothing here reaches visitors. In dev it is one reactive object the
 * volcano reads every frame (frozen, speed, step, moon) and writes its stats into, and the playground edits. The
 * volcano also hangs its actions on it (erupt, trial, seek, snapshot) once mounted, and puts it on `window.__forge`
 * so a same-origin iframe's volcano can be driven by the playground's grid.
 */
export const FORGE = Boolean(import.meta.env.DEV)

export const forge = FORGE
  ? reactive({
      frozen: false,
      speed: 1,
      step: 0, // frames still to advance while frozen
      moon: null, // 0..1 pins the moon's phase; null follows the clock (or ?moon=)
      stats: { draw: 0, max: 0, fps: 0 }, // draw ms (mean, worst) and frames per second over the last window
      actions: {}, // set by the volcano when it mounts
    })
  : null

/**
 * How far the volcano's clock advances this frame, in ms. Frozen: nothing, except one `tick` per queued step.
 * Otherwise the elapsed time, scaled by the speed.
 */
export function forgeAdvance(f, elapsed, tick) {
  if (!f) return elapsed
  if (f.frozen) {
    if (f.step > 0) {
      f.step--
      return tick
    }
    return 0
  }
  return elapsed * f.speed
}

const WINDOW = 60
const samples = { draw: new Float32Array(WINDOW), frame: new Float32Array(WINDOW), n: 0 }

/** Record one frame's draw time and frame interval; the stats are written out once per window. */
export function forgeSample(f, drawMs, frameMs) {
  if (!f) return
  const i = samples.n % WINDOW
  samples.draw[i] = drawMs
  samples.frame[i] = frameMs
  samples.n++
  if (samples.n % (WINDOW / 2) !== 0) return
  const count = Math.min(samples.n, WINDOW)
  let sum = 0
  let max = 0
  let frames = 0
  for (let k = 0; k < count; k++) {
    sum += samples.draw[k]
    if (samples.draw[k] > max) max = samples.draw[k]
    frames += samples.frame[k]
  }
  f.stats.draw = sum / count
  f.stats.max = max
  f.stats.fps = frames > 0 ? (1000 * count) / frames : 0
}

/** A dev-only number from the page's query string, or null. */
export function devNumber(name, search = typeof window === 'undefined' ? '' : window.location.search) {
  if (!FORGE) return null
  const v = new URLSearchParams(search).get(name)
  if (v === null) return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}
