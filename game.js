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
import { createSpectacle, selectRenderProfile } from './spectacle.js';
import { createRaceControl, DEFAULT_RACE_CONTROL_CLIPS } from './race-control.js';

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
const SLINGSHOT_ACCEL = 42, SLINGSHOT_VMAX_MUL = 1.46;
const SLINGSHOT_DURATION = .82, SLINGSHOT_COST = 11;
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

// ---------- player-facing race setup ----------
const DIFFICULTY_PRESETS = Object.freeze({
  rookie: Object.freeze({
    id: 'rookie',
    label: 'ROOKIE',
    pace: .955,
    corner: .94,
    burstOffset: 10,
    boostDuration: .9,
    bandMin: -.055,
    bandMax: .01,
    passLook: 22,
    passOffset: 1.6,
    edgeAssist: .55,
    playerGrip: 1.12,
    wallDamage: .65,
    collisionDamage: .75,
    passiveRegen: 2,
    rechargeRate: 50,
    boostDrain: .92,
    padCharge: 1.08,
    boostGrip: .90,
    impactLockout: .34,
    boostSpill: 8,
    damageCooldown: 2.4,
    impactSpeedLoss: .11,
    wakeRate: .72,
    slingshotCooldown: 11,
    aiSlingshotLimit: 1,
  }),
  pro: Object.freeze({
    id: 'pro',
    label: 'PRO',
    pace: 1,
    corner: 1,
    burstOffset: 0,
    boostDuration: 1,
    bandMin: -.025,
    bandMax: .03,
    passLook: 30,
    passOffset: 2.1,
    edgeAssist: .18,
    playerGrip: 1,
    wallDamage: 1,
    collisionDamage: 1,
    passiveRegen: .7,
    rechargeRate: 45,
    boostDrain: 1,
    padCharge: 1,
    boostGrip: .84,
    impactLockout: .48,
    boostSpill: 11,
    damageCooldown: 4,
    impactSpeedLoss: .20,
    wakeRate: 1,
    slingshotCooldown: 8.5,
    aiSlingshotLimit: 2,
  }),
  apex: Object.freeze({
    id: 'apex',
    label: 'APEX',
    pace: 1.085,
    corner: 1.14,
    burstOffset: -16,
    boostDuration: 1.22,
    bandMin: -.012,
    bandMax: .018,
    passLook: 38,
    passOffset: 2.7,
    edgeAssist: 0,
    playerGrip: 1,
    wallDamage: 1.15,
    collisionDamage: 1.1,
    passiveRegen: 0,
    rechargeRate: 40,
    boostDrain: 1.06,
    padCharge: .96,
    boostGrip: .78,
    impactLockout: .64,
    boostSpill: 14,
    damageCooldown: 6,
    impactSpeedLoss: .26,
    wakeRate: 1.08,
    slingshotCooldown: 6.8,
    aiSlingshotLimit: 3,
  }),
});

const DRIVER_PROFILES = Object.freeze({
  pilot: Object.freeze({
    id: 'pilot',
    name: 'OPENAI PILOT',
    hudName: 'OPENAI PILOT',
    callsign: 'ORBIT-01',
    monogram: '01',
    accent: 0xdfff47,
  }),
  sam: Object.freeze({
    id: 'sam',
    name: 'SAM ALTMAN',
    hudName: 'SAM ALTMAN',
    callsign: 'SAM // 01',
    monogram: 'SA',
    accent: 0x6cecff,
    tribute: true,
  }),
});

const CONTRACT_PRESETS = Object.freeze({
  sprint: Object.freeze({
    id: 'sprint',
    label: 'SPRINT',
    short: 'FIRST TO HELIOS',
    describe: 'Pure position and time. Claim the array.',
  }),
  'full-payload': Object.freeze({
    id: 'full-payload',
    label: 'FULL PAYLOAD',
    short: 'SECURE 8 DATA CORES',
    describe: 'Collect every off-line data core before classification.',
  }),
  'clean-uplink': Object.freeze({
    id: 'clean-uplink',
    label: 'CLEAN UPLINK',
    short: 'NO CONTACT',
    describe: 'Reach HELIOS without touching a wall or rival.',
  }),
  'slingshot-master': Object.freeze({
    id: 'slingshot-master',
    label: 'SLINGSHOT MASTER',
    short: 'DEPLOY 2 SLINGSHOTS',
    describe: 'Build and fire at least two race-legal wake surges.',
  }),
});

const STORAGE_KEYS = Object.freeze({
  difficulty: 'ai-race:difficulty:v1',
  driver: 'ai-race:driver:v1',
  contract: 'ai-race:contract:v1',
  records: 'ai-race:records:v1',
  ghosts: 'ai-race:ghosts:v1',
});

const query = new URLSearchParams(location.search);
const showcaseMode = query.get('showcase') === '1';

function storedChoice(key, choices, fallback) {
  try {
    const value = localStorage.getItem(key);
    return choices[value] ? value : fallback;
  } catch {
    return fallback;
  }
}

function queryChoice(name, choices) {
  const value = query.get(name);
  return choices[value] ? value : null;
}

const setupSelection = {
  difficulty: queryChoice('difficulty', DIFFICULTY_PRESETS) ||
    (showcaseMode ? 'pro' : storedChoice(STORAGE_KEYS.difficulty, DIFFICULTY_PRESETS, 'pro')),
  driver: queryChoice('driver', DRIVER_PROFILES) ||
    (showcaseMode ? 'sam' : storedChoice(STORAGE_KEYS.driver, DRIVER_PROFILES, 'pilot')),
  contract: queryChoice('contract', CONTRACT_PRESETS) ||
    (showcaseMode ? 'sprint' : storedChoice(STORAGE_KEYS.contract, CONTRACT_PRESETS, 'sprint')),
};
const activeDifficulty = () => DIFFICULTY_PRESETS[setupSelection.difficulty];
const activeDriver = () => DRIVER_PROFILES[setupSelection.driver];
const activeContract = () => CONTRACT_PRESETS[setupSelection.contract];
const showcaseSetupActive = () => showcaseMode &&
  query.get('autostart') === '1' &&
  setupSelection.difficulty === 'pro' &&
  setupSelection.driver === 'sam' &&
  setupSelection.contract === 'sprint';
const recordKey = () => `${setupSelection.difficulty}:${setupSelection.contract}`;
function loadRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.records) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
const raceRecords = loadRecords();
function loadGhosts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.ghosts) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
const raceGhosts = loadGhosts();

function seedHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function selectedRunSeed() {
  const requested = Number.parseInt(query.get('seed') || '', 10);
  if (Number.isFinite(requested)) return requested >>> 0;
  return seedHash(`${setupSelection.difficulty}:${setupSelection.contract}:${showcaseMode ? 'showcase' : 'standard'}`);
}
let raceRng = mulberry32(selectedRunSeed());

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
  { name: 'AIIT-THRESHOLD', color: 0xff3e93, trimColor: 0x6cecff, threshold: true,
    vmax: 84.4, latG: 20.6, look: 1.01, risk: 1.01, burstAt: 45, lane: 0.8 },
  { name: 'MICROSOFT', color: 0x7fdb55, vmax: 84.2, latG: 20.8, look: 1.13, risk: 0.96, burstAt: 57, lane: -2.4 },
  { name: 'OPENAI',    color: 0xdfff47, vmax: 89.5, latG: 22.8, look: 1.04, risk: 1.03, burstAt: 38, lane: 0, player: true },
];

// ---------- renderer / scene ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const renderProfile = selectRenderProfile(renderer);
document.body.dataset.renderProfile = renderProfile.name.toLowerCase();
const renderEyebrow = document.querySelector('#menu .eyebrow');
if (renderEyebrow) renderEyebrow.textContent = 'HELIOS ORBITAL GRAND PRIX // BUILD WEEK EXHIBITION';
function profilePixelRatio(width = innerWidth, height = innerHeight) {
  const budget = Math.sqrt(renderProfile.maxPixels / Math.max(1, width * height));
  const textureCap = renderer.capabilities.maxTextureSize / Math.max(1, width, height);
  return Math.max(.5, Math.min(
    devicePixelRatio,
    renderProfile.software ? .58 : renderProfile.pixelRatio,
    budget,
    textureCap,
  ));
}
let adaptiveRenderScale = 1;
let renderPixelRatio = profilePixelRatio();
renderer.setPixelRatio(renderPixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = renderProfile.post ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = renderProfile.post ? 1 : 1.04;
renderer.shadowMap.enabled = renderProfile.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x030713, 720, 2500);
const camera = new THREE.PerspectiveCamera(64, 1, 0.1, 5200);

