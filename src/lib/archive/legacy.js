/**
 * Legacy Accolades: validation and the view model for the sealed `legacy` payload
 * (docs/superpowers/specs/2026-10-16-legacy-accolades-design.md). Pure: no I/O, no globals.
 * `auditLegacy` is what keeps a bad file out of the sealed bundle; `legacyView` is what the page renders.
 */
export const LEGACY_FILE = 'legacy-accolades.json'
export const NAME_MAX = 32 // Discord's own cap on nicknames and display names
export const ROLE_NAME_MAX = 100 // Discord's cap on role names
export const BLURB_MAX = 600

const SNOWFLAKE = /^\d{17,20}$/
const COLOR = /^#[0-9a-f]{6}$/i
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HIDDEN = /[\p{Cc}\p{Cf}]/u // control characters and invisible formatting (zero-width, bidi overrides)
const TOP_KEYS = ['snapshot', 'accolades']
const ACCOLADE_KEYS = ['roleId', 'name', 'color', 'blurb', 'holders']
const HOLDER_KEYS = ['id', 'name']

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasUnknownKey = (o, allowed) => Object.keys(o).some((k) => !allowed.includes(k))
// typeof first: a number or a one-element array would otherwise coerce into a match.
const isSnowflake = (v) => typeof v === 'string' && SNOWFLAKE.test(v)
const hasHidden = (s, allowNewlines) => [...s].some((c) => !(allowNewlines && c === '\n') && HIDDEN.test(c))
const isPlain = (s, max, { newlines = false } = {}) =>
  typeof s === 'string' && s !== '' && s === s.trim() && [...s].length <= max && !hasHidden(s, newlines)

// Date.parse rolls 2026-02-31 over to March; only a value that survives the round trip is a real date.
// No typeof guard: a non-string can never equal the string toISOString() returns.
const isInstant = (s) => INSTANT.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s

/** Problems with a legacy payload, as short descriptions that name positions and never quote data. */
export function auditLegacy(legacy) {
  if (!isObject(legacy)) return ['legacy: not an object']
  const problems = []
  const bad = (where, what) => problems.push(`${where}: ${what}`)
  if (hasUnknownKey(legacy, TOP_KEYS)) bad('legacy', 'has an unknown field')
  if (!isInstant(legacy.snapshot)) bad('legacy', 'snapshot is not a UTC instant like 2026-01-02T03:04:05.000Z')
  if (!Array.isArray(legacy.accolades) || legacy.accolades.length === 0) {
    bad('legacy', 'accolades must be a non-empty array')
    return problems
  }
  const seenRoles = new Set()
  legacy.accolades.forEach((a, i) => {
    const at = `accolade ${i + 1}`
    if (!isObject(a)) return bad(at, 'not an object')
    if (hasUnknownKey(a, ACCOLADE_KEYS)) bad(at, 'has an unknown field')
    if (!isSnowflake(a.roleId)) bad(at, 'roleId is not a snowflake')
    else if (seenRoles.has(a.roleId)) bad(at, 'roleId appears twice')
    seenRoles.add(a.roleId)
    if (!isPlain(a.name, ROLE_NAME_MAX)) bad(at, `name must be 1-${ROLE_NAME_MAX} characters of plain text`)
    if (a.color !== null && !(typeof a.color === 'string' && COLOR.test(a.color))) bad(at, 'color must be #rrggbb or null')
    if (!isPlain(a.blurb, BLURB_MAX, { newlines: true })) bad(at, `blurb must be 1-${BLURB_MAX} characters of plain text`)
    if (!Array.isArray(a.holders)) return bad(at, 'holders must be an array')
    const seenHolders = new Set()
    a.holders.forEach((h, j) => {
      const who = `${at}, holder ${j + 1}`
      if (!isObject(h)) return bad(who, 'not an object')
      if (hasUnknownKey(h, HOLDER_KEYS)) bad(who, 'has an unknown field')
      if (!isSnowflake(h.id)) bad(who, 'id is not a snowflake')
      else if (seenHolders.has(h.id)) bad(who, 'id appears twice')
      seenHolders.add(h.id)
      if (!isPlain(h.name, NAME_MAX)) bad(who, `name must be 1-${NAME_MAX} characters of plain text`)
    })
  })
  return problems
}

// Headings are large text, which needs 3:1 against the plaque's near-black inlay (luminance about 0.008).
const READABLE_LUMINANCE = 0.15
const channel = (hex, at) => (parseInt(hex.slice(at, at + 2), 16) / 255) ** 2.2

/** Relative luminance of "#rrggbb" (a plain 2.2 gamma: only used to pick readable colours). */
export const luminance = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)

/** The role colour if it shows up on the dark inlay, else null (the page then uses its normal heading colour). */
export const readableColor = (color, min = READABLE_LUMINANCE) => (color !== null && luminance(color) >= min ? color : null)

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id)
const countLabel = (n) => (n === 0 ? 'No holders on record' : n === 1 ? '1 holder' : `${n} holders`)

/** What the page shows. Input is an audited payload; it is never mutated. */
export function legacyView(legacy) {
  return {
    snapshotDate: legacy.snapshot.slice(0, 10),
    accolades: legacy.accolades.map((a) => ({
      roleId: a.roleId,
      name: a.name,
      color: readableColor(a.color),
      paragraphs: a.blurb.split(/\n{2,}/),
      countLabel: countLabel(a.holders.length),
      holders: a.holders.map((h) => ({ id: h.id, name: h.name })).sort(byName),
    })),
  }
}

/** The one on-disk format of the export file: the snapshot script writes it, `unseal` restores it. */
export const canonicalLegacy = (legacy) => JSON.stringify(legacy, null, 2) + '\n'
