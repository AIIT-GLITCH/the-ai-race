// THE AI RACE — a one-shot orbital compute sprint. Three.js, fixed-step
// physics on a 3D track manifold (elevation + banking are load-bearing physics,
// not decoration).
//
// Simulation lives in TRACK SPACE: each ship is (s, lat) on the track surface
// with velocity (vA along tangent, vL along right) and a relative yaw psi
// (psi>0 = nose toward +right). Pseudo-forces make the geometry real:
//   centrifugal  vL += k * vA^2 * dt          (k>0 = track turns left)
//   banking      vL += g * sin(bank) * dt     (proper banks cancel centrifugal)
//   slope        vA -= g * tangent.y * dt     (climbs cost speed, drops pay it back)
// Steer input +1 = LEFT (psi decreases). Verified by the __aiRace test seam.
import * as THREE from './vendor/three.module.js';
import { buildTrack, nearestSample, validateTrack, HALF_WIDTH, WALL_OFFSET } from './track.js';

// ---------- deterministic PRNG for scenery ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xA17ACE);

// ---------- track ----------
const track = buildTrack();
const trackStats = validateTrack(track);
if (!trackStats.ok) console.error('TRACK INVALID:', trackStats.problems);
const L = track.total;
const STEP = track.step;
const N = track.pts.length;
const START_IDX = 30; // HELIOS launch straight
const startS = START_IDX * STEP;
const wrapI = i => ((i % N) + N) % N;
const wrapS = s => ((s % L) + L) % L;
function deltaS(a, b) {
  let d = b - a;
  if (d > L / 2) d -= L;
  if (d < -L / 2) d += L;
  return d;
}
// continuous frame at arclength s (lerped between samples, renormalized)
const _fr = { p: [0, 0, 0], t: [0, 0, 0], u: [0, 0, 0], r: [0, 0, 0], k: 0, bank: 0 };
function frameAt(s) {
  const f = wrapS(s) / STEP;
  const i0 = wrapI(Math.floor(f)), i1 = wrapI(i0 + 1);
  const a = f - Math.floor(f);
  const P = track.pts, T = track.tangents, U = track.ups, R = track.rights;
  for (let c = 0; c < 3; c++) {
    _fr.p[c] = P[i0][c] + (P[i1][c] - P[i0][c]) * a;
    _fr.t[c] = T[i0][c] + (T[i1][c] - T[i0][c]) * a;
    _fr.u[c] = U[i0][c] + (U[i1][c] - U[i0][c]) * a;
    _fr.r[c] = R[i0][c] + (R[i1][c] - R[i0][c]) * a;
  }
  for (const v of [_fr.t, _fr.u, _fr.r]) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    v[0] /= l; v[1] /= l; v[2] /= l;
  }
  _fr.k = track.curvature[i0] + (track.curvature[i1] - track.curvature[i0]) * a;
  _fr.bank = track.bank[i0] + (track.bank[i1] - track.bank[i0]) * a;
  return _fr;
}
function curveAhead(s, meters) {
  const i = Math.round(wrapS(s) / STEP);
  const n = Math.ceil(meters / STEP);
  let k = 0;
  for (let j = 0; j <= n; j += 2) k = Math.max(k, Math.abs(track.curvature[wrapI(i + j)]));
  return k;
}
function signedCurveAhead(s, meters) {
  const i = Math.round(wrapS(s) / STEP);
  const n = Math.ceil(meters / STEP);
  let best = 0;
  for (let j = 0; j <= n; j += 2) {
    const k = track.curvature[wrapI(i + j)];
    if (Math.abs(k) > Math.abs(best)) best = k;
  }
  return best;
}

// ---------- physics constants ----------
const DT = 1 / 120;
const GRAV = 9.81;
const SHIP_R = 1.15;
const EDGE = HALF_WIDTH - SHIP_R;
const ACCEL = 28, BRAKE = 36;
const GRIP = 6.7, GRIP_DRIFT = 1.65;
const BOOST_ACCEL = 24, BOOST_DRAIN = 27, PAD_CHARGE = 34, PAD_KICK = 10;
const SHIELD_MAX = 100, BOOST_VMAX_MUL = 1.3;
const LAPS = 1;

// Mission sectors and energy zones are expressed as fractions of the orbital
// ribbon. The visible sector gates and HUD use the same source of truth.
const SECTORS = [
  { f: 0.00, code: '01', name: 'HELIOS LAUNCH ARRAY' },
  { f: 0.16, code: '02', name: 'KARMAN CLIMB' },
  { f: 0.35, code: '03', name: 'LUNAR SLINGSHOT' },
  { f: 0.55, code: '04', name: 'DARK-SIDE SWITCHBACK' },
  { f: 0.74, code: '05', name: 'QUANTUM DATA STREAM' },
  { f: 0.91, code: '06', name: 'HELIOS COMPUTE ARRAY' },
];
const PADS = [
  { f: 0.105, len: 18 },
  { f: 0.285, len: 18 },
  { f: 0.485, len: 18 },
  { f: 0.675, len: 18 },
  { f: 0.855, len: 22 },
];
const DATA_CORES = [
  { f: 0.065, lat: -6.2 }, { f: 0.135, lat: 5.8 },
  { f: 0.235, lat: -4.8 }, { f: 0.39, lat: 6.4 },
  { f: 0.525, lat: -6.1 }, { f: 0.63, lat: 4.9 },
  { f: 0.76, lat: -5.5 }, { f: 0.925, lat: 5.7 },
];
const RECHARGE = { f: 0.952, len: 46 };
const TUNNEL = { f0: 0.79, f1: 0.90 };

// ---------- roster ----------
const ROSTER = [
  { name: 'ANTHROPIC', color: 0xd97745, vmax: 83.8, latG: 20.2, look: 1.18, risk: 0.91, burstAt: 65, lane: -4.1 },
  { name: 'DEEPMIND',  color: 0x4285f4, vmax: 85.0, latG: 21.4, look: 1.16, risk: 0.97, burstAt: 58, lane: 2.5 },
  { name: 'xAI',       color: 0xf4f4f4, vmax: 87.2, latG: 20.5, look: 0.94, risk: 1.05, burstAt: 35, lane: 4.6 },
  { name: 'META',      color: 0x2788f5, vmax: 84.5, latG: 21.1, look: 1.08, risk: 0.98, burstAt: 52, lane: -1.6 },
  { name: 'DEEPSEEK',  color: 0x37d6e9, vmax: 84.8, latG: 20.8, look: 1.12, risk: 0.96, burstAt: 70, lane: 3.7 },
  { name: 'MISTRAL',   color: 0xff8a21, vmax: 84.1, latG: 20.1, look: 1.03, risk: 1.00, burstAt: 48, lane: -3.2 },
  { name: 'QWEN',      color: 0x8b5cf6, vmax: 84.7, latG: 20.7, look: 1.09, risk: 0.98, burstAt: 55, lane: 1.5 },
  { name: 'MOONSHOT',  color: 0xffdc5d, vmax: 85.4, latG: 20.3, look: 1.02, risk: 1.02, burstAt: 42, lane: 4.2 },
  { name: 'COHERE',    color: 0xff6b5b, vmax: 83.5, latG: 20.4, look: 1.14, risk: 0.94, burstAt: 62, lane: -4.6 },
  { name: 'MINIMAX',   color: 0xff3e93, vmax: 84.4, latG: 20.6, look: 1.01, risk: 1.01, burstAt: 45, lane: 0.8 },
  { name: 'MICROSOFT', color: 0x7fdb55, vmax: 84.2, latG: 20.8, look: 1.13, risk: 0.96, burstAt: 57, lane: -2.4 },
  { name: 'OPENAI',    color: 0xdfff47, vmax: 89.5, latG: 22.8, look: 1.04, risk: 1.03, burstAt: 38, lane: 0, player: true },
];

// ---------- renderer / scene ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, matchMedia('(pointer: coarse)').matches ? 1.35 : 1.75));
renderer.toneMapping = THREE.NoToneMapping; // ACES lives in the composite pass
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x060912, 640, 2300);
const camera = new THREE.PerspectiveCamera(64, 1, 0.1, 5200);

// ---------- orbital sky: starfield + Earth limb + solar glow ----------
const MOON_DIR = new THREE.Vector3(-310, 240, -170).normalize();
function makeSkyMesh() {
  const geo = new THREE.SphereGeometry(3600, 40, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x020207) },
      bot: { value: new THREE.Color(0x090b18) },
      moonDir: { value: MOON_DIR },
      auroraA: { value: new THREE.Color(0x1de9b6) },
      auroraB: { value: new THREE.Color(0x7c4dff) },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform vec3 top; uniform vec3 bot; uniform vec3 moonDir;
      uniform vec3 auroraA; uniform vec3 auroraB; varying vec3 vP;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164)))*43758.5453); }
      void main(){
        vec3 d = normalize(vP);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(bot, top, pow(h, 0.6));
        col += vec3(0.05, 0.13, 0.24) * exp(-abs(d.y + 0.1) * 8.0) * 0.5;
        float m = max(dot(d, moonDir), 0.0);
        col += vec3(0.85, 0.92, 1.0) * pow(m, 1400.0) * 4.0;           // moon disc (HDR)
        col += vec3(0.45, 0.55, 0.8) * pow(m, 24.0) * 0.22;            // halo
        // charged solar ribbons high above the orbital course
        float band1 = exp(-abs(d.y - 0.34 - 0.055*sin(d.x*3.0 + d.z*2.0)) * 13.0);
        float band2 = exp(-abs(d.y - 0.48 - 0.045*sin(d.x*5.0 - d.z*3.0)) * 16.0);
        float wob = 0.5 + 0.5 * sin(d.x*7.0 + d.z*4.0);
        col += auroraA * band1 * (0.35 + 0.45*wob) * 1.15;
        col += auroraB * band2 * (0.3 + 0.4*(1.0-wob)) * 0.9;
        vec3 cell = floor(d * 260.0);
        float star = step(0.9978, hash(cell)) * smoothstep(-0.35, 0.05, d.y);
        col += vec3(star) * (0.4 + 0.9 * hash(cell + 1.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  return new THREE.Mesh(geo, mat);
}
scene.add(makeSkyMesh());
{
  const envScene = new THREE.Scene();
  envScene.add(makeSkyMesh());
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
}
scene.add(new THREE.HemisphereLight(0xa6c8ff, 0x111522, 0.9));
const moon = new THREE.DirectionalLight(0xbdd2ff, 1.6);
moon.position.copy(MOON_DIR).multiplyScalar(400);
scene.add(moon);

// ---------- procedural textures ----------
function noiseCanvas(base, spread, speckles, w = 256) {
  const cv = document.createElement('canvas'); cv.width = cv.height = w;
  const c2 = cv.getContext('2d');
  c2.fillStyle = base; c2.fillRect(0, 0, w, w);
  for (let i = 0; i < speckles; i++) {
    const v = (rng() - 0.5) * 2 * spread;
    c2.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v)})`;
    c2.fillRect(Math.floor(rng() * w), Math.floor(rng() * w), 1 + Math.floor(rng() * 2), 1 + Math.floor(rng() * 2));
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const deckTex = noiseCanvas('#1c1e2a', 0.07, 6000);
const glowTex = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c2 = cv.getContext('2d');
  const g = c2.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c2.fillStyle = g; c2.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();

// ---------- Earth below the orbital ribbon ----------
{
  const earthMat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      sunDir: { value: MOON_DIR },
      ocean: { value: new THREE.Color(0x061d37) },
      land: { value: new THREE.Color(0x174f55) },
      ice: { value: new THREE.Color(0xbde8ed) },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vP;
      void main(){ vN=normalize(normalMatrix*normal); vP=normalize(position);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 sunDir; uniform vec3 ocean; uniform vec3 land; uniform vec3 ice;
      varying vec3 vN; varying vec3 vP;
      float hash(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
      float noise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){
        float n=noise(vP*4.2)+noise(vP*9.0)*0.45+noise(vP*21.0)*0.16;
        float continent=smoothstep(.72,.88,n+abs(vP.y)*.05);
        vec3 base=mix(ocean,land,continent);
        base=mix(base,ice,smoothstep(.78,.96,abs(vP.y)));
        float light=.13+.87*max(dot(vN,normalize(sunDir)),0.0);
        float city=step(.84,noise(vP*52.0))*continent*(1.0-smoothstep(-.12,.12,dot(vN,normalize(sunDir))));
        gl_FragColor=vec4(base*light+vec3(1.0,.55,.18)*city*1.8,1.0);
      }`,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(760, 64, 32), earthMat);
  // Offset the planet downrange so its curved limb reads on the horizon instead
  // of behaving like a conventional ground plane.
  earth.position.set(1350, -520, 100);
  earth.rotation.z = -0.22;
  scene.add(earth);
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(775, 64, 32),
    new THREE.MeshBasicMaterial({
      color: 0x56bfff, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false, fog: false,
    }));
  atmosphere.position.copy(earth.position);
  scene.add(atmosphere);
}

