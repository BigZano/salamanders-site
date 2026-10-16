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
import { createDiscord } from './lib/discord.mjs'

const GUILD_ID = '1322056087792521269'
const ROLE_ID = '1377787723976409211'
const OUT = new URL('../src/data/discord-members.json', import.meta.url)

const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  console.error('DISCORD_BOT_TOKEN not set.')
  process.exit(1)
}

const { fetchAllMembers } = createDiscord({ token, log: console.log })

async function run() {
  console.log(`Fetching members of guild ${GUILD_ID}...`)
  const members = await fetchAllMembers(GUILD_ID)

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
