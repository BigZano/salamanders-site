import { describe, it, expect, vi, afterEach } from 'vitest'
import { supportsLavaShader, hasWebGL2, createLavaLayer } from './lavaShader'
import { UNIFORMS, LAVA_FRAG } from './lavaShader.glsl'
import { SIM_UNIFORMS, SIM_FRAG } from './lavaSim.glsl'
import { simUniforms, paletteBytes } from './lavaSim'
import { DEFAULTS } from './fireTuning'
import { compileProgram, createSimTargets, deleteSimTargets } from './lavaGl'

// A failed build warns in development, so tests that fail one on purpose spy on console.warn.
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

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
  'TEXTURE_WRAP_T', 'NEAREST', 'LINEAR', 'CLAMP_TO_EDGE', 'RGB', 'RGBA', 'RGBA8', 'RGBA16F', 'HALF_FLOAT',
  'UNSIGNED_BYTE', 'UNSIGNED_SHORT', 'FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'COLOR_BUFFER_BIT', 'TRIANGLES',
  'TRIANGLE_STRIP', 'BLEND', 'UNPACK_ALIGNMENT',
]
const ATTRIBUTES = ['aPos', 'aAcross', 'aAlong', 'aHalf', 'aHeat', 'aId']

// A WebGL2 stand-in that links everything, records what the layer asks of it, and fires context events
// the way a canvas does. `rec.calls` counts every GL call, so a test can show a lost context is left alone.
// Textures and framebuffers are real objects and the fake tracks the binds, so `rec.passes` shows for every
// draw which program ran, what each texture unit held, what it drew into and what every uniform was; a handle
// that is deleted or lost throws if the layer binds it again. A program is told apart by its fragment source.
function fakeGL({ float = true, compileOk = true, linkOk = true, dpr, refuseContext = false, failSim = false } = {}) {
  const listeners = new Map()
  const objects = []
  const labels = new WeakMap()
  const state = { unit: 0, units: [], fbo: null, align: 4, viewport: null, program: null }
  const fire = (type) => {
    if (type === 'webglcontextlost') for (const object of objects) object.dead = true
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    for (const fn of listeners.get(type) ?? []) fn(event)
    return event
  }
  const rec = {
    calls: 0, lookups: 0, programs: 0, loseCalls: 0, contexts: [], deletedPrograms: 0, deletedTargets: 0,
    drawElements: [], drawArrays: [], uploads: [], sources: [], textures: [], objects, state,
    by: { field: {}, lava: {}, sim: {} }, passes: [], reads: [], pixelStore: [],
    enabled: [], attribs: [], infoLogReads: 0,
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
  const make = () => {
    const object = { id: objects.length, params: {} }
    objects.push(object)
    return object
  }
  const live = (object) => {
    if (object?.dead || object?.deleted) throw new Error('bound a GL object that is deleted or lost')
    return object
  }
  const labelOf = (source) => {
    const bare = source.replace('#define FIELD_PACKED\n', '')
    return bare === SIM_FRAG ? 'sim' : bare === LAVA_FRAG ? 'lava' : 'field'
  }
  for (const name of [
    'compileShader', 'linkProgram', 'bindVertexArray', 'bindBuffer', 'clearColor', 'clear', 'disable', 'deleteShader',
  ]) method(name)
  method('useProgram', (program) => { state.program = program })
  method('viewport', (...v) => { state.viewport = v })
  method('activeTexture', (unit) => { state.unit = unit - gl.TEXTURE0 })
  method('bindTexture', (_target, texture) => { state.units[state.unit] = live(texture) })
  method('bindFramebuffer', (_target, fbo) => { state.fbo = live(fbo) })
  method('framebufferTexture2D', (_target, _attachment, _texTarget, texture) => { state.fbo.texture = live(texture) })
  method('pixelStorei', (name, value) => {
    rec.pixelStore.push([name, value])
    if (name === gl.UNPACK_ALIGNMENT) state.align = value
  })
  method('texImage2D', (...args) => {
    rec.textures.push(args)
    Object.assign(state.units[state.unit], { size: [args[3], args[4]], alignment: state.align })
  })
  method('readPixels', (x, y, w, h, format, type, data) => {
    rec.reads.push({ x, y, w, h, format, type, data, fbo: state.fbo })
    data.fill(type === gl.FLOAT ? 0.5 : 7)
  })
  // The vertex layout and sampler state are recorded: they decide what the shaders read, and a no-op stub
  // would let a wrong offset or filter through.
  method('enableVertexAttribArray', (at) => rec.enabled.push(at))
  method('vertexAttribPointer', (...args) => rec.attribs.push(args))
  method('texParameteri', (_target, name, value) => { state.units[state.unit].params[name] = value })
  method('getShaderInfoLog', () => { rec.infoLogReads++; return 'shader log' })
  method('getProgramInfoLog', () => { rec.infoLogReads++; return 'program log' })
  method('deleteProgram', () => rec.deletedPrograms++)
  method('deleteFramebuffer', (fbo) => { fbo.deleted = true; rec.deletedTargets++ })
  method('deleteTexture', (texture) => { texture.deleted = true })
  method('createShader', (type) => ({ type }))
  method('shaderSource', (shader, source) => {
    shader.source = source
    rec.sources.push({ type: shader.type, source })
  })
  method('attachShader', (program, shader) => {
    if (shader.type === gl.FRAGMENT_SHADER) labels.set(program, labelOf(shader.source))
  })
  method('getShaderParameter', (shader) => compileOk && !(failSim && shader.source === SIM_FRAG))
  method('createProgram', () => ({ id: ++rec.programs }))
  method('getProgramParameter', () => linkOk)
  // Like a real compiler, drop the attribute the shader never reads.
  method('getAttribLocation', (_p, name) => (name === 'aHeat' ? -1 : ATTRIBUTES.indexOf(name)))
  method('getUniformLocation', (program, name) => { rec.lookups++; return { name, owner: labels.get(program) ?? 'field' } })
  for (const name of ['createBuffer', 'createVertexArray']) method(name, () => ({}))
  for (const name of ['createTexture', 'createFramebuffer']) method(name, make)
  method('bufferData', (target, data, usage) => rec.uploads.push({ target, data, usage }))
  method('drawElements', (mode, count, type, offset) => rec.drawElements.push({ mode, count, type, offset }))
  method('drawArrays', (mode, first, count) => {
    rec.drawArrays.push({ mode, first, count })
    const program = labels.get(state.program) ?? 'field'
    rec.passes.push({ program, uniforms: { ...rec.by[program] }, fbo: state.fbo, units: [...state.units], viewport: state.viewport })
  })
  for (const name of ['uniform1f', 'uniform1i', 'uniform1fv', 'uniform2f', 'uniform4f', 'uniform4fv']) {
    method(name, (loc, ...v) => {
      rec.by[loc.owner][loc.name] = v.length === 1 ? (ArrayBuffer.isView(v[0]) ? Array.from(v[0]) : v[0]) : v
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
const frame = (flows, extra = {}) => ({ t: 1, secs: 1 / 60, flows, calmRects: [], calmShift: 0, tune, density: 1, ...extra })
// The passes that ran the simulation, and the textures of a given size that were made (sim 256 x 384, field 800 x 600).
const simPassesOf = (rec) => rec.passes.filter((p) => p.program === 'sim')
const texturesOf = (rec, w, h) => rec.objects.filter((o) => o.size?.[0] === w && o.size[1] === h)

describe('createLavaLayer', () => {
  it('is null without WebGL2', () => {
    expect(createLavaLayer({ win: {}, phone: false })).toBeNull()
  })
  it('is null when the context is refused or a program does not build', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(createLavaLayer({ win: fakeGL({ refuseContext: true }).win, phone: false })).toBeNull()
    expect(createLavaLayer({ win: fakeGL({ compileOk: false }).win, phone: false })).toBeNull()
    expect(createLavaLayer({ win: fakeGL({ linkOk: false }).win, phone: false })).toBeNull()
  })
  it('is null, with every program freed and the context given back, when only the sim program fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { win, rec } = fakeGL({ failSim: true })
    expect(createLavaLayer({ win, phone: false })).toBeNull()
    // The field and lava programs had linked; the sim's compile failed so it never became a program.
    expect(rec.deletedPrograms).toBe(2)
    // The probe, then the release of the layer's own context.
    expect(rec.loseCalls).toBe(2)
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
    const lava = rec.by.lava
    expect(lava.uResolution).toEqual([195, 422])
    // The centreline runs (50, 50) to (50, 150) and the pad is 1.25 * the scaled width of 10.
    expect(lava.uBounds.map((v) => Math.round(v * 1000) / 1000)).toEqual([37.5, 37.5, 25, 125])
    expect(lava.uLength[0]).toBe(100)
    expect(lava.uCalmCount).toBe(1)
    expect(lava.uCalm.slice(0, 4)).toEqual([5, 14, 15, 24])
  })

  it('draws every levee first, then every channel body, in the order the strips give, as byte offsets', () => {
    const { win, gl, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    // The sheet is first in the array but a head, so it is drawn after the arm it feeds.
    layer.resize(800, 600, [{ ...flow, head: true }, flow])
    const uploads = rec.uploads.map((u) => u.target)
    expect(uploads).toContain(gl.ARRAY_BUFFER)
    expect(uploads).toContain(gl.ELEMENT_ARRAY_BUFFER)
    expect(rec.uploads.every((u) => u.usage === gl.DYNAMIC_DRAW)).toBe(true)
    // Each range is 12 indices of 2 bytes: channel 1 at 24 and 36, channel 0 at 0 and 12.
    expect(rec.drawElements.map((d) => d.offset)).toEqual([48, 0, 72, 24])
    expect(rec.drawElements.every((d) => d.count === 12 && d.mode === gl.TRIANGLES && d.type === gl.UNSIGNED_SHORT)).toBe(true)
  })

  it('reaches the levee 1.25 half widths past the centreline, not 2.2, and pads the box by the same factor', () => {
    const { win, gl, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [straight])
    const verts = rec.uploads.find((u) => u.target === gl.ARRAY_BUFFER).data
    // Vertices 0-3 are the channel's (two points, two banks); vertex 4 is the levee's left bank at the first point.
    expect([verts[4 * 7 + 2], verts[5 * 7 + 2]]).toEqual([-1.25, 1.25])
    expect(verts[4 * 7]).toBeCloseTo(100 - 12.5) // half width 10 * 1.25
    expect(verts[4 * 7 + 4]).toBe(10) // and it keeps the channel's half width
    // The box pads by 1.25 * the widest the channel gets along it, here its width at the toe, not at the vent.
    const widening = { ...straight, widthAt: (s) => 10 + 30 * s }
    layer.resize(800, 600, [widening])
    layer.draw(frame([widening]))
    expect(rec.by.lava.uBounds.map((v) => Math.round(v * 1000) / 1000)).toEqual([50, 50, 100, 300])
  })

  it('takes joins and a pool as a fourth argument, in CSS pixels: the pool is one more channel drawn first, the fan last', () => {
    const { win, gl, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: true })
    const trunk = { ...flow, head: true, pts: [{ x: 100, y: 100 }, { x: 100, y: 200 }, { x: 100, y: 300 }], widthAt: () => 20 }
    const feeder = { ...flow, pts: [{ x: 40, y: 100 }, { x: 70, y: 200 }, { x: 100, y: 250 }], widthAt: () => 10 }
    const arcY = (x) => 330 - 15 * Math.sqrt(Math.max(0, 1 - ((x - 100) / 60) ** 2))
    const pool = { cx: 100, cy: 330, rx: 60, ry: 15, arcTop: 315, arcY }
    const joins = [{ feeder: 1, trunk: 0, at: 0.75, wf: 10, wt: 20, wj: 26 }]
    layer.resize(390, 844, [trunk, feeder], { joins, pool })
    // Order: the pool, the feeder, the trunk (the head). Levees (the pool has none), then bodies, then the fan:
    // [count, byte offset] of each draw. Per flow 24 indices (levee 12 + channel 12), the pool 864, the fan 18.
    expect(rec.drawElements.map((d) => [d.count, d.offset])).toEqual([
      [12, 48], [12, 0], // levees: feeder at 24, trunk at 0
      [864, 96], [12, 72], [12, 24], // bodies: pool at 48, feeder at 36, trunk at 12
      [54, 1824], // the fan and its feather strip (18 + 36 indices), at index 912, after every body
    ])
    const verts = rec.uploads.find((u) => u.target === gl.ARRAY_BUFFER).data
    // The pool's first vertex (vertex 24, after two flows of 12) is its left tip at half scale, no height there.
    expect(Array.from(verts.slice(24 * 7, 25 * 7))).toEqual([20, 165, -1, 0, 0, 1, 2])
    // Its top, over the centre (column 12): the arc's top at half scale, half width ry / 2.
    expect(Array.from(verts.slice(36 * 7, 37 * 7))).toEqual([50, 157.5, 0, 0, 7.5, 1, 2])
    // The fan carries the trunk's id and its half width at half scale (20 / 2 / 2), after the pool's 175 vertices.
    expect(Array.from(verts.slice(199 * 7 + 4, 199 * 7 + 7))).toEqual([5, 1, 0])
    // Its tip sits at the bank's solid edge in canvas px (BANK_PX 1 over a half width of 5), on the feeder's left side;
    // the feather point of the arc's first vertex (vertex 199 + 8) is at the 0-alpha edge.
    expect(verts[199 * 7 + 2]).toBeCloseTo(-0.8, 5)
    expect(verts[(199 + 8) * 7 + 2]).toBeCloseTo(-1.2, 5)

    layer.draw(frame([trunk, feeder]))
    // The box holds the pool: x 20 to 80, y 157.5 to 172.5 at half scale, with the flows (x 20 to 50, y 50 to 150) and a pad of 12.5.
    expect(rec.by.lava.uBounds.map((v) => Math.round(v * 1000) / 1000)).toEqual([7.5, 37.5, 85, 147.5])
    // The pool's length along the shader reads is its height at the centre.
    expect(rec.by.lava.uLength[2]).toBe(15)
  })

  it('draws only the flows when there is no pool or joins, or when the shader has no channel left for the pool', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    const pool = { cx: 100, cy: 330, rx: 60, ry: 15, arcTop: 315, arcY: () => 315 }
    layer.resize(800, 600, [flow], { joins: null, pool: null })
    expect(rec.drawElements.map((d) => d.count)).toEqual([12, 12])
    rec.drawElements.length = 0
    layer.resize(800, 600, Array.from({ length: 12 }, () => flow), { pool })
    expect(rec.drawElements).toHaveLength(24)
    expect(rec.drawElements.every((d) => d.count === 12)).toBe(true)
  })

  it('tells both passes which channel is the pool, uPoolId = flows.length, and -1 when there is none', () => {
    const pool = { cx: 100, cy: 330, rx: 60, ry: 15, arcTop: 315, arcY: () => 315 }
    const withPool = fakeGL()
    const layer = createLavaLayer({ win: withPool.win, phone: false })
    layer.resize(800, 600, [flow, straight], { pool })
    // The field pass is told at resize (it draws once per layout), the lava pass at every draw.
    expect(withPool.rec.by.field.uPoolId).toBe(2)
    layer.draw(frame([flow, straight]))
    expect(withPool.rec.by.lava.uPoolId).toBe(2)

    const bare = fakeGL()
    const plain = createLavaLayer({ win: bare.win, phone: false })
    plain.resize(800, 600, [flow, straight])
    plain.draw(frame([flow, straight]))
    expect(bare.rec.by.field.uPoolId).toBe(-1)
    expect(bare.rec.by.lava.uPoolId).toBe(-1)
    // Flows that fill the shader leave the pool out, so the id goes back to -1 rather than naming a channel that is not there.
    layer.resize(800, 600, Array.from({ length: 12 }, () => flow), { pool })
    expect(withPool.rec.by.field.uPoolId).toBe(-1)
  })

  it('keeps the plate scale off the pool: uPlateH is the flows-only box at the old pad of 2.2 vent widths', () => {
    const trunk = { ...flow, head: true, pts: [{ x: 100, y: 100 }, { x: 100, y: 300 }], widthAt: () => 20 }
    const pool = { cx: 100, cy: 330, rx: 60, ry: 15, arcTop: 315, arcY: () => 315 }
    const plain = fakeGL()
    const bare = createLavaLayer({ win: plain.win, phone: false })
    bare.resize(800, 600, [trunk])
    bare.draw(frame([trunk]))
    // The centreline runs 200 px and the pad is 2.2 * 20 each side: what the box measured before the pool and the narrower levee.
    expect(plain.rec.by.lava.uPlateH).toBe(200 + 2 * 2.2 * 20)

    const pooled = fakeGL()
    const layer = createLavaLayer({ win: pooled.win, phone: false })
    layer.resize(800, 600, [trunk], { pool })
    layer.draw(frame([trunk]))
    // The pool grows the bounds quad (a pad of 1.25 * 20 and the ellipse to y 345), not the plates.
    expect(pooled.rec.by.lava.uBounds[3]).toBeGreaterThan(plain.rec.by.lava.uBounds[3])
    expect(pooled.rec.by.lava.uPlateH).toBe(plain.rec.by.lava.uPlateH)
    // Scaled with the drawing buffer, as every px the GPU sees: a phone draws at half.
    const phone = fakeGL()
    const small = createLavaLayer({ win: phone.win, phone: true })
    small.resize(800, 600, [trunk], { pool })
    small.draw(frame([trunk]))
    expect(phone.rec.by.lava.uPlateH).toBe((200 + 2 * 2.2 * 20) / 2)
  })

  it('ignites the sim again when a pool appears or goes: it is one more block', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    const pool = { cx: 100, cy: 330, rx: 60, ry: 15, arcTop: 315, arcY: () => 315 }
    layer.resize(800, 600, [flow])
    layer.stepN(1)
    layer.resize(800, 600, [flow])
    layer.stepN(1)
    layer.resize(800, 600, [flow], { pool })
    layer.stepN(1)
    layer.resize(800, 600, [flow], { pool })
    layer.stepN(1)
    layer.resize(800, 600, [flow])
    layer.stepN(1)
    expect(simPassesOf(rec).map((p) => p.uniforms.uIgnite)).toEqual([1, 0, 1, 0, 1])
  })

  it('counts the pool as a block only when the strips kept it: a pool with no size is no block, no length and no box', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    const flat = { cx: 100, cy: 330, rx: 0, ry: 15, arcTop: 315, arcY: () => 315 }
    layer.resize(800, 600, [straight])
    layer.stepN(1)
    layer.resize(800, 600, [straight], { pool: flat })
    layer.stepN(1)
    expect(simPassesOf(rec).map((p) => p.uniforms.uIgnite)).toEqual([1, 0])
    layer.draw(frame([straight]))
    expect(rec.by.lava.uLength[1]).toBe(0)
    expect(rec.by.lava.uBounds.map((v) => Math.round(v * 1000) / 1000)).toEqual([75, 75, 50, 250])
  })

  it('stores the field as half floats when it can, else as bytes with the packed define', () => {
    const wide = fakeGL({ float: true })
    createLavaLayer({ win: wide.win, phone: false }).resize(800, 600, [])
    const wideField = wide.rec.textures.find((args) => args[3] === 800)
    expect(wideField).toEqual([wide.gl.TEXTURE_2D, 0, wide.gl.RGBA16F, 800, 600, 0, wide.gl.RGBA, wide.gl.HALF_FLOAT, null])
    expect(wide.rec.sources.some((s) => s.source.startsWith('#version 300 es\n#define FIELD_PACKED\n'))).toBe(false)

    const narrow = fakeGL({ float: false })
    createLavaLayer({ win: narrow.win, phone: false }).resize(800, 600, [])
    const narrowField = narrow.rec.textures.find((args) => args[3] === 800)
    expect(narrowField).toEqual([narrow.gl.TEXTURE_2D, 0, narrow.gl.RGBA8, 800, 600, 0, narrow.gl.RGBA, narrow.gl.UNSIGNED_BYTE, null])
    // Only the field and lava fragment shaders pack `across`; the sim's has no such define.
    const packed = narrow.rec.sources.filter((s) => s.source.startsWith('#version 300 es\n#define FIELD_PACKED\n'))
    expect(packed.map((s) => s.type)).toEqual([narrow.gl.FRAGMENT_SHADER, narrow.gl.FRAGMENT_SHADER])
    expect(narrow.rec.sources).toHaveLength(6)
  })

  it('lays the field pass vertices out as lavaStrips does and skips the dropped aHeat', () => {
    const { win, gl, rec } = fakeGL()
    createLavaLayer({ win, phone: false })
    // [location, size, type, normalized, stride, offset]: 7 floats a vertex, so 28 bytes.
    expect(rec.attribs).toEqual([
      [0, 2, gl.FLOAT, false, 28, 0], // aPos
      [1, 1, gl.FLOAT, false, 28, 8], // aAcross
      [2, 1, gl.FLOAT, false, 28, 12], // aAlong
      [3, 1, gl.FLOAT, false, 28, 16], // aHalf
      [5, 1, gl.FLOAT, false, 28, 24], // aId
    ])
    expect(rec.enabled).toEqual([0, 1, 2, 3, 5])
    expect(rec.enabled).not.toContain(-1)
  })

  it('samples the field by pixel: nearest, clamped to the edge', () => {
    const { win, gl, rec } = fakeGL()
    createLavaLayer({ win, phone: false }).resize(800, 600, [flow])
    const [field, ...others] = texturesOf(rec, 800, 600)
    expect(others).toHaveLength(0)
    expect(field.params).toEqual({
      [gl.TEXTURE_MIN_FILTER]: gl.NEAREST,
      [gl.TEXTURE_MAG_FILTER]: gl.NEAREST,
      [gl.TEXTURE_WRAP_S]: gl.CLAMP_TO_EDGE,
      [gl.TEXTURE_WRAP_T]: gl.CLAMP_TO_EDGE,
    })
  })

  it('sets every uniform of both programs on every draw from locations looked up once', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow]))
    // The lava pass takes no uTime, uPhase, uSurge, uCrust or uBreakoutRate: they live in the sim now.
    expect(Object.keys(rec.by.lava).sort()).toEqual([...UNIFORMS].sort())
    expect(Object.keys(rec.by.sim).sort()).toEqual([...SIM_UNIFORMS].sort())
    const lookups = rec.lookups
    rec.by.lava = {}
    rec.by.sim = {}
    layer.draw(frame([flow], { t: 2 }))
    expect(Object.keys(rec.by.lava).sort()).toEqual([...UNIFORMS].sort())
    expect(Object.keys(rec.by.sim).sort()).toEqual([...SIM_UNIFORMS].sort())
    expect(rec.lookups).toBe(lookups)
    // One bounds quad per frame, as a strip of four vertices, over the sampled field.
    expect(rec.drawArrays.at(-1)).toMatchObject({ count: 4 })
    expect(rec.by.lava.uField).toBe(0)
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
    layer.stepN(3)
    layer.readSim(new Uint8Array(256 * 384 * 4))
    layer.resize(400, 300, [flow])
    expect(rec.calls).toBe(calls)
    expect(layer.canvas.width).toBe(400)
    expect(layer.fieldPasses).toBe(1)
    expect(layer.simPasses).toBe(0)
  })

  it('rebuilds its programs and renders the newest field on restore', () => {
    const { win, rec, fire } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    expect(rec.programs).toBe(3)
    fire('webglcontextlost')
    layer.resize(400, 300, [flow])
    fire('webglcontextrestored')
    expect(rec.programs).toBe(6)
    expect(layer.fieldPasses).toBe(2)
    expect(texturesOf(rec, 400, 300)).toHaveLength(1)
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

describe('the layer and the heat simulation', () => {
  it('runs one sim pass then the frame pass per draw, and swaps the targets', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow], { secs: 0.033 }))
    expect(layer.simPasses).toBe(1)
    expect(layer.drawCalls).toBe(1)
    expect(rec.by.sim.uDt).toBeCloseTo(0.033)
    layer.draw(frame([flow]))
    expect(rec.passes.map((p) => p.program)).toEqual(['sim', 'lava', 'sim', 'lava'])

    const [sim1, lava1, sim2, lava2] = rec.passes
    // The first pass reads one target and writes the other; the frame pass shows what was just written...
    expect(sim1.units[0]).not.toBe(sim1.fbo.texture)
    expect(lava1.units[1]).toBe(sim1.fbo.texture)
    // ...and the next step reads that and writes back into the first.
    expect(sim2.units[0]).toBe(sim1.fbo.texture)
    expect(sim2.fbo.texture).toBe(sim1.units[0])
    expect(lava2.units[1]).toBe(sim2.fbo.texture)
  })

  it('gives the sim pass the sim texture for a viewport and the frame pass the canvas', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow]))
    expect(rec.passes[0].viewport).toEqual([0, 0, 256, 384])
    expect(rec.passes[1].viewport).toEqual([0, 0, 800, 600])
  })

  it('binds the field, the sim and the palette to units 0, 1 and 2 for the frame pass', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow]))
    const lava = rec.passes[1]
    expect(lava.units[0].size).toEqual([800, 600])
    expect(lava.units[1].size).toEqual([256, 384])
    expect(lava.units[2].size).toEqual([37, 1])
    expect(lava.uniforms).toMatchObject({ uField: 0, uSim: 1, uPalette: 2, uSimSize: [256, 32] })
    expect(rec.passes[0].uniforms).toMatchObject({ uPrev: 0, uSimSize: [256, 32] })
  })

  it('clamps a huge frame gap to 50 ms of sim time', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow], { secs: 4 }))
    expect(rec.by.sim.uDt).toBe(0.05)
  })

  it('steps the sim by a sixtieth of a second when the caller gives no frame time', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw({ t: 1, flows: [flow], calmRects: [], calmShift: 0, tune, density: 1 })
    expect(rec.by.sim.uDt).toBeCloseTo(1 / 60)
  })

  it('steps the sim by a sixtieth of a second when the frame time is not a number', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow], { secs: NaN }))
    expect(rec.by.sim.uDt).toBeCloseTo(1 / 60)
  })

  it('steps the sim by a sixtieth of a second when the frame time is negative', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow], { secs: -1 }))
    expect(rec.by.sim.uDt).toBeCloseTo(1 / 60)
  })

  it('feeds the sim the tuner values, the surges and the channel parentage', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    const arm = { ...flow, parent: 0, attach: 0.4 }
    layer.resize(800, 600, [{ ...flow, surge: 0.3 }, arm])
    layer.draw(frame([{ ...flow, surge: 0.3 }, arm], { tune: { ...tune, heat: 1.5, crust: 0.2, viscosity: 0.9, breakoutRate: 2 } }))
    const sim = rec.by.sim
    expect(sim.uSource).toBeCloseTo(1.35)
    expect(sim).toMatchObject({ uCool: 0.2, uVisc: 0.9, uBreak: 2 })
    expect(sim.uSurge.slice(0, 3).map((v) => Math.round(v * 100) / 100)).toEqual([0.3, -1, -1])
    // Slot 2 is past the last flow: no channel's (lavaSim.js NO_CHANNEL), so the sim keeps it empty.
    expect(sim.uParent.slice(0, 3)).toEqual([-1, 0, -2])
    expect(sim.uAttach[1]).toBeCloseTo(0.4)
    expect(sim.uSurge).toHaveLength(12)
    // Flows that say nothing of a drain (today's) drain nowhere: the sim's drain read stays idle.
    expect(sim.uDrain).toEqual(Array(12).fill(-2))
    expect(sim.uDrainAt).toEqual(Array(12).fill(0))
  })

  it('simExtras carries drain, drainAt and vent from channelMap: -1 for the pool, an index for a trunk, -2 past the flows', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    // A pool feeder's drainAt is its entry across the arc (the trunk's end 0, the fissure to its left), not an along fraction.
    const trunk = { ...flow, drain: -1, drainAt: 0 }
    const rim = { ...flow, parent: -1, heat: 0.8, drain: 0, drainAt: 0.3 }
    const braid = { ...flow, parent: 0, attach: 0.8, drain: 0, drainAt: 0.95 }
    const fissure = { ...flow, parent: -1, heat: 0.72, drain: -1, drainAt: -0.6 }
    layer.resize(800, 600, [trunk, rim, braid, fissure])
    layer.draw(frame([trunk, rim, braid, fissure]))
    const sim = rec.by.sim
    expect(sim.uDrain).toHaveLength(12)
    expect(sim.uDrainAt).toHaveLength(12)
    expect(sim.uVentHeat).toHaveLength(12)
    expect(sim.uDrain.slice(0, 5)).toEqual([-1, 0, 0, -1, -2])
    expect(sim.uDrainAt.slice(0, 5).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.3, 0.95, -0.6, 0])
    // Each flow's heat is its vent share (the trunk's flow has heat 1); no pool is passed yet, so slot 4 is 0.
    expect(sim.uVentHeat.slice(0, 5).map((v) => Math.round(v * 100) / 100)).toEqual([1, 0.8, 1, 0.72, 0])
    expect(sim.uParent.slice(0, 4)).toEqual([-1, -1, 0, -1])
    expect(sim.uAttach[2]).toBeCloseTo(0.8)
  })

  it('stepN runs sim passes only, at 1/30 s each, and the clock advances on every one', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.stepN(3)
    expect(layer.simPasses).toBe(3)
    expect(layer.drawCalls).toBe(0)
    const sims = simPassesOf(rec)
    expect(sims).toHaveLength(3)
    for (const pass of sims) expect(pass.uniforms.uDt).toBeCloseTo(1 / 30)
    expect(sims.map((p) => p.uniforms.uTime)).toEqual([1 / 30, 2 / 30, 3 / 30].map((v) => expect.closeTo(v, 6)))
    // The steps ping-pong like a drawn frame's do.
    expect(sims[1].units[0]).toBe(sims[0].fbo.texture)
  })

  it('stepN with no frame drawn yet uses the shipped lava tuning', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.stepN(1)
    const { uDt, uSource, uCool, uVisc, uBreak } = simUniforms(DEFAULTS.lava, 1 / 30, false)
    expect(rec.by.sim).toMatchObject({ uDt, uSource, uCool, uVisc, uBreak })
    // Once a frame has been drawn the steps follow that frame's tune.
    layer.draw(frame([flow], { tune: { ...tune, heat: 2 } }))
    layer.stepN(1)
    expect(rec.by.sim.uSource).toBeCloseTo(1.8)
  })

  it('ignites cold: the first sim pass after ignite carries uIgnite 1, the next 0', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.stepN(2)
    expect(simPassesOf(rec).map((p) => p.uniforms.uIgnite)).toEqual([1, 0])
    layer.ignite()
    layer.stepN(2)
    expect(simPassesOf(rec).map((p) => p.uniforms.uIgnite)).toEqual([1, 0, 1, 0])
    // A drawn frame carries the flag the same way.
    layer.ignite()
    layer.draw(frame([flow]))
    expect(simPassesOf(rec).at(-1).uniforms.uIgnite).toBe(1)
  })

  it('keeps the sim on a resize, and ignites only when the number of channels changes', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.stepN(1)
    const textures = texturesOf(rec, 256, 384)
    layer.resize(900, 700, [flow])
    layer.stepN(1)
    layer.resize(900, 700, [flow, flow])
    layer.stepN(1)
    layer.resize(800, 600, [flow, flow])
    layer.stepN(1)
    expect(simPassesOf(rec).map((p) => p.uniforms.uIgnite)).toEqual([1, 0, 1, 0])
    // The same two sim textures all along, never rebuilt for a new canvas size: only the three old field
    // targets were freed.
    expect(textures).toHaveLength(2)
    expect(texturesOf(rec, 256, 384)).toHaveLength(2)
    expect(rec.deletedTargets).toBe(3)
  })

  it('re-ignites on context restore and never reads a deleted target', () => {
    const { win, rec, fire } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [flow])
    layer.draw(frame([flow]))
    layer.stepN(1)
    const before = simPassesOf(rec).at(-1)
    expect(before.uniforms.uIgnite).toBe(0)
    fire('webglcontextlost')
    expect(() => {
      layer.draw(frame([flow]))
      layer.stepN(2)
    }).not.toThrow()
    fire('webglcontextrestored')
    // The fake throws if a lost handle is bound, so these running at all shows the sim was rebuilt.
    layer.stepN(2)
    layer.draw(frame([flow]))
    const after = simPassesOf(rec).slice(-3)
    expect(after.map((p) => p.uniforms.uIgnite)).toEqual([1, 0, 0])
    expect(after[0].units[0]).not.toBe(before.units[0])
    expect(layer.simPasses).toBe(5)
  })

  it('runs the sim with no flows and draws nothing', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.resize(800, 600, [])
    layer.draw(frame([]))
    expect(layer.simPasses).toBe(1)
    expect(layer.drawCalls).toBe(0)
    expect(rec.passes.map((p) => p.program)).toEqual(['sim'])
    // No flow fills any slot, so every block is no channel's (lavaSim.js NO_CHANNEL) and the sim keeps it empty.
    expect(rec.by.sim.uParent.every((v) => v === -2)).toBe(true)
  })

  it('leaves the default framebuffer bound after a sim pass', () => {
    const { win, rec } = fakeGL()
    const layer = createLavaLayer({ win, phone: false })
    layer.stepN(1)
    expect(simPassesOf(rec)[0].fbo).not.toBeNull()
    expect(rec.state.fbo).toBeNull()
  })

  it('builds sim targets at the sim size: 256 x 384 on a desktop, 128 x 192 on a phone', () => {
    const desktop = fakeGL()
    createLavaLayer({ win: desktop.win, phone: false })
    expect(texturesOf(desktop.rec, 256, 384)).toHaveLength(2)
    const phone = fakeGL()
    const layer = createLavaLayer({ win: phone.win, phone: true })
    expect(texturesOf(phone.rec, 128, 192)).toHaveLength(2)
    expect(texturesOf(phone.rec, 256, 384)).toHaveLength(0)
    expect(layer.simSize).toEqual({ along: 128, across: 16 })
  })

  it('stores the sim as half floats when the field can be, else as bytes', () => {
    const wide = fakeGL({ float: true })
    createLavaLayer({ win: wide.win, phone: false })
    expect(wide.rec.textures.filter((a) => a[3] === 256)).toEqual(
      Array(2).fill([wide.gl.TEXTURE_2D, 0, wide.gl.RGBA16F, 256, 384, 0, wide.gl.RGBA, wide.gl.HALF_FLOAT, null]),
    )
    const narrow = fakeGL({ float: false })
    createLavaLayer({ win: narrow.win, phone: false })
    expect(narrow.rec.textures.filter((a) => a[3] === 256)).toEqual(
      Array(2).fill([narrow.gl.TEXTURE_2D, 0, narrow.gl.RGBA8, 256, 384, 0, narrow.gl.RGBA, narrow.gl.UNSIGNED_BYTE, null]),
    )
  })

  it('filters the sim linearly and clamps it to the edge', () => {
    const { win, gl, rec } = fakeGL()
    createLavaLayer({ win, phone: false })
    for (const texture of texturesOf(rec, 256, 384)) {
      expect(texture.params).toEqual({
        [gl.TEXTURE_MIN_FILTER]: gl.LINEAR,
        [gl.TEXTURE_MAG_FILTER]: gl.LINEAR,
        [gl.TEXTURE_WRAP_S]: gl.CLAMP_TO_EDGE,
        [gl.TEXTURE_WRAP_T]: gl.CLAMP_TO_EDGE,
      })
    }
  })

  it('uploads the palette as a 37 x 1 RGB texture, with byte-aligned rows', () => {
    const { win, gl, rec } = fakeGL()
    createLavaLayer({ win, phone: false })
    expect(rec.textures.filter((a) => a[3] === 37)).toEqual([
      [gl.TEXTURE_2D, 0, gl.RGB, 37, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, paletteBytes()],
    ])
    const [palette] = texturesOf(rec, 37, 1)
    // 37 x 3 = 111 bytes a row is not a multiple of 4, so the upload must not assume the default alignment.
    expect(palette.alignment).toBe(1)
    expect(rec.pixelStore).toEqual([[gl.UNPACK_ALIGNMENT, 1], [gl.UNPACK_ALIGNMENT, 4]])
    expect(rec.state.align).toBe(4)
    expect(palette.params).toEqual({
      [gl.TEXTURE_MIN_FILTER]: gl.LINEAR,
      [gl.TEXTURE_MAG_FILTER]: gl.LINEAR,
      [gl.TEXTURE_WRAP_S]: gl.CLAMP_TO_EDGE,
      [gl.TEXTURE_WRAP_T]: gl.CLAMP_TO_EDGE,
    })
  })

  describe('readSim', () => {
    it('reads the sim target a step just wrote, as floats quantised to bytes, when the sim is half float', () => {
      const { win, gl, rec } = fakeGL({ float: true })
      const layer = createLavaLayer({ win, phone: false })
      layer.stepN(1)
      const out = new Uint8Array(256 * 384 * 4)
      layer.readSim(out)
      const [read] = rec.reads
      expect([read.x, read.y, read.w, read.h, read.format]).toEqual([0, 0, 256, 384, gl.RGBA])
      // A half float target cannot be read as bytes: that would be INVALID_OPERATION on a real context.
      expect(read.type).toBe(gl.FLOAT)
      expect(read.data).toBeInstanceOf(Float32Array)
      expect(read.fbo).toBe(simPassesOf(rec)[0].fbo)
      expect(out.every((v) => v === 128)).toBe(true)
      expect(rec.state.fbo).toBeNull()
    })

    it('reads straight into the buffer as bytes when the sim is bytes', () => {
      const { win, gl, rec } = fakeGL({ float: false })
      const layer = createLavaLayer({ win, phone: false })
      layer.stepN(2)
      const out = new Uint8Array(256 * 384 * 4)
      layer.readSim(out)
      const [read] = rec.reads
      expect(read.type).toBe(gl.UNSIGNED_BYTE)
      expect(read.data).toBe(out)
      // The current target is the one the second step wrote.
      expect(read.fbo).toBe(simPassesOf(rec)[1].fbo)
      expect(out.every((v) => v === 7)).toBe(true)
      expect(rec.state.fbo).toBeNull()
    })
  })
})

