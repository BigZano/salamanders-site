import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as L from './rosterLadder.js'

const SNOWFLAKE = /^\d{17,20}$/
const SPEC = readFileSync(new URL('../../docs/superpowers/specs/2026-10-13-roster-design.md', import.meta.url), 'utf8')

// Every role id the roster reads, with what it means.
function meanings() {
  const out = []
  const add = (id, what) => out.push([id, what])
  for (const r of L.HIGH_COMMAND) add(r.id, `high-command:${r.key}`)
  add(L.CAPTAIN.id, 'captain')
  add(L.VENERABLE_DREADNOUGHT.id, 'venerable-dreadnought')
  for (const r of L.DREADNOUGHTS) add(r.id, `dreadnought:${r.key}`)
  for (const s of L.SPECIALTIES) {
    add(s.head.id, `head:${s.key}`)
    for (const r of s.ranks) {
      add(r.id, `${s.key}:${r.key}`)
      for (const v of r.variants ?? []) add(v.id, `variant:${r.key}`)
    }
  }
  for (const r of L.COMPANY_RANKS) {
    add(r.id, `rank:${r.key}`)
    for (const v of r.variants ?? []) add(v.id, `variant:${r.key}`)
  }
  for (const c of L.COMPANIES) {
    add(c.roleId, `company:${c.number}`)
    c.commandRoleIds.forEach((id, i) => add(id, `command:${c.number}:${i}`))
  }
  add(L.LEGION_ROLE, 'legion')
  add(L.INFIRMARY_ROLE, 'infirmary')
  add(L.VOICE_OF_VULKAN_ROLE, 'voice-of-vulkan')
  add(L.SERVO_SKULLS_ROLE, 'servo-skulls')
  add(L.LEGION_HIERARCHY_ROLE, 'legion-hierarchy')
  return out
}

describe('role ids', () => {
  it('are all snowflakes', () => {
    for (const [id, what] of meanings()) expect(id, what).toMatch(SNOWFLAKE)
  })

  it('never serve two meanings', () => {
    const seen = new Map()
    for (const [id, what] of meanings()) {
      expect(seen.get(id), `${what} reuses the id of ${seen.get(id)}`).toBeUndefined()
      seen.set(id, what)
    }
  })

  it('are exactly the ids in the spec table (guards typos in either)', () => {
    const inSpec = [...new Set(SPEC.match(/\b\d{17,20}\b/g))].sort()
    const inCode = meanings().map(([id]) => id).sort()
    expect(inCode).toEqual(inSpec)
  })
})

describe('ranks', () => {
  const lists = {
    highCommand: L.HIGH_COMMAND,
    dreadnoughts: L.DREADNOUGHTS,
    companyRanks: L.COMPANY_RANKS,
    ...Object.fromEntries(L.SPECIALTIES.map((s) => [s.key, s.ranks])),
  }

  it.each(Object.entries(lists))('%s: keys are unique and tiers start at 1 and step by at most 1', (_, list) => {
    expect(new Set(list.map((r) => r.key)).size).toBe(list.length)
    let prev = 0
    for (const r of list) {
      expect(r.tier).toBeGreaterThanOrEqual(prev)
      expect(r.tier - prev).toBeLessThanOrEqual(1)
      prev = r.tier
    }
    expect(list[0].tier).toBe(1)
  })

  it('puts Company Ancient and Company Champion on one tier and nothing else shares a company tier', () => {
    const tiers = L.COMPANY_RANKS.map((r) => r.tier)
    const byKey = Object.fromEntries(L.COMPANY_RANKS.map((r) => [r.key, r.tier]))
    expect(byKey['company-ancient']).toBe(byKey['company-champion'])
    expect(tiers.length - new Set(tiers).size).toBe(1)
  })

  it('orders the company waterfall as the spec does, Terminator lateral', () => {
    expect(L.COMPANY_RANKS.map((r) => r.key)).toEqual([
      'lieutenant', 'company-ancient', 'company-champion', 'veteran-sergeant', 'sergeant',
      'terminator', 'company-veteran', 'battle-brother', 'scout',
    ])
    expect(L.COMPANY_RANKS.filter((r) => r.lateral).map((r) => r.key)).toEqual(['terminator'])
  })

  it('orders each specialty as the spec does', () => {
    expect(Object.fromEntries(L.SPECIALTIES.map((s) => [s.key, [s.head.key, ...s.ranks.map((r) => r.key)]]))).toEqual({
      forge: ['master-of-the-forge', 'mechadendrite-expert', 'techmarine', 'tech-adept'],
      librarius: ['chief-librarian', 'epistolary', 'codicier', 'lexicanium'],
      apothecarion: ['chief-apothecary', 'apothecary-biologis', 'apothecary', 'helix-adept'],
      reclusiam: ['reclusiarch-chaplain', 'company-chaplain', 'igniax-chaplain'],
    })
    expect(L.SPECIALTIES.map((s) => s.headFirst)).toEqual([true, true, true, false])
  })

  it('labels the Master of Sanctity role "Lord Chaplain"', () => {
    expect(L.HIGH_COMMAND.map((r) => r.label)).toEqual([
      'Lord of Drakes', 'Lord Protector of the 7 Realms', 'Pyre Guard', 'Chapter Master', 'Lord Chaplain',
    ])
  })

  it('maps each rank variant to its company: Firedrake is 1st, Scout Sergeant is 7th', () => {
    const variants = [...L.SPECIALTIES.flatMap((s) => s.ranks), ...L.COMPANY_RANKS]
      .flatMap((r) => (r.variants ?? []).map((v) => [r.key, v.company]))
    expect(variants).toEqual([
      ['company-chaplain', 1], ['sergeant', 1], ['sergeant', 7], ['company-veteran', 1],
    ])
  })

  it('NO_RANK sorts after every company rank', () => {
    expect(L.NO_RANK.tier).toBe(Math.max(...L.COMPANY_RANKS.map((r) => r.tier)) + 1)
    expect(L.NO_RANK.id).toBeUndefined()
  })
})

