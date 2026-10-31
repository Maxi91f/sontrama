"""Thin native adapter for the shared C/WASM three-oscillator instrument."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .models import ThreeOscPatch
from .native_core import CONTRACT, load_core, patch_vector


@dataclass(frozen=True)
class Voice:
    phases: np.ndarray
    age: int
    release_age: int | None
    key_down: bool


class ThreeOscInstrument:
    def __init__(self, sample_rate: int, patch: ThreeOscPatch, *, seed=CONTRACT["seed"]):
        self.sample_rate = sample_rate
        self.backend = "native-c"
        self.kernel = load_core()
        self.pointer = self.kernel.sontrama_osc_create(sample_rate, seed)
        if not self.pointer:
            raise MemoryError("Could not allocate oscillator engine")
        self.configure(patch.model_dump())

    def configure(self, parameters):
        self.patch = ThreeOscPatch.model_validate(parameters)
        vector = patch_vector(self.patch)
        self.kernel.sontrama_osc_configure(self.pointer, vector.ctypes.data)

    def midi(self, data):
        self.kernel.sontrama_osc_midi(
            self.pointer, data[0], data[1], data[2] if len(data) > 2 else 0
        )

    def render(self, frames):
        output = np.empty((frames, 2), dtype=np.float32)
        self.kernel.sontrama_osc_process(self.pointer, output.ctypes.data, frames)
        return output

    @property
    def voices(self):
        """Expose diagnostic snapshots without duplicating voice management in Python."""
        result = {}
        values = np.empty(12, dtype=np.float64)
        for note in range(128):
            if self.kernel.sontrama_osc_voice(self.pointer, note, values.ctypes.data):
                result[note] = Voice(
                    values[:6].copy().reshape(3, 2),
                    int(values[6]),
                    None if values[7] < 0 else int(values[7]),
                    bool(values[10]),
                )
        return result

    def panic(self):
        self.kernel.sontrama_osc_panic(self.pointer)

    def close(self):
        if getattr(self, "pointer", None):
            self.kernel.sontrama_osc_free(self.pointer)
            self.pointer = None

    def __del__(self):
        self.close()
