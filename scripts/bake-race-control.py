#!/usr/bin/env python3
"""Bake the original Orbital Race Control clip library with Kokoro-82M.

Runtime dependencies are intentionally not part of the browser game:

    pip install "kokoro==0.9.4" soundfile

Kokoro-82M and its generic voices are Apache-2.0 licensed. This script does
not use a reference recording, custom speaker embedding, or voice clone.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline


CLIPS = {
    "briefing": "Orbital race control online. Twelve labs cleared for launch.",
    "green": "Launch confirmed. The race to HELIOS is on.",
    "leader.OPENAI": "OpenAI takes command of the orbital sprint.",
    "leader.ANTHROPIC": "Anthropic takes the lead.",
    "leader.DEEPMIND": "DeepMind takes the lead.",
    "leader.xAI": "xAI takes the lead.",
    "leader.META": "Meta takes the lead.",
    "leader.DEEPSEEK": "DeepSeek takes the lead.",
    "leader.MISTRAL": "Mistral takes the lead.",
    "leader.QWEN": "Qwen takes the lead.",
    "leader.MOONSHOT": "Moonshot takes the lead.",
    "leader.COHERE": "Cohere takes the lead.",
    "leader.AIIT-THRESHOLD": "AIIT Threshold takes the lead.",
    "leader.MICROSOFT": "Microsoft takes the lead.",
    "rank.up": "OpenAI is charging through the field.",
    "rank.down": "OpenAI loses a position. Time to answer back.",
    "draft": "Draft link established. Burst charge is climbing.",
    "draft.2": "OpenAI is in the wake. Slingshot charge is building.",
    "draft.3": "Clean tow acquired. Energy is stacking fast.",
    "draft.4": "Wake captured. OpenAI is loading the attack.",
    "draft.5": "The slipstream is locked. Burst reserve climbing.",
    "slingshot.ready": "Wake lock complete. Slingshot is armed.",
    "slingshot.ready.2": "The wake is charged. Attack window open.",
    "slingshot.ready.3": "Slingshot energy at full charge. Release when ready.",
    "slingshot.ready.4": "Tow complete. OpenAI has the slingshot.",
    "slingshot.fire": "Slingshot deployed. OpenAI is coming through.",
    "slingshot.fire.2": "OpenAI fires the slingshot and surges forward.",
    "slingshot.fire.3": "Attack boost released. OpenAI is on the move.",
    "slingshot.fire.4": "Slingshot away. Here comes OpenAI.",
    "core": "Data core secured. Burst and shields replenished.",
    "core.2": "Core aboard. Boost reserve restored.",
    "core.3": "Another data core recovered. Systems recharged.",
    "core.4": "Payload increased. Shield and burst are back online.",
    "core.5": "Core capture confirmed. OpenAI gets fresh energy.",
    "core.6": "Recovery complete. Another core joins the payload.",
    "core.7": "Data secured. OpenAI has more power in reserve.",
    "core.8": "Every data core secured. OpenAI has a full inference payload.",
    "impact": "Contact. OpenAI shield is holding.",
    "impact.2": "OpenAI takes a hit, but the shield absorbs it.",
    "impact.3": "Barrier strike. Shield remains online.",
    "impact.4": "Rival contact. OpenAI stays in the fight.",
    "impact.5": "Heavy touch. The shield is still carrying the load.",
    "shield.low": "Thermal shield critical. Keep it off the barriers.",
    "shield.gone": "Shield failure. OpenAI is in limp mode. Clean line, now.",
    "sector.02": "Sector two. Karman Climb. The field goes to full thrust.",
    "sector.03": "Sector three. Lunar Slingshot. Momentum is everything here.",
    "sector.04": "Sector four. Dark-Side Switchback. No sunlight, no margin.",
    "sector.05": "Sector five. Quantum Data Stream. The racing line is wide open.",
    "sector.06": "Final approach. HELIOS is awake. Every position is live.",
    "finish.win": "Compute claimed! OpenAI wins the race to HELIOS!",
    "finish.loss": "HELIOS reached. OpenAI is classified. The race is complete.",
}

LABS = {
    "OPENAI": "OpenAI",
    "ANTHROPIC": "Anthropic",
    "DEEPMIND": "DeepMind",
    "xAI": "xAI",
    "META": "Meta",
    "DEEPSEEK": "DeepSeek",
    "MISTRAL": "Mistral",
    "QWEN": "Qwen",
    "MOONSHOT": "Moonshot",
    "COHERE": "Cohere",
    "AIIT-THRESHOLD": "AIIT Threshold",
    "MICROSOFT": "Microsoft",
}

ORDINALS = (
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
)

DIGITS = (
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
)

BROADCAST_CLAUSES = {
    **{f"clause.lab.{clip_id}": text for clip_id, text in LABS.items()},
    **{f"clause.rank.{rank}": word for rank, word in enumerate(ORDINALS, 1)},
    **{f"clause.digit.{digit}": word for digit, word in enumerate(DIGITS)},
    "clause.openai-passes": "OpenAI passes",
    "clause.passes-openai": "passes OpenAI",
    "clause.openai-drops-to": "OpenAI drops to",
    "clause.for": "for",
    "clause.takes-lead-from": "takes the lead from",
    "clause.slingshot-deployed": "Slingshot deployed",
    "clause.openai-attacks": "OpenAI attacks",
    "clause.helios-online": "HELIOS online",
    "clause.openai-wins": "OpenAI wins the race to HELIOS",
    "clause.openai-wins-by": "OpenAI wins by",
    "clause.claims-helios": "claims HELIOS",
    "clause.openai-finishes": "OpenAI finishes",
    "clause.point": "point",
    "clause.seconds": "seconds",
    "clause.back": "back",
}

CLIPS.update(BROADCAST_CLAUSES)


def safe_name(clip_id: str) -> str:
    return clip_id.replace(".", "-").replace("xAI", "xai").lower()


def speech_text(text: str) -> str:
    """Keep captions canonical while spelling initialisms for the stock voice."""
    return text.replace("OpenAI", "Open A I").replace("xAI", "x A I")

def bake_broadcast_sprite(out: Path, temp: Path) -> dict[str, dict[str, float]]:
    """Join normalized clauses into one gapless, single-request audio sprite."""
    chunks = []
    timings = {}
    cursor = 0
    sample_rate = 24_000
    for clip_id in BROADCAST_CLAUSES:
        source = out / f"{safe_name(clip_id)}.mp3"
        audio, rate = sf.read(source, dtype="float32")
        if rate != sample_rate:
            raise RuntimeError(f"Unexpected clause sample rate for {clip_id}: {rate}")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        timings[clip_id] = {
            "offset": round(cursor / sample_rate, 6),
            "duration": round(len(audio) / sample_rate, 6),
        }
        chunks.append(audio)
        cursor += len(audio)

    sprite_wav = temp / "broadcast-clauses.wav"
    sprite_mp3 = out / "broadcast-clauses.mp3"
    sf.write(sprite_wav, np.concatenate(chunks), sample_rate)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(sprite_wav),
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-b:a",
            "64k",
            str(sprite_mp3),
        ],
        check=True,
    )
    (out / "broadcast-clauses-timings.json").write_text(
        json.dumps(timings, indent=2) + "\n",
        encoding="utf-8",
    )
    timing_lines = [
        "/* Generated by scripts/bake-race-control.py. */",
        "export const BROADCAST_CLAUSE_TIMINGS = Object.freeze({",
    ]
    timing_lines.extend(
        f"  {json.dumps(clip_id)}: Object.freeze("
        f"[{timing['offset']}, {timing['duration']}]),"
        for clip_id, timing in timings.items()
    )
    timing_lines.append("});")
    (out / "broadcast-clauses.js").write_text(
        "\n".join(timing_lines) + "\n",
        encoding="utf-8",
    )
    return timings


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("assets/race-control"))
    parser.add_argument("--voice", default="bm_george")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--speed", type=float, default=1.06)
    parser.add_argument(
        "--clip",
        action="append",
        choices=sorted(CLIPS),
        help="Bake only this clip ID (repeatable). Defaults to the full library.",
    )
    parser.add_argument(
        "--broadcast-pack",
        action="store_true",
        help="Bake only the short compositional broadcast clauses.",
    )
    parser.add_argument(
        "--keep-clause-files",
        action="store_true",
        help="Keep the intermediate one-file-per-clause MP3s after building the sprite.",
    )
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    pipeline = KPipeline(
        lang_code="b",
        repo_id="hexgrad/Kokoro-82M",
        device=args.device,
    )

    with tempfile.TemporaryDirectory(prefix="ai-race-control-") as temp_dir:
        temp = Path(temp_dir)
        selected = args.clip or (
            list(BROADCAST_CLAUSES) if args.broadcast_pack else list(CLIPS)
        )
        for clip_id in selected:
            text = CLIPS[clip_id]
            chunks = [
                result.audio.detach().cpu().numpy()
                for result in pipeline(
                    speech_text(text),
                    voice=args.voice,
                    speed=args.speed,
                )
            ]
            if not chunks:
                raise RuntimeError(f"Kokoro returned no audio for {clip_id}")
            audio = np.concatenate(chunks)
            wav = temp / f"{safe_name(clip_id)}.wav"
            target = args.out / f"{safe_name(clip_id)}.mp3"
            sf.write(wav, audio, 24_000)
            filters = "highpass=f=75,loudnorm=I=-16:TP=-1.5:LRA=7"
            if clip_id.startswith("clause."):
                # Clause programs need tight joins. Preserve a tiny tail so
                # consonants survive while removing sentence-sized silences.
                filters = (
                    "silenceremove="
                    "start_periods=1:start_silence=0.01:start_threshold=-45dB:"
                    "stop_periods=-1:stop_silence=0.06:stop_threshold=-45dB,"
                    f"{filters},apad=pad_dur=0.035"
                )
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    str(wav),
                    "-af",
                    filters,
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

        if all(clip_id in selected for clip_id in BROADCAST_CLAUSES):
            timings = bake_broadcast_sprite(args.out, temp)
            print(
                f"{'broadcast sprite':20s} -> "
                f"{args.out / 'broadcast-clauses.mp3'} ({len(timings)} clauses)"
            )
            if not args.keep_clause_files:
                for clip_id in BROADCAST_CLAUSES:
                    (args.out / f"{safe_name(clip_id)}.mp3").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