// ---------- orbital sky: starfield + Earth limb + solar glow ----------
const MOON_DIR = new THREE.Vector3(-310, 240, -170).normalize();
const skyMats = [];
function makeSkyMesh(animate = true) {
  const geo = new THREE.SphereGeometry(3600, renderProfile.name === 'BALANCED' ? 28 : 48, renderProfile.name === 'BALANCED' ? 14 : 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x010106) },
      bot: { value: new THREE.Color(0x070b19) },
      moonDir: { value: MOON_DIR },
      auroraA: { value: new THREE.Color(0x1de9b6) },
      auroraB: { value: new THREE.Color(0x7c4dff) },
      uTime: { value: 0 },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform vec3 top; uniform vec3 bot; uniform vec3 moonDir;
      uniform vec3 auroraA; uniform vec3 auroraB; uniform float uTime; varying vec3 vP;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164)))*43758.5453); }
      float noise3(vec3 p){
        vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
      }
      float fbm(vec3 p){
        float n=0.0; n+=noise3(p)*.56; p=p*2.03+3.1;
        n+=noise3(p)*.28; p=p*2.01+5.7; n+=noise3(p)*.14;
        return n;
      }
      void main(){
        vec3 d = normalize(vP);
        float h = clamp(d.y * .5 + .5, 0.0, 1.0);
        vec3 col = mix(bot, top, pow(h, 0.72));
        float horizon = exp(-abs(d.y + .08) * 9.0);
        col += vec3(.025,.075,.17) * horizon;
        vec3 galN = normalize(vec3(.22,.91,.35));
        float galBand = exp(-abs(dot(d,galN)+.08)*9.0);
        float galNoise = fbm(d*9.0+vec3(1.0,4.0,7.0));
        col += mix(vec3(.04,.13,.22),vec3(.25,.06,.29),galNoise) * galBand * smoothstep(.28,.82,galNoise) * .82;
        float neb = smoothstep(.58,.82,fbm(d*5.2+vec3(7.0,-3.0,2.0)));
        col += vec3(.055,.018,.12) * neb * (1.0-galBand*.35);
        float m = max(dot(d, moonDir), 0.0);
        col += vec3(1.0,.91,.78) * pow(m, 1800.0) * 5.5;
        col += vec3(.5,.57,.85) * pow(m, 34.0) * .2;
        float drift=uTime*.018;
        float band1=exp(-abs(d.y-.31-.035*sin(d.x*5.0+d.z*3.0+drift))*21.0);
        float band2=exp(-abs(d.y-.43-.026*sin(d.x*7.0-d.z*4.0-drift))*26.0);
        float mask=smoothstep(.15,.9,fbm(d*12.0+vec3(drift,0.0,0.0)));
        col += auroraA*band1*mask*.34+auroraB*band2*(1.0-mask)*.28;
        vec3 cell=floor(d*420.0);
        float star=step(.9983,hash(cell));
        col+=vec3(.72,.85,1.0)*star*(.55+1.7*hash(cell+1.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  if (animate) skyMats.push(mat);
  return new THREE.Mesh(geo, mat);
}
scene.add(makeSkyMesh());
{
  const envScene = new THREE.Scene();
  envScene.add(makeSkyMesh(false));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
}
scene.add(new THREE.HemisphereLight(0x789bcc, 0x080a12, 0.56));
const moon = new THREE.DirectionalLight(0xffe4ca, 2.25);
moon.position.copy(MOON_DIR).multiplyScalar(400);
moon.castShadow = renderProfile.shadows;
if (renderProfile.shadows) {
  moon.shadow.mapSize.set(renderProfile.shadowMap, renderProfile.shadowMap);
  moon.shadow.camera.left = moon.shadow.camera.bottom = -48;
  moon.shadow.camera.right = moon.shadow.camera.top = 48;
  moon.shadow.camera.near = 30;
  moon.shadow.camera.far = 720;
  moon.shadow.bias = -0.0003;
  moon.shadow.normalBias = 0.035;
  scene.add(moon.target);
}
scene.add(moon);
const orbitalRim = new THREE.DirectionalLight(0x638cff, .46);
orbitalRim.position.set(250, 90, 380);
scene.add(orbitalRim);

// ---------- procedural textures ----------
function makeDeckMaps() {
  const size = renderProfile.name === 'BALANCED' ? 256 : 512;
  const colorCanvas = document.createElement('canvas');
  const roughCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = roughCanvas.width = roughCanvas.height =
    bumpCanvas.width = bumpCanvas.height = size;
  const color = colorCanvas.getContext('2d');
  const rough = roughCanvas.getContext('2d');
  const bump = bumpCanvas.getContext('2d');
  color.fillStyle = '#202838'; color.fillRect(0, 0, size, size);
  rough.fillStyle = '#a0a0a0'; rough.fillRect(0, 0, size, size);
  bump.fillStyle = '#808080'; bump.fillRect(0, 0, size, size);

  // Large composite panels read at 300 km/h; small directional scoring catches
  // the moving key light without turning the road into random visual noise.
  const cols = 4, rows = 8;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const x0 = x * size / cols, y0 = y * size / rows;
    const shade = 27 + ((x * 7 + y * 11) % 11);
    color.fillStyle = `rgb(${shade},${shade + 5},${shade + 14})`;
    color.fillRect(x0 + 2, y0 + 2, size / cols - 4, size / rows - 4);
    color.strokeStyle = 'rgba(95,126,160,.22)';
    color.lineWidth = 1;
    color.strokeRect(x0 + 3.5, y0 + 3.5, size / cols - 7, size / rows - 7);
    rough.fillStyle = `rgb(${132 + ((x + y) % 3) * 12},${132 + ((x + y) % 3) * 12},${132 + ((x + y) % 3) * 12})`;
    rough.fillRect(x0 + 3, y0 + 3, size / cols - 6, size / rows - 6);
    bump.strokeStyle = '#5f5f5f'; bump.lineWidth = 2;
    bump.strokeRect(x0 + 2, y0 + 2, size / cols - 4, size / rows - 4);
    bump.strokeStyle = '#9d9d9d'; bump.lineWidth = 1;
    bump.strokeRect(x0 + 4, y0 + 4, size / cols - 8, size / rows - 8);
  }
  for (let i = 0; i < size * 5; i++) {
    const x = rng() * size, y = rng() * size;
    const len = 2 + rng() * 24;
    color.strokeStyle = `rgba(${rng() < .08 ? 105 : 190},${rng() < .08 ? 155 : 205},220,${.012 + rng() * .038})`;
    color.lineWidth = rng() < .1 ? 1 : .4;
    color.beginPath(); color.moveTo(x, y); color.lineTo(x + (rng() - .5) * 1.6, y + len); color.stroke();
  }
  // Recessed coolant/data conduits run with the direction of travel.
  for (const x of [size * .12, size * .5, size * .88]) {
    color.fillStyle = 'rgba(7,11,18,.68)'; color.fillRect(x - 2, 0, 4, size);
    color.fillStyle = 'rgba(83,126,170,.16)'; color.fillRect(x + 2, 0, 1, size);
    bump.fillStyle = '#565656'; bump.fillRect(x - 2, 0, 4, size);
  }
  const toTexture = (canvas, srgb = false) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };
  return {
    color: toTexture(colorCanvas, true),
    roughness: toTexture(roughCanvas),
    bump: toTexture(bumpCanvas),
  };
}
const deckMaps = makeDeckMaps();
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
const earthDynamic = { materials: [], clouds: null };
{
  const earthRadius = 1700;
  const earthPosition = new THREE.Vector3(1150, -80, 2610);
  const earthMat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      sunDir: { value: MOON_DIR },
      ocean: { value: new THREE.Color(0x061d37) },
      land: { value: new THREE.Color(0x174f55) },
      ice: { value: new THREE.Color(0xbde8ed) },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vP;
      void main(){ vN=normalize(normalMatrix*normal); vP=normalize(position);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 sunDir; uniform vec3 ocean; uniform vec3 land; uniform vec3 ice; uniform float uTime;
      varying vec3 vN; varying vec3 vP;
      float hash(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
      float noise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){
        vec3 spinP=normalize(vec3(vP.x*cos(uTime*.001)-vP.z*sin(uTime*.001),vP.y,vP.x*sin(uTime*.001)+vP.z*cos(uTime*.001)));
        float n=noise(spinP*4.2)+noise(spinP*9.0)*0.45+noise(spinP*21.0)*0.16;
        float continent=smoothstep(.72,.88,n+abs(vP.y)*.05);
        vec3 base=mix(ocean,land,continent);
        base=mix(base,ice,smoothstep(.78,.96,abs(vP.y)));
        float solar=dot(vP,normalize(sunDir));
        float light=.055+.945*smoothstep(-.08,.22,solar);
        float city=step(.855,noise(spinP*58.0))*continent*(1.0-smoothstep(-.08,.18,solar));
        float coast=smoothstep(.70,.74,n)-smoothstep(.86,.9,n);
        gl_FragColor=vec4(base*light+vec3(1.0,.47,.14)*city*2.35+vec3(.03,.16,.2)*coast*light,1.0);
      }`,
  });
  earthDynamic.materials.push(earthMat);
  const earthSegments = renderProfile.name === 'ULTRA' ? [112, 72] : (renderProfile.name === 'HIGH' ? [80, 48] : [48, 28]);
  const earth = new THREE.Mesh(new THREE.SphereGeometry(earthRadius, earthSegments[0], earthSegments[1]), earthMat);
  // Keep the planet enormous but physically distant. The near placement made
  // later sectors pass through its surface; this composition gives Earthside
  // a huge limb while leaving the complete orbital ribbon unobstructed.
  earth.position.copy(earthPosition);
  earth.rotation.z = -0.22;
  scene.add(earth);

  // Separate animated clouds introduce a moving scale reference over the
  // terminator at the cost of one translucent draw.
  const cloudMat = new THREE.ShaderMaterial({
    fog: false,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    uniforms: { uTime: { value: 0 }, sunDir: { value: MOON_DIR } },
    vertexShader: 'varying vec3 vP; varying vec3 vN; void main(){vP=normalize(position);vN=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec3 vP; varying vec3 vN; uniform float uTime; uniform vec3 sunDir;
      float h(vec3 p){return fract(sin(dot(p,vec3(17.13,43.71,91.17)))*43758.5453);}
      float n(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
        mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z);}
      void main(){
        float a=uTime*.004; vec3 p=vec3(vP.x*cos(a)-vP.z*sin(a),vP.y,vP.x*sin(a)+vP.z*cos(a));
        float cloud=n(p*11.0)*.65+n(p*23.0)*.35;
        float alpha=smoothstep(.57,.72,cloud)*.48*smoothstep(-.24,.18,dot(vP,normalize(sunDir)));
        gl_FragColor=vec4(vec3(.78,.9,1.0)*(1.0+max(dot(vN,normalize(sunDir)),0.0)),alpha);
      }`,
  });
  earthDynamic.materials.push(cloudMat);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(earthRadius + 12, earthSegments[0], earthSegments[1]), cloudMat);
  clouds.position.copy(earth.position);
  clouds.rotation.copy(earth.rotation);
  earthDynamic.clouds = clouds;
  scene.add(clouds);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(earthRadius + 42, earthSegments[0], earthSegments[1]),
    new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { tint: { value: new THREE.Color(0x4ebcff) } },
      vertexShader: 'varying vec3 vN;varying vec3 vV;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vN=normalize(normalMatrix*normal);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'varying vec3 vN;varying vec3 vV;uniform vec3 tint;void main(){float f=pow(1.0-abs(dot(vN,vV)),3.2);gl_FragColor=vec4(tint*(.7+f*2.2),f*.52);}',
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
  const mat = new THREE.MeshStandardMaterial({
    map: winTex,
    emissiveMap: winTex,
    color: 0x243044,
    emissive: 0x78b8e8,
    emissiveIntensity: .78,
    roughness: .31,
    metalness: .82,
    envMapIntensity: 1.2,
  });
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
// deck: dark reflective composite panels with directional wear, variable
// roughness, and actual micro-relief for the moving solar key.
deckMaps.color.repeat.set(1, 1);
deckMaps.roughness.repeat.set(1, 1);
deckMaps.bump.repeat.set(1, 1);
const deckMesh = buildStrip3D(-HALF_WIDTH, HALF_WIDTH, 0, new THREE.MeshStandardMaterial({
  map: deckMaps.color,
  roughnessMap: deckMaps.roughness,
  bumpMap: deckMaps.bump,
  bumpScale: .085,
  color: 0xdde8ff,
  emissive: 0x07101c,
  emissiveIntensity: .42,
  roughness: 0.48,
  metalness: 0.58,
  envMapIntensity: 1.45,
}));
deckMesh.receiveShadow = renderProfile.shadows;
// A subtle rubbered/data-flow groove adds surface depth without competing with
// boost pads or clipping to white in bloom.
buildStrip3D(-2.15, 2.15, 0.018, new THREE.MeshStandardMaterial({
  color: 0x080d14,
  emissive: 0x071322,
  emissiveIntensity: .28,
  roughness: .27,
  metalness: .72,
  transparent: true,
  opacity: .64,
  depthWrite: false,
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
  rechargeMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      cyan: { value: new THREE.Color(0x35e7e2) },
      lime: { value: new THREE.Color(0xdfff47) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv=uv;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime;
      uniform vec3 cyan;
      uniform vec3 lime;
      void main(){
        float sequence=fract(vUv.y*3.4-uTime*.72);
        float bar=1.0-smoothstep(.055,.18,abs(sequence-.5));
        float laneA=1.0-smoothstep(.012,.045,abs(vUv.x-.32));
        float laneB=1.0-smoothstep(.012,.045,abs(vUv.x-.68));
        float edge=smoothstep(0.0,.08,vUv.x)*(1.0-smoothstep(.92,1.0,vUv.x));
        float lane=max(laneA,laneB);
        vec3 energy=mix(cyan,lime,lane);
        float alpha=edge*(.025+bar*.075+lane*(.11+bar*.19));
        gl_FragColor=vec4(energy*(1.0+bar*.8+lane*.9),alpha);
      }`,
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
  const every = Math.max(1, Math.round((renderProfile.name === 'BALANCED' ? 14 : 7) / STEP));
  const archGeo = new THREE.TorusGeometry(HALF_WIDTH + 1.3, 0.17, 8, 26, Math.PI);
  const M = new THREE.Matrix4();
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), P = new THREE.Vector3();
  const slots = [];
  for (let i = i0; i <= i1; i += every) slots.push(i);
  const mat = new THREE.MeshBasicMaterial({ color: 0x2fa8d8, fog: false });
  archMats.push(mat);
  const arches = new THREE.InstancedMesh(archGeo, mat, slots.length);
  slots.forEach((i, instanceIndex) => {
    const ii = wrapI(i);
    const p = track.pts[ii], t = track.tangents[ii], u = track.ups[ii], r = track.rights[ii];
    X.set(r[0], r[1], r[2]); Y.set(u[0], u[1], u[2]); Z.set(t[0], t[1], t[2]);
    M.makeBasis(X, Y, Z);
    M.setPosition(P.set(p[0] + u[0] * 0.4, p[1] + u[1] * 0.4, p[2] + u[2] * 0.4));
    arches.setMatrixAt(instanceIndex, M);
  });
  arches.instanceMatrix.needsUpdate = true;
  arches.frustumCulled = false;
  scene.add(arches);
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
      new THREE.Vector3(-r[0], -r[1], -r[2]),
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
const heliosDynamic = {
  station: null, ring: null, inner: null, ringEnergy: null,
  glow: null, halo: null, nodes: null, beacon: null, beam: null, panels: [],
  rackCores: [], claimRings: [], claimBanner: null, claimBannerCanvas: null,
  claimBannerContext: null, metal: null, white: null, coreMaterial: null,
};
{
  // Put the destination just before the finish seam: it stays behind the
  // launch camera, then becomes the final structure the player flies through.
  const idx = wrapI(START_IDX - Math.round(34 / STEP));
  const p = track.pts[idx], t = track.tangents[idx], r = track.rights[idx], u = track.ups[idx];
  const station = new THREE.Group();
  station.name = 'HELIOS_STATION';
  station.userData.trackFraction = idx / N;
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(-r[0], -r[1], -r[2]),
    new THREE.Vector3(u[0], u[1], u[2]),
    new THREE.Vector3(t[0], t[1], t[2]));
  station.quaternion.setFromRotationMatrix(basis);
  station.position.set(p[0] + u[0] * 28, p[1] + u[1] * 28, p[2] + u[2] * 28);
  heliosDynamic.station = station;
  const metal = new THREE.MeshStandardMaterial({
    color: 0x12191d, metalness: .92, roughness: .23,
    emissive: 0x163b52, emissiveIntensity: 1.05,
  });
  const white = new THREE.MeshStandardMaterial({
    color: 0xc9d4cf, metalness: .72, roughness: .22,
    emissive: 0x16231f, emissiveIntensity: .18,
  });
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xdfff47, fog: false });
  coreMat.color.multiplyScalar(1.15);
  heliosDynamic.metal = metal;
  heliosDynamic.white = white;
  heliosDynamic.coreMaterial = coreMat;
  const ringMetal = metal.clone();
  ringMetal.emissive.setHex(0x176486);
  ringMetal.emissiveIntensity = .35;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(42, 2.2, 14, 84), ringMetal);
  station.add(ring);
  heliosDynamic.ring = ring;
  const inner = new THREE.Mesh(new THREE.TorusGeometry(35.8, .48, 8, 84), coreMat);
  station.add(inner);
  heliosDynamic.inner = inner;
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(45.8, .18, 6, 96),
    new THREE.MeshBasicMaterial({
      color: 0x6cecff,
      transparent: true,
      opacity: .44,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    }),
  );
  station.add(halo);
  heliosDynamic.halo = halo;
  const ringEnergy = new THREE.Mesh(
    new THREE.TorusGeometry(42, .64, 8, 112),
    new THREE.MeshBasicMaterial({
      color: 0x6cecff,
      transparent: true,
      opacity: .54,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    }),
  );
  ringEnergy.material.color.multiplyScalar(1.05);
  station.add(ringEnergy);
  heliosDynamic.ringEnergy = ringEnergy;
  const nodeGeometry = new THREE.SphereGeometry(.78, 10, 7);
  const nodeMaterial = new THREE.MeshBasicMaterial({
    color: 0xdfff47,
    depthTest: true,
    depthWrite: false,
    fog: false,
  });
  nodeMaterial.color.multiplyScalar(1.35);
  const ringNodes = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, 20);
  const nodeMatrix = new THREE.Matrix4();
  for (let i = 0; i < 20; i++) {
    const a = i / 20 * Math.PI * 2;
    nodeMatrix.makeTranslation(Math.cos(a) * 42, Math.sin(a) * 42, 0);
    ringNodes.setMatrixAt(i, nodeMatrix);
  }
  ringNodes.instanceMatrix.needsUpdate = true;
  station.add(ringNodes);
  heliosDynamic.nodes = ringNodes;
  const stationGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex,
    color: 0x65dfff,
    transparent: true,
    opacity: .16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  }));
  stationGlow.scale.set(90, 90, 1);
  stationGlow.position.z = -3;
  station.add(stationGlow);
  heliosDynamic.glow = stationGlow;
  for (let i = 0; i < 8; i++) {
    // Keep the lower center of the HELIOS ring as a clean racing aperture.
    // Rack 6 would otherwise cancel the station's +28m lift and sit directly
    // on the deck, forcing the player and camera through luminous geometry.
    if (i === 6) continue;
    const a = (i / 8) * Math.PI * 2;
    const rack = new THREE.Mesh(new THREE.BoxGeometry(6.2, 15.5, 11.8), i % 2 ? metal : white);
    rack.name = `HELIOS_RACK_${i}`;
    rack.position.set(Math.cos(a) * 28, Math.sin(a) * 28, 4);
    rack.rotation.z = a + Math.PI / 2;
    station.add(rack);
    const core = new THREE.Mesh(new THREE.BoxGeometry(.38, 12.2, 12), coreMat);
    core.position.set(Math.cos(a) * 27.5, Math.sin(a) * 27.5, -1.8);
    core.rotation.z = a + Math.PI / 2;
    station.add(core);
    heliosDynamic.rackCores.push(core);
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
    heliosDynamic.panels.push(panel);
    for (let gx = -2; gx <= 2; gx++) {
      const grid = new THREE.Mesh(new THREE.BoxGeometry(.16, 24.2, .56), white);
      grid.position.set(side * 98 + gx * 8.2, 0, -.18);
      station.add(grid);
    }
  }
  const beacon = new THREE.PointLight(0xdfff47, 9, 220, 1.6);
  beacon.position.z = 5;
  station.add(beacon);
  heliosDynamic.beacon = beacon;
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(5.5, 115, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xdfff47,
      transparent: true,
      opacity: .075,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  beam.rotation.x = Math.PI / 2;
  beam.position.z = -54;
  station.add(beam);
  heliosDynamic.beam = beam;

  const claimCanvas = document.createElement('canvas');
  claimCanvas.width = 1024;
  claimCanvas.height = 192;
  const claimContext = claimCanvas.getContext('2d');
  const claimTexture = new THREE.CanvasTexture(claimCanvas);
  claimTexture.colorSpace = THREE.SRGBColorSpace;
  const claimBanner = new THREE.Mesh(
    new THREE.PlaneGeometry(38, 7.1),
    new THREE.MeshBasicMaterial({
      map: claimTexture,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );
  claimBanner.name = 'HELIOS_CLAIM_BANNER';
  claimBanner.position.set(0, 17.5, -5);
  claimBanner.rotation.y = Math.PI;
  claimBanner.renderOrder = 12;
  station.add(claimBanner);
  heliosDynamic.claimBanner = claimBanner;
  heliosDynamic.claimBannerCanvas = claimCanvas;
  heliosDynamic.claimBannerContext = claimContext;

  for (let i = 0; i < 3; i++) {
    const claimRing = new THREE.Mesh(
      new THREE.TorusGeometry(43.8, .085 + i * .022, 6, 96),
      new THREE.MeshBasicMaterial({
        color: 0xdfff47,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    claimRing.name = `HELIOS_CLAIM_WAVE_${i + 1}`;
    claimRing.position.z = -1.2 - i * .6;
    station.add(claimRing);
    heliosDynamic.claimRings.push(claimRing);
  }
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

function makeSmoothShipHull() {
  const stations = [
    [-2.38, .68, .26, .17], [-2.05, .93, .31, .24], [-1.42, 1.01, .35, .29],
    [-.62, 1.00, .39, .32], [.28, .92, .42, .31], [1.18, .76, .39, .25],
    [2.02, .54, .31, .18], [2.72, .18, .22, .09], [3.04, .035, .18, .035],
  ];
  const rings = renderProfile.name === 'BALANCED' ? 8 : 14;
  const positions = [], indices = [];
  for (let s = 0; s < stations.length; s++) {
    const [z, width, centerY, height] = stations[s];
    for (let j = 0; j < rings; j++) {
      const angle = j / rings * Math.PI * 2;
      let y = centerY + Math.sin(angle) * height;
      if (y < .13) y += (.13 - y) * .78;
      const shoulder = 1 - .08 * Math.max(0, Math.sin(angle));
      positions.push(Math.cos(angle) * width * shoulder, y, z);
    }
  }
  for (let s = 0; s < stations.length - 1; s++) for (let j = 0; j < rings; j++) {
    const a = s * rings + j, b = s * rings + (j + 1) % rings;
    const c = (s + 1) * rings + j, d = (s + 1) * rings + (j + 1) % rings;
    indices.push(a, b, c, b, d, c);
  }
  for (let j = 1; j < rings - 1; j++) {
    indices.push(0, j + 1, j);
    const front = (stations.length - 1) * rings;
    indices.push(front, front + j, front + j + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function mergeGeometryParts(parts) {
  const positions = [], normals = [], indices = [];
  let vertexOffset = 0;
  const transform = new THREE.Matrix4();
  const partPosition = new THREE.Vector3();
  const partQuaternion = new THREE.Quaternion();
  const partScale = new THREE.Vector3();
  const euler = new THREE.Euler();
  for (const part of parts) {
    const geometry = part.geometry.clone();
    const p = part.position || [0, 0, 0];
    const r = part.rotation || [0, 0, 0];
    const s = part.scale || [1, 1, 1];
    partPosition.set(p[0], p[1], p[2]);
    partQuaternion.setFromEuler(euler.set(r[0], r[1], r[2]));
    partScale.set(s[0], s[1], s[2]);
    transform.compose(partPosition, partQuaternion, partScale);
    geometry.applyMatrix4(transform);
    const positionAttribute = geometry.getAttribute('position');
    const normalAttribute = geometry.getAttribute('normal');
    for (let i = 0; i < positionAttribute.count; i++) {
      positions.push(positionAttribute.getX(i), positionAttribute.getY(i), positionAttribute.getZ(i));
      normals.push(normalAttribute.getX(i), normalAttribute.getY(i), normalAttribute.getZ(i));
    }
    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) indices.push(vertexOffset + geometry.index.getX(i));
    } else {
      for (let i = 0; i < positionAttribute.count; i++) indices.push(vertexOffset + i);
    }
    vertexOffset += positionAttribute.count;
    geometry.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setIndex(indices);
  merged.computeBoundingSphere();
  return merged;
}

const SHIP_GEOMETRY = (() => {
  const hull = makeSmoothShipHull();
  const pod = makeTaperedBox(.54, .34, .38, 2.75, -.06);
  const fin = makeTaperedBox(.13, .04, .82, 1.2, -.55);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const nozzle = new THREE.CylinderGeometry(.3, .22, .32, renderProfile.name === 'BALANCED' ? 10 : 18, 1, true);
  const engine = new THREE.CylinderGeometry(.2, .13, .23, renderProfile.name === 'BALANCED' ? 10 : 18);
  const paint = mergeGeometryParts([
    { geometry: hull },
    { geometry: pod, position: [-1.18, .03, -.62] },
    { geometry: pod, position: [1.18, .03, -.62] },
  ]);
  const dark = mergeGeometryParts([
    { geometry: fin, position: [0, .38, -1.64] },
    { geometry: fin, position: [-1.18, .17, -1.38], scale: [.72, .7, .82] },
    { geometry: fin, position: [1.18, .17, -1.38], scale: [.72, .7, .82] },
    { geometry: box, position: [-.72, .18, -.42], rotation: [0, 0, -.08], scale: [1.05, .075, 1.42] },
    { geometry: box, position: [.72, .18, -.42], rotation: [0, 0, .08], scale: [1.05, .075, 1.42] },
    { geometry: box, position: [0, .09, 1.65], scale: [.18, .12, 1.55] },
    { geometry: nozzle, position: [-.34, .28, -2.34], rotation: [Math.PI / 2, 0, 0] },
    { geometry: nozzle, position: [.34, .28, -2.34], rotation: [Math.PI / 2, 0, 0] },
    { geometry: nozzle, position: [-1.18, .19, -2.02], rotation: [Math.PI / 2, 0, 0], scale: [.72, .72, .72] },
    { geometry: nozzle, position: [1.18, .19, -2.02], rotation: [Math.PI / 2, 0, 0], scale: [.72, .72, .72] },
  ]);
  const trim = mergeGeometryParts([
    { geometry: box, position: [-.82, .4, .05], scale: [.045, .055, 3.62] },
    { geometry: box, position: [.82, .4, .05], scale: [.045, .055, 3.62] },
    { geometry: box, position: [-1.43, .24, -.62], scale: [.055, .055, 2.42] },
    { geometry: box, position: [1.43, .24, -.62], scale: [.055, .055, 2.42] },
    { geometry: box, position: [0, .73, -.4], scale: [.045, .04, 1.9] },
  ]);
  const engines = mergeGeometryParts([
    { geometry: engine, position: [-.34, .28, -2.45], rotation: [Math.PI / 2, 0, 0] },
    { geometry: engine, position: [.34, .28, -2.45], rotation: [Math.PI / 2, 0, 0] },
    { geometry: engine, position: [-1.18, .19, -2.14], rotation: [Math.PI / 2, 0, 0], scale: [.7, .7, .7] },
    { geometry: engine, position: [1.18, .19, -2.14], rotation: [Math.PI / 2, 0, 0], scale: [.7, .7, .7] },
  ]);
  const canopy = makeTaperedBox(.78, .36, .39, 1.55, -.34);
  hull.dispose(); pod.dispose(); fin.dispose(); box.dispose(); nozzle.dispose(); engine.dispose();
  return { paint, dark, trim, engines, canopy };
})();

const sharedShipDark = new THREE.MeshStandardMaterial({
  color: 0x090d15,
  roughness: .39,
  metalness: .78,
  envMapIntensity: 1.4,
});
const sharedShipGlass = renderProfile.name === 'BALANCED'
  ? new THREE.MeshStandardMaterial({ color: 0x3d6d96, roughness: .17, metalness: .55 })
  : new THREE.MeshPhysicalMaterial({
      color: 0x72bfff,
      roughness: .045,
      metalness: .26,
      transparent: true,
      opacity: .7,
      clearcoat: 1,
      clearcoatRoughness: .025,
      envMapIntensity: 2.35,
    });

function paintDriverBadge(badge, profile) {
  if (!badge) return;
  const { canvas, context, texture } = badge;
  const accent = `#${profile.accent.toString(16).padStart(6, '0')}`;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(3, 8, 13, .94)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = accent;
  context.lineWidth = 8;
  context.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
  context.fillStyle = accent;
  context.font = '900 80px Arial Narrow, Arial, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(profile.monogram, 24, 86);
  context.fillStyle = '#f4f7f5';
  context.font = '900 30px Arial Narrow, Arial, sans-serif';
  context.fillText(profile.callsign, 158, 66);
  context.fillStyle = 'rgba(244,247,245,.62)';
  context.font = '800 18px Arial Narrow, Arial, sans-serif';
  context.fillText('OPENAI RACE DIVISION', 158, 105);
  texture.needsUpdate = true;
}

function makeDriverBadge(profile) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 144;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.72, .48), material);
  mesh.name = 'PLAYER_DRIVER_BADGE';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, .792, -.58);
  const badge = { canvas, context, texture, mesh };
  paintDriverBadge(badge, profile);
  return badge;
}

