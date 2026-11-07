/**
 * The lava shader's layer: how it draws.
 *
 * `createLavaLayer` wraps the strips, the profile uniforms, the heat simulation and the GLSL passes behind
 * a canvas the volcano composites into its own 2D context. Whether to use the shader at all
 * (`supportsLavaShader`, `hasWebGL2`) and the GPU setup live in lavaGpu.js; the first two are re-exported
 * here, where the volcano and the tests look for them.
 */

import { packUniforms, MAX_CHANNELS, MAX_CALM } from './lavaProfile'
import { buildStrips, bounds } from './lavaStrips'
import { simSize, parents, simUniforms } from './lavaSim'
import { createFieldTarget, deleteFieldTarget, readTarget } from './lavaGl'
import { uploadFrame, uploadSim } from './lavaUniforms'
import { hasWebGL2, buildGpu } from './lavaGpu'

export { supportsLavaShader, hasWebGL2 } from './lavaGpu'

// How far past the bank the levee reaches, in channel half widths. The shader's LEVEE is the same number.
const LEVEE = 2.2

// A sim step that no frame times (stepN's) lasts this long, in seconds.
const STEP = 1 / 30

// The tuner's shipped lava values (fireTuning's DEFAULTS.lava): what a sim stepped before any frame has been
// drawn runs on.
const DEFAULT_TUNE = { crust: 0.75, heat: 1, viscosity: 0.7, cracks: 0.8, foldScale: 1, breakoutRate: 1 }

// The flows in drawing-buffer pixels. Only the fields buildStrips reads are copied, and only the first
// MAX_CHANNELS, because the shader's per-channel arrays hold no more.
function scaleFlows(flows, k) {
  return flows.slice(0, MAX_CHANNELS).map((f) => ({
    pts: f.pts.map((p) => ({ x: p.x * k, y: p.y * k })),
    head: f.head,
    heat: f.heat,
    widthAt: f.widthAt ? (s) => f.widthAt(s) * k : undefined,
  }))
}

function lengthOf(pts) {
  let sum = 0
  for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return sum
}

/**
 * The WebGL2 lava layer, or null when WebGL2, the context or either program is unavailable.
 *
 * The volcano calls `resize` on layout and `draw` each frame, then `drawImage`s `layer.canvas` into its
 * own 2D context. `resize` builds the channels' strips and renders them once into the field texture;
 * `draw` only paints the bounds quad over that field, so a frame costs one draw call. The canvas is
 * `scale` times the CSS size (half on a phone, the device pixel ratio capped at 2 elsewhere) and every
 * pixel value the GPU sees is in those drawing-buffer pixels.
 *
 * Each `draw` first steps a heat simulation (lavaSim.glsl): two small textures in channel space, one read
 * while the other is written, which the lava pass samples for its heat and crust. The sim is not screen
 * sized, so a resize keeps it. It starts cold; `ignite` starts it cold again, `stepN` runs it without
 * drawing, and `readSim` reads it back for tools.
 *
 * `ok` is false while the context is lost, and `draw` does nothing until it is restored. The layer keeps
 * the last layout on the CPU, so a restore re-uploads it rather than asking the volcano to resize.
 */