// mountain silhouette rings on the horizon
function mountainRing(radius, height, color, seedOff) {
  const SEG = 220, pos = [], idxs = [];
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const j = i % SEG;
    const n = Math.sin(j * 12.9898 + seedOff) * 43758.5453;
    const r1 = n - Math.floor(n);
    const h = height * (0.35 + 0.65 * Math.abs(Math.sin(j * 0.23 + seedOff) * 0.6 + (r1 - 0.5) * 0.8));
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    pos.push(x, -14, z, x, h, z);
    if (i < SEG) { const b = i * 2; idxs.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idxs);
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, fog: false, side: THREE.DoubleSide })));
}
// ---------- HELIOS compute monoliths around the orbital course ----------
{
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
  const c2 = cv.getContext('2d');
  c2.fillStyle = '#05060e'; c2.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 124; y += 7) for (let x = 4; x < 60; x += 9) {
    if (rng() < 0.42) {
      const warm = rng() < 0.35;
      c2.fillStyle = warm ? 'rgba(255,190,120,0.9)' : 'rgba(120,210,255,0.85)';
      c2.fillRect(x, y, 5, 3.5);
    }
  }
  const winTex = new THREE.CanvasTexture(cv);
  winTex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshBasicMaterial({ map: winTex, color: 0xbfd4ff });
  const COUNT = 112;
  const inst = new THREE.InstancedMesh(geo, mat, COUNT);
  const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < COUNT; i++) {
    const ring = i < 72 ? 0 : 1;
    const a = rng() * Math.PI * 2;
    const rad = ring === 0 ? 520 + rng() * 190 : 820 + rng() * 260;
    const w = 18 + rng() * 34, h = 80 + rng() * 250;
    Q.setFromAxisAngle(UP, rng() * Math.PI * 2);
    inst.setMatrixAt(i, M.compose(P.set(Math.cos(a) * rad, -70, Math.sin(a) * rad), Q, S.set(w, h, w)));
  }
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// ---------- track meshes ----------
// ribbon builder in full 3D: lateral offsets + an offset along the frame's up
function buildStrip3D(latA, latB, upOff, mat, opts = {}) {
  const pos = [], nrm = [], uvs = [], idxs = [];
  for (let i = 0; i <= N; i++) {
    const ii = wrapI(i);
    const p = track.pts[ii], r = track.rights[ii], u = track.ups[ii];
    const la = typeof latA === 'function' ? latA(ii) : latA;
    const lb = typeof latB === 'function' ? latB(ii) : latB;
    const ua = typeof upOff === 'function' ? upOff(ii, 0) : upOff;
    const ub = typeof upOff === 'function' ? upOff(ii, 1) : upOff;
    pos.push(
      p[0] + r[0] * la + u[0] * ua, p[1] + r[1] * la + u[1] * ua, p[2] + r[2] * la + u[2] * ua,
      p[0] + r[0] * lb + u[0] * ub, p[1] + r[1] * lb + u[1] * ub, p[2] + r[2] * lb + u[2] * ub);
    nrm.push(u[0], u[1], u[2], u[0], u[1], u[2]);
    const v = (i * STEP) / (opts.uvLen ?? 9);
    uvs.push(0, v, 1, v);
    if (i < N) { const b = i * 2; idxs.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idxs);
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);
  return mesh;
}
// deck: dark reflective composite
deckTex.repeat.set(2, 1);
buildStrip3D(-HALF_WIDTH, HALF_WIDTH, 0, new THREE.MeshStandardMaterial({
  map: deckTex, color: 0xffffff, roughness: 0.42, metalness: 0.55, envMapIntensity: 1.1,
}));
// under-deck skirts (so the track reads as a solid elevated structure)
const skirtMat = new THREE.MeshStandardMaterial({ color: 0x0d0f1a, roughness: 0.7, metalness: 0.4, side: THREE.DoubleSide });
for (const side of [-1, 1]) {
  buildStrip3D(side * (HALF_WIDTH + 0.12), side * (HALF_WIDTH + 0.12), (ii, e) => e ? -1.6 : 0.06, skirtMat);
}
buildStrip3D(-HALF_WIDTH, HALF_WIDTH, -1.6, skirtMat); // underside

// neon edge rails: left cyan, right hot pink (orientation cue + bloom food)
const railL = new THREE.MeshBasicMaterial({ color: 0x9ff4ff, fog: false });
railL.color.multiplyScalar(2.4);
const railR = new THREE.MeshBasicMaterial({ color: 0xff8ee6, fog: false });
railR.color.multiplyScalar(2.4);
buildStrip3D(-HALF_WIDTH + 0.12, -HALF_WIDTH + 0.62, 0.03, railL);
buildStrip3D(HALF_WIDTH - 0.62, HALF_WIDTH - 0.12, 0.03, railR);

