/**
 * Every Discord reference in the archive resolves in-site or renders as
 * plain text — never as a link back to Discord. Order: exact fix → direct
 * (thread in any collection, message present) → channel-level fix →
 * unaccounted (which the seal step refuses).
 */
import { GUILD_ID } from './registry'

const SNOW = '\\d{17,20}'
const URL_RE = new RegExp(
  `^<?https?://(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com/channels/(${SNOW}|@me)/(${SNOW})(?:/(${SNOW}))?/?>?$`,
)
const MENTION_RE = new RegExp(`^<#(${SNOW})>$`)
const KEY_RE = new RegExp(`^${SNOW}(?:/${SNOW})?$`)
const DISCORD_HOST = /(^|\.)(discord(app)?\.com|discord\.gg)$/i
const FIX_FIELDS = new Set(['to', 'text', 'why'])

export function parseDiscordRef(s) {
  if (typeof s !== 'string') return null
  const t = s.trim()
  const mention = MENTION_RE.exec(t)
  if (mention) return { guildId: GUILD_ID, channelId: mention[1], messageId: null }
  const m = URL_RE.exec(t)
  if (!m) return null
  return { guildId: m[1], channelId: m[2], messageId: m[3] ?? null }
}

export function isDiscordHost(href) {
  // new URL() itself trims whitespace and throws on non-URLs (incl. non-strings
  // like null, which stringify to relative junk), so no pre-cleaning here.
  try {
    return DISCORD_HOST.test(new URL(href).hostname)
  } catch {
    return false
  }
}

export function buildLinkIndex(collections) {
  const index = new Map()
  for (const c of collections) {
    for (const [threadId, entry] of c.threads) {
      if (index.has(threadId)) throw new Error(`duplicate thread ${threadId} across collections`)
      index.set(threadId, { prefix: c.prefix, messageIds: new Set(entry.messages.map((m) => m.id)) })
    }
  }
  return index
}

function direct(channelId, messageId, index) {
  const t = index.get(channelId)
  if (!t) return null
  if (messageId && messageId !== channelId && !t.messageIds.has(messageId)) return null
  const hash = messageId && messageId !== channelId ? `#m-${messageId}` : ''
  return { kind: 'route', to: { path: `${t.prefix}/${channelId}`, hash } }
}

function applyFix(fix, index) {
  if (fix.text === true) return { kind: 'text' }
  const [channelId, messageId = null] = fix.to.split('/')
  return direct(channelId, messageId, index) ?? { kind: 'unaccounted', reason: `fix target ${fix.to} does not exist` }
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

export function resolveRef(ref, index, fixes) {
  if (!ref) return { kind: 'unaccounted', reason: 'not a Discord reference' }
  if (ref.guildId !== GUILD_ID) return { kind: 'unaccounted', reason: `foreign guild ${ref.guildId}` }
  const exactKey = ref.messageId ? `${ref.channelId}/${ref.messageId}` : ref.channelId
  if (own(fixes, exactKey)) return applyFix(fixes[exactKey], index)
  const hit = direct(ref.channelId, ref.messageId, index)
  if (hit) return hit
  if (!index.has(ref.channelId) && own(fixes, ref.channelId)) return applyFix(fixes[ref.channelId], index)
  const why = index.has(ref.channelId) ? `message ${ref.messageId} no longer exists` : `channel ${ref.channelId} is outside the archive`
  return { kind: 'unaccounted', reason: why }
}

export function validateFixes(fixes, index) {
  if (!fixes || typeof fixes !== 'object' || Array.isArray(fixes)) return ['link-fixes must be a JSON object']
  const errors = []
  for (const [key, fix] of Object.entries(fixes)) {
    if (!KEY_RE.test(key)) errors.push(`${key}: key must be <channelId> or <channelId>/<messageId>`)
    if (!fix || typeof fix !== 'object') {
      errors.push(`${key}: fix must be an object`)
      continue
    }
    for (const f of Object.keys(fix)) if (!FIX_FIELDS.has(f)) errors.push(`${key}: unknown field "${f}"`)
    if (typeof fix.why !== 'string' || fix.why.trim() === '') errors.push(`${key}: every fix needs a non-empty "why"`)
    const hasTo = own(fix, 'to')
    const hasText = fix.text === true
    if (hasTo === hasText || (own(fix, 'text') && fix.text !== true)) {
      errors.push(`${key}: needs exactly one of "to" or "text": true`)
      continue
    }
    if (hasTo) {
      if (typeof fix.to !== 'string' || !KEY_RE.test(fix.to)) errors.push(`${key}: "to" target must be <threadId>[/<messageId>]`)
      else if (applyFix(fix, index).kind !== 'route') errors.push(`${key}: "to" target ${fix.to} does not exist in the archive`)
    }
  }
  return errors
}
