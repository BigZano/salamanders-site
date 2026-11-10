/**
 * GLSL ES 3.00 sources for the lava shader, kept apart from the layer so tests can read them.
 *
 * Two passes. The field pass rasterises every channel's triangle strips once per layout into a
 * texture: R = across (-1.25 to 1.25, 0 at the centre), G = along (0 at the vent, 1 at the toe),
 * B = channel id / 255, A = the channel's half width in px / 255 (0 where no channel is, so coverage
 * is A > 0; the layer clears the field to zero and draws it with blending off). The lava pass then
 * runs each frame over the channels' bounding box, reads that texture and paints the lava (spec 4.2).
 *
 * The lava pass also reads the heat simulation (lavaSim.glsl.js): uSim holds 12 channel blocks of ACROSS
 * rows by ALONG columns, RGBA = heat, crust, pressure, age, and uSimSize = (ALONG, ACROSS). It wants LINEAR
 * filtering and CLAMP_TO_EDGE. uPalette is the title's DOOM_PALETTE as a 37 x 1 texture, read at (heat, 0.5).
 *
 * If the field texture is RGBA8 rather than float, the layer inserts "#define FIELD_PACKED" on the
 * line after "#version 300 es" in FIELD_FRAG and LAVA_FRAG. across is then stored as
 * (across / LEVEE) * 0.5 + 0.5 with LEVEE 1.25 in both fragments, and the lava pass unpacks it. Do not put anything
 * before #version.
 *
 * Both vertex shaders flip y (px run down the screen, clip space runs up), and the lava fragment
 * looks the field up at its own pixel, so the two passes agree on which texel is which.
 *
 * Things the layer must know. aHeat is in the vertex layout but unread (heat is the sim's), so the
 * compiler drops it and getAttribLocation returns -1: skip any location below 0. The sheet is flow
 * id 0, because buildFlows pushes it first; the sim feeds it from a hot source row, so the head of the
 * sheet needs no holding. The field wants NEAREST sampling, and all px (aPos, uBounds, uResolution, the
 * calm rects) are drawing-buffer px. uLength[id] is each channel's centreline length in px. The pool, when there is
 * one, is channel id uPoolId (flows.length; -1 for none): both passes are told it, since it has no start cap.
 */

// Every uniform the layer sets on the lava program. packUniforms supplies the per-frame floats and arrays;
// the layer sets the rest (each channel's length, the pool's id, the plate height, the field, sim and palette
// samplers, the sim size, the drawing buffer size and the quad).
export const UNIFORMS = [
  'uViscosity', 'uCracks', 'uFoldScale', 'uDensity', 'uOctaves', 'uCalm', 'uCalmCount', 'uPoolId', 'uPlateH',
  'uLength', 'uFlow', 'uField', 'uSim', 'uPalette', 'uSimSize', 'uResolution', 'uBounds',
]

export const FIELD_VERT = `#version 300 es
// Field pass vertex: one triangle strip vertex per call. aPos is in px, y down.
// aHeat is part of the vertex layout but unread (heat is the sim's), so the
// compiler drops it and getAttribLocation returns -1: the layer must skip a location below 0.
in vec2 aPos;
in float aAcross;
in float aAlong;
in float aHalf;
in float aHeat;
in float aId;
uniform vec2 uResolution;
out float across;
out float along;
out float halfPx;
flat out float id;
void main() {
  vec2 clip = aPos / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  across = aAcross;
  along = aAlong;
  halfPx = aHalf;
  id = aId;
}
`

export const FIELD_FRAG = `#version 300 es
precision highp float;
// Field pass fragment. With "#define FIELD_PACKED" (an RGBA8 field), across is stored as
// (across / LEVEE) * 0.5 + 0.5; along then keeps only 8 bits, which the lava pass lives with.
// Alpha is the half width in px over 255, which holds any channel and doubles as coverage.
in float across;
in float along;
in float halfPx;
flat in float id;
uniform float uPoolId;                // the pool's channel id (the strips' poolId), -1 for none: it has no start cap
const float LEVEE = 1.25;             // across at the levee ring's outer edge: the strip builder's ring, and the lava pass's
out vec4 fragColor;
void main() {
  // Where the lava pass's strip-end caps (its step 10, same sums) leave a channel's flat strip end invisible, leave the
  // pixel to whatever channel was drawn there first: a braid's head over its arm then shows the arm, not a dark bar.
  // The sheet (id 0) and the pool have no start cap.
  float a = abs(across), e = max(0.0, (along - 0.9) * 10.0), h = id < 0.5 || id == uPoolId ? 0.0 : max(0.0, (0.1 - along) * 10.0);
  if (e * e + a * a * step(0.001, e) >= 1.0 || h * h + a * a * step(0.001, h) >= 1.0) discard;
#ifdef FIELD_PACKED
  float r = (across / LEVEE) * 0.5 + 0.5;
#else
  float r = across;
#endif
  fragColor = vec4(r, along, id / 255.0, halfPx / 255.0);
}
`

