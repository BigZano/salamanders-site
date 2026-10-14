/**
 * Parsers for a weapon's wiki page, shared by the bake script and its tests.
 * Pure: they take a parsed document and return plain data.
 */
import { tableAfter, tableRecords, rowsOf, clean, normalizeQuality } from './wiki.mjs'

/** The "Perk List" table: quality is rowspanned across its perks. */
export function parsePerks(doc) {
  const rows = rowsOf(tableAfter(doc, 'Perk List'))
  const out = []
  let quality = ''
  for (const cells of rows) {
    const rowQuality = normalizeQuality(cells[0])
    if (rowQuality) quality = rowQuality

    let name, description
    if (rowQuality && cells.length >= 3) {
      ;[, name, description] = cells
    } else {
      name = cells[cells.length - 2]
      description = cells[cells.length - 1]
    }
    if (!name || !description || name === description || name.length > 100) continue
    out.push({ name, quality: quality || 'Unknown', description })
  }
  return out
}

/** Perk-point budget is the number of upgrade rows in the stats table. */
export function parseBudget(doc) {
  const table = tableAfter(doc, 'In-game shown stats') || tableAfter(doc, 'Versions')
  if (!table) return 10
  const rows = table
    .querySelectorAll('tr')
    .filter((tr) => tr.querySelectorAll('td').length >= 2).length
  return Math.max(1, Math.min(30, rows || 10))
}

// Ranged pages rate Firepower/Accuracy/…; melee pages rate Strength/Speed/
// Cleaving Potential and carry a text Defence column. Rather than hardcode
// either list, treat every column that isn't an identity, a figure or the
// defence type as a 0-10 gauge.
const IDENTITY = ['Quality', 'Version', 'Version Name']
const FIGURES = ['Magazine Capacity', 'Ammo Reserve']
const DEFENCE_COLUMN = /^defen[cs]e$/i

// A Map, not an object: a hostile cell like "constructor" must not hit Object.prototype.
const DEFENCE = new Map([
  ['block', 'Block'],
  ['balance', 'Balanced'], // the wiki's spelling
  ['balanced', 'Balanced'],
  ['fencing', 'Fencing'],
])

/** Melee defence type: 'Block' | 'Balanced' | 'Fencing', or null when blank or unrecognised. */
export function normalizeDefence(raw) {
  return DEFENCE.get(clean(raw).toLowerCase()) ?? null
}

/** "4+" reads as a half-step above 4 on the in-game bars. */
function ratingValue(raw) {
  const m = clean(raw).match(/^(\d+(?:\.\d+)?)\s*(\+)?/)
  if (!m) return null
  return Number(m[1]) + (m[2] ? 0.5 : 0)
}

/** Per-version stat lines from the "In-game shown stats" table. */
export function parseVersions(doc) {
  const recs = tableRecords(tableAfter(doc, 'In-game shown stats'))
  return recs
    .map((r) => {
      const name = r['Version Name'] || r.Version || ''
      if (!name) return null

      const gauges = {}
      const figures = {}
      let defence = null
      for (const [key, raw] of Object.entries(r)) {
        if (!key || !raw || IDENTITY.includes(key)) continue
        if (DEFENCE_COLUMN.test(key)) {
          defence = normalizeDefence(raw)
          continue
        }
        if (FIGURES.includes(key)) {
          figures[key] = raw
          continue
        }
        const value = ratingValue(raw)
        if (value !== null) gauges[key] = { value, raw }
      }

      const version = { quality: normalizeQuality(r.Quality) || r.Quality || '', name, gauges, figures }
      if (defence) version.defence = defence
      return version
    })
    .filter(Boolean)
}

/** Slot / category / damage type / usable classes, from the infobox. */
export function parseMeta(doc) {
  const out = {}
  for (const d of doc.querySelectorAll('.portable-infobox .pi-data, aside .pi-data')) {
    const label = clean(d.querySelector('.pi-data-label')?.text)
    const value = clean(d.querySelector('.pi-data-value')?.text)
    if (!label || !value) continue
    if (/^slot$/i.test(label)) out.slot = value
    else if (/^category$/i.test(label)) out.category = value
    // The infobox concatenates damage types with no separator, e.g.
    // "Bullet(Bolter)Explosive(Grenade)" — split them back apart.
    else if (/damage type/i.test(label)) {
      out.damageType = value
        .replace(/\)(?=[A-Z])/g, ') · ')
        .replace(/([a-z])(?=[A-Z])/g, '$1 · ')
    }
  }
  return out
}

/** Lead paragraphs, which on these pages sit above the first section heading. */
export function parseIntro(doc) {
  const out = []
  for (const p of doc.querySelectorAll('p')) {
    // Pages label the lead "Description: …"; the label isn't worth shipping.
    const t = clean(p.text).replace(/^Description:\s*/i, '')
    if (t) out.push(t)
    if (out.length >= 2) break
  }
  return out
}

/**
 * Everything the bake keeps for one weapon. A page with versions but no perk
 * table (a weapon whose perks the wiki has not published) is baked with
 * `perks: []` and `perksPending: true` rather than failing.
 */
export function buildTree(doc) {
  const perks = parsePerks(doc)
  const versions = parseVersions(doc)
  if (!perks.length && !versions.length) throw new Error('no readable perk table or versions')
  const tree = { perks, budget: parseBudget(doc), intro: parseIntro(doc), meta: parseMeta(doc), versions }
  if (!perks.length) tree.perksPending = true
  return tree
}

/**
 * Versions under --keep-perks: an existing version keeps its baked stats and
 * takes only the fresh defence type; a version new on the wiki is taken whole;
 * a version the wiki has dropped is kept. The wiki's stat edits (magazine
 * sizes, ammo reserves) are as uncorroborated as its perk edits.
 */
function holdVersions(previous, fresh) {
  const before = new Map(previous.map((v) => [v.name, v]))
  const out = fresh.map((f) => {
    const p = before.get(f.name)
    if (!p) return f
    return f.defence ? { ...p, defence: f.defence } : p
  })
  const seen = new Set(out.map((v) => v.name))
  return [...out, ...previous.filter((v) => !seen.has(v.name))]
}

/**
 * Combine the previous bake with a fresh one.
 *
 * With `keepPerks`, a weapon already in the bake keeps its perks, budget and
 * version stats (see holdVersions) and takes the fresh meta, intro, new
 * versions and defence types. A fresh tree with no perk table never wipes a
 * previous tree that has perks, with or without the flag: a perk list
 * vanishing from the wiki is a glitch far more often than a decision.
 * Weapons only in `fresh` are taken whole; weapons only in `previous` (a
 * failed fetch) are kept.
 */
export function mergeTrees(previous, fresh, { keepPerks }) {
  const out = {}
  for (const [name, f] of Object.entries(fresh)) {
    const p = previous[name]
    if (!p) {
      out[name] = f
      continue
    }
    const versions = keepPerks ? holdVersions(p.versions || [], f.versions) : f.versions
    if (p.perks?.length > 0 && (keepPerks || f.perksPending)) {
      const { perksPending, ...rest } = f
      out[name] = { ...rest, perks: p.perks, budget: p.budget, versions }
    } else {
      out[name] = { ...f, versions }
    }
  }
  for (const [name, p] of Object.entries(previous)) if (!(name in out)) out[name] = p
  return out
}
