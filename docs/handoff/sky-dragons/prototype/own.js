// Throwaway v2: side-view dragons (drake, legless wyrm) from parts, a dorsal great wyrm, and the planform small dragon.
const dir = (a) => [Math.cos(a), Math.sin(a)]
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const sc = (a, k) => [a[0] * k, a[1] * k]
const lerp = (a, b, t) => a + (b - a) * t
const cr = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t; return [0, 1].map((i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3)) }
function catmull(pts, seg = 10) { const P = [pts[0], ...pts, pts[pts.length - 1]], out = []; for (let i = 1; i < P.length - 2; i++) for (let k = 0; k < seg; k++) out.push(cr(P[i - 1], P[i], P[i + 1], P[i + 2], k / seg)); out.push(pts[pts.length - 1]); return out }
function interp(tbl, s) { for (let i = 1; i < tbl.length; i++) if (s <= tbl[i][0]) { const [s0, v0] = tbl[i - 1], [s1, v1] = tbl[i]; return lerp(v0, v1, (s - s0) / (s1 - s0 || 1)) } return tbl[tbl.length - 1][1] }
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }

// ---- side-view parameter sets. Units: 1 = hips to shoulder. x forward (head +x), y down.
// The wing root is the SHOULDER: top of the chest, right behind the base of the neck, over the forelegs.
const SWIFT = {
  spine: [[-2.5, 0.38], [-1.6, 0.13], [-0.8, 0.03], [0, 0], [0.5, -0.04], [0.95, -0.1], [1.3, -0.3], [1.55, -0.52], [1.78, -0.6], [1.95, -0.58]],
  thick: [[0, 0.004], [0.2, 0.03], [0.4, 0.075], [0.52, 0.16], [0.62, 0.24], [0.74, 0.25], [0.82, 0.17], [0.92, 0.11], [1, 0.09]],
  topK: 0.8, botK: 1.1, head: { scale: 0.85, tilt: 0.1, horns: 2 },
  spinesN: 11, spineH: 0.09, shoulderX: 0.9, attachX: 0.05, shoulderUp: 0.03, legX: [0.1, 0.78],
  wing: { a1: 0.55, a2: 0.85, fingers: [1.55, 1.45, 1.25, 1.0], fan: [0.0, 0.34, 0.7, 1.05], up: -1.7, down: -3.5, elbow: 0.32, scallop: 0.3, arm: 0.07, bulge: 0.14 },
  legs: true, tail: { barb: 0.2 },
}
const WYRM = {  // true wyrm: no legs, long serpentine body that undulates, big wings off the shoulders
  spine: [[-4.6, 0], [-3.4, 0], [-2.2, 0], [-1.0, 0], [0, 0], [0.9, -0.03], [1.5, -0.16], [2.0, -0.4], [2.35, -0.62], [2.6, -0.62]],
  thick: [[0, 0.02], [0.2, 0.05], [0.45, 0.11], [0.62, 0.18], [0.74, 0.23], [0.82, 0.22], [0.9, 0.16], [1, 0.12]],
  topK: 1, botK: 0.95, head: { scale: 0.95, tilt: 0.08, horns: 3 },
  spinesN: 18, spineH: 0.1, shoulderX: 1.3, attachX: 0.2, shoulderUp: 0.03, legX: null,
  wing: { a1: 0.6, a2: 0.95, fingers: [1.75, 1.65, 1.45, 1.2, 0.9], fan: [0.0, 0.3, 0.62, 0.95, 1.28], up: -1.7, down: -3.5, elbow: 0.32, scallop: 0.3, arm: 0.075, bulge: 0.15 },
  legs: false, tail: { barb: 0.22 },
}

