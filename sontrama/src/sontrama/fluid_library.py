"""Locate the pinned Banks engine without mixing C APIs from different libraries."""

import ctypes
import os
from functools import lru_cache
from pathlib import Path

from .native_core import CONTRACT


@lru_cache(maxsize=1)
def load_fluid_library():
    root = Path(__file__).resolve().parents[2]
    install = root / "data/native" / f"fluidsynth-{CONTRACT['fluidsynth']}"
    override = os.getenv("SONTRAMA_FLUIDSYNTH_LIBRARY")
    paths = [Path(override)] if override else list(install.glob("lib*/libfluidsynth.so*"))
    if not paths:
        raise RuntimeError(
            "Pinned FluidSynth is missing. Run scripts/build-banks.sh before starting Sontrama."
        )
    library = ctypes.CDLL(str(sorted(paths)[0]))
    library.fluid_version_str.restype = ctypes.c_char_p
    actual = library.fluid_version_str().decode("ascii")
    if actual != CONTRACT["fluidsynth"]:
        raise RuntimeError(f"FluidSynth {CONTRACT['fluidsynth']} is required; found {actual}")
    return library


def fluid_version():
    try:
        return load_fluid_library().fluid_version_str().decode("ascii")
    except (OSError, RuntimeError):
        return None
