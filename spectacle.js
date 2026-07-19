// THE AI RACE — cinematic rendering layer.
//
// This module deliberately spends the GPU budget on instancing and shaders:
// tens of thousands of visible details remain a small number of draw calls.
// Software renderers and genuinely weak devices get a materially lighter path.

const PROFILES = {
  ULTRA: {
    name: 'ULTRA',
    pixelRatio: 2,
    maxPixels: 3_700_000,
    post: true,
    hdr: true,
    msaa: 4,
    bloomPasses: 3,
    wideBloom: true,
    shadows: true,
    shadowMap: 2048,
    stars: 12000,
    motes: 5200,
    modules: 280,
    portals: 46,
    trusses: 180,
    edgeLights: 720,
    solarPanels: 280,
    drones: 112,
    speedLines: 240,
    orbitalCenters: 14,
    volumetricBeams: 20,
    dynamicEmitters: 3,
    refractiveCores: true,
  },
  HIGH: {
    name: 'HIGH',
    pixelRatio: 1.5,
    maxPixels: 2_400_000,
    post: true,
    hdr: true,
    msaa: 2,
    bloomPasses: 2,
    wideBloom: true,
    shadows: true,
    shadowMap: 1536,
    stars: 7000,
    motes: 2800,
    modules: 170,
    portals: 32,
    trusses: 120,
    edgeLights: 440,
    solarPanels: 160,
    drones: 72,
    speedLines: 150,
    orbitalCenters: 9,
    volumetricBeams: 12,
    dynamicEmitters: 2,
    refractiveCores: true,
  },
  BALANCED: {
    name: 'BALANCED',
    pixelRatio: 0.9,
    maxPixels: 900_000,
    post: false,
    hdr: false,
    msaa: 0,
    bloomPasses: 0,
    wideBloom: false,
    shadows: false,
    shadowMap: 0,
    stars: 2200,
    motes: 800,
    modules: 64,
    portals: 16,
    trusses: 54,
    edgeLights: 160,
    solarPanels: 48,
    drones: 24,
    speedLines: 64,
    orbitalCenters: 4,
    volumetricBeams: 0,
    dynamicEmitters: 1,
    refractiveCores: false,
  },
};

// Keep the HIGH profile identity so the rest of the renderer retains its
// physical materials, baked hull maps, and detailed geometry. Mobile tuning
// trims expensive fill-rate features instead of throwing away the art
// direction merely because a screen is touch-capable.
const MOBILE_HIGH = {
  pixelRatio: 1.25,
  maxPixels: 1_600_000,
  post: true,
  hdr: false,
  msaa: 0,
  bloomPasses: 1,
  wideBloom: false,
  shadows: false,
  shadowMap: 0,
  stars: 5000,
  motes: 1800,
  modules: 140,
  portals: 28,
  trusses: 96,
  edgeLights: 360,
  solarPanels: 128,
  drones: 48,
  speedLines: 120,
  orbitalCenters: 8,
  volumetricBeams: 6,
  dynamicEmitters: 2,
  refractiveCores: true,
};

const MOBILE_FLAGSHIP = {
  ...MOBILE_HIGH,
  pixelRatio: 1.5,
  maxPixels: 1_900_000,
  stars: 6500,
  motes: 2400,
  modules: 160,
  portals: 30,
  trusses: 108,
  edgeLights: 410,
  solarPanels: 148,
  drones: 60,
  speedLines: 138,
  orbitalCenters: 9,
  volumetricBeams: 8,
};

function finiteCapability(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function selectRenderProfile(renderer) {
  let gpu = '';
  let floatColor = false;
  let maxSamples = 0;
  let maxTextureSize = finiteCapability(renderer.capabilities?.maxTextureSize);
  let maxTextureUnits = finiteCapability(renderer.capabilities?.maxTextures);
  const webgl2 = Boolean(renderer.capabilities?.isWebGL2);
  try {
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) || '') : '';
    floatColor = Boolean(webgl2 && gl.getExtension('EXT_color_buffer_float'));
    maxSamples = webgl2 ? Number(gl.getParameter(gl.MAX_SAMPLES) || 0) : 0;
    maxTextureSize ??= finiteCapability(
      gl.MAX_TEXTURE_SIZE === undefined ? null : gl.getParameter(gl.MAX_TEXTURE_SIZE),
    );
    maxTextureUnits ??= finiteCapability(
      gl.MAX_TEXTURE_IMAGE_UNITS === undefined ? null : gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    );
  } catch {
    gpu = '';
  }
  const software = /swiftshader|llvmpipe|software|mesa offscreen/i.test(gpu);
  const desktopClassGpu =
    /\b(?:rtx|quadro|nvidia\s+a\d{4}|radeon\s+rx|apple\s+m[1-9])\b/i.test(gpu);
  const flagshipMobileGpu =
    /adreno(?:\s*\(tm\))?\s*(?:7[3-9]\d|8\d\d)|xclipse\s*(?:9[4-9]\d)|mali(?:-|\s)*g7[1-9]\d/i.test(gpu);
  const lowClassGpu =
    /adreno(?:\s*\(tm\))?\s*(?:[3-5]\d\d|6[0-1]\d)|mali(?:-|\s)*g(?:3\d|5[0-2])|powervr\s+(?:ge8|rogue)/i.test(gpu);
  const coarse = matchMedia('(pointer: coarse)').matches;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const memory = finiteCapability(navigator.deviceMemory);
  const cores = finiteCapability(navigator.hardwareConcurrency);
  const forced = new URLSearchParams(location.search).get('quality')?.toUpperCase();
  let name;
  let selectionReason;
  let mobileTuned = false;
  if (forced && PROFILES[forced]) {
    name = forced;
    selectionReason = 'quality override';
  } else if (
    software ||
    !webgl2 ||
    lowClassGpu ||
    (memory !== null && memory <= 3) ||
    (cores !== null && cores <= 3) ||
    (maxTextureSize !== null && maxTextureSize < 4096)
  ) {
    name = 'BALANCED';
    selectionReason = software
      ? 'software renderer'
      : (!webgl2 ? 'WebGL 1 renderer' : 'low capability hardware');
  } else if (
    desktopClassGpu &&
    (memory === null || memory >= 8) &&
    (cores === null || cores >= 8)
  ) {
    // A workstation with a touch display is still a workstation. Pointer
    // precision must never demote otherwise identical hardware.
    name = 'ULTRA';
    selectionReason = 'desktop-class GPU';
  } else if (coarse) {
    name = 'HIGH';
    mobileTuned = true;
    selectionReason = flagshipMobileGpu ? 'flagship mobile GPU' : 'capable mobile hardware';
  } else if ((memory === null || memory >= 8) && (cores === null || cores >= 8)) {
    name = 'ULTRA';
    selectionReason = 'high capability hardware';
  } else {
    name = 'HIGH';
    selectionReason = 'capable hardware';
  }
  const base = mobileTuned
    ? { ...PROFILES[name], ...(flagshipMobileGpu ? MOBILE_FLAGSHIP : MOBILE_HIGH) }
    : PROFILES[name];
  return Object.freeze({
    ...base,
    hdr: base.hdr && floatColor,
    msaa: Math.min(base.msaa, maxSamples),
    gpu: gpu || 'WebGL renderer',
    software,
    reducedMotion,
    coarse,
    mobileTuned,
    mobileTier: mobileTuned ? (flagshipMobileGpu ? 'FLAGSHIP' : 'CAPABLE') : null,
    selectionReason,
    capabilities: Object.freeze({
      webgl2,
      memory,
      cores,
      maxSamples,
      maxTextureSize,
      maxTextureUnits,
      floatColor,
    }),
  });
}

