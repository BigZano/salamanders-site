import { describe, it, expect } from 'vitest'
import { createDevKeyHandler } from './archive-dev-server.mjs'

const KEY = Buffer.alloc(32, 3).toString('base64')
const ORIGIN = 'http://localhost:5173'
const handle = createDevKeyHandler({ key: KEY, kid: 'abc', origin: ORIGIN })
const get = (path, init) => handle(new Request(`http://127.0.0.1:8799${path}`, init))

describe('local archive dev key server', () => {
  it('serves the local key to the local dev origin', async () => {
    const r = await get('/archive/key', { headers: { Origin: ORIGIN, Authorization: 'Bearer anything' } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ key: KEY, kid: 'abc' })
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })
  it('answers CORS preflight for the Authorization header', async () => {
    const r = await get('/archive/key', { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.get('Access-Control-Allow-Headers')).toMatch(/Authorization/)
  })
  it('never grants another origin CORS access', async () => {
    const r = await get('/archive/key', { headers: { Origin: 'https://evil.example' } })
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
  })
  it('serves an empty builds list so other pages load, and 404s everything else', async () => {
    expect(await (await get('/builds')).json()).toEqual([])
    expect((await get('/other')).status).toBe(404)
  })
})
