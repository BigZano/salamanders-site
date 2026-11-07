/**
 * The uniform uploads for the lava layer's two programs, kept apart from the layer so it stays readable.
 *
 * Each takes the program's location table (looked up once, by name), the values `packUniforms` or
 * `simUniforms` produced, and `extras` for what only the layer knows. Nothing here allocates: the draw loop
 * calls these sixty times a second, and the layer reuses one extras object for each.
 */

// The lava pass's single floats; packUniforms supplies all of them.
const SCALARS = ['uHeat', 'uViscosity', 'uCracks', 'uFoldScale', 'uDensity']

// The sim clock wraps here. The shader's noise hash loses precision as its seed grows, and an hour of
// seconds is far past what anyone watches the volcano for.
const CLOCK_WRAP = 3600

/**
 * Set every uniform of the lava pass. The field is on texture unit 0, the sim on 1 and the palette on 2.
 *
 * `extras` is `{ lengths, width, height, box, size }`: the channel lengths, the drawing buffer's size, the
 * bounds quad and the sim's `{ along, across }`.
 */
export function uploadFrame(gl, loc, u, extras) {
  for (let i = 0; i < SCALARS.length; i++) gl.uniform1f(loc[SCALARS[i]], u[SCALARS[i]])
  gl.uniform1i(loc.uOctaves, u.uOctaves)
  gl.uniform1i(loc.uCalmCount, u.uCalmCount)
  gl.uniform1fv(loc.uHeatPer, u.uHeatPer)
  gl.uniform1fv(loc.uFlow, u.uFlow)
  gl.uniform4fv(loc.uCalm, u.uCalm)
  gl.uniform1fv(loc.uLength, extras.lengths)
  gl.uniform1i(loc.uField, 0)
  gl.uniform1i(loc.uSim, 1)
  gl.uniform1i(loc.uPalette, 2)
  gl.uniform2f(loc.uSimSize, extras.size.along, extras.size.across)
  gl.uniform2f(loc.uResolution, extras.width, extras.height)
  gl.uniform4f(loc.uBounds, extras.box.x, extras.box.y, extras.box.w, extras.box.h)
}

/**
 * Set every uniform of the sim pass. The previous state is on texture unit 0.
 *
 * `s` is `simUniforms`' result; its `uCrackGlow` is not sent, because the crack glow is the lava pass's
 * `uCracks`. `extras` is `{ size, time, ignite, surge, parent, attach }`: the sim's `{ along, across }`, the
 * sim clock in seconds, whether this step writes the cold state, and the three per-channel arrays.
 */
export function uploadSim(gl, loc, s, extras) {
  gl.uniform1i(loc.uPrev, 0)
  gl.uniform2f(loc.uSimSize, extras.size.along, extras.size.across)
  gl.uniform1f(loc.uDt, s.uDt)
  gl.uniform1f(loc.uTime, extras.time % CLOCK_WRAP)
  gl.uniform1f(loc.uSource, s.uSource)
  gl.uniform1f(loc.uCool, s.uCool)
  gl.uniform1f(loc.uVisc, s.uVisc)
  gl.uniform1f(loc.uBreak, s.uBreak)
  gl.uniform1fv(loc.uSurge, extras.surge)
  gl.uniform1fv(loc.uParent, extras.parent)
  gl.uniform1fv(loc.uAttach, extras.attach)
  gl.uniform1f(loc.uIgnite, extras.ignite ? 1 : 0)
}
