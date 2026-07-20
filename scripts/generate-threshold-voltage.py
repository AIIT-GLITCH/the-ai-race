#!/usr/bin/env python3
"""Generate THRESHOLD VOLTAGE, an original wonky arena-rock game loop."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


ROOT = Path(__file__).resolve().parents[1] / "assets" / "music"
RATE = 44_100
BPM = 132
BEAT = 60 / BPM
BARS = 32
DURATION = BARS * 4 * BEAT + 3.2
RNG = np.random.default_rng(47018)


def midi(note: float) -> float:
    return 440 * 2 ** ((note - 69) / 12)


def envelope(length: int, attack: float, release: float, decay: float = 2.5) -> np.ndarray:
    t = np.arange(length) / RATE
    env = np.minimum(1, t / max(attack, 1 / RATE)) * np.exp(-decay * t)
    tail = np.minimum(1, (length - np.arange(length)) / max(1, release * RATE))
    return env * tail


def pan(mono: np.ndarray, position: float) -> np.ndarray:
    angle = (np.clip(position, -1, 1) + 1) * np.pi / 4
    return np.column_stack((mono * np.cos(angle), mono * np.sin(angle)))


def add(bus: np.ndarray, start: float, mono: np.ndarray, position: float = 0) -> None:
    first = max(0, int(start * RATE))
    last = min(len(bus), first + len(mono))
    if last > first:
        bus[first:last] += pan(mono[: last - first], position)


def smooth(signal: np.ndarray, samples: int) -> np.ndarray:
    samples = max(1, int(samples))
    if samples == 1:
        return signal.copy()
    was_mono = signal.ndim == 1
    source = signal[:, None] if was_mono else signal
    prefix = np.repeat(source[:1], samples - 1, axis=0)
    padded = np.concatenate((np.zeros_like(source[:1]), prefix, source), axis=0)
    cumulative = np.cumsum(padded, axis=0)
    result = (cumulative[samples:] - cumulative[:-samples]) / samples
    return result[:, 0] if was_mono else result


def lowpass(signal: np.ndarray, cutoff: float) -> np.ndarray:
    width = max(1, round(RATE / max(1, cutoff * 2)))
    return smooth(smooth(signal, width), width)


def highpass(signal: np.ndarray, cutoff: float) -> np.ndarray:
    width = max(2, round(RATE / max(1, cutoff * 2)))
    return signal - smooth(signal, width)


def guitar(note: float, duration: float, bend: float = 0, choke: bool = False) -> np.ndarray:
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    bend_curve = bend * np.minimum(1, t / max(duration * .68, .01))
    phase = 2 * np.pi * np.cumsum(midi(note + bend_curve)) / RATE
    fifth = 2 * np.pi * np.cumsum(midi(note + 7 + bend_curve)) / RATE
    octave = phase * 2
    raw = sum(np.sin(phase * h) / h for h in range(1, 9))
    raw += .72 * sum(np.sin(fifth * h) / h for h in range(1, 7))
    raw += .38 * sum(np.sin(octave * h) / h for h in range(1, 5))
    raw += RNG.normal(0, .035, n)
    raw = lowpass(np.tanh(raw * 2.8), 4_700)
    release = .045 if choke else .16
    return raw * envelope(n, .006, release, 2.0 if not choke else 8.5)


def bass(note: float, duration: float) -> np.ndarray:
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    phase = 2 * np.pi * midi(note) * t
    raw = np.sin(phase) + .32 * np.sin(phase * 2) + .16 * np.sin(phase * 3)
    return np.tanh(lowpass(raw, 780) * 1.8) * envelope(n, .008, .08, 1.25)


def lead(note: float, duration: float, bend: float = 0) -> np.ndarray:
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    pitch = note + bend * np.sin(np.minimum(1, t / max(duration, .01)) * np.pi / 2)
    phase = 2 * np.pi * np.cumsum(midi(pitch)) / RATE
    raw = np.sin(phase) + .42 * np.sin(phase * 2) + .2 * np.sin(phase * 3)
    raw *= 1 + .06 * np.sin(2 * np.pi * 6.2 * t)
    return np.tanh(raw * 2.2) * envelope(n, .012, .18, .8)


def kick() -> np.ndarray:
    duration = .34
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    frequency = 42 + 112 * np.exp(-t * 24)
    phase = 2 * np.pi * np.cumsum(frequency) / RATE
    click = highpass(RNG.normal(0, 1, n), 3_200) * np.exp(-t * 80) * .16
    return (np.sin(phase) * np.exp(-t * 12) + click) * .92


def snare() -> np.ndarray:
    duration = .31
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    noise = highpass(RNG.normal(0, 1, n), 1_250) * np.exp(-t * 15)
    body = np.sin(2 * np.pi * 188 * t) * np.exp(-t * 20)
    return np.tanh(noise * 1.3 + body * .65) * .56


def hat(open_hat: bool = False) -> np.ndarray:
    duration = .25 if open_hat else .075
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    noise = highpass(RNG.normal(0, 1, n), 6_500)
    return noise * np.exp(-t * (17 if open_hat else 70)) * .18


def glitch(duration: float = .22) -> np.ndarray:
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    carrier = np.sign(np.sin(2 * np.pi * (83 + 37 * np.sin(t * 31)) * t))
    noise = RNG.normal(0, 1, n)
    gate = ((np.arange(n) // max(1, int(RATE * .018))) % 3 != 1).astype(float)
    return highpass((carrier * .48 + noise * .28) * gate, 240) * np.exp(-t * 7)


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    size = int(DURATION * RATE)
    rhythm = np.zeros((size, 2), dtype=np.float64)
    low = np.zeros_like(rhythm)
    drums = np.zeros_like(rhythm)
    melody = np.zeros_like(rhythm)
    effects = np.zeros_like(rhythm)

    roots = [40, 40, 43, 45, 40, 47, 43, 42]
    riff = [0, None, 0, 3, 5, None, 3, -2]
    wonky_bars = {7, 15, 23, 27}

    for bar in range(BARS):
        bar_start = bar * 4 * BEAT
        root = roots[bar % len(roots)]
        intro_gain = .48 if bar < 2 else 1

        for eighth, interval in enumerate(riff):
            if interval is None:
                continue
            when = bar_start + eighth * BEAT / 2
            if bar in wonky_bars and eighth >= 5:
                when -= BEAT / 6
            choke = eighth not in (0, 4)
            note = root + interval
            left = guitar(note, BEAT * (.47 if choke else .88), choke=choke) * .28 * intro_gain
            right = guitar(note, BEAT * (.47 if choke else .88), bend=.08 if bar % 8 == 6 else 0, choke=choke)
            add(rhythm, when, left, -.58)
            add(rhythm, when + .011, right * .25 * intro_gain, .58)
            add(low, when, bass(note - 12, BEAT * .46) * .42, -.05)

        for beat in range(4):
            when = bar_start + beat * BEAT
            if bar >= 1:
                add(drums, when, kick(), 0)
                if beat in (1, 3):
                    add(drums, when, snare(), .06 if beat == 1 else -.06)
            for half in range(2):
                hat_time = when + half * BEAT / 2
                add(drums, hat_time, hat(open_hat=half == 1 and beat == 3) * intro_gain, .48)

        if bar in wonky_bars:
            add(effects, bar_start + 3.15 * BEAT, glitch(.3) * .42, (-1) ** bar * .65)
            add(melody, bar_start + 2.5 * BEAT, lead(58, BEAT * 1.25, bend=-5) * .23, .35)

        if 8 <= bar < 16 or 24 <= bar < 31:
            phrase = [64, 67, 70, 69] if bar % 2 == 0 else [67, 64, 62, 58]
            for index, note in enumerate(phrase):
                add(
                    melody,
                    bar_start + (index * .75 + .45) * BEAT,
                    lead(note, BEAT * .62, bend=1.6 if index == 2 else 0) * .19,
                    .32 if index % 2 else -.32,
                )

    # A fake tape-stop before the last bar makes the final hit feel enormous.
    stop_start = int((30 * 4 * BEAT + 3.0 * BEAT) * RATE)
    stop_end = min(size, stop_start + int(BEAT * RATE))
    fade = np.linspace(1, 0, stop_end - stop_start)[:, None]
    rhythm[stop_start:stop_end] *= fade
    drums[stop_start:stop_end] *= fade
    low[stop_start:stop_end] *= fade

    final_at = BARS * 4 * BEAT
    add(rhythm, final_at, guitar(40, 2.9, bend=-.12) * .52, -.5)
    add(rhythm, final_at + .014, guitar(40, 2.9, bend=.08) * .48, .5)
    add(low, final_at, bass(28, 2.7) * .62, 0)
    add(drums, final_at, kick() * 1.3, 0)
    add(drums, final_at, snare() * .7, 0)
    add(effects, final_at + .08, glitch(.7) * .18, 0)

    mix = rhythm + low + drums + melody + effects
    # Short slap delay and a tiny stereo disagreement create the wonky width.
    delay = int(.083 * RATE)
    mix[delay:, 0] += mix[:-delay, 1] * .105
    mix[delay:, 1] += mix[:-delay, 0] * .085
    mix = highpass(mix, 28)
    mix = np.tanh(mix * 1.18)
    mix /= max(np.max(np.abs(mix)), 1e-9)
    mix *= .92

    raw = ROOT / "threshold-voltage-raw.wav"
    final = ROOT / "threshold-voltage.mp3"
    sf.write(raw, mix.astype(np.float32), RATE, subtype="PCM_24")
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
            "-af", "loudnorm=I=-14:TP=-1.2:LRA=8",
            "-c:a", "libmp3lame", "-b:a", "256k", str(final),
        ],
        check=True,
    )
    print(final)


if __name__ == "__main__":
    main()
