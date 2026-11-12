// The plate renderer: Mount Deathfire's rock and sky, rendered once, offline, from the page's own mountain data.
// Grown from the lava3d mock (dev-mock/lava3d, a vetoed look kept as this scene's source): its sky, its rock material
// and its lights (the moon's cool rim key from behind and left, the cool sky, the blue-violet fill from the right, the warm
// lights of the vent and the lake), without the moon itself, the lava, the fountain, the embers, the splinters, the steam,
// the title or any animation. The far peaks are not here: the page paints them, under the plate.
//
// URL: index.html?plate=1&pass=sky|rock&input=<base64 JSON, see input.js>[&connected=0]
//   pass=sky      the sky alone, opaque
//   pass=rock     the cone, the hills joined to it and the foreground ridge, on a transparent clear (premultiplied alpha)
//   connected=0   the cone alone (to measure its outline against the page's polygon, and to compare)
// One still frame, then window.__plateReady = { pass, w, h } (or window.__plateError = message). The canvas is the
// input's canvas size at a pixel ratio of 1: the caller sizes the viewport to { w, h } and screenshots it.
// Deterministic: every noise is seeded from input.seed; nothing reads the clock.
//
// For looking only (never in a plate): preview=1 draws the sky and the rock together and scales the canvas down to fit the
// window; far=1 with it also paints the page's far ridges between them, as MountDeathfire.vue draws them.
import * as THREE from 'three'
import { parseInput } from './input.js'
import { buildWorld } from './world.js'

const params = new URLSearchParams(window.location.search)
const pass = params.get('pass') === 'sky' ? 'sky' : 'rock'
const connected = params.get('connected') !== '0'
const preview = params.get('preview') === '1'
const far = preview && params.get('far') === '1'

function fail(e) {
  window.__plateError = String(e?.message ?? e)
  console.error('[plate]', window.__plateError)
}

// Preview only: a long input is kept in this tab's session storage under its bucket's name and the address bar is given
// that short name instead (input=session:wide), so a look's URL stays short. A plate pass always takes the input inline.
function inputParam() {
  const raw = params.get('input') ?? ''
  if (!preview) return raw
  if (raw.startsWith('session:')) return sessionStorage.getItem(`plate-${raw.slice(8)}`) ?? ''
  if (raw.length > 512) {
    let key = 'look'
    try {
      key = /^[a-z]+$/.test(parseInput(raw).bucket) ? parseInput(raw).bucket : key
    } catch {}
    sessionStorage.setItem(`plate-${key}`, raw)
    params.set('input', `session:${key}`)
    history.replaceState(null, '', `?${params}`)
  }
  return raw
}

// ------------------------------------------------------------------ shared GLSL (the mock's)
const NOISE = /* glsl */ `
float sstep(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = m * p; a *= 0.5; } return s / 0.9375; }`

// the sky's colours (linear): a dark violet zenith, a smoky horizon, and the sulphur-orange of the air over the crater
const SKY_TOP = new THREE.Vector3(0.006, 0.005, 0.016)
const SKY_HOR = new THREE.Vector3(0.045, 0.02, 0.024)
const HAZE_WARM = new THREE.Vector3(0.4, 0.15, 0.024)

// The sky's colour at a canvas uv (linear, before tone mapping): the sky pass draws it, and the hills' haze is it.
const SKY = /* glsl */ `
uniform vec2 uVentUv, uSeed; uniform float uAspect; uniform vec3 uTop, uHor, uWarm;
vec3 skyColor(vec2 uv){
  float y = uv.y;
  vec3 c = mix(uHor, uTop, smoothstep(0.1, 0.95, y));
  // the painting's split: warm over the vent, cool blue-violet on the far side
  float far = smoothstep(0.15, 0.75, abs(uv.x - uVentUv.x));
  c = mix(c, mix(vec3(0.012, 0.012, 0.036), uTop, smoothstep(0.12, 0.9, y)), far * 0.75);
  // distances in frame heights, tightened on a tall frame so the glow stays a cone and not a wash
  vec2 d = (uv - uVentUv) * vec2(uAspect, 1.0) * max(1.0, 0.75 / uAspect);
  // the heavens over the crater: a sulphur-orange glow, brighter up the plume's line, thin cloud through it
  float cloud = 0.65 + 0.6 * fbm(vec2(uv.x * 3.0 * uAspect, uv.y * 3.0) + uSeed);
  float wisp = smoothstep(0.42, 0.78, fbm(vec2(uv.x * 1.3 * uAspect, uv.y * 7.0) + uSeed * 1.7));
  float up = smoothstep(-0.1, 0.5, d.y);
  vec2 dp = d - vec2(0.0, 0.12);
  float g = 0.5 * exp(-dot(dp, dp) * 6.5) + 0.16 * exp(-dot(d * vec2(1.4, 0.75), d * vec2(1.4, 0.75)) * 1.3) * (0.6 + 0.4 * up);
  c += uWarm * g * cloud;
  c = mix(c, c * 0.6 + uWarm * 0.7 * g, wisp * 0.6);
  c += uWarm * 0.1 * exp(-y * 5.0) * (1.0 - far * 0.8);
  return c;
}`

const OUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>`

// premultiplied "over": every rock layer composes on the transparent clear and on the layers drawn before it
const OVER = { transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, depthTest: false, depthWrite: false }

const quadVS = /* glsl */ `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`

function quad(material, order) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  mesh.frustumCulled = false
  mesh.renderOrder = order
  return mesh
}

function skyUniforms(input, W, H) {
  const m = input.mountain
  return {
    uVentUv: { value: new THREE.Vector2(m.vent.x / W, 1 - m.vent.y / H) },
    uSeed: { value: new THREE.Vector2(((input.seed >>> 0) % 997) * 0.731, ((input.seed >>> 10) % 991) * 0.577) },
    uAspect: { value: W / H },
    uTop: { value: SKY_TOP },
    uHor: { value: SKY_HOR },
    uWarm: { value: HAZE_WARM },
  }
}

function skyMesh(uniforms) {
  return quad(
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: quadVS,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        ${NOISE}
        ${SKY}
        void main(){
          vec3 c = skyColor(vUv) + (hash12(gl_FragCoord.xy + uSeed) - 0.5) / 255.0;
          gl_FragColor = vec4(c, 1.0);
          ${OUT}
        }`,
      depthTest: false,
      depthWrite: false,
    }),
    -10,
  )
}

// ------------------------------------------------------------------ the rock's textures (Poly Haven CC0, see fetch-textures.mjs)
async function loadTex(url, srgb, maxAniso) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status} (run node scripts/plates/fetch-textures.mjs)`)
  const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'flipY' })
  const t = new THREE.Texture(bmp)
  t.flipY = false // flipped at decode
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = Math.min(8, maxAniso)
  t.needsUpdate = true
  return t
}

// The outlines as one mask: red the cone's polygon, filled the way MountDeathfire.vue fills its silhouette; green the hills'
// regions; blue the foreground ridge's. The shader cuts each surface with its own, so every outline is exactly its polygon.
function maskTexture(world, w, h) {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const g = cv.getContext('2d')
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  g.globalCompositeOperation = 'lighter'
  const fill = (poly, colour) => {
    g.beginPath()
    g.moveTo(poly[0].x, poly[0].y)
    for (const p of poly.slice(1)) g.lineTo(p.x, p.y)
    g.closePath()
    g.fillStyle = colour
    g.fill()
  }
  fill(world.outline, '#f00')
  for (const hl of world.hills) fill(hl.region, '#0f0')
  if (world.foreground) fill(world.foreground.region, '#00f')
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.NoColorSpace
  t.minFilter = t.magFilter = THREE.NearestFilter
  t.generateMipmaps = false
  return t
}

// ------------------------------------------------------------------ the rock
function rockMaterial(world, input, tex, mask, sky, kind) {
  const m = input.mountain
  const W = world.canvas.w, H = world.canvas.h
  const lights = [world.vent, world.poolLight ?? world.vent]
  const seedR = new THREE.Vector2(((input.seed >>> 0) % 997) * 0.731, ((input.seed >>> 10) % 991) * 0.577)
  return new THREE.ShaderMaterial({
    uniforms: {
      ...sky,
      uKind: { value: kind },
      uUnit: { value: world.unit },
      uRes: { value: new THREE.Vector2(W, H) },
      uSeedR: { value: seedR },
      // the mock's moon: a cool rim key from behind and left, so faces toward the camera stay dark and the ribs' edges catch it
      uMoonDir: { value: new THREE.Vector3(...world.moon) },
      uMoonCol: { value: new THREE.Vector3(0.5, 0.56, 0.85).multiplyScalar(1.55) },
      // the cool sky on faces turned up, almost nothing from below; the blue-violet fill from the right (the painting's
      // cool side); the orange heavens over the crater, warm on faces turned up near the summit only
      uSkyAmb: { value: new THREE.Vector3(0.011, 0.011, 0.022).multiplyScalar(1.6) },
      uGroundAmb: { value: new THREE.Vector3(0.002, 0.0015, 0.002) },
      uFillDir: { value: new THREE.Vector3(0.9, 0.35, 0.25).normalize() },
      uFillCol: { value: new THREE.Vector3(0.05, 0.06, 0.12).multiplyScalar(1.5) },
      uApex: { value: new THREE.Vector2(m.peakX, world.sizes.tipY) },
      uLPos: { value: lights.map((p) => new THREE.Vector3(p.x, p.y, p.z)) },
      uLCol: { value: [new THREE.Vector3(6.5, 2.2, 0.45), new THREE.Vector3(world.poolLight ? 1.3 : 0, world.poolLight ? 0.38 : 0, world.poolLight ? 0.07 : 0)] },
      uLRad: { value: [0.95 * world.sizes.ch, world.poolLight ? 0.45 * (m.pool?.rx ?? 1) : 1] },
      uCh: { value: world.sizes.ch },
      uHm: { value: world.sizes.Hm },
      uPeakY: { value: world.sizes.tipY },
      uBaseY: { value: world.sizes.floorY },
      tMask: { value: mask },
      ...tex,
    },
    vertexShader: /* glsl */ `
      attribute vec2 aPlate; attribute vec4 aField; attribute vec4 aShade;
      varying vec3 vWorld; varying vec3 vNormal; varying vec2 vPlate; varying vec4 vField; varying vec4 vShade;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vPlate = aPlate;
        vField = aField;
        vShade = aShade;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uKind, uUnit, uCh, uHm, uPeakY, uBaseY; uniform vec2 uRes, uSeedR, uApex;
      uniform vec3 uMoonDir, uMoonCol, uSkyAmb, uGroundAmb, uFillDir, uFillCol;
      uniform vec3 uLPos[2]; uniform vec3 uLCol[2]; uniform float uLRad[2];
      uniform sampler2D tMask, tRockD, tRockN, tRockR, tRockAO, tCliffD, tCliffN, tCliffR;
      varying vec3 vWorld; varying vec3 vNormal; varying vec2 vPlate; varying vec4 vField; varying vec4 vShade;
      ${NOISE}
      ${SKY}

      // The mock's triplanar rock, for its relief and its grain only: dark_rock's fractured plates on faces turned up,
      // rock_face_03's broken face on the rest; two scales of each, blended by a slow mask so no tile repeats; the normal
      // maps blended the whiteout way. None of the photographs' colour is used.
      struct Rock { float lum; vec3 N; float rough; float ao; };
      vec3 tnBlend(vec3 tn, vec2 nxy, float nz){ return vec3(tn.xy + nxy, abs(tn.z) * nz); }
      Rock rockSample(vec3 p, vec3 Ng, float px){
        vec3 w = pow(abs(Ng), vec3(4.0));
        w /= (w.x + w.y + w.z);
        float s1 = 1.0 / 7.0, s2 = 1.0 / 18.0;
        float mk = smoothstep(0.35, 0.65, fbm(p.xy * 0.05 + p.z * 0.03 + 50.0));
        vec2 uy1 = p.xz * s1, uy2 = p.xz * s2 + 0.37;
        vec3 dY = mix(texture2D(tRockD, uy1).rgb, texture2D(tRockD, uy2).rgb, mk);
        vec3 nY = mix(texture2D(tRockN, uy1).xyz, texture2D(tRockN, uy2).xyz, mk) * 2.0 - 1.0;
        float rY = mix(texture2D(tRockR, uy1).r, texture2D(tRockR, uy2).r, mk);
        float aoY = mix(texture2D(tRockAO, uy1).r, texture2D(tRockAO, uy2).r, mk);
        vec2 ux = p.zy * s1 * 0.8, uz1 = p.xy * s1 * 0.8 + 0.21, uz2 = p.xy * s2 * 0.8 + 0.53;
        vec3 dX = texture2D(tCliffD, ux).rgb;
        vec3 dZ = mix(texture2D(tCliffD, uz1).rgb, texture2D(tCliffD, uz2).rgb, mk);
        vec3 nX = texture2D(tCliffN, ux).xyz * 2.0 - 1.0;
        vec3 nZ = mix(texture2D(tCliffN, uz1).xyz, texture2D(tCliffN, uz2).xyz, mk) * 2.0 - 1.0;
        float rX = texture2D(tCliffR, ux).r, rZ = mix(texture2D(tCliffR, uz1).r, texture2D(tCliffR, uz2).r, mk);
        float aoZ = mix(texture2D(tRockAO, uz1).r, texture2D(tRockAO, uz2).r, mk);
        Rock r;
        vec3 alb = dX * w.x + dY * w.y + dZ * w.z;
        r.lum = dot(alb, vec3(0.2126, 0.7152, 0.0722));
        r.rough = rX * w.x + rY * w.y + rZ * w.z;
        r.ao = mix(aoZ, aoY, w.y);
        vec3 bx = tnBlend(nX, Ng.zy, Ng.x), by = tnBlend(nY, Ng.xz, Ng.y), bz = tnBlend(nZ, Ng.xy, Ng.z);
        r.N = normalize(bx.zyx * w.x + by.xzy * w.y + bz.xyz * w.z);
        r.N = normalize(mix(r.N, Ng, smoothstep(0.08, 0.5, px)));
        return r;
      }

      void main(){
        vec4 mk = texture2D(tMask, gl_FragCoord.xy / uRes);
        float a = uKind > 0.5 ? mk.b : max(mk.r, mk.g);
        if (a < 0.002) discard;
        float glow = vField.x, pool = vField.y, crest = vField.z, hill = vField.w;
        float ao = vShade.x, vis = vShade.y, haze = vShade.z, relief = vShade.w;
        vec3 wp = vWorld / uUnit + vec3(uSeedR, 0.0);
        float px = length(fwidth(wp.xy)) + 1e-4;
        vec3 Vv = normalize(cameraPosition - vWorld);
        vec3 Ng = normalize(vNormal);
        vec2 suv = gl_FragCoord.xy / uRes;
        float asp = uRes.x / uRes.y;
        vec2 dv = (suv - uVentUv) * vec2(asp, 1.0) * max(1.0, 0.75 / asp);

        Rock rk = rockSample(wp, Ng, px * (1.0 + 1.5 * haze));
        vec3 N = normalize(mix(rk.N, Ng, 0.2 + 0.35 * haze));

        // basalt, near-black and cool: the photographs' grain and value, none of their colour. Ribs a shade lighter than the
        // gullies (dust and scree lie in the gullies, the ribs are bare rock). Warmth only comes from light.
        float big = fbm(wp.xy * 0.06 + 4.0);
        float alb = rk.lum * mix(0.7, 1.15, big) * (0.85 + 0.3 * vnoise(wp.xy * 0.9 + 7.0));
        alb *= 0.9 + 0.25 * smoothstep(-6.0, 6.0, relief);
        alb *= mix(1.0, 0.38, uKind);
        vec3 albedo = vec3(0.92, 0.92, 1.0) * alb;
        float rough = clamp(rk.rough, 0.55, 1.0);
        float glassy = smoothstep(0.66, 0.82, fbm(wp.xy * 0.5 + 30.0)) * (1.0 - haze);
        rough = mix(rough, 0.35, glassy);
        float f0 = mix(0.035, 0.07, glassy);
        float occl = ao * mix(1.0, rk.ao, 0.6);

        // the lights. Specular is Blinn-Phong, from the moon and the warm lights.
        float shin = clamp(2.0 / (rough * rough * rough * rough) - 2.0, 4.0, 400.0);
        float norm = (shin + 8.0) / 25.13;
        vec3 diff = vec3(0.0), spec = vec3(0.0);
        float nlm = max(dot(N, uMoonDir), 0.0) * vis;
        diff += uMoonCol * nlm;
        spec += uMoonCol * pow(max(dot(N, normalize(uMoonDir + Vv)), 0.0), shin) * norm * f0 * nlm;
        diff += mix(uGroundAmb, uSkyAmb, N.y * 0.5 + 0.5) * occl;
        diff += uFillCol * max(dot(N, uFillDir), 0.0) * occl;
        // the orange heavens over the crater: warm on faces turned up, near the summit only
        float nearVent = exp(-dot(dv, dv) * 9.0);
        diff += uWarm * 0.09 * max(N.y, 0.0) * nearVent * occl;
        for (int i = 0; i < 2; i++){
          vec3 d = uLPos[i] - vWorld;
          float dist = length(d);
          d /= dist;
          float att = 1.0 / (1.0 + dist * dist / (uLRad[i] * uLRad[i]));
          // a short reach: warmth only near the vent and the lake, never a cast over the whole cone
          att *= 1.0 - smoothstep(3.5 * uLRad[i], 7.0 * uLRad[i], dist);
          if (i == 0) {
            // the vent's light climbs the crests' inner faces (the fountain lights them) and falls off on what stands well
            // above them (no shadows here: the spear's very top stays dark by hand), and less of it falls on the face below
            att *= 1.0 - 0.75 * smoothstep(1.8 * uCh, 4.2 * uCh, vWorld.y - uLPos[0].y);
            att *= mix(1.0, 0.45, smoothstep(0.3 * uCh, 1.5 * uCh, uLPos[0].y - vWorld.y));
          }
          float l = max(dot(N, d) * 0.85 + 0.15, 0.0);
          diff += uLCol[i] * att * l;
          spec += uLCol[i] * att * pow(max(dot(N, normalize(d + Vv)), 0.0), shin) * norm * f0 * l;
        }
        // the lava's light on the ground beside it, strongest on faces turned up (the mock's)
        diff += vec3(1.0, 0.3, 0.06) * glow * glow * 1.2 * (0.5 + 0.5 * max(N.y, 0.0));
        vec3 col = albedo * diff + spec;
        // fresnel rim: the sky's cold light on the edges, warm where the lava and the vent are near
        float fres = pow(1.0 - max(dot(N, Vv), 0.0), 4.0);
        col += fres * (uSkyAmb * 2.0 * occl + vec3(0.9, 0.3, 0.06) * (0.35 * glow + 0.08 * nearVent));
        // the foot falls into shadow
        col *= mix(1.0, 0.65, smoothstep(uPeakY + 0.4 * (uBaseY - uPeakY), uBaseY, vPlate.y) * (1.0 - glow));
        // the hills that run back from the cone sit in the air between it and the far peaks: the sky's colour, cooled and
        // dimmed (the haze over the hills is lit by the sky, not by the fire)
        vec3 air = skyColor(suv);
        air = mix(air, vec3(dot(air, vec3(0.3, 0.5, 0.2))) * vec3(0.8, 0.82, 1.25), 0.55) * 0.62;
        col = mix(col, air, haze * 0.6);

        gl_FragColor = vec4(col, 1.0);
        ${OUT}
        // premultiplied: the outline's own antialiasing is the alpha
        gl_FragColor = vec4(gl_FragColor.rgb * a, a);
      }`,
    ...OVER,
  })
}

function bodyMesh(part, material, order) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(part.positions, 3))
  geo.setAttribute('aPlate', new THREE.BufferAttribute(part.plate, 2))
  geo.setAttribute('aField', new THREE.BufferAttribute(part.field, 4))
  geo.setAttribute('aShade', new THREE.BufferAttribute(part.shade, 4))
  geo.setIndex(new THREE.BufferAttribute(part.index, 1))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  mesh.renderOrder = order
  return mesh
}

// ------------------------------------------------------------------ preview only: the page's far ridges, as it paints them
async function paintedRidges(input, W, H) {
  const { mountainForRoute, peakHeight } = await import('/src/lib/mountain.js')
  const { DEFAULTS, RANDOMIZE_DEFAULTS, ROUTE_PROFILE_DEFAULTS } = await import('/src/lib/fireTuning.js')
  const key = input.profile?.key ?? '/'
  const prof = ROUTE_PROFILE_DEFAULTS[key] ?? ROUTE_PROFILE_DEFAULTS['*']
  const tune = DEFAULTS.bed
  const randomize = RANDOMIZE_DEFAULTS
  // the page in a window the plate's size: its painted mountain, then MountDeathfire.vue's buildRidges from the same stream
  const { face, rng } = mountainForRoute({ path: key === '*' ? '/default' : key.replace('/*', ''), w: W, h: H, tune, prof, randomize })
  const grand = (a, b) => a + rng() * (b - a)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')
  for (let n = 0; n < Math.max(0, Math.round(tune.ridges)); n++) {
    const height = peakHeight(H, prof.scale, tune.height) * grand(0.22, 0.42)
    const side = rng() < 0.5 ? -1 : 1
    const parallax = randomize.ridges ? grand(-0.18, 0.18) * prof.variance : 0
    const peakX = (face + side * grand(0.32, 0.72) + parallax) * W
    const halfBase = grand(W * 0.16, W * 0.4)
    const pts = []
    for (let i = 14; i >= 0; i--) pts.push({ x: peakX - Math.pow(i / 14, 1.4) * halfBase, y: H - height + (i / 14) * height + grand(-1, 1) * height * 0.05 })
    for (let i = 0; i <= 14; i++) pts.push({ x: peakX + Math.pow(i / 14, 1.4) * halfBase, y: H - height + (i / 14) * height + grand(-1, 1) * height * 0.05 })
    const depth = grand(0.45, 0.85)
    g.beginPath()
    g.moveTo(pts[0].x, H + 20)
    for (const p of pts) g.lineTo(p.x, p.y)
    g.lineTo(pts[pts.length - 1].x, H + 20)
    g.closePath()
    g.fillStyle = `rgba(9, 18, 15, ${depth})`
    g.fill()
  }
  // the canvas's own (display-encoded) values, premultiplied, laid over the sky as the page's 2D canvas lays them
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.NoColorSpace
  t.premultiplyAlpha = true
  return quad(
    new THREE.ShaderMaterial({
      uniforms: { tMap: { value: t } },
      vertexShader: quadVS,
      fragmentShader: /* glsl */ `uniform sampler2D tMap; varying vec2 vUv;
        void main(){ gl_FragColor = texture2D(tMap, vUv); }`,
      ...OVER,
    }),
    -6,
  )
}

async function render() {
  const input = parseInput(inputParam())
  const { w: W, h: H } = input.canvas
  const canvas = document.getElementById('scene')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(W, H, !preview)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 0)
  if (preview) document.body.classList.add('preview')
  // preview only: view=x,y,s puts canvas pixel (x, y) at the window's corner, s screen pixels to one canvas pixel
  const view = preview ? (params.get('view') ?? '').split(',').map(Number) : []
  if (view.length === 3 && view.every(Number.isFinite)) {
    Object.assign(canvas.style, { position: 'absolute', maxWidth: 'none', maxHeight: 'none', width: `${W * view[2]}px`, height: `${H * view[2]}px`, left: `${-view[0] * view[2]}px`, top: `${-view[1] * view[2]}px`, imageRendering: 'pixelated' })
  }

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, W / H, 1, 10)
  const sky = skyUniforms(input, W, H)

  if (pass === 'sky' || preview) scene.add(skyMesh(sky))
  if (pass === 'rock' || preview) {
    const world = buildWorld({ mountain: input.mountain, canvas: input.canvas, channels: input.channels, seed: input.seed, bucket: input.bucket ?? 'wide', offset: input.offset, connected })
    const c = world.camera
    camera.fov = c.fov
    camera.near = c.near
    camera.far = c.far
    camera.position.set(c.x, c.y, c.z)
    camera.lookAt(c.x, c.y, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    const aniso = renderer.capabilities.getMaxAnisotropy()
    const base = './textures/'
    const [rd, rn, rr, rao, cd, cn, cr] = await Promise.all([
      loadTex(base + 'dark_rock_02/diffuse.jpg', true, aniso), // dark_rock's gold veins read as hot cracks
      loadTex(base + 'dark_rock/nor_gl.jpg', false, aniso),
      loadTex(base + 'dark_rock/rough.jpg', false, aniso),
      loadTex(base + 'dark_rock_02/ao.jpg', false, aniso),
      loadTex(base + 'dark_rock_02/diffuse.jpg', true, aniso),
      loadTex(base + 'rock_face_03/nor_gl.jpg', false, aniso),
      loadTex(base + 'dark_rock_02/rough.jpg', false, aniso),
    ])
    const tex = { tRockD: { value: rd }, tRockN: { value: rn }, tRockR: { value: rr }, tRockAO: { value: rao }, tCliffD: { value: cd }, tCliffN: { value: cn }, tCliffR: { value: cr } }
    const mask = maskTexture(world, W, H)
    scene.add(bodyMesh(world.body, rockMaterial(world, input, tex, mask, sky, 0), 0))
    if (world.fg) scene.add(bodyMesh(world.fg, rockMaterial(world, input, tex, mask, sky, 1), 5))
    window.__plateWorld = { hills: world.hills, foreground: world.foreground, frame: world.frame }
  }
  if (far) scene.add(await paintedRidges(input, W, H))

  await renderer.compileAsync(scene, camera)
  renderer.render(scene, camera)
  // two frames, so the drawn buffer is on screen before anyone screenshots it
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.__plateReady = { pass: preview ? 'preview' : pass, w: W, h: H }
}

render().catch(fail)
