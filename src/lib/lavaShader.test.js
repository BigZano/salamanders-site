import { describe, it, expect } from 'vitest'
import { supportsLavaShader, hasWebGL2 } from './lavaShader'

describe('supportsLavaShader', () => {
  it('reads the switch from the query string', () => {
    expect(supportsLavaShader({ search: '?lava=0' })).toBe('off')
    expect(supportsLavaShader({ search: '?lava=1' })).toBe('on')
    expect(supportsLavaShader({ search: '?moon=0.4' })).toBe('auto')
  })
})
describe('hasWebGL2', () => {
  it('is false without the constructor or without a context', () => {
    expect(hasWebGL2({})).toBe(false)
    const win = { WebGL2RenderingContext: function () {}, document: { createElement: () => ({ getContext: () => null }) } }
    expect(hasWebGL2(win)).toBe(false)
  })
  it('is true when a probe canvas yields a context', () => {
    const win = { WebGL2RenderingContext: function () {}, document: { createElement: () => ({ getContext: () => ({}) }) } }
    expect(hasWebGL2(win)).toBe(true)
  })
})
