# THE AI RACE // RACE TO ORBIT

Twelve frontier AI labs. One unclaimed orbital data center. You drive OPENAI
as the neutral ORBIT-01 pilot or an optional text-only Sam Altman tribute role
across a 2.7 km, 24-meter-wide anti-gravity ribbon to claim the HELIOS compute
array before Anthropic, Google DeepMind, xAI, Meta, DeepSeek, Mistral, Qwen,
Moonshot, Cohere, AIIT-Threshold, and Microsoft AI.

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
- `Shift`: inference burst; fresh-press it when a wake lock is armed to launch a
  slingshot
- `C`: chase, wide, cockpit, and orbital-drone cameras
- `B`: recover ship
- `R`: restart
- `P` / `Esc`: pause
- `M`: mute

Standard gamepads and full touch controls are supported.

For a judged demo, `?showcase=1` opens the Pro/Sam/Sprint setup with the normal
twelve-car starting grid. Add `&autostart=1` to launch the hand-staged final
showdown: OPENAI starts 17 m behind ANTHROPIC with the wake and slingshot armed.
Showcase runs never read or overwrite personal-best ghost data.

## Race setup

- **Rookie:** calmer rivals, stronger grip and edge assistance, faster shield
  recovery, gentler contact penalties, and one rival slingshot each.
- **Pro:** the intended balance, with reduced passive recovery, less burst grip,
  harder contact, and up to two slingshots per rival.
- **Apex:** faster cornering and overtakes, no edge assist or passive shield
  recovery, the harshest burst/contact economy, and up to three rival
  slingshots.
- **Driver:** choose ORBIT-01 or the text-only Sam Altman tribute role. The
  Sam option changes the ship credential, HUD, and results presentation only.
  It uses no likeness, endorsement claim, or cloned voice.

Preferences persist locally. Personal bests and the deterministic MODEL N-1
hologram are tracked separately for each difficulty-and-contract pairing. The
results screen compares all six sectors, supports a one-tap `Race My PB`
rematch, immediate replay, and returning to setup.

## Mission contracts

- **Sprint:** win the race.
- **Full Payload:** collect all eight data cores.
- **Clean Uplink:** finish without wall or rival contact.
- **Slingshot Master:** deploy at least two charged slingshots.

Every contract creates its own progression lane: complete a first run to record
MODEL N-1, then race the non-colliding holographic replay with a live time delta
and sector-by-sector gains or losses.

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
- Wake-lock drafting that reduces drag and charges a separate slingshot. Hold a
  clean line behind a rival until `WAKE LOCKED`, then release and fresh-press
  `Shift` to spend the lock on a short attack surge. Rival ships earn and deploy
  the same move rather than receiving a player-only speed trick.
- Contact is costly racecraft: a real wall or ship hit scrubs speed, spills
  burst energy, breaks the wake lock, and briefly locks out boosting. A depleted
  shield puts the craft into limp mode, where inference bursts cannot fire.
- A colossal procedural orbital data center, Earth limb, compute monoliths,
  solar arrays, sector gates, data-stream tunnel, aurora, particles, and bloom.
- A 7.6-second HELIOS takeover sequence gives the winner a real payoff:
  ownership handshake, rack-light cascade, array-claim banner, orbital energy
  beam, expanding claim rings, and a dedicated station-to-hero camera cut.
- A priority-driven orbital race-control narrator composes exact calls from a
  predecoded 49-clause generic speech sprite: named leader changes, named
  passes and losses, slingshot targets, sectors, cores, damage, and a precise
  winner-plus-margin HELIOS claim. Radio processing, captions, music ducking,
  and deterministic browser-speech fallback keep it immediate without a cloud
  request or identity-linked voice.
- Four cameras, spatial Doppler rival engines, generative sector-aware score,
  start tones, boost roar, wind, and wall scrape.
- Desktop, keyboard, gamepad, portrait mobile, pause, restart, mute, results,
  contextual live gaps, minimap, per-contract records, MODEL N-1 ghost racing,
  and no-refresh replay.

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
browser build remains playable without proprietary SDKs. Launch, contact,
overtake, sector, slingshot, and finish drama is directed through existing
camera, lighting, post-processing, trail, and HUD envelopes—no extra scene draw
calls. Automated checks cap the launch at 280 draw calls and the course at 220.

## Verification

```bash
npm run check
npm run build
npm run test:showdown # HELIOS, contracts, exact narration, and PB ghost
npm run test:browser  # requires Playwright/Chromium
npm run test:options
npm run test:graphics
npm run test:mobile
node scripts/rtx-a6000-qa.mjs  # optional genuine NVIDIA WebGL validation
```

The browser exposes `window.__aiRace` for deterministic simulation, state
inspection, camera tests, and hidden-tab frame capture. `window.__zero` remains
as a compatibility alias for the donor regression tooling.

## How Codex and GPT-5.6 were used

Codex and GPT-5.6 were the project’s engineering and critique environment
across the main build sessions. GPT-5.6 helped turn the creative direction into
concrete systems, interrogate weak spots in the race loop, compare design
options, and refine the visual, mobile, narration, performance, and replay
priorities. Codex worked directly in the shared codebase to implement those
decisions, coordinate focused parallel reviews, create deterministic test
seams, run browser and genuine RTX A6000 validation, fix regressions, package
the exact source state, and deploy verified production versions.

Human direction established the concept, fictional setting, desired feel,
feature priorities, public-figure boundaries, and final acceptance decisions.
The shipped game does not call GPT-5.6 at runtime; it remains a static,
instant-play browser build.

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

## License

The AI Race source is released under the [MIT License](LICENSE). Copyright
2026 AIIT-THRESHOLD LLC.
