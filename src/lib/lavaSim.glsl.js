/**
 * GLSL ES 3.00 sources for the lava heat simulation pass, kept apart from the layer so tests can read them
 * (spec 4.1, 2026-11-07-lava-heat-sim-design.md).
 *
 * The pass runs once per frame over a small texture in channel space: 12 channel blocks stacked in y, each
 * ACROSS rows tall, ALONG columns wide (uSimSize = ALONG, ACROSS). A texel is one cell of one channel and holds
 * R = heat, G = crust, B = pressure, A = age of the crust, each 0..1. It is Doom fire bent along the channel:
 * the previous state is read from uPrev and the new state written to the other half of a ping-pong pair.
 *
 * Things the layer must know. uPrev wants LINEAR filtering and CLAMP_TO_EDGE; the shader keeps every bilinear
 * read inside one channel's block, so the blocks never bleed. The viewport is the whole sim texture. The sheet is
 * the channel whose uParent is below 0 (flow id 0); it alone has a vent row. An arm (uParent >= 0) is fed from
 * its parent's cell at uAttach. uTime must change on every step, including each step of stepN, or the flicker
 * and the random cooling freeze into one fixed pattern. Do not put anything before #version.
 */

// Every uniform the layer sets on the sim program, in the order the brief lists them.
export const SIM_UNIFORMS = [
  'uPrev', 'uSimSize', 'uDt', 'uTime', 'uSource', 'uCool', 'uVisc', 'uBreak', 'uSurge', 'uParent', 'uAttach', 'uIgnite',
]

export const SIM_VERT = `#version 300 es
// Sim pass vertex: a fullscreen triangle strip from gl_VertexID 0..3, no buffers.
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`

export const SIM_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uPrev;          // the previous state: heat, crust, pressure, age
uniform vec2 uSimSize;            // ALONG, ACROSS: cells along one channel, rows across it
uniform float uDt;                // seconds this step advances, already clamped by the layer
uniform float uTime;              // seconds, different on every step; seeds the hash
uniform float uSource;            // vent heat: the tuner's heat
uniform float uCool;              // cooling rate: the tuner's crust
uniform float uVisc;              // viscosity: the velocity profile's exponent
uniform float uBreak;             // breakout rate: the inverse pressure threshold
uniform float uSurge[12];         // where a surge has got to per channel, 0 at the vent to 1 at the toe, -1 none
uniform float uParent[12];        // the channel an arm branches from, -1 for the sheet
uniform float uAttach[12];        // how far along its parent an arm starts, 0..1
uniform float uIgnite;            // 1 on the first step after ignition: write the cold state and stop
out vec4 fragColor;

const float T_CRUST = 0.35;       // heat below this grows crust
const float T_MELT = 0.55;        // heat above this melts crust
const float K_CRUST = 1.2;        // crust growth per second per unit of heat below T_CRUST
const float K_MELT = 2.5;         // crust melt per second per unit of heat above T_MELT
const float K_P = 0.8;            // pressure gain per second behind a crusted cell with hot lava upstream
const float P_BREAK = 0.6;        // pressure at which the crust bursts, divided by uBreak
const float SPEED0 = 0.06;        // along units per second at the sheet head, at the centre of the plug
const float SRC_ROW = 0.03;       // the vent row: the first 3% of the sheet's along
const float FLICKER = 0.15;       // share of the vent heat that flickers
const float SURGE_V = 1.6;        // velocity scale at the start of a surge
const float COOL0 = 0.012;        // cooling scale: the spec's rate was far too fast for a 10-20 s trip
const float Q = 1.0 / 255.0;      // one level of the narrowest render target (RGBA8): the unit cooling is rounded in

