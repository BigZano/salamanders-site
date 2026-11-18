// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fc from 'fast-check'
import { placeKey, forgetPlaces } from './places'

// Every id here is invented.
const POST = '200000000000000402'
const OTHER = '200000000000000403'

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('placeKey', () => {
  it('names the key a post keeps the reader\'s place under', () => {
    expect(placeKey(POST)).toBe(`lb-anchor:${POST}`)
    expect(placeKey(OTHER)).toBe(`lb-anchor:${OTHER}`)
    expect(placeKey(POST)).not.toBe(placeKey(OTHER))
  })
})

describe('forgetPlaces', () => {
  it('removes the place kept for every post', () => {
    sessionStorage.setItem(placeKey(POST), '200000000000000450')
    sessionStorage.setItem(placeKey(OTHER), '200000000000000451')
    forgetPlaces()
    expect(sessionStorage.getItem(placeKey(POST))).toBeNull()
    expect(sessionStorage.getItem(placeKey(OTHER))).toBeNull()
    expect(sessionStorage).toHaveLength(0)
  })

  it('removes a place that is the only thing kept, and the first and the last of many', () => {
    sessionStorage.setItem(placeKey(POST), 'x')
    forgetPlaces()
    expect(sessionStorage).toHaveLength(0)

    sessionStorage.setItem(placeKey(POST), 'x')
    sessionStorage.setItem('between', 'kept')
    sessionStorage.setItem(placeKey(OTHER), 'y')
    forgetPlaces()
    expect(sessionStorage).toHaveLength(1)
    expect(sessionStorage.getItem('between')).toBe('kept')
  })

  it('leaves everything that is not a place alone, however alike its key is', () => {
    const kept = {
      'salamanders-discord-return-path': '/planner',
      'lb-anchor': 'no colon',
      'LB-ANCHOR:1': 'other case',
      'xlb-anchor:1': 'prefix before',
      ' lb-anchor:1': 'space before',
      'lb-anchors:1': 'plural',
      'lb_anchor:1': 'underscore',
      'a-lb-anchor:1': 'in the middle',
      '': 'empty key',
    }
    for (const [key, value] of Object.entries(kept)) sessionStorage.setItem(key, value)
    sessionStorage.setItem(placeKey(POST), 'gone')
    forgetPlaces()
    for (const [key, value] of Object.entries(kept)) expect(sessionStorage.getItem(key), JSON.stringify(key)).toBe(value)
    expect(sessionStorage.getItem(placeKey(POST))).toBeNull()
    expect(sessionStorage).toHaveLength(Object.keys(kept).length)
  })

  it('removes a key that is nothing but the prefix, and one with anything after it', () => {
    for (const key of ['lb-anchor:', 'lb-anchor:abc', 'lb-anchor:1:2', 'lb-anchor: ']) sessionStorage.setItem(key, 'v')
    forgetPlaces()
    expect(sessionStorage).toHaveLength(0)
  })

  it('does nothing when nothing is kept, and can be asked twice', () => {
    expect(() => forgetPlaces()).not.toThrow()
    sessionStorage.setItem('other', 'kept')
    forgetPlaces()
    forgetPlaces()
    expect(sessionStorage.getItem('other')).toBe('kept')
  })

  it('does not touch localStorage, where the sign-in is', () => {
    localStorage.setItem(placeKey(POST), 'kept')
    sessionStorage.setItem(placeKey(POST), 'gone')
    forgetPlaces()
    expect(localStorage.getItem(placeKey(POST))).toBe('kept')
    localStorage.clear()
  })

  it('removes exactly the keys that begin with the prefix, whatever else is kept (property)', () => {
    const key = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.string({ maxLength: 12 }).map((rest) => `lb-anchor:${rest}`),
      fc.constantFrom('lb-anchor', 'lb-anchor:', 'LB-ANCHOR:x', ' lb-anchor:x', 'x lb-anchor:'),
    )
    fc.assert(
      fc.property(fc.dictionary(key, fc.string({ maxLength: 8 }), { maxKeys: 12 }), (entries) => {
        sessionStorage.clear()
        for (const [k, v] of Object.entries(entries)) sessionStorage.setItem(k, v)
        forgetPlaces()
        const left = Object.fromEntries(Object.keys(entries).filter((k) => !k.startsWith('lb-anchor:')).map((k) => [k, entries[k]]))
        expect(sessionStorage).toHaveLength(Object.keys(left).length)
        for (const [k, v] of Object.entries(left)) expect(sessionStorage.getItem(k)).toBe(v)
      }),
    )
  })

  it('never throws, and keeps what it could not read, when the browser will not let it look', () => {
    sessionStorage.setItem(placeKey(POST), 'kept')
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(() => forgetPlaces()).not.toThrow()
    vi.restoreAllMocks()
    expect(sessionStorage.getItem(placeKey(POST))).toBe('kept')
  })

  it('never throws when removing is what the browser refuses', () => {
    sessionStorage.setItem(placeKey(POST), 'kept')
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(() => forgetPlaces()).not.toThrow()
  })
})
