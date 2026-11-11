import { CROWN_BASE } from './lavaNetwork'
import { DEFAULTS, RANDOMIZE_DEFAULTS, profileFor } from './fireTuning'

/**
 * Mount Deathfire's cone, as data: the peak, the two flanks, the crater rim and the broken crown of the summit.
 *
 * Pure. Everything the build reads comes in as a parameter (the viewport, the route's path, its profile, the tuning,
 * the seeded stream), so the page and the offline plate pipeline lay down identical geometry from the same inputs.
 * MountDeathfire.vue draws it; nothing here touches a canvas, the DOM or the router.
 */

/**
 * The viewport the tuning panel's numbers were dialled in against.
 *
 * bed.height was being used as raw pixels, so the cone kept one absolute height
 * while its base width stayed a fraction of the viewport. On anything shorter
 * than the tuning window the summit walked off the top — a 640px-tall viewport
 * put the peak at y = -50, which is why the crater, the caldera light and every
 * eruption were invisible and the mountain read as bare lava streaks. Heights
 * are now measured against this reference and scaled, so the cone keeps its
 * proportions at every size and `/` renders exactly as tuned at 1600x1000.
 */
export const REF = { w: 1600, h: 1000 }

/** Fraction of the viewport kept clear above the summit, for the plume. */
export const HEADROOM = 0.3

/**
 * The cone's height in this viewport: tuned height, scaled, then clamped.
 *
 * `scale` is the route profile's (how far away you stand) and `height` the tuned bed height, which defaults to the
 * baked hero's.
 *
 * Non-finite input collapses to the floor rather than propagating — an emptied
 * number field in the tuning panel hands over NaN, and NaN here reaches the
 * canvas as a thrown gradient rather than as a visibly wrong mountain.
 */
export function peakHeight(h, scale, height = DEFAULTS.bed.height) {
  const wanted = height * scale * (h / REF.h)
  return Math.max(40, Math.min(Number.isFinite(wanted) ? wanted : 0, h * (1 - HEADROOM)))
}

/**
 * Terrain randomness is *seeded*, so each route gets its own face of the
 * mountain and keeps it. Walk away from the Armoury and come back and you're
 * standing on the same side of Deathfire you left.
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

export const hashString = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Where this route's peak sits, and the seeded stream that goes on to shape the rest of the page.
 *
 * Position is two parts: the profile's bearing, which is a designed choice
 * about where this page stands, and a seeded wander of up to faceSpread on top
 * of it, which is the random part. The hero's bearing is 0 and its variance 1,
 * so it lands exactly where tune.offsetX plus its own seed put it.
 *
 * The stream is seeded from the path and its first draw is spent on the wander (drawn even when the spread is 0, so the
 * number of draws never changes), then handed back positioned there: buildMountain, the ridges and the network all
 * draw from it next.
 *
 * @returns {{ face: number, rng: () => number }} face is the peak's x as a fraction of the viewport, 0.1 to 0.9
 */
export function faceFor({ path, tune, prof, randomize = RANDOMIZE_DEFAULTS }) {
  const rng = mulberry32(hashString(path || '/') ^ 0x5a1a)
  const grand = (a, b) => a + rng() * (b - a)
  const spread = randomize.offsetX ? tune.faceSpread : 0
  const wander = grand(-spread, spread) * prof.variance
  const face = Math.max(0.1, Math.min(0.9, tune.offsetX + prof.bearing + wander))
  return { face, rng }
}

/**
 * A cone with a broken crater at the top. Slopes are walked in steps with
 * jitter so the flanks read as fractured basalt rather than a clean triangle,
 * and the jitter shrinks near the summit where the rock is younger.
 *
 * `rng` is the seeded stream the flanks draw from (the one faceFor returned); the terraces and the crown have their own
 * streams, seeded from `path`, so the seeded one that shapes the mountain is untouched by them. `face` is the peak's x
 * as a fraction of `w`, and `prof` the route's profile (`scale`, `variance`).
 */
