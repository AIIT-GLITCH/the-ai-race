import { buildTrack, validateTrack } from '../track.js';
const t = buildTrack();
const v = validateTrack(t);
console.log(`length ${v.length.toFixed(0)}m, min radius ${v.minRadius.toFixed(1)}m @ [${v.minRadiusAt.map(x => x.toFixed(0))}], max slope ${v.maxSlopePct.toFixed(1)}%, elevation ${v.elevation[0].toFixed(1)}..${v.elevation[1].toFixed(1)}m, max bank ${v.maxBankDeg.toFixed(1)}°`);
for (const w of v.warnings) console.log('WARN:', w);
if (!v.ok) { for (const p of v.problems) console.error('FAIL:', p); process.exit(1); }
console.log('TRACK OK');