// center dashes: faint slate-blue modules for speed perception on the dark deck
{
  const dashGeo = new THREE.PlaneGeometry(0.34, 2.4);
  const dashMat = new THREE.MeshBasicMaterial({ color: 0x3d4f86, fog: true });
  const every = Math.max(1, Math.round(6.5 / STEP));
  const slots = [];
  for (let i = 0; i < N; i += every) slots.push(i);
  const inst = new THREE.InstancedMesh(dashGeo, dashMat, slots.length);
  const M = new THREE.Matrix4(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), P = new THREE.Vector3();
  const R = new THREE.Matrix4().makeRotationX(-Math.PI / 2); // plane lies flat, long side along track
  slots.forEach((i, n) => {
    const p = track.pts[i], tt = track.tangents[i], u = track.ups[i], r = track.rights[i];
    X.set(r[0], r[1], r[2]); Y.set(u[0], u[1], u[2]); Z.set(tt[0], tt[1], tt[2]);
    M.makeBasis(X, Y, Z).multiply(R);
    M.setPosition(P.set(p[0] + u[0] * 0.025, p[1] + u[1] * 0.025, p[2] + u[2] * 0.025));
    inst.setMatrixAt(n, M);
  });
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// energy walls: additive gradient panels just past the deck edge
{
  const wallShader = (tint) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { tint: { value: new THREE.Color(tint) }, uT: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform vec3 tint; uniform float uT; varying vec2 vUv;
      void main(){
        float x = fract(vUv.x);
        float fade = pow(1.0 - x, 2.0);
        float pulse = 0.75 + 0.25 * sin(vUv.y * 2.2 - uT * 2.4);
        gl_FragColor = vec4(tint * fade * pulse * 0.5, fade * 0.4);
      }`,
  });
  window.__wallMats = [];
  for (const side of [-1, 1]) {
    const m = wallShader(side < 0 ? 0x53d8ff : 0xff6ad5);
    window.__wallMats.push(m);
    // uv.x runs across the strip: 0 at deck level -> 1 at top
    const off = side * (HALF_WIDTH + WALL_OFFSET);
    const mesh = buildStrip3D(off, off, (ii, e) => e ? 2.0 : 0.05, m, { uvLen: 14 });
    mesh.renderOrder = 5;
  }
}

// boost pads: scrolling chevron ribbons
const padMats = [];
{
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
  const c2 = cv.getContext('2d');
  c2.fillStyle = '#000'; c2.fillRect(0, 0, 128, 128);
  c2.fillStyle = '#fff';
  for (const y0 of [8, 72]) {
    c2.beginPath();
    c2.moveTo(10, y0 + 26); c2.lineTo(64, y0); c2.lineTo(118, y0 + 26);
    c2.lineTo(118, y0 + 44); c2.lineTo(64, y0 + 18); c2.lineTo(10, y0 + 44);
    c2.closePath(); c2.fill();
  }
  const chevTex = new THREE.CanvasTexture(cv);
  chevTex.wrapS = chevTex.wrapT = THREE.RepeatWrapping;
  for (const pad of PADS) {
    const i0 = Math.round((pad.f * L) / STEP), n = Math.round(pad.len / STEP);
    const tex = chevTex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(1, Math.max(1, Math.round(pad.len / 6)));
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0xffc857, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    mat.color.multiplyScalar(2.2);
    padMats.push(mat);
    const pos = [], uvs = [], idxs = [];
    for (let j = 0; j <= n; j++) {
      const ii = wrapI(i0 + j);
      const p = track.pts[ii], r = track.rights[ii], u = track.ups[ii];
      const w = HALF_WIDTH - 1.1;
      pos.push(
        p[0] - r[0] * w + u[0] * 0.05, p[1] - r[1] * w + u[1] * 0.05, p[2] - r[2] * w + u[2] * 0.05,
        p[0] + r[0] * w + u[0] * 0.05, p[1] + r[1] * w + u[1] * 0.05, p[2] + r[2] * w + u[2] * 0.05);
      uvs.push(0, j / n * tex.repeat.y, 1, j / n * tex.repeat.y);
      if (j < n) { const b = j * 2; idxs.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idxs);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    scene.add(mesh);
  }
}
// recharge strip: green pulsing band
let rechargeMat;
{
  rechargeMat = new THREE.MeshBasicMaterial({
    color: 0x3ef2b4, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const i0 = Math.round((RECHARGE.f * L) / STEP), n = Math.round(RECHARGE.len / STEP);
  const pos = [], idxs = [];
  for (let j = 0; j <= n; j++) {
    const ii = wrapI(i0 + j);
    const p = track.pts[ii], r = track.rights[ii], u = track.ups[ii];
    const w = HALF_WIDTH - 0.7;
    pos.push(
      p[0] - r[0] * w + u[0] * 0.04, p[1] - r[1] * w + u[1] * 0.04, p[2] - r[2] * w + u[2] * 0.04,
      p[0] + r[0] * w + u[0] * 0.04, p[1] + r[1] * w + u[1] * 0.04, p[2] + r[2] * w + u[2] * 0.04);
    if (j < n) { const b = j * 2; idxs.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idxs);
  const mesh = new THREE.Mesh(geo, rechargeMat);
  mesh.renderOrder = 3;
  scene.add(mesh);
}

// Data cores are optional high-value pickups placed off the obvious line. They
// reward the warm, readable route-choice play from Fable GP without turning the
// race into a weapon game.
const dataCoreMeshes = [];
{
  const shellMat = new THREE.MeshBasicMaterial({
    color: 0x6cecff, wireframe: true, transparent: true, opacity: .88,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  shellMat.color.multiplyScalar(1.7);
  const heartMat = new THREE.MeshBasicMaterial({ color: 0xdfff47, fog: false });
  heartMat.color.multiplyScalar(2.1);
  for (const core of DATA_CORES) {
    const s = core.f * L;
    const f = frameAt(s);
    const group = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.OctahedronGeometry(.82, 1), shellMat);
    const heart = new THREE.Mesh(new THREE.OctahedronGeometry(.28, 0), heartMat);
    group.add(shell, heart);
    group.position.set(
      f.p[0] + f.r[0] * core.lat + f.u[0] * 1.35,
      f.p[1] + f.r[1] * core.lat + f.u[1] * 1.35,
      f.p[2] + f.r[2] * core.lat + f.u[2] * 1.35);
    const light = new THREE.PointLight(0x6cecff, 1.4, 15, 2);
    group.add(light);
    core.mesh = group;
    core.collected = false;
    dataCoreMeshes.push(group);
    scene.add(group);
  }
}

// pylons: deck to canyon floor
{
  const geo = new THREE.BoxGeometry(1.6, 1, 1.6);
  geo.translate(0, -0.5, 0); // origin at top, extends down
  const mat = new THREE.MeshStandardMaterial({ color: 0x141726, roughness: 0.6, metalness: 0.5 });
  const every = Math.max(1, Math.round(13 / STEP));
  const slots = [];
  for (let i = 0; i < N; i += every) slots.push(i);
  const inst = new THREE.InstancedMesh(geo, mat, slots.length);
  const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  slots.forEach((i, n) => {
    const p = track.pts[i];
    const h = p[1] - 1.4 + 14;
    Q.identity();
    inst.setMatrixAt(n, M.compose(P.set(p[0], p[1] - 1.4, p[2]), Q, S.set(1, h, 1)));
  });
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// tunnel: glowing arches + dark canopy over the low section
const archMats = [];
{
  const i0 = Math.round((TUNNEL.f0 * L) / STEP), i1 = Math.round((TUNNEL.f1 * L) / STEP);
  const every = Math.max(1, Math.round(7 / STEP));
  const archGeo = new THREE.TorusGeometry(HALF_WIDTH + 1.3, 0.17, 8, 26, Math.PI);
  const M = new THREE.Matrix4();
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), P = new THREE.Vector3();
  for (let i = i0; i <= i1; i += every) {
    const ii = wrapI(i);
    const mat = new THREE.MeshBasicMaterial({ color: 0x2fa8d8, fog: false });
    archMats.push(mat);
    const arch = new THREE.Mesh(archGeo, mat);
    const p = track.pts[ii], t = track.tangents[ii], u = track.ups[ii], r = track.rights[ii];
    X.set(r[0], r[1], r[2]); Y.set(u[0], u[1], u[2]); Z.set(t[0], t[1], t[2]);
    M.makeBasis(X, Y, Z);
    arch.quaternion.setFromRotationMatrix(M);
    arch.position.set(p[0] + u[0] * 0.4, p[1] + u[1] * 0.4, p[2] + u[2] * 0.4);
    scene.add(arch);
  }
  // canopy
  const canMat = new THREE.MeshStandardMaterial({ color: 0x0b0d18, roughness: 0.95, metalness: 0.05, envMapIntensity: 0.12, side: THREE.DoubleSide });
  const pos = [], idxs = [];
  const SEGS = 10;
  let row = 0;
  for (let i = i0; i <= i1; i += 1) {
    const ii = wrapI(i);
    const p = track.pts[ii], r = track.rights[ii], u = track.ups[ii];
    for (let a = 0; a <= SEGS; a++) {
      const ang = (a / SEGS) * Math.PI;
      const lx = Math.cos(ang) * (HALF_WIDTH + 1.55), ly = Math.sin(ang) * (HALF_WIDTH + 1.55) * 0.62 + 0.4;
      pos.push(p[0] + r[0] * lx + u[0] * ly, p[1] + r[1] * lx + u[1] * ly, p[2] + r[2] * lx + u[2] * ly);
    }
    if (i > i0) {
      const b0 = (row - 1) * (SEGS + 1), b1 = row * (SEGS + 1);
      for (let a = 0; a < SEGS; a++) idxs.push(b0 + a, b1 + a, b0 + a + 1, b1 + a, b1 + a + 1, b0 + a + 1);
    }
    row++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idxs);
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, canMat));
  // ceiling light strip + wall-level glow lines so the interior isn't a cave
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xaef2ff, fog: false, side: THREE.DoubleSide });
  stripMat.color.multiplyScalar(0.95);
  const lowMat = new THREE.MeshBasicMaterial({ color: 0xff8ee6, fog: false, side: THREE.DoubleSide });
  lowMat.color.multiplyScalar(1.1);
  for (const [latC, upC, wS, m] of [[0, 5.55, 0.5, stripMat], [-HALF_WIDTH - 0.6, 2.2, 0.18, lowMat], [HALF_WIDTH + 0.6, 2.2, 0.18, lowMat]]) {
    const sp = [], si = [];
    let rr = 0;
    for (let i = i0; i <= i1; i += 2) {
      const ii = wrapI(i);
      const p = track.pts[ii], r = track.rights[ii], u = track.ups[ii];
      sp.push(
        p[0] + r[0] * (latC - wS) + u[0] * upC, p[1] + r[1] * (latC - wS) + u[1] * upC, p[2] + r[2] * (latC - wS) + u[2] * upC,
        p[0] + r[0] * (latC + wS) + u[0] * upC, p[1] + r[1] * (latC + wS) + u[1] * upC, p[2] + r[2] * (latC + wS) + u[2] * upC);
      // dashed: connect only 2 of every 3 rows so the strip reads as light modules
      if (i > i0 && ((i - i0) / 2) % 3 !== 0) { const b = (rr - 1) * 2; si.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
      rr++;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setIndex(si);
    scene.add(new THREE.Mesh(sg, m));
  }
}

// start gantry: pylons + holo banner + start lights
const startLights = [];
{
  const p = track.pts[START_IDX], t = track.tangents[START_IDX],
    r = track.rights[START_IDX], u = track.ups[START_IDX];
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1e30, metalness: 0.6, roughness: 0.35 });
  for (const s of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9, 0.7), mat);
    pole.position.set(
      p[0] + r[0] * (HALF_WIDTH + 1.8) * s, p[1] + 4.5, p[2] + r[2] * (HALF_WIDTH + 1.8) * s);
    scene.add(pole);
  }
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 128;
  const c2 = cv.getContext('2d');
  c2.fillStyle = 'rgba(10,14,34,0.85)'; c2.fillRect(0, 0, 1024, 128);
  c2.font = '900 68px Arial, sans-serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle';
  const grad = c2.createLinearGradient(200, 0, 824, 0);
  grad.addColorStop(0, '#dfff47'); grad.addColorStop(0.5, '#b8ffda'); grad.addColorStop(1, '#6cecff');
  c2.fillStyle = grad; c2.fillText('T H E   A I   R A C E', 512, 66);
  const btex = new THREE.CanvasTexture(cv);
  btex.colorSpace = THREE.SRGBColorSpace;
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(2 * (HALF_WIDTH + 2.4), 2.4),
    new THREE.MeshBasicMaterial({ map: btex, side: THREE.DoubleSide, transparent: true, opacity: 0.96, fog: false }));
  banner.position.set(p[0], p[1] + 7.6, p[2]);
  banner.rotation.y = Math.atan2(t[0], t[2]) + Math.PI;
  scene.add(banner);
  const lightGeo = new THREE.SphereGeometry(0.3, 12, 8);
  for (let k = 0; k < 5; k++) {
    const m = new THREE.MeshStandardMaterial({ color: 0x181020, emissive: 0x000000, emissiveIntensity: 3.2 });
    const sph = new THREE.Mesh(lightGeo, m);
    sph.position.set(p[0] + r[0] * (k - 2) * 1.7, p[1] + 6.1, p[2] + r[2] * (k - 2) * 1.7);
    scene.add(sph);
    startLights.push(m);
  }
  // finish line band
  const COLS = 10;
  const fcv = document.createElement('canvas'); fcv.width = COLS * 32; fcv.height = 64;
  const f2 = fcv.getContext('2d');
  for (let rI = 0; rI < 2; rI++) for (let q = 0; q < COLS; q++) {
    f2.fillStyle = (rI + q) % 2 ? '#0b0b12' : '#e8f4ff';
    f2.fillRect(q * 32, rI * 32, 32, 32);
  }
  const ftex = new THREE.CanvasTexture(fcv);
  ftex.colorSpace = THREE.SRGBColorSpace;
  const pos = [], uvs = [], idxs = [];
  const SPAN = 4;
  for (let j = 0; j <= SPAN; j++) {
    const ii = wrapI(START_IDX + j);
    const pp = track.pts[ii], rr = track.rights[ii], uu = track.ups[ii];
    const w = HALF_WIDTH - 0.75;
    pos.push(
      pp[0] - rr[0] * w + uu[0] * 0.045, pp[1] - rr[1] * w + uu[1] * 0.045, pp[2] - rr[2] * w + uu[2] * 0.045,
      pp[0] + rr[0] * w + uu[0] * 0.045, pp[1] + rr[1] * w + uu[1] * 0.045, pp[2] + rr[2] * w + uu[2] * 0.045);
    uvs.push(0, j / SPAN, 1, j / SPAN);
    if (j < SPAN) { const b = j * 2; idxs.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idxs);
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: ftex })));
}
function updateStartLights() {
  let red = 0, green = false;
  if (state.phase === 'countdown') {
    red = THREE.MathUtils.clamp(Math.ceil((1 - (state.countdown - 0.2) / 3) * 5), 0, 5);
  } else if (state.phase === 'race' && state.goTimer > 0) green = true;
  startLights.forEach((m, k) => m.emissive.set(green ? 0x00e838 : (k < red ? 0xff2010 : 0x000000)));
}

// Sector gates: a clear mission arc from launch to the orbital compute array.
{
  const gateMat = new THREE.MeshStandardMaterial({
    color: 0x182026, emissive: 0x0b2b28, emissiveIntensity: 0.55,
    metalness: 0.82, roughness: 0.28,
  });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xdfff47, fog: false });
  glowMat.color.multiplyScalar(1.6);
  for (const sector of SECTORS.slice(1)) {
    const idx = wrapI(Math.round((sector.f * L) / STEP));
    const p = track.pts[idx], t = track.tangents[idx], r = track.rights[idx], u = track.ups[idx];
    const group = new THREE.Group();
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(r[0], r[1], r[2]),
      new THREE.Vector3(u[0], u[1], u[2]),
      new THREE.Vector3(t[0], t[1], t[2]));
    group.quaternion.setFromRotationMatrix(basis);
    group.position.set(p[0], p[1], p[2]);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(.55, 6.8, .55), gateMat);
      leg.position.set(side * (HALF_WIDTH + 1.3), 3.4, 0);
      group.add(leg);
      const edge = new THREE.Mesh(new THREE.BoxGeometry(.12, 6.2, .12), glowMat);
      edge.position.set(side * (HALF_WIDTH + 1.02), 3.4, -.3);
      group.add(edge);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(HALF_WIDTH * 2 + 3.2, .62, .62), gateMat);
    beam.position.y = 6.75;
    group.add(beam);
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 128;
    const c2 = cv.getContext('2d');
    c2.fillStyle = 'rgba(4,7,9,.94)'; c2.fillRect(0, 0, 1024, 128);
    c2.fillStyle = '#dfff47'; c2.fillRect(0, 0, 12, 128);
    c2.font = '900 18px Arial, sans-serif'; c2.letterSpacing = '4px';
    c2.textAlign = 'left'; c2.textBaseline = 'middle'; c2.fillStyle = '#9aa6a2';
    c2.fillText(`SECTOR ${sector.code}`, 46, 38);
    c2.font = '900 44px Arial, sans-serif'; c2.fillStyle = '#f4f7f5';
    c2.fillText(sector.name, 46, 83);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(13.8, 1.72),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(cv), transparent: true,
        side: THREE.DoubleSide, depthWrite: false, fog: false,
      }));
    sign.position.set(0, 8.15, 0);
    sign.rotation.y = Math.PI;
    group.add(sign);
    scene.add(group);
  }
}

// HELIOS: a monumental orbital data center wrapped around the finish vector.
{
  const idx = wrapI(START_IDX + Math.round(18 / STEP));
  const p = track.pts[idx], t = track.tangents[idx], r = track.rights[idx], u = track.ups[idx];
  const station = new THREE.Group();
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(r[0], r[1], r[2]),
    new THREE.Vector3(u[0], u[1], u[2]),
    new THREE.Vector3(t[0], t[1], t[2]));
  station.quaternion.setFromRotationMatrix(basis);
  station.position.set(p[0] + u[0] * 18, p[1] + u[1] * 18, p[2] + u[2] * 18);
  const metal = new THREE.MeshStandardMaterial({
    color: 0x12191d, metalness: .92, roughness: .23,
    emissive: 0x102422, emissiveIntensity: .25,
  });
  const white = new THREE.MeshStandardMaterial({
    color: 0xc9d4cf, metalness: .72, roughness: .22,
    emissive: 0x16231f, emissiveIntensity: .18,
  });
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xdfff47, fog: false });
  coreMat.color.multiplyScalar(1.9);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(42, 3.2, 14, 84), metal);
  station.add(ring);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(35.8, .48, 8, 84), coreMat);
  station.add(inner);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rack = new THREE.Mesh(new THREE.BoxGeometry(6.2, 15.5, 11.8), i % 2 ? metal : white);
    rack.position.set(Math.cos(a) * 28, Math.sin(a) * 28, 4);
    rack.rotation.z = a + Math.PI / 2;
    station.add(rack);
    const core = new THREE.Mesh(new THREE.BoxGeometry(.38, 12.2, 12), coreMat);
    core.position.set(Math.cos(a) * 27.5, Math.sin(a) * 27.5, -1.8);
    core.rotation.z = a + Math.PI / 2;
    station.add(core);
  }
  for (const side of [-1, 1]) {
    const boom = new THREE.Mesh(new THREE.BoxGeometry(52, 1.1, 1.1), metal);
    boom.position.x = side * 68;
    station.add(boom);
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(42, 24, .42),
      new THREE.MeshStandardMaterial({
        color: 0x193866, emissive: 0x0b2453, emissiveIntensity: .75,
        metalness: .8, roughness: .26,
      }));
    panel.position.x = side * 98;
    station.add(panel);
    for (let gx = -2; gx <= 2; gx++) {
      const grid = new THREE.Mesh(new THREE.BoxGeometry(.16, 24.2, .56), white);
      grid.position.set(side * 98 + gx * 8.2, 0, -.18);
      station.add(grid);
    }
  }
  const beacon = new THREE.PointLight(0xdfff47, 9, 220, 1.6);
  beacon.position.z = 5;
  station.add(beacon);
  scene.add(station);
}

// Holo billboards carry the story beats around the sprint.
{
  const texts = ['EARTH HAS LIMITS', 'COMPUTE DOES NOT', 'FIRST TO HELIOS WINS', 'THE NEXT ERA IS OFF-WORLD'];
  const fracs = [0.2, 0.42, 0.6, 0.78];
  texts.forEach((txt, n) => {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
    const c2 = cv.getContext('2d');
    c2.fillStyle = 'rgba(8,12,30,0.75)'; c2.fillRect(0, 0, 512, 128);
    c2.strokeStyle = 'rgba(126,232,255,0.8)'; c2.lineWidth = 4; c2.strokeRect(4, 4, 504, 120);
    c2.font = '700 44px system-ui, sans-serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillStyle = n % 2 ? '#ff8ee6' : '#7ee8ff'; c2.fillText(txt, 256, 66);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const i = Math.round((fracs[n] * L) / STEP);
    const p = track.pts[i], t = track.tangents[i], r = track.rights[i];
    const side = n % 2 ? 1 : -1;
    const bb = new THREE.Mesh(new THREE.PlaneGeometry(18, 4.5),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92, side: THREE.DoubleSide }));
    bb.position.set(p[0] + r[0] * (HALF_WIDTH + 9) * side, p[1] + 7, p[2] + r[2] * (HALF_WIDTH + 9) * side);
    bb.rotation.y = Math.atan2(t[0], t[2]) + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
    scene.add(bb);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.5, 22, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x141726, roughness: 0.6, metalness: 0.5 }));
    pole.position.set(bb.position.x, p[1] - 14 + 11 + 7, bb.position.z);
    pole.position.y = (p[1] + 4.7 - 14) / 2 + -14 + (p[1] + 4.7 + 14) / 2; // center between floor and board
    pole.position.y = (-14 + p[1] + 4.7) / 2;
    pole.scale.y = (p[1] + 4.7 + 14) / 22;
    scene.add(pole);
  });
}

// ---------- ships ----------
function makeTaperedBox(bottomWidth, topWidth, height, length, topZOffset = 0) {
  const bw = bottomWidth * 0.5, tw = topWidth * 0.5, l = length * 0.5;
  const positions = [
    -bw, 0, -l, bw, 0, -l, bw, 0, l, -bw, 0, l,
    -tw, height, -l + topZOffset, tw, height, -l + topZOffset,
    tw, height, l + topZOffset, -tw, height, l + topZOffset,
  ];
  const indices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function makeShip(spec) {
  const g = new THREE.Group();
  const lean = new THREE.Group();
  g.add(lean);
  const paint = new THREE.MeshPhysicalMaterial({
    color: spec.color, roughness: 0.25, metalness: 0.5,
    clearcoat: 1.0, clearcoatRoughness: 0.1, envMapIntensity: 2.2,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x10121c, roughness: 0.5, metalness: 0.55 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x86c8ff, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.65,
    clearcoat: 1.0, clearcoatRoughness: 0.03, envMapIntensity: 2.0,
  });
  const trim = new THREE.MeshBasicMaterial({ color: spec.color, fog: false });
  trim.color.multiplyScalar(2.0);
  const engineMat = new THREE.MeshBasicMaterial({ color: 0xbfe9ff, fog: false });
  engineMat.color.multiplyScalar(1.3);

  // hull: low wide dart
  const hull = new THREE.Mesh(makeTaperedBox(1.6, 0.95, 0.42, 4.4, -0.25), paint);
  hull.position.set(0, 0.05, 0);
  // nose wedge
  const noseG = makeTaperedBox(0.9, 0.3, 0.26, 1.4, -0.5);
  const nose = new THREE.Mesh(noseG, paint);
  nose.position.set(0, 0.1, 2.6);
  // canopy
  const canopy = new THREE.Mesh(makeTaperedBox(0.72, 0.4, 0.34, 1.3, -0.28), glass);
  canopy.position.set(0, 0.44, 0.35);
  // dorsal fin
  const fin = new THREE.Mesh(makeTaperedBox(0.12, 0.05, 0.75, 1.0, -0.55), dark);
  fin.position.set(0, 0.42, -1.7);
  lean.add(hull, nose, canopy, fin);
  // outriggers + wings
  for (const s of [-1, 1]) {
    const pod = new THREE.Mesh(makeTaperedBox(0.5, 0.34, 0.36, 2.5, 0), paint);
    pod.position.set(s * 1.18, 0.02, -0.55);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.07, 1.15), dark);
    wing.position.set(s * 0.72, 0.16, -0.5);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 2.3), trim);
    strip.position.set(s * 1.42, 0.2, -0.55);
    const podEng = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 12), engineMat);
    podEng.rotation.x = Math.PI / 2;
    podEng.position.set(s * 1.18, 0.18, -1.83);
    lean.add(pod, wing, strip, podEng);
  }
  // hull side trim
  for (const s of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 3.6), trim);
    strip.position.set(s * 0.78, 0.3, 0.1);
    lean.add(strip);
  }
  // main engines
  const engines = [];
  for (const sx of [-0.34, 0.34]) {
    const e = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.08, 16), engineMat.clone());
    e.rotation.x = Math.PI / 2;
    e.position.set(sx, 0.28, -2.16);
    lean.add(e);
    engines.push(e.material);
  }
  // underglow (team color pool on the deck)
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 6.2), new THREE.MeshBasicMaterial({
    map: glowTex, color: spec.color, transparent: true, opacity: 0.34,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = -0.52;
  g.add(pool);
  // dark contact oval (grounds the ship visually)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.4), new THREE.MeshBasicMaterial({
    map: glowTex, color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false,
  }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = -0.5;
  g.add(blob);

  if (!spec.player) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const c2 = cv.getContext('2d');
    c2.font = 'bold 42px system-ui, sans-serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillStyle = '#000'; c2.globalAlpha = 0.45; c2.fillRect(0, 0, 256, 64); c2.globalAlpha = 1;
    c2.fillStyle = '#' + spec.color.toString(16).padStart(6, '0'); c2.fillText(spec.name, 128, 34);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), depthTest: true, transparent: true,
    }));
    spr.scale.set(Math.min(5.4, Math.max(3.8, spec.name.length * .54)), .95, 1);
    spr.position.y = 1.8;
    g.add(spr);
    return { group: g, lean, engines, plate: spr };
  }
  return { group: g, lean, engines, plate: null };
}

// engine trail ribbons
const TRAIL_N = 46;
function makeTrail(spec) {
  const geo = new THREE.BufferGeometry();
  const posA = new THREE.Float32BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3);
  const fadeA = new THREE.Float32BufferAttribute(new Float32Array(TRAIL_N * 2), 1);
  posA.setUsage(THREE.DynamicDrawUsage); fadeA.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posA);
  geo.setAttribute('aFade', fadeA);
  const idxs = [];
  for (let i = 0; i < TRAIL_N - 1; i++) {
    const b = i * 2;
    idxs.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  geo.setIndex(idxs);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { tint: { value: new THREE.Color(spec.color).lerp(new THREE.Color(0xffffff), 0.35) } },
    vertexShader: 'attribute float aFade; varying float vF; void main(){ vF=aFade; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 tint; varying float vF; void main(){ gl_FragColor = vec4(tint * 1.7 * vF, vF * 0.55); }',
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, posA, fadeA, hist: [], boostGlow: 0 };
}
function updateTrail(c, dt) {
  const tr = c.trail;
  const spd = Math.hypot(c.vA, c.vL);
  // world position of the tail engines
  const f = frameAt(c.s);
  const cosP = Math.cos(c.psi), sinP = Math.sin(c.psi);
  const fx = f.t[0] * cosP + f.r[0] * sinP, fy = f.t[1] * cosP + f.r[1] * sinP, fz = f.t[2] * cosP + f.r[2] * sinP;
  const px = c.wx - fx * 2.1, py = c.wy - fy * 2.1 + 0.28, pz = c.wz - fz * 2.1;
  const rxx = f.r[0] * cosP - f.t[0] * sinP, rxy = f.r[1] * cosP - f.t[1] * sinP, rxz = f.r[2] * cosP - f.t[2] * sinP;
  tr.hist.unshift({ x: px, y: py, z: pz, rx: rxx, ry: rxy, rz: rxz });
  if (tr.hist.length > TRAIL_N) tr.hist.pop();
  tr.boostGlow += ((c.boosting || c.padGlow > 0 ? 1 : 0) - tr.boostGlow) * (1 - Math.exp(-6 * dt));
  const on = spd > 12 ? 1 : spd / 12;
  for (let i = 0; i < TRAIL_N; i++) {
    const h = tr.hist[Math.min(i, tr.hist.length - 1)] || { x: px, y: py, z: pz, rx: rxx, ry: rxy, rz: rxz };
    const w = (0.34 + tr.boostGlow * 0.3) * (1 - i / TRAIL_N);
    tr.posA.array[i * 6 + 0] = h.x - h.rx * w;
    tr.posA.array[i * 6 + 1] = h.y - h.ry * w;
    tr.posA.array[i * 6 + 2] = h.z - h.rz * w;
    tr.posA.array[i * 6 + 3] = h.x + h.rx * w;
    tr.posA.array[i * 6 + 4] = h.y + h.ry * w;
    tr.posA.array[i * 6 + 5] = h.z + h.rz * w;
    const fade = (1 - i / TRAIL_N) * on * (0.5 + tr.boostGlow * 0.5);
    tr.fadeA.array[i * 2] = fade;
    tr.fadeA.array[i * 2 + 1] = fade;
  }
  tr.posA.needsUpdate = true;
  tr.fadeA.needsUpdate = true;
}

// ---------- ship state + physics ----------
function newShipState(spec, gridSlot) {
  const s = wrapS(startS - 17 - Math.floor(gridSlot / 2) * 9.5);
  return {
    spec,
    s, lat: (gridSlot % 2 === 0 ? -4.2 : 4.2),
    psi: 0, vA: 0, vL: 0,
    steer: 0, steerIn: 0, throttle: 0, brake: 0, airbrake: 0, boostIn: 0,
    boost: 18, boosting: false, shield: SHIELD_MAX, limp: false, padGlow: 0,
    drafting: false, packets: 0,
    progress: -deltaS(s, startS) * -1 - 0, // set below
    lap: 0, cps: [false, false],
    lapStart: 0, lapTimes: [], best: Infinity, finished: false, finishTime: 0,
    wrongWay: 0, stuck: 0, hitWall: false, wallSide: 0,
    wx: 0, wy: 0, wz: 0, roll: 0, pitch: 0, prevVF: 0, latA: 0, bobPhase: rng() * 6.28,
    aiBias: (spec.lane ?? 0) + (rng() - 0.5) * 0.8,
    aiBoostT: 0,
  };
}

function isDrafting(c) {
  if (Math.hypot(c.vA, c.vL) < 30) return false;
  for (const other of ships) {
    if (other === c || other.finished) continue;
    const ahead = deltaS(c.s, other.s);
    if (ahead > 3 && ahead < 28 && Math.abs(c.lat - other.lat) < 3.1) return true;
  }
  return false;
}

function stepShip(c, raceTime, freeze) {
  if (c.finished) {
    c.boosting = false;
    c.throttle = 0;
    c.brake = 1;
    c.vA *= Math.exp(-.34 * DT);
    c.vL *= Math.exp(-2.2 * DT);
    c.s = wrapS(c.s + c.vA * DT);
    const dockLane = (((c.finishOrder ?? 0) % 5) - 2) * 4.1;
    c.lat += (dockLane - c.lat) * (1 - Math.exp(-1.1 * DT));
    const f = frameAt(c.s);
    c.wx = f.p[0] + f.r[0] * c.lat + f.u[0] * .55;
    c.wy = f.p[1] + f.r[1] * c.lat + f.u[1] * .55;
    c.wz = f.p[2] + f.r[2] * c.lat + f.u[2] * .55;
    return;
  }
  const f = frameAt(c.s);
  const k = f.k, bank = f.bank, slope = f.t[1];
  const spd = Math.abs(c.vA);

  if (!freeze) {
    // steering: rate-limited, speed-tapered; +1 = LEFT = psi decreases
    const target = c.steerIn / (1 + (spd / 34) ** 2 * 0.7);
    c.steer += THREE.MathUtils.clamp(target - c.steer, -6 * DT, 6 * DT);
    const yawAuth = (2.6 - Math.min(spd, 78) * 0.012) * (1 + c.airbrake * 0.75);
    c.psi += -c.steer * yawAuth * DT;
    c.psi = THREE.MathUtils.clamp(c.psi, -1.15, 1.15);

    // decompose into ship frame
    const cosP = Math.cos(c.psi), sinP = Math.sin(c.psi);
    let vF = c.vA * cosP + c.vL * sinP;
    let vR = -c.vA * sinP + c.vL * cosP;

    // thrust / brake
    const vmax = c.spec.vmax * (c.boosting ? BOOST_VMAX_MUL : 1) * (c.limp ? 0.8 : 1);
    if (c.throttle > 0) vF += c.throttle * ACCEL * Math.max(0, 1 - vF / vmax) * DT * (c.limp ? 0.72 : 1);
    if (c.boosting) vF += BOOST_ACCEL * Math.max(0, 1 - vF / vmax) * DT;
    if (c.brake > 0) { vF -= BRAKE * c.brake * DT; if (vF < 0) vF = 0; }
    c.drafting = isDrafting(c);
    const aero = c.drafting ? 0.58 : 1;
    vF -= (0.3 + 0.0019 * vF * Math.abs(vF) * aero) * Math.sign(vF) * DT * (c.throttle > 0 ? 0.3 : 0.85);
    if (c.drafting) c.boost = Math.min(100, c.boost + 2.8 * DT);
    // lateral grip (airbrake drops it = drift)
    const grip = c.airbrake > 0 ? GRIP_DRIFT : GRIP;
    vR *= Math.exp(-grip * DT);

    // recompose to track frame
    c.vA = vF * cosP - vR * sinP;
    c.vL = vF * sinP + vR * cosP;

    // the geometry is real: centrifugal + banking + slope
    c.latA = k * c.vA * c.vA + GRAV * Math.sin(bank);
    c.vL += c.latA * DT;
    c.vA -= GRAV * slope * DT;

    // advance on the manifold (inside of a corner covers s faster)
    const jac = THREE.MathUtils.clamp(1 + k * c.lat, 0.4, 2.5);
    const dsRaw = (c.vA * DT) / jac;
    c.s = wrapS(c.s + dsRaw);
    c.lat += c.vL * DT;

    // boost bookkeeping
    c.boosting = c.boostIn > 0 && c.boost > 0.5 && !c.finished;
    if (c.boosting) c.boost = Math.max(0, c.boost - BOOST_DRAIN * DT);
    // pads
    c.padGlow = Math.max(0, c.padGlow - DT * 2);
    for (const pad of PADS) {
      const ps = pad.f * L;
      const d = deltaS(ps, c.s);
      if (d > 0 && d < pad.len && (c._padCd ?? 0) <= 0) {
        c.boost = Math.min(100, c.boost + PAD_CHARGE);
        const vmaxPad = c.spec.vmax * BOOST_VMAX_MUL;
        const cur = Math.hypot(c.vA, c.vL);
        if (cur < vmaxPad) c.vA += PAD_KICK * Math.sign(c.vA || 1) * Math.min(1, (vmaxPad - cur) / PAD_KICK);
        c.padGlow = 1;
        c._padCd = 1.2;
        if (c.spec.player) padPing();
      }
    }
    c._padCd = Math.max(0, (c._padCd ?? 0) - DT);
    if (c.spec.player) {
      for (const core of DATA_CORES) {
        if (core.collected) continue;
        const along = Math.abs(deltaS(core.f * L, c.s));
        if (along < 3.6 && Math.abs(c.lat - core.lat) < 2.25) {
          core.collected = true;
          if (core.mesh) core.mesh.visible = false;
          c.packets++;
          c.boost = Math.min(100, c.boost + 18);
          c.shield = Math.min(SHIELD_MAX, c.shield + 7);
          c.padGlow = 1.3;
          padPing();
        }
      }
    }
    // shield: recharge strip + passive regen
    const rs = RECHARGE.f * L;
    const rd = deltaS(rs, c.s);
    const onRecharge = rd > 0 && rd < RECHARGE.len;
    c.shield = Math.min(SHIELD_MAX, c.shield + (onRecharge ? 45 : 1.5) * DT);
    if (c.shield > 22) c.limp = false;

    // body attitude (visual): lean INTO the turn like an AG craft
    const kAtt = 1 - Math.exp(-8 * DT);
    const longA = (vF - c.prevVF) / DT;
    c.prevVF = vF;
    c.roll += (THREE.MathUtils.clamp(-c.latA / 26 - c.steer * 0.3, -0.5, 0.5) - c.roll) * kAtt;
    c.pitch += (THREE.MathUtils.clamp(-longA / 40, -0.12, 0.16) - c.pitch) * kAtt;
  } else {
    c.roll *= 0.97; c.pitch *= 0.97;
  }

  // wall containment: glance, never stick (shield pays for contact)
  if (Math.abs(c.lat) > EDGE) {
    const sgn = c.lat > 0 ? 1 : -1;
    c.lat = EDGE * sgn;
    const vOut = c.vL * sgn;
    if (vOut > 0) {
      c.vL = -c.vL * 0.12; // small bounce-in
      if (!freeze) {
        c.shield = Math.max(0, c.shield - vOut * 2.6);
        if (c.shield <= 0) c.limp = true;
      }
    }
    if (!freeze) c.shield = Math.max(0, c.shield - 7 * DT); // scrape
    if (c.shield <= 0) c.limp = true;
    // deflect the nose along the track while touching: ships GLANCE off walls
    c.psi += THREE.MathUtils.clamp(-c.psi, -1, 1) * 3.0 * DT;
    c.vA *= 0.996;
    c.hitWall = true; c.wallSide = sgn;
  } else { c.hitWall = false; c.wallSide = 0; }

  // progress + laps (signed, rejects cuts)
  const sOld = c._sPrev ?? c.s;
  let d = deltaS(sOld, c.s);
  if (Math.abs(d) < 30) { c.progress += d; c.lapProgress = (c.lapProgress ?? c.progress) + d; }
  c._sPrev = c.s;

  if (c.lapProgress > L / 3) c.cps[0] = true;
  if (c.lapProgress > (2 * L) / 3) c.cps[1] = true;
  if (c.lapProgress >= L) {
    if (c.cps[0] && c.cps[1]) {
      c.lap++;
      const t = raceTime - c.lapStart;
      c.lapTimes.push(t); c.best = Math.min(c.best, t); c.lapStart = raceTime;
      c.boost = Math.min(100, c.boost + 15); // lap bonus
      if (c.lap >= LAPS && !c.finished) {
        c.finished = true;
        c.finishTime = raceTime;
        c.finishOrder = ships.filter(ship => ship.finished).length;
      }
    }
    if (c.finished) c.lapProgress = L;
    else c.lapProgress -= L;
    c.cps = [false, false];
  }
  c.wrongWay = d < -0.02 ? Math.min(c.wrongWay + DT, 3) : Math.max(c.wrongWay - DT * 2, 0);
  c.stuck = Math.hypot(c.vA, c.vL) < 1.5 ? c.stuck + DT : 0;

  // world position (hover above the deck)
  const fw = frameAt(c.s);
  const hover = 0.55;
  c.wx = fw.p[0] + fw.r[0] * c.lat + fw.u[0] * hover;
  c.wy = fw.p[1] + fw.r[1] * c.lat + fw.u[1] * hover;
  c.wz = fw.p[2] + fw.r[2] * c.lat + fw.u[2] * hover;
}

function collideShips(ships) {
  for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++) {
    const a = ships[i], b = ships[j];
    if (a.finished || b.finished) continue;
    const dA = deltaS(a.s, b.s);
    if (Math.abs(dA) > 8) continue;
    const dL = b.lat - a.lat;
    const d = Math.hypot(dA, dL);
    const minD = SHIP_R * 2;
    if (d < minD && d > 1e-6) {
      const nx = dA / d, ny = dL / d;
      const push = (minD - d) / 2;
      a.s = wrapS(a.s - nx * push); a.lat -= ny * push;
      b.s = wrapS(b.s + nx * push); b.lat += ny * push;
      const rvA = b.vA - a.vA, rvL = b.vL - a.vL;
      const vn = rvA * nx + rvL * ny;
      if (vn < 0) {
        const imp = -vn * 0.6;
        a.vA -= nx * imp; a.vL -= ny * imp;
        b.vA += nx * imp; b.vL += ny * imp;
        // only real impacts cost shield — pack rubbing at 120Hz must not shred it
        if (vn < -3) {
          const dmg = Math.min(6, -vn * 0.8);
          a.shield = Math.max(0, a.shield - dmg); b.shield = Math.max(0, b.shield - dmg);
        }
      }
    }
  }
}

// ---------- AI ----------
function aiDrive(c, playerProgress) {
  if (c.stuck > 2.5) { respawn(c); return; }
  const spd = Math.hypot(c.vA, c.vL);
  // aim point: cut toward the inside of the upcoming corner
  const look = THREE.MathUtils.clamp(9 + spd * 0.5 * c.spec.look, 12, 46);
  const kA = signedCurveAhead(c.s, look + 12);
  const apex = THREE.MathUtils.clamp(Math.sign(kA) * Math.min(Math.abs(kA) * 700, 4.2), -4.4, 4.4);
  // k>0 = left turn, apex on the left = -lat... but sign(kA)*(-1)? Left turn inside is -lat:
  const targetLat = THREE.MathUtils.clamp(-apex + c.aiBias, -EDGE + 1.1, EDGE - 1.1);
  const psiDes = Math.atan2(targetLat - c.lat, look);
  c.steerIn = THREE.MathUtils.clamp((c.psi - psiDes) * 3.0, -1, 1);

  // corner-speed preview (banking raises the effective limit — the AI knows)
  const band = THREE.MathUtils.clamp((playerProgress - c.progress) / 450, -0.05, 0.06);
  let vT = c.spec.vmax * (1 + band);
  const iNow = Math.round(wrapS(c.s) / STEP);
  const nAhead = Math.ceil(THREE.MathUtils.clamp(14 + spd * 1.6, 30, 110) / STEP);
  for (let j = 0; j <= nAhead; j += 3) {
    const ii = wrapI(iNow + j);
    const kk = Math.abs(track.curvature[ii]);
    if (kk < 1e-4) continue;
    const assist = Math.max(0, -Math.sign(track.curvature[ii]) * Math.sin(track.bank[ii])) * GRAV;
    const vCorner = Math.sqrt((c.spec.latG * 0.86 * (c.spec.risk ?? 1) + assist) / kk);
    const distJ = j * STEP;
    const allowed = Math.sqrt(vCorner * vCorner + 2 * 20 * Math.max(distJ - 8, 0));
    vT = Math.min(vT, allowed);
  }
  if (spd < vT - 1) { c.throttle = 1; c.brake = 0; }
  else if (spd > vT + 2) { c.throttle = 0; c.brake = 1; }
  else { c.throttle = 0.4; c.brake = 0; }
  c.airbrake = Math.abs(c.psi - psiDes) > 0.45 && spd > 30 ? 1 : 0;

  // boost on straights when it has charge (and slightly more eagerly when behind)
  c.aiBoostT = Math.max(0, c.aiBoostT - DT);
  const straight = curveAhead(c.s, 70) < 0.005;
  const burstAt = Math.max(24, (c.spec.burstAt ?? 55) - (band > 0 ? 15 : 0));
  if (c.aiBoostT <= 0 && straight && c.boost > burstAt) c.aiBoostT = 0.8 + (c.spec.risk ?? 1) * 0.45;
  c.boostIn = c.aiBoostT > 0 ? 1 : 0;
}

function respawn(c) {
  c.lat = 0; c.psi = 0; c.vA = 0; c.vL = 0; c.steer = 0; c.stuck = 0;
}

// ---------- race state ----------
const state = {
  phase: 'menu', raceTime: 0, countdown: 0, goTimer: 0,
  muted: false, cameraMode: 0, cameraLabelT: 0, autopilot: false,
  finishDelay: -1, countdownBeat: null,
};

const ships = ROSTER.map((spec, i) => {
  const st = newShipState(spec, i);
  const built = makeShip(spec);
  st.mesh = built.group; st.lean = built.lean; st.engines = built.engines; st.plate = built.plate;
  st.trail = makeTrail(spec);
  scene.add(st.mesh);
  return st;
});
const player = ships.find(c => c.spec.player);
// fix initial progress (distance behind the line is negative)
for (const c of ships) {
  c.progress = deltaS(startS, c.s) <= 0 ? deltaS(startS, c.s) : deltaS(startS, c.s) - L;
  c.lapProgress = c.progress;
  c._sPrev = c.s;
}

function resetRace() {
  ships.forEach((c, i) => {
    const fresh = newShipState(c.spec, i);
    Object.assign(c, { ...fresh, mesh: c.mesh, lean: c.lean, engines: c.engines, plate: c.plate, trail: c.trail });
    c.progress = deltaS(startS, c.s) <= 0 ? deltaS(startS, c.s) : deltaS(startS, c.s) - L;
    c.lapProgress = c.progress;
    c._sPrev = c.s;
    c.trail.hist.length = 0;
  });
  state.raceTime = 0; state.countdown = 3.2; state.phase = 'countdown'; state.goTimer = 0;
  state.finishDelay = -1; state.countdownBeat = null;
  for (const core of DATA_CORES) {
    core.collected = false;
    if (core.mesh) core.mesh.visible = true;
  }
  hud.msg.textContent = '';
  hud.menu.classList.remove('show'); hud.results.classList.remove('show'); hud.pause.classList.remove('show');
  document.body.classList.add('race-active');
  camSnap();
}

function ranking() {
  return [...ships].sort((a, b) =>
    (b.finished - a.finished) || (a.finished ? a.finishTime - b.finishTime : b.progress - a.progress));
}

// ---------- input ----------
const keys = {};
addEventListener('keydown', e => onKey(e, true));
addEventListener('keyup', e => onKey(e, false));
function onKey(e, down) {
  const code = e.code;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) e.preventDefault();
  keys[code] = down;
  if (!down) return;
  if (code === 'Enter' && (state.phase === 'menu' || state.phase === 'results')) resetRace();
  if (code === 'KeyR' && state.phase !== 'menu') resetRace();
  if (code === 'KeyB' && state.phase === 'race') respawn(player);
  if (code === 'KeyM') setMuted(!state.muted);
  if (code === 'KeyC') {
    state.cameraMode = (state.cameraMode + 1) % 4;
    state.cameraLabelT = 1.2;
    camSnap();
  }
  if (code === 'Escape' || code === 'KeyP') {
    if (state.phase === 'race') { state.phase = 'paused'; hud.pause.classList.add('show'); }
    else if (state.phase === 'paused') { state.phase = 'race'; hud.pause.classList.remove('show'); }
  }
}
const touch = { left: false, right: false, gas: false, brk: false, boost: false, drift: false };
for (const [id, prop] of [
  ['tl', 'left'], ['tr', 'right'], ['tg', 'gas'], ['tb', 'brk'],
  ['tboost', 'boost'], ['tdrift', 'drift'],
]) {
  const el = document.getElementById(id);
  if (!el) continue;
  const set = v => e => { e.preventDefault(); touch[prop] = v; el.classList.toggle('on', v); };
  el.addEventListener('pointerdown', set(true));
  el.addEventListener('pointerup', set(false));
  el.addEventListener('pointercancel', set(false));
  el.addEventListener('pointerleave', set(false));
}
let kbSteer = 0;
function readInput() {
  const rawSteer = ((keys.KeyA || keys.ArrowLeft || touch.left) ? 1 : 0) -
                   ((keys.KeyD || keys.ArrowRight || touch.right) ? 1 : 0);
  kbSteer += THREE.MathUtils.clamp(rawSteer - kbSteer, -DT / 0.12, DT / 0.12);
  let throttle = (keys.KeyW || keys.ArrowUp || touch.gas) ? 1 : 0;
  let brake = (keys.KeyS || keys.ArrowDown || touch.brk) ? 1 : 0;
  let airbrake = (keys.Space || touch.drift) ? 1 : 0;
  let boost = (keys.ShiftLeft || keys.ShiftRight || touch.boost) ? 1 : 0;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    if (Math.abs(p.axes[0]) > 0.12) kbSteer = -p.axes[0];
    if (p.buttons[7]?.value > 0.05) throttle = p.buttons[7].value;
    if (p.buttons[6]?.value > 0.05) brake = p.buttons[6].value;
    if (p.buttons[0]?.pressed) boost = 1;
    if (p.buttons[2]?.pressed) airbrake = 1;
  }
  return { steer: kbSteer, throttle, brake, airbrake, boost };
}

// ---------- audio: EV turbine (worklet whine + noise taps) ----------
const MASTER_VOL = 0.17;
const TURBINE_WORKLET = `
class TurbineProc extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 70, minValue: 20, maxValue: 900, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'boost', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.ph = [0, 0, 0, 0];
    this.det = [0, 0, 0, 0];
    this.lp = 0;
    this.seed = 0x2E20;
  }
  rnd() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x7fffffff; }
  process(inputs, outputs, params) {
    const out = outputs[0][0];
    const f0 = params.freq[0], thr = params.throttle[0], boost = params.boost[0];
    const dt = 1 / sampleRate;
    const harm = [1, 2.004, 3.011, 4.02];
    const gains = [1, 0.55, 0.4, 0.26];
    for (let i = 0; i < out.length; i++) {
      // slow random-walk detune per partial: shimmer, not a pure drone
      if ((i & 63) === 0) {
        for (let h = 0; h < 4; h++) {
          this.det[h] += (this.rnd() - 0.5) * 0.004;
          this.det[h] *= 0.995;
        }
      }
      let s = 0;
      for (let h = 0; h < 4; h++) {
        this.ph[h] += f0 * harm[h] * (1 + this.det[h]) * dt;
        if (this.ph[h] > 1) this.ph[h] -= 1;
        s += Math.sin(6.2832 * this.ph[h]) * gains[h];
      }
      // turbulence: lowpassed noise amplitude-modulates the whine
      this.lp += ((this.rnd() * 2 - 1) - this.lp) * 0.02;
      const turb = 1 + this.lp * (0.35 + boost * 0.5);
      out[i] = s * turb * (0.16 + 0.5 * thr + 0.34 * boost) * 0.35;
    }
    return true;
  }
}
registerProcessor('turbine-proc', TurbineProc);`;

let ac = null, engineNode = null, engineFilt = null, engineGain = null,
  whooshFilt = null, whooshGain = null, windGain = null, boostGain = null, boostSub = null,
  scrapeFilt = null, scrapeGain = null, masterGain = null, scoreGain = null,
  scoreFilt = null, scoreVoices = [], lastAudioT = 0;
const aiVoices = [];
const _lisDir = new THREE.Vector3();
function ensureAudio() {
  if (ac) { if (ac.state === 'suspended') ac.resume().catch(() => {}); return; }
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ac.createGain();
    masterGain.gain.value = state.muted ? 0 : MASTER_VOL;
    masterGain.connect(ac.destination);

    engineFilt = ac.createBiquadFilter(); engineFilt.type = 'lowpass';
    engineFilt.frequency.value = 1200; engineFilt.Q.value = 0.8;
    engineGain = ac.createGain(); engineGain.gain.value = 0.0001;
    engineFilt.connect(engineGain); engineGain.connect(masterGain);

    const blobURL = URL.createObjectURL(new Blob([TURBINE_WORKLET], { type: 'application/javascript' }));
    ac.audioWorklet.addModule(blobURL).then(() => {
      engineNode = new AudioWorkletNode(ac, 'turbine-proc', { numberOfInputs: 0, outputChannelCount: [1] });
      engineNode.connect(engineFilt);
      for (const c of ships) {
        if (c.spec.player) continue;
        const node = new AudioWorkletNode(ac, 'turbine-proc', { numberOfInputs: 0, outputChannelCount: [1] });
        const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
        const g = ac.createGain(); g.gain.value = 0;
        const pan = ac.createPanner();
        pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse';
        pan.refDistance = 12; pan.rolloffFactor = 1.1; pan.maxDistance = 420;
        node.connect(lp); lp.connect(g); g.connect(pan); pan.connect(masterGain);
        aiVoices.push({ c, node, g, pan, lastDist: null });
      }
    }).catch(e => console.warn('[THE AI RACE] turbine worklet failed:', e));

    // shared noise -> whoosh / wind / boost / scrape taps
    const bufSize = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, bufSize, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = buf; noise.loop = true; noise.start();
    const tap = (mk) => { const g = ac.createGain(); g.gain.value = 0; mk.connect(g); g.connect(masterGain); noise.connect(mk); return g; };
    whooshFilt = ac.createBiquadFilter(); whooshFilt.type = 'bandpass';
    whooshFilt.frequency.value = 400; whooshFilt.Q.value = 0.7;
    whooshGain = tap(whooshFilt);
    const wf = ac.createBiquadFilter(); wf.type = 'highpass'; wf.frequency.value = 1100;
    windGain = tap(wf);
    const bf = ac.createBiquadFilter(); bf.type = 'lowpass'; bf.frequency.value = 460;
    boostGain = tap(bf);
    boostSub = ac.createOscillator(); boostSub.type = 'sine'; boostSub.frequency.value = 44;
    const bsg = ac.createGain(); bsg.gain.value = 0;
    boostSub.connect(bsg); bsg.connect(masterGain); boostSub.start();
    boostSub._g = bsg;
    scrapeFilt = ac.createBiquadFilter(); scrapeFilt.type = 'bandpass';
    scrapeFilt.frequency.value = 1900; scrapeFilt.Q.value = 2.8;
    scrapeGain = tap(scrapeFilt);

    // A restrained generative score follows the current mission sector. It is
    // deliberately synthesis-only so the submission remains tiny and licensed.
    scoreGain = ac.createGain(); scoreGain.gain.value = 0.0001;
    scoreFilt = ac.createBiquadFilter(); scoreFilt.type = 'lowpass';
    scoreFilt.frequency.value = 620; scoreFilt.Q.value = 1.3;
    scoreGain.connect(scoreFilt); scoreFilt.connect(masterGain);
    for (const [ratio, type, level] of [[1, 'sine', .42], [1.5, 'triangle', .16], [2, 'sine', .12]]) {
      const osc = ac.createOscillator(); osc.type = type;
      const gain = ac.createGain(); gain.gain.value = level;
      osc.connect(gain); gain.connect(scoreGain); osc.start();
      scoreVoices.push({ osc, ratio });
    }
  } catch { ac = null; }
}
function padPing() {
  if (!ac || state.muted) return;
  const t = ac.currentTime;
  const o = ac.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(660, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.24, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  o.connect(g); g.connect(masterGain);
  o.start(t); o.stop(t + 0.3);
}
function launchTone(go = false) {
  if (!ac || state.muted) return;
  const t = ac.currentTime;
  const o = ac.createOscillator(); o.type = go ? 'sawtooth' : 'sine';
  o.frequency.setValueAtTime(go ? 880 : 220, t);
  if (go) o.frequency.exponentialRampToValueAtTime(1760, t + .18);
  const g = ac.createGain();
  g.gain.setValueAtTime(go ? .22 : .13, t);
  g.gain.exponentialRampToValueAtTime(.001, t + (go ? .42 : .16));
  o.connect(g); g.connect(masterGain); o.start(t); o.stop(t + (go ? .44 : .18));
}
function setMuted(m) {
  state.muted = m;
  hud.mute.textContent = m ? 'SOUND // OFF' : 'SOUND // ON';
  if (masterGain && ac) masterGain.gain.setTargetAtTime(m ? 0 : MASTER_VOL, ac.currentTime, 0.03);
}
function updateAudio() {
  if (!ac || !engineGain) return;
  const t = ac.currentTime;
  const active = state.phase === 'race' || state.phase === 'countdown';
  const spd = Math.hypot(player.vA, player.vL);
  const f0 = 58 + spd * 4.0 + (player.boosting ? 60 : 0);
  if (engineNode) {
    engineNode.parameters.get('freq').setTargetAtTime(f0, t, 0.05);
    engineNode.parameters.get('throttle').setTargetAtTime(active ? player.throttle : 0.05, t, 0.06);
    engineNode.parameters.get('boost').setTargetAtTime(player.boosting ? 1 : 0, t, 0.05);
  }
  engineFilt.frequency.setTargetAtTime(500 + spd * 26 + (player.boosting ? 900 : 0), t, 0.06);
  engineGain.gain.setTargetAtTime(active ? 0.32 : 0.06, t, 0.06);
  whooshFilt.frequency.setTargetAtTime(280 + spd * 15, t, 0.08);
  whooshGain.gain.setTargetAtTime(active ? Math.min(spd / player.spec.vmax, 1.2) * 0.16 : 0, t, 0.09);
  windGain.gain.setTargetAtTime(active ? (spd / player.spec.vmax) ** 2 * 0.1 : 0, t, 0.1);
  boostGain.gain.setTargetAtTime(player.boosting ? 0.3 : 0, t, 0.05);
  if (boostSub) boostSub._g.gain.setTargetAtTime(player.boosting ? 0.2 : 0, t, 0.05);
  const scrape = player.hitWall && spd > 4;
  scrapeGain.gain.setTargetAtTime(active && scrape ? 0.2 : 0, t, 0.04);
  if (scoreGain && scoreVoices.length) {
    const progress = THREE.MathUtils.clamp((player.lapProgress ?? 0) / L, 0, 1);
    const roots = [55, 61.74, 65.41, 73.42, 82.41, 98];
    const root = roots[Math.min(roots.length - 1, Math.floor(progress * roots.length))];
    scoreVoices.forEach(v => v.osc.frequency.setTargetAtTime(root * v.ratio, t, .45));
    scoreGain.gain.setTargetAtTime(active ? .11 + Math.min(spd / 800, .035) : .018, t, .6);
    scoreFilt.frequency.setTargetAtTime(420 + spd * 8 + (player.boosting ? 480 : 0), t, .3);
  }

  const Ls = ac.listener;
  if (Ls.positionX) {
    Ls.positionX.value = camera.position.x; Ls.positionY.value = camera.position.y; Ls.positionZ.value = camera.position.z;
    camera.getWorldDirection(_lisDir);
    Ls.forwardX.value = _lisDir.x; Ls.forwardY.value = _lisDir.y; Ls.forwardZ.value = _lisDir.z;
    Ls.upX.value = 0; Ls.upY.value = 1; Ls.upZ.value = 0;
  }
  const adt = Math.max(t - lastAudioT, 1e-3);
  lastAudioT = t;
  for (const v of aiVoices) {
    const dist = Math.hypot(v.c.wx - camera.position.x, v.c.wy - camera.position.y, v.c.wz - camera.position.z);
    const dop = v.lastDist === null ? 1 : THREE.MathUtils.clamp(1 + (v.lastDist - dist) / adt / 343, 0.75, 1.35);
    v.lastDist = dist;
    if (v.pan.positionX) { v.pan.positionX.value = v.c.wx; v.pan.positionY.value = v.c.wy; v.pan.positionZ.value = v.c.wz; }
    const vSpd = Math.hypot(v.c.vA, v.c.vL);
    v.node.parameters.get('freq').setTargetAtTime((58 + vSpd * 4.0 + (v.c.boosting ? 60 : 0)) * dop, t, 0.06);
    v.node.parameters.get('throttle').setTargetAtTime(v.c.throttle || 0, t, 0.08);
    v.g.gain.setTargetAtTime(active ? 0.5 : 0, t, 0.1);
  }
}
addEventListener('pointerdown', ensureAudio);
addEventListener('keydown', ensureAudio);

// ---------- particles: wall sparks + boost flames ----------
function makeParticleSystem(count, { color, additive, gravity, drag, grow, baseSize }) {
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3);
  const fadeAttr = new THREE.Float32BufferAttribute(new Float32Array(count), 1);
  const sizeAttr = new THREE.Float32BufferAttribute(new Float32Array(count), 1);
  posAttr.setUsage(THREE.DynamicDrawUsage); fadeAttr.setUsage(THREE.DynamicDrawUsage); sizeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('aFade', fadeAttr);
  geo.setAttribute('aSize', sizeAttr);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uBoost: { value: additive ? 2.5 : 1.0 } },
    vertexShader: `
      attribute float aFade; attribute float aSize; varying float vFade;
      void main(){ vFade = aFade; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (240.0 / max(-mv.z, 1.0)); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uBoost; varying float vFade;
      void main(){ float a = smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5)) * vFade;
        if (a < 0.004) discard; gl_FragColor = vec4(uColor * uBoost, a); }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  const p = new Float32Array(count * 8);
  let cursor = 0;
  return {
    spawn(x, y, z, vx, vy, vz, life, size) {
      const idx = cursor, o = idx * 8; cursor = (cursor + 1) % count;
      p[o] = x; p[o + 1] = y; p[o + 2] = z; p[o + 3] = vx; p[o + 4] = vy; p[o + 5] = vz;
      p[o + 6] = 0; p[o + 7] = life;
      sizeAttr.array[idx] = size * baseSize;
    },
    update(dt) {
      for (let i = 0; i < count; i++) {
        const o = i * 8;
        if (p[o + 7] <= 0) { fadeAttr.array[i] = 0; continue; }
        p[o + 6] += dt;
        if (p[o + 6] >= p[o + 7]) { p[o + 7] = 0; fadeAttr.array[i] = 0; continue; }
        const dr = Math.exp(-drag * dt);
        p[o + 3] *= dr; p[o + 5] *= dr;
        p[o + 4] = p[o + 4] * dr + gravity * dt;
        p[o] += p[o + 3] * dt; p[o + 1] += p[o + 4] * dt; p[o + 2] += p[o + 5] * dt;
        const t = p[o + 6] / p[o + 7];
        posAttr.array[i * 3] = p[o]; posAttr.array[i * 3 + 1] = p[o + 1]; posAttr.array[i * 3 + 2] = p[o + 2];
        fadeAttr.array[i] = (1 - t) * (additive ? 1.0 : 0.32);
        sizeAttr.array[i] = baseSize * (1 + grow * t);
      }
      posAttr.needsUpdate = fadeAttr.needsUpdate = sizeAttr.needsUpdate = true;
    },
  };
}
const sparks = makeParticleSystem(260, { color: 0x8ff4ff, additive: true, gravity: -10, drag: 0.8, grow: -0.5, baseSize: 0.24 });
const flames = makeParticleSystem(300, { color: 0xffa14d, additive: true, gravity: 0.5, drag: 2.2, grow: 1.6, baseSize: 0.5 });

