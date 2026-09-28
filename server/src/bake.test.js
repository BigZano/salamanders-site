import { describe, it, expect, vi } from 'vitest'
import { createBakeLoader } from './bake'
import { Upstream } from './discordRoles'

const files = {
  'https://raw.test/data/weapon-trees.json': { weapons: { 'Las Fusil': { perks: [] } } },
  'https://raw.test/data/perk-details.json': { classes: { Tactical: { perks: {} } } },
}
const okFetch = () => vi.fn(async (url) => new Response(JSON.stringify(files[String(url)])))

describe('createBakeLoader', () => {
  it('loads both files and caches within the ttl', async () => {
    const fetchImpl = okFetch()
    let t = 0
    const load = createBakeLoader({ baseUrl: 'https://raw.test/data/', fetchImpl, ttlMs: 100, now: () => t })
    expect(Object.keys((await load()).weapons)).toEqual(['Las Fusil'])
    await load()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    t = 101
    await load()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('serves stale data when a refresh fails', async () => {
    let t = 0
    const fetchImpl = okFetch()
    const load = createBakeLoader({ baseUrl: 'https://raw.test/data/', fetchImpl, ttlMs: 1, now: () => t })
    await load()
    fetchImpl.mockImplementation(async () => new Response('nope', { status: 500 }))
    t = 5
    expect((await load()).classes.Tactical).toBeTruthy()
  })

  it('throws Upstream when nothing was ever loaded', async () => {
    const load = createBakeLoader({ baseUrl: 'https://raw.test/data/', fetchImpl: async () => new Response('x', { status: 404 }) })
    await expect(load()).rejects.toBeInstanceOf(Upstream)
  })
})
