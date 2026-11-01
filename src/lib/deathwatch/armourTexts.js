// The Armouring Hall's page texts (cfg.tx), which the Watch Commander edits from the page ("Edit page"): each
// uniform's introduction and each part's notes, and the Restricted Wargear. The paints and parts themselves stay in
// armour.js. Each key falls back to the text the page had before (ARMOUR_TEXTS, RW_TEXTS).
//   ah_<uniform>_lead      the introduction above the parts ([text](/deathwatch/…) links a page of the area)
//   ah_<uniform>_<part>    a part's notes, one a line ("Left: …", "(see Company Heraldry)" as before)
//   ah_companyheraldry_<section>   a note under a Company Heraldry section, one paragraph a line
//   rw_h   heading lines: title, subtitle, heading        rw_i  introduction        rw_f  footnote
//   rw_c1, rw_c2   a card: set, piece, how it is unlocked, proof (one a line)
import { UNIFORMS, itemSlug } from './armour'
import { inline } from './notables'

const WATCH_BROTHER = '[standard Watch-Brother Uniform](/deathwatch/armouringhall/standard/watchbrother)'
const NOTES = 'one note per line · “Left:”, “Right:”, “Pattern:” lead a note · “(see Company Heraldry)” links there'

const leadKey = (u) => `ah_${itemSlug(u)}_lead`
/** A part's notes key, by its uniform and its title ("ah_librarium_helm"). */
export const noteKey = (u, title) => `ah_${itemSlug(u)}_${title.toLowerCase()}`

// The introduction as the page wrote it: what the uniform builds on (a Watch Command specialist such as the Watch
// Apothecary its Specialist uniform, every other one the Watch-Brother uniform), then who may wear it.
function lead(u) {
  return `In addition to the ${u.onSpecialist ? `[Specialist Uniform](/deathwatch/armouringhall/specialist/${u.onSpecialist})` : WATCH_BROTHER}, ${u.who} may use the following colors and markings:`
}

// Company Heraldry's sections, as [slug, title, the note it had]; the page lays them out (HeraldryView.vue).
const HERALDRY = [
  ['companies', 'Battle Companies', "These colors follow the standards of each Battle-Brother's own Company and also appear in the regular uniform guidelines."],
  ['markings', 'Watch Company Markings', 'Painted Abaddon Black with a Mephiston Red stripe. Fully black markings denote Watch Company Primus.'],
  ['alternative', 'Alternative Colors', ''],
]
const heraldryKey = (slug) => `ah_companyheraldry_${slug}`

/** A uniform's texts as [key, label]: its introduction (if it has one), then each part's notes; Company Heraldry's notes. */
export function armourFields(u) {
  if (u.heraldry) return HERALDRY.map(([slug, title]) => [heraldryKey(slug), `${title}: notes (one paragraph per line)`])
  const parts = [...u.L, ...u.R]
  return [
    ...(u.who ? [[leadKey(u), `${u.name}: introduction (a link: [text](/deathwatch/…))`]] : []),
    ...parts.map((p) => [noteKey(u, p[0]), `${u.name} · ${p[0]}: notes (${NOTES})`]),
  ]
}

/** Every uniform's texts as the page had them: the defaults. */
export const ARMOUR_TEXTS = Object.fromEntries([
  ...Object.values(UNIFORMS)
    .flat()
    .filter((u) => !u.heraldry)
    .flatMap((u) => [...(u.who ? [[leadKey(u), lead(u)]] : []), ...[...u.L, ...u.R].map((p) => [noteKey(u, p[0]), p[2].join('\n')])]),
  ...HERALDRY.map(([slug, , note]) => [heraldryKey(slug), note]),
])

export const RW_TEXTS = {
  rw_h: 'Restricted / Locked Wargear\nWargear that is Restricted or completely Locked from being worn.\nNon-Active Deployment',
  rw_i: 'The following Deathwatch wargear may **not** be worn by combatants who are not currently deployed with the Watch, unless explicit authorization has been granted:',
  rw_c1: 'Mark VIII Errant Deathwatch\nL. Pauldron\nPermanently unlocked by completing **one (1) Tour of Duty**.\nProof: you retain the Discord role awarded for a completed Tour.',
  rw_c2: 'Deathwatch\nL. Gauntlet (Heroic)\nPermanently unlocked by completing **two (2) Tours of Duty**.\nProof: two (2) mentions.',
  rw_f: 'A Tour of Duty is a four-week Deathwatch Tour. **Previous Tours of Duty also count** toward the required number.',
}