describe('branches', () => {
  it('run companies 1-7, Venerable Dreadnoughts, then the specialties', () => {
    expect(L.BRANCHES.map((b) => b.key)).toEqual([
      'company-1', 'company-2', 'company-3', 'company-4', 'company-5', 'company-6', 'company-7',
      'venerable-dreadnoughts', 'forge', 'librarius', 'apothecarion', 'reclusiam',
    ])
    expect(L.BRANCHES.map((b) => b.kind)).toEqual([...Array(7).fill('company'), 'dreadnoughts', ...Array(4).fill('specialty')])
    expect(L.COMPANIES.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('give companies the Captain as head and the No-rank row last; give the 5th and 6th two Command roles', () => {
    const c5 = L.BRANCHES[4]
    expect(c5.head).toBe(L.CAPTAIN)
    expect(c5.ranks.at(-1)).toBe(L.NO_RANK)
    expect(L.COMPANIES.map((c) => c.commandRoleIds.length)).toEqual([1, 1, 1, 1, 2, 2, 1])
  })
})

describe('derived sets', () => {
  it('ALL_RANKS follows the placement-rule order', () => {
    const keys = L.ALL_RANKS.map((r) => r.key)
    expect(keys.slice(0, 5)).toEqual(['lord-of-drakes', 'lord-protector', 'pyre-guard', 'chapter-master', 'lord-chaplain'])
    expect(keys.indexOf('master-of-the-forge')).toBeLessThan(keys.indexOf('captain'))
    expect(keys.indexOf('captain')).toBeLessThan(keys.indexOf('venerable-dreadnought'))
    expect(keys.indexOf('venerable-dreadnought')).toBeLessThan(keys.indexOf('dreadnought'))
    expect(keys.indexOf('dreadnought')).toBeLessThan(keys.indexOf('reclusiarch-chaplain'))
    expect(keys.indexOf('reclusiarch-chaplain')).toBeLessThan(keys.indexOf('techmarine'))
    expect(keys.indexOf('techmarine')).toBeLessThan(keys.indexOf('lieutenant'))
    expect(keys.at(-1)).toBe('scout')
  })

  it('PLACING_ROLES holds every rank, variant and company role, and nothing else', () => {
    expect(L.PLACING_ROLES.has(L.CAPTAIN.id)).toBe(true)
    expect(L.PLACING_ROLES.has(L.COMPANY_RANKS[4].variants[0].id)).toBe(true)
    expect(L.PLACING_ROLES.has(L.COMPANIES[2].roleId)).toBe(true)
    for (const id of [L.LEGION_ROLE, L.INFIRMARY_ROLE, L.SERVO_SKULLS_ROLE, L.VOICE_OF_VULKAN_ROLE, L.LEGION_HIERARCHY_ROLE, L.COMPANIES[0].commandRoleIds[0]]) {
      expect(L.PLACING_ROLES.has(id), id).toBe(false)
    }
  })

  it('COMMAND_TIER_ROLES is High Command, Captain, the four heads, Legion Hierarchy and every Command role', () => {
    const expected = [
      ...L.HIGH_COMMAND.map((r) => r.id), L.CAPTAIN.id, ...L.SPECIALTIES.map((s) => s.head.id),
      L.LEGION_HIERARCHY_ROLE, ...L.COMPANIES.flatMap((c) => c.commandRoleIds),
    ]
    expect([...L.COMMAND_TIER_ROLES].sort()).toEqual([...expected].sort())
    expect(L.COMMAND_TIER_ROLES.size).toBe(5 + 1 + 4 + 1 + 9)
    for (const id of [L.VENERABLE_DREADNOUGHT.id, L.LEGION_ROLE, L.INFIRMARY_ROLE]) expect(L.COMMAND_TIER_ROLES.has(id)).toBe(false)
  })
})