function spineData(P, wave) {
  let pts = catmull(P.spine, 12)
  if (wave) pts = pts.map((p) => [p[0], p[1] + wave(p[0])])
  const n = pts.length, s = [0]
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const L = s[n - 1]; const t = s.map((v) => v / L)
  const tan = pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l] })
  const nor = tan.map(([x, y]) => [y, -x])                  // points "up" when travelling right
  const w = t.map((v) => interp(P.thick, v))
  return { pts, t, tan, nor, w, n }
}
const at = (D, s) => { let i = 0; while (i < D.n - 2 && D.t[i + 1] < s) i++; return i }
const atX = (D, x) => { let i = 0; while (i < D.n - 2 && D.pts[i][0] < x) i++; return i }

function headPoly() {  // local frame: origin at the neck end, +x forward. Brow ridge, snout, mouth slightly open.
  return [[-0.02, -0.07], [0.08, -0.10], [0.17, -0.105], [0.27, -0.07], [0.40, -0.06], [0.50, -0.05], [0.55, -0.02], [0.52, 0.0], [0.42, 0.012], [0.46, 0.04], [0.38, 0.062], [0.22, 0.085], [0.08, 0.11], [-0.02, 0.09]]
}
function hornPoly(k, n) { // swept-back horns from the brow
  const j = n === 2 ? [0, 1][k] : k
  const base = [0.10 + j * 0.05, -0.095 - (j % 2) * 0.01], len = 0.34 - j * 0.045, lift = 0.10 + j * 0.05
  return [[base[0], base[1]], [base[0] - len * 0.6, base[1] - lift * 0.9], [base[0] - len, base[1] - lift * 0.35 - j * 0.02], [base[0] - len * 0.55, base[1] - lift * 0.35 + 0.02], [base[0] + 0.03, base[1] + 0.04]]
}

function fillPoly(ctx, pts, S) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * S, y * S) : ctx.moveTo(x * S, y * S))); ctx.closePath(); ctx.fill() }

function wingJoints(P, D, u, phase = 0) {
  const W = P.wing, uu = Math.max(0, Math.min(1, u + phase))
  const i = atX(D, P.shoulderX), base = add(D.pts[i], sc(D.nor[i], D.w[i] * P.topK * 0.75 + P.shoulderUp))
  const th = W.up + (W.down - W.up) * uu                       // arm angle sweeps up -> back-down (through "back", never forward)
  const E = add(base, sc(dir(th), W.a1))
  const th2 = th + W.elbow * (1 - uu) - 0.1 * uu                // forearm folds a little on the upstroke
  const Wr = add(E, sc(dir(th2), W.a2))
  const tips = W.fingers.map((len, k) => add(Wr, sc(dir(th2 - W.fan[k] * (0.92 + 0.22 * uu)), len * (1 - 0.1 * uu))))
  const j = atX(D, P.attachX), hip = add(D.pts[j], sc(D.nor[j], -D.w[j] * P.botK * 0.6))
  return { base, E, Wr, tips, hip, th2 }
}
function drawWing(ctx, P, D, u, S, phase = 0) {
  const W = P.wing, J = wingJoints(P, D, u, phase), pull = W.scallop
  const m = (a, b) => [(a[0] + b[0]) / 2 * (1 - pull) + J.Wr[0] * pull, (a[1] + b[1]) / 2 * (1 - pull) + J.Wr[1] * pull]
  const nrm = dir(J.th2 + Math.PI / 2), bulge = W.bulge || 0
  const ce = [J.E[0] + nrm[0] * bulge, J.E[1] + nrm[1] * bulge]
  ctx.beginPath(); ctx.moveTo(J.base[0] * S, J.base[1] * S); ctx.quadraticCurveTo(ce[0] * S, ce[1] * S, J.Wr[0] * S, J.Wr[1] * S); ctx.lineTo(J.tips[0][0] * S, J.tips[0][1] * S)
  for (let k = 1; k < J.tips.length; k++) { const c = m(J.tips[k - 1], J.tips[k]); ctx.quadraticCurveTo(c[0] * S, c[1] * S, J.tips[k][0] * S, J.tips[k][1] * S) }
  const last = J.tips[J.tips.length - 1], c = m(last, J.hip); ctx.quadraticCurveTo(c[0] * S, c[1] * S, J.hip[0] * S, J.hip[1] * S); ctx.closePath(); ctx.fill()
  ctx.strokeStyle = ctx.fillStyle; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.lineWidth = W.arm * S; ctx.beginPath(); ctx.moveTo(J.base[0] * S, J.base[1] * S); ctx.quadraticCurveTo(ce[0] * S, ce[1] * S, J.E[0] * S, J.E[1] * S); ctx.stroke()
  ctx.lineWidth = W.arm * 0.7 * S; ctx.beginPath(); ctx.moveTo(J.E[0] * S, J.E[1] * S); ctx.lineTo(J.Wr[0] * S, J.Wr[1] * S); ctx.stroke()
  ctx.lineWidth = W.arm * 0.32 * S
  J.tips.forEach((t) => { const d = [t[0] - J.Wr[0], t[1] - J.Wr[1]], l = Math.hypot(...d); ctx.beginPath(); ctx.moveTo(J.Wr[0] * S, J.Wr[1] * S); ctx.lineTo((t[0] + d[0] / l * 0.07) * S, (t[1] + d[1] / l * 0.07) * S); ctx.stroke() })
  const cl = add(J.Wr, sc(dir(J.th2 - 1.9), 0.17)); ctx.lineWidth = W.arm * 0.5 * S; ctx.beginPath(); ctx.moveTo(J.Wr[0] * S, J.Wr[1] * S); ctx.quadraticCurveTo((J.Wr[0] + cl[0]) / 2 * S, (J.Wr[1] + cl[1]) / 2 * S - 0.03 * S, cl[0] * S, cl[1] * S); ctx.stroke()
}

