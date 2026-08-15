/**
 * Bake the list of Discord member IDs holding the "member" role into
 * src/data/discord-members.json, so the static site can badge a build as
 * member-submitted without any live OAuth/backend check at request time.
 *
 * Discord has no "list members by role" endpoint — this pulls the full
 * guild member list (paginated, 1000/page) and filters locally. Requires
 * DISCORD_BOT_TOKEN (bot must be in the guild, GUILD_MEMBERS privileged
 * intent enabled in the Developer Portal).
 *
 *   DISCORD_BOT_TOKEN=... bun run discord:members
 */
import { writeFile } from 'node:fs/promises'

const GUILD_ID = '1322056087792521269'
const ROLE_ID = '1377787723976409211'
const API = 'https://discord.com/api/v10'
const OUT = new URL('../src/data/discord-members.json', import.meta.url)

const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  console.error('DISCORD_BOT_TOKEN not set.')
  process.exit(1)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Fetch with Discord's rate-limit headers/429 body honored. */
async function discordFetch(url) {
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } })

    if (res.status === 429) {
      const { retry_after } = await res.json()
      console.warn(`  rate limited, retrying in ${retry_after}s`)
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
async function fetchAllMembers() {
  const members = []
  let after = '0'
  for (;;) {
    const page = await discordFetch(`${API}/guilds/${GUILD_ID}/members?limit=1000&after=${after}`)
    members.push(...page)
    console.log(`  fetched page: ${page.length} members (total ${members.length})`)
    if (page.length < 1000) break
    after = page[page.length - 1].user.id
  }
  return members
}

async function run() {
  console.log(`Fetching members of guild ${GUILD_ID}...`)
  const members = await fetchAllMembers()

  const memberIds = members
    .filter((m) => m.roles.includes(ROLE_ID))
    .map((m) => m.user.id)

  await writeFile(
    OUT,
    JSON.stringify(
      { fetched: new Date().toISOString(), guildId: GUILD_ID, roleId: ROLE_ID, memberIds },
      null,
      2,
    ),
  )
  console.log(`\n${memberIds.length}/${members.length} members hold the role. Wrote ${OUT.pathname}`)
}

run().catch((err) => {
  console.error(`\nFetch failed: ${err.message}`)
  process.exit(1)
})
