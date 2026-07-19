# RTX A6000 aerospace asset pack

Original, project-local renders for the AI Race orbital-compute environment. No
online image, HDRI, texture, mesh, logo, or proprietary product design appears
in these files. Online sources were used only to understand real engineering
visual language.

## Browser assets

| File | Dimensions | Size | Intended use |
| --- | ---: | ---: | --- |
| `orbital-compute-array.webp` | 1920×1080 | 130 KB | HELIOS/finish environment plate |
| `orbital-server-trench.webp` | 1920×1080 | 108 KB | compute-sector parallax plate |
| `lunar-relay-approach.webp` | 1920×1080 | 85 KB | lunar-slingshot environment plate |
| `aerospace-surface-atlas.webp` | 2048×2048 | 262 KB | reusable spacecraft/server materials |
| `aerospace-emissive-mask.webp` | 1024×1024 | 1 KB | rack practical-light mask |
| `aerospace-roughness-mask.webp` | 1024×1024 | 370 KB | PBR roughness mask; black=smooth |

The browser also ships 1024² color quadrants and aligned 512² mask quadrants
derived from the atlas. High and Ultra load only those smaller material maps;
Balanced/mobile retains the procedural fallback.

The surface atlas uses image-space quadrants: top-left gold MLI blanket,
top-right liquid-cooled compute rack, bottom-left solar cells, bottom-right
white optical-surface radiator. Both masks align to the same quadrants at half
resolution.

## Scene briefs / prompts

Use case: `stylized-concept`, authored as physically grounded 3D rather than a
photo copy.

- **Orbital compute array:** low forward flight camera; clear racing aperture;
  pressure ring, utility truss, copper/cyan coolant trunks, liquid-cooled racks,
  segmented solar wings, white radiators, MLI service bays, Earth limb.
- **Orbital server trench:** long open-space compute corridor; symmetric rack
  rows, exposed overhead truss, cold and return manifolds, service practicals,
  Earth below; no logos or text.
- **Lunar relay approach:** compact lunar transfer station; Moon-dominant
  composition, distant Earth, roll-out solar wings, radiators, docking ring,
  solar-electric propulsion glow, open vehicle path.
- **Surface atlas:** orthographic four-quadrant aerospace material study; gold
  MLI, generic liquid-cooled rack face, solar cells, radiator/heat pipes; no
  brand-specific arrangement, labels, or marks.

## Provenance and A6000 verification

- Procedural source: `render_assets.py` (seed `420252`).
- Compression/mask source: `postprocess_assets.py`.
- Blender: official 4.4.3 Linux build, AgX color management.
- Final compute/lunar plates: Cycles, 80 samples, OptiX denoising.
- Final atlas: Cycles, 96 samples, OptiX denoising.
- Final server trench: EEVEE Next on the same NVIDIA GPU; selected because its
  Earth limb was cleaner at game-background scale.
- Cycles enumerated `NVIDIA RTX A6000` as both CUDA and OptiX, disabled the CPU,
  and logged OptiX acceleration-structure construction/device copies.
- A one-second `nvidia-smi dmon` trace during the 2048² atlas validation
  captured 98% SM utilization, about 286 W, and roughly 3.0 GiB additional
  framebuffer use. This records the render run, not a controlled benchmark;
  other resident GPU services contributed to the baseline.
- WebP quality: 84 for environment plates, 90 for the full color atlas, 86 for
  runtime color quadrants, and lossless for masks. The six master WebPs total
  under 1 MiB; the complete shipped RTX pack, including runtime derivatives,
  is about 1.5 MiB.

Example rerender:

```bash
A6000_RENDER_OUT=/tmp/ai-race-rtx \
A6000_RENDER_ENGINE=CYCLES \
A6000_RENDER_ONLY=compute,lunar,atlas \
blender --background --python assets/rtx/render_assets.py
```

`A6000_RENDER_ONLY` accepts `compute,trench,lunar,atlas`. The default engine is
`BLENDER_EEVEE_NEXT`; set `A6000_RENDER_ENGINE=CYCLES` for the OptiX path.

## Engineering reference research

- [NASA ISS components poster](https://www.nasa.gov/wp-content/uploads/2012/01/179225main_iss_poster_back.pdf):
  integrated truss, utilities, solar arrays, and heat-rejection radiators.
- [NASA Gateway overview](https://www.nasa.gov/reference/gateway-about/) and
  [Power and Propulsion Element](https://www.nasa.gov/missions/artemis/a-powerhouse-in-deep-space-gateways-power-and-propulsion-element/):
  large roll-out arrays, modular station hardware, and solar-electric
  propulsion.
- [ESA thermal-control overview](https://www.esa.int/Enabling_Support/Space_Engineering_Technology/Thermal_Control):
  visually distinctive foil MLI and white/mirror radiator surfaces.
- [NASA Mobile Launcher 1](https://www.nasa.gov/humans-in-space/exploration-ground-systems/mobile-launcher/):
  structural bracing and umbilicals for power, communications, propellant, and
  coolant.
- [NVIDIA DGX GB rack hardware guide](https://docs.nvidia.com/dgx/dgxgb200-user-guide/hardware.html):
  generic rack-scale cues such as compute/switch trays, bus bars, backplanes,
  power shelves, and liquid-cooling manifolds. No NVIDIA product geometry or
  marks were copied.
- [Google data-center gallery](https://www.google.com/about/datacenters/gallery/):
  large-bore utility and cooling-pipe organization. No gallery image was
  downloaded or embedded.

These references informed system logic, material classes, and silhouette only.
All pixels and geometry were synthesized locally by the included scripts.
