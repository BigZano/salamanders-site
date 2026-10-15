/**
 * Carry a saved build across a game patch that changed a class's perk grid.
 *
 * Saved builds store perk names by column, so a perk that Patch 15.0 moved or
 * replaced would otherwise sit in the wrong slot with the wrong rationale. The
 * rules live in src/data/perk-migrations.json. A pick is matched on (column,
 * old name), never on name alone, because names moved between slots: Vital Data
 * left level 6 for level 8, and a pick of Vital Data in its new column is fine.
 *
 *   replaced  the slot now holds a different perk: drop the pick and its rationale
 *   reworked  same name, new effect: keep the pick and flag it, because the
 *             rationale may no longer fit. Needs the build's creation date, so
 *             only builds that carry one (the gallery) can be flagged.
 */
import migrations from '../data/perk-migrations.json'

/** @typedef {{ kind: 'replaced'|'reworked', className: string, level: number|null, was: string, now: string, note?: string }} Notice */

const PATCH_DATE = Date.parse(migrations.date)

const columnOf = (level) => (level - 2) % 8

/** True when the build was saved before the patch. Missing or unreadable dates are not "old". */
const madeBeforePatch = (createdAt) => {
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN
  return Number.isFinite(t) && t < PATCH_DATE
}

const notice = (entry, level, className) => ({
  kind: entry.action,
  className,
  level,
  was: entry.was,
  now: entry.now,
  ...(entry.note ? { note: entry.note } : {}),
})

/**
 * @param {{ className: string, selectedPerks?: Record<number, string>|null, justifications?: Record<number, string>|null, prestigePicks?: (string|null)[]|null, createdAt?: string|null }} input
 * @returns {{ selectedPerks: object, justifications: object, prestigePicks: any, notices: Notice[] }}
 */
export function migrateSelection({ className, selectedPerks, justifications, prestigePicks, createdAt }) {
  // hasOwn: a class name like "constructor" must not resolve to Object.prototype.
  const rules = Object.hasOwn(migrations.classes, className) ? migrations.classes[className] : undefined
  const picks = { ...selectedPerks }
  const why = { ...justifications }
  let prestige = prestigePicks
  const notices = []

  if (rules) {
    for (const slot of rules.slots) {
      const col = columnOf(slot.level)
      if (picks[col] !== slot.was) continue
      if (slot.action === 'replaced') {
        delete picks[col]
        delete why[col]
        notices.push(notice(slot, slot.level, className))
      } else if (slot.action === 'reworked' && madeBeforePatch(createdAt)) {
        notices.push(notice(slot, slot.level, className))
      }
    }

    if (Array.isArray(prestige)) {
      prestige = [...prestige]
      for (const p of rules.prestige) {
        if (p.action !== 'replaced') continue
        prestige.forEach((name, i) => {
          if (name !== p.was) return
          prestige[i] = null
          notices.push(notice(p, null, className))
        })
      }
    }
  }

  return { selectedPerks: picks, justifications: why, prestigePicks: prestige, notices }
}

/**
 * Whether a gallery build needs review after the patch. `perks` is the build's
 * perk list indexed by column; every field except `className` may be missing.
 * @param {{ className: string, perks?: (string|null)[]|null, prestigePicks?: (string|null)[]|null, createdAt?: string|null }} build
 */
export function isStaleBuild(build) {
  const selectedPerks = {}
  if (Array.isArray(build.perks)) {
    build.perks.forEach((name, col) => {
      if (name) selectedPerks[col] = name
    })
  }
  return (
    migrateSelection({
      className: build.className,
      selectedPerks,
      prestigePicks: build.prestigePicks,
      createdAt: build.createdAt,
    }).notices.length > 0
  )
}