function updateParticles(dt) {
  if (state.phase === 'race') {
    for (const c of ships) {
      const spd = Math.hypot(c.vA, c.vL);
      if (c.hitWall && spd > 5) {
        const f = frameAt(c.s);
        const sgn = c.wallSide || 1;
        const px = c.wx + f.r[0] * 1.05 * sgn, py = c.wy + f.r[1] * 1.05 * sgn, pz = c.wz + f.r[2] * 1.05 * sgn;
        for (let i = 0; i < 4; i++) {
          sparks.spawn(
            px + (rng() - 0.5) * 0.4, py + rng() * 0.5, pz + (rng() - 0.5) * 0.4,
            -f.t[0] * spd * 0.4 + (rng() - 0.5) * 7, 2 + rng() * 5, -f.t[2] * spd * 0.4 + (rng() - 0.5) * 7,
            0.22 + rng() * 0.3, 1.0);
        }
      }
      if ((c.boosting || c.padGlow > 0.5) && spd > 4) {
        const f = frameAt(c.s);
        const cosP = Math.cos(c.psi), sinP = Math.sin(c.psi);
        const fx = f.t[0] * cosP + f.r[0] * sinP, fy = f.t[1] * cosP + f.r[1] * sinP, fz = f.t[2] * cosP + f.r[2] * sinP;
        for (let i = 0; i < 2; i++) {
          flames.spawn(
            c.wx - fx * 2.2 + (rng() - 0.5) * 0.5, c.wy - fy * 2.2 + 0.28, c.wz - fz * 2.2 + (rng() - 0.5) * 0.5,
            -fx * (spd * 0.3 + 6) + (rng() - 0.5) * 2, 0.4 + rng(), -fz * (spd * 0.3 + 6) + (rng() - 0.5) * 2,
            0.28 + rng() * 0.24, 1.0);
        }
      }
    }
  }
  sparks.update(dt);
  flames.update(dt);
}