function drawBody(ctx, P, D, S, swing = 0) {
  const top = D.pts.map((p, i) => add(p, sc(D.nor[i], D.w[i] * P.topK))), bot = D.pts.map((p, i) => add(p, sc(D.nor[i], -D.w[i] * P.botK)))
  const wob = P.legs ? (p, i) => [p[0], p[1] + Math.sin(swing + D.t[i] * 5) * 0.035 * (1 - D.t[i]) * (1 - D.t[i])] : (p) => p
  const T = top.map(wob), B = bot.map(wob)
  fillPoly(ctx, [...T, ...B.slice().reverse()], S)
  for (let k = 0; k < P.spinesN; k++) { const sT = 0.3 + (k / (P.spinesN - 1)) * 0.62, i = at(D, sT), a = T[i], b = T[Math.min(D.n - 1, i + 2)], h = P.spineH * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, sT * 1.05))); const apex = add(add(a, sc(D.nor[i], h)), sc(D.tan[i], -h * 0.5)); fillPoly(ctx, [a, apex, b], S) }
  const tip = T[0], tn = D.tan[0], bn = P.tail.barb
  fillPoly(ctx, [add(tip, sc(tn, -bn)), add(tip, add(sc(tn, bn * 0.25), sc(D.nor[0], bn * 0.5))), add(tip, sc(tn, bn * 0.95)), add(tip, add(sc(tn, bn * 0.25), sc(D.nor[0], -bn * 0.5)))], S)
  const e = D.n - 1, o = D.pts[e], ang = Math.atan2(D.tan[e][1], D.tan[e][0]) + P.head.tilt, hs = P.head.scale
  const place = (q) => { const c = Math.cos(ang), s2 = Math.sin(ang), x = q[0] * hs, y = q[1] * hs; return [o[0] + x * c - y * s2, o[1] + x * s2 + y * c] }
  fillPoly(ctx, headPoly().map(place), S); for (let k = 0; k < P.head.horns; k++) fillPoly(ctx, hornPoly(k, P.head.horns).map(place), S)
  if (P.legs) {
    const leg = (o2, pts) => fillPoly(ctx, pts.map((q) => add(o2, q)), S)
    const h = B[atX(D, P.legX[0])]
    leg(h, [[-0.16, -0.06], [0.12, -0.08], [0.2, 0.08], [0.12, 0.2], [0.2, 0.3], [0.3, 0.34], [0.34, 0.38], [0.2, 0.38], [0.08, 0.36], [0.02, 0.26], [-0.06, 0.16], [-0.18, 0.06]])
    const f = B[atX(D, P.legX[1])]
    leg(f, [[-0.08, -0.04], [0.1, -0.04], [0.14, 0.1], [0.1, 0.2], [0.18, 0.27], [0.1, 0.3], [0.0, 0.26], [-0.04, 0.14]])
  }
}
function drawDragon(ctx, P, D, u, S, o = {}) {
  drawWing(ctx, P, D, u, S, 0.14)      // far wing, a beat behind
  drawBody(ctx, P, D, S, o.swing || 0)
  drawWing(ctx, P, D, u, S, 0)         // near wing
}
// the wyrm's body undulates: a wave that travels from the shoulders back to the tail
const wyrmWave = (t, amp = 1) => (x) => amp * Math.sin(x * 1.55 - t * 2.6) * 0.34 * smooth((1.5 - x) / 3.2)