// Keys the hall used before Armouring Hall 2.0, by the key that took their place: Company Heraldry's two Battle
// Companies notes became one, and the one Watch Specialist became four (the parts keep their titles). A text the
// Watch Commander stored under an old key still shows until the new key is saved, which drops the old ones
// (pageTexts.editedTexts).
const OLD_SPECIALIST = 'watchspecialist'
export const LEGACY_KEYS = Object.fromEntries([
  [heraldryKey('companies'), [heraldryKey('companies1'), heraldryKey('companies2')]],
  ...Object.values(UNIFORMS)
    .flat()
    .filter((u) => u.onSpecialist)
    .flatMap((u) => [
      [leadKey(u), [`ah_${OLD_SPECIALIST}_lead`]],
      ...[...u.L, ...u.R].map((p) => [noteKey(u, p[0]), [`ah_${OLD_SPECIALIST}_${p[0].toLowerCase()}`]]),
    ]),
])

/**
 * The old keys a save of `k` may drop: those no other new key reads. A Watch Specialist's old key feeds all four
 * specialists, so it stays until each has its own text.
 * shortcut: restoring one specialist's default shows the old text again while it stays; drop it by hand if that bites.
 */
export function replacedKeys(k) {
  const mine = Object.hasOwn(LEGACY_KEYS, k) ? LEGACY_KEYS[k] : []
  return mine.filter((o) => Object.values(LEGACY_KEYS).filter((olds) => olds.includes(o)).length === 1)
}

const stored = (tx, k) => (tx && Object.hasOwn(tx, k) && typeof tx[k] === 'string' ? tx[k] : undefined)

/** The text stored under the keys an older page used for `k`, one a line, or undefined when there is none. */
export function legacyText(tx, k) {
  const old = (Object.hasOwn(LEGACY_KEYS, k) ? LEGACY_KEYS[k] : []).map((o) => stored(tx, o)).filter((t) => t !== undefined)
  // An emptied old key stays emptied (that part hidden), but adds no blank line beside another one.
  return old.length ? old.filter((t) => t.trim()).join('\n') : undefined
}

// The stored text for a key, else what an older page stored for it, else its default. Only text counts.
const read = (tx, k, defaults) => stored(tx, k) ?? legacyText(tx, k) ?? defaults[k]
const lines = (t) => t.split('\n').map((l) => l.trim())

/** The introduction of a uniform as inline segments, [] when it has none or it is emptied. */
export const leadOf = (tx, u) => (u.who ? inline(read(tx, leadKey(u), ARMOUR_TEXTS).trim()) : [])

/** A part's notes, one a line, without the blank ones. */
export const notesOf = (tx, u, title) => lines(read(tx, noteKey(u, title), ARMOUR_TEXTS)).filter(Boolean)

/** A Company Heraldry section's note: its paragraphs, one a line, as inline segments. */
export const heraldryNotes = (tx, slug) => lines(read(tx, heraldryKey(slug), ARMOUR_TEXTS)).filter(Boolean).map(inline)

/** The Restricted Wargear: { title, sub, heading, intro, cards: [{ set, part, unlock, proof }], footnote }. */
export function restrictedWargear(tx) {
  const [title = '', sub = '', heading = ''] = lines(read(tx, 'rw_h', RW_TEXTS))
  const cards = ['rw_c1', 'rw_c2']
    .map((k) => lines(read(tx, k, RW_TEXTS)))
    .filter((c) => c.some(Boolean))
    .map(([set = '', part = '', unlock = '', proof = '']) => ({ set, part, unlock: inline(unlock), proof: inline(proof) }))
  return {
    title: inline(title),
    sub: inline(sub),
    heading: inline(heading),
    intro: inline(read(tx, 'rw_i', RW_TEXTS).trim()),
    cards,
    footnote: inline(read(tx, 'rw_f', RW_TEXTS).trim()),
  }
}
