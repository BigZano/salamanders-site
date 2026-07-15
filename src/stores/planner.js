import { defineStore } from 'pinia'
import classes from '../data/classes.json'

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
    // { [className]: { [col]: perkName } }
    selectedPerks: {},
    // { [className]: { primary, secondary, melee } }
    weapons: {},
    // saved "recommended" builds (personal library, like the original)
    savedBuilds: [],
  }),

  getters: {
    meta: (s) => classes[s.activeClass],
    columns: (s) => columnsFor(s.activeClass),
    selected: (s) => s.selectedPerks[s.activeClass] || {},
    activeWeapons: (s) => s.weapons[s.activeClass] || {},
    build(s) {
      const sel = s.selectedPerks[s.activeClass] || {}
      const slots = SLOTS.map((label, c) => ({ label, cat: CATS[c], name: sel[c] || null }))
      return {
        className: s.activeClass,
        level: s.level,
        slots,
        count: slots.filter((x) => x.name).length,
        weapons: s.weapons[s.activeClass] || {},
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
    setWeapon(slot, value) {
      const cls = this.activeClass
      this.weapons[cls] ??= {}
      this.weapons[cls][slot] = value
      this.persist()
    },
    resetClass() {
      delete this.selectedPerks[this.activeClass]
      delete this.weapons[this.activeClass]
      this.persist()
    },

    // ---- saved builds library ----
    saveBuild({ title, role, notes } = {}) {
      const b = this.build
      this.savedBuilds.unshift({
        id: Date.now(),
        title: (title || '').trim() || `${b.className} Build`,
        role: (role || '').trim(),
        notes: (notes || '').trim(),
        className: this.activeClass,
        level: this.level,
        perks: b.slots.map((s) => s.name),
        perkIds: { ...(this.selectedPerks[this.activeClass] || {}) },
        weapons: { ...(this.weapons[this.activeClass] || {}) },
      })
      this.persist()
    },
    applyBuild(id) {
      const r = this.savedBuilds.find((x) => x.id === id)
      if (!r) return
      this.activeClass = r.className
      this.level = r.level
      this.selectedPerks[r.className] = { ...r.perkIds }
      this.weapons[r.className] = { ...r.weapons }
      this.enforceLevel()
      this.persist()
    },
    deleteBuild(id) {
      this.savedBuilds = this.savedBuilds.filter((x) => x.id !== id)
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
            selectedPerks: this.selectedPerks,
            weapons: this.weapons,
            savedBuilds: this.savedBuilds,
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
        p: this.selectedPerks[this.activeClass] || {},
        w: this.weapons[this.activeClass] || {},
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
        this.selectedPerks[json.c] = json.p || {}
        this.weapons[json.c] = json.w || {}
        this.enforceLevel()
        this.persist()
      } catch {}
    },
    buildText() {
      const b = this.build
      const lines = [
        `${b.className.toUpperCase()} BUILD — LEVEL ${b.level}`,
        `Primary: ${b.weapons.primary || '—'}`,
        `Secondary: ${b.weapons.secondary || '—'}`,
        `Melee: ${b.weapons.melee || '—'}`,
        ...b.slots.map((s) => `${s.label}: ${s.name || '—'}`),
      ]
      return lines.join('\n')
    },
  },
})
