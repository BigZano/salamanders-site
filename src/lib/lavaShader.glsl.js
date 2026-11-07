/**
 * GLSL ES 3.00 sources for the lava shader, kept apart from the layer so tests can read them.
 *
 * Two passes. The field pass rasterises every channel's triangle strips once per layout into a
 * texture: R = across (-2.2 to 2.2, 0 at the centre), G = along (0 at the vent, 1 at the toe),
 * B = channel id / 255, A = the channel's half width in px / 255 (0 where no channel is, so coverage
 * is A > 0; the layer clears the field to zero and draws it with blending off). The lava pass then
 * runs each frame over the channels' bounding box, reads that texture and paints the lava (spec 4.2).
 *
 * If the field texture is RGBA8 rather than float, the layer inserts "#define FIELD_PACKED" on the
 * line after "#version 300 es" in FIELD_FRAG and LAVA_FRAG. across is then stored as
 * (across / 2.2) * 0.5 + 0.5, and the lava pass unpacks it. Do not put anything before #version.
 *
 * Both vertex shaders flip y (px run down the screen, clip space runs up), and the lava fragment
 * looks the field up at its own pixel, so the two passes agree on which texel is which.
 *
 * Things the layer must know. aHeat is in the vertex layout but unread (heat is uHeatPer[id]), so the
 * compiler drops it and getAttribLocation returns -1: skip any location below 0. The sheet is flow
 * id 0, because buildFlows pushes it first; the head of that channel is held at the top of the
 * colour ramp. The field wants NEAREST sampling, and all px (aPos, uBounds, uResolution, the calm
 * rects) are drawing-buffer px. uLength[id] is each channel's centreline length in px.
 */

// Every uniform the layer sets on the lava program. packUniforms supplies the first 14; the layer
// sets the last 4 (each channel's length, the field sampler, the drawing buffer size and the quad).
export const UNIFORMS = [
  'uTime', 'uCrust', 'uHeat', 'uViscosity', 'uCracks', 'uFoldScale', 'uBreakoutRate', 'uDensity',
  'uOctaves', 'uSurge', 'uHeatPer', 'uPhase', 'uCalm', 'uCalmCount', 'uLength', 'uFlow', 'uField', 'uResolution', 'uBounds',
]

