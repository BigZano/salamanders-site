/**
 * The mechanical GL pieces under the lava layer: building a program and making the field's render
 * target. They hold no layer state, so each takes the context and hands back what it made.
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

/**
 * A w by h texture with a framebuffer drawing into it. Half floats when `float` is true; otherwise
 * bytes, and the caller's shaders must pack `across` themselves (it chooses the sources, so it already
 * knows). It is sampled by pixel, so NEAREST: a filtered sample would blend channel ids into nonsense.
 */
export function createFieldTarget(gl, w, h, float) {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { texture, fbo }
}

export function deleteFieldTarget(gl, target) {
  gl.deleteFramebuffer(target.fbo)
  gl.deleteTexture(target.texture)
}