function makeShip(spec) {
  const g = new THREE.Group();
  const lean = new THREE.Group();
  g.add(lean);
  const paint = renderProfile.name === 'BALANCED'
    ? new THREE.MeshStandardMaterial({
        color: spec.color, roughness: .28, metalness: .62, envMapIntensity: 1.45,
        emissive: spec.threshold ? 0x320019 : 0x000000,
        emissiveIntensity: spec.threshold ? .52 : 0,
      })
    : new THREE.MeshPhysicalMaterial({
        color: spec.color, roughness: .19, metalness: .58,
        clearcoat: 1, clearcoatRoughness: .075, envMapIntensity: 2.45,
        emissive: spec.threshold ? 0x320019 : 0x000000,
        emissiveIntensity: spec.threshold ? .7 : 0,
      });
  const trim = new THREE.MeshBasicMaterial({ color: spec.trimColor || spec.color, fog: false });
  trim.color.multiplyScalar(1.55);
  const engineMat = new THREE.MeshBasicMaterial({ color: 0xbfe9ff, fog: false });
  engineMat.color.multiplyScalar(1.18);

  const hull = new THREE.Mesh(SHIP_GEOMETRY.paint, paint);
  const dark = new THREE.Mesh(SHIP_GEOMETRY.dark, sharedShipDark);
  const trimMesh = new THREE.Mesh(SHIP_GEOMETRY.trim, trim);
  const enginesMesh = new THREE.Mesh(SHIP_GEOMETRY.engines, engineMat);
  const canopy = new THREE.Mesh(SHIP_GEOMETRY.canopy, sharedShipGlass);
  canopy.position.set(0, .39, .36);
  // Small silhouette changes keep a pack of twelve from reading as clones.
  const style = ROSTER.indexOf(spec) % 4;
  const widthScale = spec.player ? .96 : [1.02, .94, 1.08, .98][style];
  hull.scale.x = widthScale;
  dark.scale.x = widthScale;
  trimMesh.scale.x = widthScale;
  enginesMesh.scale.x = widthScale;
  if (style === 1) { hull.scale.z = 1.06; trimMesh.scale.z = 1.06; }
  if (style === 2) { dark.scale.x *= 1.08; canopy.scale.set(.9, .92, .88); }
  if (style === 3) canopy.position.z -= .16;
  lean.add(hull, dark, trimMesh, enginesMesh, canopy);
  if (spec.threshold) {
    const thresholdHalo = new THREE.Mesh(
      new THREE.TorusGeometry(1.42, .045, 7, 36),
      new THREE.MeshBasicMaterial({
        color: spec.trimColor,
        transparent: true,
        opacity: .82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    thresholdHalo.name = 'AIIT_THRESHOLD_HALO';
    thresholdHalo.rotation.x = Math.PI / 2;
    thresholdHalo.position.set(0, .62, -.18);
    thresholdHalo.scale.z = 1.7;
    lean.add(thresholdHalo);
  }
  const engines = [engineMat];

  // underglow (team color pool on the deck)
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 6.2), new THREE.MeshBasicMaterial({
    map: glowTex, color: spec.color, transparent: true, opacity: 0.24,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = -0.52;
  g.add(pool);
  // dark contact oval (grounds the ship visually)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.4), new THREE.MeshBasicMaterial({
    map: glowTex, color: 0x000000, transparent: true,
    opacity: renderProfile.shadows ? .2 : .4, depthWrite: false,
  }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = -0.5;
  g.add(blob);

  if (!spec.player && renderProfile.name !== 'BALANCED') {
    const cv = document.createElement('canvas'); cv.width = spec.threshold ? 512 : 256; cv.height = 64;
    const c2 = cv.getContext('2d');
    c2.font = `bold ${spec.threshold ? 40 : 42}px system-ui, sans-serif`;
    c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillStyle = '#000'; c2.globalAlpha = 0.45; c2.fillRect(0, 0, cv.width, 64); c2.globalAlpha = 1;
    c2.fillStyle = '#' + (spec.trimColor || spec.color).toString(16).padStart(6, '0');
    c2.fillText(spec.name, cv.width / 2, 34);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), depthTest: true, transparent: true,
    }));
    spr.scale.set(spec.threshold ? 5.8 : Math.min(4.7, Math.max(3.35, spec.name.length * .46)), .78, 1);
    spr.position.y = 1.72;
    g.add(spr);
    return { group: g, lean, engines, plate: spr, shieldMat: null };
  }
  if (!spec.player) return { group: g, lean, engines, plate: null, shieldMat: null };
  const driverBadge = makeDriverBadge(activeDriver());
  lean.add(driverBadge.mesh);
  const driverAccentMat = new THREE.MeshBasicMaterial({
    color: activeDriver().accent,
    transparent: true,
    opacity: .78,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const driverHalo = new THREE.Mesh(
    new THREE.TorusGeometry(.55, .035, 8, 28),
    driverAccentMat,
  );
  driverHalo.name = 'PLAYER_DRIVER_HALO';
  driverHalo.rotation.x = Math.PI / 2;
  driverHalo.position.set(0, .8, .28);
  lean.add(driverHalo);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: activeDriver().accent,
    wireframe: true,
    transparent: true,
    opacity: .055,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const shield = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), shieldMat);
  shield.scale.set(1.82, .72, 3.28);
  shield.position.y = .28;
  lean.add(shield);
  return {
    group: g,
    lean,
    engines,
    plate: null,
    shieldMat,
    driverBadge,
    driverAccentMat,
  };
}

function makeGhostShip() {
  const group = new THREE.Group();
  group.name = 'MODEL_N_MINUS_1_GHOST';
  const lean = new THREE.Group();
  group.add(lean);
  const bodyMaterial = new THREE.MeshBasicMaterial({
    color: 0x6cecff,
    transparent: true,
    opacity: .115,
    wireframe: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const signalMaterial = new THREE.MeshBasicMaterial({
    color: 0xdfff47,
    transparent: true,
    opacity: .48,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const glassMaterial = new THREE.MeshBasicMaterial({
    color: 0x9fefff,
    transparent: true,
    opacity: .16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const hull = new THREE.Mesh(SHIP_GEOMETRY.paint, bodyMaterial);
  const dark = new THREE.Mesh(SHIP_GEOMETRY.dark, bodyMaterial);
  const trim = new THREE.Mesh(SHIP_GEOMETRY.trim, signalMaterial);
  const engines = new THREE.Mesh(SHIP_GEOMETRY.engines, signalMaterial);
  const canopy = new THREE.Mesh(SHIP_GEOMETRY.canopy, glassMaterial);
  canopy.position.set(0, .39, .36);
  lean.add(hull, dark, trim, engines, canopy);
  const echoA = new THREE.Mesh(
    new THREE.TorusGeometry(1.62, .025, 6, 32),
    signalMaterial,
  );
  echoA.rotation.x = Math.PI / 2;
  echoA.position.y = .2;
  group.add(echoA);
  const echoB = echoA.clone();
  echoB.scale.setScalar(1.32);
  echoB.material = signalMaterial;
  echoB.position.z = -.3;
  group.add(echoB);
  group.visible = false;
  group.renderOrder = 4;
  group.traverse(object => {
    if (object.isMesh) {
      object.frustumCulled = false;
      object.renderOrder = 4;
    }
  });
  return { group, lean, echoA, echoB, materials: [bodyMaterial, signalMaterial, glassMaterial] };
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
    boostLockout: 0, damageCooldown: 0, cleanRun: true,
    drafting: false, draftCharge: 0, draftStrength: 0, draftTarget: null,
    slingshotReady: false, slingshotReadySerial: 0,
    slingshotT: 0, slingshotCooldown: 0, slingshotSerial: 0, slingshots: 0,
    boostWasDown: false, surgeRequest: false, packets: 0,
    progress: -deltaS(s, startS) * -1 - 0, // set below
    lap: 0, cps: [false, false],
    lapStart: 0, lapTimes: [], best: Infinity, finished: false, finishTime: 0,
    wrongWay: 0, stuck: 0, hitWall: false, wallSide: 0, impactSerial: 0,
    wx: 0, wy: 0, wz: 0, roll: 0, pitch: 0, prevVF: 0, latA: 0, bobPhase: raceRng() * 6.28,
    aiBias: (spec.lane ?? 0) + (raceRng() - 0.5) * 0.8,
    aiBoostT: 0,
  };
}

const raceTune = () => activeDifficulty();
// Protocol difficulty changes rival pace and attack cadence. Rival durability
// stays on one Pro integrity baseline so harsher player assists do not make
// Apex opponents crash more often and accidentally become easier.
const integrityTune = c => c.spec.player ? activeDifficulty() : DIFFICULTY_PRESETS.pro;

function draftInfo(c) {
  if (c.finished || Math.hypot(c.vA, c.vL) < 29) return null;
  let best = null;
  for (const other of ships) {
    if (other === c || other.finished) continue;
    const ahead = deltaS(c.s, other.s);
    const lateral = Math.abs(c.lat - other.lat);
    if (ahead <= 3.2 || ahead >= 31 || lateral >= 3.4) continue;
    const alignment = 1 - lateral / 3.4;
    const proximity = 1 - (ahead - 3.2) / 27.8;
    const strength = THREE.MathUtils.clamp(alignment * .76 + proximity * .24, .12, 1);
    if (!best || strength > best.strength || (strength === best.strength && ahead < best.gap)) {
      best = { target: other, gap: ahead, strength };
    }
  }
  return best;
}

function armSlingshot(c) {
  if (c.slingshotReady) return false;
  c.draftCharge = 1;
  c.slingshotReady = true;
  c.slingshotReadySerial++;
  return true;
}

function fireSlingshot(c) {
  const tune = raceTune();
  if (!c.slingshotReady || c.slingshotCooldown > 0 ||
      (!c.spec.player && c.slingshots >= tune.aiSlingshotLimit) ||
      c.limp || c.hitWall || c.boostLockout > 0 ||
      c.boost < SLINGSHOT_COST) return false;
  c.boost = Math.max(0, c.boost - SLINGSHOT_COST);
  c.boosting = true;
  c.slingshotReady = false;
  c.draftCharge = 0;
  c.slingshotT = SLINGSHOT_DURATION;
  c.slingshotSerial++;
  c.slingshots++;
  c.slingshotCooldown = tune.slingshotCooldown;
  c.surgeRequest = false;
  if (c.spec.player) {
    triggerMoment('slingshot', { text: 'SLINGSHOT DEPLOYED' });
    momentTone('slingshot');
    haptic(14);
  }
  return true;
}

function disruptShip(c, severity = 1, options = {}) {
  const tune = integrityTune(c);
  const hit = THREE.MathUtils.clamp(severity, .45, 1.45);
  c.boosting = false;
  c.slingshotT = 0;
  c.slingshotReady = false;
  c.draftCharge *= .22;
  c.boostLockout = Math.max(c.boostLockout, tune.impactLockout * hit);
  c.damageCooldown = Math.max(c.damageCooldown, tune.damageCooldown);
  c.boost = Math.max(0, c.boost - tune.boostSpill * hit);
  const speedLossScale = options.speedLossScale ?? 1;
  c.vA *= Math.max(.7, 1 - tune.impactSpeedLoss * hit * speedLossScale);
  c.vL *= .72;
  c.cleanRun = false;
  if (c.spec.player) c.impactSerial++;
}

function stepShip(c, raceTime, freeze) {
  if (c.finished) {
    c.boosting = false;
    c.slingshotT = 0;
    c.slingshotReady = false;
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
    c.boostLockout = Math.max(0, c.boostLockout - DT);
    c.damageCooldown = Math.max(0, c.damageCooldown - DT);
    c.slingshotT = Math.max(0, c.slingshotT - DT);
    c.slingshotCooldown = Math.max(0, c.slingshotCooldown - DT);

    const wake = c.slingshotT > 0 ? null : draftInfo(c);
    c.drafting = Boolean(wake);
    c.draftTarget = wake?.target || null;
    c.draftStrength = wake?.strength || 0;
    const canEarnSlingshot = c.spec.player || c.slingshots < raceTune().aiSlingshotLimit;
    if (!canEarnSlingshot) {
      c.slingshotReady = false;
      c.draftCharge = 0;
    } else if (!c.slingshotReady && c.slingshotT <= 0 && c.slingshotCooldown <= 0) {
      if (wake) {
        const wakeRate = raceTune().wakeRate;
        c.draftCharge = Math.min(1, c.draftCharge + (.62 + wake.strength * .31) * wakeRate * DT);
      } else {
        c.draftCharge = Math.max(0, c.draftCharge - .34 * DT);
      }
      if (c.draftCharge >= 1) armSlingshot(c);
    } else if (c.slingshotReady) {
      c.draftCharge = 1;
    }

    const boostDown = c.boostIn > .5;
    const boostPressed = boostDown && !c.boostWasDown;
    if (c.slingshotReady && (c.spec.player ? boostPressed : c.surgeRequest)) fireSlingshot(c);
    c.boostWasDown = boostDown;
    c.surgeRequest = false;
    const slingshotActive = c.slingshotT > 0;
    const canBoost = !c.limp && !c.hitWall && c.boostLockout <= 0 && !c.finished;
    c.boosting = canBoost && (slingshotActive || (boostDown && c.boost > .5));

    // steering: rate-limited, speed-tapered; +1 = LEFT = psi decreases
    const target = c.steerIn / (1 + (spd / 34) ** 2 * 0.7);
    c.steer += THREE.MathUtils.clamp(target - c.steer, -6 * DT, 6 * DT);
    const yawAuth = (2.6 - Math.min(spd, 78) * 0.012) * (1 + c.airbrake * 0.75);
    c.psi += -c.steer * yawAuth * DT;
    c.psi = THREE.MathUtils.clamp(c.psi, -1.15, 1.15);
    if (c.spec.player && !c.airbrake && activeDifficulty().edgeAssist > 0) {
      const engage = THREE.MathUtils.clamp(
        (Math.abs(c.lat) - EDGE * .66) / (EDGE * .26),
        0,
        1,
      );
      if (engage > 0) {
        const desiredPsi = -Math.sign(c.lat) * (.16 + .24 * engage);
        const maxCorrection = activeDifficulty().edgeAssist * engage * DT;
        c.psi += THREE.MathUtils.clamp(desiredPsi - c.psi, -maxCorrection, maxCorrection);
      }
    }

    // decompose into ship frame
    const cosP = Math.cos(c.psi), sinP = Math.sin(c.psi);
    let vF = c.vA * cosP + c.vL * sinP;
    let vR = -c.vA * sinP + c.vL * cosP;

    // thrust / brake
    const vmaxMul = slingshotActive
      ? SLINGSHOT_VMAX_MUL
      : (c.boosting ? BOOST_VMAX_MUL : 1);
    const vmax = c.spec.vmax * vmaxMul * (c.limp ? 0.78 : 1);
    if (c.throttle > 0) vF += c.throttle * ACCEL * Math.max(0, 1 - vF / vmax) * DT * (c.limp ? 0.72 : 1);
    if (c.boosting) vF += BOOST_ACCEL * Math.max(0, 1 - vF / vmax) * DT;
    if (slingshotActive && c.boosting) {
      vF += SLINGSHOT_ACCEL * Math.max(0, 1 - vF / vmax) * DT;
    }
    if (c.brake > 0) { vF -= BRAKE * c.brake * DT; if (vF < 0) vF = 0; }
    const aero = c.drafting ? 0.58 : 1;
    vF -= (0.3 + 0.0019 * vF * Math.abs(vF) * aero) * Math.sign(vF) * DT * (c.throttle > 0 ? 0.3 : 0.85);
    // lateral grip (airbrake drops it = drift)
    const grip = (c.airbrake > 0 ? GRIP_DRIFT : GRIP) *
      (c.spec.player && !c.airbrake ? activeDifficulty().playerGrip : 1) *
      // Rivals keep a fixed burst-grip baseline; protocol difficulty changes
      // their pace and attack opportunities rather than destabilizing steering.
      (c.boosting && !c.airbrake ? (c.spec.player ? activeDifficulty().boostGrip : .94) : 1) *
      (slingshotActive && !c.airbrake ? .92 : 1);
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

    // Ordinary burst drains continuously. A slingshot pays its energy on
    // deployment, so its short attack envelope cannot die halfway through.
    if (c.boosting && !slingshotActive) {
      const drain = c.spec.player ? activeDifficulty().boostDrain : 1;
      c.boost = Math.max(0, c.boost - BOOST_DRAIN * drain * DT);
    }
    // pads
    c.padGlow = Math.max(0, c.padGlow - DT * 2);
    for (const pad of PADS) {
      const ps = pad.f * L;
      const d = deltaS(ps, c.s);
      if (d > 0 && d < pad.len && (c._padCd ?? 0) <= 0) {
        const charge = c.spec.player ? activeDifficulty().padCharge : 1;
        c.boost = Math.min(100, c.boost + PAD_CHARGE * charge);
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
          if (!c.slingshotReady && c.slingshotT <= 0 && c.slingshotCooldown <= 0) {
            c.draftCharge = Math.min(1, c.draftCharge + .28);
            if (c.draftCharge >= 1) armSlingshot(c);
          }
          c.padGlow = 1.3;
          padPing();
        }
      }
    }
    // shield: recharge strip + passive regen
    const rs = RECHARGE.f * L;
    const rd = deltaS(rs, c.s);
    const onRecharge = rd > 0 && rd < RECHARGE.len;
    const tune = integrityTune(c);
    const rechargeRate = onRecharge
      ? tune.rechargeRate
      : (c.damageCooldown > 0 ? 0 : tune.passiveRegen);
    c.shield = Math.min(SHIELD_MAX, c.shield + rechargeRate * DT);
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
    const enteredWall = !c.hitWall;
    const sgn = c.lat > 0 ? 1 : -1;
    c.lat = EDGE * sgn;
    const vOut = c.vL * sgn;
    if (vOut > 0) {
      c.vL = -c.vL * 0.12; // small bounce-in
      if (!freeze) {
        const damage = c.spec.player ? activeDifficulty().wallDamage : 1;
        c.shield = Math.max(0, c.shield - vOut * 2.6 * damage);
        if (c.shield <= 0) c.limp = true;
      }
    }
    if (!freeze) {
      const damage = c.spec.player ? activeDifficulty().wallDamage : 1;
      c.shield = Math.max(0, c.shield - 11 * DT * damage); // scrape
    }
    if (c.shield <= 0) c.limp = true;
    if (!freeze && enteredWall && (vOut > .6 || spd > 18)) {
      const highSpeed = Math.max(0, spd - 42) / 65;
      disruptShip(c, .68 + Math.min(1.35, Math.max(Math.max(vOut, 0) / 10, highSpeed)));
    }
    c.boostLockout = Math.max(c.boostLockout, .18);
    // deflect the nose along the track while touching: ships GLANCE off walls
    c.psi += THREE.MathUtils.clamp(-c.psi, -1, 1) * 3.0 * DT;
    c.vA *= 0.992;
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
        if (c.finishOrder === 1) startHeliosClaim(c);
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
          const damageA = a.spec.player ? activeDifficulty().collisionDamage : 1;
          const damageB = b.spec.player ? activeDifficulty().collisionDamage : 1;
          a.shield = Math.max(0, a.shield - dmg * damageA);
          b.shield = Math.max(0, b.shield - dmg * damageB);
          if (a.shield <= 0) a.limp = true;
          if (b.shield <= 0) b.limp = true;
          const severity = THREE.MathUtils.clamp((-vn - 1.5) / 8, .5, 1.35);
          disruptShip(a, severity, { speedLossScale: .34 });
          disruptShip(b, severity, { speedLossScale: .34 });
        }
      }
    }
  }
}

// ---------- AI ----------
function aiDrive(c, playerProgress) {
  if (c.stuck > 2.5) { respawn(c); return; }
  const tune = c.spec.player ? DIFFICULTY_PRESETS.pro : activeDifficulty();
  const spd = Math.hypot(c.vA, c.vL);
  // aim point: cut toward the inside of the upcoming corner
  const look = THREE.MathUtils.clamp(9 + spd * 0.5 * c.spec.look, 12, 46);
  const kA = signedCurveAhead(c.s, look + 12);
  const apex = THREE.MathUtils.clamp(Math.sign(kA) * Math.min(Math.abs(kA) * 700, 4.2), -4.4, 4.4);
  let passNudge = 0;
  let nearestTraffic = Infinity;
  for (const other of ships) {
    if (other === c || other.finished) continue;
    const ahead = deltaS(c.s, other.s);
    if (ahead <= 3 || ahead >= tune.passLook || ahead >= nearestTraffic) continue;
    if (Math.abs(c.lat - other.lat) >= 3.4) continue;
    nearestTraffic = ahead;
    const side = c.lat <= other.lat ? -1 : 1;
    passNudge = side * tune.passOffset * (1 - ahead / tune.passLook);
  }
  // k>0 = left turn, apex on the left = -lat... but sign(kA)*(-1)? Left turn inside is -lat:
  const targetLat = THREE.MathUtils.clamp(
    -apex + c.aiBias + passNudge,
    -EDGE + 1.1,
    EDGE - 1.1,
  );
  const psiDes = Math.atan2(targetLat - c.lat, look);
  c.steerIn = THREE.MathUtils.clamp((c.psi - psiDes) * 3.0, -1, 1);

  // corner-speed preview (banking raises the effective limit — the AI knows)
  const band = THREE.MathUtils.clamp(
    (playerProgress - c.progress) / 450,
    tune.bandMin,
    tune.bandMax,
  );
  let vT = c.spec.vmax * tune.pace * (1 + band);
  const iNow = Math.round(wrapS(c.s) / STEP);
  const nAhead = Math.ceil(THREE.MathUtils.clamp(14 + spd * 1.6, 30, 110) / STEP);
  for (let j = 0; j <= nAhead; j += 3) {
    const ii = wrapI(iNow + j);
    const kk = Math.abs(track.curvature[ii]);
    if (kk < 1e-4) continue;
    const assist = Math.max(0, -Math.sign(track.curvature[ii]) * Math.sin(track.bank[ii])) * GRAV;
    const vCorner = Math.sqrt(
      (c.spec.latG * 0.86 * (c.spec.risk ?? 1) * tune.corner + assist) / kk,
    );
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
  const attackStraight = curveAhead(c.s, 48) < 0.0075;
  const lateAttack = (c.lapProgress ?? c.progress) > L * .72;
  const wakeGap = c.draftTarget ? deltaS(c.s, c.draftTarget.s) : Infinity;
  c.surgeRequest = Boolean(
    c.slingshotReady &&
    c.boost >= SLINGSHOT_COST &&
    c.boostLockout <= 0 &&
    !c.limp &&
    (attackStraight || lateAttack) &&
    wakeGap > 3 &&
    wakeGap < 34
  );
  if (c.surgeRequest) c.aiBoostT = Math.max(c.aiBoostT, .72);
  const burstAt = Math.max(
    20,
    (c.spec.burstAt ?? 55) + tune.burstOffset - (band > 0 ? 10 : 0),
  );
  if (c.aiBoostT <= 0 && straight && c.boost > burstAt) {
    c.aiBoostT = (0.8 + (c.spec.risk ?? 1) * 0.45) * tune.boostDuration;
  }
  c.boostIn = c.aiBoostT > 0 ? 1 : 0;
}

function respawn(c) {
  c.lat = 0; c.psi = 0; c.vA = 0; c.vL = 0; c.steer = 0; c.stuck = 0;
  c.boosting = false; c.slingshotT = 0; c.slingshotReady = false;
  c.draftCharge = 0; c.boostLockout = Math.max(c.boostLockout, .5);
}

// ---------- race state ----------
const state = {
  phase: 'menu', raceTime: 0, countdown: 0, goTimer: 0,
  muted: false, cameraMode: 0, cameraLabelT: 0, autopilot: false,
  finishDelay: -1, countdownBeat: null,
  difficulty: setupSelection.difficulty,
  driver: setupSelection.driver,
  contract: setupSelection.contract,
  runSeed: selectedRunSeed(),
};
let raceControl = null;

const showdown = {
  active: false,
  elapsed: 0,
  stage: 'idle',
  winner: null,
  winnerColor: 0x6cecff,
  rank: null,
  margin: null,
  stationClaimed: false,
  beamActive: false,
  bannerPaintedFor: null,
};

function paintHeliosClaimBanner(winnerName, accent) {
  if (!heliosDynamic.claimBannerContext || showdown.bannerPaintedFor === winnerName) return;
  showdown.bannerPaintedFor = winnerName;
  const context = heliosDynamic.claimBannerContext;
  const canvas = heliosDynamic.claimBannerCanvas;
  const accentCss = `#${accent.toString(16).padStart(6, '0')}`;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(2, 7, 12, .96)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = accentCss;
  context.fillRect(0, 0, 18, canvas.height);
  context.strokeStyle = accentCss;
  context.lineWidth = 6;
  context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  context.fillStyle = 'rgba(244,247,245,.62)';
  context.font = '900 30px Arial Narrow, Arial, sans-serif';
  context.letterSpacing = '8px';
  context.fillText('HELIOS ORBITAL COMPUTE', 58, 56);
  context.fillStyle = '#f4f7f5';
  context.font = '900 66px Arial Narrow, Arial, sans-serif';
  context.fillText(`${winnerName} // ARRAY CLAIMED`, 58, 132);
  heliosDynamic.claimBanner.material.map.needsUpdate = true;
}

function startHeliosClaim(winner) {
  if (!winner || showdown.active) return false;
  showdown.active = true;
  showdown.elapsed = 0;
  showdown.stage = 'handshake';
  showdown.winner = winner.spec?.name || winner.name || 'UNKNOWN';
  showdown.winnerColor = winner.spec?.color ?? winner.color ?? 0x6cecff;
  showdown.rank = winner === player ? 1 : ranking().indexOf(player) + 1;
  showdown.margin = null;
  showdown.stationClaimed = false;
  showdown.beamActive = false;
  showdown.bannerPaintedFor = null;
  paintHeliosClaimBanner(showdown.winner, showdown.winnerColor);
  return true;
}

function updateShowdownMargin() {
  if (!showdown.active || showdown.margin !== null) return;
  const order = ranking();
  if (!order[0]?.finished || !order[1]?.finished) return;
  showdown.margin = Math.max(0, order[1].finishTime - order[0].finishTime);
}

function advanceShowdown(dt) {
  if (!showdown.active || dt <= 0) return;
  showdown.elapsed += dt;
  showdown.stationClaimed = showdown.elapsed >= 2.15;
  showdown.beamActive = showdown.elapsed >= 3.45;
  showdown.stage = showdown.elapsed < .45
    ? 'handshake'
    : showdown.elapsed < 2.15
      ? 'cascade'
      : showdown.elapsed < 3.45
        ? 'claimed'
        : showdown.elapsed < 5.4
          ? 'beam'
          : showdown.elapsed < 7.6
            ? 'hero'
            : 'complete';
  updateShowdownMargin();
}

const ships = ROSTER.map((spec, i) => {
  const st = newShipState(spec, i);
  const built = makeShip(spec);
  st.mesh = built.group; st.lean = built.lean; st.engines = built.engines; st.plate = built.plate;
  st.shieldMat = built.shieldMat;
  st.driverBadge = built.driverBadge || null;
  st.driverAccentMat = built.driverAccentMat || null;
  st.shadowMeshes = [];
  built.group.traverse(object => {
    const material = object.material;
    if (!object.isMesh || !material || material.transparent ||
        (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial)) return;
    object.castShadow = false;
    st.shadowMeshes.push(object);
  });
  st.trail = makeTrail(spec);
  scene.add(st.mesh);
  return st;
});
const player = ships.find(c => c.spec.player);
const ghostVisual = makeGhostShip();
scene.add(ghostVisual.group);
let activeGhost = null;
let currentGhostDelta = null;
let ghostRecorder = null;
let lastResult = null;

const ghostRound = (value, precision = 3) => {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
};

function ghostForSelection() {
  if (showcaseMode) return null;
  const candidate = raceGhosts[recordKey()];
  if (!candidate || candidate.version !== 1 || candidate.seed !== selectedRunSeed() ||
      !Array.isArray(candidate.samples) || candidate.samples.length < 2) return null;
  return candidate;
}

function startGhostRecording() {
  activeGhost = ghostForSelection();
  currentGhostDelta = null;
  ghostRecorder = {
    seed: state.runSeed,
    key: recordKey(),
    nextSample: 0,
    samples: [],
    boundaries: [0, null, null, null, null, null, null],
    lastProgress: player.lapProgress ?? player.progress,
    finished: false,
  };
  ghostVisual.group.visible = Boolean(activeGhost);
}

function recordGhostFrame(force = false) {
  if (!ghostRecorder || state.phase !== 'race') return;
  const time = Math.max(0, state.raceTime);
  const progress = Math.max(
    ghostRecorder.lastProgress,
    THREE.MathUtils.clamp(player.lapProgress ?? player.progress, 0, L),
  );
  ghostRecorder.lastProgress = progress;
  for (let i = 1; i < SECTORS.length; i++) {
    if (ghostRecorder.boundaries[i] === null && progress >= SECTORS[i].f * L) {
      ghostRecorder.boundaries[i] = ghostRound(time);
    }
  }
  if (force || time + 1e-6 >= ghostRecorder.nextSample) {
    ghostRecorder.samples.push([
      ghostRound(time),
      ghostRound(progress, 2),
      ghostRound(player.lat),
      ghostRound(player.psi),
    ]);
    ghostRecorder.nextSample = time + .1;
  }
  if (player.finished && !ghostRecorder.finished) {
    ghostRecorder.finished = true;
    ghostRecorder.boundaries[6] = ghostRound(player.finishTime);
    const last = ghostRecorder.samples[ghostRecorder.samples.length - 1];
    if (!last || Math.abs(last[0] - player.finishTime) > .001) {
      ghostRecorder.samples.push([
        ghostRound(player.finishTime),
        ghostRound(L, 2),
        ghostRound(player.lat),
        ghostRound(player.psi),
      ]);
    }
  }
}

function ghostTimeAtProgress(ghost, progress) {
  const samples = ghost?.samples;
  if (!samples?.length) return null;
  if (progress <= samples[0][1]) return samples[0][0];
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid][1] < progress) low = mid + 1;
    else high = mid;
  }
  const next = samples[low];
  const previous = samples[Math.max(0, low - 1)];
  const span = next[1] - previous[1];
  const mix = span > .001 ? THREE.MathUtils.clamp((progress - previous[1]) / span, 0, 1) : 0;
  return THREE.MathUtils.lerp(previous[0], next[0], mix);
}

