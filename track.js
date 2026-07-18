// THE AI RACE — 3D orbital ribbon geometry. Pure math, no three.js, importable
// from Node
// for validation (npm run check).
//
// Conventions (shared with game.js):
//   Each sample carries a full frame: pos, tangent t, up u, right r = t x u.
//   With t=(0,0,1), u=(0,1,0): r=(-1,0,0) — the same "right" algebra fable-gp
//   used in 2D, lifted to 3D.
//   Geodesic curvature k = -(dT/ds · r); k>0 means the track turns LEFT
//   (matches fable-gp's sign). Lateral coordinate is signed distance along r.
//   Bank angle phi (radians): the frame's up is rotated around t by phi.
//   phi>0 tilts up toward +r, i.e. raises the -r edge — that banks RIGHT
//   turns (k<0). Properly banked corners have sign(bank) == -sign(k) — the
//   validator checks this, because banking is load-bearing physics here
//   (gravity's lateral component g*sin(phi) fights centrifugal k*v^2).

export const HALF_WIDTH = 12;     // a deliberately huge 24m-wide orbital ribbon
export const WALL_OFFSET = 1.2;   // energy walls sit this far beyond the deck edge
export const SAMPLES = 2200;

// Control points: [x, y, z, bankDeg].
// A 2.6km orbital transfer ribbon. It starts on the low launch deck, climbs
// through the terminator, crests beside the lunar relay, then dives through
// the data stream and returns to the HELIOS compute array.
const CONTROL = [
  // HELIOS launch / finish straight
  [-60, 70, -410, 0],
  [135, 72, -414, 0],
  // atmosphere climb
  [300, 84, -372, 10],
  [410, 100, -242, 22],
  [442, 118, -72, 24],
  [420, 138, 104, 12],
  // lunar relay crest
  [354, 155, 236, 18],
  [222, 170, 330, 13],
  [62, 178, 364, -7],
  [-94, 172, 332, -9],
  [-242, 160, 352, 7],
  // deep-space bank and solar dive
  [-354, 145, 298, 20],
  [-432, 125, 176, 30],
  [-423, 105, 18, 23],
  [-382, 90, -142, 7],
  // data-stream descent into the array
  [-302, 80, -272, 0],
  [-212, 74, -350, 8],
  [-116, 72, -397, 10],
];

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [
    f(p0[0], p1[0], p2[0], p3[0]),
    f(p0[1], p1[1], p2[1], p3[1]),
    f(p0[2], p1[2], p2[2], p3[2]),
    f(p0[3], p1[3], p2[3], p3[3]),
  ];
}