// ---------- camera ----------
const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3(), camUp = new THREE.Vector3(0, 1, 0);
let camFrozen = false;
const _fwd = new THREE.Vector3(), _upW = new THREE.Vector3(), _rightW = new THREE.Vector3(),
  _want = new THREE.Vector3(), WORLD_UP = new THREE.Vector3(0, 1, 0);
const CAMERA_NAMES = ['CHASE', 'WIDE', 'COCKPIT', 'ORBITAL DRONE'];
function shipWorldFwd(c, out) {
  const f = frameAt(c.s);
  const cosP = Math.cos(c.psi), sinP = Math.sin(c.psi);
  out.set(
    f.t[0] * cosP + f.r[0] * sinP,
    f.t[1] * cosP + f.r[1] * sinP,
    f.t[2] * cosP + f.r[2] * sinP);
  return out;
}
function camSnap() {
  const f = frameAt(player.s);
  shipWorldFwd(player, _fwd);
  _upW.set(f.u[0], f.u[1], f.u[2]);
  _rightW.set(f.r[0], f.r[1], f.r[2]);
  const mode = state.cameraMode;
  camPos.set(player.wx, player.wy, player.wz);
  if (mode === 1) camPos.addScaledVector(_fwd, -16).addScaledVector(_upW, 6.3);
  else if (mode === 2) camPos.addScaledVector(_fwd, .95).addScaledVector(_upW, 1.05);
  else if (mode === 3) camPos.addScaledVector(_fwd, -6).addScaledVector(_rightW, 14).addScaledVector(_upW, 7.5);
  else camPos.addScaledVector(_fwd, -9.2).addScaledVector(_upW, 3.25);
  camTgt.set(player.wx, player.wy, player.wz)
    .addScaledVector(_fwd, mode === 2 ? 24 : 8)
    .addScaledVector(_upW, mode === 2 ? .45 : .8);
  camUp.copy(_upW).lerp(WORLD_UP, mode === 3 ? .7 : .32).normalize();
  camera.up.copy(camUp);
  camera.position.copy(camPos);
  camera.lookAt(camTgt);
}
function updateCamera(dt) {
  if (camFrozen) return;
  if (state.phase === 'menu' || state.phase === 'results') {
    // slow orbit around the grid so the menu floats over a living track
    const t = performance.now() * 0.00016;
    const f0 = frameAt(player.s);
    const cx = player.wx + Math.sin(t) * 26, cz = player.wz + Math.cos(t) * 26;
    camPos.lerp(_want.set(cx, player.wy + 9 + Math.sin(t * 0.7) * 2, cz), 1 - Math.exp(-2.2 * dt));
    camUp.lerp(WORLD_UP, 1 - Math.exp(-4 * dt)).normalize();
    camera.up.copy(camUp);
    camera.position.copy(camPos);
    camera.lookAt(player.wx, player.wy + 0.5, player.wz);
    camera.fov = 56;
    camera.updateProjectionMatrix();
    return;
  }
  const f = frameAt(player.s);
  shipWorldFwd(player, _fwd);
  _upW.set(f.u[0], f.u[1], f.u[2]).lerp(WORLD_UP, 0.35).normalize();
  _rightW.set(f.r[0], f.r[1], f.r[2]);
  const spd = Math.hypot(player.vA, player.vL);
  const mode = state.cameraMode;
  _want.set(player.wx, player.wy, player.wz);
  if (mode === 1) {
    _want.addScaledVector(_fwd, -(15.5 + spd * .06)).addScaledVector(_upW, 6.2 + spd * .018);
  } else if (mode === 2) {
    _want.addScaledVector(_fwd, 1.02).addScaledVector(_upW, 1.08);
  } else if (mode === 3) {
    const side = Math.sin(player.progress * .006) > 0 ? 1 : -1;
    _want.addScaledVector(_fwd, -6 - spd * .025).addScaledVector(_rightW, side * 14).addScaledVector(_upW, 7.8);
  } else {
    _want.addScaledVector(_fwd, -(9.1 + spd * .046)).addScaledVector(_upW, 3.15 + spd * .012);
  }
  camPos.lerp(_want, 1 - Math.exp(-(mode === 2 ? 13 : 6.4) * dt));
  _want.set(player.wx, player.wy, player.wz)
    .addScaledVector(_fwd, mode === 2 ? 26 : (mode === 3 ? 6 : 9))
    .addScaledVector(_upW, mode === 2 ? .38 : .8);
  camTgt.lerp(_want, 1 - Math.exp(-(mode === 2 ? 14 : 8.8) * dt));
  _want.copy(_upW).lerp(WORLD_UP, mode === 3 ? .72 : .05).normalize();
  camUp.lerp(_want, 1 - Math.exp(-4.5 * dt)).normalize();
  camera.up.copy(camUp);
  camera.position.copy(camPos);
  const shake = player.hitWall ? .18 : (player.boosting ? .025 : 0);
  if (shake) {
    camera.position.addScaledVector(_upW, Math.sin(performance.now() * .06) * shake);
    camera.position.addScaledVector(_rightW, Math.cos(performance.now() * .047) * shake * .7);
  }
  camera.lookAt(camTgt);
  const baseFov = mode === 1 ? 61 : (mode === 2 ? 70 : (mode === 3 ? 58 : 64));
  camera.fov = baseFov + Math.min(spd * (mode === 2 ? .08 : .14), 13) + (player.boosting ? 6 : 0);
  camera.updateProjectionMatrix();
  player.mesh.visible = mode !== 2 || state.phase === 'menu' || state.phase === 'results';
}

