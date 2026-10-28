"""Polyphonic three-oscillator instrument, independent of SoundFonts and audio drivers."""

from __future__ import annotations

import ctypes
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .contracts import AudioBlock
from .models import ThreeOscPatch
from .native_dsp import build_parameters, load_kernel
from .native_dsp import render as render_native

TABLE_SIZE = 2048
SHAPES = ("sine", "triangle", "square", "saw", "rounded-saw")


@lru_cache(maxsize=1)
def wave_tables():
    tables = {}
    for shape in SHAPES:
        levels = []
        for power in range(10):
            harmonics = 2**power
            spectrum = np.zeros(TABLE_SIZE // 2 + 1, dtype=np.complex128)
            for harmonic in range(1, harmonics + 1):
                if shape == "sine":
                    amplitude = 1 if harmonic == 1 else 0
                elif shape == "triangle":
                    amplitude = (
                        8 / np.pi**2 * (-1) ** ((harmonic - 1) // 2) / harmonic**2
                        if harmonic % 2
                        else 0
                    )
                elif shape == "square":
                    amplitude = 4 / (np.pi * harmonic) if harmonic % 2 else 0
                elif shape == "saw":
                    amplitude = -2 / (np.pi * harmonic)
                else:
                    amplitude = -1 / harmonic**2
                spectrum[harmonic] = -0.5j * TABLE_SIZE * amplitude
            table = np.fft.irfft(spectrum, n=TABLE_SIZE).astype(np.float32)
            levels.append(table)
        tables[shape] = levels
    return tables


@lru_cache(maxsize=1)
def stacked_tables():
    tables = wave_tables()
    return np.array([tables[shape] for shape in SHAPES])


@dataclass
class Voice:
    note: int
    velocity: float
    phases: np.ndarray
    age: int = 0
    key_down: bool = True
    release_age: int | None = None
    release_level: float = 0
    pressure: float = 0


class ThreeOscInstrument:
    def __init__(self, sample_rate: int, patch: ThreeOscPatch):
        self.sample_rate = sample_rate
        self.patch = patch.model_copy(deep=True)
        self.tables = wave_tables()
        self.kernel = load_kernel()
        self.backend = "native-c" if self.kernel else "numpy"
        self.native_tables = stacked_tables()
        self.native_parameters = build_parameters(self.patch)
        self.native_random = ctypes.c_uint64(int(np.random.default_rng().integers(1, 2**63)))

        self.voices: dict[int, Voice] = {}
        self.random = np.random.default_rng()
        self.sustain = False
        self.bend = 0.0
        self.modulation = 0.0
        self.pressure = 0.0
        self.volume = 1.0
        self.expression = 1.0
        self.pan = 0.0
        self.clock = 0

    def configure(self, parameters: dict):
        patch = ThreeOscPatch.model_validate(parameters)
        delta = np.array(
            [
                [
                    (new.phase_start - old.phase_start) / 360,
                    (new.phase_start - old.phase_start + new.phase - old.phase) / 360,
                ]
                for old, new in zip(self.patch.oscillators, patch.oscillators, strict=True)
            ]
        )
        for voice in self.voices.values():
            voice.phases = (voice.phases + delta) % 1
        self.patch = patch
        self.native_parameters = build_parameters(patch)

    def _level(self, ages):
        seconds = ages / self.sample_rate
        envelope = self.patch.envelope
        return np.where(
            seconds < envelope.attack,
            seconds / envelope.attack,
            np.where(
                seconds < envelope.attack + envelope.decay,
                1 - (1 - envelope.sustain) * (seconds - envelope.attack) / envelope.decay,
                envelope.sustain,
            ),
        )

    def _release(self, voice: Voice):
        if voice.release_age is None:
            voice.release_level = float(self._level(np.array([voice.age]))[0])
            voice.release_age = 0

    def midi(self, data: list[int]):
        kind, value = data[0] & 0xF0, data[1]
        if kind == 0x90 and data[2]:
            self.voices.pop(value, None)
            if len(self.voices) >= 16:
                self.voices.pop(next(iter(self.voices)))
            phases = self.random.random((3, 2)) * self.patch.phase_random
            for index, oscillator in enumerate(self.patch.oscillators):
                phases[index] += oscillator.phase_start / 360
                phases[index, 1] += oscillator.phase / 360
            self.voices[value] = Voice(value, data[2] / 127, phases % 1)
        elif kind in (0x80, 0x90):
            if value in self.voices:
                voice = self.voices[value]
                voice.key_down = False
                if not self.sustain:
                    self._release(voice)
        elif kind == 0xE0:
            self.bend = (value + (data[2] << 7) - 8192) / 8192 * 2
        elif kind == 0xD0:
            self.pressure = value / 127
        elif kind == 0xA0 and value in self.voices:
            self.voices[value].pressure = data[2] / 127
        elif kind == 0xB0:
            control, amount = value, data[2]
            if control == 64:
                self.sustain = amount >= 64
                if not self.sustain:
                    for voice in self.voices.values():
                        if not voice.key_down:
                            self._release(voice)
            elif control == 1:
                self.modulation = amount / 127
            elif control == 7:
                self.volume = amount / 127
            elif control == 11:
                self.expression = amount / 127
            elif control == 10:
                self.pan = max(-1, min(1, (amount - 64) / 63))
            elif control == 120:
                self.panic()
            elif control == 123:
                for voice in self.voices.values():
                    voice.key_down = False
                    if not self.sustain:
                        self._release(voice)
            elif control == 121:
                self.sustain = False
                self.bend = self.modulation = self.pressure = self.pan = 0
                self.volume = self.expression = 1
                for voice in self.voices.values():
                    if not voice.key_down:
                        self._release(voice)

    def render(self, frames: int) -> AudioBlock:
        if self.kernel:
            return render_native(self, frames)
        voices = list(self.voices.values())
        offsets = np.arange(frames)
        lfo = np.sin((self.clock + offsets) * 2 * np.pi * 5 / self.sample_rate)
        self.clock += frames
        if not voices:
            return np.zeros((frames, 2), dtype=np.float32)
        oscillators = self.patch.oscillators
        depths = np.array(
            [max(self.modulation, self.pressure * 0.5, voice.pressure * 0.5) for voice in voices]
        )
        vibrato = np.exp2(depths[:, None] * lfo[None, :] * 0.5 / 12)
        tuning = np.array(
            [
                [osc.coarse + (osc.fine + osc.detune * side) / 100 for side in (-0.5, 0.5)]
                for osc in oscillators
            ]
        )
        notes = np.array([voice.note for voice in voices])
        base = 440 * np.exp2((notes[:, None, None] - 69 + tuning + self.bend) / 12)
        frequencies = base[..., None] * vibrato[:, None, None, :]
        increments = frequencies / self.sample_rate
        starts = np.array([voice.phases for voice in voices])[..., None]
        phases = (starts + np.cumsum(increments, axis=-1) - increments) % 1
        last_phases = (phases[..., -1] + increments[..., -1]) % 1
        highest = frequencies.max(axis=-1)
        if self.patch.hq:
            power = np.minimum(
                9, np.floor(np.log2(np.maximum(1, self.sample_rate * 0.49 / highest)))
            ).astype(int)
        else:
            power = np.full(highest.shape, 9, dtype=int)
        shapes = np.array(
            [SHAPES.index(osc.shape) if osc.shape != "noise" else 0 for osc in oscillators]
        )[None, :, None, None]
        positions = phases * TABLE_SIZE
        first = positions.astype(int) % TABLE_SIZE
        fraction = positions - np.floor(positions)
        # Vectorize across voices, all oscillators, stereo and frames. The Pi must
        # finish one block before the audio device consumes the preceding block.
        tables = stacked_tables()
        waves = (
            tables[shapes, power[..., None], first] * (1 - fraction)
            + tables[shapes, power[..., None], (first + 1) % TABLE_SIZE] * fraction
        )
        waves *= frequencies < self.sample_rate * 0.49
        for index, oscillator in enumerate(oscillators):
            if oscillator.shape == "noise":
                waves[:, index] = self.random.uniform(-1, 1, (len(voices), 2, frames))
        pans = np.array([np.clip(osc.pan + self.pan, -1, 1) for osc in oscillators])
        angles = (pans + 1) * np.pi / 4
        gains = np.stack([np.cos(angles), np.sin(angles)], axis=1)
        gains *= np.array([int(osc.enabled) for osc in oscillators])[:, None]
        waves *= gains[None, :, :, None]
        mix2 = oscillators[1].mix if oscillators[1].enabled else 0
        mix3 = oscillators[2].mix if oscillators[2].enabled else 0
        combined = waves[:, 0] * (1 - mix2) + waves[:, 1] * mix2
        if self.patch.am_osc3:
            combined *= (1 - mix3) + mix3 * (waves[:, 2] + 1) * 0.5
        else:
            combined = combined * (1 - mix3) + waves[:, 2] * mix3
        ages = np.array([voice.age for voice in voices])[:, None] + offsets
        envelope = self._level(ages)
        for index, voice in enumerate(voices):
            if voice.release_age is not None:
                envelope[index] = voice.release_level * np.maximum(
                    0,
                    1
                    - (voice.release_age + offsets)
                    / (self.patch.envelope.release * self.sample_rate),
                )
                voice.release_age += frames
                if voice.release_age >= self.patch.envelope.release * self.sample_rate:
                    self.voices.pop(voice.note)
            voice.age += frames
            voice.phases = last_phases[index]
        velocity = np.array([voice.velocity for voice in voices])
        combined *= envelope[:, None, :] * velocity[:, None, None]
        output = combined.sum(axis=0).T * (0.2 * self.volume * self.expression)
        return output.astype(np.float32)

    def panic(self):
        self.voices.clear()
        self.sustain = False
        self.bend = 0

    def close(self):
        self.panic()
