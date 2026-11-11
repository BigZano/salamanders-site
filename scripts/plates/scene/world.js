// The plate scene's ground, built on the CPU once from the page's own mountain (src/lib/mountain.js, in canvas pixels).
// Pure JS (no three.js) so it can be checked under node.
//
// The terrain is a heightfield laid out in SCREEN space: a grid over the mountain's outline in canvas pixels, each vertex
// given a depth (toward the camera) and then pushed along the camera ray through its pixel. Every vertex therefore
// projects to exactly its own pixel whatever its depth, so the relief lights the rock but can never move the outline: the
// silhouette is the polygon's (the shader cuts it with a mask of the same polygon, filled the way the page fills it).
//
// World units are canvas pixels on the z = 0 plane: x right, y up (y = canvas.h - pixel y), z toward the camera.

// ------------------------------------------------------------------ noise (seeded; the mock's)
function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
export function vnoise(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}
export function fbm(x, y, oct = 4, s = 0) {
  let a = 0.5, t = 0, f = 1
  for (let i = 0; i < oct; i++) {
    t += a * vnoise(x * f, y * f, s + i * 17)
    f *= 2.03
    a *= 0.5
  }
  return t / (1 - Math.pow(0.5, oct))
}
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
export function smooth(e0, e1, x) {
  const t = sat((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
const lerp = (a, b, t) => a + (b - a) * t
const ridged = (n) => 1 - Math.abs(2 * n - 1)

// ------------------------------------------------------------------ the outline
/**
 * The mountain's silhouette as one closed polygon in canvas pixels, in the order MountDeathfire.vue's buildSilhouette
 * fills it: up the left flank from its foot, the rim, the crown, the rim, down the right flank. Below each foot the
 * page drops straight off the bottom of its window; a plate has bleed there, so each flank carries on along its last
 * segment to just below the canvas instead (that part is only ever seen in a cover-fit crop).
 */
export function outline(m, canvas) {
  const bottom = canvas.h + 4
  const foot = (pts) => {
    const a = pts[pts.length - 2], b = pts[pts.length - 1]
    const dy = b.y - a.y
    if (dy <= 1e-6 || b.y >= bottom) return { x: b.x, y: Math.max(b.y, bottom) }
    const t = (bottom - b.y) / dy
    const x = b.x + (b.x - a.x) * t
    return { x: Math.max(-canvas.w, Math.min(2 * canvas.w, x)), y: bottom }
  }
  const poly = [foot(m.left)]
  for (let i = m.left.length - 1; i >= 0; i--) poly.push({ x: m.left[i].x, y: m.left[i].y })
  poly.push({ x: m.rimL.x, y: m.rimL.y })
  for (const p of m.crown) poly.push({ x: p.x, y: p.y })
  poly.push({ x: m.rimR.x, y: m.rimR.y })
  for (const p of m.right) poly.push({ x: p.x, y: p.y })
  poly.push(foot(m.right))
  return poly
}

/** @returns {number[]} where the horizontal line at y crosses the closed polygon, sorted (pairs bound the inside, even-odd) */
export function rowCrossings(poly, y) {
  const xs = []
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
  }
  return xs.sort((p, q) => p - q)
}

/** @returns {{ d: number, s: number }} the distance from (x, y) to a polyline and the arc length along it to the nearest point */
export function distToPolyline(pts, x, y) {
  let best = Infinity, bestS = 0, acc = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    const ex = b.x - a.x, ey = b.y - a.y
    const L2 = ex * ex + ey * ey
    const L = Math.sqrt(L2)
    let t = L2 > 0 ? ((x - a.x) * ex + (y - a.y) * ey) / L2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const d = Math.hypot(x - a.x - ex * t, y - a.y - ey * t)
    if (d < best) {
      best = d
      bestS = acc + L * t
    }
    acc += L
  }
  return { d: best, s: bestS }
}

const polylineLength = (pts) => pts.reduce((acc, p, i) => (i ? acc + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0)

/**
 * The terraces buildMountain cut into a flank: where the flank steps outward by more than its own curve does from one
 * row to the next. `dir` is -1 for the left flank, 1 for the right.
 * @returns {{ i: number, y: number, out: number }[]} the row the step lands on, its y and how far it steps out (px)
 */
export function terraces(flank, dir, minStep = 6) {
  const out = []
  for (let i = 2; i < flank.length; i++) {
    const step = dir * (flank[i].x - flank[i - 1].x) - Math.max(0, dir * (flank[i - 1].x - flank[i - 2].x))
    if (step > minStep) out.push({ i, y: (flank[i].y + flank[i - 1].y) / 2, out: step })
  }
  return out
}

// ------------------------------------------------------------------ the world
/**
 * Everything the scene needs, from the mountain in canvas pixels.
 *
 * `channels` are the lava's streams (polylines in canvas pixels); without them the vent-to-pool line stands in. `seed`
 * is the only source of noise. `cell` is the grid's spacing in pixels.
 */
export function buildWorld({ mountain: m, canvas, channels = [], seed = 0, cell = 4, depth = 3 }) {
  const W = canvas.w, H = canvas.h
  const D = depth * H // camera distance: 1 world unit = 1 px on z = 0
  const s0 = (seed >>> 0) % 100003
  const poly = outline(m, canvas)

  const tipY = Math.min(...m.crown.map((p) => p.y), m.peakY)
  const tip = m.crown.reduce((a, p) => (p.y < a.y ? p : a), m.crown[0] ?? { x: m.peakX, y: m.peakY })
  const baseY = Math.max(m.left[m.left.length - 1].y, m.right[m.right.length - 1].y)
  const Hm = Math.max(1, baseY - tipY)
  const S = Math.max(1, (m.right[m.right.length - 1].x - m.left[m.left.length - 1].x) / 2)
  const ch = m.craterHalf
  const rimY = Math.min(m.rimL.y, m.rimR.y)
  const unit = S / 30 // the mock's world unit, so its noise and texture scales carry over

  // the grid: the outline's box, clipped to the canvas, on whole cells
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity
  for (const p of poly) {
    x0 = Math.min(x0, p.x)
    x1 = Math.max(x1, p.x)
    y0 = Math.min(y0, p.y)
  }
  x0 = Math.max(0, Math.floor(x0 / cell) * cell - 2 * cell)
  x1 = Math.min(W, Math.ceil(x1 / cell) * cell + 2 * cell)
  y0 = Math.max(0, Math.floor(y0 / cell) * cell - 2 * cell)
  const y1 = H
  const nx = Math.round((x1 - x0) / cell) + 1
  const ny = Math.round((y1 - y0) / cell) + 1
  const N = nx * ny
  const gx = (i) => Math.min(x1, x0 + i * cell)
  const gy = (j) => Math.min(y1, y0 + j * cell)

  // ---------------------------------------------------------------- the body: each row's span a circle seen edge on
  // (a cone's cross-section), so the limbs turn away and the middle comes forward; the crown's crests are narrow spans,
  // so they come out as blades. Outside the outline the surface falls behind the plane (masked off, but it keeps the
  // blur below from pulling the limbs forward).
  const z = new Float32Array(N)
  const inside = new Uint8Array(N)
  for (let j = 0; j < ny; j++) {
    const y = gy(j)
    const xs = rowCrossings(poly, y)
    for (let i = 0; i < nx; i++) {
      const x = gx(i)
      let k = 0
      while (k < xs.length && xs[k] <= x) k++
      const k0 = j * nx + i
      if (k % 2 === 1) {
        const a = xs[k - 1], b = xs[k]
        const R = (b - a) / 2
        const dr = R - Math.abs(x - (a + b) / 2)
        z[k0] = 0.8 * Math.sqrt(Math.max(0, dr * (2 * R - dr)))
        inside[k0] = 1
      } else {
        const near = Math.min(k > 0 ? x - xs[k - 1] : Infinity, k < xs.length ? xs[k] - x : Infinity)
        z[k0] = -Math.min(near, 3 * cell) * 0.5
      }
    }
  }
  // soften the rows' seams (where the crown's two spans meet the cone's one): two box passes each way, about 3 cells
  const blur = (src, r) => {
    const tmp = new Float32Array(N)
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          let s = 0
          for (let d = -r; d <= r; d++) s += src[j * nx + Math.min(nx - 1, Math.max(0, i + d))]
          tmp[j * nx + i] = s / (2 * r + 1)
        }
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          let s = 0
          for (let d = -r; d <= r; d++) s += tmp[Math.min(ny - 1, Math.max(0, j + d)) * nx + i]
          src[j * nx + i] = s / (2 * r + 1)
        }
    }
  }
  blur(z, 2)

  // ---------------------------------------------------------------- the pieces laid on it
  const terr = [...terraces(m.left, -1).map((t) => ({ ...t, dir: -1 })), ...terraces(m.right, 1).map((t) => ({ ...t, dir: 1 }))]
  const flankX = (flank, y) => {
    for (let i = 1; i < flank.length; i++) {
      const a = flank[i - 1], b = flank[i]
      if (y <= b.y) return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1)
    }
    return flank[flank.length - 1].x
  }
  const pool = m.pool ?? null
  const streams = channels.length ? channels : pool ? [[m.vent, { x: pool.cx, y: pool.arcTop }]] : [[m.vent, { x: m.vent.x, y: baseY }]]
  const streamInfo = streams.map((pts, k) => ({ pts, len: polylineLength(pts) || 1, main: k === 0 }))
  const glow = new Float32Array(N)
  const poolMask = new Float32Array(N)
  const crest = new Float32Array(N)
  const plate = new Float32Array(N * 2)

  for (let j = 0; j < ny; j++) {
    const y = gy(j)
    for (let i = 0; i < nx; i++) {
      const x = gx(i)
      const k = j * nx + i
      plate[k * 2] = x
      plate[k * 2 + 1] = y
      const inner = smooth(-cell, 4 * cell, z[k]) // 0 at the limb, 1 well inside
      let dz = 0

      // gullies and ribs down the fall line, fanning from the summit (the mock's: fast across the slope, slow down it).
      // Irregular: the angle is warped, each rib's width wanders, and they start and stop, so no comb and no grid.
      const dxp = x - m.peakX, dyp = y - tipY
      const r = Math.hypot(dxp, dyp)
      const th = Math.atan2(dxp, Math.max(dyp, 1))
      const warp = (fbm(th * 3, r / (0.35 * Hm), 3, s0 + 5) - 0.5) * 0.22
      const rib = ridged(vnoise((th + warp) * 30, r / (0.45 * Hm), s0 + 7))
      const narrow = 1.2 + 2.2 * vnoise(th * 6, r / (0.6 * Hm), s0 + 11)
      const life = smooth(0.3, 0.65, vnoise(th * 9, r / (0.16 * Hm), s0 + 9))
      const fall = smooth(0, 0.12 * Hm, dyp)
      dz += (Math.pow(rib, narrow) - 0.3) * 0.05 * Hm * life * fall
      const rib2 = ridged(vnoise((th + warp * 1.7) * 71, r / (0.2 * Hm), s0 + 8))
      dz += (Math.pow(rib2, 2) - 0.3) * 0.014 * Hm * smooth(0.25, 0.6, vnoise(th * 17, r / (0.1 * Hm), s0 + 13)) * fall
      // broad lumps (smooth: the fine grain is the shader's, so nothing sparkles at the vertices)
      dz += (fbm(x / (3.5 * unit), y / (3.5 * unit), 4, s0 + 21) - 0.5) * 0.03 * Hm
      const rowH = Hm / 26

      // the crown: the lore's sheer broken spear. Vertical fracture planes: strips of seeded width, each a plane turned its
      // own way, so the faces meet at hard edges; the tall crest's top snapped off at a slant.
      const cr = smooth(rimY + 0.1 * ch, rimY - 0.35 * ch, y)
      crest[k] = cr
      if (cr > 0) {
        const fw = 0.15 * ch
        const fx = x / fw + (vnoise(y / (1.6 * ch), 1.5, s0 + 33) - 0.5) * 0.4
        const fi = Math.floor(fx)
        const ff = fx - fi
        const tilt = (hash2(fi, 3, s0 + 35) - 0.5) * 2.6
        // each plane's own slope, its two edges eased over a pixel or two so they meet hard but do not stair-step
        dz += cr * tilt * (ff - 0.5) * smooth(0, 0.12, ff) * smooth(1, 0.88, ff) * fw
        const dt = Math.hypot((x - tip.x) / (0.7 * ch), (y - tip.y) / (0.9 * ch))
        const snap = smooth(1, 0.2, dt)
        // the fracture face tilts up and toward the vent: depth grows down and away from it across the face
        dz += snap * ((y - tip.y) * 0.9 + Math.sign(tip.x - m.vent.x || 1) * (x - tip.x) * 0.35)
      }

      // terraces: the ledges the flank's outline steps out at run in across the face as shelves that catch the sky
      for (const t of terr) {
        const fx = flankX(t.dir < 0 ? m.left : m.right, t.y)
        const across = t.dir * (fx - x) // px in from that flank's edge
        const reach = (0.25 + 0.35 * vnoise(t.y * 0.01, 3, s0 + 41)) * S
        const lateral = smooth(-cell, 0.15 * reach, across) * smooth(reach, 0.3 * reach, across)
        if (lateral <= 0) continue
        const wob = (vnoise(x / (2.2 * unit), t.i, s0 + 43) - 0.5) * 0.6 * t.out
        const below = smooth(t.y - 0.5 * rowH, t.y + 0.25 * rowH, y + wob)
        dz += below * lateral * Math.min(t.out, 0.06 * S) * 1.4
      }

      // the channels: a shallow groove with a low levee, and the baked glow where the lava will run
      let gl = 0
      let cd = Infinity
      for (const st of streamInfo) {
        const { d, s } = distToPolyline(st.pts, x, y)
        cd = Math.min(cd, d)
        const heat = (st.main ? 1 : 0.6) * (0.35 + 0.65 * Math.exp(-s / (0.35 * st.len)))
        gl = Math.max(gl, heat * Math.exp(-Math.pow(d / (0.045 * Hm), 2)) + 0.22 * heat * Math.exp(-d / (0.07 * Hm)))
      }
      const wc = Math.max(8, 0.35 * ch)
      dz += (-0.5 * Math.exp(-Math.pow(cd / wc, 2)) + 0.2 * Math.exp(-Math.pow((cd - 1.7 * wc) / (0.6 * wc), 2))) * 0.03 * Hm

      // the vent's own light on the crown and the mouth
      gl = Math.max(gl, Math.exp(-Math.hypot(x - m.vent.x, y - m.vent.y) / (0.9 * ch)))

      // the pool: the same rock, slightly sunk, lit warm by the lake around and above it. The live lake is drawn over it
      // and may come out a little smaller or larger than this ellipse, so nothing here draws an edge.
      let pw = 0
      if (pool) {
        const q = Math.hypot((x - pool.cx) / pool.rx, (y - pool.cy) / pool.ry)
        pw = 1 - smooth(0.7, 1.15, q)
        dz -= 0.015 * Hm * pw
        const above = Math.max(0, pool.arcTop - y)
        const halo = Math.exp(-Math.max(q - 0.85, 0) / 0.45) * Math.exp(-above / (0.1 * Hm))
        gl = Math.max(gl, 0.55 * halo)
      }
      poolMask[k] = pw
      glow[k] = sat(gl)
      z[k] += dz * inner
    }
  }

  // ---------------------------------------------------------------- along the rays
  const positions = new Float32Array(N * 3)
  const cx = W / 2, cy = H / 2
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const X = gx(i), Y = H - gy(j)
      const f = (D - z[k]) / D
      positions[k * 3] = cx + (X - cx) * f
      positions[k * 3 + 1] = cy + (Y - cy) * f
      positions[k * 3 + 2] = z[k]
    }
  const index = new Uint32Array((nx - 1) * (ny - 1) * 6)
  let n = 0
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1
      // counter-clockwise seen from +z (rows run down the screen, so c is below a)
      index[n++] = a; index[n++] = c; index[n++] = b
      index[n++] = b; index[n++] = c; index[n++] = d
    }

  /** a canvas pixel at depth z (toward the camera), in world units */
  const toWorld = (px, py, zz = 0) => {
    const f = (D - zz) / D
    return { x: cx + (px - cx) * f, y: cy + (H - py - cy) * f, z: zz }
  }
  const depthAt = (px, py) => {
    const i = Math.round((Math.min(x1, Math.max(x0, px)) - x0) / cell)
    const j = Math.round((Math.min(y1, Math.max(y0, py)) - y0) / cell)
    return z[Math.min(ny - 1, j) * nx + Math.min(nx - 1, i)]
  }

  return {
    canvas: { w: W, h: H },
    camera: { x: cx, y: cy, z: D, fov: (2 * Math.atan(H / 2 / D) * 180) / Math.PI, near: 1, far: D * 2 },
    unit,
    outline: poly,
    grid: { nx, ny, cell, x0, y0 },
    positions,
    index,
    plate,
    glow,
    poolMask,
    crest,
    inside,
    vent: toWorld(m.vent.x, m.vent.y, depthAt(m.vent.x, m.vent.y) + 0.6 * ch),
    poolLight: pool ? toWorld(pool.cx, pool.arcTop - 0.4 * pool.ry, depthAt(pool.cx, pool.arcTop) + pool.ry) : null,
    sizes: { Hm, S, ch, tipY, baseY },
  }
}