describe('the sim targets', () => {
  it('are made as a pair of distinct textures and freed together', () => {
    const { gl, rec } = fakeGL()
    const targets = createSimTargets(gl, 256, 384, true)
    expect(targets).toHaveLength(2)
    expect(targets[0].texture).not.toBe(targets[1].texture)
    expect(targets[0].fbo).not.toBe(targets[1].fbo)
    deleteSimTargets(gl, targets)
    expect(rec.deletedTargets).toBe(2)
    expect(targets.every((t) => t.texture.deleted && t.fbo.deleted)).toBe(true)
  })
})

describe('compileProgram', () => {
  const SRC = '#version 300 es\n'
  it('returns null, and deletes the program, when it will not link', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { gl, rec } = fakeGL({ linkOk: false })
    expect(compileProgram(gl, SRC, SRC)).toBeNull()
    expect(rec.deletedPrograms).toBe(1)
  })
  it('returns the linked program, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { gl, rec } = fakeGL()
    const program = compileProgram(gl, SRC, SRC)
    expect(program).toEqual({ id: 1 })
    expect(rec.deletedPrograms).toBe(0)
    expect(rec.sources.map((s) => s.type)).toEqual([gl.VERTEX_SHADER, gl.FRAGMENT_SHADER])
    expect(warn).not.toHaveBeenCalled()
  })
  it('warns the driver log for a failed compile or link in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(compileProgram(fakeGL({ compileOk: false }).gl, SRC, SRC)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('compile failed'), 'shader log')
    warn.mockClear()
    expect(compileProgram(fakeGL({ linkOk: false }).gl, SRC, SRC)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('link failed'), 'program log')
  })
  it('says nothing, and does not even read the log, outside development', () => {
    vi.stubEnv('DEV', false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const compileFails = fakeGL({ compileOk: false })
    const linkFails = fakeGL({ linkOk: false })
    expect(compileProgram(compileFails.gl, SRC, SRC)).toBeNull()
    expect(compileProgram(linkFails.gl, SRC, SRC)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    expect(compileFails.rec.infoLogReads + linkFails.rec.infoLogReads).toBe(0)
  })
})
