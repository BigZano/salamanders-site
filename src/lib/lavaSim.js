/**
 * The helpers the lava layer calls to run its heat simulation.
 *
 * The simulation is a small grid per channel: heat enters at the vent, flows
 * toward the toe and cools on the way, and the lava shader reads the result
 * through the title fire's palette. Everything here is pure so it can be tested
 * without a GL context. The result objects and typed arrays are built once and
 * refilled on every call, because the draw loop hands them straight to GL and
 * allocating them sixty times a second is garbage the phone does not need.
 */

import { DOOM_PALETTE } from './doomfire'
import { MAX_CHANNELS } from './lavaProfile'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Cells per channel: `along` runs vent to toe, `across` runs bank to bank. A
// phone gets half the resolution on each axis, which is a quarter of the work.
const DESKTOP_SIZE = Object.freeze({ along: 256, across: 32 })
const PHONE_SIZE = Object.freeze({ along: 128, across: 16 })

/** The simulation grid size for this device. The returned objects are shared. */
export function simSize(phone) {
  return phone ? PHONE_SIZE : DESKTOP_SIZE
}

// The palette as tightly packed r, g, b bytes, ready to upload as a texture.
const PALETTE_BYTES = new Uint8Array(DOOM_PALETTE.length * 3)
for (let i = 0; i < DOOM_PALETTE.length; i++) {
  PALETTE_BYTES[i * 3] = DOOM_PALETTE[i][0]
  PALETTE_BYTES[i * 3 + 1] = DOOM_PALETTE[i][1]
  PALETTE_BYTES[i * 3 + 2] = DOOM_PALETTE[i][2]
}

/** The title fire's palette, flattened in order. The returned array is shared. */
export function paletteBytes() {
  return PALETTE_BYTES
}

// The parent of a slot no flow fills: the sim keeps that block empty instead of running it as a second sheet.
export const NO_CHANNEL = -2

// The parent of the pool's block. The sim treats it as neither a sheet nor an arm (lavaSim.glsl.js).
export const POOL = -3

const PARENT = new Float32Array(MAX_CHANNELS)
const ATTACH = new Float32Array(MAX_CHANNELS)
const DRAIN = new Float32Array(MAX_CHANNELS)
const DRAIN_AT = new Float32Array(MAX_CHANNELS)
const VENT = new Float32Array(MAX_CHANNELS)
const channels = { parent: PARENT, attach: ATTACH, drain: DRAIN, drainAt: DRAIN_AT, vent: VENT }

/**
 * Where each channel gets its lava from, where it sends it, and which block is the pool.
 *
 * `parent[i]` is the index into `flows` of the channel that channel `i` starts on, or -1 when it starts on a
 * vent row of its own: no parent, or an index that does not name a channel. `attach[i]` is how far along that
 * parent, 0..1, the branch starts, and 0 when the flow does not say. A braid has both a parent it starts on and a
 * drain back into it.
 *
 * `drain[i]` is the channel that channel `i` ends in: its index, or -1 for the pool, or NO_CHANNEL when the flow
 * names none (or names a channel that is not there, or itself). `drainAt[i]` means two things. For a channel that
 * drains into another channel it is where along that channel, 0..1: the flow's own `drainAt`, 1 when it says none.
 * For a channel that drains into the pool (`drain` -1) it is the channel's ENTRY POSITION across the pool's arc,
 * -1..1, 0 under the trunk's end: the flow's own `drainAt` clamped to that, 0 when it says none. It is 0 for a
 * channel that drains nowhere.
 *
 * `vent[i]` is the share of the vent heat the channel's vent row gets: the flow's `heat` clamped to 0..1 (1 when
 * it has none), 1 for the pool's slot, 0 for a slot no flow fills. Only a vent-fed block (parent -1) reads it.
 *
 * Slots past the last flow read as NO_CHANNEL and 0, except the slot at `flows.length` when `pool` is given: it
 * reads POOL, the sim's pool block. A full house of MAX_CHANNELS flows leaves no slot, and the pool is dropped.
 * The returned object and its typed arrays are shared between calls.
 */
export function channelMap(flows, pool) {
  const count = Math.min(flows.length, MAX_CHANNELS)
  for (let i = 0; i < MAX_CHANNELS; i++) {
    const flow = i < count ? flows[i] : null
    const p = flow ? flow.parent : undefined
    const d = flow ? flow.drain : undefined
    PARENT[i] = !flow ? (pool && i === count ? POOL : NO_CHANNEL) : Number.isInteger(p) && p >= 0 && p < count ? p : -1
    ATTACH[i] = flow ? (flow.attach ?? 0) : 0
    DRAIN[i] = flow && (d === -1 || (Number.isInteger(d) && d >= 0 && d < count && d !== i)) ? d : NO_CHANNEL
    const at = flow ? flow.drainAt : undefined
    DRAIN_AT[i] = DRAIN[i] === NO_CHANNEL ? 0 : DRAIN[i] === -1 ? (Number.isFinite(at) ? clamp(at, -1, 1) : 0) : Number.isFinite(at) ? clamp(at, 0, 1) : 1
    VENT[i] = flow ? (Number.isFinite(flow.heat) ? clamp(flow.heat, 0, 1) : 1) : pool && i === count ? 1 : 0
  }
  return channels
}

/** The channel map without a pool: what the layer called before the pool had a block. Same arrays as `channelMap`. */
export const parents = (flows) => channelMap(flows, null)

const uniforms = {
  uDt: 0,
  uSource: 0,
  uCool: 0,
  uVisc: 0,
  uBreak: 0,
  uCrackGlow: 0,
}

/**
 * Turn the tunables and the frame time into the simulation's uniform values.
 *
 * `dt` is capped at 50 ms so a stalled tab does not feed the simulation one
 * huge step on its return. Heat 1 gives a source of 0.9 of the palette; a
 * surge adds the rest up to the top. Tunables are clamped to the ranges the
 * tuner offers, as in `packUniforms`. `phone` is part of the signature so the
 * caller need not change if a phone ever wants different values; none do yet.
 * The returned object is shared between calls.
 */
export function simUniforms(tune, dt, phone) {
  uniforms.uDt = Math.min(dt, 0.05)
  uniforms.uSource = clamp(tune.heat, 0, 2) * 0.9
  uniforms.uCool = clamp(tune.crust, 0, 1)
  uniforms.uVisc = clamp(tune.viscosity, 0, 1)
  uniforms.uBreak = clamp(tune.breakoutRate, 0, 4)
  uniforms.uCrackGlow = clamp(tune.cracks, 0, 2)
  return uniforms
}
