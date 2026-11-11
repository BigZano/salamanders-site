// The plate renderer: Mount Deathfire's rock and sky, rendered once, offline, from the page's own mountain data.
// Grown from the lava3d mock (dev-mock/lava3d, a vetoed look kept as this scene's source): its sky, its rock material
// and its lights, without the moon, the lava, the fountain, the embers, the splinters, the steam, the title or any
// animation. The far ridges and the dark foreground ridge are the mock's too (its far hills and its haze pass's ridge).
//
// URL: index.html?plate=1&pass=sky|rock&input=<base64 JSON, see input.js>[&ridges=0]
//   pass=sky   the sky alone, opaque
//   pass=rock  the mountain and its ridges, on a transparent clear (premultiplied alpha)
//   ridges=0   the cone alone (to check its outline against the page's polygon)
// One still frame, then window.__plateReady = { pass, w, h } (or window.__plateError = message). The canvas is the
// input's canvas size at a pixel ratio of 1: the caller sizes the viewport to { w, h } and screenshots it.
// Deterministic: every noise is seeded from input.seed; nothing reads the clock.
import * as THREE from 'three'
import { parseInput } from './input.js'
import { buildRidges, buildWorld } from './world.js'

const params = new URLSearchParams(window.location.search)
const pass = params.get('pass') === 'sky' ? 'sky' : 'rock'
const withRidges = params.get('ridges') !== '0'

