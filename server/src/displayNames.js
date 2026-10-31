/**
 * Discord display names for build authors: server nickname, else global
 * display name, else username — what the guild itself shows. Built from one
 * directory of the guild's members held in this process's memory only (never
 * written to the database or the repo) and refetched every ttlMs, so renames
 * show up and members who leave drop out. Once stale, the old directory keeps
 * answering while a refresh runs; a failed refresh keeps the last good one and
 * retries after retryMs. Anyone not in the directory (not in the guild, or no
 * directory yet) is "Community Member". The public builds API sends these
 * names, never the username stored with a build.
 *
 * The same directory also records which members hold the one configured role
 * (memberRoleId), swapped in together with the names, and answers "is this
 * person a guild member?" through memberResolver(). With no memberRoleId, or
 * no directory yet, nobody is.
 *
 * Listing members needs the bot's GUILD_MEMBERS privileged intent.
 */
import { sanitizeText } from './perkCorrectionsCore.js'

export const COMMUNITY_MEMBER = 'Community Member'
const PAGE = 1000
const NAME_MAX = 32 // Discord's own cap on nicknames and display names
const SNOWFLAKE = /^\d{17,20}$/

/** The name the guild shows for a member object, cleaned; null if none is usable. */
export function nameOf(member) {
  for (const raw of [member?.nick, member?.user?.global_name, member?.user?.username]) {
    const clean = sanitizeText(raw)
    if (clean && clean.length <= NAME_MAX) return clean
  }
  return null
}

const idOf = (member) => (SNOWFLAKE.test(member?.user?.id) ? member.user.id : null)

export function createDisplayNames({
  fetchImpl = fetch,
  apiBase,
  guildId,
  botToken,
  now = Date.now,
  ttlMs = 15 * 60_000,
  retryMs = 60_000,
  timeoutMs = 10_000,
  maxPages = 20,
  memberRoleId,
}) {
  for (const [key, v] of Object.entries({ ttlMs, retryMs, timeoutMs, maxPages })) {
    if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${key} must be a positive number`)
  }
  const configured = [apiBase, guildId, botToken].every((v) => typeof v === 'string' && v !== '')
  const roleConfigured = typeof memberRoleId === 'string' && memberRoleId !== ''

  let directory = { names: new Map(), holders: new Set() }
  let loaded = false
  let nextRefreshAt = -Infinity
  let inflight = null

  /** → the full directory { names, holders }, or null if any page fails (the caller keeps the old one). */
  async function load() {
    const next = { names: new Map(), holders: new Set() }
    let after = '0'
    for (let i = 0; i < maxPages; i++) {
      const res = await fetchImpl(`${apiBase}/v10/guilds/${guildId}/members?limit=${PAGE}&after=${after}`, {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status !== 200) return null
      const members = await res.json()
      if (!Array.isArray(members)) return null
      for (const m of members) {
        const id = idOf(m)
        if (!id) continue
        next.names.set(id, nameOf(m)) // a null name reads as Community Member
        if (roleConfigured && Array.isArray(m.roles) && m.roles.includes(memberRoleId)) next.holders.add(id)
      }
      if (members.length < PAGE) return next
      after = idOf(members[PAGE - 1])
      if (!after) return null
    }
    return null // more than maxPages: refuse a partial directory
  }

  function settle(next) {
    if (next) {
      directory = next
      loaded = true
    }
    nextRefreshAt = now() + (next ? ttlMs : retryMs)
  }
  function refresh() {
    inflight ??= load()
      .then(settle, () => settle(null))
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  /** → the directory to answer from, refreshed if due. Waits only for the very first one. */
  async function current() {
    if (configured && now() >= nextRefreshAt) {
      const pending = refresh()
      if (!loaded) await pending
    }
    return directory
  }

  /** → (discordId) => display name. */
  async function resolver() {
    const { names } = await current()
    return (id) => names.get(id) ?? COMMUNITY_MEMBER
  }

  /** → (discordId) => holds the member role. False for everyone until a directory has loaded. */
  async function memberResolver() {
    const { holders } = await current()
    return (id) => holders.has(id)
  }

  return { resolver, memberResolver }
}
