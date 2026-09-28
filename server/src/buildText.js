/**
 * Sanitizes and validates a build's user-typed text fields (title, role,
 * notes, per-perk justifications) — the input-sanitization amendment applied
 * to builds, alongside the perk corrections routes in perks.js. Pure, so
 * index.js needs no unit tests for this part of createBuild.
 */
import { sanitizeText } from './perkCorrectionsCore.js'

const JUSTIFICATION_LIMIT = 1000

/**
 * `justifications` is a client-supplied object keyed by perk id. Only its own
 * string-valued entries survive — anything else (a non-object, an inherited
 * or prototype-polluting key, a non-string value) is dropped rather than
 * trusted. Entries are rebuilt with Object.fromEntries, never a bracket
 * assignment onto a plain object literal, so a key literally named
 * "__proto__" (e.g. from JSON.parse('{"__proto__":...}'), which JSON.parse
 * hands back as an ordinary own property, not the object's prototype) can
 * never reach an assignment that would trigger Object.prototype's __proto__
 * setter. → sanitized object, or an error message string if one entry is
 * over the limit.
 */
function sanitizeJustifications(input) {
  if (!input || typeof input !== 'object') return {}
  const entries = []
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(input, key) || typeof value !== 'string') continue
    const clean = sanitizeText(value, { multiline: true })
    if (!clean) continue
    if (clean.length > JUSTIFICATION_LIMIT) return `A perk justification is too long (${JUSTIFICATION_LIMIT} characters max).`
    entries.push([key, clean])
  }
  return Object.fromEntries(entries)
}

/** → { title, role, notes, justifications } sanitized, or an error message string. */
export function validateBuildText(b) {
  const title = sanitizeText(b.title)
  const role = sanitizeText(b.role)
  const notes = sanitizeText(b.notes, { multiline: true })
  if (title.length > 200) return 'Title is too long (200 characters max).'
  if (role.length > 200) return 'Role is too long (200 characters max).'
  if (notes.length > 2000) return 'Notes are too long (2000 characters max).'
  if (!title) return 'Give the build a title.'
  const justifications = sanitizeJustifications(b.justifications)
  if (typeof justifications === 'string') return justifications
  return { title, role, notes, justifications }
}