export function buildMountain({ w, h, face, prof, tune, rng, path = '/', randomize = RANDOMIZE_DEFAULTS }) {
  /** Seeded generation randomness. */
  const grand = (a, b) => a + rng() * (b - a)
  /**
   * Pull a seeded value back toward the neutral (hero-symmetric) one.
   *
   * `grand` is still called either way, so the number of draws from the seeded
   * stream never changes — only how far the result is allowed to travel. That's
   * what lets variance vary per page without reshuffling any other page.
   */
  const stray = (neutral, seeded) => neutral + (seeded - neutral) * prof.variance

  // How tall this page stands the peak. Everything derived from height scales
  // with it, or the crater and the jitter stay hero-sized on a distant cone.
  const height = peakHeight(h, prof.scale, tune.height)
  const peakX = w * face
  const peakY = h - height
  // Base width is a fraction of the viewport *width* while height follows its
  // *height*, so on a narrow window the cone sharpened into a lit chimney. The
  // floor holds it to the slope it was tuned at (halfBase ~= 0.7 * height at
  // 1600x1000), and only bites below about 4:3 — every desktop width keeps the
  // fraction it had before, so the hero is untouched.
  const halfBase = Math.max((w * tune.width) / 2, height * 0.6)
  const craterHalf = Math.max(18, height * 0.13)

  // The cone's own profile. Reshaping it per route is what stops the site
  // feeling like one flat backdrop, but pushed too far it stops being Deathfire
  // seen from another side and becomes a different mountain — so the profile's
  // variance pulls each draw back toward the neutral cone. The hero runs at
  // full stray; the reading-heavy pages sit much closer to symmetric.
  const vary = randomize.asymmetry
  const leftSpread = vary ? stray(1, grand(0.78, 1.24)) : 1
  const rightSpread = vary ? stray(1, grand(0.78, 1.24)) : 1
  const leftCurve = vary ? stray(2.4, grand(2.15, 2.65)) : 2.4
  const rightCurve = vary ? stray(2.4, grand(2.15, 2.65)) : 2.4

  // The crater rim. This is the brightest line in the scene, so it has to read
  // level. It used to drop by two independent draws — 0..6px on the left and
  // 4..12px on the right — which both tilted the lit mouth (3.3px over a 179px
  // span on the hero seed) and, because the flanks were jittered separately at
  // the same x, stepped the rock outline 3-4px at each corner. One seeded dip,
  // mirrored, keeps the "blown out on one side" character without the tilt.
  const rimDip = vary ? stray(0, grand(-1.5, 1.5)) : 0
  const rimL = { x: peakX - craterHalf, y: peakY - rimDip }
  const rimR = { x: peakX + craterHalf, y: peakY + rimDip }

  const flank = (dir) => {
    const pts = []
    const steps = 26
    const spread = dir < 0 ? leftSpread : rightSpread
    const curve = dir < 0 ? leftCurve : rightCurve
    for (let i = 0; i <= steps; i++) {
      const f = i / steps // 0 at crater rim, 1 at base
      // Concave profile: volcanoes flare out as they descend.
      const eased = Math.pow(f, curve)
      const x = peakX + dir * (craterHalf + eased * (halfBase * spread - craterHalf))
      const y = peakY + f * height
      // Less jitter high up, more on the old broken skirts below. The taper runs
      // all the way to zero at the rim (it used to floor at 0.25) so the flank
      // meets the crater mouth exactly instead of stepping off it.
      const jitter = (vary ? grand(-1, 1) : 0) * prof.variance * height * 0.03 * f
      pts.push({ x, y: y + jitter })
    }
    // Terraces: a few cliff ledges step the flank outward as it falls, like the broken shelves of a collapsed caldera.
    // They use their own random stream, so the seeded one that shapes the mountain is untouched.
    const lr = mulberry32(hashString(path || '/') ^ (dir < 0 ? 0x1ed9e : 0x2fa7))
    for (let n = 0; n < 3; n++) {
      const k = 4 + Math.floor(lr() * (steps - 9))
      const out = (0.03 + lr() * 0.05) * halfBase * spread
      for (let i = k; i <= steps; i++) pts[i].x += dir * out
    }
    // Share the rim's own point, so silhouette and lit mouth cannot disagree.
    pts[0] = dir < 0 ? { ...rimL } : { ...rimR }
    return pts
  }

  const left = flank(-1)
  const right = flank(1)

  const crown = buildCrown(path, rimL, rimR, craterHalf, left, right)
  return {
    peakX,
    peakY,
    craterHalf,
    left,
    right,
    rimL,
    rimR,
    crown: crown.poly,
    mouthL: crown.mouthL,
    mouthR: crown.mouthR,
    valley: crown.valley, // the breach, left edge to right edge
    vent: crown.vent, // the valley floor's low point, where the lava leaves
    valleyDepth: crown.depth,
    litL: crown.litL,
    litR: crown.litR,
  }
}

