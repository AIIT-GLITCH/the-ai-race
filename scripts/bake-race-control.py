#!/usr/bin/env python3
"""Bake the original Orbital Race Control clip library with Kokoro-82M.

Runtime dependencies are intentionally not part of the browser game:

    pip install "kokoro==0.9.4" soundfile

Kokoro-82M and its generic voices are Apache-2.0 licensed. This script does
not use a reference recording, custom speaker embedding, or voice clone.
"""

from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline


CLIPS = {
    "briefing": "Orbital race control online. Twelve labs cleared for launch.",
    "green": "Launch confirmed. The race to HELIOS is on.",
    "leader.OPENAI": "Open A I takes command of the orbital sprint.",
    "leader.ANTHROPIC": "Anthropic takes the lead.",
    "leader.DEEPMIND": "DeepMind takes the lead.",
    "leader.xAI": "x A I takes the lead.",
    "leader.META": "Meta takes the lead.",
    "leader.DEEPSEEK": "DeepSeek takes the lead.",
    "leader.MISTRAL": "Mistral takes the lead.",
    "leader.QWEN": "Qwen takes the lead.",
    "leader.MOONSHOT": "Moonshot takes the lead.",
    "leader.COHERE": "Cohere takes the lead.",
    "leader.MINIMAX": "MiniMax takes the lead.",
    "leader.MICROSOFT": "Microsoft takes the lead.",
    "rank.up": "Open A I is charging through the field.",
    "rank.down": "Open A I loses a position. Time to answer back.",
    "draft": "Draft link established. Burst charge is climbing.",
    "core": "Data core secured. Burst and shields replenished.",
    "core.8": "Every data core secured. Open A I has a full inference payload.",
    "impact": "Contact. Open A I shield is holding.",
    "shield.low": "Thermal shield critical. Keep it off the barriers.",
    "shield.gone": "Shield failure. Open A I is in limp mode. Clean line, now.",
    "sector.02": "Sector two. Karman Climb. The field goes to full thrust.",
    "sector.03": "Sector three. Lunar Slingshot. Momentum is everything here.",
    "sector.04": "Sector four. Dark-Side Switchback. No sunlight, no margin.",
    "sector.05": "Sector five. Quantum Data Stream. The racing line is wide open.",
    "sector.06": "Final approach. HELIOS is awake. Every position is live.",
    "finish.win": "Compute claimed! Open A I wins the race to HELIOS!",
    "finish.loss": "HELIOS reached. Open A I is classified. The race is complete.",
}


def safe_name(clip_id: str) -> str:
    return clip_id.replace(".", "-").replace("xAI", "xai").lower()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("assets/race-control"))
    parser.add_argument("--voice", default="bm_george")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--speed", type=float, default=1.06)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    pipeline = KPipeline(
        lang_code="b",
        repo_id="hexgrad/Kokoro-82M",
        device=args.device,
    )

    with tempfile.TemporaryDirectory(prefix="ai-race-control-") as temp_dir:
        temp = Path(temp_dir)
        for clip_id, text in CLIPS.items():
            chunks = [
                result.audio.detach().cpu().numpy()
                for result in pipeline(text, voice=args.voice, speed=args.speed)
            ]
            if not chunks:
                raise RuntimeError(f"Kokoro returned no audio for {clip_id}")
            audio = np.concatenate(chunks)
            wav = temp / f"{safe_name(clip_id)}.wav"
            target = args.out / f"{safe_name(clip_id)}.mp3"
            sf.write(wav, audio, 24_000)
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    str(wav),
                    "-af",
                    "highpass=f=75,loudnorm=I=-16:TP=-1.5:LRA=7",
                    "-ac",
                    "1",
                    "-ar",
                    "24000",
                    "-b:a",
                    "64k",
                    str(target),
                ],
                check=True,
            )
            print(f"{clip_id:20s} -> {target}")


if __name__ == "__main__":
    main()
