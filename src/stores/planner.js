import { defineStore } from 'pinia'
import classes from '../data/classes.json'
import perkDetails from '../data/perk-details.json'

// Wiki-baked perk text, keyed by class then perk name. See scripts/fetch-wiki-perks.mjs.
export const detailsFor = (className) => perkDetails.classes[className] || { perks: {}, prestige: [] }
export const describePerk = (className, perkName) =>
  detailsFor(className).perks[perkName]?.description || ''
// A class can prestige 4 times, each rank granting one perk pick. The wiki only
// documents which perks unlock at ranks 1 and 2, so the candidate pool is
// smaller than the rank cap — that's a data gap, not a rule.
export const MAX_PRESTIGE = 4

export const CLASS_NAMES = Object.keys(classes)
// Column categories, headers, and build-slot labels — mirrors the original.
export const CATS = ['core', 'core', 'core', 'team', 'gear', 'gear', 'gear', 'signature']
export const HEADS = ['CORE', 'CORE', 'CORE', 'TEAM', 'GEAR', 'GEAR', 'GEAR', 'SIGNATURE']
export const SLOTS = ['CORE 1', 'CORE 2', 'CORE 3', 'TEAM', 'GEAR 1', 'GEAR 2', 'GEAR 3', 'SIGNATURE']

const STORAGE_KEY = 'salamanders-planner-v1'

// Column c holds perks at levels 2+c, 10+c, 18+c (one per tier).
function columnsFor(className) {
  const rows = classes[className].rows
  return Array.from({ length: 8 }, (_, c) => ({
    col: c,
    cat: CATS[c],
    head: HEADS[c],
    slot: SLOTS[c],
    perks: [0, 1, 2].map((tier) => ({
      name: rows[tier][c],
      level: 2 + c + tier * 8,
      col: c,
      tier,
      cat: CATS[c],
    })),
  }))
}

