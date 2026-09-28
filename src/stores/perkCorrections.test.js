// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import baked from '../data/weapon-trees.json'
import bundled from '../data/perk-corrections.json'

vi.mock('../lib/perksApi', () => ({
  getCorrections: vi.fn(),
  getPrivileges: vi.fn(),
  submitCorrection: vi.fn(),
  revertCorrection: vi.fn(),
}))
import * as api from '../lib/perksApi'
import { usePerkCorrections } from './perkCorrections'

const names = (tree, q) => tree.perks.filter((p) => p.quality === q).map((p) => p.name)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})

describe('perk corrections store', () => {
  it('renders the bundled snapshot before (or without) the API', () => {
    const s = usePerkCorrections()
    const occ = s.weaponTree('Occulus Bolt Carbine', baked.weapons['Occulus Bolt Carbine'])
    expect(names(occ, 'Standard')).toEqual(['Great Might', 'Remote Threat'])
    expect(names(occ, 'Relic')).not.toContain('Tyranid Eliminator')
    expect(s.canEdit).toBe(false)
  })

  // A removal the bake no longer has means the wiki caught up: drop that correction.
  it('every bundled removal still names a perk in the bake', () => {
    for (const [weapon, list] of Object.entries(bundled.weapons)) {
      expect(baked.weapons[weapon], weapon).toBeTruthy()
      for (const c of list.filter((c) => c.op === 'remove')) {
        const inBake = baked.weapons[weapon].perks.some((p) => p.quality === c.quality && p.name === c.perkName)
        expect(inBake, `${weapon} / ${c.quality} / ${c.perkName}`).toBe(true)
      }
    }
  })

  it('an API failure keeps the snapshot and disables editing', async () => {
    api.getCorrections.mockRejectedValue(new Error('down'))
    api.getPrivileges.mockResolvedValue({ editor: true })
    const s = usePerkCorrections()
    await s.load()
    await s.loadPrivileges('tok')
    expect(s.live).toBe(false)
    expect(s.canEdit).toBe(false)
    expect(s.doc).toBe(bundled)
  })

  it('editing needs a live document and editor privileges', async () => {
    api.getCorrections.mockResolvedValue({ version: 'v', weapons: {}, classes: {} })
    api.getPrivileges.mockResolvedValue({ editor: true })
    const s = usePerkCorrections()
    await s.load()
    await s.loadPrivileges('tok')
    expect(s.canEdit).toBe(true)
  })

  it('submit shows the change immediately, then adopts the server document', async () => {
    let resolve
    api.submitCorrection.mockReturnValue(new Promise((r) => (resolve = r)))
    const s = usePerkCorrections()
    const c = { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'add', perkName: 'Zeal', description: 'z' }
    const pending = s.submit(c, 'tok')
    expect(names(s.weaponTree('Las Fusil', baked.weapons['Las Fusil']), 'Relic')).toContain('Zeal')
    const server = { version: 'v2', weapons: { 'Las Fusil': [{ id: 99, op: 'add', quality: 'Relic', perkName: 'Zeal', description: 'z', createdAt: 't' }] }, classes: {} }
    resolve(server)
    await pending
    expect(s.doc).toBe(server)
  })

  it('a refused submit rolls back and rethrows', async () => {
    api.submitCorrection.mockRejectedValue(Object.assign(new Error('Your site privileges have been revoked.'), { status: 403 }))
    const s = usePerkCorrections()
    const before = s.doc
    await expect(s.submit({ kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'add', perkName: 'Zeal', description: 'z' }, 'tok')).rejects.toThrow(/revoked/)
    expect(s.doc).toBe(before)
  })

  it('class corrections change the planner description', async () => {
    const s = usePerkCorrections()
    const perk = Object.keys(s.classPerks('Tactical'))[0]
    api.submitCorrection.mockImplementation(async () => ({ version: 'v', weapons: {}, classes: { Tactical: [{ id: 1, op: 'edit', quality: null, perkName: perk, description: 'fixed', createdAt: 't' }] } }))
    await s.submit({ kind: 'class', target: 'Tactical', op: 'edit', perkName: perk, description: 'fixed' }, 'tok')
    expect(s.describe('Tactical', perk)).toBe('fixed')
    expect(s.classPerks('Tactical')[perk].corrected).toEqual({ id: 1, createdAt: 't' })
  })

  // Controller ruling (b): sanitize before the optimistic update and before sending.
  it('sanitizes text before the optimistic update and before sending', async () => {
    let resolve
    api.submitCorrection.mockReturnValue(new Promise((r) => (resolve = r)))
    const s = usePerkCorrections()
    const c = {
      kind: 'weapon',
      target: 'Las Fusil',
      quality: 'Relic',
      op: 'add',
      perkName: 'Zeal​  Strike',
      description: 'z',
    }
    const pending = s.submit(c, 'tok')
    expect(names(s.weaponTree('Las Fusil', baked.weapons['Las Fusil']), 'Relic')).toContain('Zeal Strike')
    expect(api.submitCorrection).toHaveBeenCalledWith(expect.objectContaining({ perkName: 'Zeal Strike' }), 'tok')
    resolve({ version: 'v2', weapons: {}, classes: {} })
    await pending
  })
})
