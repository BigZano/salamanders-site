/**
 * Display-time pruning of the parsed archive (user decision 2026-09-24).
 * The export itself is never modified; these return new ASTs.
 *
 * - dropDeadLines: removes lines/items/headings that are nothing but
 *   non-live references (plus emoji, punctuation, formatting). Sentences
 *   that merely mention one keep it, rendered as plain text.
 * - tocOnly: a table-of-contents view — only blocks holding a live link,
 *   the headings they sit under, and list labels with live links beneath.
 *
 * `classify(href)` is model.classifyHref-shaped: 'route' | 'external' are
 * live; anything else ('text', 'unaccounted') is not.
 */
import { walk } from './markdown'

const LIVE = new Set(['route', 'external'])
const CONTENT = /[\p{L}\p{N}]/u
const refOf = (n) => (n.type === 'link' || n.type === 'url' ? n.href : n.kind === 'channel' ? n.raw : null)

export function liveRefs(nodes, classify) {
  const out = []
  walk(nodes, (n) => {
    const href = refOf(n)
    // Stryker disable next-line ConditionalExpression: classify(null) is never live (classifyHref → 'text')
    if (href !== null && LIVE.has(classify(href))) out.push(href)
  })
  return out
}

// A dead reference's label is the reference, not content around it.
function scan(nodes, classify, acc) {
  for (const n of nodes) {
    const href = refOf(n)
    if (href !== null) {
      if (!LIVE.has(classify(href))) {
        acc.dead = true
        continue
      }
      acc.live = true
    }
    if (n.type === 'text' ? CONTENT.test(n.value) : n.type === 'code' || n.kind === 'user' || n.kind === 'role') acc.content = true
    if (n.children) scan(n.children, classify, acc)
  }
  return acc
}

function deadOnly(inline, classify) {
  const s = scan(inline, classify, {}) // flags start undefined (falsy)
  return s.dead && !s.live && !s.content
}

export function dropDeadLines(blocks, classify) {
  const out = []
  for (const b of blocks) {
    if (b.type === 'quote') {
      const children = dropDeadLines(b.children, classify)
      if (children.some((c) => c.type !== 'blank')) out.push({ ...b, children })
    } else if (b.type === 'list') {
      const items = []
      for (const it of b.items) {
        const [own, ...subs] = it.children
        const kept = dropDeadLines(subs, classify)
        const keepOwn = !deadOnly(own.children, classify)
        if (keepOwn || kept.length) items.push({ ...it, children: keepOwn ? [own, ...kept] : kept })
      }
      if (items.length) out.push({ ...b, items })
    } else if (!(b.children && deadOnly(b.children, classify))) {
      out.push(b)
    }
  }
  return out
}

export function tocOnly(blocks, classify) {
  const out = []
  let pending = [] // headings waiting for a live link beneath them
  const emit = (b) => {
    out.push(...pending, b)
    pending = []
  }
  const live = (nodes) => liveRefs(nodes, classify).length > 0
  for (const b of blocks) {
    if (b.type === 'heading') {
      pending = pending.filter((h) => h.level < b.level)
      if (live(b.children)) emit(b)
      else pending.push(b)
    } else if (b.type === 'quote') {
      const children = tocOnly(b.children, classify)
      if (children.length) emit({ ...b, children })
    } else if (b.type === 'list') {
      const items = []
      for (const it of b.items) {
        const [own, ...subs] = it.children
        const kept = tocOnly(subs, classify)
        if (kept.length || live(own.children)) items.push({ ...it, children: [own, ...kept] })
      }
      if (items.length) emit({ ...b, items })
    } else if (b.children && live(b.children)) {
      emit(b)
    }
  }
  return out
}
