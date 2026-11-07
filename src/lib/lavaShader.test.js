import { describe, it, expect } from 'vitest'
import { supportsLavaShader, hasWebGL2, createLavaLayer } from './lavaShader'
import { UNIFORMS } from './lavaShader.glsl'
import { compileProgram } from './lavaGl'

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

// Every GL enum the layer reads; the values only need to be distinct so a test can tell them apart.
const GL_CONSTANTS = [
  'VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS', 'ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER',
  'DYNAMIC_DRAW', 'FLOAT', 'TEXTURE_2D', 'TEXTURE0', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'TEXTURE_WRAP_S',
  'TEXTURE_WRAP_T', 'NEAREST', 'CLAMP_TO_EDGE', 'RGBA', 'RGBA8', 'RGBA16F', 'HALF_FLOAT', 'UNSIGNED_BYTE',
  'UNSIGNED_SHORT', 'FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'COLOR_BUFFER_BIT', 'TRIANGLES', 'TRIANGLE_STRIP', 'BLEND',
]
const ATTRIBUTES = ['aPos', 'aAcross', 'aAlong', 'aHalf', 'aHeat', 'aId']

// A WebGL2 stand-in that links everything, records what the layer asks of it, and fires context events
// the way a canvas does. `rec.calls` counts every GL call, so a test can show a lost context is left alone.
function fakeGL({ float = true, compileOk = true, linkOk = true, dpr, refuseContext = false } = {}) {
  const listeners = new Map()
  const fire = (type) => {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    for (const fn of listeners.get(type) ?? []) fn(event)
    return event
  }
  const rec = {
    calls: 0, lookups: 0, programs: 0, loseCalls: 0, contexts: [], deletedPrograms: 0, deletedTargets: 0,
    drawElements: [], drawArrays: [], uploads: [], sources: [], textures: [], uniforms: {},
  }
  const lose = {
    loseContext() { rec.loseCalls++; fire('webglcontextlost') },
    restoreContext() { fire('webglcontextrestored') },
  }
  const gl = {}
  GL_CONSTANTS.forEach((name, i) => { gl[name] = i + 1 })
  const method = (name, impl = () => undefined) => {
    gl[name] = (...args) => { rec.calls++; return impl(...args) }
  }
  for (const name of [
    'compileShader', 'attachShader', 'linkProgram', 'useProgram', 'enableVertexAttribArray', 'vertexAttribPointer',
    'bindVertexArray', 'bindBuffer', 'bindTexture', 'texParameteri', 'bindFramebuffer', 'framebufferTexture2D',
    'viewport', 'clearColor', 'clear', 'activeTexture', 'disable', 'deleteShader',
  ]) method(name)
  method('deleteProgram', () => rec.deletedPrograms++)
  method('deleteFramebuffer', () => rec.deletedTargets++)
  method('deleteTexture')
  method('createShader', (type) => ({ type }))
  method('shaderSource', (shader, source) => rec.sources.push({ type: shader.type, source }))
  method('getShaderParameter', () => compileOk)
  method('createProgram', () => ({ id: ++rec.programs }))
  method('getProgramParameter', () => linkOk)
  // Like a real compiler, drop the attribute the shader never reads.
  method('getAttribLocation', (_p, name) => (name === 'aHeat' ? -1 : ATTRIBUTES.indexOf(name)))
  method('getUniformLocation', (_p, name) => { rec.lookups++; return { name } })
  for (const name of ['createBuffer', 'createVertexArray', 'createTexture', 'createFramebuffer']) method(name, () => ({}))
  method('bufferData', (target, data, usage) => rec.uploads.push({ target, data, usage }))
  method('texImage2D', (...args) => rec.textures.push(args))
  method('drawElements', (mode, count, type, offset) => rec.drawElements.push({ mode, count, type, offset }))
  method('drawArrays', (mode, first, count) => rec.drawArrays.push({ mode, first, count }))
  for (const name of ['uniform1f', 'uniform1i', 'uniform1fv', 'uniform2f', 'uniform4f', 'uniform4fv']) {
    method(name, (loc, ...v) => {
      rec.uniforms[loc.name] = v.length === 1 ? (ArrayBuffer.isView(v[0]) ? Array.from(v[0]) : v[0]) : v
    })
  }
  method('getExtension', (name) => {
    if (name === 'WEBGL_lose_context') return lose
    if (name === 'EXT_color_buffer_float') return float ? {} : null
    return null
  })

  const canvas = {
    width: 300,
    height: 150,
    // The first context is hasWebGL2's probe; `refuseContext` makes the layer's own request fail.
    getContext(kind, attrs) {
      rec.contexts.push([kind, attrs])
      return refuseContext && rec.contexts.length > 1 ? null : gl
    },
    addEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
  }
  const win = { WebGL2RenderingContext: function () {}, devicePixelRatio: dpr, document: { createElement: () => canvas } }
  const listenerCount = () => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  return { win, gl, canvas, rec, lose, fire, listenerCount }
}