export const LAVA_VERT = `#version 300 es
// Lava pass vertex: the uBounds quad (x, y, w, h in px, y down) as a 4 vertex triangle strip.
uniform vec4 uBounds;
uniform vec2 uResolution;
out vec2 vPx;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vPx = uBounds.xy + corner * uBounds.zw;
  vec2 clip = vPx / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`

export const LAVA_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
// Lava pass fragment (spec 4.2). With "#define FIELD_PACKED" the field is RGBA8 (see FIELD_FRAG).
// Sample it NEAREST so channel ids never blend. All px here are drawing-buffer px: uBounds,
// uResolution and the calm rects share one space, and vPx is the pixel's place in it, y down.
// The state (heat, crust, age) is the sim's; this pass only reads it, colours it and adds plate texture.
uniform float uDensity; uniform int uOctaves;                         // the page's glow; noise octaves
uniform float uViscosity; uniform float uCracks; uniform float uFoldScale;  // the tuner's viscosity, cracks and foldScale
uniform float uPoolId; uniform float uPlateH;   // the pool's channel id (-1 for none); the flows' own box height, for the plate size
uniform float uFlow[12]; uniform float uLength[12];  // per channel: flow clock, length in px
uniform vec4 uCalm[8]; uniform int uCalmCount;   // calm rects as l, t, r, b; only the first uCalmCount are live
uniform sampler2D uField; uniform sampler2D uSim; uniform sampler2D uPalette;
uniform vec2 uSimSize; uniform vec2 uResolution;  // sim cells as ALONG, ACROSS; then px
in vec2 vPx;
out vec4 fragColor;

// Look constants, tuned by name. The px ones are for a 600 px tall scene and scale with it.
const float LEVEE = 1.25;              // across at the outer edge of the levee ring (the strip builder's): room for the bank feather
const float CYCLE = 40.0;              // seconds the plate texture is carried before it starts again
const float SPEED = 3.0;               // px per second the plug at the centre carries the plates
const float WARP = 2.4;                // plate cells the domain warp pushes the noise along the flow, at full viscosity
const float WARP_FREQ = 0.4;           // the warp noise's frequency, against the plates'
const vec2 CELL = vec2(7.0, 18.0);     // size of a plate in px, across and along the flow
const float FOLD_PX = 28.0;            // wavelength of the fold ripples in px
const vec2 MARGIN = vec2(0.55, 0.95);  // across where the banks start and finish running hot
const vec3 ORANGE_GLOW = vec3(255.0, 136.0, 38.0) / 255.0 * 0.6;
const vec3 RUBBLE = vec3(52.0, 40.0, 34.0) / 255.0;
const float BANK_PX = 1.0;             // half width of the bank's edge, lava to nothing, in canvas px: a phone's half-res
                                       // canvas is scaled up 4x, and a 1 px edge on a slant shows as a stair there
const vec2 SOFT = vec2(0.5, 0.15);     // share of a pixel's sim state taken from the reads across and along it: softens the grid
const float SOFT_PX = 2.0;             // how far across those reads sit, in canvas px (at least a row): a phone's half-res
                                       // canvas gives a channel about 12 px for 16 rows, so a crust edge one row wide is a stair
const vec2 NET_CELL = vec2(9.0, 14.0); // px of a skin plate on the molten core, across and along; carried rigidly, so no bark
const vec2 NET_HEAT = vec2(0.85, 0.35); // sim heat at which the skin starts to close over the core, and is mostly closed:
                                        // an established arm runs at .45-.65 (real GPU), so its skin is half open