function ghostSampleAtTime(ghost, time) {
  const samples = ghost?.samples;
  if (!samples?.length) return null;
  if (time <= samples[0][0]) return samples[0];
  if (time >= samples[samples.length - 1][0]) return samples[samples.length - 1];
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid][0] < time) low = mid + 1;
    else high = mid;
  }
  const next = samples[low];
  const previous = samples[Math.max(0, low - 1)];
  const span = next[0] - previous[0];
  const mix = span > .001 ? THREE.MathUtils.clamp((time - previous[0]) / span, 0, 1) : 0;
  return [
    time,
    THREE.MathUtils.lerp(previous[1], next[1], mix),
    THREE.MathUtils.lerp(previous[2], next[2], mix),
    THREE.MathUtils.lerp(previous[3], next[3], mix),
  ];
}

function syncGhostVisual(t) {
  const visible = Boolean(
    activeGhost &&
    (state.phase === 'countdown' || state.phase === 'race') &&
    !player.finished,
  );
  ghostVisual.group.visible = visible;
  if (!visible) return;
  const sample = ghostSampleAtTime(activeGhost, Math.max(0, state.raceTime));
  if (!sample) {
    ghostVisual.group.visible = false;
    return;
  }
  const [, progress, lat, psi] = sample;
  const s = wrapS(startS + progress);
  const f = frameAt(s);
  const cosP = Math.cos(psi);
  const sinP = Math.sin(psi);
  _Z.set(
    f.t[0] * cosP + f.r[0] * sinP,
    f.t[1] * cosP + f.r[1] * sinP,
    f.t[2] * cosP + f.r[2] * sinP,
  );
  _Y.set(f.u[0], f.u[1], f.u[2]);
  _X.crossVectors(_Y, _Z).normalize();
  _shipM.makeBasis(_X, _Y, _Z);
  ghostVisual.group.quaternion.setFromRotationMatrix(_shipM);
  const phase = t * 4.4;
  ghostVisual.group.position.set(
    f.p[0] + f.r[0] * lat + f.u[0] * (.58 + Math.sin(phase) * .035),
    f.p[1] + f.r[1] * lat + f.u[1] * (.58 + Math.sin(phase) * .035),
    f.p[2] + f.r[2] * lat + f.u[2] * (.58 + Math.sin(phase) * .035),
  );
  ghostVisual.echoA.scale.setScalar(1 + (Math.sin(phase) + 1) * .08);
  ghostVisual.echoB.scale.setScalar(1.28 + (Math.sin(phase + 1.4) + 1) * .11);
  currentGhostDelta = ghostTimeAtProgress(
    activeGhost,
    THREE.MathUtils.clamp(player.lapProgress ?? player.progress, 0, L),
  );
  if (currentGhostDelta !== null) currentGhostDelta = state.raceTime - currentGhostDelta;
}

function currentSectorDeltas() {
  const currentBoundaries = ghostRecorder?.boundaries || [0, null, null, null, null, null, null];
  const bestBoundaries = activeGhost?.boundaries || [0, null, null, null, null, null, null];
  return SECTORS.map((sector, index) => {
    const currentEnd = currentBoundaries[index + 1];
    const currentStart = currentBoundaries[index];
    const bestEnd = bestBoundaries[index + 1];
    const bestStart = bestBoundaries[index];
    const current = currentEnd !== null && currentStart !== null ? currentEnd - currentStart : null;
    const pb = bestEnd !== null && bestStart !== null ? bestEnd - bestStart : null;
    const delta = current !== null && pb !== null ? current - pb : null;
    return {
      code: sector.code,
      current,
      pb,
      delta,
      status: delta === null ? 'pending' : (delta <= 0 ? 'ahead' : 'behind'),
    };
  });
}

const spectacle = createSpectacle({
  THREE,
  renderer,
  scene,
  camera,
  track,
  halfWidth: HALF_WIDTH,
  profile: renderProfile,
});
// fix initial progress (distance behind the line is negative)
for (const c of ships) {
  c.progress = deltaS(startS, c.s) <= 0 ? deltaS(startS, c.s) : deltaS(startS, c.s) - L;
  c.lapProgress = c.progress;
  c._sPrev = c.s;
}

function placeShipAtProgress(c, progress, lat, speed) {
  c.progress = progress;
  c.lapProgress = progress;
  c.s = wrapS(startS + progress);
  c._sPrev = c.s;
  c.lat = lat;
  c.psi = 0;
  c.vA = speed;
  c.vL = 0;
  c.prevVF = speed;
  c.cps = [progress > L / 3, progress > (2 * L) / 3];
  const f = frameAt(c.s);
  c.wx = f.p[0] + f.r[0] * lat + f.u[0] * .55;
  c.wy = f.p[1] + f.r[1] * lat + f.u[1] * .55;
  c.wz = f.p[2] + f.r[2] * lat + f.u[2] * .55;
}

function stageShowcaseGrid() {
  if (!showcaseSetupActive()) return;
  const target = ships.find(c => c.spec.name === 'ANTHROPIC') || ships[0];
  const base = L * .835;
  placeShipAtProgress(target, base + 17, -1.2, 72);
  placeShipAtProgress(player, base, -1.05, 75);
  let slot = 0;
  for (const c of ships) {
    if (c === player || c === target) continue;
    placeShipAtProgress(c, base - 42 - slot * 9, ((slot % 2) * 2 - 1) * 3.8, 68 - slot * .18);
    slot++;
  }
  player.boost = 88;
  player.draftCharge = 1;
  player.drafting = true;
  player.draftTarget = target;
  player.slingshotReady = true;
  player.slingshotReadySerial = 1;
  player.cleanRun = true;
}

function resetRace() {
  state.runSeed = selectedRunSeed();
  raceRng = mulberry32(state.runSeed);
  ships.forEach((c, i) => {
    const fresh = newShipState(c.spec, i);
    Object.assign(c, {
      ...fresh,
      mesh: c.mesh,
      lean: c.lean,
      engines: c.engines,
      plate: c.plate,
      shieldMat: c.shieldMat,
      driverBadge: c.driverBadge,
      driverAccentMat: c.driverAccentMat,
      shadowMeshes: c.shadowMeshes,
      trail: c.trail,
    });
    c.progress = deltaS(startS, c.s) <= 0 ? deltaS(startS, c.s) : deltaS(startS, c.s) - L;
    c.lapProgress = c.progress;
    c._sPrev = c.s;
    c.trail.hist.length = 0;
  });
  stageShowcaseGrid();
  startGhostRecording();
  state.raceTime = 0; state.countdown = 3.2; state.phase = 'countdown'; state.goTimer = 0;
  state.finishDelay = -1; state.countdownBeat = null;
  state.contract = setupSelection.contract;
  Object.assign(showdown, {
    active: false,
    elapsed: 0,
    stage: 'idle',
    winner: null,
    winnerColor: 0x6cecff,
    rank: null,
    margin: null,
    stationClaimed: false,
    beamActive: false,
    bannerPaintedFor: null,
  });
  if (heliosDynamic.claimBanner) heliosDynamic.claimBanner.material.opacity = 0;
  heliosDynamic.claimRings.forEach(ring => {
    ring.material.opacity = 0;
    ring.scale.setScalar(1);
  });
  resetMoments();
  for (const core of DATA_CORES) {
    core.collected = false;
    if (core.mesh) core.mesh.visible = true;
  }
  hud.msg.textContent = '';
  hud.msg.classList.remove('warn', 'draft', 'camera');
  if (hud.launchCue) {
    hud.launchCue.innerHTML = coarsePointer
      ? '<b>HOLD THRUST</b> // STEER CLEAR // <b>TAP BURST</b>'
      : '<b>HOLD THRUST</b> // STEER CLEAR // <b>SHIFT TO BURST</b>';
    hud.launchCue.classList.remove('battle', 'ready', 'active');
    hud.launchCue.classList.add('live');
  }
  hud.menu.classList.remove('show'); hud.results.classList.remove('show'); hud.pause.classList.remove('show');
  document.body.classList.remove('results-active');
  document.body.classList.add('race-active');
  camSnap();
  raceControl?.reset(raceControlSnapshot());
  startRaceMusic(true);
}

function ranking() {
  return [...ships].sort((a, b) =>
    (b.finished - a.finished) || (a.finished ? a.finishTime - b.finishTime : b.progress - a.progress));
}

function raceControlSnapshot() {
  const order = ranking();
  const playerIndex = order.indexOf(player);
  const ahead = playerIndex > 0 ? order[playerIndex - 1] : null;
  const behind = playerIndex >= 0 && playerIndex < order.length - 1 ? order[playerIndex + 1] : null;
  const playerSpeed = Math.hypot(player.vA, player.vL);
  const gapTo = rival => rival
    ? Math.max(0, rival.progress - player.progress)
    : null;
  const gapAhead = gapTo(ahead);
  const gapBehind = behind ? Math.max(0, player.progress - behind.progress) : null;
  return {
    phase: state.phase,
    time: state.raceTime,
    progress: THREE.MathUtils.clamp((player.lapProgress ?? player.progress) / L, 0, 1),
    player: {
      name: player.spec.name,
      driverId: activeDriver().id,
      driverName: activeDriver().name,
      rank: playerIndex + 1,
      speed: playerSpeed,
      remainingDistance: Math.max(0, L - (player.lapProgress ?? player.progress)),
      adjacentAhead: ahead?.spec?.name || null,
      adjacentBehind: behind?.spec?.name || null,
      gapAhead,
      gapBehind,
      gapAheadSeconds: gapAhead === null ? null : gapAhead / Math.max(playerSpeed, 10),
      closingRate: ahead ? playerSpeed - Math.hypot(ahead.vA, ahead.vL) : null,
      packets: player.packets,
      packetTotal: DATA_CORES.length,
      drafting: player.drafting,
      draftCharge: player.draftCharge,
      draftTarget: player.draftTarget?.spec?.name || null,
      slingshotReady: player.slingshotReady,
      slingshotReadySerial: player.slingshotReadySerial,
      slingshotSerial: player.slingshotSerial,
      shield: player.shield,
      limp: player.limp,
      hitWall: player.hitWall,
      impactSerial: player.impactSerial,
      finished: player.finished,
      finishTime: player.finishTime,
    },
    order: order.map(c => ({
      name: c.spec.name,
      progress: c.progress,
      speed: Math.hypot(c.vA, c.vL),
      drafting: c.drafting,
      slingshotReady: c.slingshotReady,
      slingshotSerial: c.slingshotSerial,
      finished: c.finished,
      finishTime: c.finishTime,
    })),
  };
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
  if (code === 'Enter' && (state.phase === 'menu' || state.phase === 'results')) launchRace();
  if (code === 'KeyR' && state.phase !== 'menu') resetRace();
  if (code === 'KeyB' && state.phase === 'race') respawn(player);
  if (code === 'KeyM') setMuted(!state.muted);
  if (code === 'KeyC') {
    state.cameraMode = (state.cameraMode + 1) % 4;
    state.cameraLabelT = 1.2;
    camSnap();
  }
  if (code === 'Escape' || code === 'KeyP') {
    if (state.phase === 'race') {
      state.phase = 'paused'; hud.pause.classList.add('show'); pauseRaceMusic();
    } else if (state.phase === 'paused') {
      state.phase = 'race'; hud.pause.classList.remove('show'); resumeRaceMusic();
    }
  }
}
const touch = { left: false, right: false, gas: false, brk: false, boost: false, drift: false };
const coarsePointer = matchMedia('(pointer: coarse)').matches;
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
const MUSIC_VOL = 0.27;
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
  scrapeFilt = null, scrapeGain = null, masterGain = null, bedGain = null, momentGain = null,
  scoreGain = null,
  scoreFilt = null, scoreVoices = [], lastAudioT = 0;
