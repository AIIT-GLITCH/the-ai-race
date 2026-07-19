# Orbital Race Control voice clips

These clips were generated specifically for this project with the open-weight
`hexgrad/Kokoro-82M` model and its generic `bm_george` voice.

- Model/weights license: Apache-2.0.
- Kokoro package version: 0.9.4.
- No reference recording, custom speaker embedding, private voice model, or
  voice clone was used.
- Source text and reproducible bake command live in
  `scripts/bake-race-control.py`.
- Output: mono 24 kHz MP3 at 64 kbps, loudness-normalized before the game's
  real-time radio EQ/compression chain.
- `broadcast-clauses.mp3` is a single-request audio sprite containing 49 short
  lab names, actions, positions, and digits. Race Control predecodes and joins
  those sample-accurate slices at runtime for exact rival, rank, slingshot, and
  finish-margin calls. Its generated timing map is checked in beside it.

Rebake:

```bash
python scripts/bake-race-control.py
```

Rebake only the compositional broadcast pack on a CUDA GPU:

```bash
python scripts/bake-race-control.py --broadcast-pack --device cuda
```

Model card and training-data notes:
<https://huggingface.co/hexgrad/Kokoro-82M/blob/main/README.md>