export const FIELD_VERT = `#version 300 es
// Field pass vertex: one triangle strip vertex per call. aPos is in px, y down.
// aHeat is part of the vertex layout but unread (the lava pass takes heat from uHeatPer), so the
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
// (across / 2.2) * 0.5 + 0.5; along then keeps only 8 bits, which the lava pass lives with.
// Alpha is the half width in px over 255, which holds any channel and doubles as coverage.
in float across;
in float along;
in float halfPx;
flat in float id;
out vec4 fragColor;
void main() {
#ifdef FIELD_PACKED
  float r = (across / 2.2) * 0.5 + 0.5;
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
uniform float uTime; uniform float uDensity; uniform int uOctaves;    // seconds; the page's glow; noise octaves
uniform float uCrust; uniform float uHeat; uniform float uViscosity;  // the tuner's lava.crust, heat, viscosity
uniform float uCracks; uniform float uFoldScale; uniform float uBreakoutRate;  // and its cracks, foldScale, breakoutRate
uniform float uSurge[12]; uniform float uFlow[12]; uniform float uHeatPer[12]; uniform float uPhase[12]; uniform float uLength[12];  // per channel
uniform vec4 uCalm[8]; uniform int uCalmCount;   // calm rects as l, t, r, b; only the first uCalmCount are live
uniform sampler2D uField; uniform vec2 uResolution; uniform vec4 uBounds;
in vec2 vPx;
out vec4 fragColor;

// Look constants, tuned by name. The px ones are for a 600 px tall scene and scale with it.
const float LEVEE = 2.2;               // across at the outer edge of the rubble
const float CYCLE = 40.0;              // seconds a layer of plates lasts before it is renewed
const float SPEED = 3.0;               // px per second the plug at the centre carries the plates
const float GAIN = 1.8; const float CRUST_FADE = 2.4; // crust noise contrast; the toe fade curve's power
const float WARP = 2.4;                // plate cells the domain warp pushes the noise along the flow, at full viscosity
const float WARP_FREQ = 0.4;           // the warp noise's frequency, against the plates'
const vec2 CELL = vec2(7.0, 18.0);     // size of a plate in px, across and along the flow
const float FOLD_PX = 28.0;            // wavelength of the fold ripples in px
const vec2 MARGIN = vec2(0.55, 0.95);  // across where the banks start and finish running hot
const float CRACK_PX = 1.5;            // width of a crack line in px
const vec2 PERIOD = vec2(10.0, 20.0);  // shortest and longest breakout period in s, spread by channel id
const vec3 CRUST = vec3(12.0, 6.0, 4.0) / 255.0;
const vec3 DEEP = vec3(90.0, 10.0, 0.0) / 255.0;
const vec3 RED = vec3(200.0, 40.0, 10.0) / 255.0;
const vec3 ORANGE = vec3(255.0, 136.0, 38.0) / 255.0;
const vec3 WHITE = vec3(255.0, 220.0, 150.0) / 255.0;
const vec3 RUBBLE = vec3(52.0, 40.0, 34.0) / 255.0;

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
// Mirrors velocity() in lavaProfile.js: change the two together.
float velocity(float across, float along) {
  return pow(max(0.0, 1.0 - across * across), 1.0 + 3.0 * uViscosity) * (1.5 - 1.2 * along);
}
vec3 ramp(float t) {
  vec3 c = mix(CRUST, DEEP, smoothstep(0.0, 0.22, t));
  c = mix(c, RED, smoothstep(0.22, 0.48, t));
  c = mix(c, ORANGE, smoothstep(0.48, 0.75, t));
  return mix(c, WHITE, smoothstep(0.75, 1.0, t));
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
// One layer of plates, x = crust noise, y = fold ripple. The noise is carried down the channel by
// the viscous profile s for ph of a CYCLE. A layer is only shown while ph runs 0 to 1, fading in and
// out, so the banks and the centre never shear far enough apart to turn the noise into hair.
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
  float scale = max(uBounds.w, 200.0) / 600.0;
#ifdef FIELD_PACKED
  float across = (f.r * 2.0 - 1.0) * LEVEE;
#else
  float across = f.r;
#endif
  // 1. Coverage: the field is cleared to zero, and a channel's alpha is its half width over 255.
  if (f.a <= 0.0) discard;
  float hw = f.a * 255.0;
  int id = min(int(f.b * 255.0 + 0.5), 11);
  float along = clamp(f.g, 0.0, 1.0);
  float a = abs(across);
  // 2. Lava space, in px, so noise does not stretch with the channel's length.
  float u = across * hw;
  float v = along * uLength[id];
  // 3. Viscous advection. Two plate layers half a CYCLE apart, cross-faded so neither shows the instant it reseeds.
  float s = velocity(across, along);
  float cyc = uFlow[id] / CYCLE; // the channel's own flow clock: a surge runs it faster for a while
  float w0 = 1.0 - abs(2.0 * fract(cyc) - 1.0);
  float w1 = 1.0 - w0;
  float seedShift = float(id) * 17.3;
  vec2 pa = plates(u, v, s, fract(cyc), floor(cyc) * 11.7 + seedShift, along, scale);
  vec2 pb = plates(u, v, s, fract(cyc + 0.5), floor(cyc + 0.5) * 11.7 + seedShift + 53.0, along, scale);
  // 4. Folds: ridges across the flow, bunched toward the toe by plates().
  float fold = w0 * pa.y + w1 * pb.y;
  // 9. Surge, worked out early because the crust threshold needs it. sg is -1 when none.
  float sg = uSurge[id];
  float surgeDist = (along - sg) / (0.07 + 0.2 * max(sg, 0.0));
  float fresh = sg < 0.0 ? 0.0 : exp(-surgeDist * surgeDist) * (1.0 - min(1.0, sg));
  // 5. Crust: one continuous dark ribbon, fading toward the toe on a curve that steepens with depth (Bret, 2026-11-07).
  float c = clamp(0.5 + (w0 * (pa.x - 0.5) + w1 * (pb.x - 0.5)) * inversesqrt(w0 * w0 + w1 * w1) * GAIN, 0.0, 1.0);
  float thr = 1.0 - (0.3 + 0.35 * uCrust) + fresh;
  float crusted = smoothstep(thr - 0.2, thr + 0.2, c) * (1.0 - pow(along, CRUST_FADE));
  // 6. Cracks: bright lines about CRACK_PX wide at the plate edges, whatever the slope of the noise.
  float crack = (1.0 - smoothstep(0.0, CRACK_PX, abs(c - thr) / max(fwidth(c), 0.002))) * uCracks;
  // 7. Margins: the banks run hot where the flow shears against them.
  float shear = smoothstep(MARGIN.x, MARGIN.y, a);
  // 8. Breakouts: every PERIOD seconds a crusted toe darkens, a tongue brightens there, then cools back. 0 = off.
  float period = mix(PERIOD.x, PERIOD.y, fract(float(id) * 0.618)) / max(uBreakoutRate, 0.01);
  float bp = fract(uTime / period + uPhase[id]);
  float blob = smoothstep(0.45, 0.8, vnoise(vec2(u, v) / (vec2(10.0, 14.0) * scale) + seedShift));
  float dim = smoothstep(0.0, 0.3, bp) * (1.0 - smoothstep(0.3, 0.45, bp));
  float tongue = smoothstep(0.45, 0.6, bp) * (1.0 - smoothstep(0.6, 1.0, bp));
  float breakout = step(0.001, uBreakoutRate) * smoothstep(0.78, 0.92, along) * (0.5 * blob * tongue - 0.5 * dim);
  // 10. Temperature: deep red to dark orange as the base, scattered hotter spots where the plates run thin.
  float hot = smoothstep(0.7, 0.95, w0 * pa.x + w1 * pb.x);
  float T = (0.64 - 0.3 * along) * uHeatPer[id] + hot * 0.45 + crack * 0.45 + shear * 0.18
          - crusted * 0.9 + fold * 0.08 + breakout;
  T = clamp(T, 0.0, 1.0) * uHeat * uDensity;
  // 11. Colour. The sheet is flow 0 (buildFlows pushes it first), and its head is held at the top.
  float hold = id == 0 ? 1.0 - smoothstep(0.1, 0.15, along) : 0.0;
  T = max(T, hold * clamp(uHeat * uDensity, 0.0, 1.0));
  vec3 col = ramp(T);
  // 12. Levee: grey rubble past the bank, lit toward the channel by what the bank is doing.
  float rub = 0.7 + 0.6 * vnoise(vec2(u, v) / (3.0 * scale) + seedShift);
  vec3 rubble = RUBBLE * rub + col * ((LEVEE - a) * T * 0.25);
  col = mix(col, rubble, smoothstep(1.0 - 0.5 / hw, 1.0 + 0.5 / hw, a));
  // 13. Calm band, 1 px feather at the field's end, rubble fading to LEVEE, and the flat strip ends cut to soft ellipses.
  float e = max(0.0, (along - 0.9) * 10.0), h = id == 0 ? 0.0 : max(0.0, (0.1 - along) * 10.0);
  float caps = smoothstep(1.0, 0.8, e * e + a * a * step(0.001, e)) * smoothstep(1.0, 0.8, h * h + a * a * step(0.001, h));
  float alpha = calm(vPx) * clamp((LEVEE - a) * hw, 0.0, 1.0) * (1.0 - smoothstep(1.2, LEVEE, a)) * caps;
  fragColor = vec4(col * alpha, alpha); // 14. Premultiplied, for the 2D canvas to add with lighter.
}
`