function fail(e) {
  window.__plateError = String(e?.message ?? e)
  console.error('[plate]', window.__plateError)
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

// The sky's colour at a canvas uv (linear, before tone mapping): the sky pass draws it, and the far ridges fade into it.
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

// ------------------------------------------------------------------ the ridges: crest lines (one y per column) in a texture
function crestTexture(crest, H) {
  const data = new Float32Array(crest.length)
  for (let i = 0; i < crest.length; i++) data[i] = Number.isFinite(crest[i]) ? crest[i] : H * 4
  const t = new THREE.DataTexture(data, crest.length, 1, THREE.RedFormat, THREE.FloatType)
  t.minFilter = t.magFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

// far: dark rock fading into the sky's own colour, a faint warm line on the crest where it faces the vent.
// near (the foreground ridge): near-black, its crest lit faintly by the air over the vent (the mock's haze pass).
function ridgeMesh({ crest, fade, near }, sky, W, H, order) {
  return quad(
    new THREE.ShaderMaterial({
      uniforms: { ...sky, tCrest: { value: crestTexture(crest, H) }, uFade: { value: fade ?? 0 }, uNear: { value: near ? 1 : 0 }, uRes: { value: new THREE.Vector2(W, H) } },
      vertexShader: quadVS,
      fragmentShader: /* glsl */ `
        uniform sampler2D tCrest; uniform float uFade, uNear; uniform vec2 uRes; varying vec2 vUv;
        ${NOISE}
        ${SKY}
        void main(){
          float yPx = uRes.y - gl_FragCoord.y; // down from the top, as the page counts
          float crest = texture2D(tCrest, vec2(gl_FragCoord.x / uRes.x, 0.5)).r;
          float below = yPx - crest;
          float a = clamp(below + 0.5, 0.0, 1.0); // a pixel's coverage of the crest
          if (a <= 0.0) discard;
          vec2 d = (vUv - uVentUv) * vec2(uAspect, 1.0) * max(1.0, 0.75 / uAspect);
          vec2 p = gl_FragCoord.xy / 40.0 + uSeed;
          vec3 rock = vec3(0.0042, 0.0034, 0.0046) * (0.6 + 0.8 * fbm(p * vec2(1.0, 1.6)));
          // the crest catches the air over the vent; below it the rock goes dark
          vec3 rim = uWarm * exp(-below / mix(10.0, 26.0, uNear)) * exp(-dot(d, d) * 1.8) * mix(0.35, 0.25, uNear);
          vec3 col = rock + rim;
          // far ones fade into the sky behind them, more toward the top of the ridge
          col = mix(col, skyColor(vUv) * 0.8, uFade * (0.75 + 0.25 * exp(-below / 120.0)));
          gl_FragColor = vec4(col, 1.0);
          ${OUT}
          gl_FragColor = vec4(gl_FragColor.rgb * a, a);
        }`,
      ...OVER,
    }),
    order,
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

// the outline, filled the way MountDeathfire.vue fills its silhouette: the mask the shader cuts the cone with
function maskTexture(poly, w, h) {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const g = cv.getContext('2d')
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  g.beginPath()
  g.moveTo(poly[0].x, poly[0].y)
  for (const p of poly.slice(1)) g.lineTo(p.x, p.y)
  g.closePath()
  g.fillStyle = '#fff'
  g.fill()
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.NoColorSpace
  t.minFilter = t.magFilter = THREE.NearestFilter
  t.generateMipmaps = false
  return t
}

function rockMaterial(world, input, tex, mask) {
  const m = input.mountain
  const W = world.canvas.w, H = world.canvas.h
  const lights = [world.vent, world.poolLight ?? world.vent]
  return new THREE.ShaderMaterial({
    uniforms: {
      uUnit: { value: world.unit },
      uRes: { value: new THREE.Vector2(W, H) },
      uSeedR: { value: new THREE.Vector2(((input.seed >>> 0) % 997) * 0.731, ((input.seed >>> 10) % 991) * 0.577) },
      // the mock's moon: a rim key from behind and left, so faces toward the camera stay dark and edges catch it
      uMoonDir: { value: new THREE.Vector3(-0.62, 0.5, -0.42).normalize() },
      uMoonCol: { value: new THREE.Vector3(0.55, 0.58, 0.74) },
      // the orange sky's bounce on faces turned up, and almost nothing from below
      uSkyAmb: { value: new THREE.Vector3(0.012, 0.0065, 0.0045) },
      uGroundAmb: { value: new THREE.Vector3(0.0015, 0.0012, 0.0015) },
      uWarm: { value: HAZE_WARM },
      uVentUv: { value: new THREE.Vector2(m.vent.x / W, 1 - m.vent.y / H) },
      uApex: { value: new THREE.Vector2(m.peakX, world.sizes.tipY) },
      uLPos: { value: lights.map((p) => new THREE.Vector3(p.x, p.y, p.z)) },
      uLCol: { value: [new THREE.Vector3(4.0, 1.35, 0.28), new THREE.Vector3(world.poolLight ? 1.4 : 0, world.poolLight ? 0.4 : 0, world.poolLight ? 0.08 : 0)] },
      uLRad: { value: [0.75 * world.sizes.ch, world.poolLight ? 0.5 * (m.pool?.rx ?? 1) : 1] },
      uPeakY: { value: world.sizes.tipY },
      uBaseY: { value: world.sizes.baseY },
      uHm: { value: world.sizes.Hm },
      tMask: { value: mask },
      ...tex,
    },
    vertexShader: /* glsl */ `
      attribute vec2 aPlate; attribute vec4 aField;
      varying vec3 vWorld; varying vec3 vNormal; varying vec2 vPlate; varying vec4 vField;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vPlate = aPlate;
        vField = aField;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uUnit, uPeakY, uBaseY, uHm; uniform vec2 uRes, uSeedR, uVentUv, uApex;
      uniform vec3 uMoonDir, uMoonCol, uSkyAmb, uGroundAmb, uWarm;
      uniform vec3 uLPos[2]; uniform vec3 uLCol[2]; uniform float uLRad[2];
      uniform sampler2D tMask, tRockD, tRockN, tRockR, tRockAO, tCliffD, tCliffN, tCliffR;
      varying vec3 vWorld; varying vec3 vNormal; varying vec2 vPlate; varying vec4 vField;
      ${NOISE}

      // The mock's triplanar rock: dark_rock's relief on faces turned up; everywhere dark_rock_02's grey basalt; on the steep
      // faces rock_face_03's fractured relief (the mock's cliff_side is a tan sandstone and read as leather here); two scales
      // of each, blended by a slow mask so no tile repeats; the normal maps blended the whiteout way.
      struct Rock { vec3 alb; vec3 N; float rough; float ao; };
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
        Rock r;
        r.alb = dX * w.x + dY * w.y + dZ * w.z;
        r.rough = rX * w.x + rY * w.y + rZ * w.z;
        r.ao = mix(1.0, aoY, w.y);
        vec3 bx = tnBlend(nX, Ng.zy, Ng.x), by = tnBlend(nY, Ng.xz, Ng.y), bz = tnBlend(nZ, Ng.xy, Ng.z);
        r.N = normalize(bx.zyx * w.x + by.xzy * w.y + bz.xyz * w.z);
        r.N = normalize(mix(r.N, Ng, smoothstep(0.08, 0.5, px)));
        return r;
      }

      // the mock's lighting, without its cool sky fill: the moon's rim, the sky's warm bounce on faces turned up, a
      // barely-there cool on the side away from the vent, and the two warm lights (vent, lake). Specular from the warm
      // lights only, and broad.
      vec3 light(vec3 N, vec3 Vv, float rough, float f0, float crest){
        float shin = clamp(2.0 / (rough * rough * rough * rough) - 2.0, 4.0, 60.0);
        float norm = (shin + 8.0) / 25.13;
        vec3 o = uMoonCol * max(dot(N, uMoonDir), 0.0) * mix(1.0, 0.55, crest);
        o += mix(uGroundAmb, uSkyAmb, max(N.y, 0.0));
        float away = smoothstep(0.0, 0.25, gl_FragCoord.x / uRes.x - uVentUv.x);
        o += vec3(0.008, 0.009, 0.016) * max(dot(N, normalize(vec3(0.9, 0.35, 0.25))), 0.0) * away;
        for (int i = 0; i < 2; i++){
          vec3 d = uLPos[i] - vWorld;
          float dist = length(d);
          d /= dist;
          float att = 1.0 / (1.0 + dist * dist / (uLRad[i] * uLRad[i]));
          float l = max(dot(N, d) * 0.85 + 0.15, 0.0);
          o += uLCol[i] * att * (l + pow(max(dot(N, normalize(d + Vv)), 0.0), shin) * norm * f0 * l);
        }
        return o;
      }

      void main(){
        float a = texture2D(tMask, gl_FragCoord.xy / uRes).r;
        if (a < 0.002) discard;
        float glow = vField.x, pool = vField.y, crest = vField.z;
        // the page's own plane, y up, in the mock's units
        vec2 p = vec2(vPlate.x, -vPlate.y) / uUnit + uSeedR;
        vec3 wp = vWorld / uUnit + vec3(uSeedR, 0.0);
        float px = length(fwidth(p)) + 1e-4;
        vec3 Vv = normalize(cameraPosition - vWorld);
        vec3 Ng = normalize(vNormal);

        // fine strata down the fall line (the mock's slope-following lines): fast across the slope, slow down it, the
        // angle warped so they wander and break; lumps on the gentler ground
        vec2 dp = vPlate - uApex;
        float r = length(dp);
        float th = atan(dp.x, max(dp.y, 1.0));
        float warpA = (fbm(vec2(th * 4.0, r / (0.3 * uHm)) + uSeedR) - 0.5) * 0.12;
        // across the slope in pixels (angle times radius), so the lines keep one spacing from the summit to the foot
        float across = (th + warpA) * max(r, 0.2 * uHm) / 9.0;
        float lines = vnoise(vec2(across, r / (0.05 * uHm)) + uSeedR);
        // (not on the crown, where the angle turns too fast to hold a line: its own fracture planes carry it)
        float breaks = smoothstep(0.3, 0.7, vnoise(vec2(across / 6.0, r / (0.04 * uHm)) + uSeedR * 2.0)) * smoothstep(0.12 * uHm, 0.3 * uHm, r) * (1.0 - crest);
        float hb = fbm(p * 0.7) * 0.3 + (1.0 - abs(2.0 * lines - 1.0)) * 0.16 * breaks * (1.0 - pool);
        vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
        float hx = dFdx(hb), hy = dFdy(hb);
        vec3 r1 = cross(dpy, Ng), r2 = cross(Ng, dpx);
        float det = dot(dpx, r1);
        // the bump is 0.35 of the mock's unit tall, in world pixels
        vec3 N = normalize(abs(det) * Ng - 0.35 * uUnit * sign(det) * (hx * r1 + hy * r2));

        // basalt, near-black: the photographed rock's grain and value, none of its colour. Warmth only comes from light.
        Rock rk = rockSample(wp, N, px);
        float lum = dot(rk.alb, vec3(0.2126, 0.7152, 0.0722));
        float big = fbm(p * 0.08 + 4.0);
        vec3 alb = vec3(0.92, 0.9, 0.95) * lum * mix(0.85, 1.25, big) * (0.8 + 0.4 * vnoise(p * 0.9 + 7.0));
        N = rk.N;
        float rough = clamp(rk.rough, 0.8, 1.0);
        float ao = mix(1.0, rk.ao, 0.8);
        float f0 = 0.02;

        vec3 E = light(N, Vv, rough, f0, crest);
        // the lava's light on the ground beside it, strongest on faces turned up (the mock's)
        E += vec3(1.0, 0.3, 0.06) * glow * glow * 1.2 * (0.5 + 0.5 * max(N.y, 0.0));
        vec3 col = alb * E * ao;
        // the crown: rim-lit warm on the side that faces the vent, and only there
        vec3 toVent = normalize(uLPos[0] - vWorld);
        float fres = pow(1.0 - max(dot(N, Vv), 0.0), 3.0);
        col += vec3(0.9, 0.3, 0.06) * fres * max(dot(N, toVent), 0.0) * (0.12 * crest + 0.3 * glow);
        // the foot falls into shadow; the air over the vent is lit (the mock's haze, faint)
        col *= mix(1.0, 0.6, smoothstep(uPeakY + 0.35 * (uBaseY - uPeakY), uBaseY, vPlate.y) * (1.0 - glow));
        vec2 suv = gl_FragCoord.xy / uRes;
        float asp = uRes.x / uRes.y;
        vec2 dv = (suv - uVentUv) * vec2(asp, 1.0) * max(1.0, 0.75 / asp);
        col += uWarm * 0.03 * exp(-dot(dv, dv) * 10.0);

        gl_FragColor = vec4(col, 1.0);
        ${OUT}
        // premultiplied: the outline's own antialiasing is the alpha
        gl_FragColor = vec4(gl_FragColor.rgb * a, a);
      }`,
    ...OVER,
  })
}

async function render() {
  const input = parseInput(params.get('input'))
  const { w: W, h: H } = input.canvas
  const canvas = document.getElementById('scene')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(W, H)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, W / H, 1, 10)
  const sky = skyUniforms(input, W, H)

  if (pass === 'sky') {
    scene.add(skyMesh(sky))
  } else {
    const world = buildWorld({ mountain: input.mountain, canvas: input.canvas, channels: input.channels, seed: input.seed })
    const c = world.camera
    camera.fov = c.fov
    camera.near = c.near
    camera.far = c.far
    camera.position.set(c.x, c.y, c.z)
    camera.lookAt(c.x, c.y, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(world.positions, 3))
    geo.setAttribute('aPlate', new THREE.BufferAttribute(world.plate, 2))
    const field = new Float32Array(world.glow.length * 4)
    for (let i = 0; i < world.glow.length; i++) field.set([world.glow[i], world.poolMask[i], world.crest[i], world.inside[i]], i * 4)
    geo.setAttribute('aField', new THREE.BufferAttribute(field, 4))
    geo.setIndex(new THREE.BufferAttribute(world.index, 1))
    geo.computeVertexNormals()

    const aniso = renderer.capabilities.getMaxAnisotropy()
    const base = './textures/'
    const [rd, rn, rr, rao, cd, cn, cr] = await Promise.all([
      loadTex(base + 'dark_rock_02/diffuse.jpg', true, aniso), // dark_rock's gold veins read as hot cracks
      loadTex(base + 'dark_rock/nor_gl.jpg', false, aniso),
      loadTex(base + 'dark_rock/rough.jpg', false, aniso),
      loadTex(base + 'dark_rock/ao.jpg', false, aniso),
      loadTex(base + 'dark_rock_02/diffuse.jpg', true, aniso),
      loadTex(base + 'rock_face_03/nor_gl.jpg', false, aniso),
      loadTex(base + 'dark_rock_02/rough.jpg', false, aniso),
    ])
    const tex = {
      tRockD: { value: rd },
      tRockN: { value: rn },
      tRockR: { value: rr },
      tRockAO: { value: rao },
      tCliffD: { value: cd },
      tCliffN: { value: cn },
      tCliffR: { value: cr },
    }
    const cone = new THREE.Mesh(geo, rockMaterial(world, input, tex, maskTexture(world.outline, W, H)))
    cone.frustumCulled = false
    cone.renderOrder = 0
    scene.add(cone)

    if (withRidges) {
      const floor = H - input.offset.y
      const ridges = buildRidges({ mountain: input.mountain, canvas: input.canvas, floor, channels: input.channels, seed: input.seed })
      ridges.far.forEach((r, i) => scene.add(ridgeMesh(r, sky, W, H, -5 + i)))
      scene.add(ridgeMesh({ crest: ridges.fg.crest, near: true }, sky, W, H, 5))
    }
  }

  await renderer.compileAsync(scene, camera)
  renderer.render(scene, camera)
  // two frames, so the drawn buffer is on screen before anyone screenshots it
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.__plateReady = { pass, w: W, h: H }
}

render().catch(fail)
