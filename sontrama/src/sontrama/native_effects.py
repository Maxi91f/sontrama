"""Prepare the portable effect kernel before opening the audio output."""

import numpy as np

from .effect_parameters import EFFECT_KINDS, EFFECT_SPECS
from .native_core import load_core

load_effect_kernel = load_core


def parameter_vector(spec):
    definitions = EFFECT_SPECS[spec.kind]["parameters"]
    return np.array(
        [
            definition["choices"].index(spec.parameters[name])
            if definition["type"] == "choice"
            else spec.parameters[name]
            for name, definition in definitions.items()
        ],
        dtype=np.float64,
    )


class NativeEffect:
    def __init__(self, spec, sample_rate):
        self.library = load_effect_kernel()
        parameters = parameter_vector(spec)
        self.pointer = self.library.sontrama_effect_create(
            EFFECT_KINDS.index(spec.kind), sample_rate, parameters.ctypes.data, len(parameters)
        )
        if not self.pointer:
            raise MemoryError("Could not allocate effect buffers")

    def configure(self, spec):
        parameters = parameter_vector(spec)
        self.library.sontrama_effect_configure(
            self.pointer, parameters.ctypes.data, len(parameters)
        )

    def process(self, block):
        source = np.ascontiguousarray(block, dtype=np.float32)
        output = np.empty_like(source)
        self.library.sontrama_effect_process(
            self.pointer, source.ctypes.data, output.ctypes.data, len(source)
        )
        return output

    def __del__(self):
        if getattr(self, "pointer", None):
            self.library.sontrama_effect_free(self.pointer)
            self.pointer = None
