/**
 * Table-of-contents display, on top of the authored ToC post. The export is
 * untouched; placement comes from the collection's sealed `toc` overlay
 * (see model.createArchive), and the rest is derived:
 *
 *   insertEntries — lists overlay `insert` threads right after the ToC entry
 *     that links their `after` thread, shaped like that entry.
 *   unlistedThreads — this collection's threads the ToC never reaches, for
 *     "Also in the archive", minus the ones the overlay hides (reached some
 *     other way, as they are in Discord, or deliberately left out).
 */
import { liveRefs } from '../../lib/archive/prune'
import { classifyHref } from '../../lib/archive/model'

const bySnowflake = (a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : 1)

/** [collectionKey, threadId] for every live in-site link in the nodes. */
function linkedThreads(nodes, archive) {
  const classify = (href) => classifyHref(href, archive).kind
  return liveRefs(nodes, classify).map((href) => classifyHref(href, archive).to?.path?.split('/').slice(1) ?? [])
}

/**
 * `tocNodes` is the ToC as displayed: one parsed, pruned AST per message.
 * Returns new ASTs with the overlay's inserted entries; inputs are not mutated.
 * An entry whose `after` isn't linked anywhere in the ToC goes at the end.
 */
export function insertEntries(tocNodes, col, archive) {
  const out = tocNodes.map((nodes) => [...nodes])
  for (const { after, thread } of col.toc.insert) {
    const link = { type: 'link', href: `<#${thread}>`, children: [{ type: 'text', value: col.threads.get(thread).thread.name }] }
    let placed = false
    for (const nodes of out) {
      const i = nodes.findIndex((n) => linkedThreads([n], archive).some(([, id]) => id === after))
      if (i < 0) continue
      const anchor = nodes[i]
      nodes.splice(i + 1, 0, anchor.type === 'heading' ? { type: 'heading', level: anchor.level, children: [link] } : { type: 'line', children: [link] })
      placed = true
      break
    }
    if (!placed) out.at(-1).push({ type: 'line', children: [link] })
  }
  return out
}

/** Threads for "Also in the archive" under this collection's ToC: [{ id, name }], oldest first. */
export function unlistedThreads(col, archive, tocNodes) {
  const linked = new Set(tocNodes.flatMap((nodes) => linkedThreads(nodes, archive)).filter(([key]) => key === col.key).map(([, id]) => id))
  return [...col.threads]
    .filter(([id]) => id !== col.tocThreadId && !linked.has(id) && !col.toc.hide.includes(id))
    .map(([id, e]) => ({ id, name: e.thread.name }))
    .sort(bySnowflake)
}
