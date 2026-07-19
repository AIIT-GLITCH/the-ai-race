# THE AI RACE // RACE TO ORBIT

Twelve frontier AI labs. One unclaimed orbital data center. You pilot OPENAI
across a 2.7 km, 24-meter-wide anti-gravity ribbon to claim the HELIOS compute
array before Anthropic, Google DeepMind, xAI, Meta, DeepSeek, Mistral, Qwen,
Moonshot, Cohere, MiniMax, and Microsoft AI.

The entire submission is a dependency-free static browser game: no build step,
no account, no API key, and no loading spinner.

## Run

```bash
cd /home/buddybox/ai-race-orbit
npm start
# open http://127.0.0.1:8140/
```

`python3 -m http.server` also works.

## Controls

- `W` / `↑`: thrust
- `A D` / `← →`: steer
- `S` / `↓`: brake
- `Space`: airbrake drift
- `Shift`: inference burst
- `C`: chase, wide, cockpit, and orbital-drone cameras
- `B`: recover ship
- `R`: restart
- `P` / `Esc`: pause
- `M`: mute

Standard gamepads and full touch controls are supported.

## The four-game fusion

- **Fable Zero:** load-bearing 3D manifold physics, banking, slope, anti-gravity
  ships, shield/boost economy, HDR bloom, trails, positional rival audio.
- **Codex Motorsport:** camera vocabulary, speed-responsive FOV, deterministic
  120 Hz simulation discipline, telemetry-first HUD, regression seam.
- **Apex Circuit:** cinematic race-control presentation, live start grid,
  PBR/clearcoat vocabulary, complete pause/results flow.
- **Fable GP:** stable curvature-preview rival AI, anti-wedge wall recovery,
  readable route choices, procedural audio, mobile/gamepad input coverage.

## Competition features

- One focused 40–55 second orbital sprint—fast enough to replay immediately.
- Twelve distinct rival strategies with different risk, line, look-ahead, and
  burst behavior.
- A 2,725 m spline course with 108 m of elevation, 30° banking, six named
  sectors, full-width uplink pads, and eight optional off-line data cores.
- Drafting that reduces drag and slowly charges the inference-burst meter.
- A colossal procedural orbital data center, Earth limb, compute monoliths,
  solar arrays, sector gates, data-stream tunnel, aurora, particles, and bloom.
- A priority-driven orbital race-control narrator calls stable lead changes,
  overtakes, sectors, draft links, core pickups, damage, final approach, and
  classification with baked speech, radio processing, captions, and music ducking.
- Four cameras, spatial Doppler rival engines, generative sector-aware score,
  start tones, boost roar, wind, and wall scrape.
- Desktop, keyboard, gamepad, portrait mobile, pause, restart, mute, results,
  minimap, live gaps, and no-refresh replay.

## Cinematic rendering pass

The High and Ultra profiles use a browser-safe, Portal-with-RTX-inspired
material and lighting pass: detailed PBR spacecraft surfaces, refractive
coolant cores, heat-rejection wings, emissive fixtures backed by a bounded
nearest-light reservoir, local colored bounce light, volumetric radiance
shafts, HDR bloom, ACES tone mapping, adaptive resolution, and restrained
reconstruction sharpening.

This is still WebGL raster rendering. It does not claim native path tracing,
RTXDI, ReSTIR GI, Neural Radiance Cache, DLSS, frame generation, Reflex, or
RTX IO. The visual equivalents are deliberately bounded so the same static
browser build remains playable without proprietary SDKs.

## Verification

```bash
npm run check
npm run build
npm run test:browser  # requires Playwright/Chromium
npm run test:graphics
npm run test:mobile
node scripts/rtx-a6000-qa.mjs  # optional genuine NVIDIA WebGL validation
```

The browser exposes `window.__aiRace` for deterministic simulation, state
inspection, camera tests, and hidden-tab frame capture. `window.__zero` remains
as a compatibility alias for the donor regression tooling.

## Original art and third-party code

The title key art and compute-panel material were generated specifically for
this submission with OpenAI image generation. The orbital material atlas and
environment plates were modeled and rendered locally in Blender on an RTX
A6000; their reproducible sources and reference provenance are in
`assets/rtx/README.md`. All geometry, ships, effects, UI, music, and vehicle
audio remain project-original and procedural.

Race-control speech was baked from original lines with the Apache-2.0
Kokoro-82M model and a generic stock voice—never a cloned or identity-linked
voice. The exact lines and bake script are included.

Three.js is vendored under `vendor/three.module.js` and used under the MIT
license. See `THIRD_PARTY.md`.
