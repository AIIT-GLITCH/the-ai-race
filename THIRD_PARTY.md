# Third-party notices

## Three.js

Copyright © 2010–2026 three.js authors.

Licensed under the MIT License:
https://github.com/mrdoob/three.js/blob/dev/LICENSE

The vendored browser module is `vendor/three.module.js`. Its source header also
contains the MIT notice.

## Kokoro-82M

The original Orbital Race Control lines under `assets/race-control/` were
synthesized from the `hexgrad/Kokoro-82M` model repository with the Kokoro
Python package version 0.9.4 and its generic `bm_george` voice. Model weights
are licensed under Apache License 2.0:

https://huggingface.co/hexgrad/Kokoro-82M

No Kokoro model weights or runtime code are shipped to the browser. No custom
voice, reference recording, speaker embedding, or identity-linked clone was
used. The deterministic source lines and optional rebake script are included
at `scripts/bake-race-control.py`.

No third-party vehicle, logo, music, photograph, mesh, or texture asset is
included. NASA, ESA, NVIDIA, and data-center imagery was used only as visual
engineering research; all shipped pixels and geometry are original.