let musicAudio = null, musicSource = null, musicGain = null, musicStopToken = 0;
let narratorDucking = false;
const aiVoices = [];
const _lisDir = new THREE.Vector3();
function ensureAudio() {
  if (ac) { if (ac.state === 'suspended') ac.resume().catch(() => {}); return; }
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ac.createGain();
    masterGain.gain.value = state.muted ? 0 : MASTER_VOL;
    masterGain.connect(ac.destination);
    bedGain = ac.createGain();
    bedGain.gain.value = narratorDucking ? .3 : 1;
    momentGain = ac.createGain();
    momentGain.gain.value = 1;
    bedGain.connect(masterGain);
    momentGain.connect(masterGain);

    musicAudio = new Audio('assets/music/threshold-voltage.mp3');
    musicAudio.preload = 'auto';
    musicAudio.loop = true;
    musicSource = ac.createMediaElementSource(musicAudio);
    musicGain = ac.createGain();
    musicGain.gain.value = 0;
    musicSource.connect(musicGain);
    musicGain.connect(ac.destination);

    engineFilt = ac.createBiquadFilter(); engineFilt.type = 'lowpass';
    engineFilt.frequency.value = 1200; engineFilt.Q.value = 0.8;
    engineGain = ac.createGain(); engineGain.gain.value = 0.0001;
    engineFilt.connect(engineGain); engineGain.connect(bedGain);

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
        node.connect(lp); lp.connect(g); g.connect(pan); pan.connect(bedGain);
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
    const tap = (mk) => { const g = ac.createGain(); g.gain.value = 0; mk.connect(g); g.connect(bedGain); noise.connect(mk); return g; };
    whooshFilt = ac.createBiquadFilter(); whooshFilt.type = 'bandpass';
    whooshFilt.frequency.value = 400; whooshFilt.Q.value = 0.7;
    whooshGain = tap(whooshFilt);
    const wf = ac.createBiquadFilter(); wf.type = 'highpass'; wf.frequency.value = 1100;
    windGain = tap(wf);
    const bf = ac.createBiquadFilter(); bf.type = 'lowpass'; bf.frequency.value = 460;
    boostGain = tap(bf);
    boostSub = ac.createOscillator(); boostSub.type = 'sine'; boostSub.frequency.value = 44;
    const bsg = ac.createGain(); bsg.gain.value = 0;
    boostSub.connect(bsg); bsg.connect(bedGain); boostSub.start();
    boostSub._g = bsg;
    scrapeFilt = ac.createBiquadFilter(); scrapeFilt.type = 'bandpass';
    scrapeFilt.frequency.value = 1900; scrapeFilt.Q.value = 2.8;
    scrapeGain = tap(scrapeFilt);

    // A restrained generative score follows the current mission sector. It is
    // deliberately synthesis-only so the submission remains tiny and licensed.
    scoreGain = ac.createGain(); scoreGain.gain.value = 0.0001;
    scoreFilt = ac.createBiquadFilter(); scoreFilt.type = 'lowpass';
    scoreFilt.frequency.value = 620; scoreFilt.Q.value = 1.3;
    scoreGain.connect(scoreFilt); scoreFilt.connect(bedGain);
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
  o.connect(g); g.connect(momentGain || masterGain);
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
  o.connect(g); g.connect(momentGain || masterGain); o.start(t); o.stop(t + (go ? .44 : .18));
}
function momentTone(kind = 'pass') {
  if (!ac || state.muted) return;
  const t = ac.currentTime;
  const profiles = {
    boost: [180, 520, .12, .2],
    slingshot: [105, 1480, .24, .52],
    pass: [440, 880, .11, .22],
    danger: [310, 155, .1, .24],
    sector: [520, 1040, .12, .3],
    finish: [220, 1320, .22, .8],
    impact: [92, 48, .13, .18],
  };
  const [from, to, level, duration] = profiles[kind] || profiles.pass;
  const osc = ac.createOscillator();
  osc.type = kind === 'impact' ? 'square' : (kind === 'slingshot' ? 'sawtooth' : 'triangle');
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + duration * .72);
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(kind === 'impact' ? 280 : 2200, t);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + .018);
  gain.gain.exponentialRampToValueAtTime(.0001, t + duration);
  osc.connect(filter); filter.connect(gain); gain.connect(momentGain || masterGain);
  osc.start(t); osc.stop(t + duration + .02);
}
function haptic(ms = 10) {
  if (renderProfile.reducedMotion || typeof navigator.vibrate !== 'function' || document.hidden) return;
  navigator.vibrate(ms);
}
function setMuted(m) {
  state.muted = m;
  hud.mute.textContent = m ? 'SOUND // OFF' : 'SOUND // ON';
  raceControl?.setMuted(m);
  if (masterGain && ac) {
    const level = m ? 0 : MASTER_VOL;
    masterGain.gain.setTargetAtTime(level, ac.currentTime, 0.03);
  }
  syncMusicGain(.03);
}
function musicLevel() {
  if (state.muted || state.phase === 'menu' || state.phase === 'results' || state.phase === 'paused') return 0;
  return MUSIC_VOL * (narratorDucking ? .26 : 1);
}
function syncMusicGain(timeConstant = .16) {
  if (!musicGain || !ac) return;
  musicGain.gain.setTargetAtTime(musicLevel(), ac.currentTime, timeConstant);
}
function startRaceMusic(restart = false) {
  if (!musicAudio || !ac) return;
  musicStopToken++;
  if (restart) {
    try { musicAudio.currentTime = 0; } catch { /* metadata may still be loading */ }
  }
  musicAudio.play().catch(() => {});
  syncMusicGain(.16);
}
function pauseRaceMusic() {
  musicStopToken++;
  if (musicGain && ac) musicGain.gain.setTargetAtTime(0, ac.currentTime, .04);
  musicAudio?.pause();
}
function resumeRaceMusic() {
  if (!musicAudio || !ac) return;
  musicStopToken++;
  musicAudio.play().catch(() => {});
  syncMusicGain(.1);
}
function stopRaceMusic(rewind = true) {
  const token = ++musicStopToken;
  if (musicGain && ac) musicGain.gain.setTargetAtTime(0, ac.currentTime, .28);
  setTimeout(() => {
    if (token !== musicStopToken || !musicAudio) return;
    musicAudio.pause();
    if (rewind) {
      try { musicAudio.currentTime = 0; } catch { /* metadata may still be loading */ }
    }
  }, 900);
}
function setNarratorDuck(ducking) {
  narratorDucking = Boolean(ducking);
  if (!bedGain || !ac) return;
  bedGain.gain.setTargetAtTime(narratorDucking ? .3 : 1, ac.currentTime, narratorDucking ? 0.04 : 0.16);
  syncMusicGain(narratorDucking ? .04 : .18);
}
function updateAudio() {
  if (!ac || !engineGain) return;
  const t = ac.currentTime;
  const active = state.phase === 'race' || state.phase === 'countdown';
  const spd = Math.hypot(player.vA, player.vL);
  const slingshot = player.slingshotT > 0;
  const f0 = 58 + spd * 4.0 + (player.boosting ? 60 : 0) + (slingshot ? 105 : 0);
  if (engineNode) {
    engineNode.parameters.get('freq').setTargetAtTime(f0, t, 0.05);
    engineNode.parameters.get('throttle').setTargetAtTime(active ? player.throttle : 0.05, t, 0.06);
    engineNode.parameters.get('boost').setTargetAtTime(player.boosting ? 1 : 0, t, 0.05);
  }
  engineFilt.frequency.setTargetAtTime(500 + spd * 26 + (player.boosting ? 900 : 0) + (slingshot ? 850 : 0), t, 0.06);
  engineGain.gain.setTargetAtTime(active ? 0.32 : 0.06, t, 0.06);
  whooshFilt.frequency.setTargetAtTime(280 + spd * 15, t, 0.08);
  whooshGain.gain.setTargetAtTime(active ? Math.min(spd / player.spec.vmax, 1.2) * 0.16 : 0, t, 0.09);
  windGain.gain.setTargetAtTime(active ? (spd / player.spec.vmax) ** 2 * 0.1 : 0, t, 0.1);
  boostGain.gain.setTargetAtTime(player.boosting ? (slingshot ? .46 : .3) : 0, t, 0.05);
  if (boostSub) boostSub._g.gain.setTargetAtTime(player.boosting ? (slingshot ? .3 : .2) : 0, t, 0.05);
  const scrape = player.hitWall && spd > 4;
  scrapeGain.gain.setTargetAtTime(active && scrape ? 0.2 : 0, t, 0.04);
  if (scoreGain && scoreVoices.length) {
    const progress = THREE.MathUtils.clamp((player.lapProgress ?? 0) / L, 0, 1);
    const roots = [55, 61.74, 65.41, 73.42, 82.41, 98];
    const root = roots[Math.min(roots.length - 1, Math.floor(progress * roots.length))];
    scoreVoices.forEach(v => v.osc.frequency.setTargetAtTime(root * v.ratio, t, .45));
    scoreGain.gain.setTargetAtTime(active ? .026 : .005, t, .6);
    scoreFilt.frequency.setTargetAtTime(420 + spd * 8 + (player.boosting ? 480 : 0) + (slingshot ? 360 : 0), t, .3);
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
    v.node.parameters.get('freq').setTargetAtTime(
      (58 + vSpd * 4.0 + (v.c.boosting ? 60 : 0) + (v.c.slingshotT > 0 ? 80 : 0)) * dop,
      t,
      0.06,
    );
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
        const flameCount = c.slingshotT > 0 ? 4 : 2;
        for (let i = 0; i < flameCount; i++) {
          flames.spawn(
            c.wx - fx * 2.2 + (rng() - 0.5) * 0.5, c.wy - fy * 2.2 + 0.28, c.wz - fz * 2.2 + (rng() - 0.5) * 0.5,
            -fx * (spd * 0.3 + 6) + (rng() - 0.5) * 2, 0.4 + rng(), -fz * (spd * 0.3 + 6) + (rng() - 0.5) * 2,
            0.28 + rng() * 0.24, c.slingshotT > 0 ? 1.34 : 1.0);
        }
      }
    }
  }
  sparks.update(dt);
  flames.update(dt);
}

// ---------- camera ----------
const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3(), camUp = new THREE.Vector3(0, 1, 0);
const camVel = new THREE.Vector3(), camTgtVel = new THREE.Vector3();
let camFrozen = false;
const _fwd = new THREE.Vector3(), _upW = new THREE.Vector3(), _rightW = new THREE.Vector3(),
  _want = new THREE.Vector3(), _camDir = new THREE.Vector3(), _velDir = new THREE.Vector3(),
  WORLD_UP = new THREE.Vector3(0, 1, 0);
const CAMERA_NAMES = ['CHASE', 'WIDE', 'COCKPIT', 'ORBITAL DRONE'];
function springVector(value, velocity, target, frequency, dampingRatio, dt) {
  const omega = frequency * Math.PI * 2;
  const steps = Math.max(1, Math.ceil(dt * 120));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    velocity.x += ((target.x - value.x) * omega * omega - 2 * dampingRatio * omega * velocity.x) * h;
    velocity.y += ((target.y - value.y) * omega * omega - 2 * dampingRatio * omega * velocity.y) * h;
    velocity.z += ((target.z - value.z) * omega * omega - 2 * dampingRatio * omega * velocity.z) * h;
    value.addScaledVector(velocity, h);
  }
}
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
  camVel.set(0, 0, 0);
  camTgtVel.set(0, 0, 0);
}
function updateCamera(dt) {
  if (camFrozen) return;
  if (state.phase === 'menu' || state.phase === 'results') {
    // slow orbit around the grid so the menu floats over a living track
    const t = performance.now() * 0.00016;
    const f0 = frameAt(player.s);
    const cx = player.wx + Math.sin(t) * 26, cz = player.wz + Math.cos(t) * 26;
    _want.set(cx, player.wy + 9 + Math.sin(t * 0.7) * 2, cz);
    springVector(camPos, camVel, _want, .58, .96, Math.min(dt, .1));
    _want.set(player.wx, player.wy + .5, player.wz);
    springVector(camTgt, camTgtVel, _want, .75, 1, Math.min(dt, .1));
    camUp.lerp(WORLD_UP, 1 - Math.exp(-4 * dt)).normalize();
    camera.up.copy(camUp);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    camera.fov = THREE.MathUtils.damp(camera.fov, 56, 4.5, dt);
    camera.updateProjectionMatrix();
    return;
  }
  const f = frameAt(player.s);
  shipWorldFwd(player, _fwd);
  _upW.set(f.u[0], f.u[1], f.u[2]).lerp(WORLD_UP, 0.35).normalize();
  _rightW.set(f.r[0], f.r[1], f.r[2]);
  const spd = Math.hypot(player.vA, player.vL);
  _velDir.copy(_fwd).multiplyScalar(player.vA).addScaledVector(_rightW, player.vL);
  if (_velDir.lengthSq() > 4) _velDir.normalize();
  else _velDir.copy(_fwd);
  _camDir.copy(_fwd).lerp(_velDir, .28).normalize();
  const mode = state.cameraMode;
  const portraitPullback = THREE.MathUtils.clamp((1 - camera.aspect) * .85, 0, .5);

  if (state.phase === 'countdown' && !renderProfile.reducedMotion) {
    const scan = THREE.MathUtils.clamp((3.2 - state.countdown) / 3, 0, 1);
    const eased = scan * scan * (3 - 2 * scan);
    _want.set(player.wx, player.wy, player.wz)
      .addScaledVector(_camDir, THREE.MathUtils.lerp(-14, -9.2, eased))
      .addScaledVector(_rightW, THREE.MathUtils.lerp(10.5, 0, eased))
      .addScaledVector(_upW, THREE.MathUtils.lerp(5.2, 3.25, eased));
    springVector(camPos, camVel, _want, 2.25, .98, Math.min(dt, .1));
    _want.set(player.wx, player.wy, player.wz)
      .addScaledVector(_fwd, THREE.MathUtils.lerp(2, 9, eased))
      .addScaledVector(_upW, .75);
    springVector(camTgt, camTgtVel, _want, 2.5, 1, Math.min(dt, .1));
    camUp.lerp(_upW, 1 - Math.exp(-5 * dt)).normalize();
    camera.up.copy(camUp);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    camera.fov = THREE.MathUtils.damp(camera.fov, 58 + eased * 6, 5.5, dt);
    camera.updateProjectionMatrix();
    player.mesh.visible = true;
    return;
  }

  if (state.phase === 'race' && player.finished && state.finishDelay >= 0 &&
      !renderProfile.reducedMotion) {
    if (showdown.active && showdown.elapsed >= 2.05 && showdown.elapsed < 5.45 &&
        heliosDynamic.station) {
      const stationFrame = frameAt((heliosDynamic.station.userData.trackFraction || 0) * L);
      _fwd.set(stationFrame.t[0], stationFrame.t[1], stationFrame.t[2]);
      _rightW.set(stationFrame.r[0], stationFrame.r[1], stationFrame.r[2]);
      _upW.set(stationFrame.u[0], stationFrame.u[1], stationFrame.u[2])
        .lerp(WORLD_UP, .3)
        .normalize();
      const reveal = THREE.MathUtils.clamp((showdown.elapsed - 2.05) / 3.4, 0, 1);
      const orbitSide = Math.sin(player.finishTime * 2.7) >= 0 ? 1 : -1;
      _want.copy(heliosDynamic.station.position)
        .addScaledVector(_fwd, THREE.MathUtils.lerp(-118, -102, reveal))
        .addScaledVector(_rightW, orbitSide * THREE.MathUtils.lerp(28, 42, reveal))
        .addScaledVector(_upW, THREE.MathUtils.lerp(22, 32, reveal));
      springVector(camPos, camVel, _want, 1.6, 1, Math.min(dt, .1));
      _want.copy(heliosDynamic.station.position)
        .addScaledVector(_upW, -2)
        .addScaledVector(_fwd, 1);
      springVector(camTgt, camTgtVel, _want, 1.8, 1, Math.min(dt, .1));
      camUp.lerp(_upW, 1 - Math.exp(-3.5 * dt)).normalize();
      camera.up.copy(camUp);
      camera.position.copy(camPos);
      camera.lookAt(camTgt);
      camera.fov = THREE.MathUtils.damp(camera.fov, 58 - reveal * 3, 3.5, dt);
      camera.updateProjectionMatrix();
      player.mesh.visible = true;
      return;
    }
    const hero = THREE.MathUtils.clamp(state.finishDelay / 3, 0, 1);
    const eased = hero * hero * (3 - 2 * hero);
    const side = Math.sin(player.finishTime * 2.7) >= 0 ? 1 : -1;
    _want.set(player.wx, player.wy, player.wz)
      .addScaledVector(_camDir, THREE.MathUtils.lerp(-8, -3.5, eased))
      .addScaledVector(_rightW, side * THREE.MathUtils.lerp(2.5, 12, eased))
      .addScaledVector(_upW, THREE.MathUtils.lerp(3.4, 5.8, eased));
    springVector(camPos, camVel, _want, 2.2, 1, Math.min(dt, .1));
    _want.set(player.wx, player.wy, player.wz)
      .addScaledVector(_fwd, THREE.MathUtils.lerp(10, 3.5, eased))
      .addScaledVector(_upW, .7);
    springVector(camTgt, camTgtVel, _want, 2.2, 1, Math.min(dt, .1));
    camUp.lerp(_upW, 1 - Math.exp(-4 * dt)).normalize();
    camera.up.copy(camUp);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    camera.fov = THREE.MathUtils.damp(camera.fov, 61 - eased * 4, 4.2, dt);
    camera.updateProjectionMatrix();
    player.mesh.visible = true;
    return;
  }

  _want.set(player.wx, player.wy, player.wz);
  if (mode === 1) {
    _want.addScaledVector(_camDir, -(15.5 + spd * .06) * (1 + portraitPullback))
      .addScaledVector(_upW, 6.2 + spd * .018 + portraitPullback);
  } else if (mode === 2) {
    _want.addScaledVector(_camDir, 1.02).addScaledVector(_upW, 1.08);
  } else if (mode === 3) {
    const side = Math.sin(player.progress * .006) > 0 ? 1 : -1;
    _want.addScaledVector(_camDir, -6 - spd * .025).addScaledVector(_rightW, side * 14).addScaledVector(_upW, 7.8);
  } else {
    _want.addScaledVector(_camDir, -(9.1 + spd * .046) * (1 + portraitPullback))
      .addScaledVector(_upW, 3.15 + spd * .012 + portraitPullback * .65);
  }
  springVector(camPos, camVel, _want, mode === 2 ? 4.8 : (mode === 3 ? 2.4 : 1.72), .96, Math.min(dt, .1));
  _want.set(player.wx, player.wy, player.wz)
    .addScaledVector(_fwd, mode === 2 ? 26 : (mode === 3 ? 6 : 9))
    .addScaledVector(_upW, mode === 2 ? .38 : .8);
  springVector(camTgt, camTgtVel, _want, mode === 2 ? 5.2 : 2.15, 1, Math.min(dt, .1));
  _want.copy(_upW).lerp(WORLD_UP, mode === 3 ? .72 : .05).normalize();
  camUp.lerp(_want, 1 - Math.exp(-4.5 * dt)).normalize();
  camera.up.copy(camUp);
  camera.position.copy(camPos);
  const slingshotFx = momentLevel('slingshot');
  const impactFx = Math.max(momentLevel('impact'), player.hitWall ? 1 : 0);
  const shake = renderProfile.reducedMotion ? 0 :
    (impactFx > 0 ? .18 * impactFx : (player.boosting ? .025 + slingshotFx * .04 : 0));
  if (shake) {
    camera.position.addScaledVector(_upW, Math.sin(performance.now() * .06) * shake);
    camera.position.addScaledVector(_rightW, Math.cos(performance.now() * .047) * shake * .7);
  }
  camera.lookAt(camTgt);
  const baseFov = mode === 1 ? 61 : (mode === 2 ? 70 : (mode === 3 ? 58 : 64));
  const wantedFov = baseFov +
    Math.min(spd * (mode === 2 ? .08 : .14), 13) +
    (player.boosting && !renderProfile.reducedMotion ? 6 : 0) +
    (!renderProfile.reducedMotion ? slingshotFx * 5 + momentLevel('launch') * 2.5 : 0);
  camera.fov = THREE.MathUtils.damp(camera.fov, wantedFov, mode === 2 ? 9 : 5.5, dt);
  camera.updateProjectionMatrix();
  player.mesh.visible = mode !== 2 || state.phase === 'menu' || state.phase === 'results';
}

