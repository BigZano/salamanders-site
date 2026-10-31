/**
 * Discord REST helpers for the maintenance scripts (snapshot-legacy-accolades).
 * Discord's rate-limit headers and 429 bodies are honoured; the member list is paginated.
 * Needs a bot token, and the GUILD_MEMBERS privileged intent for the member list.
 */
export const API = 'https://discord.com/api/v10'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createDiscord({ token, fetchImpl = fetch, sleep = wait, log = () => {} }) {
  /** Fetch with Discord's rate-limit headers/429 body honored. */
  async function discordFetch(url) {
    for (;;) {
      const res = await fetchImpl(url, { headers: { Authorization: `Bot ${token}` } })

      if (res.status === 429) {
        const { retry_after } = await res.json()
        log(`  rate limited, retrying in ${retry_after}s`)
        await sleep(retry_after * 1000)
        continue
      }
      if (!res.ok) {
        throw new Error(`Discord API ${res.status} ${res.statusText}: ${await res.text()}`)
      }

      const body = await res.json()
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = Number(res.headers.get('x-ratelimit-reset-after') || 0)
        if (resetAfter > 0) await sleep(resetAfter * 1000)
      }
      return body
    }
  }

  /** Paginate /guilds/{id}/members (max 1000/page) until exhausted. */
  async function fetchAllMembers(guildId) {
    const members = []
    let after = '0'
    for (;;) {
      const page = await discordFetch(`${API}/guilds/${guildId}/members?limit=1000&after=${after}`)
      members.push(...page)
      log(`  fetched page: ${page.length} members (total ${members.length})`)
      if (page.length < 1000) break
      after = page[page.length - 1].user.id
    }
    return members
  }

  const fetchRoles = (guildId) => discordFetch(`${API}/guilds/${guildId}/roles`)

  return { discordFetch, fetchAllMembers, fetchRoles }
}