export function createLavaLayer({ win = typeof window === 'undefined' ? undefined : window, phone } = {}) {
  if (!hasWebGL2(win)) return null
  const canvas = win.document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false })
  if (!gl) return null
  const size = simSize(phone)
  let gpu = buildGpu(gl, size)
  if (!gpu) {
    // Give the context back: browsers cap how many a page may hold.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }

  const scale = phone ? 0.5 : Math.min(win.devicePixelRatio || 1, 2)
  let ok = true
  let fieldPasses = 0
  let drawCalls = 0
  let simPasses = 0
  // The sim's clock, in seconds of sim time. It moves on with every step so the shader's noise never freezes.
  let simClock = 0
  // The next sim step writes the cold state. True at the start, and again after a restore or a change in the
  // number of channels.
  let igniteNext = true
  let channels = 0
  let strips = buildStrips([], { levee: LEVEE })
  const lengths = new Float32Array(MAX_CHANNELS)
  // Calm rects are scaled into these slots each frame, so a frame allocates nothing of its own.
  const calmPool = Array.from({ length: MAX_CALM }, () => ({ l: 0, t: 0, r: 0, b: 0 }))
  const calm = []
  const packArgs = { flows: [], calmRects: calm, calmShift: 0, tune: DEFAULT_TUNE, density: 1, t: 0, phone }
  // What the two uploads need beyond the packed values: one object each, rewritten, so a frame allocates nothing.
  const frameExtras = { lengths, width: 0, height: 0, box: { x: 0, y: 0, w: 0, h: 0 }, size }
  const simExtras = { size, time: 0, ignite: false, surge: null, parent: null, attach: null }
  let readBuffer = null

  function drawRange([start, count]) {
    // drawElements takes a byte offset, and the indices are 16-bit.
    if (count > 0) gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, start * 2)
  }

  // A layer under 2 px (a zero-size layout leaves it 1 x 1) is dark: drawImage of an empty canvas throws
  // in a 2D context, and there is nothing to see.
  const tooSmall = () => canvas.width < 2 || canvas.height < 2

  // Rasterise every channel into the field texture: every levee first, then every channel body in the
  // strips' order (sheet last), so no levee ever sits on a neighbouring body where channels meet.
  function renderField() {
    if (tooSmall()) return
    const { vertices, indices, order, ranges } = strips
    gl.bindVertexArray(gpu.fieldVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW)

    // The texture is sized to the canvas, so a new layout gets a new target.
    if (gpu.target) deleteFieldTarget(gl, gpu.target)
    gpu.target = createFieldTarget(gl, canvas.width, canvas.height, gpu.float)
    gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.target.fbo)
    // The viewport does not follow the canvas when it is resized, so every pass sets its own.
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(gpu.fieldProgram)
    gl.uniform2f(gpu.fieldResolution, canvas.width, canvas.height)
    for (const id of order) drawRange(ranges[id].levee)
    for (const id of order) drawRange(ranges[id].channel)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    fieldPasses++
  }

  function resize(w, h, flows) {
    const cw = Math.round(w * scale)
    const ch = Math.round(h * scale)
    const empty = !(cw > 0 && ch > 0)
    canvas.width = empty ? 1 : cw
    canvas.height = empty ? 1 : ch
    const scaled = scaleFlows(flows, scale)
    packArgs.flows = flows
    if (scaled.length !== channels) igniteNext = true
    channels = scaled.length
    strips = buildStrips(scaled, { levee: LEVEE })
    let widest = 0
    scaled.forEach((f, i) => {
      lengths[i] = lengthOf(f.pts)
      if (f.widthAt) widest = Math.max(widest, f.widthAt(0))
    })
    frameExtras.box = bounds(scaled, LEVEE * widest)
    frameExtras.width = canvas.width
    frameExtras.height = canvas.height
    // While the context is lost the new layout is only remembered; the restore renders it.
    if (ok) renderField()
  }

  // Bind a texture to a unit: the field is on 0, the sim on 1 and the palette on 2 for the lava pass.
  function bind(unit, texture) {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  // One step of the heat simulation: read the latest state, write the next into the other target and make
  // that the latest. The clock moves on first, so every step, stepN's too, gets its own noise.
  function simStep(dt, packed) {
    const s = simUniforms(packArgs.tune, dt, phone)
    const map = parents(packArgs.flows)
    simClock += s.uDt
    simExtras.time = simClock
    simExtras.ignite = igniteNext
    simExtras.surge = packed.uSurge
    simExtras.parent = map.parent
    simExtras.attach = map.attach
    const { sim, simNow } = gpu
    gl.bindFramebuffer(gl.FRAMEBUFFER, sim[1 - simNow].fbo)
    // The pass covers the whole sim texture, whatever size the canvas is.
    gl.viewport(0, 0, size.along, size.across * MAX_CHANNELS)
    gl.useProgram(gpu.simProgram)
    gl.bindVertexArray(gpu.lavaVao)
    bind(0, sim[simNow].texture)
    uploadSim(gl, gpu.simLoc, s, simExtras)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gpu.simNow = 1 - simNow
    igniteNext = false
    simPasses++
  }

  function draw(frame) {
    if (!ok) return
    const rects = frame.calmRects
    const calmCount = Math.min(rects.length, MAX_CALM)
    for (let i = 0; i < calmCount; i++) {
      const r = rects[i]
      const slot = calmPool[i]
      slot.l = r.l * scale
      slot.t = r.t * scale
      slot.r = r.r * scale
      slot.b = r.b * scale
      calm[i] = slot
    }
    calm.length = calmCount
    packArgs.flows = frame.flows
    packArgs.calmShift = frame.calmShift * scale
    packArgs.tune = frame.tune
    packArgs.density = frame.density
    packArgs.t = frame.t
    const u = packUniforms(packArgs)
    // The sim runs even with nothing to show, so it is warm when the channels come back. A caller that gives
    // no frame time gets a sixtieth of a second, not a NaN in the sim's state.
    simStep(frame.secs ?? 1 / 60, u)

    // A draw before the first field pass has no target to sample either.
    if (!gpu.target || tooSmall() || frame.flows.length === 0) return
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(gpu.lavaProgram)
    gl.bindVertexArray(gpu.lavaVao)
    bind(0, gpu.target.texture)
    bind(1, gpu.sim[gpu.simNow].texture)
    bind(2, gpu.palette)
    uploadFrame(gl, gpu.loc, u, frameExtras)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    drawCalls++
  }

  // Run the sim `n` steps of 1/30 s each and draw nothing: a still page's lava is settled this way before
  // its one frame. The steps follow the last drawn frame's tune and flows, or the shipped tune before one.
  function stepN(n) {
    if (!ok) return
    const packed = packUniforms(packArgs)
    for (let i = 0; i < n; i++) simStep(STEP, packed)
  }

  function ignite() {
    igniteNext = true
  }

  // The latest sim state as RGBA bytes, for tools: `out` holds simSize.along * simSize.across * 12 * 4 of them.
  function readSim(out) {
    if (!ok) return
    if (gpu.float && readBuffer?.length !== out.length) readBuffer = new Float32Array(out.length)
    readTarget(gl, gpu.sim[gpu.simNow], size.along, size.across * MAX_CHANNELS, out, gpu.float ? readBuffer : null)
  }

  // Preventing the default is what lets the browser restore the context later. Every GL handle is dead
  // once it is lost, so drop them rather than keep ones that would only raise errors if used.
  function onLost(event) {
    event.preventDefault()
    ok = false
    gpu = null
  }

  function onRestored() {
    gpu = buildGpu(gl, size)
    if (!gpu) return
    ok = true
    igniteNext = true
    renderField()
  }

  function dispose() {
    // Listeners go first so that losing the context here is not mistaken for a loss to recover from.
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    ok = false
    gpu = null
  }

  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    canvas,
    resize,
    draw,
    stepN,
    ignite,
    readSim,
    dispose,
    get ok() { return ok },
    get fieldPasses() { return fieldPasses },
    get drawCalls() { return drawCalls },
    get simPasses() { return simPasses },
    get simSize() { return size },
  }
}
