import { describe, it, expect } from 'vitest'
import { fetchKey, loadArchive, loadAssetBlob, ArchiveAccessError } from './client'
import { deriveKeys, seal, opaqueName, keyToBase64 } from './crypto'
import { makeIndex } from './testIndex'

const RAW = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const enc = (s) => new TextEncoder().encode(s)

async function server(opts = {}) {
  const { keyStatus = 200, files = {}, throwOn } = opts
  const keys = await deriveKeys(RAW)
  const body = 'keyBody' in opts ? opts.keyBody : { key: keyToBase64(RAW), kid: keys.kid }
  return {
    keys,
    fetchImpl: async (url, init) => {
      if (throwOn && url.includes(throwOn)) throw new TypeError('network')
      if (url.endsWith('/archive/key')) return new Response(JSON.stringify(body), { status: keyStatus })
      const name = url.split('/').pop()
      return name in files ? new Response(files[name]) : new Response('nope', { status: 404 })
    },
  }
}
async function state(p) {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveAccessError)
    return e.state
  }
  throw new Error('expected rejection')
}

describe('fetchKey', () => {
  it.each([
    [401, 'signed-out'], [403, 'restricted'], [503, 'unavailable'], [500, 'unavailable'], [429, 'unavailable'],
  ])('HTTP %i → %s', async (status, want) => {
    const s = await server({ keyStatus: status })
    expect(await state(fetchKey({ apiBase: 'https://api', token: 't', fetchImpl: s.fetchImpl }))).toBe(want)
  })
  it('no token → signed-out without any request', async () => {
    let called = false
    expect(await state(fetchKey({ apiBase: 'x', token: null, fetchImpl: async () => ((called = true), new Response()) }))).toBe('signed-out')
    expect(called).toBe(false)
  })
  it('network error → unavailable', async () => {
    const s = await server({ throwOn: '/archive/key' })
    expect(await state(fetchKey({ apiBase: 'https://api', token: 't', fetchImpl: s.fetchImpl }))).toBe('unavailable')
  })
  it.each([[{}], [{ key: 'short', kid: 'x' }], [null]])('malformed 200 body %j → unavailable', async (keyBody) => {
    const s = await server({ keyBody })
    expect(await state(fetchKey({ apiBase: 'https://api', token: 't', fetchImpl: s.fetchImpl }))).toBe('unavailable')
  })
  it('sends the bearer token and asks for no caching', async () => {
    let seen
    const s = await server()
    await fetchKey({ apiBase: 'https://api', token: 'tok', fetchImpl: async (u, i) => ((seen = i), s.fetchImpl(u, i)) })
    expect(seen.headers.Authorization).toBe('Bearer tok')
    expect(seen.cache).toBe('no-store')
  })
})

describe('loadArchive', () => {
  async function sealedIndex(keys, index = { ...makeIndex(), kid: keys.kid }) {
    return { [`${await opaqueName(keys, 'index')}.bin`]: await seal(keys, 'index', enc(JSON.stringify(index))) }
  }
  it('returns keys and the decrypted index', async () => {
    const s = await server()
    const files = await sealedIndex(s.keys)
    const s2 = await server({ files })
    const r = await loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/archive/', fetchImpl: s2.fetchImpl })
    expect(r.index.collections.accolades.tocThreadId).toBe(makeIndex().collections.accolades.tocThreadId)
  })
  it('versions sealed-file URLs by release, so a new release never reads a cached old file', async () => {
    const s = await server()
    const files = await sealedIndex(s.keys)
    const s2 = await server({ files })
    const urls = []
    const fetchImpl = async (url, init) => (urls.push(url), s2.fetchImpl(url.split('?')[0], init))
    await loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/archive/', version: 'archive-v3', fetchImpl })
    await loadAssetBlob({ keys: s.keys, assetBase: '/archive/', logicalPath: 'accolades/assets/x.png', version: 'archive-v3', fetchImpl }).catch(() => {})
    const sealed = urls.filter((u) => u.includes('.bin'))
    expect(sealed).toHaveLength(2)
    for (const u of sealed) expect(u).toMatch(/^\/archive\/[0-9a-f]{32}\.bin\?v=archive-v3$/)
    urls.length = 0
    await loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/archive/', fetchImpl })
    expect(urls.find((u) => u.includes('.bin'))).toMatch(/\.bin$/) // no release known: plain name
  })
  it('null expectedKid → unpublished, no key request made', async () => {
    let called = false
    expect(await state(loadArchive({ apiBase: 'x', token: 't', expectedKid: null, assetBase: '/a/', fetchImpl: async () => ((called = true), new Response()) }))).toBe('unpublished')
    expect(called).toBe(false)
  })
  it('server kid ≠ bundle kid → outdated', async () => {
    const s = await server()
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: 'ffffffffffffffff', assetBase: '/a/', fetchImpl: s.fetchImpl }))).toBe('outdated')
  })
  it('server returns a key whose real kid differs from the kid it claims → outdated', async () => {
    const s = await server({ keyBody: { key: keyToBase64(new Uint8Array(32)), kid: (await deriveKeys(RAW)).kid } })
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s.fetchImpl }))).toBe('outdated')
  })
  it('index missing (404) → outdated', async () => {
    const s = await server()
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s.fetchImpl }))).toBe('outdated')
  })
  it('tampered index → integrity', async () => {
    const s = await server()
    const files = await sealedIndex(s.keys)
    const [name] = Object.keys(files)
    files[name][files[name].length - 1] ^= 1
    const s2 = await server({ files })
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s2.fetchImpl }))).toBe('integrity')
  })
  it('index kid disagreeing with the key → integrity', async () => {
    const s = await server()
    const files = await sealedIndex(s.keys, { ...makeIndex(), kid: '0000000000000000' })
    const s2 = await server({ files })
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s2.fetchImpl }))).toBe('integrity')
  })
  it('index that decrypts but is not JSON → integrity', async () => {
    const s = await server()
    const files = { [`${await opaqueName(s.keys, 'index')}.bin`]: await seal(s.keys, 'index', enc('{nope')) }
    const s2 = await server({ files })
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s2.fetchImpl }))).toBe('integrity')
  })
})

describe('loadAssetBlob', () => {
  it.each([['a.png', 'image/png'], ['a.gif', 'image/gif'], ['a.jpg', 'image/jpeg'], ['a.webp', 'image/webp'], ['a.bin', 'application/octet-stream']])(
    '%s decrypts with MIME %s',
    async (file, mime) => {
      const s = await server()
      const logicalPath = `accolades/assets/${file}`
      const files = { [`${await opaqueName(s.keys, logicalPath)}.bin`]: await seal(s.keys, logicalPath, enc('img')) }
      const s2 = await server({ files })
      const blob = await loadAssetBlob({ keys: s.keys, assetBase: '/archive/', logicalPath, fetchImpl: s2.fetchImpl })
      expect(blob.type).toBe(mime)
      expect(await blob.text()).toBe('img')
    },
  )
  it('404 or tamper rejects (the image component shows its fallback)', async () => {
    const s = await server()
    await expect(loadAssetBlob({ keys: s.keys, assetBase: '/archive/', logicalPath: 'accolades/assets/x.png', fetchImpl: s.fetchImpl })).rejects.toThrow()
  })
})