float hash(vec3 p) {              // Hoskins' hash13
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
// Mirrors velocity() in lavaProfile.js and lavaShader.glsl.js: change the three together.
float velocity(float across, float along) {
  return pow(max(0.0, 1.0 - across * across), 1.0 + 3.0 * uVisc) * (1.5 - 1.2 * along);
}
// Bilinear read of channel block blk at along a and row r (0 to ACROSS - 1, fractional), the row clamped to
// half a texel inside the block so a channel never reads its neighbour.
vec4 cell(int blk, float a, float r) {
  float y0 = float(blk) * uSimSize.y;
  float y = clamp(y0 + r + 0.5, y0 + 0.5, y0 + uSimSize.y - 0.5);
  return texture(uPrev, vec2(clamp(a, 0.0, 1.0) * (uSimSize.x - 1.0) + 0.5, y) / vec2(uSimSize.x, uSimSize.y * 12.0));
}
void main() {
  // 6. Ignite, first: the cold state, fully crusted, and nothing else runs.
  if (uIgnite > 0.5) {
    fragColor = vec4(0.0, 1.0, 0.0, 1.0);
    return;
  }
  ivec2 p = ivec2(gl_FragCoord.xy);
  int ACROSS = int(uSimSize.y);
  int ALONG = int(uSimSize.x);
  int id = min(p.y / ACROSS, 11);
  int row = p.y - id * ACROSS;
  float across = float(row) / float(ACROSS - 1) * 2.0 - 1.0;
  float along = float(p.x) / float(ALONG - 1);
  float seed = uTime * 60.0;      // a frame is one hash step; the fractions below keep the four draws apart
  vec2 c = vec2(p);
  vec4 prev = texelFetch(uPrev, p, 0);
  bool sheet = uParent[id] < 0.0;
  // 1. Advect: sample upstream along the viscous profile, slowed by this cell's crust, with Doom's sideways lick.
  float sg = uSurge[id];
  float surgeActive = sg >= 0.0 ? 1.0 - min(1.0, sg) : 0.0;
  float v = velocity(across, along) * (1.0 - 0.85 * prev.g) * SPEED0 * (1.0 + (SURGE_V - 1.0) * surgeActive);
  float ua = along - v * uDt;
  float jitter = (hash(vec3(c, seed)) - 0.5) * 2.0 / float(ACROSS);
  float r = (across + jitter + 1.0) * 0.5 * float(ACROSS - 1);
  bool arm = ua < 0.0 && !sheet;  // before the head of an arm: read the parent, one texture() call either way
  vec4 up = cell(arm ? int(uParent[id]) : id, arm ? uAttach[id] : ua, r);
  if (ua < 0.0 && sheet) up = vec4(uSource, 0.0, 0.0, 0.0);  // before the head of the sheet: the source
  float heat = up.r;
  float crust = up.g;
  float press = up.b;
  float age = up.a;
  // 2. Source: the sheet's vent row is held at the vent heat with flicker, plus a surge spike, and has no crust.
  // Arms have no vent row of their own: their lava is the parent's, read in step 1.
  if (sheet && along < SRC_ROW) {
    float spike = surgeActive * surgeActive * (3.0 - 2.0 * surgeActive) * (1.0 - uSource);
    heat = uSource * (1.0 - FLICKER + FLICKER * hash(vec3(c, seed + 0.37))) + spike;
    crust = 0.0;
  }
  // 3. Cool: faster at the banks and downstream, with Doom's random decay. One frame's cooling is far below a
  // render target level (about 1e-4 against 4e-3 in RGBA8), so a plain subtraction rounds away and a hot plateau
  // never cools. Take whole levels, plus one more with the fractional part as its probability: as Doom does, the
  // expected cooling is the formula's at any precision and frame rate.
  float cool = uDt * COOL0 * (0.4 + 0.8 * uCool) * (0.6 + 0.8 * abs(across)) * (1.0 + 0.5 * along) * (0.7 + 0.6 * hash(vec3(c, seed + 0.71)));
  heat -= Q * (floor(cool / Q) + step(hash(vec3(c, seed + 0.53)), fract(cool / Q)));
  heat = clamp(heat, 0.0, 1.0);
  // 4. Crust: grows where the lava is cold, melts where hot lava arrives, and ages while it stays.
  if (heat < T_CRUST) crust += uDt * K_CRUST * (T_CRUST - heat);
  if (heat > T_MELT) crust -= uDt * K_MELT * (heat - T_MELT);
  crust = clamp(crust, 0.0, 1.0);
  age = crust < 0.1 ? 0.0 : min(1.0, age + uDt * 0.05);
  // 5. Pressure: builds where the cell one step upstream is hotter than this crusted one (the advected sample
  // cannot, it barely moves under crust); past the threshold the crust bursts and the heat comes through.
  float heatUp = p.x > 0 ? texelFetch(uPrev, p - ivec2(1, 0), 0).r : up.r;
  press += uDt * K_P * max(0.0, heatUp - heat) * crust;
  if (press > P_BREAK / max(uBreak, 0.01)) {
    crust *= 0.2;
    heat = max(heat, heatUp);
    press = 0.0;
  } else {
    press *= 1.0 - uDt * 0.2;
  }
  // 7. Output, every channel clamped to 0..1 so a long step cannot leave the range.
  fragColor = clamp(vec4(heat, crust, press, age), 0.0, 1.0);
}
`
