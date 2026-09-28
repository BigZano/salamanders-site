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
 * Listing members needs the bot's GUILD_MEMBERS privileged intent, same as
 * scripts/fetch-discord-members.mjs.
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
}) {
  for (const [key, v] of Object.entries({ ttlMs, retryMs, timeoutMs, maxPages })) {
    if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${key} must be a positive number`)
  }
  const configured = [apiBase, guildId, botToken].every((v) => typeof v === 'string' && v !== '')

  let names = new Map()
  let loaded = false
  let nextRefreshAt = -Infinity
  let inflight = null

  /** → the full directory, or null if any page fails (the caller keeps the old one). */
  async function load() {
    const next = new Map()
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
        if (id) next.set(id, nameOf(m)) // a null name reads as Community Member
      }
      if (members.length < PAGE) return next
      after = idOf(members[PAGE - 1])
      if (!after) return null
    }
    return null // more than maxPages: refuse a partial directory
  }

  function settle(next) {
    if (next) {
      names = next
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

  /** → (discordId) => display name. Waits only for the very first directory. */
  async function resolver() {
    if (configured && now() >= nextRefreshAt) {
      const pending = refresh()
      if (!loaded) await pending
    }
    const current = names
    return (id) => current.get(id) ?? COMMUNITY_MEMBER
  }

  return { resolver }
}
