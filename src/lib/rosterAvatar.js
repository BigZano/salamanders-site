/**
 * Avatars and initials for roster chips. Avatar URLs come from the server (it
 * builds Discord CDN links), but an <img src> is a place a bad value does harm,
 * so the client allows only https URLs on a short list of origins and shows
 * initials for anything else. Adding an origin is one line here.
 */
export const AVATAR_ORIGINS = ['https://cdn.discordapp.com']

/** The URL if it is an https URL on an allowed origin, else null. */
export function safeAvatar(url) {
  if (typeof url !== 'string' || !url) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  return parsed.protocol === 'https:' && AVATAR_ORIGINS.includes(parsed.origin) ? url : null
}

/** First letter of the first two words, uppercased (code-point aware, so an emoji counts as one). */
export function initials(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0])
    .join('')
    .toUpperCase()
}