// ---------- post: HDR -> bright pass -> blur -> ACES composite ----------
const post = (() => {
  const sceneRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
  const blurA = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
  const blurB = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsGeo = new THREE.BufferGeometry();
  fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const fsScene = new THREE.Scene();
  const fsMesh = new THREE.Mesh(fsGeo, null);
  fsMesh.frustumCulled = false;
  fsScene.add(fsMesh);
  const V = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const brightMat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, thr: { value: 1.0 } }, vertexShader: V, fragmentShader: `
    uniform sampler2D tex; uniform float thr; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tex, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor = vec4(c * smoothstep(thr, thr * 2.0, l), 1.0); }`,
  });
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, texel: { value: new THREE.Vector2() } },
    vertexShader: V, fragmentShader: `
    uniform sampler2D tex; uniform vec2 dir; uniform vec2 texel; varying vec2 vUv;
    void main(){ vec2 o = dir * texel;
      vec3 c = texture2D(tex, vUv).rgb * 0.227027;
      c += (texture2D(tex, vUv + o * 1.3846).rgb + texture2D(tex, vUv - o * 1.3846).rgb) * 0.3162162;
      c += (texture2D(tex, vUv + o * 3.2308).rgb + texture2D(tex, vUv - o * 3.2308).rgb) * 0.0702703;
      gl_FragColor = vec4(c, 1.0); }`,
  });
  const compMat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, bloom: { value: null }, strength: { value: 1.0 }, exposure: { value: 1.12 } },
    vertexShader: V, fragmentShader: `
    uniform sampler2D tex; uniform sampler2D bloom; uniform float strength; uniform float exposure; varying vec2 vUv;
    vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
    void main(){
      vec3 c = texture2D(tex, vUv).rgb + texture2D(bloom, vUv).rgb * strength;
      c = aces(c * exposure);
      gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0); }`,
  });
  function pass(mat, target) { fsMesh.material = mat; renderer.setRenderTarget(target); renderer.render(fsScene, fsCam); }
  function setSize(w, h) {
    sceneRT.setSize(w, h);
    const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    blurA.setSize(bw, bh); blurB.setSize(bw, bh);
    blurMat.uniforms.texel.value.set(1 / bw, 1 / bh);
  }
  function render() {
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    brightMat.uniforms.tex.value = sceneRT.texture; pass(brightMat, blurA);
    for (let i = 0; i < 2; i++) {
      blurMat.uniforms.tex.value = blurA.texture; blurMat.uniforms.dir.value.set(1, 0); pass(blurMat, blurB);
      blurMat.uniforms.tex.value = blurB.texture; blurMat.uniforms.dir.value.set(0, 1); pass(blurMat, blurA);
    }
    compMat.uniforms.tex.value = sceneRT.texture; compMat.uniforms.bloom.value = blurA.texture;
    pass(compMat, null);
  }
  return { render, setSize };
})();
function renderFrame() { post.render(); }

