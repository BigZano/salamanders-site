// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useArchive } from './archive'
import { useAuth } from './auth'
import { ArchiveAccessError } from '../lib/archive/client'
import { makeIndex } from '../lib/archive/testIndex'

beforeEach(() => setActivePinia(createPinia()))

const ok = () => async () => ({ keys: { fake: true }, index: makeIndex() })
const fail = (state) => async () => { throw new ArchiveAccessError(state) }

describe('useArchive', () => {
  it('load → ready with a parsed archive', async () => {
    const s = useArchive()
    await s.load('tok', { loadArchive: ok() })
    expect(s.status).toBe('ready')
    expect(s.archive.collections.get('ranks')).toBeTruthy()
  })
  it.each(['signed-out', 'restricted', 'unavailable', 'outdated', 'integrity', 'unpublished'])('access error %s → error state', async (st) => {
    const s = useArchive()
    await s.load('tok', { loadArchive: fail(st) })
    expect(s.status).toBe('error')
    expect(s.error).toBe(st)
    expect(s.archive).toBeNull()
  })
  it('a malformed index → integrity (never partial content)', async () => {
    const s = useArchive()
    await s.load('tok', { loadArchive: async () => ({ keys: {}, index: { format: 1, collections: {} } }) })
    expect([s.status, s.error, s.archive]).toEqual(['error', 'integrity', null])
  })
  it('concurrent loads share one request', async () => {
    const s = useArchive()
    let calls = 0
    const slow = async () => (calls++, await new Promise((r) => setTimeout(r, 10)), { keys: {}, index: makeIndex() })
    await Promise.all([s.load('t', { loadArchive: slow }), s.load('t', { loadArchive: slow })])
    expect(calls).toBe(1)
  })
  it('assetUrl caches per file and reset revokes every blob URL synchronously and clears content', async () => {
    const revoked = []
    let n = 0
    URL.createObjectURL = () => `blob:${++n}`
    URL.revokeObjectURL = (u) => revoked.push(u)
    const s = useArchive()
    await s.load('tok', { loadArchive: ok() })
    const blob = async () => new Blob(['x'], { type: 'image/png' })
    const a = await s.assetUrl('accolades', 'emoji-fixture.png', { loadAssetBlob: blob })
    const b = await s.assetUrl('accolades', 'emoji-fixture.png', { loadAssetBlob: blob })
    const c = await s.assetUrl('ranks', 'emoji-fixture.png', { loadAssetBlob: blob })
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    s.reset()
    expect(revoked.sort()).toEqual([a, c].sort())
    expect([s.status, s.archive]).toEqual(['idle', null])
  })
  it('an asset that finishes decrypting after reset is revoked, not leaked', async () => {
    const revoked = []
    URL.createObjectURL = () => 'blob:late'
    URL.revokeObjectURL = (u) => revoked.push(u)
    const s = useArchive()
    await s.load('tok', { loadArchive: ok() })
    let release
    const pending = s.assetUrl('accolades', 'big.png', { loadAssetBlob: () => new Promise((r) => (release = r)) })
    s.reset()
    release(new Blob(['x']))
    await pending
    expect(revoked).toEqual(['blob:late'])
  })
  it('assetUrl before ready rejects', async () => {
    await expect(useArchive().assetUrl('accolades', 'x.png')).rejects.toThrow(/not loaded/)
  })
  it('retry clears an error and loads again', async () => {
    const s = useArchive()
    await s.load('tok', { loadArchive: fail('unavailable') })
    await s.retry('tok', { loadArchive: ok() })
    expect(s.status).toBe('ready')
  })
  it('a load that finishes after reset is discarded: no key, no content', async () => {
    const s = useArchive()
    let release
    const pending = s.load('tok', { loadArchive: () => new Promise((r) => (release = r)) })
    s.reset()
    release({ keys: { fake: true }, index: makeIndex() })
    await pending
    expect([s.status, s.archive]).toEqual(['idle', null])
    await expect(s.assetUrl('accolades', 'x.png')).rejects.toThrow(/not loaded/)
  })
  it('a fresh load after a reset is not blocked by the stale in-flight one', async () => {
    const s = useArchive()
    s.load('tok', { loadArchive: () => new Promise(() => {}) })
    s.reset()
    await s.load('tok', { loadArchive: ok() })
    expect(s.status).toBe('ready')
  })
  it('signing out anywhere (not just on an archive page) wipes the archive and revokes blobs', async () => {
    const revoked = []
    URL.createObjectURL = () => 'blob:1'
    URL.revokeObjectURL = (u) => revoked.push(u)
    const s = useArchive()
    await s.load('tok', { loadArchive: ok() })
    await s.assetUrl('accolades', 'emoji-fixture.png', { loadAssetBlob: async () => new Blob(['x']) })
    useAuth().signOut()
    expect([s.status, s.archive]).toEqual(['idle', null])
    expect(revoked).toEqual(['blob:1'])
  })
})