/**
 * The broken crown of the summit, built as the top of the mountain and not something set on it. Each crest rises from a
 * rim corner along the line of its own flank, so the cliff face simply carries on upward, with a thick base, a jagged
 * outer edge and a stepped inner wall. The mouth is the notch left between them, at rim level, where the lava lip, the
 * channel heads and the caldera's light all sit. One crest is tall and one is a broken stub, and which is which, and
 * the jags, belong to the route. Own random stream: the seeded one that shapes the mountain is untouched.
 */
function buildCrown(path, rimL, rimR, ch, leftFlank, rightFlank) {
  const r = mulberry32(hashString(path || '/') ^ 0x5ead)
  const j = (a, b) => a + (b - a) * r()
  const tallLeft = r() < 0.5
  // `side` is -1 for the left crest and +1 for the right; `rise` is its height in crater widths
  const crest = (rim, flank, side, rise) => {
    const inward = -side
    // the flank's own direction near the rim, pointing up and in
    let ux = flank[0].x - flank[2].x
    let uy = flank[0].y - flank[2].y
    const len = Math.hypot(ux, uy) || 1
    ux /= len
    uy /= len
    const along = (rise * ch) / Math.max(0.2, -uy)
    const on = (tt, wobble) => ({ x: rim.x + ux * along * tt - uy * wobble * ch, y: rim.y + uy * along * tt + ux * wobble * ch })
    const outer = [0.3, 0.62, 0.86].map((tt) => on(tt, j(-0.05, 0.05)))
    const tip = on(1, 0)
    tip.x += inward * 0.05 * ch
    outer.push(tip)
    const edge = { x: rim.x + inward * CROWN_BASE * ch, y: rim.y }
    const inner = [0.2, 0.42, 0.62, 0.82].map((tt, k) => ({
      x: tip.x + (edge.x - tip.x) * tt + (k % 2 ? 1 : -1) * inward * j(0.02, 0.07) * ch,
      y: tip.y + (edge.y - tip.y) * tt - (k % 2 ? 0 : j(0.02, 0.08)) * rise * ch * 0.3,
    }))
    inner.push(edge)
    return { outer, tip, inner, edge }
  }
  const left = crest(rimL, leftFlank, -1, tallLeft ? j(1.5, 2.1) : j(0.55, 0.9))
  const right = crest(rimR, rightFlank, 1, tallLeft ? j(0.55, 0.9) : j(1.5, 2.1))
  // The breach: the near rim is cut away between the crests into a valley, its floor well below rim level, as the
  // rim of a cone breaks where the lava finds its way out (Mauna Loa's fissure 3 channel, Etna's breached cones).
  // The lava pools in it and leaves over the floor's low point, the vent.
  const mw = right.edge.x - left.edge.x
  const depth = j(0.3, 0.42) * ch
  const low = 0.42 + j(-0.08, 0.08)
  const vx = (f) => left.edge.x + mw * f
  const vy = (f) => left.edge.y + (right.edge.y - left.edge.y) * f
  const valley = [
    { x: vx(0.14 + j(-0.03, 0.03)), y: vy(0.14) + depth * 0.5 },
    { x: vx(low - 0.14), y: vy(low - 0.14) + depth * 0.92 },
    { x: vx(low), y: vy(low) + depth },
    { x: vx(low + 0.16), y: vy(low + 0.16) + depth * 0.9 },
    { x: vx(0.86 + j(-0.03, 0.03)), y: vy(0.86) + depth * 0.45 },
  ]
  return {
    poly: [...left.outer, ...left.inner, ...valley, ...[...right.inner].reverse(), ...[...right.outer].reverse()],
    mouthL: left.edge,
    mouthR: right.edge,
    valley: [left.edge, ...valley, right.edge],
    vent: valley[2],
    depth,
    litL: [left.tip, ...left.inner],
    litR: [right.tip, ...right.inner],
  }
}

/**
 * A route's mountain in one call: its face and seeded stream (faceFor), then the cone built from them.
 *
 * `rng` comes back positioned where the page's stream is after the mountain is built, so the ridges, the network and
 * the riders can go on drawing from it. `prof` is the route's profile from the live store; pass one to override it.
 *
 * @returns {{ mountain: object, face: number, rng: () => number }}
 */
export function mountainForRoute({ path, w, h, tune, randomize = RANDOMIZE_DEFAULTS, prof = profileFor(path) }) {
  const { face, rng } = faceFor({ path, tune, prof, randomize })
  const mountain = buildMountain({ w, h, face, prof, tune, rng, path, randomize })
  return { mountain, face, rng }
}
