import { describe, it, expect } from 'vitest'
import { applyCors } from './cors'

const ORIGIN = 'https://site.test'
const run = () => applyCors(new Response('{}'), ORIGIN)

describe('applyCors', () => {
  it('allows the configured origin', () => {
    expect(run().headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
  })

  it('allows the methods the API uses', () => {
    expect(run().headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, DELETE, OPTIONS')
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