// ---- dorsal great wyrm: body along x (head +x), wings spread across y, dorsal side toward us
function drawDorsal(ctx, S, o = {}) {
  const flex = o.flex || 0, bank = o.bank || 0
  const body = [[-3.6, 0.0], [-3.4, 0.05], [-2.6, 0.1], [-1.7, 0.2], [-0.9, 0.34], [-0.3, 0.44], [0.3, 0.4], [0.75, 0.44], [1.1, 0.3], [1.5, 0.19], [1.95, 0.15], [2.1, 0.24], [2.3, 0.27], [2.5, 0.19], [2.75, 0.12], [2.95, 0.06], [3.0, 0]]
  const poly = [...body.map(([x, w]) => [x, -w]), ...body.slice().reverse().map(([x, w]) => [x, w])]
  fillPoly(ctx, poly, S)
  // tail spade + side spikes along the tail
  fillPoly(ctx, [[-3.45, 0], [-3.95, -0.26], [-3.75, 0], [-3.95, 0.26]], S)
  for (let k = 0; k < 8; k++) { const x = -3.0 + k * 0.45; let w = 0; for (let i = 1; i < body.length; i++) if (x <= body[i][0]) { w = lerp(body[i - 1][1], body[i][1], (x - body[i - 1][0]) / (body[i][0] - body[i - 1][0])); break } ; for (const sg of [-1, 1]) fillPoly(ctx, [[x, sg * w], [x - 0.26, sg * (w + 0.2)], [x - 0.4, sg * w]], S) }
  // horns
  for (const sg of [-1, 1]) { fillPoly(ctx, [[2.18, sg * 0.15], [1.7, sg * 0.5], [1.55, sg * 0.46], [2.0, sg * 0.1]], S); fillPoly(ctx, [[2.3, sg * 0.17], [2.0, sg * 0.42], [1.9, sg * 0.4], [2.2, sg * 0.12]], S) }
  // tucked legs, claws splayed
  for (const sg of [-1, 1]) {
    fillPoly(ctx, [[-0.5, sg * 0.25], [-0.1, sg * 0.28], [0.1, sg * 0.5], [-0.05, sg * 0.66], [-0.2, sg * 0.7], [-0.16, sg * 0.56], [-0.34, sg * 0.5]], S)
    fillPoly(ctx, [[0.7, sg * 0.28], [0.95, sg * 0.3], [1.05, sg * 0.46], [0.9, sg * 0.56], [0.8, sg * 0.5]], S)
  }
  // wings
  for (const sg of [-1, 1]) {
    const span = 1 + bank * sg, a1 = 0.95 * span, a2 = 1.35 * span
    const P0 = [0.72, sg * 0.4]
    const d1 = [0.6, sg], n1 = Math.hypot(...d1), d2 = [-0.3 - flex * 0.2, sg], n2 = Math.hypot(...d2)
    const E = [P0[0] + d1[0] / n1 * a1, P0[1] + d1[1] / n1 * a1]
    const Wr = [E[0] + d2[0] / n2 * a2, E[1] + d2[1] / n2 * a2]
    const phis = [0.38, 0.72, 1.04, 1.36, 1.68, 1.98], lens = [2.0, 2.35, 2.25, 1.95, 1.55, 1.15]
    const tips = phis.map((ph, k) => { const p = ph + flex * 0.16 * (k / 5); return [Wr[0] - Math.sin(p) * lens[k] * span, Wr[1] + sg * Math.cos(p) * lens[k] * span] })
    const H = [-0.95, sg * 0.42], pull = 0.28
    const m = (a, b) => [(a[0] + b[0]) / 2 * (1 - pull) + Wr[0] * pull, (a[1] + b[1]) / 2 * (1 - pull) + Wr[1] * pull]
    const ce = [E[0] + 0.45, E[1] + sg * 0.1]
    ctx.beginPath(); ctx.moveTo(P0[0] * S, P0[1] * S); ctx.quadraticCurveTo(ce[0] * S, ce[1] * S, Wr[0] * S, Wr[1] * S); ctx.lineTo(tips[0][0] * S, tips[0][1] * S)
    for (let k = 1; k < tips.length; k++) { const c = m(tips[k - 1], tips[k]); ctx.quadraticCurveTo(c[0] * S, c[1] * S, tips[k][0] * S, tips[k][1] * S) }
    const c = m(tips[tips.length - 1], H); ctx.quadraticCurveTo(c[0] * S, c[1] * S, H[0] * S, H[1] * S); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = ctx.fillStyle; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.lineWidth = 0.1 * S; ctx.beginPath(); ctx.moveTo(P0[0] * S, P0[1] * S); ctx.quadraticCurveTo(ce[0] * S, ce[1] * S, Wr[0] * S, Wr[1] * S); ctx.stroke()
    ctx.lineWidth = 0.034 * S
    tips.forEach((t) => { const d = [t[0] - Wr[0], t[1] - Wr[1]], l = Math.hypot(...d); ctx.beginPath(); ctx.moveTo(Wr[0] * S, Wr[1] * S); ctx.lineTo((t[0] + d[0] / l * 0.1) * S, (t[1] + d[1] / l * 0.1) * S); ctx.stroke() })
    ctx.lineWidth = 0.05 * S; ctx.beginPath(); ctx.moveTo(Wr[0] * S, Wr[1] * S); ctx.lineTo((Wr[0] + 0.1) * S, (Wr[1] + sg * 0.2) * S); ctx.stroke()
  }
}

