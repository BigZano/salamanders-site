/**
 * Hand-wrought scrollwork for the archive plaque. The spines, curls, leaves
 * and flame are drawn freehand as point lists (not formulas), then each line
 * is cut the way a graver cuts: it enters as a hairline, swells under
 * pressure, and tapers out — spirals thinning as they wind in. Every corner
 * gets its own small tremor of the hand, so no two match exactly.
 *
 * Units: the brass rim is 40 wide. Each piece returns { cuts, veins, beads }:
 * `cuts` is one filled path of bright metal, `veins` the dark lines cut into
 * leaves and flame, `beads` punched dots.
 */
export const f = (n) => Math.round(n * 100) / 100

/** Seeded tremor, so a given corner always wobbles the same way. */
export function hand(seed) {
  let s = seed >>> 0
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  return (amt) => r() * amt
}

/** Sample a Catmull-Rom curve through the points. */
export function sample(pts, per = 8) {
  const out = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)))
    }
  }
  out.push(pts.at(-1))
  return out
}

export const PROFILES = {
  // A scroll: quick swell, then thinning all the way into the curl.
  curl: (t) => Math.min(1, t / 0.1) ** 0.6 * (1 - 0.82 * t) + 0.08,
  // A sweep: hairline in, full in the middle, hairline out.
  sweep: (t) => 0.12 + 0.88 * Math.sin(Math.PI * t) ** 0.8,
  // A ring: even, with a little pressure variation from the tremor.
  even: () => 1,
  // A horn, spike or fang: full at the root, drawn out to a point.
  point: (t) => (1 - t) ** 0.85 + 0.02,
  // A spine snapped off: tapering, then ending blunt.
  broken: (t) => 1 - 0.5 * t,
  // A tooth: a cone, tapering steadily from a broad root to a firm (not needle) point.
  tooth: (t) => (1 - t) ** 0.7 * 0.92 + 0.08,
  // A fang: broad through the body, drawn to a point.
  fang: (t) => (1 - t ** 1.25) ** 0.85 + 0.04,
}

/** A graver cut along freehand points: a filled ribbon whose width follows the profile. */
export function cut(pts, width, profile, jit) {
  const c = sample(pts)
  const left = [], right = []
  for (let i = 0; i < c.length; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)]
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1
    const w = (width * PROFILES[profile](i / (c.length - 1)) * (1 + jit(0.07))) / 2
    left.push([c[i][0] - (dy / len) * w, c[i][1] + (dx / len) * w])
    right.push([c[i][0] + (dy / len) * w, c[i][1] - (dx / len) * w])
  }
  const ring = [...left, ...right.reverse()]
  return `M${ring.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`
}

/** Freehand acanthus: three deep lobes on the belly, a tip that curls back, a vein cut down it. */
const ACANTHUS = [[0, 0], [0.1, 0.17], [0.21, 0.35], [0.31, 0.3], [0.39, 0.47], [0.52, 0.52], [0.59, 0.39], [0.69, 0.45], [0.81, 0.36], [0.91, 0.22], [1, 0.05], [0.98, -0.07], [0.91, -0.04], [0.72, 0.06], [0.46, 0.05], [0.2, 0.01], [0, 0]]
const VEIN = [[0.05, 0.04], [0.32, 0.16], [0.6, 0.2], [0.86, 0.1]]
function place(pts, [x, y], a, L, flip, jit) {
  const s = flip ? -1 : 1
  return pts.map(([u, v]) => {
    const px = u * L + jit(0.25), py = v * L * s + jit(0.25)
    return [x + px * Math.cos(a) - py * Math.sin(a), y + px * Math.sin(a) + py * Math.cos(a)]
  })
}
export function acanthus(at, a, L, flip, jit) {
  const outline = sample(place(ACANTHUS, at, a, L, flip, jit), 5)
  return {
    cuts: `M${outline.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`,
    veins: cut(place(VEIN, at, a, L, flip, jit), L * 0.07, 'sweep', jit),
  }
}

export const shake = (pts, jit, amt = 0.35) => pts.map(([x, y]) => [x + jit(amt), y + jit(amt)])
const swap = (pts) => pts.map(([x, y]) => [y, x])

function piece() {
  return { cuts: '', veins: '', beads: [] }
}
export function add(p, part) {
  p.cuts += part.cuts ?? ''
  p.veins += part.veins ?? ''
  return p
}

// ---- corner ------------------------------------------------------------

