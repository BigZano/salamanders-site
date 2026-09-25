/** Decrypted archive index → queryable collections. Parses the verbatim export files; never rewrites them. */
import { COLLECTIONS } from './registry'
import { buildLinkIndex, parseDiscordRef, resolveRef, isDiscordHost } from './links'

const THREAD_FILE = /^threads\/(\d{17,20})\.json$/
const RENDERED_TYPES = new Set([0, 19])

export function createArchive(index, registry = COLLECTIONS) {
  if (!index || index.format !== 1) throw new Error('unsupported archive format')
  const collections = new Map()
  for (const def of registry) {
    const src = index.collections?.[def.key]
    if (!src) throw new Error(`archive is missing collection "${def.key}"`)
    const json = (name) => JSON.parse(src.files[name])
    const threads = new Map()
    for (const [name, text] of Object.entries(src.files)) {
      const m = THREAD_FILE.exec(name)
      if (!m) continue
      const t = JSON.parse(text)
      threads.set(m[1], { thread: t.thread, messages: orderMessages(t.messages) })
    }
    if (!threads.has(src.tocThreadId)) throw new Error(`collection "${def.key}" has no table-of-contents thread`)
    collections.set(def.key, {
      ...def,
      tocThreadId: src.tocThreadId,
      forum: json('forum.json'),
      resolve: json('resolve.json'),
      assets: json('assets.json'),
      threads,
    })
  }
  return { collections, fixes: index.fixes ?? {}, linkIndex: buildLinkIndex([...collections.values()]) }
}

export function orderMessages(messages) {
  return messages
    .filter((m) => RENDERED_TYPES.has(m.type))
    .sort((a, b) => a.position - b.position || cmpSnowflake(a.id, b.id))
}
function cmpSnowflake(a, b) {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

const cdn = (id, ext) => `https://cdn.discordapp.com/emojis/${id}.${ext}`
export function emojiFile(col, id, animated) {
  const byResolve = col.resolve.emojis?.[id]?.file
  if (byResolve) return byResolve
  const order = animated ? ['gif', 'png', 'webp'] : ['png', 'webp', 'gif']
  for (const ext of order) {
    const hit = col.assets[cdn(id, ext)]?.file
    if (hit) return hit
  }
  return null
}

export function attachmentFile(col, url) {
  return col.assets[url]?.file ?? null
}

export function threadTags(col, thread) {
  const byId = new Map((col.forum.available_tags ?? []).map((t) => [t.id, t]))
  return (thread.applied_tags ?? []).map((id) => byId.get(id)).filter(Boolean)
}

export function findThread(archive, threadId) {
  for (const col of archive.collections.values()) {
    const entry = col.threads.get(threadId)
    if (entry) return { col, entry }
  }
  return null
}

export function mentionLabel(col, archive, node) {
  if (node.kind === 'role') {
    const r = col.resolve.roles?.[node.id]
    return { label: `@${r?.name ?? 'unknown-role'}`, color: r?.color ?? null }
  }
  if (node.kind === 'user') {
    const u = col.resolve.users?.[node.id]
    return { label: `@${u?.display_name ?? u?.username ?? 'unknown-user'}`, color: null }
  }
  const inSite = findThread(archive, node.id)
  const name = inSite?.entry.thread.name ?? col.resolve.channels?.[node.id]?.name ?? 'unknown-channel'
  return { label: `#${name}`, color: null }
}

export function classifyHref(href, archive) {
  const ref = parseDiscordRef(href)
  if (ref) return resolveRef(ref, archive.linkIndex, archive.fixes)
  if (isDiscordHost(href)) return { kind: 'unaccounted', reason: 'Discord link that is not a channel/message link' }
  if (/^https?:\/\/[^/\s]/i.test(href)) return { kind: 'external', href }
  return { kind: 'text' }
}
