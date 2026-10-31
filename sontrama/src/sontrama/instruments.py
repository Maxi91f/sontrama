"""Instrument adapters; MIDI routing and effects do not depend on FluidSynth."""

import ctypes as c
from pathlib import Path

import numpy as np

from .contracts import AudioBlock
from .fluid_library import load_fluid_library


class BanksInstrument:
    def __init__(self, sample_rate: int):
        self.library = load_fluid_library()
        signatures = {
            "new_fluid_settings": (c.c_void_p, []),
            "delete_fluid_settings": (None, [c.c_void_p]),
            "fluid_settings_setint": (c.c_int, [c.c_void_p, c.c_char_p, c.c_int]),
            "fluid_settings_setnum": (c.c_int, [c.c_void_p, c.c_char_p, c.c_double]),
            "new_fluid_synth": (c.c_void_p, [c.c_void_p]),
            "delete_fluid_synth": (None, [c.c_void_p]),
            "fluid_synth_sfload": (c.c_int, [c.c_void_p, c.c_char_p, c.c_int]),
            "fluid_synth_program_select": (
                c.c_int,
                [c.c_void_p, c.c_int, c.c_int, c.c_int, c.c_int],
            ),
            "fluid_synth_noteon": (c.c_int, [c.c_void_p, c.c_int, c.c_int, c.c_int]),
            "fluid_synth_noteoff": (c.c_int, [c.c_void_p, c.c_int, c.c_int]),
            "fluid_synth_cc": (c.c_int, [c.c_void_p, c.c_int, c.c_int, c.c_int]),
            "fluid_synth_pitch_bend": (c.c_int, [c.c_void_p, c.c_int, c.c_int]),
            "fluid_synth_channel_pressure": (c.c_int, [c.c_void_p, c.c_int, c.c_int]),
            "fluid_synth_key_pressure": (c.c_int, [c.c_void_p, c.c_int, c.c_int, c.c_int]),
            "fluid_synth_write_float": (
                c.c_int,
                [c.c_void_p, c.c_int, c.c_void_p, c.c_int, c.c_int, c.c_void_p, c.c_int, c.c_int],
            ),
        }
        for name, (result, arguments) in signatures.items():
            function = getattr(self.library, name)
            function.restype = result
            function.argtypes = arguments
        self.settings = self.library.new_fluid_settings()
        if not self.settings:
            raise MemoryError("Could not allocate FluidSynth settings")
        self.synth = None
        try:
            for key, value in {
                "synth.reverb.active": 0,
                "synth.chorus.active": 0,
                "synth.polyphony": 128,
                "synth.cpu-cores": 1,
            }.items():
                self.library.fluid_settings_setint(self.settings, key.encode(), value)
            self.library.fluid_settings_setnum(
                self.settings, b"synth.sample-rate", float(sample_rate)
            )
            self.library.fluid_settings_setnum(self.settings, b"synth.gain", 0.6)
            self.synth = self.library.new_fluid_synth(self.settings)
            if not self.synth:
                raise RuntimeError("Could not initialize FluidSynth")
        except Exception:
            self.close()
            raise
        self.fonts: dict[Path, int] = {}

    def select(self, path: Path, bank: int, program: int):
        if path not in self.fonts:
            identifier = self.library.fluid_synth_sfload(self.synth, str(path).encode(), 0)
            if identifier < 0:
                raise ValueError(f"Could not load {path.name}")
            self.fonts[path] = identifier
        self.panic()
        if (
            self.library.fluid_synth_program_select(self.synth, 0, self.fonts[path], bank, program)
            < 0
        ):
            raise ValueError("Could not select preset")

    def midi(self, data: list[int]):
        kind, value = data[0] & 0xF0, data[1]
        if kind == 0x90 and data[2]:
            self.library.fluid_synth_noteon(self.synth, 0, value, data[2])
        elif kind in (0x80, 0x90):
            self.library.fluid_synth_noteoff(self.synth, 0, value)
        elif kind == 0xB0:
            self.library.fluid_synth_cc(self.synth, 0, value, data[2])
        elif kind == 0xE0:
            self.library.fluid_synth_pitch_bend(self.synth, 0, value + (data[2] << 7))
        elif kind == 0xD0:
            self.library.fluid_synth_channel_pressure(self.synth, 0, value)
        elif kind == 0xA0:
            self.library.fluid_synth_key_pressure(self.synth, 0, value, data[2])

    def render(self, frames: int) -> AudioBlock:
        block = np.empty((frames, 2), dtype=np.float32)
        if (
            self.library.fluid_synth_write_float(
                self.synth, frames, block.ctypes.data, 0, 2, block.ctypes.data, 1, 2
            )
            < 0
        ):
            raise RuntimeError("FluidSynth rendering failed")
        return block

    def panic(self):
        self.library.fluid_synth_cc(self.synth, 0, 64, 0)
        self.library.fluid_synth_cc(self.synth, 0, 120, 0)
        self.library.fluid_synth_pitch_bend(self.synth, 0, 8192)

    def close(self):
        if getattr(self, "synth", None):
            self.library.delete_fluid_synth(self.synth)
            self.synth = None
        if getattr(self, "settings", None):
            self.library.delete_fluid_settings(self.settings)
            self.settings = None


def banks_factory(catalog, sample_rate):
    def create(state):
        instrument = BanksInstrument(sample_rate)
        try:
            instrument.select(catalog.paths[state.soundfont], state.bank, state.program)
        except Exception:
            instrument.close()
            raise
        return instrument

    return create


def instrument_factory(catalog, sample_rate):
    from .three_osc import ThreeOscInstrument

    factories = {
        "banks": banks_factory(catalog, sample_rate),
        "three-osc": lambda state: ThreeOscInstrument(sample_rate, state.three_osc),
    }
    return lambda state: factories[state.instrument](state)
