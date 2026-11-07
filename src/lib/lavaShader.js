/**
 * The lava shader's layer: whether to use it, and how it draws.
 *
 * `supportsLavaShader` and `hasWebGL2` are plain functions over a `win` argument so they can be tested
 * without a browser. `createLavaLayer` wraps the rest: the strips, the profile uniforms and the two GLSL
 * passes, behind a canvas the volcano composites into its own 2D context.
 */

import { packUniforms, MAX_CHANNELS, MAX_CALM } from './lavaProfile'
import { buildStrips, bounds, STRIDE } from './lavaStrips'
import { compileProgram, createFieldTarget, deleteFieldTarget } from './lavaGl'
import { FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG, UNIFORMS } from './lavaShader.glsl'

/**
 * Whether the page was told to force the shader on or off.
 *
 * `?lava=0` forces the ribbons, `?lava=1` forces the shader on when the browser
 * has WebGL2, and anything else leaves the choice to the capability check
 * ('auto'). With no `search` given it reads the current page's query string, so
 * the volcano can call it bare. Outside a browser there is no query string, and
 * the answer is 'auto'.
 */
export function supportsLavaShader({ search, win = typeof window === 'undefined' ? undefined : window } = {}) {
  const query = search ?? win?.location?.search ?? ''
  const flag = new URLSearchParams(query).get('lava')
  if (flag === '0') return 'off'
  if (flag === '1') return 'on'
  return 'auto'
}

/**
 * Whether a WebGL2 context can really be made here.
 *
 * Checking for the constructor is not enough: a browser can expose it and still
 * refuse a context (a blocklisted GPU, or hardware acceleration switched off),
 * so a throwaway canvas is asked for one. The probe context is released at once,
 * because browsers cap how many live contexts a page may hold and the real layer
 * needs its own.
 */
