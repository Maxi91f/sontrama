"""Load the same portable DSP sources compiled for native and WebAssembly targets."""

from __future__ import annotations

import ctypes as c
import hashlib
import json
import os
import platform
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

import numpy as np

DSP = Path(__file__).with_name("dsp")
CONTRACT = json.loads((DSP / "core_contract.json").read_text())
SOURCES = ("three_osc.c", "effects.c", "mixer.c", "core_contract.json", "../effect_specs.json")


@lru_cache(maxsize=1)
def core_revision():
    digest = hashlib.sha256()
    for name in SOURCES:
        digest.update(name.encode() + b"\0" + (DSP / name).read_bytes())
    return digest.hexdigest()


@lru_cache(maxsize=1)
def load_core():
    cache = Path(os.environ.get("SONTRAMA_NATIVE_CACHE", DSP.parents[2] / "data/native"))
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"core-{platform.machine()}-{core_revision()[:16]}.so"
    if not target.exists():
        with tempfile.TemporaryDirectory(dir=cache) as temporary:
            artifact = Path(temporary) / "core.so"
            subprocess.run(
                [
                    os.environ.get("CC", "cc"),
                    "-O3",
                    "-ffp-contract=off",
                    f'-DSONTRAMA_CORE_REVISION="{core_revision()}"',
                    "-std=c99",
                    "-fPIC",
                    "-shared",
                    *(str(DSP / name) for name in SOURCES if name.endswith(".c")),
                    "-o",
                    str(artifact),
                    "-lm",
                ],
                check=True,
                capture_output=True,
                timeout=120,
            )
            artifact.replace(target)
    library = c.CDLL(str(target))
    library.sontrama_core_revision.restype = c.c_char_p
    if library.sontrama_core_revision().decode("ascii") != core_revision():
        raise RuntimeError("The native DSP artifact does not match its source revision")
    signatures = {
        "sontrama_osc_create": (c.c_void_p, [c.c_int, c.c_uint32]),
        "sontrama_osc_free": (None, [c.c_void_p]),
        "sontrama_osc_configure": (None, [c.c_void_p, c.c_void_p]),
        "sontrama_osc_midi": (None, [c.c_void_p, c.c_int, c.c_int, c.c_int]),
        "sontrama_osc_process": (None, [c.c_void_p, c.c_void_p, c.c_int]),
        "sontrama_osc_panic": (None, [c.c_void_p]),
        "sontrama_osc_voice": (c.c_int, [c.c_void_p, c.c_int, c.c_void_p]),
        "sontrama_bus_create": (c.c_void_p, [c.c_int]),
        "sontrama_bus_free": (None, [c.c_void_p]),
        "sontrama_bus_configure": (None, [c.c_void_p, c.c_double, c.c_double, c.c_int]),
        "sontrama_bus_process": (None, [c.c_void_p, c.c_void_p, c.c_void_p, c.c_int]),
        "sontrama_clip": (None, [c.c_void_p, c.c_void_p, c.c_int]),
        "sontrama_effect_create": (c.c_void_p, [c.c_int, c.c_int, c.c_void_p, c.c_int]),
        "sontrama_effect_configure": (None, [c.c_void_p, c.c_void_p, c.c_int]),
        "sontrama_effect_process": (None, [c.c_void_p, c.c_void_p, c.c_void_p, c.c_int]),
        "sontrama_effect_free": (None, [c.c_void_p]),
    }
    for name, (result, arguments) in signatures.items():
        function = getattr(library, name)
        function.restype = result
        function.argtypes = arguments
    return library


def patch_vector(patch):
    values = []
    for oscillator in patch.oscillators:
        for field in CONTRACT["oscillator_fields"]:
            value = getattr(oscillator, field)
            values.append(CONTRACT["shapes"].index(value) if field == "shape" else value)
    for field in CONTRACT["patch_fields"]:
        values.append(
            getattr(patch.envelope, field)
            if hasattr(patch.envelope, field)
            else getattr(patch, field)
        )
    return np.asarray(values, dtype=np.float64)


class NativeBus:
    """Shared gain/pan smoothing and immediate mute, with persistent DSP state."""

    def __init__(self, sample_rate, gain=1, pan=0, muted=False):
        self.library = load_core()
        self.pointer = self.library.sontrama_bus_create(sample_rate)
        if not self.pointer:
            raise MemoryError("Could not allocate mixer bus")
        self.configure(gain, pan, muted)

    def configure(self, gain, pan, muted=False):
        self.pan = pan
        self.library.sontrama_bus_configure(self.pointer, gain, pan, muted)

    def process(self, block):
        source = np.ascontiguousarray(block, dtype=np.float32)
        output = np.empty_like(source)
        self.library.sontrama_bus_process(
            self.pointer, source.ctypes.data, output.ctypes.data, len(source)
        )
        return output

    def __del__(self):
        if getattr(self, "pointer", None):
            self.library.sontrama_bus_free(self.pointer)
            self.pointer = None


def clip(block):
    output = np.empty_like(block)
    load_core().sontrama_clip(block.ctypes.data, output.ctypes.data, len(block))
    return output
