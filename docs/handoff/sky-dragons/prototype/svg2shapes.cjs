// Throwaway converter: general SVG (multi-path, transforms, rel/abs M L H V C Z) -> normalised polygons per path.
const fs = require('fs'), path = require('path')

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
function parseTransform(t) {
  let m = [1, 0, 0, 1, 0, 0]
  for (const [, fn, args] of (t || '').matchAll(/(matrix|translate|scale|rotate)\(([^)]*)\)/g)) {
    const a = args.split(/[ ,]+/).filter(Boolean).map(Number)
    if (fn === 'matrix') m = mul(m, a)
    else if (fn === 'translate') m = mul(m, [1, 0, 0, 1, a[0], a[1] || 0])
    else if (fn === 'scale') m = mul(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0])
    else if (fn === 'rotate') { const r = (a[0] * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); m = mul(m, [c, s, -s, c, 0, 0]) }
  }
  return m
}
const ap = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

function flatten(d) {
  const tok = [...d.matchAll(/([MmLlCcZzHhVv])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g)].map((m) => m[1] || +m[2])
  const subs = []; let cur = null, x = 0, y = 0, sx0 = 0, sy0 = 0, cmd = null, i = 0
  const num = () => tok[i++]
  const cubic = (x0, y0, x1, y1, x2, y2, x3, y3) => {
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
    const n = Math.max(2, Math.min(10, Math.ceil(len / 14)))
    for (let k = 1; k <= n; k++) { const u = k / n, v = 1 - u; cur.push([v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3]) }
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
      case 'Z': { cur = null; x = sx0; y = sy0; if (typeof tok[i] === 'number') throw new Error('number after z'); break }
      default: throw new Error('cmd ' + cmd)
    }
  }
  return subs
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts
  const a = pts[0], b = pts[pts.length - 1]
  let dmax = 0, idx = 0
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9
  for (let i = 1; i < pts.length - 1; i++) { const dist = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L; if (dist > dmax) { dmax = dist; idx = i } }
  if (dmax > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)]
  return [a, b]
}
const loop = (pts, eps) => {
  let far = 0, best = 0
  for (let i = 1; i < pts.length; i++) { const dd = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (dd > best) { best = dd; far = i } }
  return [...rdp(pts.slice(0, far + 1), eps).slice(0, -1), ...rdp(pts.slice(far), eps).slice(0, -1)]
}

function paths(svg) {
  const out = []; const stack = [[1, 0, 0, 1, 0, 0]]
  for (const [, close, tag, attrs, selfClose] of svg.matchAll(/<(\/?)([a-zA-Z]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    if (tag === 'g') { if (close) stack.pop(); else { const t = (attrs.match(/transform="([^"]*)"/) || [])[1]; stack.push(mul(stack[stack.length - 1], parseTransform(t))); if (selfClose) stack.pop() } }
    else if (tag === 'path' && !close) {
      const d = (attrs.match(/\sd="([^"]*)"/) || [])[1]; if (!d) continue
      const t = (attrs.match(/transform="([^"]*)"/) || [])[1]
      const m = mul(stack[stack.length - 1], parseTransform(t))
      const fill = (attrs.match(/fill="([^"]*)"/) || attrs.match(/fill:\s*([^;"]*)/) || [])[1]
      if (fill === 'none' || fill === '#ffffff' || fill === 'white') continue
      out.push(flatten(d).map((s) => s.map((p) => ap(m, p))))
    }
  }
  return out
}

const result = {}
for (const [name, file, eps] of JSON.parse(process.argv[3])) {
  const svg = fs.readFileSync(path.join(process.env.TEMP, 'refs', 'dragons', file), 'utf8')
  // drop outline-text glyphs (the FreeSVG credit line): paths far smaller than the artwork
  const vb = (svg.match(/viewBox="([^"]*)"/) || [])[1]
  const canvas = vb ? Math.max(...vb.split(/[ ,]+/).map(Number).slice(2)) : 1e9
  const ext = (sp) => { const q = sp.flat(), x = q.map((v) => v[0]), y = q.map((v) => v[1]); return Math.max(Math.max(...x) - Math.min(...x), Math.max(...y) - Math.min(...y)) }
  let ps = paths(svg)
  const before = ps.length
  ps = ps.filter((sp) => ext(sp) >= canvas * 0.035)
  console.log('  ' + name + ': kept', ps.length, 'of', before, 'paths')
  const all = ps.flat(2)
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), w = maxX - minX, h = maxY - minY, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const norm = (p) => [(p[0] - cx) / w, (p[1] - cy) / w]
  const out = ps.map((sp) => sp.map((s) => loop(s.map(norm), eps)).filter((s) => s.length > 3)).filter((p) => p.length)
  result[name] = { aspect: +(h / w).toFixed(4), paths: out.map((p) => p.map((s) => s.map((q) => [+q[0].toFixed(4), +q[1].toFixed(4)]))) }
  console.log(name.padEnd(10), 'aspect', result[name].aspect, 'paths', out.length, 'subpaths', out.flat().length, 'points', out.flat(2).length, 'JSON bytes', JSON.stringify(result[name]).length)
}
fs.writeFileSync(process.argv[2], JSON.stringify(result))
console.log('wrote', process.argv[2])
