/**
 * The wiki bake (src/data/weapon-trees.json + perk-details.json), read from
 * the repo's main branch so the API validates against exactly what the site
 * ships, without rebuilding the API image on every re-bake. Cached; a failed
 * refresh keeps serving the last good copy.
 */
import { Upstream } from './discordRoles.js'

export function createBakeLoader({ baseUrl, fetchImpl = fetch, ttlMs = 10 * 60_000, now = Date.now }) {
  let cached = null
  let at = 0

  async function get(file) {
    const res = await fetchImpl(new URL(file, baseUrl), { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`${file}: ${res.status}`)
    return res.json()
  }

  return async function loadBake() {
    if (cached && now() - at < ttlMs) return cached
    try {
      const [trees, details] = await Promise.all([get('weapon-trees.json'), get('perk-details.json')])
      if (!trees?.weapons || !details?.classes) throw new Error('unexpected bake shape')
      cached = { weapons: trees.weapons, classes: details.classes }
      at = now()
      return cached
    } catch (err) {
      if (cached) return cached
      throw new Upstream(`Perk data unavailable: ${err.message}`)
    }
  }
}
