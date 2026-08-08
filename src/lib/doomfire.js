/**
 * The Doom (PSX) fire effect.
 *
 * A grid of palette indices. The bottom row is the heat source; every frame
 * each cell takes the value of the cell below it, minus a random decay, offset
 * a random column sideways. That single rule is what produces the flicker and
 * the sideways lick of flame — there is no particle system here.
 *
 * Rendered at a low resolution and blown up with smoothing off, so the pixels
 * stay chunky and deliberate rather than looking like a blurry gradient.
 */

// Classic 37-step ramp: black through blood red and orange to white-hot.
export const DOOM_PALETTE = [
  [7, 7, 7], [31, 7, 7], [47, 15, 7], [71, 15, 7], [87, 23, 7],
  [103, 31, 7], [119, 31, 7], [143, 39, 7], [159, 47, 7], [175, 63, 7],
  [191, 71, 7], [199, 71, 7], [223, 79, 7], [223, 87, 7], [223, 87, 7],
  [215, 95, 7], [215, 95, 7], [215, 103, 15], [207, 111, 15], [207, 119, 15],
  [207, 127, 15], [207, 135, 23], [199, 135, 23], [199, 143, 23], [199, 151, 31],
  [191, 159, 31], [191, 159, 31], [191, 167, 39], [191, 167, 39], [191, 175, 47],
  [183, 175, 47], [183, 183, 47], [183, 183, 55], [207, 207, 111], [223, 223, 159],
  [239, 239, 199], [255, 255, 255],
]

export const MAX_HEAT = DOOM_PALETTE.length - 1

export class DoomFire {
  /**
   * @param {number} width  grid columns
   * @param {number} height grid rows
   * @param {object} [opts]
   * @param {number} [opts.maxHeat]  cap the source heat — lower reads as coals
   *                                 rather than an open bonfire
   * @param {number} [opts.decay]    0..1 chance of losing a heat step per cell
   */
  /**
   * @param {number} [opts.variation] 0..2 — how far a cell may wander sideways
   *                                  and how erratically it cools. Low is a
   *                                  steady column, high is a wild flicker.
   * @param {number} [opts.intensity] brightness/heat multiplier
   */
  constructor(width, height, opts = {}) {
    this.maxHeat = opts.maxHeat ?? MAX_HEAT
    this.decay = opts.decay ?? 1
    this.palette = opts.palette ?? DOOM_PALETTE
    this.variation = opts.variation ?? 1
    this.intensity = opts.intensity ?? 1
    this.resize(width, height)
  }

  /** Source heat, after intensity, clamped to the palette. */
  get sourceHeat() {
    return Math.max(1, Math.min(this.palette.length - 1, Math.round(this.maxHeat * this.intensity)))
  }

  resize(width, height) {
    this.w = Math.max(1, width | 0)
    this.h = Math.max(2, height | 0)
    this.cells = new Uint8Array(this.w * this.h)
    this.rgba = new Uint8ClampedArray(this.w * this.h * 4)
    this.ignite()
  }

  /** Light the bottom row. */
  ignite() {
    const base = (this.h - 1) * this.w
    this.cells.fill(0)
    const heat = this.sourceHeat
    for (let x = 0; x < this.w; x++) this.cells[base + x] = heat
  }

  /**
   * Vary the source row so the bed reads as coals rather than one flat strip.
   *
   * Two parts: a slow travelling wave that makes the whole bank breathe and
   * roll, and short-lived hot spikes on individual columns. The spikes are what
   * produce tongues — a hot column pushes a lick of flame up through the sim on
   * its own, so the tongues are real fire rather than drawn shapes.
   *
   * @param {number} t seconds
   * @param {number} [wave]  depth of the rolling swell, 0..1
   * @param {number} [spike] how often tongues kick up, 0..1
   */
  stokeCoals(t, wave = 1, spike = 0.5) {
    if (!this.spikes || this.spikes.length !== this.w) this.spikes = new Float32Array(this.w)
    const base = (this.h - 1) * this.w
    const src = this.sourceHeat

    for (let x = 0; x < this.w; x++) {
      // Cool any spike from previous frames, then occasionally light a new one.
      this.spikes[x] *= 0.88
      if (Math.random() < 0.028 * spike) this.spikes[x] = 1

      // Three out-of-phase waves so the swell never looks like a sine.
      const a = Math.sin(x * 0.13 + t * 0.7)
      const b = Math.sin(x * 0.31 - t * 1.1)
      const c = Math.sin(x * 0.07 + t * 0.29)
      const n = (a * 0.45 + b * 0.3 + c * 0.25 + 1) / 2 // 0..1

      const swell = 1 - wave * 0.55 + n * wave * 0.55
      const heat = src * Math.min(1, swell + this.spikes[x] * 0.45)
      this.cells[base + x] = heat | 0
    }
  }

  step() {
    const { w, h, cells, decay, variation } = this
    // Wider spread = more sideways wander and more erratic cooling.
    const spread = Math.max(1, 3 * variation)
    for (let y = 1; y < h; y++) {
      const row = y * w
      const above = row - w
      for (let x = 0; x < w; x++) {
        const src = cells[row + x]
        if (src === 0) {
          cells[above + x] = 0
          continue
        }
        const rand = (Math.random() * spread) | 0
        const dx = x - rand + 1
        if (dx < 0 || dx >= w) {
          cells[above + x] = 0
          continue
        }
        const lose = rand & 1 && Math.random() < decay ? 1 : 0
        const next = src - lose
        cells[above + dx] = next > 0 ? next : 0
      }
    }
  }

  /** Paint the grid into an ImageData buffer. */
  toImageData(imageData) {
    const { cells, rgba, palette, intensity } = this
    const top = palette.length - 1
    for (let i = 0; i < cells.length; i++) {
      const heat = cells[i]
      const [r, g, b] = palette[heat > top ? top : heat]
      const o = i * 4
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      // Black is the absence of fire, so fade it out rather than painting it.
      rgba[o + 3] = heat === 0 ? 0 : Math.min(255, heat * 26 * intensity)
    }
    imageData.data.set(rgba)
    return imageData
  }
}

/** Shared guard: does this browser/user want an animated canvas at all? */
export function motionAllowed() {
  return (
    typeof window !== 'undefined' &&
    !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
}
