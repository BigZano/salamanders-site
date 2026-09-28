import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import bundled from '../data/perk-corrections.json'
import { applyWeaponCorrections, applyClassCorrections, sanitizeText } from '../../server/src/perkCorrectionsCore.js'
import * as api from '../lib/perksApi'
import { detailsFor } from './planner'

// Perk corrections over the wiki bake. Starts from the snapshot bundled at
// deploy time (works offline); load() swaps in the live document. Editing
// is offered only against a live document, to someone the server calls an
// editor — the server re-checks every write regardless.
let pendingId = 0

// Mirrors the field set server/src/perks.js's validateCorrection sanitizes.
// The server is the source of truth for validation; this just keeps the
// optimistic render and the outgoing request free of control/format chars
// before either happens (spec amendment 2026-09-27 — input sanitization).
function sanitizeCorrection(c) {
  const clean = {
    kind: sanitizeText(c.kind),
    target: sanitizeText(c.target),
    quality: sanitizeText(c.quality) || null,
    op: sanitizeText(c.op),
    perkName: sanitizeText(c.perkName),
    description: sanitizeText(c.description) || null,
    note: sanitizeText(c.note) || null,
  }
  if (clean.kind === 'class') clean.quality = null
  if (clean.op === 'remove') clean.description = null
  return clean
}

function withPending(doc, c) {
  const bucket = c.kind === 'class' ? 'classes' : 'weapons'
  const entry = {
    id: `pending-${++pendingId}`,
    op: c.op,
    quality: c.quality ?? null,
    perkName: c.perkName,
    description: c.description ?? null,
    createdAt: new Date().toISOString(),
  }
  return { ...doc, [bucket]: { ...doc[bucket], [c.target]: [...(doc[bucket][c.target] || []), entry] } }
}

export const usePerkCorrections = defineStore('perkCorrections', {
  // doc is markRaw'd everywhere it's assigned: it's a wholesale-replaced,
  // never-mutated-in-place snapshot (bundled JSON, or a server response), so
  // Vue's deep reactivity on it would be pure overhead — and tests rely on
  // `doc` keeping its identity (e.g. `toBe(bundled)`) across state that
  // didn't change it. See src/stores/archive.js for the same pattern.
  state: () => ({ doc: markRaw(bundled), live: false, privileges: null }),
  getters: {
    weaponTree: (s) => (name, tree) => (tree ? applyWeaponCorrections(tree, s.doc.weapons[name] || []) : tree),
    classPerks: (s) => (className) => applyClassCorrections(detailsFor(className).perks, s.doc.classes[className] || []),
    describe() {
      return (className, perkName) => this.classPerks(className)[perkName]?.description || ''
    },
    canEdit: (s) => s.live && !!s.privileges?.editor,
  },
  actions: {
    async load() {
      try {
        this.doc = markRaw(await api.getCorrections())
        this.live = true
      } catch {
        this.live = false
      }
    },
    async loadPrivileges(token) {
      if (!token) {
        this.privileges = null
        return
      }
      try {
        this.privileges = await api.getPrivileges(token)
      } catch {
        this.privileges = null
      }
    },
    async submit(correction, token) {
      const clean = sanitizeCorrection(correction)
      const before = this.doc
      this.doc = markRaw(withPending(before, clean))
      try {
        this.doc = markRaw(await api.submitCorrection(clean, token))
      } catch (err) {
        this.doc = before
        throw err
      }
    },
    async revert(id, note, token) {
      const clean = sanitizeText(note) || null
      this.doc = markRaw(await api.revertCorrection(id, clean, token))
    },
  },
})