// ------------------------------------------------------------------ the ridges
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The ridges around the cone, as crest lines: one y per canvas column (pixel rows down from the top; the ridge is
 * everything below it; `Infinity` where there is none). Seeded from `seed` alone.
 *
 * - `far`: back to front, a low hazy horizon range across the whole width, then two lower cones off to the sides like
 *   MountDeathfire.vue's far ridges (0.22 to 0.42 of the cone's height). They sit behind the cone and fade into the sky
 *   (`fade` is how much of the sky's colour each takes).
 * - `fg`: one dark ridge in the near foreground, the mock's, rising toward the canvas edge on the side away from the pool,
 *   its crest kept below every point of the pool's ellipse and the lava's streams near its columns, so it never crosses
 *   them.
 *
 * `floor` is the reference frame's bottom edge in canvas pixels (above the bleed); heights are measured from it.
 */
export function buildRidges({ mountain: m, canvas, floor = canvas.h, channels = [], seed = 0 }) {
  const W = canvas.w
  const rng = mulberry32(((seed >>> 0) ^ 0x9e3779b9) >>> 0)
  const range = (a, b) => a + (b - a) * rng()
  const s0 = (seed >>> 0) % 100003
  const tipY = Math.min(...m.crown.map((p) => p.y), m.peakY)
  const coneH = Math.max(1, floor - tipY)
  const empty = () => new Float32Array(W).fill(Infinity)
  const lift = (crest, x, y) => {
    const i = Math.round(x)
    if (i >= 0 && i < W) crest[i] = Math.min(crest[i], y)
  }

  // the horizon range: low, long, broken
  const horizon = empty()
  const hh = range(0.1, 0.16) * coneH
  for (let x = 0; x < W; x++) {
    const n = fbm(x / 420, 1.3, 4, s0 + 61)
    const jag = (vnoise(x / 37, 2.1, s0 + 63) - 0.5) * 0.06 + (vnoise(x / 11, 4.2, s0 + 65) - 0.5) * 0.02
    horizon[x] = floor - hh * (0.45 + 0.9 * Math.pow(n, 1.5) + jag)
  }
  const far = [{ crest: horizon, fade: 0.72 }]

  // two far cones, off to either side of the peak
  for (const side of [-1, 1]) {
    const crest = empty()
    const height = coneH * range(0.22, 0.42)
    const px = m.peakX + side * range(0.32, 0.72) * W * 0.5 + range(-0.09, 0.09) * W
    const halfBase = range(0.16, 0.4) * W
    const steps = 14
    const pts = []
    for (let i = steps; i >= 0; i--) pts.push({ x: px - Math.pow(i / steps, 1.4) * halfBase, y: floor - height + (i / steps) * height + range(-1, 1) * height * 0.05 })
    for (let i = 1; i <= steps; i++) pts.push({ x: px + Math.pow(i / steps, 1.4) * halfBase, y: floor - height + (i / steps) * height + range(-1, 1) * height * 0.05 })
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      for (let x = Math.ceil(a.x); x <= b.x; x++) lift(crest, x, a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1) + (vnoise(x / 9, 7.7, s0 + 67) - 0.5) * 0.012 * height)
    }
    far.push({ crest, fade: range(0.45, 0.58) })
  }
  far.sort((a, b) => b.fade - a.fade) // the haziest first

  // the foreground ridge, on the side away from the pool
  const pool = m.pool
  const side = pool ? (pool.cx < W / 2 ? 1 : -1) : m.peakX < W / 2 ? 1 : -1
  const avoid = []
  if (pool) for (let t = 0; t < 96; t++) avoid.push({ x: pool.cx + pool.rx * 1.08 * Math.cos((t / 96) * Math.PI * 2), y: pool.cy + pool.ry * 1.08 * Math.sin((t / 96) * Math.PI * 2) })
  for (const line of channels) for (let i = 0; i < line.length - 1; i++) for (let f = 0; f < 1; f += 0.25) avoid.push({ x: line[i].x + (line[i + 1].x - line[i].x) * f, y: line[i].y + (line[i + 1].y - line[i].y) * f })
  avoid.push(m.vent)
  const margin = 0.03 * W
  const lowest = empty()
  for (const p of avoid) for (let x = Math.floor(p.x - margin); x <= p.x + margin; x++) lift(lowest, x, -p.y) // max y as -min
  const rise = range(0.15, 0.2) * Math.min(coneH, canvas.h * 0.9)
  const start = range(0.5, 0.62)
  const fg = empty()
  for (let x = 0; x < W; x++) {
    const u = side > 0 ? x / W : 1 - x / W // 0 on the pool's side, 1 at the far edge
    const k = smooth(start, start + 0.3, u)
    if (k <= 0) continue
    const shape = 0.78 + 0.32 * fbm(x / 260, 5.5, 3, s0 + 71) - 0.12 * smooth(0.85, 1, u)
    const jag = (vnoise(x / 31, 8.8, s0 + 73) - 0.5) * 0.08 + (vnoise(x / 9, 9.9, s0 + 75) - 0.5) * 0.025
    let y = floor - rise * k * (shape + jag)
    const keep = -lowest[x] // the lowest pool or stream point near this column
    if (Number.isFinite(keep)) y = Math.max(y, keep + 0.02 * coneH)
    if (y < canvas.h) fg[x] = y
  }
  return { far, fg: { crest: fg, side } }
}