export function hasWebGL2(win) {
  if (!win || !('WebGL2RenderingContext' in win)) return false
  try {
    const gl = win.document.createElement('canvas').getContext('webgl2')
    if (!gl) return false
    gl.getExtension?.('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    // Some browsers throw rather than return null when a context is refused.
    return false
  }
}

// How far past the bank the levee reaches, in channel half widths. The shader's LEVEE is the same number.
const LEVEE = 2.2

// The field pass's attributes: [name, floats, offset in floats] in the order lavaStrips lays a vertex out.
const ATTRIBUTES = [['aPos', 2, 0], ['aAcross', 1, 2], ['aAlong', 1, 3], ['aHalf', 1, 4], ['aHeat', 1, 5], ['aId', 1, 6]]

// The lava pass's single floats; packUniforms supplies all of them.
const SCALARS = ['uTime', 'uCrust', 'uHeat', 'uViscosity', 'uCracks', 'uFoldScale', 'uBreakoutRate', 'uDensity']

/**
 * Everything the layer owns on the GPU, or null if a program will not build. Kept in one object so that
 * losing the context is a single `gpu = null` and a restore is a single call to this. The field target
 * is made by `renderField`, once the canvas has its size.
 */
function buildGpu(gl) {
  // A float field holds `across` as it is. Without float rendering the field is bytes, and both fragment
  // shaders pack and unpack `across` themselves when they see the define on the line after #version.
  const float = Boolean(gl.getExtension('EXT_color_buffer_float'))
  const sourceFor = (source) => (float ? source : source.replace('#version 300 es\n', '#version 300 es\n#define FIELD_PACKED\n'))
  const fieldProgram = compileProgram(gl, FIELD_VERT, sourceFor(FIELD_FRAG))
  const lavaProgram = compileProgram(gl, LAVA_VERT, sourceFor(LAVA_FRAG))
  if (!fieldProgram || !lavaProgram) {
    if (fieldProgram) gl.deleteProgram(fieldProgram)
    if (lavaProgram) gl.deleteProgram(lavaProgram)
    return null
  }

  // Looked up once: asking the driver for a location by name every frame is slow on a phone.
  const loc = {}
  for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(lavaProgram, name)

  const vertexBuffer = gl.createBuffer()
  const indexBuffer = gl.createBuffer()
  const fieldVao = gl.createVertexArray()
  gl.bindVertexArray(fieldVao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  for (const [name, size, offset] of ATTRIBUTES) {
    const at = gl.getAttribLocation(fieldProgram, name)
    // The compiler drops aHeat (unread), and a dropped attribute has no location.
    if (at < 0) continue
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, STRIDE * 4, offset * 4)
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  // The lava pass takes its corners from gl_VertexID, so its VAO stays empty.
  const lavaVao = gl.createVertexArray()
  gl.bindVertexArray(null)

  // The output is premultiplied for the 2D canvas to composite, so the GPU must not blend it again.
  gl.disable(gl.BLEND)
  return {
    float, fieldProgram, lavaProgram, loc, fieldResolution: gl.getUniformLocation(fieldProgram, 'uResolution'),
    vertexBuffer, indexBuffer, fieldVao, lavaVao, target: null,
  }
}

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
 * `ok` is false while the context is lost, and `draw` does nothing until it is restored. The layer keeps
 * the last layout on the CPU, so a restore re-uploads it rather than asking the volcano to resize.
 */
export function createLavaLayer({ win = typeof window === 'undefined' ? undefined : window, phone } = {}) {
  if (!hasWebGL2(win)) return null
  const canvas = win.document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false })
  if (!gl) return null
  let gpu = buildGpu(gl)
  if (!gpu) {
    // Give the context back: browsers cap how many a page may hold.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }

  const scale = phone ? 0.5 : Math.min(win.devicePixelRatio || 1, 2)
  let ok = true
  let fieldPasses = 0
  let drawCalls = 0
  let strips = buildStrips([], { levee: LEVEE })
  let box = { x: 0, y: 0, w: 0, h: 0 }
  const lengths = new Float32Array(MAX_CHANNELS)
  // Calm rects are scaled into these slots each frame, so a frame allocates nothing of its own.
  const calmPool = Array.from({ length: MAX_CALM }, () => ({ l: 0, t: 0, r: 0, b: 0 }))
  const calm = []
  const packArgs = { flows: null, calmRects: calm, calmShift: 0, tune: null, density: 1, t: 0, phone }

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
    strips = buildStrips(scaled, { levee: LEVEE })
    let widest = 0
    scaled.forEach((f, i) => {
      lengths[i] = lengthOf(f.pts)
      if (f.widthAt) widest = Math.max(widest, f.widthAt(0))
    })
    box = bounds(scaled, LEVEE * widest)
    // While the context is lost the new layout is only remembered; the restore renders it.
    if (ok) renderField()
  }

  function draw(frame) {
    // A draw before the first field pass has no target to sample either.
    if (!ok || !gpu.target || tooSmall() || frame.flows.length === 0) return
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

    const { loc } = gpu
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(gpu.lavaProgram)
    gl.bindVertexArray(gpu.lavaVao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, gpu.target.texture)
    gl.uniform1i(loc.uField, 0)
    for (let i = 0; i < SCALARS.length; i++) gl.uniform1f(loc[SCALARS[i]], u[SCALARS[i]])
    gl.uniform1i(loc.uOctaves, u.uOctaves)
    gl.uniform1i(loc.uCalmCount, u.uCalmCount)
    gl.uniform1fv(loc.uSurge, u.uSurge)
    gl.uniform1fv(loc.uHeatPer, u.uHeatPer)
    gl.uniform1fv(loc.uPhase, u.uPhase)
    gl.uniform4fv(loc.uCalm, u.uCalm)
    gl.uniform1fv(loc.uLength, lengths)
    gl.uniform2f(loc.uResolution, canvas.width, canvas.height)
    gl.uniform4f(loc.uBounds, box.x, box.y, box.w, box.h)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    drawCalls++
  }

  // Preventing the default is what lets the browser restore the context later. Every GL handle is dead
  // once it is lost, so drop them rather than keep ones that would only raise errors if used.
  function onLost(event) {
    event.preventDefault()
    ok = false
    gpu = null
  }

  function onRestored() {
    gpu = buildGpu(gl)
    if (!gpu) return
    ok = true
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
    dispose,
    get ok() { return ok },
    get fieldPasses() { return fieldPasses },
    get drawCalls() { return drawCalls },
  }
}