// ---------- post: HDR -> bright pass -> blur -> ACES composite ----------
const post = (() => {
  const sceneStats = { calls: 0, triangles: 0, points: 0, lines: 0 };
  const targetType = renderProfile.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const sceneRT = new THREE.WebGLRenderTarget(2, 2, {
    type: targetType,
    samples: renderProfile.msaa,
    depthBuffer: true,
  });
  const blurA = new THREE.WebGLRenderTarget(2, 2, { type: targetType, depthBuffer: false });
  const blurB = new THREE.WebGLRenderTarget(2, 2, { type: targetType, depthBuffer: false });
  const wideA = new THREE.WebGLRenderTarget(2, 2, { type: targetType, depthBuffer: false });
  const wideB = new THREE.WebGLRenderTarget(2, 2, { type: targetType, depthBuffer: false });
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
    uniforms: { tex: { value: null }, thr: { value: 1.12 }, knee: { value: .52 } },
    vertexShader: V,
    fragmentShader: `
      uniform sampler2D tex; uniform float thr; uniform float knee; varying vec2 vUv;
      void main(){
        vec3 c=texture2D(tex,vUv).rgb;
        float b=max(max(c.r,c.g),c.b);
        float soft=clamp((b-thr+knee)/(2.0*knee),0.0,1.0);
        soft=soft*soft*knee;
        float contribution=max(soft,b-thr)/max(b,.0001);
        gl_FragColor=vec4(c*max(0.0,contribution),1.0);
      }`,
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
    uniforms: {
      tex: { value: null },
      bloom: { value: null },
      bloomWide: { value: null },
      strength: { value: renderProfile.name === 'ULTRA' ? .86 : .72 },
      exposure: { value: 1.055 },
      speedFx: { value: 0 },
      boostFx: { value: 0 },
      surgeFx: { value: 0 },
      momentFx: { value: 0 },
      impactFx: { value: 0 },
      uTime: { value: 0 },
      fxEnabled: { value: renderProfile.reducedMotion ? 0 : 1 },
      texel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    },
    vertexShader: V,
    fragmentShader: `
      uniform sampler2D tex; uniform sampler2D bloom; uniform sampler2D bloomWide;
      uniform float strength; uniform float exposure; uniform float speedFx;
      uniform float boostFx; uniform float surgeFx; uniform float momentFx;
      uniform float impactFx; uniform float uTime; uniform float fxEnabled;
      uniform vec2 texel;
      varying vec2 vUv;
      vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.0,1.0);}
      float hash12(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
      void main(){
        vec2 center=vUv-.5;
        float edge=dot(center,center);
        float motion=(speedFx*.56+boostFx*.7+surgeFx*.55)*fxEnabled;
        float aberr=(.00025+edge*.0042)*(speedFx*.55+boostFx+surgeFx*.7)*fxEnabled;
        vec2 aberrDir=normalize(center+vec2(.0001))*aberr;
        vec3 c;
        c.r=texture2D(tex,clamp(vUv+aberrDir,0.0,1.0)).r;
        c.g=texture2D(tex,vUv).g;
        c.b=texture2D(tex,clamp(vUv-aberrDir,0.0,1.0)).b;
        if(motion>.001){
          vec3 streak=c;
          streak+=texture2D(tex,clamp(vUv-center*.005*motion,0.0,1.0)).rgb*.82;
          streak+=texture2D(tex,clamp(vUv-center*.011*motion,0.0,1.0)).rgb*.62;
          streak+=texture2D(tex,clamp(vUv-center*.019*motion,0.0,1.0)).rgb*.42;
          streak+=texture2D(tex,clamp(vUv-center*.029*motion,0.0,1.0)).rgb*.24;
          c=mix(c,streak/3.1,motion*.72);
        }
        // A restrained reconstruction-style unsharp pass restores material
        // detail lost to adaptive render scaling. This is ordinary spatial
        // filtering, not a DLSS or neural-reconstruction claim.
        vec3 base=texture2D(tex,vUv).rgb;
        vec3 neighbours=(
          texture2D(tex,clamp(vUv+vec2(texel.x,0.0),0.0,1.0)).rgb+
          texture2D(tex,clamp(vUv-vec2(texel.x,0.0),0.0,1.0)).rgb+
          texture2D(tex,clamp(vUv+vec2(0.0,texel.y),0.0,1.0)).rgb+
          texture2D(tex,clamp(vUv-vec2(0.0,texel.y),0.0,1.0)).rgb
        )*.25;
        c+=(base-neighbours)*(.22-motion*.08);
        vec3 glow=texture2D(bloom,vUv).rgb+texture2D(bloomWide,vUv).rgb*.62;
        c+=glow*strength*(1.0+boostFx*.18+surgeFx*.2);
        float radius=length(center);
        float attackRing=exp(-abs(radius-(.16+surgeFx*.25))*62.0)*surgeFx*fxEnabled;
        c+=vec3(.62,1.0,.72)*attackRing*.22;
        c*=1.0+momentFx*.035;
        c=mix(c,vec3(dot(c,vec3(.299,.587,.114))),impactFx*.18);
        c.r+=impactFx*.18*edge;
        c=aces(c*exposure*(1.0+boostFx*.055+surgeFx*.04));
        float vignette=1.0-edge*(.34+speedFx*.2);
        float grain=(hash12(gl_FragCoord.xy+uTime*73.1)-.5)*(.0025+speedFx*.0025)*fxEnabled;
        c=c*vignette+grain;
        gl_FragColor=vec4(pow(max(c,0.0),vec3(1.0/2.2)),1.0);
      }`,
  });
  function pass(mat, target) { fsMesh.material = mat; renderer.setRenderTarget(target); renderer.render(fsScene, fsCam); }
  function setSize(w, h) {
    if (!renderProfile.post) return;
    sceneRT.setSize(w, h);
    compMat.uniforms.texel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    blurA.setSize(bw, bh); blurB.setSize(bw, bh);
    const ww = Math.max(1, w >> 2), wh = Math.max(1, h >> 2);
    wideA.setSize(ww, wh); wideB.setSize(ww, wh);
  }
  function render() {
    if (!renderProfile.post) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      Object.assign(sceneStats, renderer.info.render);
      return;
    }
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    Object.assign(sceneStats, renderer.info.render);
    brightMat.uniforms.tex.value = sceneRT.texture; pass(brightMat, blurA);
    const bw = blurA.width, bh = blurA.height;
    blurMat.uniforms.texel.value.set(1 / bw, 1 / bh);
    for (let i = 0; i < renderProfile.bloomPasses; i++) {
      blurMat.uniforms.tex.value = blurA.texture; blurMat.uniforms.dir.value.set(1, 0); pass(blurMat, blurB);
      blurMat.uniforms.tex.value = blurB.texture; blurMat.uniforms.dir.value.set(0, 1); pass(blurMat, blurA);
    }
    if (renderProfile.wideBloom) {
      blurMat.uniforms.tex.value = blurA.texture;
      blurMat.uniforms.dir.value.set(0, 0);
      pass(blurMat, wideA);
      const ww = wideA.width, wh = wideA.height;
      blurMat.uniforms.texel.value.set(1 / ww, 1 / wh);
      for (let i = 0; i < 2; i++) {
        blurMat.uniforms.tex.value = wideA.texture; blurMat.uniforms.dir.value.set(1, 0); pass(blurMat, wideB);
        blurMat.uniforms.tex.value = wideB.texture; blurMat.uniforms.dir.value.set(0, 1); pass(blurMat, wideA);
      }
    }
    compMat.uniforms.tex.value = sceneRT.texture; compMat.uniforms.bloom.value = blurA.texture;
    compMat.uniforms.bloomWide.value = renderProfile.wideBloom ? wideA.texture : blurA.texture;
    pass(compMat, null);
  }
  function dynamics(time, speed, boost, impact, directedMoments = null) {
    compMat.uniforms.uTime.value = time;
    compMat.uniforms.speedFx.value = THREE.MathUtils.clamp((speed - 28) / 68, 0, 1);
    const surge = directedMoments ? momentLevel('slingshot') : 0;
    const boostKick = directedMoments ? momentLevel('boost') : 0;
    const directed = directedMoments
      ? Math.max(
        momentLevel('launch'),
        momentLevel('pass'),
        momentLevel('sector'),
        momentLevel('finish') * .5,
      )
      : 0;
    compMat.uniforms.boostFx.value = Math.max(boost ? .72 : 0, boostKick, surge);
    compMat.uniforms.surgeFx.value = surge;
    compMat.uniforms.momentFx.value = directed;
    compMat.uniforms.impactFx.value = Math.max(impact ? 1 : 0, directedMoments ? momentLevel('impact') : 0);
  }
  return { render, setSize, dynamics, sceneStats };
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
  resultsMeta: document.getElementById('resultsMeta'),
  resultDriver: document.getElementById('resultDriver'),
  resultDifficulty: document.getElementById('resultDifficulty'),
  resultTime: document.getElementById('resultTime'),
  resultCores: document.getElementById('resultCores'),
  resultSlingshots: document.getElementById('resultSlingshots'),
  resultContract: document.getElementById('resultContract'),
  resultContractName: document.getElementById('resultContractName'),
  resultContractStatus: document.getElementById('resultContractStatus'),
  resultContractProgress: document.getElementById('resultContractProgress'),
  resultPbDelta: document.getElementById('resultPbDelta'),
  sectorBreakdownList: document.getElementById('sectorBreakdownList'),
  racePb: document.getElementById('racePbBtn'),
  resultsStinger: document.getElementById('resultsStinger'),
  boostControlLabel: document.getElementById('burstControlLabel'),
  raceControl: document.getElementById('raceControl'),
  launchCue: document.getElementById('launchCue'),
  momentStamp: document.getElementById('momentStamp'),
  driverHud: document.getElementById('driverHud'),
  difficultyHud: document.getElementById('difficultyHud'),
  pilotSpeedLabel: document.getElementById('pilotSpeedLabel'),
  setupStatus: document.getElementById('setupStatus'),
  ghostDelta: document.getElementById('ghostDelta'),
  ghostDeltaValue: document.getElementById('ghostDeltaValue'),
  ghostSectorLabel: document.getElementById('ghostSectorLabel'),
  touchBoost: document.getElementById('tboost'),
  start: document.getElementById('startBtn'),
};
let narratorDecodeContext = null;
function getNarratorDecodeContext() {
  if (narratorDecodeContext) return narratorDecodeContext;
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext) return null;
  try {
    narratorDecodeContext = new OfflineContext(1, 1, 44_100);
  } catch {
    narratorDecodeContext = null;
  }
  return narratorDecodeContext;
}

// ---------- moment direction ----------
// These are time envelopes, not new scene objects. Important race actions feed
// the existing camera, post pass, lighting, HUD, and synthesis buses.
const MOMENT_DURATION = Object.freeze({
  launch: 1.15,
  boost: .48,
  pass: .72,
  sector: .82,
  impact: .46,
  finish: 3.1,
  slingshot: 1.05,
});
const moments = {
  launch: 0, boost: 0, pass: 0, sector: 0, impact: 0, finish: 0, slingshot: 0,
  stampT: 0, lastBoosting: false, lastImpactSerial: 0, finishSeen: false,
};
function momentLevel(kind) {
  return THREE.MathUtils.clamp((moments[kind] || 0) / (MOMENT_DURATION[kind] || 1), 0, 1);
}
function triggerMoment(kind, options = {}) {
  if (MOMENT_DURATION[kind]) {
    moments[kind] = Math.max(moments[kind] || 0, MOMENT_DURATION[kind]);
  }
  if (options.text && hud.momentStamp) {
    hud.momentStamp.textContent = options.text;
    hud.momentStamp.classList.toggle('danger', Boolean(options.danger));
    hud.momentStamp.classList.add('live');
    moments.stampT = options.hold ?? (kind === 'finish' ? 2.7 : .72);
  }
}
function resetMoments() {
  for (const kind of Object.keys(MOMENT_DURATION)) moments[kind] = 0;
  moments.stampT = 0;
  moments.lastBoosting = false;
  moments.lastImpactSerial = player.impactSerial;
  moments.finishSeen = false;
  hud.momentStamp?.classList.remove('live', 'danger');
  if (hud.momentStamp) hud.momentStamp.textContent = '';
}
function updateMoments(dt) {
  for (const kind of Object.keys(MOMENT_DURATION)) {
    moments[kind] = Math.max(0, moments[kind] - dt);
  }
  moments.stampT = Math.max(0, moments.stampT - dt);
  if (moments.stampT <= 0) hud.momentStamp?.classList.remove('live', 'danger');

  const boostEdge = player.boosting && !moments.lastBoosting;
  if (boostEdge && player.slingshotT <= 0) {
    triggerMoment('boost');
    momentTone('boost');
  }
  moments.lastBoosting = player.boosting;

  if (player.impactSerial !== moments.lastImpactSerial) {
    moments.lastImpactSerial = player.impactSerial;
    triggerMoment('impact');
    momentTone('impact');
    haptic(10);
  }
  if (player.finished && !moments.finishSeen) {
    moments.finishSeen = true;
    const rank = ranking().indexOf(player) + 1;
    triggerMoment('finish', { text: `LINK ACQUIRED // P${rank}`, hold: 2.7 });
    momentTone('finish');
    haptic(18);
  }
}
function handleRaceControlEvent(event) {
  const meta = event?.meta || {};
  if (event?.kind === 'green') {
    triggerMoment('launch');
    return;
  }
  if (event?.kind === 'rankUp') {
    const rival = meta.rival ? ` // ${meta.rival} CLEARED` : '';
    triggerMoment('pass', {
      text: `P${String(meta.previous || 0).padStart(2, '0')} → P${String(meta.rank || 0).padStart(2, '0')}${rival}`,
    });
    momentTone('pass');
    return;
  }
  if (event?.kind === 'rankDown') {
    const rival = meta.rival ? ` // ${meta.rival} THROUGH` : '';
    triggerMoment('pass', {
      text: `P${String(meta.previous || 0).padStart(2, '0')} → P${String(meta.rank || 0).padStart(2, '0')}${rival}`,
      danger: true,
    });
    momentTone('danger');
    return;
  }
  if (event?.kind === 'sector' || event?.kind === 'final') {
    const code = meta.code || meta.sector?.code || '';
    const name = meta.name || meta.sector?.name || '';
    triggerMoment('sector', { text: `SECTOR ${code}${name ? ` // ${name}` : ''}` });
    momentTone('sector');
  }
}

raceControl = createRaceControl({
  captionEl: hud.raceControl,
  sectors: SECTORS,
  muted: state.muted,
  getAudioContext: () => ac,
  getDecodeContext: getNarratorDecodeContext,
  onDuck: setNarratorDuck,
  onEvent: handleRaceControlEvent,
});

function persistSetupChoice(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is enhancement only; private browsing must remain playable.
  }
}

function refreshSetupPresentation() {
  const difficulty = activeDifficulty();
  const driver = activeDriver();
  const contract = activeContract();
  state.difficulty = difficulty.id;
  state.driver = driver.id;
  state.contract = contract.id;
  document.body.dataset.difficulty = difficulty.id;
  document.body.dataset.driver = driver.id;
  document.body.dataset.contract = contract.id;
  document.querySelectorAll('[data-difficulty]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.difficulty === difficulty.id));
  });
  document.querySelectorAll('[data-driver]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.driver === driver.id));
  });
  document.querySelectorAll('[data-contract]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.contract === contract.id));
  });
  hud.setupStatus.textContent = `${difficulty.label} // ${driver.name} // ${contract.label}`;
  hud.driverHud.textContent = driver.hudName;
  hud.difficultyHud.textContent = difficulty.label;
  hud.pilotSpeedLabel.textContent = driver.callsign;
  hud.start.textContent = driver.id === 'sam' ? 'Launch as Sam' : 'Initiate launch';
  paintDriverBadge(player.driverBadge, driver);
  player.driverAccentMat?.color.set(driver.accent);
  player.shieldMat?.color.set(driver.accent);
}

function applyDifficulty(id, options = {}) {
  if (!DIFFICULTY_PRESETS[id]) return false;
  if (!options.force && state.phase !== 'menu' && state.phase !== 'results') return false;
  setupSelection.difficulty = id;
  if (options.persist !== false) persistSetupChoice(STORAGE_KEYS.difficulty, id);
  refreshSetupPresentation();
  return true;
}

function applyDriver(id, options = {}) {
  if (!DRIVER_PROFILES[id]) return false;
  if (!options.force && state.phase !== 'menu' && state.phase !== 'results') return false;
  setupSelection.driver = id;
  if (options.persist !== false) persistSetupChoice(STORAGE_KEYS.driver, id);
  refreshSetupPresentation();
  return true;
}

function applyContract(id, options = {}) {
  if (!CONTRACT_PRESETS[id]) return false;
  if (!options.force && state.phase !== 'menu' && state.phase !== 'results') return false;
  setupSelection.contract = id;
  if (options.persist !== false) persistSetupChoice(STORAGE_KEYS.contract, id);
  refreshSetupPresentation();
  return true;
}

for (const button of document.querySelectorAll('[data-difficulty]')) {
  button.addEventListener('click', () => applyDifficulty(button.dataset.difficulty));
}
for (const button of document.querySelectorAll('[data-driver]')) {
  button.addEventListener('click', () => applyDriver(button.dataset.driver));
}
for (const button of document.querySelectorAll('[data-contract]')) {
  button.addEventListener('click', () => applyContract(button.dataset.contract));
}
for (const group of document.querySelectorAll('.setupChoices')) {
  const buttons = [...group.querySelectorAll('.setupOption')];
  buttons.forEach((button, index) => {
    button.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(index + direction + buttons.length) % buttons.length];
      next.focus();
      next.click();
    });
  });
}

