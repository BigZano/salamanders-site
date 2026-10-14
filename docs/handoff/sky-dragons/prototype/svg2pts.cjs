// Throwaway converter: potrace SVG path -> normalised polygon point lists (RDP-simplified).
const fs = require('fs'), path = require('path')

function parseSvg(svg) {
  const d = svg.match(/ d="([^"]+)"/)[1]
  const t = (svg.match(/transform="([^"]+)"/) || [])[1] || ''
  let tx = 0, ty = 0, sx = 1, sy = 1
  const tr = t.match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/); if (tr) { tx = +tr[1]; ty = +tr[2] }
  const sc = t.match(/scale\(([-\d.]+)[ ,]+([-\d.]+)\)/); if (sc) { sx = +sc[1]; sy = +sc[2] }
  return { d, apply: ([x, y]) => [x * sx + tx, y * sy + ty] }
}

function flatten(d) {
  const tok = [...d.matchAll(/([MmLlCcZzHhVv])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g)].map((m) => m[1] || +m[2])
  const subs = []; let cur = null, x = 0, y = 0, sx0 = 0, sy0 = 0, cmd = null, i = 0
  const num = () => tok[i++]
  const cubic = (x0, y0, x1, y1, x2, y2, x3, y3) => {
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
    const n = Math.max(3, Math.min(14, Math.ceil(len / 120)))
    for (let k = 1; k <= n; k++) {
      const u = k / n, v = 1 - u
      cur.push([v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3])
    }
  }
  while (i < tok.length) {
    if (typeof tok[i] === 'string') cmd = tok[i++]
    const rel = cmd === cmd.toLowerCase()
    switch (cmd.toUpperCase()) {
      case 'M': { const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; cur = [[x, y]]; subs.push(cur); sx0 = x; sy0 = y; cmd = rel ? 'l' : 'L'; break }
      case 'L': { const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; cur.push([x, y]); break }
      case 'H': { const a = num(); x = rel ? x + a : a; cur.push([x, y]); break }
      case 'V': { const a = num(); y = rel ? y + a : a; cur.push([x, y]); break }
      case 'C': { const p = [num(), num(), num(), num(), num(), num()]; const q = rel ? [x + p[0], y + p[1], x + p[2], y + p[3], x + p[4], y + p[5]] : p; cubic(x, y, ...q); x = q[4]; y = q[5]; break }
      case 'Z': { cur = null; x = sx0; y = sy0; break }
      default: throw new Error('cmd ' + cmd)
    }
  }
  return subs
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts
  const [a, b] = [pts[0], pts[pts.length - 1]]
  let dmax = 0, idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9
    const dist = Math.abs(dy * px - dx * py + b[0] * a[1] - b[1] * a[0]) / L
    if (dist > dmax) { dmax = dist; idx = i }
  }
  if (dmax > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)]
  return [a, b]
}

const out = {}
for (const name of ['pterosauria', 'rhamphorhynchus']) {
  const svg = fs.readFileSync(path.join(process.env.TEMP, 'refs', name + '.svg'), 'utf8')
  const { d, apply } = parseSvg(svg)
  let subs = flatten(d).map((s) => s.map(apply))
  const all = subs.flat()
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const w = maxX - minX, h = maxY - minY, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const norm = (p) => [(p[0] - cx) / w, (p[1] - cy) / w] // width = 1, centred, y down (svg space after transform)
  const loop = (pts) => {
    // a closed contour starts and ends at one point; split at the farthest point so each half has a real chord
    let far = 0, best = 0
    for (let i = 1; i < pts.length; i++) { const dd = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (dd > best) { best = dd; far = i } }
    return [...rdp(pts.slice(0, far + 1), 0.0016).slice(0, -1), ...rdp(pts.slice(far), 0.0016).slice(0, -1)]
  }
  subs = subs.map((s) => loop(s.map(norm))).filter((s) => s.length > 3)
  // drop specks: keep subpaths whose bbox is at least 1.5% of width
  subs = subs.filter((s) => { const a = s.map((p) => p[0]), b = s.map((p) => p[1]); return Math.max(...a) - Math.min(...a) > 0.015 || Math.max(...b) - Math.min(...b) > 0.015 })
  out[name] = { aspect: +(h / w).toFixed(4), subpaths: subs.map((s) => s.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)])) }
  console.log(name, 'aspect', out[name].aspect, 'subpaths', subs.length, 'points', subs.reduce((n, s) => n + s.length, 0), 'bytes', JSON.stringify(out[name]).length)
}
const dest = process.argv[2]
fs.writeFileSync(dest, JSON.stringify(out))
console.log('wrote', dest)
