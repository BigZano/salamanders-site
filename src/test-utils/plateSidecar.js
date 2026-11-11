import home from '../lib/__fixtures__/mountain-home-1600x1000.json'

/**
 * A plate sidecar for tests: the home mountain the page built at 1600x1000 (captured in lib/__fixtures__), with the pool
 * arc and the lip anchor a real sidecar carries, as the plain JSON a fetch would hand back. Every call returns a fresh
 * copy, so a test can break one without breaking the next.
 */
export function makeSidecar(extra = {}) {
  const sidecar = {
    ...structuredClone(home.mountain),
    pool: { cx: 800, cy: 1000, rx: 320, ry: 90, arcTop: 905 },
    lip: { x: home.mountain.peakX, y: home.mountain.peakY },
    ...extra,
  }
  return JSON.parse(JSON.stringify(sidecar))
}
