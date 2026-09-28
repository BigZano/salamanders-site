/**
 * Sanitizes and validates a build body before createBuild stores it: the
 * user-typed text (title, role, notes, per-perk justifications) and the
 * structured picks (className, weapons, perks, prestigePicks, weaponPerks,
 * perkIds, shaped like planner.buildSnapshot in src/stores/planner.js) — the
 * input-sanitization amendment applied to builds, alongside the perk
 * corrections routes in perks.js. Pure, so index.js needs no unit tests for
 * this part of createBuild. Over-limit input is a 400 message, never
 * truncated; non-string junk is dropped. Objects are rebuilt with
 * Object.fromEntries (see sanitizeJustifications for why).
 */
import { sanitizeText, PERK_NAME } from './perkCorrectionsCore.js'

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

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const ownEntries = (o) => (isObject(o) ? Object.entries(o).filter(([k]) => Object.hasOwn(o, k)) : [])

class Invalid extends Error {}
const fail = (msg) => {
  throw new Invalid(msg)
}
/** Sanitized single-line string, or `fail` when longer than `max`. */
const line = (v, max, msg) => {
  const clean = sanitizeText(v)
  if (clean.length > max) fail(msg)
  return clean
}

/** Positional list (build slots, prestige ranks): non-strings become null so later entries keep their place. */
function slotList(input, { max, itemMax, tooMany, tooLong }) {
  if (!Array.isArray(input)) return []
  if (input.length > max) fail(tooMany)
  return input.map((v) => (typeof v === 'string' ? line(v, itemMax, tooLong) || null : null))
}

function weaponsOf(input) {
  const entries = ownEntries(input)
  if (entries.length > 6) fail('Build has too many weapons.')
  const out = []
  for (const [slot, name] of entries) {
    if (typeof name !== 'string') continue
    if (slot.length > 40) fail('A weapon slot name is too long.')
    const clean = line(name, 80, 'A weapon name is too long (80 characters max).')
    if (clean) out.push([slot, clean])
  }
  return Object.fromEntries(out)
}

function weaponPerksOf(input) {
  const entries = ownEntries(input)
  if (entries.length > 6) fail('Build has too many weapon perk trees.')
  const out = []
  for (const [weapon, picks] of entries) {
    if (!isObject(picks)) continue
    const name = line(weapon, 80, 'A weapon name is too long (80 characters max).')
    const ids = ownEntries(picks).filter(([, v]) => v === true)
    if (ids.length > 40) fail('A weapon has too many perks selected.')
    const kept = ids.map(([id]) => [line(id, 120, 'A weapon perk id is too long.'), true]).filter(([id]) => id)
    if (name) out.push([name, Object.fromEntries(kept)])
  }
  return Object.fromEntries(out)
}

function perkIdsOf(input) {
  const entries = ownEntries(input)
  if (entries.length > 40) fail('Build has too many perk picks.')
  const out = []
  for (const [key, value] of entries) {
    if (key.length > 120) fail('A perk pick is too long.')
    if (typeof value === 'string') out.push([key, line(value, 120, 'A perk pick is too long.')])
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out.push([key, value])
  }
  return Object.fromEntries(out)
}

function structuredFields(b) {
  const className = sanitizeText(b.className)
  if (!className || className.length > 40 || !PERK_NAME.test(className)) fail('Class name is not valid.')
  return {
    className,
    weapons: weaponsOf(b.weapons),
    perks: slotList(b.perks, { max: 24, itemMax: 80, tooMany: 'Build has too many perks.', tooLong: 'A perk name is too long (80 characters max).' }),
    prestigePicks: slotList(b.prestigePicks, {
      max: 4,
      itemMax: 80,
      tooMany: 'Build has too many prestige picks.',
      tooLong: 'A prestige pick is too long (80 characters max).',
    }),
    weaponPerks: weaponPerksOf(b.weaponPerks),
    perkIds: perkIdsOf(b.perkIds),
  }
}

/**
 * → { title, role, notes, justifications, className, weapons, perks,
 * prestigePicks, weaponPerks, perkIds } sanitized, or an error message string.
 */
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
  try {
    return { title, role, notes, justifications, ...structuredFields(b) }
  } catch (err) {
    if (err instanceof Invalid) return err.message
    throw err
  }
}
