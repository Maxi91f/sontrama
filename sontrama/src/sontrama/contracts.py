from typing import Protocol, runtime_checkable

import numpy as np
from numpy.typing import NDArray

AudioBlock = NDArray[np.float32]


class Instrument(Protocol):
    """Instruments receive MIDI and render dry stereo audio."""

    def midi(self, data: list[int]) -> None: ...
    def render(self, frames: int) -> AudioBlock: ...
    def panic(self) -> None: ...
    def close(self) -> None: ...


class AudioEffect(Protocol):
    def process(self, block: AudioBlock) -> AudioBlock: ...


class AudioOutput(Protocol):
    def start(self) -> None: ...
    def close(self) -> None: ...


class MidiSource(Protocol):
    def start(self) -> None: ...
    def close(self) -> None: ...


@runtime_checkable
class ConfigurableInstrument(Protocol):
    def configure(self, parameters: dict) -> None: ...