const norm3 = v => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1e-9;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function buildTrack() {
  const n = CONTROL.length;
  const raw = [];
  const per = Math.ceil((SAMPLES * 2) / n); // oversample, then arclength-resample
  for (let i = 0; i < n; i++) {
    const p0 = CONTROL[(i - 1 + n) % n], p1 = CONTROL[i];
    const p2 = CONTROL[(i + 1) % n], p3 = CONTROL[(i + 2) % n];
    for (let j = 0; j < per; j++) raw.push(catmullRom(p0, p1, p2, p3, j / per));
  }

  // resample to uniform arclength (3D distance)
  const cum = [0];
  for (let i = 1; i <= raw.length; i++) {
    const a = raw[i - 1], b = raw[i % raw.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cum[raw.length];
  const pts = [], bank = [];
  let seg = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const target = (i / SAMPLES) * total;
    while (seg < raw.length - 1 && cum[seg + 1] < target) seg++;
    const a = raw[seg], b = raw[(seg + 1) % raw.length];
    const t = (target - cum[seg]) / Math.max(cum[seg + 1] - cum[seg], 1e-9);
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    bank.push(((a[3] + (b[3] - a[3]) * t) * Math.PI) / 180);
  }

  const step = total / SAMPLES;
  const tangents = [], ups = [], rights = [], curvature = [], slope = [];
  for (let i = 0; i < SAMPLES; i++) {
    const prev = pts[(i - 1 + SAMPLES) % SAMPLES], next = pts[(i + 1) % SAMPLES];
    const t = norm3([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]);
    tangents.push(t);
    slope.push(t[1]);
    // base up: world up made perpendicular to t, then rotated around t by bank
    const bu = norm3([-t[0] * t[1], 1 - t[1] * t[1], -t[2] * t[1]]);
    const br = cross3(t, bu); // right before banking
    const c = Math.cos(bank[i]), s = Math.sin(bank[i]);
    const u = [bu[0] * c + br[0] * s, bu[1] * c + br[1] * s, bu[2] * c + br[2] * s];
    ups.push(u);
    rights.push(cross3(t, u));
  }
  for (let i = 0; i < SAMPLES; i++) {
    const a = tangents[(i - 1 + SAMPLES) % SAMPLES], b = tangents[(i + 1) % SAMPLES];
    const dT = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    curvature.push(-dot3(dT, rights[i]) / (2 * step)); // k>0 = turning left
  }

  return { pts, tangents, ups, rights, curvature, bank, slope, total, step };
}

// Nearest-sample lookup with a windowed search around a cached index.
// Returns { idx, lateral, along, height } in the sample's frame.
export function nearestSample(track, x, y, z, hintIdx) {
  const { pts } = track;
  const N = pts.length;
  let best = -1, bestD = Infinity;
  const scan = (from, to) => {
    for (let k = from; k <= to; k++) {
      const i = ((k % N) + N) % N;
      const dx = x - pts[i][0], dy = y - pts[i][1], dz = z - pts[i][2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
  };
  if (hintIdx == null) scan(0, N - 1);
  else {
    scan(hintIdx - 40, hintIdx + 40);
    if (bestD > 45 * 45) { best = -1; bestD = Infinity; scan(0, N - 1); } // lost: full search
  }
  const i = best;
  const r = track.rights[i], t = track.tangents[i], u = track.ups[i];
  const dx = x - pts[i][0], dy = y - pts[i][1], dz = z - pts[i][2];
  return {
    idx: i,
    lateral: dx * r[0] + dy * r[1] + dz * r[2],
    along: dx * t[0] + dy * t[1] + dz * t[2],
    height: dx * u[0] + dy * u[1] + dz * u[2],
  };
}

export function validateTrack(track) {
  const { pts, tangents, ups, rights, curvature, bank, slope, total, step } = track;
  const problems = [], warnings = [];
  const N = pts.length;

  let minR = Infinity, minRAt = 0;
  for (let i = 0; i < N; i++) {
    const r = 1 / Math.max(Math.abs(curvature[i]), 1e-9);
    if (r < minR) { minR = r; minRAt = i; }
  }
  if (minR < HALF_WIDTH * 2.2) {
    problems.push(`min radius ${minR.toFixed(1)}m too tight for half-width ${HALF_WIDTH}m (sample ${minRAt})`);
  }
  for (let i = 0; i < N; i++) {
    if (Math.abs(curvature[i]) * HALF_WIDTH >= 1) {
      problems.push(`edge inversion at sample ${i} (k=${curvature[i].toFixed(4)})`);
      break;
    }
  }

  // slope limit (AG ships climb, but the deck should stay sane)
  let maxSlope = 0, maxSlopeAt = 0;
  for (let i = 0; i < N; i++) {
    if (Math.abs(slope[i]) > maxSlope) { maxSlope = Math.abs(slope[i]); maxSlopeAt = i; }
  }
  if (maxSlope > 0.16) problems.push(`slope ${(maxSlope * 100).toFixed(1)}% too steep at sample ${maxSlopeAt}`);

  // bank sanity: properly banked corners have sign(bank) == -sign(k)
  let adverse = 0;
  for (let i = 0; i < N; i++) {
    if (Math.abs(curvature[i]) > 0.012 && Math.abs(bank[i]) > 0.06 &&
        Math.sign(bank[i]) === Math.sign(curvature[i])) adverse++;
  }
  if (adverse > N * 0.02) warnings.push(`${adverse} samples with adverse camber (bank leaning INTO centrifugal force)`);
  let maxBank = 0;
  for (let i = 0; i < N; i++) maxBank = Math.max(maxBank, Math.abs(bank[i]));
  if (maxBank > Math.PI / 4) problems.push(`bank ${(maxBank * 180 / Math.PI).toFixed(0)}° exceeds 45° frame limit`);

  // frame orthonormality
  for (let i = 0; i < N; i += 7) {
    const t = tangents[i], u = ups[i], r = rights[i];
    const d1 = Math.abs(t[0] * u[0] + t[1] * u[1] + t[2] * u[2]);
    const lr = Math.hypot(r[0], r[1], r[2]);
    if (d1 > 0.02 || Math.abs(lr - 1) > 0.02) {
      problems.push(`frame degenerate at sample ${i} (t·u=${d1.toFixed(3)}, |r|=${lr.toFixed(3)})`);
      break;
    }
  }

  // self-intersection in 3D: distant samples must keep clearance (or vertical gap)
  const minGap = Math.round((HALF_WIDTH * 2.6) / step);
  for (let i = 0; i < N; i++) {
    for (let j = i + minGap; j < N; j += 3) {
      if (Math.min(j - i, N - (j - i)) < minGap) continue;
      const dx = pts[i][0] - pts[j][0], dz = pts[i][2] - pts[j][2];
      const dy = Math.abs(pts[i][1] - pts[j][1]);
      if (dx * dx + dz * dz < (HALF_WIDTH * 2.3) ** 2 && dy < 9) {
        problems.push(`track folds: samples ${i} and ${j} are ${Math.hypot(dx, dz).toFixed(1)}m apart (dy ${dy.toFixed(1)}m)`);
        i = N; break;
      }
    }
  }

  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }

  return {
    ok: problems.length === 0, problems, warnings,
    minRadius: minR, minRadiusAt: pts[minRAt], length: total,
    maxSlopePct: maxSlope * 100, elevation: [minY, maxY],
    maxBankDeg: maxBank * 180 / Math.PI,
  };
}
