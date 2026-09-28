/**
 * Fire-and-forget Discord webhook. Mentions are always disabled: perk names,
 * notes and usernames are user-typed and must never ping @everyone or a role.
 */
const MAX = 2000

export function createNotifier({ url, suffix = '', fetchImpl = fetch, log = console.error }) {
  return function notify(content) {
    if (!url) return
    const room = MAX - suffix.length
    const body = (content.length > room ? content.slice(0, room - 1) + '…' : content) + suffix
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body, allowed_mentions: { parse: [] } }),
    }).catch(log)
  }
}
