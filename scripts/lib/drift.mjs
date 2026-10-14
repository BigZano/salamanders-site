/**
 * Compare two keyed lists of text (perk name -> description, say) and sort what
 * changed into numeric and wording edits. A numeric edit is a balance change
 * (a percentage, a duration); a wording edit is a rephrase. The bake scripts
 * use this to report wiki changes they are holding back.
 */
const NUMBERS = /\d+(?:\.\d+)?/g

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const numbersOf = (s) => (squash(s).match(NUMBERS) || []).join('|')

/**
 * @param {{ key: string, text: string }[]} oldItems
 * @param {{ key: string, text: string }[]} newItems
 * @returns {{ added: string[], removed: string[], changed: { key: string, old: string, new: string, kind: 'numeric'|'wording' }[] }}
 */
export function listDrift(oldItems, newItems) {
  const before = new Map(oldItems.map((i) => [i.key, squash(i.text)]))
  const after = new Map(newItems.map((i) => [i.key, squash(i.text)]))

  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = []
  for (const [key, was] of before) {
    if (!after.has(key)) continue
    const now = after.get(key)
    if (was === now) continue
    changed.push({ key, old: was, new: now, kind: numbersOf(was) === numbersOf(now) ? 'wording' : 'numeric' })
  }
  return { added, removed, changed }
}