const tune = { crust: 0.5, heat: 1, viscosity: 0.5, cracks: 1, foldScale: 1, breakoutRate: 1 }
const flow = { pts: [{ x: 100, y: 100 }, { x: 120, y: 200 }, { x: 150, y: 300 }], head: false, heat: 1, widthAt: () => 20 }
// A straight downward channel 20 px wide: its first channel vertex sits at x = 90 and its length is 200.
const straight = { pts: [{ x: 100, y: 100 }, { x: 100, y: 300 }], head: false, heat: 0.8, widthAt: () => 20 }
const frame = (flows, extra = {}) => ({ t: 1, flows, calmRects: [], calmShift: 0, tune, density: 1, ...extra })

describe('createLavaLayer', () => {
  it('is null without WebGL2', () => {
    expect(createLavaLayer({ win: {}, phone: false })).toBeNull()
  })
  it('is null when the context is refused or a program does not build', () => {
    expect(createLavaLayer({ win: fakeGL({ refuseContext: true }).win, phone: false })).toBeNull()
    expect(createLavaLayer({ win: fakeGL({ compileOk: false }).win, phone: false })).toBeNull()
    expect(createLavaLayer({ win: fakeGL({ linkOk: false }).win, phone: false })).toBeNull()
  })
  it('asks for a premultiplied, aliased context that clears itself', () => {
    const { win, rec } = fakeGL()
    createLavaLayer({ win, phone: false })
    expect(rec.contexts[1]).toEqual([
      'webgl2',
      { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false },
    ])
  })

  it('renders the field once per resize and draws only when it has flows', () => {
    const { win } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [])
    expect(layer.fieldPasses).toBe(1)
    layer.draw(frame([]))
    expect(layer.drawCalls).toBe(0)
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow]))
    expect(layer.fieldPasses).toBe(2)
    expect(layer.drawCalls).toBe(1)
  })

  it('sizes the canvas by the device pixel ratio, capped at 2, and halves it on a phone', () => {
    const phone = createLavaLayer({ win: fakeGL().win, phone: true })
    phone.resize(390, 844, [])
    expect(phone.canvas.width).toBe(195)
    expect(phone.canvas.height).toBe(422)
    const dense = createLavaLayer({ win: fakeGL({ dpr: 3 }).win, phone: false })
    dense.resize(800, 600, [])
    expect([dense.canvas.width, dense.canvas.height]).toEqual([1600, 1200])
    const plain = createLavaLayer({ win: fakeGL().win, phone: false })
    plain.resize(800, 600, [])
    expect(plain.canvas.width).toBe(800)
  })

  it('scales every pixel quantity it hands the GPU', () => {
    const { win, gl, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: true })
    layer.resize(390, 844, [straight])
    const strips = rec.uploads.find((u) => u.target === gl.ARRAY_BUFFER).data
    // The first vertex is the channel's left bank: x = 50 - 5, y = 50, half width 5.
    expect([strips[0], strips[1], strips[4]]).toEqual([45, 50, 5])

    layer.draw(frame([straight], { calmRects: [{ l: 10, t: 20, r: 30, b: 40 }], calmShift: 8 }))
    expect(rec.uniforms.uResolution).toEqual([195, 422])
    // The centreline runs (50, 50) to (50, 150) and the pad is 2.2 * the scaled width of 10.
    expect(rec.uniforms.uBounds.map((v) => Math.round(v * 1000) / 1000)).toEqual([28, 28, 44, 144])
    expect(rec.uniforms.uLength[0]).toBe(100)
    expect(rec.uniforms.uCalmCount).toBe(1)
    expect(rec.uniforms.uCalm.slice(0, 4)).toEqual([5, 14, 15, 24])
  })

  it('draws each channel levee first then channel, in the order the strips give, as byte offsets', () => {
    const { win, gl, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    // The sheet is first in the array but a head, so it is drawn after the arm it feeds.
    layer.resize(800, 600, [{ ...flow, head: true }, flow])
    const uploads = rec.uploads.map((u) => u.target)
    expect(uploads).toContain(gl.ARRAY_BUFFER)
    expect(uploads).toContain(gl.ELEMENT_ARRAY_BUFFER)
    expect(rec.uploads.every((u) => u.usage === gl.DYNAMIC_DRAW)).toBe(true)
    // Each range is 12 indices of 2 bytes: channel 1 at 24 and 36, channel 0 at 0 and 12.
    expect(rec.drawElements.map((d) => d.offset)).toEqual([48, 72, 0, 24])
    expect(rec.drawElements.every((d) => d.count === 12 && d.mode === gl.TRIANGLES && d.type === gl.UNSIGNED_SHORT)).toBe(true)
  })

  it('stores the field as half floats when it can, else as bytes with the packed define', () => {
    const wide = fakeGL({ float: true })
    createLavaLayer({ win: wide.win, phone: false }).resize(800, 600, [])
    expect(wide.rec.textures[0]).toEqual([wide.gl.TEXTURE_2D, 0, wide.gl.RGBA16F, 800, 600, 0, wide.gl.RGBA, wide.gl.HALF_FLOAT, null])
    expect(wide.rec.sources.some((s) => s.source.startsWith('#version 300 es\n#define FIELD_PACKED\n'))).toBe(false)

    const narrow = fakeGL({ float: false })
    createLavaLayer({ win: narrow.win, phone: false }).resize(800, 600, [])
    expect(narrow.rec.textures[0]).toEqual([narrow.gl.TEXTURE_2D, 0, narrow.gl.RGBA8, 800, 600, 0, narrow.gl.RGBA, narrow.gl.UNSIGNED_BYTE, null])
    const packed = narrow.rec.sources.filter((s) => s.source.startsWith('#version 300 es\n#define FIELD_PACKED\n'))
    expect(packed.map((s) => s.type)).toEqual([narrow.gl.FRAGMENT_SHADER, narrow.gl.FRAGMENT_SHADER])
    expect(narrow.rec.sources).toHaveLength(4)
  })

  it('sets every uniform on every draw from locations looked up once', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow]))
    expect(Object.keys(rec.uniforms).sort()).toEqual([...UNIFORMS].sort())
    const lookups = rec.lookups
    rec.uniforms = {}
    layer.draw(frame([flow], { t: 2 }))
    expect(Object.keys(rec.uniforms).sort()).toEqual([...UNIFORMS].sort())
    expect(rec.uniforms.uTime).toBe(2)
    expect(rec.lookups).toBe(lookups)
    // One bounds quad per frame, as a strip of four vertices, over the sampled field.
    expect(rec.drawArrays.at(-1)).toMatchObject({ count: 4 })
    expect(rec.uniforms.uField).toBe(0)
  })

  it('goes dark on context loss and comes back on restore', () => {
    const { win, gl } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    gl.getExtension('WEBGL_lose_context').loseContext()
    expect(layer.ok).toBe(false)
    layer.draw(frame([flow], { t: 2 }))
    expect(layer.drawCalls).toBe(0)
    gl.getExtension('WEBGL_lose_context').restoreContext()
    expect(layer.ok).toBe(true)
    expect(layer.fieldPasses).toBe(2)
  })

  it('stops the browser from discarding the lost context, and leaves it alone while it is gone', () => {
    const { win, rec, fire } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    expect(fire('webglcontextlost').defaultPrevented).toBe(true)
    const calls = rec.calls
    layer.draw(frame([flow]))
    layer.resize(400, 300, [flow])
    expect(rec.calls).toBe(calls)
    expect(layer.canvas.width).toBe(400)
    expect(layer.fieldPasses).toBe(1)
  })

  it('rebuilds its programs and renders the newest field on restore', () => {
    const { win, rec, fire } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    expect(rec.programs).toBe(2)
    fire('webglcontextlost')
    layer.resize(400, 300, [flow])
    fire('webglcontextrestored')
    expect(rec.programs).toBe(4)
    expect(layer.fieldPasses).toBe(2)
    expect(rec.textures.at(-1).slice(3, 5)).toEqual([400, 300])
    layer.draw(frame([flow]))
    expect(layer.drawCalls).toBe(1)
  })

  it('is dark, not broken, for a zero-size layout', () => {
    const { win } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(0, 0, [flow])
    expect([layer.canvas.width, layer.canvas.height]).toEqual([1, 1])
    expect(layer.fieldPasses).toBe(0)
    expect(() => layer.draw(frame([flow]))).not.toThrow()
    expect(layer.drawCalls).toBe(0)
    // A real layout brings it back, and a collapse afterwards darkens it again even with a target kept.
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow]))
    expect(layer.drawCalls).toBe(1)
    layer.resize(0, 0, [flow])
    layer.draw(frame([flow]))
    expect(layer.drawCalls).toBe(1)
    expect(layer.fieldPasses).toBe(1)
  })

  it('does not draw before its first field pass, and frees the old field target on a new layout', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.draw(frame([flow]))
    expect(layer.drawCalls).toBe(0)
    layer.resize(800, 600, [flow])
    expect(rec.deletedTargets).toBe(0)
    layer.resize(640, 480, [flow])
    expect(rec.deletedTargets).toBe(1)
  })

  it('dispose loses the context, drops its listeners and stops drawing', () => {
    const { win, rec, fire, listenerCount } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    expect(listenerCount()).toBe(2)
    const losses = rec.loseCalls
    layer.dispose()
    expect(rec.loseCalls).toBe(losses + 1)
    expect(layer.ok).toBe(false)
    expect(listenerCount()).toBe(0)
    fire('webglcontextrestored')
    expect(layer.ok).toBe(false)
    layer.draw(frame([flow]))
    expect(layer.drawCalls).toBe(0)
  })
})

describe('compileProgram', () => {
  it('returns null, and deletes the program, when it will not link', () => {
    const { gl, rec } = fakeGL({ linkOk: false })
    expect(compileProgram(gl, '#version 300 es\n', '#version 300 es\n')).toBeNull()
    expect(rec.deletedPrograms).toBe(1)
  })
  it('returns the linked program', () => {
    const { gl, rec } = fakeGL()
    const program = compileProgram(gl, '#version 300 es\n', '#version 300 es\n')
    expect(program).toEqual({ id: 1 })
    expect(rec.deletedPrograms).toBe(0)
    expect(rec.sources.map((s) => s.type)).toEqual([gl.VERTEX_SHADER, gl.FRAGMENT_SHADER])
  })
})