function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function radialTexture(THREE, inner, mid, outer, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(0.24, mid);
  gradient.addColorStop(1, outer);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function lunarTexture(THREE) {
  const random = mulberry32(0xC0FFEE);
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const image = context.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const grain = 126 + Math.floor((random() - 0.5) * 46);
    image.data[i] = grain * 0.92;
    image.data[i + 1] = grain * 0.96;
    image.data[i + 2] = grain;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  for (let i = 0; i < 190; i++) {
    const x = random() * size;
    const y = random() * size;
    const radius = 2 + random() ** 2 * 32;
    const gradient = context.createRadialGradient(
      x - radius * 0.22, y - radius * 0.25, radius * 0.08,
      x, y, radius,
    );
    gradient.addColorStop(0, 'rgba(220,226,232,.34)');
    gradient.addColorStop(0.48, 'rgba(88,94,105,.28)');
    gradient.addColorStop(0.82, 'rgba(22,26,34,.44)');
    gradient.addColorStop(1, 'rgba(210,218,226,.12)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function loadMaterialTexture(THREE, renderer, url, srgb = false) {
  const texture = new THREE.TextureLoader().load(
    url,
    loaded => {
      loaded.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      loaded.needsUpdate = true;
    },
    undefined,
    () => console.warn(`[THE AI RACE] optional material texture unavailable: ${url}`),
  );
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function orbitalHullMaps(THREE, renderer, profile) {
  const size = profile.name === 'ULTRA' ? 512 : 256;
  const colorCanvas = document.createElement('canvas');
  const roughCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = roughCanvas.width = roughCanvas.height =
    bumpCanvas.width = bumpCanvas.height = size;
  const color = colorCanvas.getContext('2d');
  const rough = roughCanvas.getContext('2d');
  const bump = bumpCanvas.getContext('2d');
  color.fillStyle = '#9ba7b0';
  rough.fillStyle = '#a9a9a9';
  bump.fillStyle = '#808080';
  color.fillRect(0, 0, size, size);
  rough.fillRect(0, 0, size, size);
  bump.fillRect(0, 0, size, size);

  // A physically legible spacecraft skin: replaceable pressure panels,
  // fasteners, thermal-blanket seams, and directional micrometeor scoring.
  const columns = 8;
  const rows = 12;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const x0 = x * size / columns;
      const y0 = y * size / rows;
      const alternating = (x * 3 + y * 5) % 5;
      const value = 132 + alternating * 7;
      color.fillStyle = `rgb(${value},${value + 7},${value + 12})`;
      color.fillRect(x0 + 2, y0 + 2, size / columns - 4, size / rows - 4);
      color.strokeStyle = 'rgba(226,239,246,.28)';
      color.lineWidth = 1;
      color.strokeRect(x0 + 2.5, y0 + 2.5, size / columns - 5, size / rows - 5);
      rough.fillStyle = `rgb(${142 + alternating * 10},${142 + alternating * 10},${142 + alternating * 10})`;
      rough.fillRect(x0 + 3, y0 + 3, size / columns - 6, size / rows - 6);
      bump.strokeStyle = '#5f5f5f';
      bump.lineWidth = 2;
      bump.strokeRect(x0 + 2, y0 + 2, size / columns - 4, size / rows - 4);
      for (const fx of [x0 + 5, x0 + size / columns - 5]) {
        for (const fy of [y0 + 5, y0 + size / rows - 5]) {
          bump.fillStyle = '#b8b8b8';
          bump.beginPath();
          bump.arc(fx, fy, 1.15, 0, Math.PI * 2);
          bump.fill();
        }
      }
    }
  }
  const random = mulberry32(0xA6000);
  for (let i = 0; i < size * 2; i++) {
    const x = random() * size;
    const y = random() * size;
    const length = 2 + random() * 18;
    color.strokeStyle = `rgba(16,27,34,${.015 + random() * .05})`;
    color.lineWidth = random() < .08 ? 1.2 : .45;
    color.beginPath();
    color.moveTo(x, y);
    color.lineTo(x + (random() - .5) * 2, y + length);
    color.stroke();
  }
  const toTexture = (canvas, srgb = false) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };
  return {
    color: toTexture(colorCanvas, true),
    roughness: toTexture(roughCanvas),
    bump: toTexture(bumpCanvas),
  };
}

function crossedBeamGeometry(THREE) {
  // Two intersecting quads produce a convincing light volume from every racing
  // camera angle while remaining a single instanced draw call.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ], 2));
  geometry.setIndex([
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

function setInstance(mesh, index, matrix, position, quaternion, scale) {
  matrix.compose(position, quaternion, scale);
  mesh.setMatrixAt(index, matrix);
}

export function createSpectacle({
  THREE,
  renderer,
  scene,
  camera,
  track,
  halfWidth,
  profile,
}) {
  const random = mulberry32(0x51A7E11);
  // The A6000-baked atlas is split into browser-sized quadrants so each
  // material occupies only the GPU memory it needs. Balanced/mobile keeps the
  // procedural fallback and avoids these optional high-resolution maps.
  const bakedMaps = profile.name === 'BALANCED' ? null : {
    panel: loadMaterialTexture(
      THREE,
      renderer,
      'assets/materials/orbital-compute-panel-v1.webp',
      true,
    ),
    mli: loadMaterialTexture(THREE, renderer, 'assets/rtx/aerospace-mli.webp', true),
    mliRoughness: loadMaterialTexture(
      THREE,
      renderer,
      'assets/rtx/aerospace-mli-roughness.webp',
    ),
    rack: loadMaterialTexture(THREE, renderer, 'assets/rtx/aerospace-compute-rack.webp', true),
    rackRoughness: loadMaterialTexture(
      THREE,
      renderer,
      'assets/rtx/aerospace-compute-rack-roughness.webp',
    ),
    rackEmissive: loadMaterialTexture(
      THREE,
      renderer,
      'assets/rtx/aerospace-compute-rack-emissive.webp',
    ),
    solar: loadMaterialTexture(THREE, renderer, 'assets/rtx/aerospace-solar.webp', true),
    solarRoughness: loadMaterialTexture(
      THREE,
      renderer,
      'assets/rtx/aerospace-solar-roughness.webp',
    ),
    radiator: loadMaterialTexture(THREE, renderer, 'assets/rtx/aerospace-radiator.webp', true),
    radiatorRoughness: loadMaterialTexture(
      THREE,
      renderer,
      'assets/rtx/aerospace-radiator-roughness.webp',
    ),
  };
  const root = new THREE.Group();
  root.name = 'CINEMATIC_ORBITAL_WORLD';
  scene.add(root);

  const N = track.pts.length;
  const total = track.total;
  const matrix = new THREE.Matrix4();
  const basis = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const local = new THREE.Vector3();
  const colors = [0x62e8ff, 0xff63c8, 0xdfff47, 0x8d7bff, 0xffb45c];
  const emitterAnchors = [];
  const basisAt = (index, out = quaternion) => {
    const i = ((index % N) + N) % N;
    const r = track.rights[i], u = track.ups[i], t = track.tangents[i];
    // Track-space stores r=t×u for its steering convention. That frame is
    // reflected: r×u=-t, and cannot be represented by a quaternion. Negating
    // the lateral axis produces a proper rigid frame while preserving
    // Y=surface-up and Z=forward.
    basis.makeBasis(
      local.set(-r[0], -r[1], -r[2]),
      position.set(u[0], u[1], u[2]),
      scale.set(t[0], t[1], t[2]),
    );
    return out.setFromRotationMatrix(basis);
  };
  const pointAt = (index, lateral, up, along = 0, out = position) => {
    const i = ((index % N) + N) % N;
    const p = track.pts[i], r = track.rights[i], u = track.ups[i], t = track.tangents[i];
    return out.set(
      p[0] + r[0] * lateral + u[0] * up + t[0] * along,
      p[1] + r[1] * lateral + u[1] * up + t[1] * along,
      p[2] + r[2] * lateral + u[2] * up + t[2] * along,
    );
  };

  // Deep parallax star volume. The shader keeps stars crisp while the nearby
  // orbital infrastructure still exhibits real perspective motion.
  const starUniforms = { time: { value: 0 } };
  {
    const positions = new Float32Array(profile.stars * 3);
    const sizes = new Float32Array(profile.stars);
    const phases = new Float32Array(profile.stars);
    for (let i = 0; i < profile.stars; i++) {
      const z = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const radius = 1450 + random() * 1900;
      const ring = Math.sqrt(1 - z * z);
      positions[i * 3] = Math.cos(a) * ring * radius;
      positions[i * 3 + 1] = z * radius;
      positions[i * 3 + 2] = Math.sin(a) * ring * radius;
      sizes[i] = 0.6 + random() ** 5 * 3.8;
      phases[i] = random() * Math.PI * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: starUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexShader: `
        attribute float aSize; attribute float aPhase;
        uniform float time; varying float vEnergy;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vEnergy = .68 + .32 * sin(time * (.55 + fract(aPhase) * .4) + aPhase);
          gl_PointSize = aSize * (1.0 + .18 * vEnergy);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vEnergy;
        void main(){
          vec2 p = gl_PointCoord - .5;
          float core = smoothstep(.5, .02, length(p));
          float ray = smoothstep(.08, 0.0, min(abs(p.x), abs(p.y))) * smoothstep(.5, .06, max(abs(p.x), abs(p.y)));
          float a = max(core, ray * .55) * vEnergy;
          gl_FragColor = vec4(vec3(.66,.84,1.0) * (1.2 + vEnergy), a);
        }`,
    });
    const stars = new THREE.Points(geometry, material);
    stars.frustumCulled = false;
    root.add(stars);
  }

  // Monumental lunar relay: a textured moon plus two true track-spanning
  // slingshot gates. Every gate's torus lives in local XY, so mapping
  // X->track right, Y->track up, Z->track tangent makes its plane rigorously
  // perpendicular to the racing line.
  let relayMoon;
  {
    const texture = lunarTexture(THREE);
    const moonMaterial = new THREE.MeshStandardMaterial({
      map: texture,
      bumpMap: texture,
      bumpScale: 8,
      color: 0xd2d9e3,
      emissive: 0x1b2c46,
      emissiveIntensity: .72,
      roughness: 0.94,
      metalness: 0.02,
      envMapIntensity: 0.18,
    });
    relayMoon = new THREE.Mesh(new THREE.SphereGeometry(360, profile.name === 'ULTRA' ? 96 : 56, profile.name === 'ULTRA' ? 64 : 36), moonMaterial);
    relayMoon.position.set(-1010, 145, 1070);
    relayMoon.rotation.set(0.13, -0.7, -0.08);
    root.add(relayMoon);

    const ringMetal = new THREE.MeshStandardMaterial({
      color: 0x0b101a,
      emissive: 0x071321,
      emissiveIntensity: 0.7,
      metalness: 0.96,
      roughness: 0.2,
    });
    const ringGlow = new THREE.MeshBasicMaterial({
      color: 0x6cecff,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    ringGlow.color.multiplyScalar(1.9);
    const slingGates = [
      { fraction: .405, radius: halfWidth + 4, tube: 1.35, roll: -.055 },
      { fraction: .465, radius: halfWidth + 7, tube: .92, roll: .072 },
    ];
    slingGates.forEach(({ fraction, radius, tube, roll }, gateIndex) => {
      const trackIndex = Math.floor(fraction * N);
      const gatePosition = pointAt(trackIndex, 0, .45, 0, new THREE.Vector3());
      const gateQuaternion = basisAt(trackIndex, new THREE.Quaternion());
      // Roll is around local Z (the tangent), so it adds visual rhythm without
      // ever tipping the ring plane into the direction of travel.
      gateQuaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll),
      );
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 160), ringMetal);
      ring.name = `LUNAR_SLINGSHOT_GATE_${gateIndex + 1}`;
      ring.userData.trackFraction = fraction;
      ring.position.copy(gatePosition);
      ring.quaternion.copy(gateQuaternion);
      root.add(ring);
      const line = new THREE.Mesh(new THREE.TorusGeometry(radius - 1, Math.max(.34, tube * .14), 6, 160), ringGlow);
      line.position.copy(ring.position);
      line.quaternion.copy(ring.quaternion);
      root.add(line);
    });
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture(THREE, 'rgba(180,225,255,.95)', 'rgba(85,170,255,.16)', 'rgba(0,0,0,0)'),
      color: 0x8bcaff,
      transparent: true,
      opacity: .58,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }));
    halo.position.copy(relayMoon.position).add(new THREE.Vector3(0, 0, -18));
    halo.scale.setScalar(1080);
    halo.renderOrder = 6;
    root.add(halo);
  }

  // Track-local compute megacity. Each facility is assembled from chassis,
  // cooling fins, luminous racks, and antennae, but each class is one draw.
  {
    const count = profile.modules;
    const chassis = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        map: bakedMaps?.panel || null,
        color: bakedMaps ? 0xc0c8d0 : 0x111927,
        emissive: 0x06101d,
        emissiveIntensity: .65,
        metalness: .9,
        roughness: .27,
        envMapIntensity: 1.3,
      }),
      count,
    );
    const fins = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x314052,
        metalness: .82,
        roughness: .31,
        envMapIntensity: 1.05,
      }),
      count * 4,
    );
    const racks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        map: bakedMaps?.rack || null,
        roughnessMap: bakedMaps?.rackRoughness || null,
        emissiveMap: bakedMaps?.rackEmissive || null,
        color: 0xffffff,
        emissive: bakedMaps ? 0x8beeff : 0x000000,
        emissiveIntensity: bakedMaps ? 1.35 : 0,
        metalness: bakedMaps ? .72 : 0,
        roughness: bakedMaps ? .3 : .6,
        fog: true,
      }),
      count * 3,
    );
    const antennae = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(.5, .5, 1, 8),
      new THREE.MeshStandardMaterial({
        color: 0x7b8da0,
        metalness: .92,
        roughness: .24,
      }),
      count,
    );
    const moduleData = [];
    for (let i = 0; i < count; i++) {
      const index = Math.floor(random() * N);
      const side = random() < .5 ? -1 : 1;
      const lateral = side * (halfWidth + 38 + random() * 142);
      const up = -25 + random() * 105;
      const width = 7 + random() * 18;
      const height = 14 + random() ** .45 * 76;
      const depth = 8 + random() * 24;
      const q = basisAt(index, new THREE.Quaternion());
      const p = pointAt(index, lateral, up, (random() - .5) * 24, new THREE.Vector3());
      moduleData.push({ index, side, p, q, width, height, depth });
      setInstance(chassis, i, matrix, p, q, scale.set(width, height, depth));
      for (let f = 0; f < 4; f++) {
        const x = (f < 2 ? -1 : 1) * width * (.54 + (f % 2) * .07);
        const finPos = local.set(x, (f % 2 ? .12 : -.12) * height, 0).applyQuaternion(q).add(p);
        setInstance(fins, i * 4 + f, matrix, finPos, q, scale.set(.22, height * .86, depth * (.88 - (f % 2) * .12)));
      }
      for (let r = 0; r < 3; r++) {
        const rackPos = local.set(-side * width * .515, (r - 1) * height * .27, (r - 1) * depth * .18).applyQuaternion(q).add(p);
        setInstance(racks, i * 3 + r, matrix, rackPos, q, scale.set(.18, height * .14, depth * .62));
        racks.setColorAt(i * 3 + r, new THREE.Color(colors[(i + r) % colors.length]).multiplyScalar(1.45));
      }
      const antennaPos = local.set(0, height * .62, 0).applyQuaternion(q).add(p);
      setInstance(antennae, i, matrix, antennaPos, q, scale.set(.55, 5 + random() * 14, .55));
    }
    for (const mesh of [chassis, fins, racks, antennae]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    if (racks.instanceColor) racks.instanceColor.needsUpdate = true;
  }

  // RTX Remix rebuilds Portal's simple assets as physically based, high-detail
  // machinery. Our raster equivalent is a fleet of recognizable orbital data
  // centers: pressure vessels, Whipple-shield collars, exposed coolant cores,
  // heat-rejection wings, and structural spines. All repeated parts are
  // instanced, preserving the quality-tier budgets.
  const beamUniforms = { time: { value: 0 } };
  {
    const count = profile.orbitalCenters;
    const hullMaps = orbitalHullMaps(THREE, renderer, profile);
    const radialSegments = profile.name === 'ULTRA' ? 28 : (profile.name === 'HIGH' ? 20 : 12);
    const hullMaterial = profile.name === 'BALANCED'
      ? new THREE.MeshStandardMaterial({
        map: hullMaps.color,
        roughnessMap: hullMaps.roughness,
        bumpMap: hullMaps.bump,
        bumpScale: .16,
        color: 0xaab4bc,
        emissive: 0x26323a,
        emissiveIntensity: .46,
        metalness: .72,
        roughness: .46,
        envMapIntensity: .75,
      })
      : new THREE.MeshPhysicalMaterial({
        map: hullMaps.color,
        roughnessMap: hullMaps.roughness,
        bumpMap: hullMaps.bump,
        bumpScale: .22,
        color: 0xb8c3ca,
        emissive: 0x29363e,
        emissiveIntensity: .52,
        metalness: .78,
        roughness: .34,
        clearcoat: .42,
        clearcoatRoughness: .22,
        envMapIntensity: 1.55,
      });
    const insulationMaterial = new THREE.MeshPhysicalMaterial({
      map: bakedMaps?.mli || null,
      roughnessMap: bakedMaps?.mliRoughness || null,
      color: bakedMaps ? 0xd5b46e : 0x9a6b27,
      emissive: 0x241205,
      emissiveIntensity: .3,
      metalness: .86,
      roughness: .37,
      clearcoat: .18,
      envMapIntensity: 1.3,
    });
    const structuralMaterial = new THREE.MeshStandardMaterial({
      color: 0x18222d,
      emissive: 0x07121d,
      emissiveIntensity: .45,
      metalness: .94,
      roughness: .23,
      envMapIntensity: 1.7,
    });
    const collarMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xa8b7c1,
      emissive: 0x233743,
      emissiveIntensity: .58,
      metalness: .95,
      roughness: .18,
      clearcoat: .32,
      clearcoatRoughness: .14,
      envMapIntensity: 1.8,
    });
    const radiatorMaterial = new THREE.MeshPhysicalMaterial({
      map: bakedMaps?.radiator || null,
      roughnessMap: bakedMaps?.radiatorRoughness || null,
      color: bakedMaps ? 0xc2d1d8 : 0x4a6372,
      emissive: 0x17394a,
      emissiveIntensity: .82,
      metalness: .74,
      roughness: .24,
      clearcoat: .55,
      clearcoatRoughness: .14,
      envMapIntensity: 1.75,
    });
    const hulls = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, radialSegments, 1, false),
      hullMaterial,
      count * 2,
    );
    const caps = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, radialSegments, Math.max(8, radialSegments >> 1)),
      insulationMaterial,
      count * 2,
    );
    const collars = new THREE.InstancedMesh(
      new THREE.TorusGeometry(1, .085, 5, radialSegments),
      collarMaterial,
      count * 6,
    );
    const spines = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      structuralMaterial,
      count,
    );
    const radiators = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      radiatorMaterial,
      count * 4,
    );
    const coolantRails = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
      count * 8,
    );
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: false,
    });
    const cores = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(.62, .62, 1, radialSegments, 1, false),
      coreMaterial,
      count,
    );
    const glassMaterial = profile.refractiveCores
      ? new THREE.MeshPhysicalMaterial({
        color: 0xa7efff,
        emissive: 0x071e2a,
        emissiveIntensity: .42,
        metalness: 0,
        roughness: .055,
        transmission: .78,
        thickness: 1.7,
        ior: 1.32,
        clearcoat: 1,
        clearcoatRoughness: .04,
        envMapIntensity: 2.25,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      })
      : new THREE.MeshStandardMaterial({
        color: 0x82dff5,
        emissive: 0x0b3548,
        emissiveIntensity: .8,
        metalness: .1,
        roughness: .2,
        transparent: true,
        opacity: .28,
        depthWrite: false,
      });
    const glass = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(.82, .82, 1, radialSegments, 1, true),
      glassMaterial,
      count,
    );
    glass.renderOrder = 4;

    const stationData = [];
    const axialRotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI * .5,
    );
    for (let i = 0; i < count; i++) {
      const fraction = .04 + (i + .28 + random() * .38) / count * .87;
      const index = Math.floor(fraction * N);
      const side = i % 2 ? 1 : -1;
      const lateral = side * (halfWidth + 48 + random() * 44);
      // Keep the landmarks in the chase camera's upper-middle field of view at
      // a 90–130 m reveal distance; radiator wings still rise above the smaller
      // service modules around them.
      const up = 4 + random() * 18;
      const radius = 5.4 + random() * 3.1;
      const length = 31 + random() * 27;
      const panelWidth = 23 + random() * 18;
      const panelHeight = 10 + random() * 9;
      const p = pointAt(index, lateral, up, (random() - .5) * 18, new THREE.Vector3());
      const q = basisAt(index, new THREE.Quaternion());
      const axialQ = q.clone().multiply(axialRotation);
      const segmentLength = length * .35;
      const segmentOffset = length * .31;

      for (let segment = 0; segment < 2; segment++) {
        const z = (segment ? 1 : -1) * segmentOffset;
        const segmentPosition = local.set(0, 0, z).applyQuaternion(q).add(p);
        setInstance(
          hulls,
          i * 2 + segment,
          matrix,
          segmentPosition,
          axialQ,
          scale.set(radius, segmentLength, radius),
        );
      }
      for (let end = 0; end < 2; end++) {
        const z = (end ? 1 : -1) * (segmentOffset + segmentLength * .5);
        const capPosition = local.set(0, 0, z).applyQuaternion(q).add(p);
        setInstance(caps, i * 2 + end, matrix, capPosition, q, scale.setScalar(radius * 1.015));
      }
      for (let ring = 0; ring < 6; ring++) {
        const z = (ring / 5 - .5) * length * .94;
        const ringPosition = local.set(0, 0, z).applyQuaternion(q).add(p);
        setInstance(collars, i * 6 + ring, matrix, ringPosition, q, scale.setScalar(radius * 1.085));
      }
      const spinePosition = local.set(0, -radius * 1.38, 0).applyQuaternion(q).add(p);
      setInstance(spines, i, matrix, spinePosition, q, scale.set(1.05, 1.05, length * 1.24));

      for (let panel = 0; panel < 4; panel++) {
        const wing = panel % 2 ? 1 : -1;
        const z = panel < 2 ? -length * .22 : length * .22;
        const panelX = wing * (radius + panelWidth * .5 + 3.2);
        const panelPosition = local.set(panelX, 0, z).applyQuaternion(q).add(p);
        setInstance(
          radiators,
          i * 4 + panel,
          matrix,
          panelPosition,
          q,
          scale.set(panelWidth, panelHeight, .34),
        );
        radiators.setColorAt(
          i * 4 + panel,
          new THREE.Color((i + panel) % 4 === 0 ? 0x607b89 : 0x3f5968),
        );
        for (let rail = 0; rail < 2; rail++) {
          const railX = panelX + (rail ? 1 : -1) * panelWidth * .29;
          const railPosition = local.set(railX, 0, z - .22).applyQuaternion(q).add(p);
          const railIndex = i * 8 + panel * 2 + rail;
          setInstance(
            coolantRails,
            railIndex,
            matrix,
            railPosition,
            q,
            scale.set(.18, panelHeight * .84, .13),
          );
          coolantRails.setColorAt(
            railIndex,
            new THREE.Color(colors[(i + panel) % colors.length]).multiplyScalar(1.35),
          );
        }
      }

      const coreLength = length * .23;
      setInstance(cores, i, matrix, p, axialQ, scale.set(radius * .48, coreLength, radius * .48));
      setInstance(glass, i, matrix, p, axialQ, scale.set(radius * .7, coreLength * 1.06, radius * .7));
      const stationColor = new THREE.Color(colors[i % colors.length]);
      cores.setColorAt(i, stationColor.clone().multiplyScalar(1.7));
      stationData.push({ index, side, p: p.clone(), q: q.clone(), fraction, radius, length, color: stationColor });
      emitterAnchors.push({
        s: fraction * total,
        position: p.clone(),
        color: stationColor,
        power: profile.name === 'ULTRA' ? 3600 : (profile.name === 'HIGH' ? 2500 : 900),
        range: profile.name === 'BALANCED' ? 105 : 180,
      });
    }
    for (const mesh of [hulls, caps, collars, spines, radiators, coolantRails, cores, glass]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    for (const mesh of [radiators, coolantRails, cores]) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    hulls.name = 'ORBITAL_COMPUTE_PRESSURE_VESSELS';
    glass.name = 'ORBITAL_COMPUTE_REFRACTIVE_CORES';
    radiators.name = 'ORBITAL_COMPUTE_HEAT_REJECTION_ARRAYS';

    if (profile.volumetricBeams > 0) {
      const beams = new THREE.InstancedMesh(
        crossedBeamGeometry(THREE),
        new THREE.ShaderMaterial({
          uniforms: beamUniforms,
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          fog: false,
          vertexShader: `
            varying vec2 vUv; varying vec3 vColor;
            void main(){
              vUv=uv; vColor=instanceColor;
              gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);
            }`,
          fragmentShader: `
            uniform float time; varying vec2 vUv; varying vec3 vColor;
            float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
            void main(){
              float edge=pow(max(0.0,1.0-abs(vUv.x*2.0-1.0)),1.8);
              float lengthFade=smoothstep(0.0,.1,vUv.y)*(1.0-smoothstep(.68,1.0,vUv.y));
              float grain=.7+.3*hash(floor(gl_FragCoord.xy*.35)+floor(time*8.0));
              float a=edge*lengthFade*grain*.12;
              if(a<.004) discard;
              gl_FragColor=vec4(vColor*(1.1+edge*1.8),a);
            }`,
        }),
        profile.volumetricBeams,
      );
      for (let i = 0; i < profile.volumetricBeams; i++) {
        const station = stationData[i % stationData.length];
        const beamOffset = (Math.floor(i / stationData.length) - .5) * 10;
        const origin = station.p.clone().add(
          local.set(0, station.radius * .75, beamOffset).applyQuaternion(station.q),
        );
        const target = pointAt(
          station.index,
          station.side * (halfWidth + 20 + (i % 3) * 7),
          2 + (i % 2) * 7,
          beamOffset * .45,
          new THREE.Vector3(),
        );
        const direction = target.clone().sub(origin);
        const beamLength = direction.length();
        const beamQ = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          direction.normalize(),
        );
        setInstance(
          beams,
          i,
          matrix,
          origin,
          beamQ,
          scale.set(6 + (i % 4) * 2.1, beamLength, 6 + (i % 4) * 2.1),
        );
        beams.setColorAt(i, station.color.clone().multiplyScalar(1.3));
      }
      beams.instanceMatrix.needsUpdate = true;
      if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
      beams.frustumCulled = false;
      beams.renderOrder = 2;
      beams.name = 'VOLUMETRIC_RADIANCE_SHAFTS';
      root.add(beams);
    }
  }

  // Solar-compute farms fill the negative space outside the course.
  {
    const panels = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        map: bakedMaps?.solar || null,
        roughnessMap: bakedMaps?.solarRoughness || null,
        color: bakedMaps ? 0xb6d2eb : 0x173c79,
        emissive: 0x0b2d68,
        emissiveIntensity: 1.15,
        metalness: .78,
        roughness: .2,
        envMapIntensity: 1.45,
      }),
      profile.solarPanels,
    );
    const booms = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x687887, metalness: .9, roughness: .26 }),
      profile.solarPanels,
    );
    for (let i = 0; i < profile.solarPanels; i++) {
      const farm = Math.floor(i / 8);
      const index = Math.floor(((farm * 0.137 + .08) % 1) * N);
      const side = farm % 2 ? 1 : -1;
      const row = i % 8;
      const q = basisAt(index, new THREE.Quaternion());
      const p = pointAt(
        index,
        side * (halfWidth + 170 + Math.floor(row / 4) * 34),
        22 + (row % 4) * 13 + (farm % 3) * 20,
        (row % 4 - 1.5) * 18,
        new THREE.Vector3(),
      );
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -.2 + (farm % 4) * .11);
      q.multiply(tilt);
      setInstance(panels, i, matrix, p, q, scale.set(15.5, 6.4, .22));
      panels.setColorAt(i, new THREE.Color(i % 5 === 0 ? 0x294e9a : 0x173c79));
      const boomPos = local.set(0, -5.2, 0).applyQuaternion(q).add(p);
      setInstance(booms, i, matrix, boomPos, q, scale.set(.32, 10.5, .32));
    }
    panels.instanceMatrix.needsUpdate = true;
    booms.instanceMatrix.needsUpdate = true;
    if (panels.instanceColor) panels.instanceColor.needsUpdate = true;
    panels.frustumCulled = booms.frustumCulled = false;
    root.add(panels, booms);
  }

  // Accelerator portals: dark structural toroids with independent HDR cores.
  let portalGlow;
  {
    const dark = new THREE.InstancedMesh(
      new THREE.TorusGeometry(halfWidth + 3.8, .42, 8, 48),
      new THREE.MeshStandardMaterial({
        color: 0x101827,
        emissive: 0x06111c,
        emissiveIntensity: .7,
        metalness: .94,
        roughness: .24,
      }),
      profile.portals,
    );
    portalGlow = new THREE.InstancedMesh(
      new THREE.TorusGeometry(halfWidth + 3.78, .095, 5, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: .72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
      profile.portals,
    );
    const ranges = [[.05, .14], [.31, .39], [.54, .64], [.69, .77]];
    for (let i = 0; i < profile.portals; i++) {
      const range = ranges[i % ranges.length];
      const bandIndex = Math.floor(i / ranges.length);
      const bands = Math.ceil(profile.portals / ranges.length);
      const fraction = range[0] + (range[1] - range[0]) * ((bandIndex + .5) / bands);
      const index = Math.floor(fraction * N);
      const q = basisAt(index, new THREE.Quaternion());
      const p = pointAt(index, 0, .45, 0, new THREE.Vector3());
      setInstance(dark, i, matrix, p, q, scale.setScalar(1));
      setInstance(portalGlow, i, matrix, p, q, scale.setScalar(1));
      const portalColor = new THREE.Color(colors[i % colors.length]);
      portalGlow.setColorAt(i, portalColor.clone().multiplyScalar(1.45));
      emitterAnchors.push({
        s: fraction * total,
        position: p.clone(),
        color: portalColor,
        power: profile.name === 'ULTRA' ? 270 : (profile.name === 'HIGH' ? 190 : 72),
        range: 58,
      });
    }
    dark.instanceMatrix.needsUpdate = true;
    portalGlow.instanceMatrix.needsUpdate = true;
    if (portalGlow.instanceColor) portalGlow.instanceColor.needsUpdate = true;
    dark.frustumCulled = portalGlow.frustumCulled = false;
    root.add(dark, portalGlow);
  }

  // Visible underside engineering: cross-members, keels, illuminated edge
  // modules, and hundreds of orbital-tether line segments.
  {
    const trusses = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x27313c, metalness: .88, roughness: .3 }),
      profile.trusses * 2,
    );
    for (let i = 0; i < profile.trusses; i++) {
      const index = Math.floor((i / profile.trusses) * N);
      const q = basisAt(index, new THREE.Quaternion());
      const p = pointAt(index, 0, -1.95, 0, new THREE.Vector3());
      setInstance(trusses, i * 2, matrix, p, q, scale.set(halfWidth * 2 + 7, .28, .55));
      const keel = pointAt(index, 0, -5.05, 0, new THREE.Vector3());
      setInstance(trusses, i * 2 + 1, matrix, keel, q, scale.set(.48, 6.2, .48));
    }
    trusses.instanceMatrix.needsUpdate = true;
    trusses.frustumCulled = false;
    root.add(trusses);

    const lights = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
      profile.edgeLights,
    );
    for (let i = 0; i < profile.edgeLights; i++) {
      const index = Math.floor((i / profile.edgeLights) * N);
      const side = i % 2 ? 1 : -1;
      const q = basisAt(index, new THREE.Quaternion());
      const p = pointAt(index, side * (halfWidth + .64), .25, 0, new THREE.Vector3());
      setInstance(lights, i, matrix, p, q, scale.set(.16, .09, 1.25));
      lights.setColorAt(i, new THREE.Color(side < 0 ? 0x7eeeff : 0xff72d0).multiplyScalar(1.55));
    }
    lights.instanceMatrix.needsUpdate = true;
    if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
    lights.frustumCulled = false;
    root.add(lights);

    const cablePositions = new Float32Array(profile.trusses * 2 * 3);
    for (let i = 0; i < profile.trusses; i++) {
      const index = Math.floor((i / profile.trusses) * N);
      const side = i % 2 ? 1 : -1;
      const top = pointAt(index, side * (halfWidth + 2.4), -1.7, 0, new THREE.Vector3());
      const bottom = pointAt(index, side * (halfWidth + 8 + random() * 18), -42 - random() * 95, 0, new THREE.Vector3());
      cablePositions.set([top.x, top.y, top.z, bottom.x, bottom.y, bottom.z], i * 6);
    }
    const cableGeometry = new THREE.BufferGeometry();
    cableGeometry.setAttribute('position', new THREE.BufferAttribute(cablePositions, 3));
    const cables = new THREE.LineSegments(cableGeometry, new THREE.LineBasicMaterial({
      color: 0x294865,
      transparent: true,
      opacity: .38,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    }));
    root.add(cables);
  }

  // Charged motes occupy real 3D space around the ribbon and sell both scale
  // and velocity without requiring translucent volumetric meshes.
  const moteUniforms = { time: { value: 0 } };
  {
    const positions = new Float32Array(profile.motes * 3);
    const sizes = new Float32Array(profile.motes);
    const phases = new Float32Array(profile.motes);
    const moteColors = new Float32Array(profile.motes * 3);
    for (let i = 0; i < profile.motes; i++) {
      const index = Math.floor(random() * N);
      const side = random() < .5 ? -1 : 1;
      const p = pointAt(
        index,
        side * (halfWidth + 7 + random() ** .7 * 180),
        -36 + random() * 155,
        (random() - .5) * 34,
        new THREE.Vector3(),
      );
      positions.set([p.x, p.y, p.z], i * 3);
      sizes[i] = 1.3 + random() * 4.8;
      phases[i] = random() * 6.283;
      const color = new THREE.Color(colors[Math.floor(random() * colors.length)]);
      moteColors.set([color.r, color.g, color.b], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(moteColors, 3));
    const material = new THREE.ShaderMaterial({
      uniforms: moteUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexShader: `
        attribute float aSize; attribute float aPhase; attribute vec3 aColor;
        uniform float time; varying float vFade; varying vec3 vColor;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFade = .16 + .14 * sin(time * 1.7 + aPhase);
          vColor = aColor;
          gl_PointSize = clamp(aSize * (175.0 / max(-mv.z, 20.0)), .5, 7.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vFade; varying vec3 vColor;
        void main(){
          float a = smoothstep(.5, .06, length(gl_PointCoord - .5)) * vFade;
          if(a < .015) discard;
          gl_FragColor = vec4(vColor * 1.35, a);
        }`,
    });
    root.add(new THREE.Points(geometry, material));
  }

  // Autonomous traffic swarms race on elevated invisible lanes beside the
  // player. One instanced mesh is updated each frame.
  const droneSeeds = [];
  const drones = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(.72, 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
    profile.drones,
  );
  for (let i = 0; i < profile.drones; i++) {
    droneSeeds.push({
      s: random() * total,
      speed: 14 + random() * 44,
      lateral: (random() < .5 ? -1 : 1) * (halfWidth + 24 + random() * 105),
      up: 10 + random() * 74,
      scale: .45 + random() * 1.35,
    });
    drones.setColorAt(i, new THREE.Color(colors[i % colors.length]).multiplyScalar(1.7));
  }
  if (drones.instanceColor) drones.instanceColor.needsUpdate = true;
  drones.frustumCulled = false;
  root.add(drones);

  // Player-local hyperspeed vectors. Only 2 * N dynamic vertices are touched.
  const speedSeeds = [];
  const speedPositions = new Float32Array(profile.speedLines * 2 * 3);
  for (let i = 0; i < profile.speedLines; i++) {
    speedSeeds.push({
      x: (random() - .5) * 64,
      y: -4 + random() * 32,
      z: random() * 185,
      length: 2 + random() * 13,
      phase: random() * 200,
    });
  }
  const speedGeometry = new THREE.BufferGeometry();
  const speedPositionAttribute = new THREE.BufferAttribute(speedPositions, 3);
  speedPositionAttribute.setUsage(THREE.DynamicDrawUsage);
  speedGeometry.setAttribute('position', speedPositionAttribute);
  const speedMaterial = new THREE.LineBasicMaterial({
    color: 0xa8efff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const speedLines = new THREE.LineSegments(speedGeometry, speedMaterial);
  speedLines.frustumCulled = false;
  scene.add(speedLines);
  const speedBaseColor = speedMaterial.color.clone();
  const slingshotLineColor = new THREE.Color(0xe8ff8a);
  const trailBaseTints = new WeakMap();
  const slingshotTrailColor = new THREE.Color(0xf2ffc2);

  // A small number of moving lights produces expensive-looking specular motion
  // across the ships and deck without creating hundreds of real lights.
  const chaseLightPower = profile.name === 'ULTRA' ? 84 : (profile.name === 'HIGH' ? 52 : 18);
  const chaseLight = new THREE.PointLight(0x93dfff, chaseLightPower, 52, 2);
  const chaseLightBaseColor = chaseLight.color.clone();
  const boostLightPower = profile.name === 'ULTRA' ? 52 : (profile.name === 'HIGH' ? 30 : 0);
  const slingshotLightPower = profile.name === 'ULTRA' ? 112 : (profile.name === 'HIGH' ? 68 : 24);
  const boostLight = new THREE.PointLight(0xdfff47, boostLightPower, 32, 2);
  const boostLightBaseColor = boostLight.color.clone();
  const slingshotLightColor = new THREE.Color(0xf4ffd0);
  scene.add(chaseLight, boostLight);

  // RTXDI can evaluate huge light sets by resampling the most useful emitters.
  // WebGL has no RTXDI, so we mirror its artistic behavior with a tiny,
  // deterministic light reservoir: dozens of visible fixtures exist, but only
  // the nearest few become real direct lights. Shader cost is therefore fixed.
  const reservoirLights = [];
  for (let i = 0; i < profile.dynamicEmitters; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 120, 2);
    light.name = `EMISSIVE_RESERVOIR_LIGHT_${i + 1}`;
    light.userData.initialized = false;
    reservoirLights.push(light);
    scene.add(light);
  }
  // A low-energy, player-local bounce approximates the colored indirect light
  // Portal RTX gets from ReSTIR GI / NRC without applying a global color wash.
  const bounceLightPower = profile.name === 'ULTRA' ? 24 : (profile.name === 'HIGH' ? 14 : 0);
  const bounceLight = bounceLightPower > 0
    ? new THREE.PointLight(0x538cc4, bounceLightPower, 38, 2)
    : null;
  if (bounceLight) {
    bounceLight.name = 'PLAYER_LOCAL_RADIANCE_CACHE';
    scene.add(bounceLight);
  }

  const tempForward = new THREE.Vector3();
  const tempRight = new THREE.Vector3();
  const tempUp = new THREE.Vector3();
  const tempStart = new THREE.Vector3();
  const tempEnd = new THREE.Vector3();
  const tempRadianceColor = new THREE.Color();
  const neutralRadianceColor = new THREE.Color(0x7da0c8);
  const nearestEmitters = [];

  function update({ time, player, state }) {
    starUniforms.time.value = time;
    moteUniforms.time.value = time;
    beamUniforms.time.value = profile.reducedMotion ? 0 : time;
    relayMoon.rotation.y = -.7 + time * .006;
    if (portalGlow) portalGlow.material.opacity = .58 + Math.sin(time * 2.2) * .16;

    for (let i = 0; i < droneSeeds.length; i++) {
      const seed = droneSeeds[i];
      const s = (seed.s + time * seed.speed) % total;
      const index = Math.floor((s / total) * N);
      const q = basisAt(index, new THREE.Quaternion());
      const p = pointAt(index, seed.lateral, seed.up + Math.sin(time * 1.4 + i) * 2.5, 0, new THREE.Vector3());
      setInstance(drones, i, matrix, p, q, scale.setScalar(seed.scale));
    }
    drones.instanceMatrix.needsUpdate = true;

    if (!player) return;
    const index = Math.floor((((player.s % total) + total) % total) / total * N);
    const t = track.tangents[index], r = track.rights[index], u = track.ups[index];
    const cosine = Math.cos(player.psi || 0), sine = Math.sin(player.psi || 0);
    tempForward.set(
      t[0] * cosine + r[0] * sine,
      t[1] * cosine + r[1] * sine,
      t[2] * cosine + r[2] * sine,
    ).normalize();
    tempRight.set(
      r[0] * cosine - t[0] * sine,
      r[1] * cosine - t[1] * sine,
      r[2] * cosine - t[2] * sine,
    ).normalize();
    tempUp.set(u[0], u[1], u[2]).normalize();

    const speed = Math.hypot(player.vA || 0, player.vL || 0);
    const boost = player.boosting ? 1 : 0;
    // Slingshot is an authored tier above ordinary burst. It deliberately
    // reuses the existing line, trail, material, and light pools so the hotter
    // look costs no additional draws. Missing or malformed gameplay fields
    // collapse to the normal boost path.
    const slingshotTime = Number(player.slingshotT);
    const slingshot = Number.isFinite(slingshotTime) && slingshotTime > 0 ? 1 : 0;
    const playerS = ((player.s % total) + total) % total;

    nearestEmitters.length = 0;
    for (const anchor of emitterAnchors) {
      const rawDistance = Math.abs(anchor.s - playerS);
      const distance = Math.min(rawDistance, total - rawDistance);
      let insertAt = nearestEmitters.length;
      while (insertAt > 0 && nearestEmitters[insertAt - 1].distance > distance) insertAt--;
      if (insertAt < reservoirLights.length) {
        nearestEmitters.splice(insertAt, 0, { anchor, distance });
        if (nearestEmitters.length > reservoirLights.length) nearestEmitters.pop();
      }
    }
    const liveEnergy = state?.phase === 'race' || state?.phase === 'countdown' ? 1 : .56;
    for (let i = 0; i < reservoirLights.length; i++) {
      const light = reservoirLights[i];
      const selected = nearestEmitters[i];
      if (!selected) {
        light.intensity = 0;
        continue;
      }
      const { anchor, distance } = selected;
      if (!light.userData.initialized) {
        light.position.copy(anchor.position);
        light.color.copy(anchor.color);
        light.userData.initialized = true;
      } else {
        light.position.lerp(anchor.position, .16);
        light.color.lerp(anchor.color, .14);
      }
      light.distance = anchor.range;
      const proximity = 1 - Math.min(1, distance / Math.max(52, anchor.range * 1.25));
      light.intensity += (anchor.power * liveEnergy * (.12 + proximity * .88) - light.intensity) * .18;
    }
    if (bounceLight) {
      const sourceColor = nearestEmitters[0]?.anchor.color || tempRadianceColor.set(0x538cc4);
      tempRadianceColor.copy(sourceColor).lerp(neutralRadianceColor, .58);
      bounceLight.color.lerp(tempRadianceColor, .08);
      bounceLight.position.set(player.wx, player.wy, player.wz)
        .addScaledVector(tempUp, -4.6)
        .addScaledVector(tempRight, -2.3);
      bounceLight.intensity = bounceLightPower * liveEnergy *
        (.82 + boost * .18 + slingshot * .48);
    }

    const phase = (time * (42 + speed * 1.9 + slingshot * 138)) % 210;
    for (let i = 0; i < speedSeeds.length; i++) {
      const seed = speedSeeds[i];
      let z = (seed.z + seed.phase - phase) % 210;
      if (z < -28) z += 210;
      tempStart.set(player.wx, player.wy, player.wz)
        .addScaledVector(tempForward, z - 18)
        .addScaledVector(tempRight, seed.x)
        .addScaledVector(tempUp, seed.y);
      const length = seed.length * (.5 + speed / 70 + boost * .8 + slingshot * 1.65);
      tempEnd.copy(tempStart).addScaledVector(tempForward, -length);
      speedPositions.set([tempStart.x, tempStart.y, tempStart.z, tempEnd.x, tempEnd.y, tempEnd.z], i * 6);
    }
    speedPositionAttribute.needsUpdate = true;
    const speedEnergy = Math.max(0, Math.min(1, (speed - 28) / 52));
    speedMaterial.opacity = profile.reducedMotion ? 0 : Math.min(
      .94,
      (state?.phase === 'race' ? 1 : .18) *
        (speedEnergy * .12 + boost * .32 + slingshot * .5),
    );
    speedMaterial.color.copy(speedBaseColor)
      .lerp(slingshotLineColor, slingshot * .68)
      .multiplyScalar(1 + slingshot * .28);

    const trail = player.trail;
    const trailMaterial = trail?.mesh?.material;
    const trailTint = trailMaterial?.uniforms?.tint?.value;
    if (trail && Number.isFinite(trail.boostGlow)) {
      trail.boostGlow = Math.max(trail.boostGlow, boost + slingshot * 1.35);
    }
    if (trailMaterial && trailTint?.copy && trailTint?.lerp) {
      let baseTint = trailBaseTints.get(trailMaterial);
      if (!baseTint) {
        baseTint = trailTint.clone();
        trailBaseTints.set(trailMaterial, baseTint);
      }
      trailTint.copy(baseTint)
        .lerp(slingshotTrailColor, slingshot * .58)
        .multiplyScalar(1 + slingshot * .38);
    }

    chaseLight.position.set(player.wx, player.wy, player.wz)
      .addScaledVector(tempForward, -4)
      .addScaledVector(tempUp, 6);
    chaseLight.color.copy(chaseLightBaseColor).lerp(slingshotLightColor, slingshot * .34);
    chaseLight.intensity = chaseLightPower * (1 + slingshot * .42);
    chaseLight.distance = 52 + slingshot * 12;
    boostLight.position.set(player.wx, player.wy, player.wz)
      .addScaledVector(tempForward, -2.4)
      .addScaledVector(tempUp, .5);
    boostLight.color.copy(boostLightBaseColor).lerp(slingshotLightColor, slingshot * .56);
    boostLight.intensity =
      boostLightPower * (.12 + boost * .88) + slingshotLightPower * slingshot;
    boostLight.distance = 32 + slingshot * 16;
    if (portalGlow) {
      portalGlow.material.opacity = Math.min(
        .96,
        .58 + Math.sin(time * 2.2) * .16 + slingshot * .2,
      );
    }
  }

  return {
    update,
    profile,
    stats: Object.freeze({
      stars: profile.stars,
      motes: profile.motes,
      modules: profile.modules,
      portals: profile.portals,
      drones: profile.drones,
      speedLines: profile.speedLines,
      orbitalCenters: profile.orbitalCenters,
      volumetricBeams: profile.volumetricBeams,
      activeEmissiveLights: profile.dynamicEmitters,
      refractiveCores: profile.refractiveCores,
    }),
  };
}