// One arm, drawn along the top band; the other arm is the same hand across the diagonal.
const ARM = {
  main: [[26, 27], [33, 29], [41, 31], [50, 32], [59, 32.5], [67, 31.5], [74, 28.5], [78.5, 23.5], [79.5, 17.5], [77, 12], [72, 8.8], [66, 8.2], [60.5, 10.5], [57.5, 15], [58, 20], [61.5, 23.2], [66, 23.6], [69.5, 20.8], [69.8, 16.8], [67, 14.4], [63.8, 15.2]],
  counter: [[70, 8.4], [78, 6.8], [87, 6.6], [95, 7.8], [102.5, 10.2], [108.5, 14.5], [111, 20], [109.8, 25.4], [105.5, 28.4], [100.3, 28], [97.2, 24.6], [97.6, 20.6], [100.8, 18.6], [104, 19.6], [104.6, 22.4]],
  tendril: [[110.5, 26], [117, 30], [125, 31.8], [133, 30.6], [139.5, 27], [143, 22.4], [142.2, 18], [138.6, 16.4], [135.6, 18.2], [136, 21.2]],
  sprig: [[84, 30.5], [89, 33.4], [94.5, 34], [98, 32.2]],
  leaves: [[[36, 28.6], -0.6, 12, true], [[47, 31], 0.5, 9, false], [[79, 20], -1.45, 9, false], [[73.6, 28.6], 0.55, 8.5, true], [[84, 6.8], -0.28, 8, true], [[116, 17.5], -1.0, 8, false], [[127, 31.6], 0.2, 6.5, false], [[150, 30], -0.5, 5.5, true]],
  beads: [[89, 25.4, 0.9], [123, 9.6, 0.9], [150, 11.5, 0.7], [98.6, 32, 0.8], [136.2, 21.4, 1.1]],
}

function arm(p, jit, across) {
  const t = across ? swap : (pts) => pts
  add(p, { cuts: cut(t(shake(ARM.main, jit)), 2.3, 'curl', jit) })
  add(p, { cuts: cut(t(shake(ARM.counter, jit)), 1.6, 'curl', jit) })
  add(p, { cuts: cut(t(shake(ARM.tendril, jit)), 1, 'curl', jit) })
  add(p, { cuts: cut(t(shake(ARM.sprig, jit)), 0.8, 'sweep', jit) })
  for (const [at, a, L, flip] of ARM.leaves) {
    const [x, y] = across ? [at[1], at[0]] : at
    add(p, acanthus([x, y], across ? Math.PI / 2 - a : a, L, across ? !flip : flip, jit))
  }
  for (const [x, y, r] of ARM.beads) p.beads.push(across ? { cx: f(y + jit(0.3)), cy: f(x + jit(0.3)), r } : { cx: f(x + jit(0.3)), cy: f(y + jit(0.3)), r })
}

/** A corner in 160 × 160: rosette in the angle, arms along both bands. `seed` picks the hand's tremor. */
export function corner(seed = 1) {
  const jit = hand(seed)
  const p = piece()
  // The corner's origin is a small salamander flame pointing out into the angle —
  // not a ring-and-dot rosette, which reads as an eye.
  const toCorner = (pts) => pts.map(([x, y]) => {
    const u = (x - 100) * 0.46, v = (y - 19) * 0.46, a = -Math.PI / 4
    return [19 + u * Math.cos(a) - v * Math.sin(a), 19 + u * Math.sin(a) + v * Math.cos(a)]
  })
  const flame = sample(toCorner(shake(FLAME, jit, 0.2)), 6)
  add(p, { cuts: `M${flame.map((q) => `${f(q[0])} ${f(q[1])}`).join('L')}Z` })
  const heart = sample(toCorner(shake(FLAME_HEART, jit, 0.15)), 6)
  add(p, { veins: `M${heart.map((q) => `${f(q[0])} ${f(q[1])}`).join('L')}Z` })
  arm(p, jit, false)
  arm(p, jit, true)
  return p
}

// ---- crest --------------------------------------------------------------

