// THE AI RACE — cinematic rendering layer.
//
// This module deliberately spends the GPU budget on instancing and shaders:
// tens of thousands of visible details remain a small number of draw calls.
// Software renderers and coarse-pointer devices get a materially lighter path.

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
  },
};

export function selectRenderProfile(renderer) {
  let gpu = '';
  let floatColor = false;
  let maxSamples = 0;
  try {
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) || '') : '';
    floatColor = Boolean(renderer.capabilities.isWebGL2 && gl.getExtension('EXT_color_buffer_float'));
    maxSamples = renderer.capabilities.isWebGL2 ? Number(gl.getParameter(gl.MAX_SAMPLES) || 0) : 0;
  } catch {
    gpu = '';
  }
  const software = /swiftshader|llvmpipe|software|mesa offscreen/i.test(gpu);
  const coarse = matchMedia('(pointer: coarse)').matches;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const memory = Number(navigator.deviceMemory || 8);
  const cores = Number(navigator.hardwareConcurrency || 8);
  const forced = new URLSearchParams(location.search).get('quality')?.toUpperCase();
  let name;
  if (forced && PROFILES[forced]) name = forced;
  else if (software || coarse || memory <= 3 || cores <= 3) name = 'BALANCED';
  else if (memory >= 8 && cores >= 8) name = 'ULTRA';
  else name = 'HIGH';
  const base = PROFILES[name];
  return Object.freeze({
    ...base,
    hdr: base.hdr && floatColor,
    msaa: Math.min(base.msaa, maxSamples),
    gpu: gpu || 'WebGL renderer',
    software,
    reducedMotion,
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
  const basisAt = (index, out = quaternion) => {
    const i = ((index % N) + N) % N;
    const r = track.rights[i], u = track.ups[i], t = track.tangents[i];
    basis.makeBasis(
      local.set(r[0], r[1], r[2]),
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

  // Monumental lunar relay: a textured moon, two orbital accelerator rings,
  // and an HDR halo. It is intentionally hundreds of metres across.
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
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    ringGlow.color.multiplyScalar(1.9);
    for (const [radius, tube, tiltX, tiltY] of [[470, 4.8, 1.08, .18], [520, 1.8, .83, -.38]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 160), ringMetal);
      ring.position.copy(relayMoon.position);
      ring.rotation.set(tiltX, tiltY, .35);
      root.add(ring);
      const line = new THREE.Mesh(new THREE.TorusGeometry(radius - 1, Math.max(.34, tube * .14), 6, 160), ringGlow);
      line.position.copy(ring.position);
      line.rotation.copy(ring.rotation);
      line.renderOrder = 7;
      root.add(line);
    }
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
        color: 0x111927,
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
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }),
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

  // Solar-compute farms fill the negative space outside the course.
  {
    const panels = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x173c79,
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
      portalGlow.setColorAt(i, new THREE.Color(colors[i % colors.length]).multiplyScalar(1.45));
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

  // A small number of moving lights produces expensive-looking specular motion
  // across the ships and deck without creating hundreds of real lights.
  const chaseLight = new THREE.PointLight(
    0x93dfff,
    profile.name === 'ULTRA' ? 84 : (profile.name === 'HIGH' ? 52 : 18),
    52,
    2,
  );
  const boostLightPower = profile.name === 'ULTRA' ? 52 : (profile.name === 'HIGH' ? 30 : 0);
  const boostLight = new THREE.PointLight(0xdfff47, boostLightPower, 32, 2);
  scene.add(chaseLight, boostLight);

  const tempForward = new THREE.Vector3();
  const tempRight = new THREE.Vector3();
  const tempUp = new THREE.Vector3();
  const tempStart = new THREE.Vector3();
  const tempEnd = new THREE.Vector3();

  function update({ time, player, state }) {
    starUniforms.time.value = time;
    moteUniforms.time.value = time;
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
    const phase = (time * (42 + speed * 1.9)) % 210;
    for (let i = 0; i < speedSeeds.length; i++) {
      const seed = speedSeeds[i];
      let z = (seed.z + seed.phase - phase) % 210;
      if (z < -28) z += 210;
      tempStart.set(player.wx, player.wy, player.wz)
        .addScaledVector(tempForward, z - 18)
        .addScaledVector(tempRight, seed.x)
        .addScaledVector(tempUp, seed.y);
      const length = seed.length * (.5 + speed / 70 + boost * .8);
      tempEnd.copy(tempStart).addScaledVector(tempForward, -length);
      speedPositions.set([tempStart.x, tempStart.y, tempStart.z, tempEnd.x, tempEnd.y, tempEnd.z], i * 6);
    }
    speedPositionAttribute.needsUpdate = true;
    const speedEnergy = Math.max(0, Math.min(1, (speed - 28) / 52));
    speedMaterial.opacity = profile.reducedMotion ? 0 :
      (state?.phase === 'race' ? 1 : .18) * (speedEnergy * .12 + boost * .32);

    chaseLight.position.set(player.wx, player.wy, player.wz)
      .addScaledVector(tempForward, -4)
      .addScaledVector(tempUp, 6);
    boostLight.position.set(player.wx, player.wy, player.wz)
      .addScaledVector(tempForward, -2.4)
      .addScaledVector(tempUp, .5);
    boostLight.intensity = boostLightPower * (.12 + boost * .88);
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
    }),
  };
}
