import { describe, it, expect } from 'vitest'
import { createDiscord, API } from './discord.mjs'

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, ...init })
const GUILD = '800000000000000001'

// A Discord stand-in: each call takes the next answer; `waits` records the pauses the helper asked for.
function harness(...answers) {
  const seen = { urls: [], auths: [], waits: [] }
  const queue = [...answers]
  const fetchImpl = async (url, init) => {
    seen.urls.push(url)
    seen.auths.push(init.headers.Authorization)
    if (!queue.length) throw new Error('unexpected extra request')
    return queue.shift()
  }
  const discord = createDiscord({ token: 'tok', fetchImpl, sleep: async (ms) => void seen.waits.push(ms) })
  return { discord, seen }
}
const member = (i) => ({ user: { id: String(100000000000000000n + BigInt(i)) }, roles: [] })
const page = (n, from = 0) => Array.from({ length: n }, (_, i) => member(from + i))

describe('discordFetch', () => {
  it('authenticates as the bot and returns the parsed body', async () => {
    const { discord, seen } = harness(json({ ok: 1 }))
    expect(await discord.discordFetch(`${API}/x`)).toEqual({ ok: 1 })
    expect(seen.auths).toEqual(['Bot tok'])
  })

  it('throws on a non-OK answer, with its status and body', async () => {
    const { discord } = harness(new Response('nope', { status: 403, statusText: 'Forbidden' }))
    await expect(discord.discordFetch(`${API}/x`)).rejects.toThrow('Discord API 403 Forbidden: nope')
  })

  it('waits out a 429 for as long as Discord says, then retries', async () => {
    const { discord, seen } = harness(json({ retry_after: 2.5 }, { status: 429 }), json({ ok: 1 }))
    expect(await discord.discordFetch(`${API}/x`)).toEqual({ ok: 1 })
    expect(seen.waits).toEqual([2500])
    expect(seen.urls).toHaveLength(2)
  })

  it('pauses until the bucket resets when it is empty, and not otherwise', async () => {
    const empty = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.5' }
    const a = harness(json({}, { headers: empty }))
    await a.discord.discordFetch(`${API}/x`)
    expect(a.seen.waits).toEqual([1500])
    const b = harness(json({}, { headers: { ...empty, 'x-ratelimit-remaining': '5' } }))
    await b.discord.discordFetch(`${API}/x`)
    expect(b.seen.waits).toEqual([])
    const c = harness(json({}, { headers: { 'x-ratelimit-remaining': '0' } }))
    await c.discord.discordFetch(`${API}/x`)
    expect(c.seen.waits).toEqual([])
  })
})

describe('fetchAllMembers', () => {
  it('pages by the last id until a short page, and returns everyone', async () => {
    const { discord, seen } = harness(json(page(1000)), json(page(3, 1000)))
    const all = await discord.fetchAllMembers(GUILD)
    expect(all).toHaveLength(1003)
    expect(seen.urls).toEqual([
      `${API}/guilds/${GUILD}/members?limit=1000&after=0`,
      `${API}/guilds/${GUILD}/members?limit=1000&after=${page(1000)[999].user.id}`,
    ])
  })
  it('stops after one short page', async () => {
    const { discord, seen } = harness(json(page(5)))
    expect(await discord.fetchAllMembers(GUILD)).toHaveLength(5)
    expect(seen.urls).toHaveLength(1)
  })
  it('asks once more after an exactly full page, and accepts that it was the last', async () => {
    const { discord, seen } = harness(json(page(1000)), json([]))
    expect(await discord.fetchAllMembers(GUILD)).toHaveLength(1000)
    expect(seen.urls).toHaveLength(2)
  })
})

describe('fetchRoles', () => {
  it('returns the guild roles', async () => {
    const { discord, seen } = harness(json([{ id: '1', name: 'r', color: 0 }]))
    expect(await discord.fetchRoles(GUILD)).toEqual([{ id: '1', name: 'r', color: 0 }])
    expect(seen.urls).toEqual([`${API}/guilds/${GUILD}/roles`])
  })
})
