// throwaway benchmark harness for the mock
window.__ab = (css) => { let s = document.getElementById('ab'); if (!s) { s = document.createElement('style'); s.id = 'ab'; document.head.append(s) } s.textContent = css || '' }
window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms))
window.__reset = async () => {
  const b = document.getElementById('all')
  if (b && b.textContent.trim() === 'Collapse all') b.click()
  await __sleep(900)
  document.querySelector('.branches').scrollIntoView({ block: 'start' })
  window.scrollBy(0, -70)
  await __sleep(150)
}
window.__frames = async (action, ms = 1500) => {
  const ts = []; let run = true; const longs = []
  let po
  try { po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push(Math.round(e.duration)))); po.observe({ type: 'long-animation-frame' }) } catch (e) {}
  const tick = (t) => { ts.push(t); if (run) requestAnimationFrame(tick) }
  requestAnimationFrame(tick); await __sleep(60); action(); await __sleep(ms); run = false; po && po.disconnect()
  const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b)
  return { frames: ts.length, p50: +d[d.length >> 1].toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1), max: +d[d.length - 1].toFixed(1), slow: d.filter((x) => x > 25).length, loaf: longs.length ? longs.join('/') : '-' }
}
window.__run = async (label) => {
  const out = {}
  for (const [name, act] of [['expandAll', () => document.getElementById('all').click()], ['openOne(c7)', () => document.querySelector('[data-toggle="company-7"]').click()]]) {
    const runs = []
    for (let i = 0; i < 3; i++) { await __reset(); runs.push(await __frames(act)) }
    runs.sort((a, b) => a.max - b.max)
    out[name] = runs[1]
  }
  return { label, ...out }
}
window.addEventListener('message', async (e) => {
  if (e.data && e.data.type === 'bench') {
    if (e.data.css !== undefined) __ab(e.data.css)
    const r = await __run(e.data.label)
    parent.postMessage({ type: 'bench-result', r }, '*')
  }
})
if (location.search.includes('transparent')) {
  const s = document.createElement('style')
  s.textContent = 'html,body{background:transparent!important} body::before{display:none!important} .nav{display:none!important}'
  document.head.append(s)
}
// record frame deltas during the first 3.5s after the script runs
window.__t0 = performance.now()
window.__loadFrames = (() => { const ts = []; const tick = (t) => { ts.push(t); if (t - window.__t0 < 3500) requestAnimationFrame(tick) }; requestAnimationFrame(tick); return ts })()
window.__loadSummary = () => { const ts = window.__loadFrames; const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b); return { frames: ts.length, firstFrameDelayMs: Math.round(ts[0] - window.__t0), p95: d.length ? +d[Math.floor(d.length * 0.95)].toFixed(1) : null, max: d.length ? +d[d.length - 1].toFixed(1) : null, slow: d.filter((x) => x > 25).length } }
