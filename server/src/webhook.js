/**
 * Fire-and-forget Discord webhook. Mentions are always disabled: perk names,
 * notes and usernames are user-typed and must never ping @everyone or a role.
 * Discord markdown in that same user-influenced content is escaped so it
 * can't render as a link, heading, emphasis, quote, spoiler, etc. — the fixed
 * suffix (a site link we control) is appended after escaping and is never
 * escaped itself. The 2000-character budget is enforced on the escaped
 * length, since escaping can only grow the content.
 */
const MAX = 2000
const MARKDOWN = /[\\*_~`|>#[\]()]/g

export function createNotifier({ url, suffix = '', fetchImpl = fetch, log = console.error }) {
  return function notify(content) {
    if (!url) return
    const escaped = content.replace(MARKDOWN, '\\$&')
    const room = MAX - suffix.length
    const body = (escaped.length > room ? escaped.slice(0, room - 1) + '…' : escaped) + suffix
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body, allowed_mentions: { parse: [] } }),
    }).catch(log)
  }
}
