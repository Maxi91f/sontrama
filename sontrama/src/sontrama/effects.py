"""External, ordered stereo effects, independent of instrument adapters."""

from .contracts import AudioBlock
from .models import EffectSpec
from .native_core import NativeBus
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


class StereoPanner(NativeBus):
    """Static stereo panning through the shared mixer kernel."""

    def __init__(self, pan: float):
        super().__init__(44100, pan=pan)
