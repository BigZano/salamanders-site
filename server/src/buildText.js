/**
 * Sanitizes and validates a build's user-typed text fields (title, role,
 * notes) — the input-sanitization amendment applied to builds, alongside the
 * perk corrections routes in perks.js. Pure, so index.js needs no unit tests
 * for this part of createBuild.
 */
import { sanitizeText } from './perkCorrectionsCore.js'

/** → { title, role, notes } sanitized, or an error message string. */
export function validateBuildText(b) {
  const title = sanitizeText(b.title)
  const role = sanitizeText(b.role)
  const notes = sanitizeText(b.notes, { multiline: true })
  if (title.length > 200) return 'Title is too long (200 characters max).'
  if (role.length > 200) return 'Role is too long (200 characters max).'
  if (notes.length > 2000) return 'Notes are too long (2000 characters max).'
  if (!title) return 'Give the build a title.'
  return { title, role, notes }
}
