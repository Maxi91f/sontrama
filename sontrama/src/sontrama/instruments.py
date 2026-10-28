import ctypes
import ctypes.util
from pathlib import Path

import numpy as np

from .contracts import AudioBlock


class BanksInstrument:
    def __init__(self, sample_rate: int):
        import fluidsynth

        self.library = ctypes.CDLL(ctypes.util.find_library("fluidsynth"))
        self.write_float = self.library.fluid_synth_write_float
        self.write_float.restype = ctypes.c_int
        self.write_float.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_int,
        ]
        for name, count in (("fluid_synth_channel_pressure", 2), ("fluid_synth_key_pressure", 3)):
            function = getattr(self.library, name)
            function.restype = ctypes.c_int
            function.argtypes = [ctypes.c_void_p] + [ctypes.c_int] * count
        self.synth = fluidsynth.Synth(
            samplerate=float(sample_rate),
            gain=0.6,
            **{
                "synth.reverb.active": 0,
                "synth.chorus.active": 0,
                "synth.polyphony": 128,
                "synth.cpu-cores": 1,
            },
        )
        self.fonts: dict[Path, int] = {}

    def select(self, path: Path, bank: int, program: int):
        if path not in self.fonts:
            identifier = self.synth.sfload(str(path), update_midi_preset=0)
            if identifier < 0:
                raise ValueError(f"Could not load {path.name}")
            self.fonts[path] = identifier
        self.panic()
        if self.synth.program_select(0, self.fonts[path], bank, program) < 0:
            raise ValueError("Could not select preset")

    def midi(self, data: list[int]):
        kind, value = data[0] & 0xF0, data[1]
        if kind == 0x90 and data[2]:
            self.synth.noteon(0, value, data[2])
        elif kind in (0x80, 0x90):
            self.synth.noteoff(0, value)
        elif kind == 0xB0:
            self.synth.cc(0, value, data[2])
        elif kind == 0xE0:
            self.synth.pitch_bend(0, value + (data[2] << 7) - 8192)
        elif kind == 0xD0:
            self.library.fluid_synth_channel_pressure(self.synth.synth, 0, value)
        elif kind == 0xA0:
            self.library.fluid_synth_key_pressure(self.synth.synth, 0, value, data[2])

    def render(self, frames: int) -> AudioBlock:
        block = np.empty((frames, 2), dtype=np.float32)
        if (
            self.write_float(
                self.synth.synth, frames, block.ctypes.data, 0, 2, block.ctypes.data, 1, 2
            )
            < 0
        ):
            raise RuntimeError("FluidSynth rendering failed")
        return block

    def panic(self):
        self.synth.cc(0, 64, 0)
        self.synth.cc(0, 120, 0)
        self.synth.pitch_bend(0, 0)

    def close(self):
        self.synth.delete()


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
