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

Rebake:

```bash
python scripts/bake-race-control.py
```

Model card and training-data notes:
<https://huggingface.co/hexgrad/Kokoro-82M/blob/main/README.md>
