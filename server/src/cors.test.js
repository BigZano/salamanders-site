import { describe, it, expect } from 'vitest'
import { applyCors } from './cors'

const ORIGIN = 'https://site.test'
const run = () => applyCors(new Response('{}'), ORIGIN)

describe('applyCors', () => {
  it('allows the configured origin', () => {
    expect(run().headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
  })

  it('allows the methods the API uses', () => {
    expect(run().headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS')
  })

  it('allows PUT, which the Librarius read marker is sent with: a preflight that omits it blocks the request in the browser', () => {
    const methods = run().headers.get('Access-Control-Allow-Methods').split(',').map((m) => m.trim())
    expect(methods).toContain('PUT')
    expect(methods).toEqual(expect.arrayContaining(['GET', 'POST', 'DELETE', 'OPTIONS']))
  })

  it('allows PATCH, which editing a reply on the Librarius is sent with: a preflight that omits it blocks the request in the browser', () => {
    const methods = run().headers.get('Access-Control-Allow-Methods').split(',').map((m) => m.trim())
    expect(methods).toContain('PATCH')
  })

  it('allows the headers the client sends', () => {
    expect(run().headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization, If-None-Match')
  })

  it('lets the page read the ETag', () => {
    expect(run().headers.get('Access-Control-Expose-Headers')).toBe('ETag')
  })

  it('returns the response it was given', () => {
    const res = new Response(null, { status: 304 })
    expect(applyCors(res, ORIGIN)).toBe(res)
  })
})
