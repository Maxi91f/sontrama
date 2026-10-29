"""External, ordered stereo effects, independent of instrument adapters."""

import numpy as np

from .contracts import AudioBlock
from .models import EffectSpec
from .native_effects import NativeEffect, load_effect_kernel


class EffectChain:
    def __init__(self, specs: list[EffectSpec], sample_rate: int):
        load_effect_kernel()
        self.signature = [(spec.id, spec.kind, spec.enabled) for spec in specs]
        self.effects = [NativeEffect(spec, sample_rate) for spec in specs if spec.enabled]

    def matches(self, specs: list[EffectSpec]) -> bool:
        return self.signature == [(spec.id, spec.kind, spec.enabled) for spec in specs]

    def configure(self, specs: list[EffectSpec]):
        for effect, spec in zip(
            self.effects, (spec for spec in specs if spec.enabled), strict=True
        ):
            effect.configure(spec)

    def process(self, block: AudioBlock) -> AudioBlock:
        for effect in self.effects:
            block = effect.process(block)
        return block


class StereoPanner:
    """Equal-power stereo panning, preserving both channels at the center.

    Match Web Audio's StereoPannerNode for a stereo input: panning folds the
    opposite side into the destination side instead of simply discarding it.
    """

    def __init__(self, pan: float):
        self.pan = pan
        angle = abs(pan) * np.pi / 2
        self.cosine, self.sine = np.cos(angle), np.sin(angle)

    def process(self, block: AudioBlock) -> AudioBlock:
        if self.pan == 0:
            return block
        result = np.empty_like(block)
        if self.pan < 0:
            result[:, 0] = block[:, 0] + block[:, 1] * self.sine
            result[:, 1] = block[:, 1] * self.cosine
        else:
            result[:, 0] = block[:, 0] * self.cosine
            result[:, 1] = block[:, 1] + block[:, 0] * self.sine
        return result
