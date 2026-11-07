/**
 * The mechanical GL pieces under the lava layer: building a program, making the field's and the heat
 * simulation's render targets and the palette texture, and reading a target back. They hold no layer
 * state, so each takes the context and hands back what it made.
 */

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  if (import.meta.env.DEV) console.warn('lava shader: compile failed\n', gl.getShaderInfoLog(shader))
  gl.deleteShader(shader)
  return null
}

/**
 * Compile both shaders and link them, or return null if either step fails. A production page says
 * nothing and falls back to the ribbons; in development the driver's log is warned, since a null alone
 * would hide which line of GLSL it disliked.
 */
export function compileProgram(gl, vertSrc, fragSrc) {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSrc)
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc)
  let program = null
  if (vert && frag) {
    program = gl.createProgram()
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (import.meta.env.DEV) console.warn('lava shader: link failed\n', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      program = null
    }
  }
  // A linked program keeps its own copy, so the shader objects are not needed again.
  if (vert) gl.deleteShader(vert)
  if (frag) gl.deleteShader(frag)
  return program
}

// A bound texture with its sampler state set: the same filter on both axes, clamped to the edge.
function newTexture(gl, filter) {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

// A w by h render target: half floats when `float` is true, otherwise bytes.
function newTarget(gl, w, h, float, filter) {
  const texture = newTexture(gl, filter)
  if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { texture, fbo }
}

/**
 * The field's w by h target. When `float` is false it is bytes, and the caller's shaders must pack
 * `across` themselves (it chooses the sources, so it already knows). It is sampled by pixel, so NEAREST: a
 * filtered sample would blend channel ids into nonsense.
 */
export function createFieldTarget(gl, w, h, float) {
  return newTarget(gl, w, h, float, gl.NEAREST)
}

export function deleteFieldTarget(gl, target) {
  gl.deleteFramebuffer(target.fbo)
  gl.deleteTexture(target.texture)
}

/**
 * The heat simulation's pair of w by h targets, one read while the other is written. Unlike the field
 * they are LINEAR: the sim reads between cells, and NEAREST would turn that upstream read into a step.
 */
export function createSimTargets(gl, w, h, float) {
  return [newTarget(gl, w, h, float, gl.LINEAR), newTarget(gl, w, h, float, gl.LINEAR)]
}

export function deleteSimTargets(gl, targets) {
  for (const target of targets) deleteFieldTarget(gl, target)
}

/** The palette as a one row RGB texture, one texel per three bytes of `bytes`, filtered between steps. */
export function createPaletteTexture(gl, bytes) {
  const texture = newTexture(gl, gl.LINEAR)
  // A row of 37 texels is 111 bytes, which the default 4 byte row alignment would misread.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, bytes.length / 3, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  return texture
}

/**
 * Read a whole w by h target into `out` as RGBA bytes. A half float target cannot be read as bytes (the
 * context raises INVALID_OPERATION), so with a `floats` buffer of the same length it is read as floats and
 * rounded to bytes, clamped to 0..1. Without one the target is bytes and is read straight into `out`.
 * For tools and tests only: a read stalls the GPU.
 */
export function readTarget(gl, target, w, h, out, floats) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
  if (floats) {
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, floats)
    for (let i = 0; i < w * h * 4; i++) out[i] = Math.round(Math.min(1, Math.max(0, floats[i])) * 255)
  } else {
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
}
