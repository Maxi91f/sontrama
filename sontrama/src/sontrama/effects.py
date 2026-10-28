"""External, ordered effects. No dependency on FluidSynth."""

import numpy as np
from scipy.signal import butter, sosfilt

from .contracts import AudioBlock, AudioEffect
from .models import EffectSpec


class Gain:
    def __init__(self, value: float, sample_rate: int):
        self.gain = 10 ** (value / 20)

    def process(self, block: AudioBlock) -> AudioBlock:
        return block * self.gain


class LowPass:
    def __init__(self, value: float, sample_rate: int):
        self.sos = butter(2, min(value, sample_rate * 0.45), fs=sample_rate, output="sos")
        self.state = np.zeros((len(self.sos), 2, 2))

    def process(self, block: AudioBlock) -> AudioBlock:
        result, self.state = sosfilt(self.sos, block, axis=0, zi=self.state)
        return result.astype(np.float32)


class Chorus:
    def __init__(self, value: float, sample_rate: int):
        self.wet = value
        self.rate = sample_rate
        self.buffer = np.zeros((int(sample_rate * 0.08), 2), dtype=np.float32)
        self.position = 0
        self.time = 0

    def process(self, block: AudioBlock) -> AudioBlock:
        frames = len(block)
        indices = (self.position + np.arange(frames)) % len(self.buffer)
        self.buffer[indices] = block
        phase = (self.time + np.arange(frames)) * (2 * np.pi * 0.8 / self.rate)
        delay = (0.025 + 0.005 * np.sin(phase)) * self.rate
        positions = (indices - delay) % len(self.buffer)
        first = positions.astype(int)
        fraction = (positions - first)[:, None]
        delayed = self.buffer[first] * (1 - fraction)
        delayed += self.buffer[(first + 1) % len(self.buffer)] * fraction
        self.position = int((self.position + frames) % len(self.buffer))
        self.time += frames
        return (block * (1 - self.wet * 0.5) + delayed * self.wet * 0.5).astype(np.float32)


class Reverb:
    def __init__(self, value: float, sample_rate: int):
        self.wet = value
        self.lines = [
            np.zeros((int(sample_rate * t), 2), dtype=np.float32)
            for t in (0.0297, 0.0371, 0.0411, 0.0437)
        ]
        self.positions = [0] * len(self.lines)

    def process(self, block: AudioBlock) -> AudioBlock:
        reverberation = np.zeros_like(block)
        for index, line in enumerate(self.lines):
            indices = (self.positions[index] + np.arange(len(block))) % len(line)
            delayed = line[indices].copy()
            line[indices] = block + delayed[:, ::-1] * 0.72
            self.positions[index] = int((self.positions[index] + len(block)) % len(line))
            reverberation += delayed * 0.25
        return block * (1 - self.wet) + reverberation * self.wet


EFFECTS = {"gain": Gain, "filter": LowPass, "chorus": Chorus, "reverb": Reverb}


class EffectChain:
    def __init__(self, specs: list[EffectSpec], sample_rate: int):
        self.effects: list[AudioEffect] = [
            EFFECTS[spec.kind](spec.value, sample_rate) for spec in specs if spec.enabled
        ]

    def process(self, block: AudioBlock) -> AudioBlock:
        for effect in self.effects:
            block = effect.process(block)
        return block
