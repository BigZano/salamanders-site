/**
 * The GPU side of the lava layer: whether this page may use the shader at all, and everything the layer
 * holds in its context once it does.
 *
 * `supportsLavaShader` and `hasWebGL2` are plain functions over a `win` argument so they can be tested
 * without a browser. `buildGpu` is what `createLavaLayer` calls to make its programs, buffers and
 * textures, and again to remake them after a lost context is restored.
 */

import { MAX_CHANNELS } from './lavaProfile'
import { STRIDE } from './lavaStrips'
import { paletteBytes } from './lavaSim'
import { compileProgram, createSimTargets, createPaletteTexture } from './lavaGl'
import { FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG, UNIFORMS } from './lavaShader.glsl'
import { SIM_VERT, SIM_FRAG, SIM_UNIFORMS } from './lavaSim.glsl'

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

// The field pass's attributes: [name, floats, offset in floats] in the order lavaStrips lays a vertex out.
const ATTRIBUTES = [['aPos', 2, 0], ['aAcross', 1, 2], ['aAlong', 1, 3], ['aHalf', 1, 4], ['aHeat', 1, 5], ['aId', 1, 6]]

/**
 * Everything the layer owns on the GPU, or null if a program will not build. Kept in one object so that
 * losing the context is a single `gpu = null` and a restore is a single call to this. The field target
 * is made by the layer's `renderField`, once the canvas has its size. `sim` is the heat simulation's pair
 * of targets, `grid` cells big, and `simNow` the index of the one that holds its latest state.
 */
export function buildGpu(gl, grid) {
  // A float field holds `across` as it is. Without float rendering the field is bytes, and both fragment
  // shaders pack and unpack `across` themselves when they see the define on the line after #version.
  const float = Boolean(gl.getExtension('EXT_color_buffer_float'))
  const sourceFor = (source) => (float ? source : source.replace('#version 300 es\n', '#version 300 es\n#define FIELD_PACKED\n'))
  const fieldProgram = compileProgram(gl, FIELD_VERT, sourceFor(FIELD_FRAG))
  const lavaProgram = compileProgram(gl, LAVA_VERT, sourceFor(LAVA_FRAG))
  const simProgram = compileProgram(gl, SIM_VERT, SIM_FRAG)
  if (!fieldProgram || !lavaProgram || !simProgram) {
    for (const program of [fieldProgram, lavaProgram, simProgram]) if (program) gl.deleteProgram(program)
    return null
  }

  // Looked up once: asking the driver for a location by name every frame is slow on a phone.
  const loc = {}
  for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(lavaProgram, name)
  const simLoc = {}
  for (const name of SIM_UNIFORMS) simLoc[name] = gl.getUniformLocation(simProgram, name)

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
  // The lava and sim passes take their corners from gl_VertexID, so their VAO stays empty.
  const lavaVao = gl.createVertexArray()
  gl.bindVertexArray(null)

  // The output is premultiplied for the 2D canvas to composite, so the GPU must not blend it again.
  gl.disable(gl.BLEND)
  return {
    float, fieldProgram, lavaProgram, simProgram, loc, simLoc, fieldResolution: gl.getUniformLocation(fieldProgram, 'uResolution'),
    vertexBuffer, indexBuffer, fieldVao, lavaVao, target: null,
    sim: createSimTargets(gl, grid.along, grid.across * MAX_CHANNELS, float), simNow: 0, palette: createPaletteTexture(gl, paletteBytes()),
  }
}