export const usePlanner = defineStore('planner', {
  state: () => ({
    activeClass: CLASS_NAMES[0],
    level: 25,
    // Prestige rank per class: { [className]: 0..MAX_PRESTIGE }
    prestige: {},
    // Chosen prestige perk per rank: { [className]: [rank1, rank2, rank3, rank4] }
    // Slots hold a perk name or null, indexed by rank - 1.
    prestigePicks: {},
    // { [className]: { [col]: perkName } }
    selectedPerks: {},
    // { [className]: { primary, secondary, melee } }
    weapons: {},
    // saved "recommended" builds (personal library, like the original)
    savedBuilds: [],
    // weapon perk-tree selections: { [weapon]: { [perkId]: true } }
    weaponPerks: {},
    // per-weapon point budgets: { [weapon]: number }
    weaponBudgets: {},
  }),

  getters: {
    meta: (s) => classes[s.activeClass],
    columns: (s) => columnsFor(s.activeClass),
    selected: (s) => s.selectedPerks[s.activeClass] || {},
    activeWeapons: (s) => s.weapons[s.activeClass] || {},
    activePrestige: (s) => s.prestige[s.activeClass] || 0,
    /** Raw rank slots, always MAX_PRESTIGE long. */
    prestigeRaw: (s) => {
      const saved = s.prestigePicks[s.activeClass] || []
      return Array.from({ length: MAX_PRESTIGE }, (_, i) => saved[i] || null)
    },
    /** Just the perks actually chosen, in rank order. */
    activePrestigePicks() {
      return this.prestigeRaw.filter(Boolean)
    },
    prestigePicksLeft() {
      return this.activePrestige - this.activePrestigePicks.length
    },
    /**
     * One slot per prestige rank. The game grants a single perk choice each time
     * you prestige, up to four times, so ranks — not the wiki's unlock column —
     * are the real structure here.
     */
    prestigeSlots() {
      const rank = this.activePrestige
      const byName = Object.fromEntries(detailsFor(this.activeClass).prestige.map((p) => [p.name, p]))
      return this.prestigeRaw.map((name, i) => ({
        rank: i + 1,
        unlocked: i + 1 <= rank,
        perk: name ? byName[name] || { name, description: '' } : null,
      }))
    },
    /** The seven candidates, flagged against what's already chosen. */
    prestigePool() {
      const picks = this.activePrestigePicks
      const full = picks.length >= this.activePrestige
      return detailsFor(this.activeClass).prestige.map((p) => ({
        ...p,
        picked: picks.includes(p.name),
        disabled: this.activePrestige === 0 || (full && !picks.includes(p.name)),
      }))
    },
    build(s) {
      const sel = s.selectedPerks[s.activeClass] || {}
      const slots = SLOTS.map((label, c) => ({ label, cat: CATS[c], name: sel[c] || null }))
      return {
        className: s.activeClass,
        level: s.level,
        slots,
        count: slots.filter((x) => x.name).length,
        weapons: s.weapons[s.activeClass] || {},
        prestige: s.prestige[s.activeClass] || 0,
        // Rank slots as stored (may contain holes) plus the flat list for display.
        prestigeSlots: [...this.prestigeRaw],
        prestigePicks: this.activePrestigePicks,
        starting: classes[s.activeClass].starting,
        ability: classes[s.activeClass].ability,
      }
    },
  },

  actions: {
    setClass(name) {
      if (classes[name]) this.activeClass = name
      this.persist()
    },
    setLevel(n) {
      this.level = Math.max(1, Math.min(25, Number(n) || 1))
      this.enforceLevel()
      this.persist()
    },
    enforceLevel() {
      const sel = this.selectedPerks[this.activeClass]
      if (!sel) return
      for (const col of Object.keys(sel)) {
        const perk = columnsFor(this.activeClass)[col].perks.find((p) => p.name === sel[col])
        if (perk && perk.level > this.level) delete sel[col]
      }
    },
    togglePerk(perk) {
      if (perk.level > this.level) return
      const cls = this.activeClass
      this.selectedPerks[cls] ??= {}
      if (this.selectedPerks[cls][perk.col] === perk.name) {
        delete this.selectedPerks[cls][perk.col]
      } else {
        this.selectedPerks[cls][perk.col] = perk.name
      }
      this.persist()
    },
    setPrestige(n) {
      const rank = Math.max(0, Math.min(MAX_PRESTIGE, Number(n) || 0))
      this.prestige[this.activeClass] = rank
      this.enforcePrestige()
      this.persist()
    },
    /** Clear any rank slot the class hasn't earned. */
    enforcePrestige() {
      const cls = this.activeClass
      const rank = this.prestige[cls] || 0
      const picks = this.prestigePicks[cls]
      if (!picks?.length) return
      this.prestigePicks[cls] = picks.map((name, i) => (i + 1 <= rank ? name : null))
    },
    /** Assign a perk to the lowest open rank, or clear it if already chosen. */
    togglePrestigePerk(name) {
      const cls = this.activeClass
      const rank = this.prestige[cls] || 0
      const slots = [...this.prestigeRaw]
      const at = slots.indexOf(name)
      if (at !== -1) {
        slots[at] = null
      } else {
        const open = slots.findIndex((s, i) => !s && i + 1 <= rank)
        if (open === -1) return
        slots[open] = name
      }
      this.prestigePicks[cls] = slots
      this.persist()
    },
    /** Clear one rank slot directly. */
    clearPrestigeSlot(rank) {
      const slots = [...this.prestigeRaw]
      slots[rank - 1] = null
      this.prestigePicks[this.activeClass] = slots
      this.persist()
    },
    setWeapon(slot, value) {
      const cls = this.activeClass
      this.weapons[cls] ??= {}
      this.weapons[cls][slot] = value
      this.persist()
    },
    resetClass() {
      delete this.selectedPerks[this.activeClass]
      delete this.weapons[this.activeClass]
      delete this.prestige[this.activeClass]
      delete this.prestigePicks[this.activeClass]
      this.persist()
    },

    // ---- saved builds library ----
    snapshotWeaponPerks() {
      const equipped = Object.values(this.weapons[this.activeClass] || {}).filter(Boolean)
      const out = {}
      for (const w of equipped) {
        if (this.weaponPerks[w]) out[w] = { ...this.weaponPerks[w] }
      }
      return out
    },
    saveBuild({ title, role, notes } = {}) {
      const b = this.build
      this.savedBuilds.unshift({
        id: Date.now(),
        title: (title || '').trim() || `${b.className} Build`,
        role: (role || '').trim(),
        notes: (notes || '').trim(),
        className: this.activeClass,
        level: this.level,
        prestige: b.prestige,
        prestigePicks: [...b.prestigeSlots],
        perks: b.slots.map((s) => s.name),
        perkIds: { ...(this.selectedPerks[this.activeClass] || {}) },
        weapons: { ...(this.weapons[this.activeClass] || {}) },
        // Snapshot the tree for each equipped weapon so applying a build later
        // restores the same weapon perks, not whatever is current.
        weaponPerks: this.snapshotWeaponPerks(),
      })
      this.persist()
    },
    applyBuild(id) {
      const r = this.savedBuilds.find((x) => x.id === id)
      if (!r) return
      this.activeClass = r.className
      this.level = r.level
      this.prestige[r.className] = r.prestige || 0
      this.prestigePicks[r.className] = [...(r.prestigePicks || [])]
      this.selectedPerks[r.className] = { ...r.perkIds }
      this.weapons[r.className] = { ...r.weapons }
      for (const [w, perks] of Object.entries(r.weaponPerks || {})) {
        this.weaponPerks[w] = { ...perks }
      }
      this.enforceLevel()
      this.persist()
    },
    deleteBuild(id) {
      this.savedBuilds = this.savedBuilds.filter((x) => x.id !== id)
      this.persist()
    },

    // ---- weapon perk trees ----
    weaponBudget(weapon, fallback = 10) {
      return this.weaponBudgets[weapon] ?? fallback
    },
    weaponUsed(weapon) {
      return Object.keys(this.weaponPerks[weapon] || {}).length
    },
    toggleWeaponPerk(weapon, perkId, budget = 10) {
      this.weaponPerks[weapon] ??= {}
      const sel = this.weaponPerks[weapon]
      if (sel[perkId]) {
        delete sel[perkId]
      } else if (Object.keys(sel).length < this.weaponBudget(weapon, budget)) {
        sel[perkId] = true
      }
      this.persist()
    },
    setWeaponBudget(weapon, n) {
      this.weaponBudgets[weapon] = Math.max(1, Math.min(40, Number(n) || 1))
      this.persist()
    },
    resetWeaponTree(weapon) {
      delete this.weaponPerks[weapon]
      this.persist()
    },

    // ---- persistence + share ----
    persist() {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            activeClass: this.activeClass,
            level: this.level,
            prestige: this.prestige,
            prestigePicks: this.prestigePicks,
            selectedPerks: this.selectedPerks,
            weapons: this.weapons,
            savedBuilds: this.savedBuilds,
            weaponPerks: this.weaponPerks,
            weaponBudgets: this.weaponBudgets,
          }),
        )
      } catch {}
    },
    hydrate() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
        if (saved) this.$patch(saved)
      } catch {}
    },
    encode() {
      const payload = {
        c: this.activeClass,
        l: this.level,
        pr: this.prestige[this.activeClass] || 0,
        pp: this.prestigeRaw,
        p: this.selectedPerks[this.activeClass] || {},
        w: this.weapons[this.activeClass] || {},
        wp: this.snapshotWeaponPerks(),
      }
      return btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    },
    applyEncoded(raw) {
      try {
        const json = JSON.parse(
          decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))),
        )
        if (!classes[json.c]) return
        this.activeClass = json.c
        this.level = json.l || 25
        this.prestige[json.c] = json.pr || 0
        this.prestigePicks[json.c] = Array.isArray(json.pp) ? json.pp : []
        this.selectedPerks[json.c] = json.p || {}
        this.weapons[json.c] = json.w || {}
        for (const [w, perks] of Object.entries(json.wp || {})) {
          this.weaponPerks[w] = { ...perks }
        }
        this.enforceLevel()
        this.enforcePrestige()
        this.persist()
      } catch {}
    },
    buildText() {
      const b = this.build
      const lines = [
        `${b.className.toUpperCase()} BUILD — LEVEL ${b.level}${b.prestige ? ` · PRESTIGE ${b.prestige}` : ''}`,
        `Primary: ${b.weapons.primary || '—'}`,
        `Secondary: ${b.weapons.secondary || '—'}`,
        `Melee: ${b.weapons.melee || '—'}`,
        ...b.slots.map((s) => `${s.label}: ${s.name || '—'}`),
        ...(b.prestigePicks.length ? [`Prestige perks: ${b.prestigePicks.join(', ')}`] : []),
      ]
      return lines.join('\n')
    },
  },
})