const float SEAM = 0.04;               // half width of the glowing seams between skin plates, in noise units
const float DEEP = 0.68;               // the open core's temperature against the sim's, away from hot spots and the breach
const float DEEP_POOL = 0.75;          // the same for the pool: a shade hotter than a trunk at the same heat
const float HOT = 0.22;                // what a hot spot (the noise's lowest tenth) adds to the temperature

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Normalised by the octaves actually summed, so a phone's 3 octaves keep the same range as 4.
float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(p);
    norm += amp;
    p = p * 2.03 + 11.7;
    amp *= 0.5;
  }
  return sum / max(norm, 0.001);
}
// Mirrors velocity() in lavaProfile.js and lavaSim.glsl.js: change the three together.
float velocity(float across, float along) {
  return pow(max(0.0, 1.0 - across * across), 1.0 + 3.0 * uViscosity) * (1.5 - 1.2 * along);
}
// Mirrors calmFactor() in MountDeathfire.vue: 1 in the clear, 0.1 under text, easing out over 48 px.
// Overlapping rects take the min, as calmFactor does, not the spec's product. It loops only to
// uCalmCount, because the slots past it hold stale rects.
float calm(vec2 p) {
  float k = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uCalmCount) break;
    vec4 r = uCalm[i];
    float d = length(max(max(r.xy - p, p - r.zw), 0.0));
    k = min(k, 0.1 + 0.9 * smoothstep(0.0, 1.0, d / 48.0));
  }
  return k;
}
// One layer of plates, x = plate noise, y = fold ripple. The noise is carried down the channel by
// the viscous profile s for ph of a CYCLE, so the banks and the centre shear apart for at most one
// CYCLE before the layer starts again. With one layer there is nothing to cross-fade, so the caller
// weights both outputs by sin(pi * ph): they are zero where ph wraps from 1 to 0 and the seed changes.
vec2 plates(float u, float v, float s, float ph, float seed, float along, float scale) {
  float vv = v - ph * CYCLE * s * SPEED * scale;
  vec2 cell = CELL * scale;
  vec2 p = vec2(u, vv) / cell + seed;
  float warp = (vnoise(p * WARP_FREQ + 7.7) - 0.5) * WARP * uViscosity;
  p.y += warp;
  float k = 6.2832 / (FOLD_PX * scale) * uFoldScale * (1.0 + 2.0 * along * uViscosity);
  return vec2(fbm(p, uOctaves), sin((vv + warp * cell.y) * k));
}
void main() {
  vec4 f = texture(uField, gl_FragCoord.xy / uResolution);
  float scale = max(uPlateH, 200.0) / 600.0;  // the flows' own box, not the bounds quad: the pool must not resize the plates
#ifdef FIELD_PACKED
  float across = (f.r * 2.0 - 1.0) * LEVEE;
#else
  float across = f.r;
#endif
  // 1. Coverage: the field is cleared to zero, and a channel's alpha is its half width over 255.
  if (f.a <= 0.0) discard;
  float hw = f.a * 255.0;
  int id = min(int(f.b * 255.0 + 0.5), 11);
  bool pool = float(id) == uPoolId;
  float along = clamp(f.g, 0.0, 1.0);
  float a = abs(across);
  // 2. Lava space, in px, so noise does not stretch with the channel's length.
  float u = across * hw;
  float v = along * uLength[id];
  // 3. The sim cell under this pixel, softened with four reads around it (SOFT_PX across, one column along): the grid is
  //    coarse against the canvas (a phone's 16 rows span about 12 canvas px), and one bilinear read shows its steps.
  //    row is one cell across; the across reads stay inside this channel's block of rows. The levee (|across| > 1) reads the bank.
  float ACROSS = uSimSize.y, row = 1.0 / (12.0 * ACROSS), cw = 1.0 / uSimSize.x; // cw: one cell along
  float sx = (along * (uSimSize.x - 1.0) + 0.5) * cw; // the sim's own column for this along (cell() in lavaSim.glsl.js)
  vec2 simUV = vec2(sx, (float(id) * ACROSS + (clamp(across, -1.0, 1.0) + 1.0) * 0.5 * (ACROSS - 1.0) + 0.5) * row);
  float lo = (float(id) * ACROSS + 0.5) * row, hi = (float(id + 1) * ACROSS - 0.5) * row;
  float ds = max(1.0, SOFT_PX * (ACROSS - 1.0) / (2.0 * hw)) * row; // SOFT_PX in rows: hw px span (ACROSS - 1) / 2 rows
  vec4 c0 = texture(uSim, simUV), up = texture(uSim, vec2(sx, min(simUV.y + ds, hi))), dn = texture(uSim, vec2(sx, max(simUV.y - ds, lo)));
  vec4 bk = texture(uSim, vec2(sx - cw, simUV.y)), fw = texture(uSim, vec2(sx + cw, simUV.y));
  vec4 sim = c0 * (1.0 - SOFT.x - SOFT.y) + (up + dn) * (0.5 * SOFT.x) + (bk + fw) * (0.5 * SOFT.y);
  float heat = sim.r, crust = sim.g, age = sim.a; // sim.b, the pressure, drives the sim's breakouts and is not drawn
  // 4. Plates: one layer, for a fine texture on the colour and the fold ripples. The sim does the rest.
  //    Both terms are weighted by sin(pi * ph), so they vanish where ph wraps and the seed changes and the
  //    reseed is not seen. pl.x is the plate noise's deviation from its mean (0.5), so the colour factor is 1 there.
  float cyc = uFlow[id] / CYCLE; // the channel's own flow clock: a surge runs it faster for a while
  float seedShift = float(id) * 17.3, ph = fract(cyc);
  vec2 pl = plates(u, v, velocity(across, along), ph, floor(cyc) * 11.7 + seedShift, along, scale);
  pl = vec2(pl.x - 0.5, pl.y) * sin(3.14159 * ph);
  // 5. Margins: the banks run hot where the flow shears against them (the pool has no banks to shear against).
  float shear = pool ? 0.0 : smoothstep(MARGIN.x, MARGIN.y, a);
  // 6. Cracks, from the sim: crust that changes steeply across the channel (plates shearing), and the edge of a melting front.
  float dAcross = abs(up.g - dn.g), dAlong = max(0.0, bk.r - c0.r);
  float crack = min(uCracks * crust * (smoothstep(0.08, 0.25, dAcross) + smoothstep(0.4, 0.6, crust) * smoothstep(0.1, 0.3, dAlong)), 1.0);
  // 7. The skin on the molten core (USGS Kilauea 2018-06-12: grey plates netted with orange seams; Mauna Loa 2022-12-08:
  //    open red with hot spots). Noise carried down the channel rigidly at the plug's speed, so it never shears into bark
  //    and needs no reseed. It closes as the sim cools (bare at the breach and pool); its lowest values are hot spots.
  vec2 q = vec2(u, v - uFlow[id] * SPEED * scale) / (NET_CELL * scale) + seedShift;
  float n = 0.65 * vnoise(q) + 0.35 * vnoise(q * 2.3 + 5.1);
  float cover = (1.0 - smoothstep(NET_HEAT.y, NET_HEAT.x, heat)) * (1.0 - crust), k = 1.0 - 0.75 * cover;
  float skin = smoothstep(k - 0.03, k + 0.03, n) * cover, seam = (1.0 - smoothstep(0.0, SEAM, abs(n - k))) * cover;
  float hot = (1.0 - smoothstep(0.2, 0.3, n)) * (1.0 - crust), open = max(hot, smoothstep(0.8, 0.95, heat));
  // 8. Temperature and colour: the simulated heat through the title's palette, darkened by crust and by its age. Heat counts
  //    once, in the sim's vents (uVentHeat); the page's density scales everything here, so a dim page is dim throughout.
  float T = clamp((heat * mix(pool ? DEEP_POOL : DEEP, 1.0, open) + HOT * hot + 0.18 * shear + 0.08 * pl.y) * uDensity, 0.0, 1.0);
  vec3 col = texture(uPalette, vec2(T, 0.5)).rgb * (1.0 + 0.16 * pl.x) * (1.0 - 0.85 * crust) * (0.6 + 0.4 * (1.0 - age));
  col = mix(col, RUBBLE * 1.4 + col * 0.12, skin) + (crack + seam * (1.0 - crust)) * uDensity * ORANGE_GLOW;
  // 9 was the rubble past the bank, gone: the bank is the sim's crusted outer rows, and the alpha feather ends it.
  // 10. Calm band, 1 px feather at the field's end, the bank's feather, flat strip ends cut to soft ellipses (not on the sheet or pool).
  float e = max(0.0, (along - 0.9) * 10.0), h = id == 0 || pool ? 0.0 : max(0.0, (0.1 - along) * 10.0);
  float caps = (1.0 - smoothstep(0.8, 1.0, e * e + a * a * step(0.001, e))) * (1.0 - smoothstep(0.8, 1.0, h * h + a * a * step(0.001, h)));
  float alpha = calm(vPx) * clamp((LEVEE - a) * hw, 0.0, 1.0) * (1.0 - smoothstep(1.0 - BANK_PX / hw, 1.0 + BANK_PX / hw, a)) * caps;
  fragColor = vec4(col * alpha, alpha); // 11. Premultiplied, for the 2D canvas to add with lighter.
}
`
