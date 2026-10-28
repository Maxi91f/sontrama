"""Build and load the optional portable C oscillator kernel before audio starts."""

from __future__ import annotations

import ctypes as c
import hashlib
import logging
import os
import platform
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


class Oscillator(c.Structure):
    _fields_ = [
        ("enabled", c.c_int),
        ("shape", c.c_int),
        ("coarse", c.c_float),
        ("fine", c.c_float),
        ("pan", c.c_float),
        ("detune", c.c_float),
    ]


class Parameters(c.Structure):
    _fields_ = [
        ("oscillators", Oscillator * 3),
        ("mix2", c.c_float),
        ("mix3", c.c_float),
        ("attack", c.c_float),
        ("decay", c.c_float),
        ("sustain", c.c_float),
        ("release", c.c_float),
        ("am", c.c_int),
        ("hq", c.c_int),
    ]


class Controls(c.Structure):
    _fields_ = [
        (name, c.c_float)
        for name in ("bend", "modulation", "pressure", "volume", "expression", "pan")
    ]


@lru_cache(maxsize=1)
def load_kernel():
    if os.environ.get("SONTRAMA_PYTHON_DSP") == "1":
        return None
    source = Path(__file__).parent / "dsp/three_osc.c"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    cache = Path(os.environ.get("SONTRAMA_NATIVE_CACHE", source.parents[3] / "data/native"))
    target = cache / f"three-osc-{platform.machine()}-{digest}.so"
    try:
        cache.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            with tempfile.TemporaryDirectory(dir=cache) as temporary:
                artifact = Path(temporary) / "kernel.so"
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
        library = c.CDLL(str(target))
        function = library.sontrama_render_voice
        function.restype = None
        function.argtypes = [
            c.c_void_p,
            c.c_void_p,
            c.c_void_p,
            c.POINTER(Parameters),
            c.POINTER(Controls),
            c.c_int,
            c.c_int,
            c.c_int,
            c.c_float,
            c.c_uint64,
            c.c_int64,
            c.c_float,
            c.c_float,
            c.c_void_p,
            c.POINTER(c.c_uint64),
        ]
        lfo = library.sontrama_fill_lfo
        lfo.restype = None
        lfo.argtypes = [c.c_void_p, c.c_int, c.c_int, c.c_uint64]
        function.fill_lfo = lfo
        return function
    except (OSError, subprocess.SubprocessError):
        log.warning("C oscillator kernel unavailable; using NumPy", exc_info=True)
        return None


def build_parameters(patch):
    shapes = ("sine", "triangle", "square", "saw", "rounded-saw", "noise")
    oscillators = (Oscillator * 3)(
        *[
            Oscillator(
                int(osc.enabled), shapes.index(osc.shape), osc.coarse, osc.fine, osc.pan, osc.detune
            )
            for osc in patch.oscillators
        ]
    )
    env = patch.envelope
    return Parameters(
        oscillators,
        patch.oscillators[1].mix if patch.oscillators[1].enabled else 0,
        patch.oscillators[2].mix if patch.oscillators[2].enabled else 0,
        env.attack,
        env.decay,
        env.sustain,
        env.release,
        int(patch.am_osc3),
        int(patch.hq),
    )


def render(synth, frames):
    output = np.zeros((frames, 2), dtype=np.float32)
    lfo = np.empty(frames, dtype=np.float32)
    synth.kernel.fill_lfo(lfo.ctypes.data, frames, synth.sample_rate, synth.clock)
    controls = Controls(
        synth.bend, synth.modulation, synth.pressure, synth.volume, synth.expression, synth.pan
    )
    for note, voice in list(synth.voices.items()):
        synth.kernel(
            output.ctypes.data,
            voice.phases.ctypes.data,
            synth.native_tables.ctypes.data,
            c.byref(synth.native_parameters),
            c.byref(controls),
            frames,
            synth.sample_rate,
            note,
            voice.velocity,
            voice.age,
            -1 if voice.release_age is None else voice.release_age,
            voice.release_level,
            voice.pressure,
            lfo.ctypes.data,
            c.byref(synth.native_random),
        )
        voice.age += frames
        if voice.release_age is not None:
            voice.release_age += frames
            if voice.release_age >= synth.patch.envelope.release * synth.sample_rate:
                synth.voices.pop(note)
    synth.clock += frames
    return output
