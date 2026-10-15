/**
 * The patch-overrides layer for the class perk bake.
 *
 * The wiki is the structural baseline, but it lags the official patch notes and
 * sometimes errs. src/data/patch-overrides.json records every place we know
 * better, with its sources, and the bake applies it after parsing the wiki. Each
 * entry also tells us when it has gone stale: the bake warns when the wiki has
 * caught up, so the entry can be deleted.
 *
 * Everything here is pure; the bake script does the I/O.
 */

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const same = (a, b) => squash(a) === squash(b)

/**
 * A class grid is three rows of eight, perk levels 2 to 25. Level L sits at
 * rows[floor((L-2)/8)][(L-2) % 8].
 * @param {{ level: number|null, name: string }[]} perkList
 * @returns {string[][]}
 */
export function deriveRows(perkList) {
  const rows = [[], [], []]
  const seen = new Set()
  for (const { level, name } of perkList) {
    if (!Number.isInteger(level) || level < 2 || level > 25) throw new Error(`level out of range: ${level}`)
    if (seen.has(level)) throw new Error(`duplicate level: ${level}`)
    seen.add(level)
    rows[Math.floor((level - 2) / 8)][(level - 2) % 8] = name
  }
  for (let level = 2; level <= 25; level++) if (!seen.has(level)) throw new Error(`missing level: ${level}`)
  return rows
}

/**
 * Apply one class's overrides to its parsed wiki data. Grid entries replace the
 * perk at a level, prestige entries replace a named prestige perk in place, pins
 * keep a previous description against a wiki edit the patch notes do not back,
 * and `starting` supplies the class's starting-perk text.
 *
 * @param {string} className
 * @param {{ perkList: {level:number|null,name:string,description:string}[], prestige: {level:number|null,name:string,description:string}[] }} state
 * @param {object} overrides the parsed patch-overrides.json
 * @returns {{ perkList: object[], prestige: object[], starting: string|null, warnings: string[] }}
 */
export function applyOverrides(className, { perkList, prestige }, overrides) {
  const list = perkList.map((p) => ({ ...p }))
  const pres = prestige.map((p) => ({ ...p }))
  const o = overrides?.classes?.[className]
  const warnings = []
  if (!o) return { perkList: list, prestige: pres, starting: null, warnings }

  for (const e of o.grid ?? []) {
    const at = list.findIndex((p) => p.level === e.level)
    if (at < 0) {
      list.push({ level: e.level, name: e.name, description: e.description })
      warnings.push(`${className}: no wiki perk at level ${e.level}, added ${e.name} from overrides`)
      continue
    }
    if (list[at].name === e.name) {
      warnings.push(`${className}: stale override, the wiki already has ${e.name} at level ${e.level}; delete the entry`)
    }
    list[at] = { ...list[at], name: e.name, description: e.description }
  }

  for (const e of o.prestige ?? []) {
    const at = pres.findIndex((p) => p.name === e.replaces)
    if (at >= 0) {
      pres[at] = { ...pres[at], name: e.name, description: e.description }
    } else if (pres.some((p) => p.name === e.name)) {
      warnings.push(`${className}: stale override, the wiki prestige list already has ${e.name}; delete the entry`)
    } else {
      warnings.push(`${className}: prestige override target not found: ${e.replaces}`)
    }
  }

  for (const pin of o.pins ?? []) {
    const target = list.find((p) => p.name === pin.name) ?? pres.find((p) => p.name === pin.name)
    if (!target) {
      warnings.push(`${className}: pin target not found: ${pin.name}`)
      continue
    }
    if (same(target.description, pin.description)) {
      warnings.push(`${className}: redundant pin on ${pin.name}, the wiki text now equals it; delete the entry`)
    } else if (!same(target.description, pin.wikiSaid)) {
      warnings.push(
        `${className}: re-evaluate pin on ${pin.name}, the wiki text changed again (was "${squash(pin.wikiSaid)}", now "${squash(target.description)}")`,
      )
    }
    target.description = pin.description
  }

  return { perkList: list, prestige: pres, starting: o.starting?.text ?? null, warnings }
}

/**
 * Adopt the fresh bake for the named classes only; every other class keeps its
 * previous entry (the same object), or the fresh one when it has no previous.
 * A previous-only class is kept.
 */
export function holdClasses(previous, fresh, adopt) {
  const out = {}
  for (const [name, f] of Object.entries(fresh)) {
    out[name] = adopt.includes(name) || !(name in previous) ? f : previous[name]
  }
  for (const [name, p] of Object.entries(previous)) if (!(name in out)) out[name] = p
  return out
}
