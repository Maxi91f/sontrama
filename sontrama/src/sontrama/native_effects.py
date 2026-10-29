"""Prepare the portable effect kernel before opening the audio output."""

import ctypes as c
import hashlib
import os
import platform
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

import numpy as np

from .effect_parameters import EFFECT_KINDS, EFFECT_SPECS


@lru_cache(maxsize=1)
def load_effect_kernel():
    source = Path(__file__).parent / "dsp/effects.c"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    cache = Path(os.environ.get("SONTRAMA_NATIVE_CACHE", source.parents[3] / "data/native"))
    target = cache / f"effects-{platform.machine()}-{digest}.so"
    cache.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        try:
            with tempfile.TemporaryDirectory(dir=cache) as temporary:
                artifact = Path(temporary) / "effects.so"
                subprocess.run(
                    [
                        os.environ.get("CC", "cc"),
                        "-O3",
                        "-std=c99",
                        "-fPIC",
                        "-shared",
                        str(source),
                        "-o",
                        str(artifact),
                        "-lm",
                    ],
                    check=True,
                    capture_output=True,
                    timeout=60,
                )
                artifact.replace(target)
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError(
                "Could not prepare the effect kernel. Install a C compiler before starting Sontrama."
            ) from error
    library = c.CDLL(str(target))
    library.sontrama_effect_create.argtypes = [c.c_int, c.c_int, c.c_void_p, c.c_int]
    library.sontrama_effect_create.restype = c.c_void_p
    library.sontrama_effect_configure.argtypes = [c.c_void_p, c.c_void_p, c.c_int]
    library.sontrama_effect_configure.restype = None
    library.sontrama_effect_process.argtypes = [c.c_void_p, c.c_void_p, c.c_void_p, c.c_int]
    library.sontrama_effect_process.restype = None
    library.sontrama_effect_free.argtypes = [c.c_void_p]
    library.sontrama_effect_free.restype = None
    return library


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