function showSetupMenu() {
  state.phase = 'menu';
  document.body.classList.remove('race-active', 'results-active');
  hud.results.classList.remove('show');
  hud.pause.classList.remove('show');
  hud.menu.classList.add('show');
  hud.launchCue.classList.remove('live', 'battle', 'ready', 'active');
  hud.momentStamp?.classList.remove('live', 'danger');
  raceControl.reset(raceControlSnapshot());
  stopRaceMusic();
  refreshSetupPresentation();
}

refreshSetupPresentation();
const CRITICAL_NARRATOR_CLIPS = Object.freeze([
  'briefing',
  'green',
  'slingshot.ready',
  'slingshot.ready.2',
  'slingshot.ready.3',
  'slingshot.ready.4',
  'slingshot.fire',
  'slingshot.fire.2',
  'slingshot.fire.3',
  'slingshot.fire.4',
]);
const NARRATOR_WARM_PRIORITY = Object.freeze([
  'rank.up',
  'rank.down',
  'draft',
  'draft.2',
  'draft.3',
  'draft.4',
  'draft.5',
  'core',
  'core.2',
  'core.3',
  'core.4',
  'core.5',
  'core.6',
  'core.7',
  'impact',
  'impact.2',
  'impact.3',
  'impact.4',
  'impact.5',
  'sector.02',
  'sector.03',
  'leader.OPENAI',
  'shield.low',
  'core.8',
  'sector.04',
  'sector.05',
  'sector.06',
  'finish.win',
  'finish.loss',
  'shield.gone',
]);
const BACKGROUND_NARRATOR_CLIPS = Object.freeze(
  [
    ...NARRATOR_WARM_PRIORITY,
    ...Object.keys(DEFAULT_RACE_CONTROL_CLIPS)
      .filter(id =>
        !CRITICAL_NARRATOR_CLIPS.includes(id) &&
        !NARRATOR_WARM_PRIORITY.includes(id)),
  ],
);
const narratorIdle = callback => {
  if (globalThis.requestIdleCallback) {
    return globalThis.requestIdleCallback(callback, { timeout: 1400 });
  }
  return setTimeout(callback, 280);
};
let narratorWarmGeneration = 0;
function stageNarratorDecode(clipIds = BACKGROUND_NARRATOR_CLIPS) {
  const generation = ++narratorWarmGeneration;
  const batchSize = matchMedia('(pointer: coarse)').matches ? 2 : 4;
  let cursor = 0;
  const decodeNext = () => {
    if (generation !== narratorWarmGeneration || cursor >= clipIds.length) return;
    const batch = clipIds.slice(cursor, cursor + batchSize);
    cursor += batch.length;
    raceControl.prewarm({ clipIds: batch, retryFailed: true, resume: false })
      .finally(() => {
        if (generation === narratorWarmGeneration && cursor < clipIds.length) {
          narratorIdle(decodeNext);
        }
      });
  };
  narratorIdle(decodeNext);
}
raceControl.prefetch({ clipIds: CRITICAL_NARRATOR_CLIPS })
  .then(() => raceControl.predecode({
    clipIds: CRITICAL_NARRATOR_CLIPS,
    retryFailed: true,
  }))
  .then(() => {
    narratorIdle(() => raceControl.prefetch().catch(() => {}));
  })
  .catch(() => {});
function launchRace() {
  ensureAudio();
  raceControl.prewarm({ clipIds: CRITICAL_NARRATOR_CLIPS, retryFailed: true })
    .then(() => stageNarratorDecode())
    .catch(() => {});
  resetRace();
}
hud.start.addEventListener('click', launchRace);
if (showcaseMode && query.get('autostart') === '1') {
  setTimeout(launchRace, 0);
}
document.getElementById('againBtn').addEventListener('click', () => resetRace());
hud.racePb?.addEventListener('click', () => {
  if (!raceGhosts[recordKey()]) return;
  resetRace();
});
document.getElementById('setupBtn').addEventListener('click', showSetupMenu);
document.getElementById('resumeBtn').addEventListener('click', () => {
  state.phase = 'race'; hud.pause.classList.remove('show'); resumeRaceMusic();
});
document.getElementById('pauseRestart').addEventListener('click', () => { hud.pause.classList.remove('show'); resetRace(); });
hud.mute.addEventListener('click', () => setMuted(!state.muted));

const fmt = t => !isFinite(t) ? '—' : `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

function contractState(id = setupSelection.contract) {
  const contract = CONTRACT_PRESETS[id] || CONTRACT_PRESETS.sprint;
  const rank = ranking().indexOf(player) + 1;
  let progress = 0;
  let target = 1;
  let completed = false;
  let progressText = '0 / 1 COMPLETE';
  if (contract.id === 'sprint') {
    progress = player.finished && rank === 1 ? 1 : 0;
    completed = progress === 1;
    progressText = player.finished ? `FINAL CLASSIFICATION P${rank}` : `LIVE CLASSIFICATION P${rank}`;
  } else if (contract.id === 'full-payload') {
    progress = player.packets;
    target = DATA_CORES.length;
    completed = player.finished && progress >= target;
    progressText = `${progress} / ${target} DATA CORES`;
  } else if (contract.id === 'clean-uplink') {
    progress = player.cleanRun ? 1 : 0;
    completed = player.finished && player.cleanRun;
    progressText = player.cleanRun ? 'UPLINK INTEGRITY CLEAN' : 'CONTACT RECORDED';
  } else if (contract.id === 'slingshot-master') {
    progress = player.slingshots;
    target = 2;
    completed = player.finished && progress >= target;
    progressText = `${Math.min(progress, target)} / ${target} SLINGSHOTS`;
  }
  return {
    id: contract.id,
    name: contract.label,
    progress,
    target,
    completed,
    progressText,
  };
}

function contractSnapshot() {
  return {
    selected: setupSelection.contract,
    items: Object.keys(CONTRACT_PRESETS).map(id => contractState(id)),
    result: lastResult?.contract || null,
  };
}

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
  const playerIndex = order.indexOf(player);
  const selected = new Set([0, 1, 2]);
  for (const index of [playerIndex - 1, playerIndex, playerIndex + 1]) {
    if (index >= 0 && index < order.length) selected.add(index);
  }
  for (let index = 0; selected.size < Math.min(6, order.length); index++) {
    if (index < order.length) selected.add(index);
  }
  const visible = [...selected].sort((a, b) => a - b);
  let previousIndex = -1;
  const rows = [];
  for (const i of visible) {
    if (previousIndex >= 0 && i - previousIndex > 1) rows.push('<div class="tower-break" aria-hidden="true"></div>');
    previousIndex = i;
    const c = order[i];
    const col = '#' + c.spec.color.toString(16).padStart(6, '0');
    let gap;
    if (i === 0) gap = c.finished ? fmt(c.finishTime) : 'LEADER';
    else if (c.finished && lead.finished) gap = '+' + (c.finishTime - lead.finishTime).toFixed(1);
    else gap = '+' + ((lead.progress - c.progress) / Math.max(Math.hypot(lead.vA, lead.vL), 10)).toFixed(1);
    rows.push(`<div class="tower-row${c.spec.player ? ' you' : ''}" style="--lab:${col}">` +
      `<span class="rank">${String(i + 1).padStart(2, '0')}</span>` +
      '<span class="swatch"></span>' +
      `<span>${c.spec.name}</span>` +
      `<span class="gap">${gap}</span></div>`);
  }
  hud.tower.innerHTML =
    '<div class="tower-title"><span>Live lab order</span><span>Gap</span></div>' +
    rows.join('');
}

let hudClock = 0;
function nearestWakeThreat() {
  let threat = null;
  for (const other of ships) {
    if (other === player || other.finished || !other.drafting || other.draftTarget !== player) continue;
    const gap = deltaS(other.s, player.s);
    if (gap <= 3 || gap >= 32) continue;
    if (!threat || gap < threat.gap) threat = { ship: other, gap };
  }
  return threat;
}
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
  if (hud.ghostDelta) {
    const available = Boolean(activeGhost);
    const delta = available && Number.isFinite(currentGhostDelta) ? currentGhostDelta : null;
    const status = delta === null ? 'neutral' : (delta <= 0 ? 'ahead' : 'behind');
    hud.ghostDelta.dataset.available = String(available);
    hud.ghostDelta.dataset.status = status;
    hud.ghostDeltaValue.textContent = delta === null
      ? '--.--'
      : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
    hud.ghostSectorLabel.textContent = available
      ? `SECTOR ${activeSector.code} // ${status === 'ahead' ? 'GAINING' : status === 'behind' ? 'LOSING' : 'MATCHED'}`
      : 'NO PRIOR MODEL // SET THE LINE';
  }
  if (hud.touchBoost) {
    hud.touchBoost.textContent = 'BURST';
    hud.touchBoost.setAttribute('aria-label', 'inference burst');
  }
  if (hud.boostControlLabel) {
    hud.boostControlLabel.textContent = coarsePointer
      ? 'INFERENCE BURST · TAP'
      : 'INFERENCE BURST · SHIFT';
  }
  if (state.phase === 'race') {
    const wakeThreat = nearestWakeThreat();
    hud.launchCue.classList.remove('live', 'battle', 'ready', 'active');
    if (player.slingshotT > 0) {
      hud.launchCue.textContent = `SLINGSHOT // ${player.slingshotT.toFixed(1)}S`;
      hud.launchCue.classList.add('live', 'active');
      if (hud.touchBoost) {
        hud.touchBoost.textContent = 'SURGE';
        hud.touchBoost.setAttribute('aria-label', 'slingshot surge active');
      }
      if (hud.boostControlLabel) hud.boostControlLabel.textContent = 'SLINGSHOT SURGE';
    } else if (player.slingshotReady) {
      hud.launchCue.textContent = coarsePointer
        ? 'WAKE LOCKED // TAP BURST // SLINGSHOT'
        : 'WAKE LOCKED // SHIFT TO SLINGSHOT';
      hud.launchCue.classList.add('live', 'ready');
      if (hud.touchBoost) {
        hud.touchBoost.textContent = 'SLINGSHOT';
        hud.touchBoost.setAttribute('aria-label', 'deploy slingshot');
      }
      if (hud.boostControlLabel) {
        hud.boostControlLabel.textContent = coarsePointer
          ? 'SLINGSHOT · TAP BURST'
          : 'SLINGSHOT · SHIFT';
      }
    } else if (player.drafting) {
      const target = player.draftTarget?.spec?.name || 'TARGET';
      hud.launchCue.textContent = `WAKE LINK // ${target} // ${Math.round(player.draftCharge * 100)}%`;
      hud.launchCue.classList.add('live', 'battle');
    } else if (wakeThreat) {
      hud.launchCue.textContent = `${wakeThreat.ship.spec.name} LINKING // ${Math.round(wakeThreat.gap)}M`;
      hud.launchCue.classList.add('live', 'battle');
    }
    if (state.goTimer > 0) {
      state.goTimer -= 0.1;
      hud.msg.textContent = 'GO!';
      hud.msg.classList.remove('warn', 'draft', 'camera');
    }
    else {
      state.cameraLabelT = Math.max(0, state.cameraLabelT - .1);
      const wrongWay = player.wrongWay > 1.2;
      const cameraCall = !wrongWay && state.cameraLabelT > 0;
      hud.msg.textContent = wrongWay
        ? 'WRONG WAY'
        : (cameraCall
          ? `CAM // ${CAMERA_NAMES[state.cameraMode]}`
          : '');
      hud.msg.classList.toggle('warn', wrongWay);
      hud.msg.classList.toggle('camera', cameraCall);
      hud.msg.classList.remove('draft');
    }
  }
  drawMinimap();
}

function showResults() {
  state.phase = 'results';
  stopRaceMusic();
  document.body.classList.remove('race-active');
  document.body.classList.add('results-active');
  hud.launchCue.classList.remove('live', 'battle', 'ready', 'active');
  hud.momentStamp?.classList.remove('live', 'danger');
  const driver = activeDriver();
  const difficulty = activeDifficulty();
  const contract = activeContract();
  const key = recordKey();
  const previous = raceRecords[key] || null;
  const outcome = contractState();
  const resultSectorDeltas = currentSectorDeltas();
  const previousBestTime = Number.isFinite(previous?.bestTime) ? previous.bestTime : null;
  const newPersonalBest = player.finished && outcome.completed &&
    (!Number.isFinite(previous?.bestTime) || player.finishTime < previous.bestTime);
  if (player.finished) {
    raceRecords[key] = {
      bestTime: newPersonalBest ? player.finishTime : (previous?.bestTime ?? null),
      bestRank: Math.min(previous?.bestRank ?? ships.length, ranking().indexOf(player) + 1),
      bestCores: Math.max(previous?.bestCores ?? 0, player.packets),
      bestSlingshots: Math.max(previous?.bestSlingshots ?? 0, player.slingshots),
      completions: (previous?.completions ?? 0) + (outcome.completed ? 1 : 0),
    };
    try {
      localStorage.setItem(STORAGE_KEYS.records, JSON.stringify(raceRecords));
    } catch {
      // A result should never fail because local persistence is unavailable.
    }
  }
  if (newPersonalBest && ghostRecorder?.finished && !showcaseMode) {
    const savedGhost = {
      version: 1,
      seed: state.runSeed,
      difficulty: difficulty.id,
      contract: contract.id,
      bestTime: ghostRound(player.finishTime),
      samples: ghostRecorder.samples,
      boundaries: ghostRecorder.boundaries,
      recordedAt: Date.now(),
    };
    raceGhosts[key] = savedGhost;
    try {
      localStorage.setItem(STORAGE_KEYS.ghosts, JSON.stringify(raceGhosts));
    } catch {
      // Ghost replay is enhancement only; classification must still complete.
    }
  }
  const rows = ranking().map((c, i) => {
    const you = c.spec.player ? ' class="you"' : '';
    const entrant = c.spec.player ? `${c.spec.name} / ${driver.name}` : c.spec.name;
    return `<tr${you}><td>${i + 1}</td><td>${entrant}</td><td>${c.finished ? fmt(c.finishTime) : 'DNF'}</td></tr>`;
  }).join('');
  hud.resBody.innerHTML = rows;
  const rank = ranking().indexOf(player) + 1;
  document.getElementById('resTitle').textContent =
    rank === 1 ? 'COMPUTE CLAIMED' : `P${rank} // HELIOS ARRIVAL`;
  hud.resultsSub.textContent = rank === 1
    ? 'OPENAI reached the HELIOS array first'
    : `OPENAI classified P${rank} of ${ships.length}`;
  const record = raceRecords[key];
  const tributeLabel = driver.tribute ? ' // UNOFFICIAL TEXT-ONLY TRIBUTE' : '';
  hud.resultsMeta.textContent = newPersonalBest
    ? `${difficulty.label} // ${contract.label}${tributeLabel} // NEW MODEL N-1`
    : `${difficulty.label} // ${contract.label}${tributeLabel} // PB ${record?.bestTime ? fmt(record.bestTime) : '—'}`;
  const order = ranking();
  let gapText = '';
  if (player.finished && rank > 1 && order[0]?.finished) {
    gapText = ` // +${Math.max(0, player.finishTime - order[0].finishTime).toFixed(2)}S`;
  } else if (player.finished && rank === 1 && order[1]?.finished) {
    gapText = ` // ${Math.max(0, order[1].finishTime - player.finishTime).toFixed(2)}S CLEAR`;
  }
  const positionsGained = ships.length - rank;
  const movement = positionsGained > 0 ? `+${positionsGained} POSITIONS` : 'GRID HELD';
  hud.resultsStinger.textContent =
    `${outcome.completed ? 'CONTRACT SECURED' : 'CONTRACT MISSED'} // ` +
    `P${String(ships.length).padStart(2, '0')} → P${String(rank).padStart(2, '0')} // ${movement} // ${player.slingshots} SLINGSHOTS${gapText}`;
  hud.resultDriver.textContent = driver.name;
  hud.resultDifficulty.textContent = difficulty.label;
  hud.resultTime.textContent = player.finished ? fmt(player.finishTime) : 'DNF';
  hud.resultCores.textContent = `${player.packets} / ${DATA_CORES.length}`;
  hud.resultSlingshots.textContent = String(player.slingshots);
  hud.resultContract.dataset.status = outcome.completed ? 'complete' : 'failed';
  hud.resultContractName.textContent = contract.label;
  hud.resultContractStatus.textContent = outcome.completed ? 'CONTRACT COMPLETE' : 'CONTRACT FAILED';
  hud.resultContractProgress.textContent = outcome.progressText;

  for (const sector of resultSectorDeltas) {
    const item = hud.sectorBreakdownList?.querySelector(`[data-sector-code="${sector.code}"]`);
    if (!item) continue;
    item.dataset.status = sector.status === 'pending' ? 'neutral' : sector.status;
    const time = item.querySelector('[data-sector-time]');
    const delta = item.querySelector('[data-sector-delta]');
    if (time) time.textContent = sector.current === null ? '—' : fmt(sector.current);
    if (delta) {
      delta.textContent = sector.delta === null
        ? 'FIRST'
        : `${sector.delta > 0 ? '+' : '−'}${Math.abs(sector.delta).toFixed(2)}`;
    }
  }
  const totalDelta = previousBestTime === null || !player.finished
    ? null
    : player.finishTime - previousBestTime;
  hud.resultPbDelta.textContent = totalDelta === null
    ? (newPersonalBest ? 'MODEL N-1 CAPTURED' : 'NO PRIOR MODEL')
    : `${totalDelta > 0 ? '+' : '−'}${Math.abs(totalDelta).toFixed(2)} TOTAL`;
  hud.racePb.disabled = !raceGhosts[key];
  hud.racePb.dataset.available = String(Boolean(raceGhosts[key]));
  lastResult = {
    rank,
    time: player.finishTime,
    newPersonalBest,
    pbDelta: totalDelta,
    contract: outcome,
    sectors: resultSectorDeltas,
  };
  activeGhost = raceGhosts[key] || activeGhost;
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
  if (!freeze) {
    state.raceTime += DT;
    recordGhostFrame(player.finished);
  }
}

const _shipM = new THREE.Matrix4(), _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3();
const _engineColor = new THREE.Color(), _engineWhite = new THREE.Color(0xffffff);
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
    const slingshot = c.slingshotT > 0;
    const glow = 0.55 + (c.throttle || 0) * 0.72 + (c.boosting ? .86 : 0) +
      (slingshot ? .72 : 0) + c.padGlow * .72;
    _engineColor.setHex(c.spec.color)
      .lerp(_engineWhite, c.spec.player ? (slingshot ? .72 : .32) : .2)
      .multiplyScalar(.56 + glow * .64);
    for (const m of c.engines) m.color.copy(_engineColor);
    if (c.shieldMat) {
      const shieldEnergy = THREE.MathUtils.clamp(c.shield / SHIELD_MAX, 0, 1);
      c.shieldMat.opacity = c.hitWall ? .18 : (shieldEnergy < .25 ? .025 : 0);
      c.shieldMat.color.set(c.hitWall ? 0xffffff : (shieldEnergy < .3 ? 0xff654f : 0xdfff47));
    }
    // nameplates fade out near the camera so they never splat across the view
    if (c.plate) {
      const dc = Math.hypot(c.wx - camera.position.x, c.wy - camera.position.y, c.wz - camera.position.z);
      c.plate.visible = innerWidth > 700 && dc < 92;
      c.plate.material.opacity = THREE.MathUtils.clamp((dc - 18) / 34, 0, .48);
    }
    if (renderProfile.shadows) {
      const dc = Math.hypot(c.wx - player.wx, c.wy - player.wy, c.wz - player.wz);
      const casts = c === player || dc < 27;
      for (const mesh of c.shadowMeshes) mesh.castShadow = casts;
    }
  }
  if (renderProfile.shadows) {
    moon.position.set(player.wx, player.wy, player.wz).addScaledVector(MOON_DIR, 410);
    moon.target.position.set(player.wx, player.wy, player.wz);
    moon.target.updateMatrixWorld();
  }
}

