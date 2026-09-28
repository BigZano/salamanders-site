/**
 * Perk corrections: in-game fixes layered over the wiki bake. Pure, no I/O.
 * The API uses it to validate and to build the public document; the site
 * imports this same file (../../server/src/…) to render, so both sides apply
 * corrections identically. See
 * docs/superpowers/specs/2026-09-27-perk-corrections-design.md.
 *
 * Every weapon perk comes back with a stable `key`: its index in the bake,
 * or `c<correction id>` for an added perk. Saved builds reference perks by
 * an id built from that key, so removing a perk mid-tier must not shift the
 * others.
 */
export const QUALITIES = ['Standard', 'Master-Crafted', 'Artificer', 'Relic', 'Heroic']
export const OPS = ['add', 'remove', 'edit']
export const LIMITS = { target: 80, perkName: 80, description: 500, note: 200 }

/** Letters, numbers, spaces and basic punctuation only — no markup, no symbols. */
export const PERK_NAME = /^[\p{L}\p{N} '’\-().,&:+%/]+$/u

const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const ZERO_WIDTH_AND_BIDI = /[\u200B-\u200D\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/g
const HORIZONTAL_WS = /[^\S\n]+/g

/**
 * The one sanitizer every user-supplied text field goes through, on both the
 * API and the site, before validation or storage (spec amendment 2026-09-27,
 * see docs/superpowers/specs/2026-09-27-perk-corrections-design.md). Order:
 * normalize line endings to \n, NFC-normalize, strip C0/C1 controls (tab and
 * newline are deferred to the whitespace step below, not stripped here),
 * strip zero-width/soft-hyphen/bidi-override characters, then collapse
 * whitespace — multiline text keeps single newlines (paragraph breaks
 * collapse to at most two, blank around each line trimmed); single-line text
 * turns newlines into a space first, so everything collapses to one line.
 * Length limits are enforced by callers, after sanitizing — never truncated
 * here.
 */
export function sanitizeText(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return ''
  let v = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC')
  v = v.replace(CONTROLS, '').replace(ZERO_WIDTH_AND_BIDI, '')
  if (multiline) {
    v = v.replace(HORIZONTAL_WS, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n')
  } else {
    v = v.replace(/\n/g, ' ').replace(HORIZONTAL_WS, ' ')
  }
  return v.trim()
}

const mark = (c) => ({ id: c.id, createdAt: c.createdAt })

/** Apply in order. An edit/remove whose perk is gone (its add was reverted) is skipped. */
export function applyWeaponCorrections(tree, corrections = []) {
  const perks = tree.perks.map((p, i) => ({ ...p, key: p.key ?? i }))
  for (const c of corrections) {
    if (c.op === 'add') {
      perks.push({ name: c.perkName, quality: c.quality, description: c.description, key: `c${c.id}`, corrected: mark(c) })
      continue
    }
    const i = perks.findIndex((p) => p.quality === c.quality && p.name === c.perkName)
    if (i < 0) continue
    if (c.op === 'remove') perks.splice(i, 1)
    else if (c.op === 'edit') perks[i] = { ...perks[i], description: c.description, corrected: mark(c) }
  }
  return { ...tree, perks }
}

/** Class perks are a fixed grid keyed by name: only their text changes. */
export function applyClassCorrections(perks, corrections = []) {
  const out = { ...perks }
  for (const c of corrections) {
    if (c.op !== 'edit' || !out[c.perkName]) continue
    out[c.perkName] = { ...out[c.perkName], description: c.description, corrected: mark(c) }
  }
  return out
}

export function hasWeaponPerk(tree, quality, name) {
  return tree.perks.some((p) => p.quality === quality && p.name === name)
}

/**
 * Public document of active corrections, grouped by kind then target. Input
 * must already be in apply order (oldest first). Authors and notes stay out:
 * they're for the history tab, behind the role check.
 */
export function toDocument(corrections, version = new Date().toISOString()) {
  const doc = { version, weapons: {}, classes: {} }
  for (const c of corrections) {
    const bucket = c.kind === 'class' ? doc.classes : doc.weapons
    const list = Object.hasOwn(bucket, c.target) ? bucket[c.target] : (bucket[c.target] = [])
    list.push({
      id: c.id,
      op: c.op,
      quality: c.quality ?? null,
      perkName: c.perkName,
      description: c.description ?? null,
      createdAt: c.createdAt,
    })
  }
  return doc
}

/** Document → plain corrections, in document order (for seeding). */
export function flattenDocument(doc) {
  const out = []
  for (const [kind, bucket] of [['weapon', doc.weapons], ['class', doc.classes]]) {
    for (const [target, list] of Object.entries(bucket || {})) {
      for (const c of list) {
        out.push({ kind, target, quality: c.quality ?? null, op: c.op, perkName: c.perkName, description: c.description ?? null })
      }
    }
  }
  return out
}