// ---------- HUD ----------
const hud = {
  speed: document.getElementById('speed'), lap: document.getElementById('lap'),
  pos: document.getElementById('pos'), time: document.getElementById('time'),
  best: document.getElementById('best'), msg: document.getElementById('msg'),
  menu: document.getElementById('menu'), results: document.getElementById('results'),
  resBody: document.getElementById('resBody'), pause: document.getElementById('pauseOv'),
  mute: document.getElementById('muteBtn'), mini: document.getElementById('minimap'),
  shieldFill: document.getElementById('shieldFill'), shieldPct: document.getElementById('shieldPct'),
  shieldBar: document.getElementById('shieldBar'),
  boostFill: document.getElementById('boostFill'), boostPct: document.getElementById('boostPct'),
  tower: document.getElementById('leaderboard'),
  sectorName: document.getElementById('sectorName'), sectorIndex: document.getElementById('sectorIndex'),
  progressFill: document.getElementById('progressFill'), distanceLeft: document.getElementById('distanceLeft'),
  resultsSub: document.getElementById('resultsSub'),
};
document.getElementById('startBtn').addEventListener('click', () => { ensureAudio(); resetRace(); });
document.getElementById('againBtn').addEventListener('click', () => resetRace());
document.getElementById('resumeBtn').addEventListener('click', () => { state.phase = 'race'; hud.pause.classList.remove('show'); });
document.getElementById('pauseRestart').addEventListener('click', () => { hud.pause.classList.remove('show'); resetRace(); });
hud.mute.addEventListener('click', () => setMuted(!state.muted));