let last = performance.now(), acc = 0, testMode = false, testInput = null;
let perfElapsed = 0, perfFrames = 0, perfGoodWindows = 0;
const _claimAccent = new THREE.Color();
const _claimNeutral = new THREE.Color(0x6cecff);
const _claimCoreNeutral = new THREE.Color(0xdfff47).multiplyScalar(1.15);
const _claimCoreTarget = new THREE.Color();
const _claimNodeTarget = new THREE.Color();
const _claimPanelNeutral = new THREE.Color(0x0b2453);
const _claimPanelTarget = new THREE.Color();
function updateHeliosPresentation(t) {
  const motion = renderProfile.reducedMotion ? 0 : 1;
  const elapsed = showdown.active ? showdown.elapsed : 0;
  const claimLinear = THREE.MathUtils.clamp((elapsed - .2) / 2.65, 0, 1);
  const claim = claimLinear * claimLinear * (3 - 2 * claimLinear);
  const beamLinear = THREE.MathUtils.clamp((elapsed - 3.15) / 1.35, 0, 1);
  const beamFx = beamLinear * beamLinear * (3 - 2 * beamLinear);
  const heroFx = THREE.MathUtils.clamp((elapsed - 5.1) / 2.1, 0, 1);
  _claimAccent.setHex(showdown.active ? showdown.winnerColor : 0x6cecff);
  _claimPanelTarget.copy(_claimAccent).multiplyScalar(.42);
  _claimCoreTarget.copy(_claimAccent).multiplyScalar(1.25);
  _claimNodeTarget.copy(_claimAccent).multiplyScalar(1.35);

  const finishPulse = showdown.active
    ? (motion ? .5 + .5 * Math.sin(t * 7.5) : 1)
    : 0;
  if (heliosDynamic.ring) {
    heliosDynamic.ring.rotation.z = t * (.08 + claim * .52 * motion);
    heliosDynamic.ring.material.emissive.copy(_claimNeutral).lerp(_claimAccent, claim);
    heliosDynamic.ring.material.emissiveIntensity = .35 + claim * (.35 + finishPulse * .1);
  }
  if (heliosDynamic.inner) {
    heliosDynamic.inner.rotation.z = -t * (.17 + claim * .82 * motion);
  }
  if (heliosDynamic.coreMaterial) {
    heliosDynamic.coreMaterial.color.copy(_claimCoreNeutral).lerp(_claimCoreTarget, claim);
  }
  if (heliosDynamic.ringEnergy) {
    heliosDynamic.ringEnergy.material.color.copy(_claimNeutral).lerp(_claimAccent, claim).multiplyScalar(1.05);
    heliosDynamic.ringEnergy.material.opacity = .54 + claim * .18;
    const pulse = motion ? Math.sin(t * 7) * claim * .035 : 0;
    heliosDynamic.ringEnergy.scale.setScalar(1 + pulse);
  }
  if (heliosDynamic.halo) {
    heliosDynamic.halo.material.color.copy(_claimNeutral).lerp(_claimAccent, claim);
    heliosDynamic.halo.material.opacity = .44 + claim * .26;
  }
  if (heliosDynamic.nodes?.material) {
    heliosDynamic.nodes.material.color.copy(_claimCoreNeutral).lerp(_claimNodeTarget, claim);
  }
  if (heliosDynamic.glow) {
    heliosDynamic.glow.material.color.copy(_claimNeutral).lerp(_claimAccent, claim);
    heliosDynamic.glow.material.opacity = .16 + claim * (.28 + finishPulse * .1);
    const heroScale = 90 + heroFx * 26;
    heliosDynamic.glow.scale.set(heroScale, heroScale, 1);
  }
  if (heliosDynamic.beacon) {
    heliosDynamic.beacon.color.copy(_claimCoreNeutral).lerp(_claimAccent, claim);
    heliosDynamic.beacon.intensity = 9 + claim * 25 + beamFx * 42;
  }
  if (heliosDynamic.beam) {
    heliosDynamic.beam.material.color.copy(_claimCoreNeutral).lerp(_claimAccent, claim);
    heliosDynamic.beam.material.opacity = .055 + beamFx * .38;
    heliosDynamic.beam.scale.set(1 + beamFx * .28, 1 + beamFx * 1.55, 1 + beamFx * .28);
  }
  if (heliosDynamic.claimBanner) {
    const bannerIn = THREE.MathUtils.clamp((elapsed - 1.45) / .7, 0, 1);
    heliosDynamic.claimBanner.material.opacity = bannerIn;
    heliosDynamic.claimBanner.scale.setScalar(.92 + bannerIn * .08);
  }
  heliosDynamic.claimRings.forEach((ring, i) => {
    const wave = THREE.MathUtils.clamp((elapsed - (2.05 + i * .48)) / 1.4, 0, 1);
    ring.material.color.copy(_claimAccent);
    ring.material.opacity = motion
      ? Math.sin(wave * Math.PI) * .36
      : (showdown.stationClaimed && i === 0 ? .18 : 0);
    ring.scale.setScalar(.9 + wave * (.22 + i * .025));
  });
  heliosDynamic.panels.forEach((panel, i) => {
    const cascade = THREE.MathUtils.clamp((elapsed - (.48 + i * .15)) / .82, 0, 1);
    panel.rotation.y = Math.sin(t * .16 + i * Math.PI) * .12 * motion;
    panel.material.emissive.copy(_claimPanelNeutral).lerp(_claimPanelTarget, cascade);
    panel.material.emissiveIntensity = .75 + cascade * (2.1 + finishPulse * .55);
  });
}
function monitorRenderPerformance(dt) {
  if (testMode || document.hidden || dt <= 0) return;
  // Count real stalls instead of discarding them at the simulation's 100 ms
  // safety clamp. Bound only pathological background-resume gaps.
  perfElapsed += Math.min(dt, .5);
  perfFrames++;
  if (perfElapsed < 4) return;
  const fps = perfFrames / perfElapsed;
  if (fps < 43 && adaptiveRenderScale > .62) {
    adaptiveRenderScale = Math.max(.62, adaptiveRenderScale - .1);
    perfGoodWindows = 0;
    resize();
  } else if (fps > 57 && adaptiveRenderScale < 1) {
    perfGoodWindows++;
    if (perfGoodWindows >= 3) {
      adaptiveRenderScale = Math.min(1, adaptiveRenderScale + .05);
      resize();
      perfGoodWindows = 0;
    }
  } else {
    perfGoodWindows = 0;
  }
  perfElapsed = 0;
  perfFrames = 0;
}
function frame(now) {
  requestAnimationFrame(frame);
  const frameDt = Math.max(0, (now - last) / 1000);
  let dt = Math.min(frameDt, 0.1);
  let resultsReady = false;
  last = now;
  const t = now / 1000;
  if (state.phase === 'countdown') {
    hud.launchCue.classList.add('live');
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
  } else if (state.phase !== 'race') {
    hud.launchCue.classList.remove('live');
  }
  const running = state.phase === 'race' || state.phase === 'countdown';
  if (running && !testMode) {
    acc = Math.min(acc + dt, 0.25);
    while (acc >= DT) { physicsStep(); acc -= DT; }
    if (state.phase === 'race' && player.finished) {
      if (state.finishDelay < 0) state.finishDelay = 0;
      state.finishDelay += dt;
      const presentationComplete = !showdown.active || showdown.elapsed >= 7.6;
      resultsReady = state.finishDelay >= 2.8 &&
        presentationComplete &&
        (state.finishDelay >= 8.4 || ships.every(c => c.finished));
    }
  }
  if (state.phase === 'race') advanceShowdown(dt);
  updateMoments(dt);
  syncMeshes(t);
  syncGhostVisual(t);
  for (const c of ships) updateTrail(c, dt);
  updateParticles(dt);
  updateStartLights();
  updateCamera(dt);
  // Let race control observe the finish while the simulation is still in the
  // race phase. Otherwise a last-place finish can transition straight to the
  // results screen before the classification call is detected.
  raceControl.update(raceControlSnapshot());
  if (resultsReady) showResults();
  updateAudio();
  spectacle.update({ time: t, player, ships, state });
  // animated materials
  skyMats.forEach(m => { m.uniforms.uTime.value = t; });
  earthDynamic.materials.forEach(m => {
    if (m.uniforms.uTime) m.uniforms.uTime.value = t;
  });
  updateHeliosPresentation(t);
  for (const m of window.__wallMats || []) m.uniforms.uT.value = t;
  for (const m of padMats) m.map.offset.y -= dt * 2.2;
  if (rechargeMat) rechargeMat.uniforms.uTime.value = t;
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
  post.dynamics(t, Math.hypot(player.vA, player.vL), player.boosting, player.hitWall, moments);
  renderFrame();
  monitorRenderPerformance(frameDt);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderPixelRatio = Math.max(.5, profilePixelRatio(w, h) * adaptiveRenderScale);
  renderer.setPixelRatio(renderPixelRatio);
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

function forceFinishForTest(options = {}) {
  const rank = THREE.MathUtils.clamp(Math.round(options.rank ?? 1), 1, ships.length);
  const finishTime = Math.max(1, Number(options.time ?? 42.18));
  const rivals = ships.filter(c => c !== player);
  const ordered = [...rivals.slice(0, rank - 1), player, ...rivals.slice(rank - 1)];
  ordered.forEach((c, index) => {
    c.finished = true;
    c.finishOrder = index + 1;
    c.finishTime = finishTime + (index - (rank - 1)) * .18;
    c.progress = L;
    c.lapProgress = L;
    c.lap = LAPS;
    c.cps = [false, false];
    c.vA = 0;
    c.vL = 0;
  });
  player.finishTime = finishTime;
  player.packets = THREE.MathUtils.clamp(
    Math.round(options.packets ?? player.packets),
    0,
    DATA_CORES.length,
  );
  player.cleanRun = options.cleanRun ?? player.cleanRun;
  player.slingshots = Math.max(0, Math.round(options.slingshots ?? player.slingshots));
  state.phase = 'race';
  state.raceTime = finishTime;
  state.finishDelay = 0;
  Object.assign(showdown, {
    active: false,
    elapsed: 0,
    stage: 'idle',
    winner: null,
    margin: null,
    stationClaimed: false,
    beamActive: false,
  });
  startHeliosClaim(ordered[0]);
  updateShowdownMargin();
  if (ghostRecorder) {
    ghostRecorder.boundaries = [
      0,
      ...SECTORS.slice(1).map(sector => ghostRound(finishTime * sector.f)),
      ghostRound(finishTime),
    ];
    ghostRecorder.finished = true;
    ghostRecorder.lastProgress = L;
    if (!ghostRecorder.samples.length) {
      ghostRecorder.samples.push([0, 0, player.lat, player.psi]);
    }
    ghostRecorder.samples.push([ghostRound(finishTime), ghostRound(L, 2), player.lat, player.psi]);
  }
  triggerMoment('finish', { text: `LINK ACQUIRED // P${rank}`, hold: 2.7 });
  // Deterministic force-finish tests do not have a real audio clock. Clear
  // setup chatter, register the crossing, then expose the exact classification
  // without waiting for browser playback timers.
  raceControl.clearChannelForTest();
  raceControl.update(raceControlSnapshot());
  raceControl.clearChannelForTest();
  raceControl.emitClaim(raceControlSnapshot(), { force: true });
  syncMeshes(performance.now() / 1000);
  updateHeliosPresentation(performance.now() / 1000);
  renderFrame();
  return { rank, finishTime, winner: ordered[0].spec.name };
}

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
    const t = performance.now() / 1000;
    syncMeshes(t);
    syncGhostVisual(t);
    for (const c of ships) updateTrail(c, 1 / 60);
    updateStartLights();
    if (!camFrozen) {
      if (state.phase === 'race' && player.finished && showdown.active) updateCamera(1 / 60);
      else camSnap();
    }
    hudClock = 1; updateHUD(0);
    raceControl.update(raceControlSnapshot());
    spectacle.update({ time: t, player, ships, state });
    skyMats.forEach(m => { m.uniforms.uTime.value = t; });
    earthDynamic.materials.forEach(m => {
      if (m.uniforms.uTime) m.uniforms.uTime.value = t;
    });
    updateHeliosPresentation(t);
    post.dynamics(t, Math.hypot(player.vA, player.vL), player.boosting, player.hitWall, moments);
    renderFrame();
  },
  ndcOfPlayer() {
    const v = new THREE.Vector3(player.wx, player.wy, player.wz).project(camera);
    return { x: v.x, y: v.y, z: v.z };
  },
  state() {
    return {
      phase: state.phase, s: player.s, lat: player.lat, psi: player.psi,
      difficulty: setupSelection.difficulty,
      driver: setupSelection.driver,
      contract: setupSelection.contract,
      showcase: showcaseMode,
      runSeed: state.runSeed,
      muted: state.muted,
      raceTime: state.raceTime,
      speed: Math.hypot(player.vA, player.vL), vA: player.vA, vL: player.vL,
      shield: player.shield, boost: player.boost, boosting: player.boosting, limp: player.limp,
      boostLockout: player.boostLockout, damageCooldown: player.damageCooldown,
      cleanRun: player.cleanRun,
      packets: player.packets, drafting: player.drafting,
      draftCharge: player.draftCharge,
      draftTarget: player.draftTarget?.spec?.name || null,
      slingshotReady: player.slingshotReady,
      slingshotT: player.slingshotT,
      slingshotCooldown: player.slingshotCooldown,
      slingshotSerial: player.slingshotSerial,
      slingshots: player.slingshots,
      cameraMode: state.cameraMode,
      lap: player.lap, lapProgress: player.lapProgress, progress: player.progress,
      hitWall: !!player.hitWall, finished: player.finished, finishTime: player.finishTime,
      wx: player.wx, wy: player.wy, wz: player.wz,
      ships: ships.map(c => ({
        name: c.spec.name, lap: c.lap, progress: c.progress,
        speed: Math.hypot(c.vA, c.vL), lat: c.lat, shield: c.shield, boost: c.boost,
        boosting: c.boosting, limp: c.limp, boostLockout: c.boostLockout,
        damageCooldown: c.damageCooldown, cleanRun: c.cleanRun,
        drafting: c.drafting, draftCharge: c.draftCharge,
        slingshotReady: c.slingshotReady, slingshotT: c.slingshotT,
        slingshotCooldown: c.slingshotCooldown,
        slingshotSerial: c.slingshotSerial, slingshots: c.slingshots,
      })),
    };
  },
  setDifficulty(id, options = {}) {
    return applyDifficulty(id, { persist: options.persist ?? false, force: options.force ?? true });
  },
  difficulty() { return { ...activeDifficulty() }; },
  setDriver(id, options = {}) {
    return applyDriver(id, { persist: options.persist ?? false, force: options.force ?? true });
  },
  driver() {
    return {
      ...activeDriver(),
      badgeVisible: Boolean(player.driverBadge?.mesh.visible),
      badgeName: player.driverBadge?.mesh.name || null,
    };
  },
  setContract(id, options = {}) {
    return applyContract(id, { persist: options.persist ?? false, force: options.force ?? true });
  },
  contracts() { return contractSnapshot(); },
  showcase() {
    return {
      enabled: showcaseMode,
      autoStart: showcaseMode && query.get('autostart') === '1',
    };
  },
  showdown() {
    const ringColor = heliosDynamic.ring?.material?.emissive;
    return {
      active: showdown.active,
      stage: showdown.stage,
      elapsed: showdown.elapsed,
      duration: 7.6,
      winner: showdown.winner,
      rank: showdown.rank,
      margin: showdown.margin,
      stationClaimed: showdown.stationClaimed,
      beamActive: showdown.beamActive,
      accent: `#${showdown.winnerColor.toString(16).padStart(6, '0')}`,
      ringColor: ringColor ? `#${ringColor.getHexString()}` : null,
      beamOpacity: heliosDynamic.beam?.material?.opacity ?? 0,
      bannerOpacity: heliosDynamic.claimBanner?.material?.opacity ?? 0,
      beaconIntensity: heliosDynamic.beacon?.intensity ?? 0,
    };
  },
  tickPresentation(seconds = 1 / 60) {
    const dt = Math.max(0, Number(seconds) || 0);
    advanceShowdown(dt);
    if (player.finished) state.finishDelay = Math.max(0, state.finishDelay) + dt;
    const t = performance.now() / 1000;
    updateHeliosPresentation(t);
    updateCamera(Math.min(dt, .1));
    renderFrame();
    return this.showdown();
  },
  forceFinish(options = {}) { return forceFinishForTest(options); },
  ghost() {
    return {
      available: Boolean(activeGhost),
      active: ghostVisual.group.visible,
      sampleCount: activeGhost?.samples?.length || 0,
      bestTime: activeGhost?.bestTime ?? null,
      currentDelta: currentGhostDelta,
      difficulty: setupSelection.difficulty,
      contract: setupSelection.contract,
      runSeed: state.runSeed,
    };
  },
  sectorDeltas() { return currentSectorDeltas(); },
  reset() { resetRace(); },
  armSlingshot() {
    player.boost = Math.max(player.boost, SLINGSHOT_COST + 2);
    return armSlingshot(player);
  },
  autopilot(on) { state.autopilot = !!on; },
  tickFx(dt) { updateParticles(dt); for (const c of ships) updateTrail(c, dt); },
  advanceNarratorForTest() { return raceControl.advanceChannelForTest(); },
  audio() {
    ensureAudio(); updateAudio();
    return !ac ? { built: false } : {
      built: true, ctxState: ac.state, workletUp: !!engineNode,
      freq: engineNode ? engineNode.parameters.get('freq').value : 0,
      engineGain: engineGain.gain.value, master: masterGain.gain.value,
      bed: bedGain?.gain.value ?? 0, moment: momentGain?.gain.value ?? 0,
      music: musicGain?.gain.value ?? 0,
      musicPlaying: Boolean(musicAudio && !musicAudio.paused),
      aiVoices: aiVoices.length,
    };
  },
  raceControl() { return raceControl.inspect(); },
  raceControlSnapshot,
  renderer, camera, scene, THREE, showResults, frameAt: s => JSON.parse(JSON.stringify(frameAt(s))),
  track: { length: L, halfWidth: HALF_WIDTH, samples: N, startIdx: START_IDX },
  graphics() {
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      profile: renderProfile.name,
      gpu: renderProfile.gpu,
      software: renderProfile.software,
      coarse: renderProfile.coarse,
      mobileTuned: renderProfile.mobileTuned,
      mobileTier: renderProfile.mobileTier,
      selectionReason: renderProfile.selectionReason,
      capabilities: renderProfile.capabilities,
      post: renderProfile.post,
      hdr: renderProfile.hdr,
      msaa: renderProfile.msaa,
      shadows: renderProfile.shadows,
      pixelRatio: renderPixelRatio,
      adaptiveScale: adaptiveRenderScale,
      width: db.x,
      height: db.y,
      calls: post.sceneStats.calls,
      triangles: post.sceneStats.triangles,
      points: post.sceneStats.points,
      spectacle: spectacle.stats,
    };
  },
};
window.__aiRace = testApi;
window.__zero = testApi; // compatibility with the donor game's existing regression scripts
console.log('[THE AI RACE] ready — %s labs, track %sm, elevation %s..%sm, min radius %sm, graphics %s (%s)',
  ships.length,
  L.toFixed(0),
  trackStats.elevation[0].toFixed(0), trackStats.elevation[1].toFixed(0),
  trackStats.minRadius.toFixed(1),
  renderProfile.name,
  renderProfile.gpu);