const CREST_SIDE = {
  // Low out of the flame's root and well away before it curls, so the pair of
  // curls either side of the flame can never read as a face.
  main: [[106, 32], [114, 34], [123, 34.2], [132, 32.6], [140, 29], [146, 24], [148, 18.6], [146.4, 13.6], [142, 11], [137, 11.6], [134, 15], [134.6, 19.4], [138, 21.4], [141.4, 20], [141.8, 16.8]],
  counter: [[147, 11.6], [155, 9.2], [163, 9.4], [170, 12.6], [174, 18], [173, 23.6], [169, 26.4], [164.6, 25.6], [162.8, 22], [164.6, 19.4], [167.6, 20.2]],
  tendril: [[174, 24.6], [180, 29.6], [187, 31], [193, 28], [195, 22.4], [192.6, 18.8], [189.8, 19.8], [190.4, 22.6]],
  leaves: [[[110, 32.4], -0.85, 12.5, true], [[125, 34], -1.05, 10, false], [[147.6, 20.5], -1.45, 7, false], [[157, 9], -0.15, 6.5, true], [[175, 19], -1.0, 6.5, false], [[186, 31], 0.25, 5.5, false]],
  beads: [[120.5, 9, 0.9], [152, 31, 0.9], [182, 12, 0.7], [190.4, 22.4, 1.1]],
}
// The salamander flame, drawn freehand: outer tongues and the heart within.
const FLAME = [[100, 2.5], [103.6, 7], [107.8, 11.4], [110.8, 16.6], [111.6, 22.4], [110, 28], [105.8, 32.6], [100, 34.2], [94.2, 32.6], [90, 28], [88.4, 22.2], [89.6, 17], [92.4, 13.2], [94.2, 11.8], [93.8, 15.4], [95.2, 18.6], [97.6, 19.8], [98, 15], [98.4, 9.6], [100, 2.5]]
const FLAME_HEART = [[100.4, 14.4], [103.6, 18.8], [105.4, 23.4], [104.6, 27.6], [101.8, 30.6], [98.2, 30.8], [95.6, 28.4], [95.2, 25.4], [96.8, 23], [98.6, 24.8], [99.8, 21.4], [100.4, 14.4]]

function crestSide(p, jit, mirror) {
  const m = mirror ? (pts) => pts.map(([x, y]) => [200 - x, y]) : (pts) => pts
  add(p, { cuts: cut(m(shake(CREST_SIDE.main, jit)), 2.3, 'curl', jit) })
  add(p, { cuts: cut(m(shake(CREST_SIDE.counter, jit)), 1.6, 'curl', jit) })
  add(p, { cuts: cut(m(shake(CREST_SIDE.tendril, jit)), 1, 'curl', jit) })
  for (const [at, a, L, flip] of CREST_SIDE.leaves) {
    add(p, acanthus(mirror ? [200 - at[0], at[1]] : at, mirror ? Math.PI - a : a, L, mirror ? !flip : flip, jit))
  }
  for (const [x, y, r] of CREST_SIDE.beads) p.beads.push({ cx: f((mirror ? 200 - x : x) + jit(0.3)), cy: f(y + jit(0.3)), r })
}

/** The centre crest in 200 × 40: the flame, rooted between two hands' worth of scrolls. */
export function crest(seed = 7) {
  const jit = hand(seed)
  const p = piece()
  const outline = sample(shake(FLAME, jit, 0.2), 6)
  add(p, { cuts: `M${outline.map((q) => `${f(q[0])} ${f(q[1])}`).join('L')}Z` })
  const heart = sample(shake(FLAME_HEART, jit, 0.15), 6)
  add(p, { veins: `M${heart.map((q) => `${f(q[0])} ${f(q[1])}`).join('L')}Z` })
  crestSide(p, jit, false)
  crestSide(p, jit, true)
  return p
}

// ---- running border --------------------------------------------------------

/**
 * The straight edges: a vine worked by hand along the band, one curl in each
 * hollow, alternating up and down. Four periods drawn with their own
 * variation so the repeat isn't obvious; tiles every 320 units.
 */
export function runner(seed = 3) {
  const jit = hand(seed)
  const p = piece()
  const y = (x) => 20 - 5.5 * Math.sin((Math.PI * 2 * x) / 80)
  const vine = Array.from({ length: 33 }, (_, i) => [i * 10, y(i * 10) + (i % 32 === 0 ? 0 : jit(0.5))])
  add(p, { cuts: cut(vine, 1.3, 'even', jit) })
  for (let k = 0; k < 8; k++) {
    const up = k % 2 === 1
    const x0 = k * 40 + 5 // where the curl leaves the vine
    const s = up ? -1 : 1
    const r = 6.4 + jit(0.7)
    const cx = x0 + 15 + jit(1), cy = 20 + s * (8 + jit(0.6))
    // Out of the vine, over, and into a curl — drawn as points round an uneven, tightening loop.
    // Enters at the loop's left side heading away from the vine, winds 1⅓ turns.
    const loop = Array.from({ length: 9 }, (_, i) => {
      const a = Math.PI - s * (i / 8) * Math.PI * 2 * 1.35
      const rr = r * (1 - (i / 8) * 0.78)
      return [cx + rr * Math.cos(a) * (1 + jit(0.05)), cy + rr * Math.sin(a) * (1 + jit(0.05))]
    })
    add(p, { cuts: cut([[x0, y(x0)], [x0 + 3.6, y(x0) + s * 3], ...loop], 1, 'curl', jit) })
    add(p, acanthus([x0 + 2, y(x0 + 2)], s > 0 ? 0.5 : -0.5, 5.5 + jit(0.6), s < 0, jit))
    p.beads.push({ cx: f(cx + 13 + jit(1)), cy: f(20 - s * 12 + jit(0.8)), r: 0.75 })
  }
  return p
}