// ---- the small planform dragon from the first renders (CC0 liftarn silhouette), arc-bend flap from the body
const ROOT = 0.05, LEN = 0.45, YCUT = 0.13
function warpPlan([x, y], a, k = 0.55) {
  const ax = Math.abs(x)
  if (ax <= ROOT) return [x, y]
  const band = 1 - smooth((y - YCUT) / 0.05)
  if (band <= 0) return [x, y]
  const edge = smooth((ax - ROOT) / 0.02)
  const t = Math.min(1, (ax - ROOT) / LEN)
  const s = Math.abs(a) < 1e-4 ? t * LEN : LEN * Math.sin(a * t) / a
  const z = Math.abs(a) < 1e-4 ? 0 : LEN * (1 - Math.cos(a * t)) / a
  const w = band * edge
  const xp = Math.sign(x) * (ROOT + s), yp = y - k * z
  return [x + (xp - x) * w, y + (yp - y) * w]
}
let PLAN = null
function tracePlan(ctx, fn, W) { for (const p of PLAN.paths) { ctx.beginPath(); for (const sp of p) { sp.forEach((q, i) => { const [x, y] = fn(q); i ? ctx.lineTo(x * W, y * W) : ctx.moveTo(x * W, y * W) }); ctx.closePath() } ctx.fill('nonzero') } }
function drawPlan(ctx, a, W) { tracePlan(ctx, (p) => warpPlan(p, a), W) }