const fmt = t => !isFinite(t) ? '—' : `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

// minimap
const miniCtx = hud.mini.getContext('2d');
const miniBase = document.createElement('canvas');
let miniMap = null;
function buildMinimap() {
  const W = hud.mini.width, H = hud.mini.height;
  miniBase.width = W; miniBase.height = H;
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of track.pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const pad = 22;
  const sc = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
  const map = (x, z) => [pad + (x - minX) * sc + (W - pad * 2 - (maxX - minX) * sc) / 2,
                         pad + (z - minZ) * sc + (H - pad * 2 - (maxZ - minZ) * sc) / 2];
  const c = miniBase.getContext('2d');
  c.clearRect(0, 0, W, H);
  // elevation-tinted path: brighter = higher
  c.lineWidth = 7; c.lineCap = 'round';
  for (let i = 0; i < N; i += 4) {
    const p0 = track.pts[i], p1 = track.pts[(i + 4) % N];
    const hN = (p0[1] - trackStats.elevation[0]) /
      Math.max(1, trackStats.elevation[1] - trackStats.elevation[0]);
    c.strokeStyle = `rgba(${Math.round(110 + hN * 100)},${Math.round(190 + hN * 60)},255,${0.55 + hN * 0.35})`;
    c.beginPath();
    const [x0, y0] = map(p0[0], p0[2]);
    const [x1, y1] = map(p1[0], p1[2]);
    c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  const [sx, sz] = map(track.pts[START_IDX][0], track.pts[START_IDX][2]);
  c.fillStyle = '#fff'; c.fillRect(sx - 4, sz - 4, 8, 8);
  miniMap = map;
}
buildMinimap();
function drawMinimap() {
  const W = hud.mini.width, H = hud.mini.height;
  miniCtx.clearRect(0, 0, W, H);
  miniCtx.drawImage(miniBase, 0, 0);
  for (const c of ships) {
    const [mx, mz] = miniMap(c.wx, c.wz);
    miniCtx.fillStyle = '#' + c.spec.color.toString(16).padStart(6, '0');
    miniCtx.beginPath();
    miniCtx.arc(mx, mz, c.spec.player ? 9 : 6.5, 0, Math.PI * 2);
    miniCtx.fill();
    if (c.spec.player) { miniCtx.strokeStyle = '#fff'; miniCtx.lineWidth = 3; miniCtx.stroke(); }
  }
}

// position tower
function updateTower() {
  const order = ranking();
  const lead = order[0];
  hud.tower.innerHTML =
    '<div class="tower-title"><span>Live lab order</span><span>Gap</span></div>' +
    order.map((c, i) => {
    const col = '#' + c.spec.color.toString(16).padStart(6, '0');
    let gap;
    if (i === 0) gap = c.finished ? fmt(c.finishTime) : 'LEADER';
    else if (c.finished && lead.finished) gap = '+' + (c.finishTime - lead.finishTime).toFixed(1);
    else gap = '+' + ((lead.progress - c.progress) / Math.max(Math.hypot(lead.vA, lead.vL), 10)).toFixed(1);
    return `<div class="tower-row${c.spec.player ? ' you' : ''}" style="--lab:${col}">` +
      `<span class="rank">${String(i + 1).padStart(2, '0')}</span>` +
      '<span class="swatch"></span>' +
      `<span>${c.spec.name}</span>` +
      `<span class="gap">${gap}</span></div>`;
  }).join('');
}

let hudClock = 0;
function updateHUD(dt) {
  hudClock += dt;
  if (hudClock < 0.1) return;
  hudClock = 0;
  const towerOn = (state.phase === 'race' || state.phase === 'countdown') && innerWidth > 900;
  hud.tower.style.display = towerOn ? 'block' : 'none';
  if (hud.tower.style.display === 'block') updateTower();
  const spd = Math.hypot(player.vA, player.vL);
  hud.speed.textContent = Math.round(spd * 3.6);
  hud.lap.textContent = `${Math.min(player.lap + 1, LAPS)}/${LAPS}`;
  const rank = ranking().indexOf(player) + 1;
  hud.pos.textContent = `${rank}/${ships.length}`;
  hud.time.textContent = fmt(state.raceTime - player.lapStart);
  hud.best.textContent = `${player.packets}/${DATA_CORES.length}`;
  hud.shieldFill.style.width = `${player.shield}%`;
  hud.shieldPct.textContent = `${Math.round(player.shield)}%`;
  hud.shieldBar.classList.toggle('warn', player.shield < 25);
  hud.boostFill.style.width = `${player.boost}%`;
  hud.boostPct.textContent = `${Math.round(player.boost)}%`;
  const missionProgress = THREE.MathUtils.clamp((player.lapProgress ?? player.progress) / L, 0, 1);
  hud.progressFill.style.width = `${missionProgress * 100}%`;
  hud.distanceLeft.textContent = missionProgress >= .995
    ? 'HELIOS LINK ACQUIRED'
    : `${((1 - missionProgress) * L / 1000).toFixed(1)} KM TO COMPUTE`;
  let activeSector = SECTORS[0];
  for (const sector of SECTORS) if (missionProgress >= sector.f) activeSector = sector;
  hud.sectorName.textContent = activeSector.name;
  hud.sectorIndex.textContent = activeSector.code;
  if (state.phase === 'race') {
    if (state.goTimer > 0) { state.goTimer -= 0.1; hud.msg.textContent = 'GO!'; hud.msg.classList.remove('warn'); }
    else {
      state.cameraLabelT = Math.max(0, state.cameraLabelT - .1);
      hud.msg.textContent = player.wrongWay > 1.2
        ? 'WRONG WAY'
        : (state.cameraLabelT > 0
          ? `CAM // ${CAMERA_NAMES[state.cameraMode]}`
          : (player.drafting ? (innerWidth < 700 ? 'DRAFT' : 'DRAFT LINK') : ''));
      hud.msg.classList.toggle('warn', player.wrongWay > 1.2);
    }
  }
  drawMinimap();
}

function showResults() {
  state.phase = 'results';
  document.body.classList.remove('race-active');
  const rows = ranking().map((c, i) => {
    const you = c.spec.player ? ' class="you"' : '';
    return `<tr${you}><td>${i + 1}</td><td>${c.spec.name}</td><td>${c.spec.player ? `${c.packets}/${DATA_CORES.length}` : '—'}</td><td>${c.finished ? fmt(c.finishTime) : 'DNF'}</td></tr>`;
  }).join('');
  hud.resBody.innerHTML = rows;
  const rank = ranking().indexOf(player) + 1;
  document.getElementById('resTitle').textContent =
    rank === 1 ? 'COMPUTE CLAIMED' : `P${rank} // HELIOS ARRIVAL`;
  hud.resultsSub.textContent = rank === 1
    ? 'OPENAI reached the HELIOS orbital array first'
    : `OPENAI finished P${rank} of ${ships.length} // run it back`;
  hud.results.classList.add('show');
}

// ---------- main loop ----------
function physicsStep() {
  const freeze = state.phase === 'countdown';
  const input = state.autopilot ? null : readInput();
  for (const c of ships) {
    if (c.spec.player && !state.autopilot) {
      if (testInput) {
        c.steerIn = testInput.steer ?? 0; c.throttle = testInput.throttle ?? 0;
        c.brake = testInput.brake ?? 0; c.airbrake = testInput.airbrake ?? 0; c.boostIn = testInput.boost ?? 0;
      } else {
        c.steerIn = input.steer; c.throttle = input.throttle; c.brake = input.brake;
        c.airbrake = input.airbrake; c.boostIn = input.boost;
      }
    } else {
      aiDrive(c, player.progress);
    }
    stepShip(c, state.raceTime, freeze);
  }
  collideShips(ships);
  if (!freeze) state.raceTime += DT;
}

const _shipM = new THREE.Matrix4(), _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3();
function syncMeshes(t) {
  for (const c of ships) {
    const f = frameAt(c.s);
    const cosP = Math.cos(c.psi), sinP = Math.sin(c.psi);
    _Z.set(
      f.t[0] * cosP + f.r[0] * sinP,
      f.t[1] * cosP + f.r[1] * sinP,
      f.t[2] * cosP + f.r[2] * sinP);
    _Y.set(f.u[0], f.u[1], f.u[2]);
    _X.crossVectors(_Y, _Z).normalize();
    _shipM.makeBasis(_X, _Y, _Z);
    c.mesh.quaternion.setFromRotationMatrix(_shipM);
    const bob = Math.sin(t * 2.1 + c.bobPhase) * 0.05;
    c.mesh.position.set(c.wx + f.u[0] * bob, c.wy + f.u[1] * bob, c.wz + f.u[2] * bob);
    c.lean.rotation.z = c.roll;
    c.lean.rotation.x = c.pitch;
    const glow = 0.55 + (c.throttle || 0) * 0.75 + (c.boosting ? 1.2 : 0) + c.padGlow * 0.9;
    for (const m of c.engines) m.color.setRGB(0.75 * glow, 0.91 * glow, glow);
    // nameplates fade out near the camera so they never splat across the view
    if (c.plate) {
      const dc = Math.hypot(c.wx - camera.position.x, c.wy - camera.position.y, c.wz - camera.position.z);
      c.plate.visible = innerWidth > 700;
      c.plate.material.opacity = THREE.MathUtils.clamp((dc - 14) / 30, 0, .72);
    }
  }
}

let last = performance.now(), acc = 0, testMode = false, testInput = null;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const t = now / 1000;
  if (state.phase === 'countdown') {
    state.countdown -= dt;
    const n = Math.ceil(state.countdown - 0.2);
    if (n > 0 && n !== state.countdownBeat) {
      state.countdownBeat = n;
      launchTone(false);
    } else if (n <= 0 && state.countdownBeat !== 0) {
      state.countdownBeat = 0;
      launchTone(true);
    }
    hud.msg.classList.remove('warn');
    hud.msg.textContent = n > 0 ? String(n) : 'GO!';
    if (state.countdown <= 0.2 && state.phase === 'countdown') { state.phase = 'race'; state.goTimer = 1.2; }
  }
  const running = state.phase === 'race' || state.phase === 'countdown';
  if (running && !testMode) {
    acc = Math.min(acc + dt, 0.25);
    while (acc >= DT) { physicsStep(); acc -= DT; }
    if (state.phase === 'race' && player.finished) {
      if (state.finishDelay < 0) state.finishDelay = 0;
      state.finishDelay += dt;
      if (state.finishDelay >= 4.2 || ships.every(c => c.finished)) showResults();
    }
  }
  syncMeshes(t);
  for (const c of ships) updateTrail(c, dt);
  updateParticles(dt);
  updateStartLights();
  updateCamera(dt);
  updateAudio();
  // animated materials
  for (const m of window.__wallMats || []) m.uniforms.uT.value = t;
  for (const m of padMats) m.map.offset.y -= dt * 2.2;
  if (rechargeMat) rechargeMat.opacity = 0.24 + 0.12 * Math.sin(t * 3.5);
  dataCoreMeshes.forEach((g, i) => {
    g.rotation.y = t * 1.3 + i;
    g.rotation.x = Math.sin(t * .9 + i) * .32;
    const pulse = 1 + Math.sin(t * 4 + i * 1.7) * .13;
    g.scale.setScalar(pulse);
  });
  archMats.forEach((m, i) => {
    const s = 0.8 + 0.3 * Math.sin(t * 2.5 + i * 0.9);
    m.color.setRGB(0.16 * s, 0.6 * s, 0.85 * s); // deep cyan even at peak — never blows white
  });
  if (running || testMode) updateHUD(dt);
  renderFrame();
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  const db = renderer.getDrawingBufferSize(new THREE.Vector2());
  post.setSize(db.x, db.y);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
camSnap();
requestAnimationFrame(frame);

// ---------- test harness (drives the same physics the player feels) ----------
const testApi = {
  testMode(on) { testMode = !!on; if (on && state.phase === 'menu') resetRace(); },
  skipCountdown() { state.countdown = 0; state.phase = 'race'; hud.msg.textContent = ''; },
  setInput(o) { testInput = o; },
  step(n) { for (let i = 0; i < n; i++) physicsStep(); syncMeshes(performance.now() / 1000); },
  teleport(s, lat, psi, speed = 0) {
    player.s = wrapS(s); player.lat = lat; player.psi = psi;
    player.vA = speed; player.vL = 0; player.steer = 0;
    player._sPrev = player.s;
    const f = frameAt(player.s);
    player.wx = f.p[0] + f.r[0] * lat + f.u[0] * 0.55;
    player.wy = f.p[1] + f.r[1] * lat + f.u[1] * 0.55;
    player.wz = f.p[2] + f.r[2] * lat + f.u[2] * 0.55;
    syncMeshes(performance.now() / 1000);
  },
  freezeCam(on) { camFrozen = !!on; if (!on) camSnap(); },
  snapCam() { camSnap(); renderFrame(); },
  renderOnce() {
    syncMeshes(performance.now() / 1000);
    for (const c of ships) updateTrail(c, 1 / 60);
    updateStartLights(); if (!camFrozen) camSnap(); hudClock = 1; updateHUD(0);
    renderFrame();
  },
  ndcOfPlayer() {
    const v = new THREE.Vector3(player.wx, player.wy, player.wz).project(camera);
    return { x: v.x, y: v.y, z: v.z };
  },
  state() {
    return {
      phase: state.phase, s: player.s, lat: player.lat, psi: player.psi,
      speed: Math.hypot(player.vA, player.vL), vA: player.vA, vL: player.vL,
      shield: player.shield, boost: player.boost, boosting: player.boosting, limp: player.limp,
      packets: player.packets, drafting: player.drafting, cameraMode: state.cameraMode,
      lap: player.lap, lapProgress: player.lapProgress, progress: player.progress,
      hitWall: !!player.hitWall, finished: player.finished,
      wx: player.wx, wy: player.wy, wz: player.wz,
      ships: ships.map(c => ({
        name: c.spec.name, lap: c.lap, progress: c.progress,
        speed: Math.hypot(c.vA, c.vL), lat: c.lat, shield: c.shield, boost: c.boost,
      })),
    };
  },
  autopilot(on) { state.autopilot = !!on; },
  tickFx(dt) { updateParticles(dt); for (const c of ships) updateTrail(c, dt); },
  audio() {
    ensureAudio(); updateAudio();
    return !ac ? { built: false } : {
      built: true, ctxState: ac.state, workletUp: !!engineNode,
      freq: engineNode ? engineNode.parameters.get('freq').value : 0,
      engineGain: engineGain.gain.value, master: masterGain.gain.value,
      aiVoices: aiVoices.length,
    };
  },
  renderer, camera, scene, THREE, showResults, frameAt: s => JSON.parse(JSON.stringify(frameAt(s))),
  track: { length: L, halfWidth: HALF_WIDTH, samples: N, startIdx: START_IDX },
};
window.__aiRace = testApi;
window.__zero = testApi; // compatibility with the donor game's existing regression scripts
console.log('[THE AI RACE] ready — %s labs, track %sm, elevation %s..%sm, min radius %sm',
  ships.length,
  L.toFixed(0),
  trackStats.elevation[0].toFixed(0), trackStats.elevation[1].toFixed(0),
  trackStats.minRadius.toFixed(1));
