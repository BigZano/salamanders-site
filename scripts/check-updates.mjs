/**
 * Watch the official Space Marine 2 announcement feed for patches that could
 * invalidate the baked perk data.
 *
 * Source order matters here. Focus/Saber never published perk tables, so the
 * wiki is the only place to *read* perk data — but Valve's news API carries the
 * developer's own Steam announcements, so it's the authoritative answer to "has
 * anything changed?". We watch the official feed and re-bake from the wiki.
 *
 *   node scripts/check-updates.mjs
 *
 * Exits 0 always; writes a summary to stdout and, under GitHub Actions, to
 * $GITHUB_OUTPUT as `patch_title` / `patch_url` / `is_new`.
 */
import { readFile, writeFile, appendFile } from 'node:fs/promises'

const APP_ID = 2183900
const NEWS = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${APP_ID}&count=20&maxlength=1`
const SEEN = new URL('../src/data/last-patch.json', import.meta.url)

// Official developer announcements only — not press coverage syndicated into the feed.
const OFFICIAL_FEEDS = new Set(['steam_community_announcements'])
const PATCH_RE = /patch notes|hotfix|update \d/i

async function latestOfficialPatch() {
  const res = await fetch(NEWS)
  if (!res.ok) throw new Error(`Steam news API responded ${res.status}`)
  const json = await res.json()
  const items = json.appnews?.newsitems || []
  return (
    items
      .filter((n) => OFFICIAL_FEEDS.has(n.feedname))
      .find((n) => PATCH_RE.test(n.title)) || null
  )
}

async function readSeen() {
  try {
    return JSON.parse(await readFile(SEEN, 'utf8'))
  } catch {
    return { gid: null, title: null }
  }
}

async function emit(pairs) {
  if (!process.env.GITHUB_OUTPUT) return
  const body = Object.entries(pairs)
    .map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`)
    .join('\n')
  await appendFile(process.env.GITHUB_OUTPUT, body + '\n')
}

async function run() {
  const patch = await latestOfficialPatch()
  if (!patch) {
    console.log('No patch-shaped announcement in the official feed.')
    await emit({ is_new: 'false', patch_title: '', patch_url: '' })
    return
  }

  const seen = await readSeen()
  const isNew = seen.gid !== patch.gid
  const when = new Date(patch.date * 1000).toISOString().slice(0, 10)

  console.log(`Latest official patch: ${patch.title} (${when})`)
  console.log(`  ${patch.url}`)
  console.log(isNew ? '  -> NEW since last check' : '  -> already seen');

  if (isNew) {
    await writeFile(
      SEEN,
      JSON.stringify({ gid: patch.gid, title: patch.title, date: when, url: patch.url }, null, 2),
    )
  }

  await emit({ is_new: String(isNew), patch_title: patch.title, patch_url: patch.url })
}

run().catch((err) => {
  console.error(`Update check failed: ${err.message}`)
  // Never fail the workflow on a flaky third-party API.
  process.exit(0)
})
