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
 * the channel whose uParent is -1 (flow id 0); it alone has a vent row. An arm (uParent >= 0) is fed from its
 * parent's cell at uAttach. A block whose uParent is -2 is no channel's and is kept empty. uTime must change on
 * every step, including each step of stepN, or the flicker and the random cooling freeze into one fixed pattern.
 * Do not put anything before #version.
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
uniform float uParent[12];        // the channel an arm branches from, -1 for the sheet, -2 for no channel
uniform float uAttach[12];        // how far along its parent an arm starts, 0..1
uniform float uIgnite;            // 1 on the first step after ignition: write the cold state and stop
out vec4 fragColor;

const float T_CRUST = 0.42;       // heat below this grows crust (0.35 in the spec: the banks crusted too little)
const float T_MELT = 0.55;        // heat above this melts crust
const float K_CRUST = 5.0;        // crust growth per second per unit of heat below T_CRUST
const float K_MELT = 2.5;         // crust melt per second per unit of heat above T_MELT
const float K_P = 0.8;            // pressure gain per second behind a crusted cell with hot lava upstream
const float P_BREAK = 0.6;        // pressure at which the crust bursts, divided by uBreak
const float SPEED0 = 0.28;        // along units per second at the sheet head, at the centre of the plug
const float SRC_ROW = 0.03;       // the vent row: the first 3% of the sheet's along
const float FLICKER = 0.15;       // share of the vent heat that flickers
const float SURGE_V = 1.6;        // velocity scale at the start of a surge
const float COOL0 = 0.02;         // cooling scale: the spec's rate was far too fast for a 10-20 s trip
const float COOL_CORE = 0.3;      // cooling across the channel: COOL_CORE + COOL_BANK * across^2, so the banks
const float COOL_BANK = 4.0;      //   crust while the fast core stays hot
const float COOL_HEAD = 0.3;      // cooling along the channel: COOL_HEAD + COOL_TOE * along, so the lower reaches
const float COOL_TOE = 3.0;       //   crust while the head stays bright
const float CRUST_DAMP = 0.6;     // share of the speed a full crust takes away (0.85 in the spec: the front stalled)
const float LICK = 0.12;          // the sideways lick's reach, in rows of a 32-row channel per 1/30 s step
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
// Read of channel block blk at column x (0 to ALONG - 1) and row r (0 to ACROSS - 1, fractional), the row clamped to
// half a texel inside the block so a channel never reads its neighbour.
vec4 cell(int blk, float x, float r) {
  float y0 = float(blk) * uSimSize.y;
  float y = clamp(y0 + r + 0.5, y0 + 0.5, y0 + uSimSize.y - 0.5);
  return texture(uPrev, vec2(clamp(x, 0.0, uSimSize.x - 1.0) + 0.5, y) / vec2(uSimSize.x, uSimSize.y * 12.0));
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
  // A block no channel uses (uParent -2) stays empty and dark, and costs one write.
  if (uParent[id] < -1.5) {
    fragColor = vec4(0.0);
    return;
  }
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
  float v = velocity(across, along) * (1.0 - CRUST_DAMP * prev.g) * SPEED0 * (1.0 + (SURGE_V - 1.0) * surgeActive);
  float ua = along - v * uDt;
  // The upstream cell is a whole cell, the nearer or the farther of the two the read falls between, the farther with
  // the fractional part as its chance, as Doom copies whole pixels. A bilinear read would smear the front by a share
  // of a cell each step, which ran it faster at 60 Hz than at 30 and on a phone's coarser grid than on a desktop's.
  // The lick is the mean of two reads a share jr of a row to either side: it spreads heat sideways by jr rows^2 a
  // step, so jr goes with the step (the same spread per second at any frame rate) and with the square of the rows
  // (the same share of the width per second on a phone's 16 rows as on a desktop's 32). A random lick did the same
  // on average but its noise cooled the arms more at 30 Hz than at 60.
  float rows = float(ACROSS - 1);
  float r = (across + 1.0) * 0.5 * rows;
  float jr = LICK * uDt * 30.0 * rows * rows / 961.0;
  bool arm = ua < 0.0 && !sheet;  // before the head of an arm: read the parent, the same two reads either way
  int blk = arm ? int(uParent[id]) : id;
  float x = clamp(arm ? uAttach[id] : ua, 0.0, 1.0) * (uSimSize.x - 1.0);
  x = floor(x) + step(hash(vec3(c, seed)), fract(x));
  vec4 up = 0.5 * (cell(blk, x, r - jr) + cell(blk, x, r + jr));
  if (ua < 0.0 && sheet) up = vec4(uSource, 0.0, 0.0, 0.0);  // before the head of the sheet: the source
  float heat = up.r;
  float crust = up.g;
  float press = up.b;
  float age = up.a;
  // 2. Source: the sheet's vent row is held at the vent heat with flicker, plus a surge spike, and has no crust.
  // Arms have no vent row of their own: their lava is the parent's, read in step 1.
  if (sheet && along < SRC_ROW) {
    // A surge eases the vent up to the palette's top and back. Only up: a page's flare can push uSource past 1,
    // where the plain gap to the top would be negative and a surge would dim the vent.
    float vent = uSource * (1.0 - FLICKER + FLICKER * hash(vec3(c, seed + 0.37)));
    heat = vent + surgeActive * surgeActive * (3.0 - 2.0 * surgeActive) * max(0.0, 1.0 - vent);
    crust = 0.0;
  }
  // 3. Cool: faster at the banks and downstream, with Doom's random decay. One frame's cooling is far below a
  // render target level (about 1e-4 against 4e-3 in RGBA8), so a plain subtraction rounds away and a hot plateau
  // never cools. Take whole levels, plus one more with the fractional part as its probability: as Doom does, the
  // expected cooling is the formula's at any precision and frame rate.
  float cool = uDt * COOL0 * (0.4 + 0.8 * uCool) * (COOL_CORE + COOL_BANK * across * across) * (COOL_HEAD + COOL_TOE * along) * (0.7 + 0.6 * hash(vec3(c, seed + 0.71)));
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
  // 7. Output, every channel clamped to 0..1 so a long step cannot leave the range. A step's change is rounded to
  // whole levels of Q at random, up with the fractional part as its chance, as the cooling is: an RGBA8 target
  // would round a change under half a level to nothing, which stalls a slow front at 60 Hz. The expected change
  // is the exact one at any precision and frame rate.
  vec4 d = clamp(vec4(heat, crust, press, age), 0.0, 1.0) - prev;
  vec4 u = vec4(hash(vec3(c, seed + 0.13)), hash(vec3(c, seed + 0.29)), hash(vec3(c, seed + 0.61)), hash(vec3(c, seed + 0.83)));
  fragColor = clamp(prev + Q * floor(d / Q + u), 0.0, 1.0);
}
`
