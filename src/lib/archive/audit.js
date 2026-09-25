/** Whole-archive validation. The seal step refuses to publish while any problem remains. */
import { parse, walk } from './markdown'
import { validateFixes } from './links'
import { classifyHref, emojiFile, attachmentFile } from './model'

export function auditArchive(archive) {
  const problems = validateFixes(archive.fixes, archive.linkIndex).map((detail) => ({
    collectionKey: null, threadId: null, messageId: null, kind: 'bad-fix', detail,
  }))
  const stats = { links: 0, route: 0, text: 0, external: 0 }
  for (const col of archive.collections.values()) {
    for (const [threadId, { messages }] of col.threads) {
      for (const m of messages) {
        const at = (kind, detail) => problems.push({ collectionKey: col.key, threadId, messageId: m.id, kind, detail })
        // Only mention nodes carry `kind`.
        if (typeof m.content === 'string') walk(parse(m.content), (n) => {
          const href = n.type === 'link' || n.type === 'url' ? n.href : n.kind === 'channel' ? n.raw : null
          if (href !== null) {
            const r = classifyHref(href, archive)
            stats.links++
            if (r.kind === 'unaccounted') at('unaccounted-link', `${href} — ${r.reason}`)
            else stats[r.kind]++
          }
          if (n.type === 'emoji' && !emojiFile(col, n.id, n.animated)) at('unknown-emoji', n.raw)
          if (n.kind === 'role' && !col.resolve.roles?.[n.id]) at('unknown-role', n.raw)
          if (n.kind === 'user' && !col.resolve.users?.[n.id]) at('unknown-user', n.raw)
        })
        for (const a of m.attachments ?? []) if (!attachmentFile(col, a.url)) at('missing-attachment', a.url)
      }
    }
  }
  return { problems, stats }
}
