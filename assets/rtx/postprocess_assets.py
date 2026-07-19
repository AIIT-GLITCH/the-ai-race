"""Compress Blender masters and derive browser-ready aerospace texture masks."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter


SOURCE = Path(os.environ.get("A6000_RENDER_OUT", "/tmp/ai-race-orbit-rtx"))
ATLAS_SOURCE = Path(os.environ.get("A6000_ATLAS_SOURCE", str(SOURCE)))
DEST = Path(__file__).resolve().parent

PLATES = (
    "orbital-compute-array",
    "orbital-server-trench",
    "lunar-relay-approach",
)


def save_webp(image: Image.Image, path: Path, quality: int, lossless: bool = False):
    image.save(
        path,
        "WEBP",
        quality=quality,
        method=6,
        lossless=lossless,
        exact=True,
    )


def process_plate(stem: str):
    image = Image.open(SOURCE / f"{stem}.png").convert("RGB")
    # A tiny contrast lift survives bloom/compositing better when the plate is
    # sampled through a color-managed WebGL texture.
    image = ImageEnhance.Contrast(image).enhance(1.035)
    save_webp(image, DEST / f"{stem}.webp", quality=84)


def process_atlas():
    source = Image.open(ATLAS_SOURCE / "aerospace-surface-atlas.png").convert("RGB")
    save_webp(source, DEST / "aerospace-surface-atlas.webp", quality=90)

    quadrants = {
        "mli": (0, 0, 1024, 1024),
        "compute-rack": (1024, 0, 2048, 1024),
        "solar": (0, 1024, 1024, 2048),
        "radiator": (1024, 1024, 2048, 2048),
    }
    for name, bounds in quadrants.items():
        save_webp(
            source.crop(bounds),
            DEST / f"aerospace-{name}.webp",
            quality=86,
        )

    mask_source = source.resize((1024, 1024), Image.Resampling.LANCZOS)
    pixels = mask_source.load()

    # Emissive details only live in the liquid-cooled rack quadrant. Restricting
    # extraction to that quadrant prevents bright MLI/radiator highlights from
    # turning into glow.
    emissive = Image.new("L", mask_source.size, 0)
    out = emissive.load()
    for y in range(512):
        for x in range(512, 1024):
            red, green, blue = pixels[x, y]
            cyan = blue > 145 and green > 135 and blue > red * 1.28
            amber = red > 155 and green > 70 and red > blue * 1.9
            if cyan or amber:
                out[x, y] = 255
    emissive = emissive.filter(ImageFilter.GaussianBlur(0.35))
    emissive = emissive.point(lambda value: min(255, value * 2))
    save_webp(emissive, DEST / "aerospace-emissive-mask.webp", quality=100, lossless=True)
    save_webp(
        emissive.crop((512, 0, 1024, 512)),
        DEST / "aerospace-compute-rack-emissive.webp",
        quality=100,
        lossless=True,
    )

    # Roughness convention: black = smooth, white = rough. Each quadrant gets
    # a physically plausible starting response, with low-amplitude grain to
    # keep broad flat faces from reading as computer-perfect.
    roughness = Image.new("L", (1024, 1024), 0)
    draw = ImageDraw.Draw(roughness)
    draw.rectangle((0, 0, 511, 511), fill=84)  # MLI
    draw.rectangle((512, 0, 1023, 511), fill=62)  # rack / black glass
    draw.rectangle((0, 512, 511, 1023), fill=48)  # solar-cell cover glass
    draw.rectangle((512, 512, 1023, 1023), fill=142)  # radiator optical surface
    grain = Image.effect_noise((1024, 1024), 12).point(lambda value: int(value * 0.12))
    roughness = ImageChops.add(roughness, grain, scale=1.0, offset=-8)
    save_webp(roughness, DEST / "aerospace-roughness-mask.webp", quality=100, lossless=True)
    roughness_quadrants = {
        "mli": (0, 0, 512, 512),
        "compute-rack": (512, 0, 1024, 512),
        "solar": (0, 512, 512, 1024),
        "radiator": (512, 512, 1024, 1024),
    }
    for name, bounds in roughness_quadrants.items():
        save_webp(
            roughness.crop(bounds),
            DEST / f"aerospace-{name}-roughness.webp",
            quality=100,
            lossless=True,
        )


def report():
    for path in sorted(DEST.glob("*.webp")):
        with Image.open(path) as image:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
            print(
                f"{path.name}: {image.width}x{image.height} {image.mode}; "
                f"{path.stat().st_size} bytes; sha256 {digest}"
            )


if __name__ == "__main__":
    for plate in PLATES:
        process_plate(plate)
    process_atlas()
    report()
