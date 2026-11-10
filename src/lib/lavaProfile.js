/**
 * The shape of a lava flow's speed, and the packing of everything the lava
 * shader reads each frame.
 *
 * Both are pure so they can be tested without a GL context. The velocity formula
 * is written out again in GLSL, in lavaShader.glsl.js and lavaSim.glsl.js, so change
 * the three together.
 */

// How many channels and calm rects the fragment shader's uniform arrays hold.
// These must match the array sizes declared in the shader source.
export const MAX_CHANNELS = 12
export const MAX_CALM = 8

/**
 * Speed of the lava at one point on a channel.
 *
 * `across` runs -1..1 from bank to bank and `along` 0..1 from the vent to the
 * toe. Lava is not water: it is a Bingham-ish fluid that sticks to its banks
 * and slides on a plug down the middle, so the speed falls to zero at the
 * banks and the more viscous the flow, the sharper that plug gets. The
 * exponent runs from a parabola (1) when runny to a blunt plug (4) when stiff.
 * Along the flow it slows toward the toe, where the lava has cooled and
 * stiffened.
 */
export function velocity(across, along, viscosity) {
  return Math.pow(Math.max(0, 1 - across * across), 1 + 3 * viscosity) * (1.5 - 1.2 * along)
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Each channel gets a fixed phase so neighbouring flows do not pulse in step.
// 7.31 is arbitrary but not close to a whole number, so the fractions spread.
const PHASE = new Float32Array(MAX_CHANNELS)
// How far each channel's pattern has flowed, in seconds of flow: integrated in the volcano so a surge can
// speed the flow up for a while and the pattern never jumps.
const FLOW = new Float32Array(MAX_CHANNELS)
for (let i = 0; i < MAX_CHANNELS; i++) PHASE[i] = (i * 7.31) % 1

// The arrays and the result are built once and refilled on every call. The
// draw loop hands these straight to gl.uniform*, and allocating a handful of
// typed arrays sixty times a second is garbage the phone does not need.
const SURGE = new Float32Array(MAX_CHANNELS)
const CALM = new Float32Array(MAX_CALM * 4)

const packed = {
  uTime: 0,
  uCrust: 0,
  uViscosity: 0,
  uCracks: 0,
  uFoldScale: 0,
  uBreakoutRate: 0,
  uDensity: 0,
  uOctaves: 0,
  uSurge: SURGE,
  uPhase: PHASE,
  uFlow: FLOW,
  uCalm: CALM,
  uCalmCount: 0,
}

/**
 * Pack one frame's state into the shader's uniform values.
 *
 * `flows[i].surge` is -1 when a channel is not surging. Calm rects are the
 * page content the lava should stay quiet behind; they are measured in page
 * coordinates, so `calmShift` moves their vertical edges by the scroll.
 * Tunables are clamped here to the ranges the tuner offers, so a stale saved
 * value or a hand-typed query parameter cannot push the shader out of range.
 * The returned object and its typed arrays are shared between calls.
 */
export function packUniforms({ flows, calmRects, calmShift, tune, density, t, phone }) {
  for (let i = 0; i < MAX_CHANNELS; i++) {
    const flow = flows[i]
    SURGE[i] = flow ? (flow.surge ?? -1) : -1
    // The slot after the last flow is the pool's, if there is one. Its clock stays at 0: the plates sit still there (no
    // drifting plate noise, a static skin net) and the sim's own drift term moves the crust. A stale clock from a
    // longer flow list is cleared here, which is why every slot is written.
    FLOW[i] = i < flows.length ? (flows[i].flowDist ?? 0) : 0
  }

  const calmCount = Math.min(calmRects.length, MAX_CALM)
  for (let i = 0; i < calmCount; i++) {
    const rect = calmRects[i]
    CALM[i * 4] = rect.l
    CALM[i * 4 + 1] = rect.t + calmShift
    CALM[i * 4 + 2] = rect.r
    CALM[i * 4 + 3] = rect.b + calmShift
  }

  packed.uTime = t
  packed.uCrust = clamp(tune.crust, 0, 1)
  packed.uViscosity = clamp(tune.viscosity, 0, 1)
  packed.uCracks = clamp(tune.cracks, 0, 2)
  packed.uFoldScale = clamp(tune.foldScale, 0.25, 3)
  packed.uBreakoutRate = clamp(tune.breakoutRate, 0, 4)
  packed.uDensity = density
  // Fewer octaves of the crust noise on a phone: the cracks lose their finest
  // detail, which a small screen cannot show anyway, and the fill rate drops.
  packed.uOctaves = phone ? 3 : 4
  packed.uCalmCount = calmCount
  return packed
}
