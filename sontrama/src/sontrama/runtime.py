from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable

import numpy as np
import sounddevice as sd

from .catalog import BankCatalog
from .configuration import midi_device_id, resolve_audio_device
from .contracts import AudioOutput, ConfigurableInstrument, Instrument, MidiSource
from .effects import EffectChain, StereoPanner
from .errors import ApplicationError, Diagnostic, error_detail
from .instruments import instrument_factory as default_instrument_factory
from .midi import RtMidiSource
from .models import Session, StateStore

log = logging.getLogger(__name__)


class MidiRouter:
    """Route selected sources to a single instrument; preserve transposed note-offs."""

    def __init__(self, send: Callable[[list[int]], None]):
        self.send = send
        self.notes: dict[tuple[str, int, int], int] = {}
        self.counts: dict[int, int] = {}

    def route(self, data: list[int], source: str, octave: int = 0):
        kind, channel = data[0] & 0xF0, data[0] & 15
        routed = [kind, *data[1:]]
        if kind in (0x80, 0x90):
            key = (source, channel, data[1])
            if kind == 0x90 and data[2]:
                note = data[1] + octave * 12
                if not 0 <= note <= 127:
                    return
                if key in self.notes:
                    self.release(key)
                self.notes[key] = note
                self.counts[note] = self.counts.get(note, 0) + 1
                routed[1] = note
            else:
                self.release(key)
                return
        self.send(routed)

    def release(self, key: tuple[str, int, int]):
        note = self.notes.pop(key, None)
        if note is None:
            return
        self.counts[note] -= 1
        if self.counts[note] == 0:
            del self.counts[note]
            self.send([0x80, note, 0])

    def release_source(self, source: str):
        for key in list(self.notes):
            if key[0] == source:
                self.release(key)
        # Sustain is channel-wide: releasing a disconnected controller must not leave held notes.
        self.send([0xB0, 64, 0])

    def reset(self):
        self.notes.clear()
        self.counts.clear()


class DeviceOutput:
    def __init__(self, render, sample_rate: int, block_size: int, device: str | None):
        latency = os.environ.get("SONTRAMA_AUDIO_LATENCY", "low")
        if latency not in ("low", "high"):
            latency = float(latency)
        self.stream = sd.OutputStream(
            samplerate=sample_rate,
            channels=2,
            dtype="float32",
            blocksize=block_size,
            device=device,
            latency=latency,
            callback=render,
        )

    @property
    def latency(self):
        return self.stream.latency

    def start(self):
        self.stream.start()

    def close(self):
        self.stream.stop()
        self.stream.close()


class Studio:
    def __init__(
        self,
        catalog: BankCatalog,
        store: StateStore,
        sample_rate=44100,
        instrument_factory=None,
        output_factory=DeviceOutput,
        midi_factory=RtMidiSource,
    ):
        self.catalog = catalog
        self.store = store
        self.sample_rate = sample_rate
        self.lock = threading.RLock()
        self.control_lock = threading.Lock()
        self.state = store.load()
        self.custom_instrument_factory = instrument_factory
        self.instrument_factory = instrument_factory or default_instrument_factory(
            catalog, sample_rate
        )
        self.output_factory = output_factory
        self.midi_factory = midi_factory
        self.instrument: Instrument | None = None
        self.output: AudioOutput | None = None
        self.chain = EffectChain(self.state.effects, sample_rate)
        self.master_chain = EffectChain(self.state.master_effects, sample_rate)
        self.panner = StereoPanner(self.state.pan)
        self.master_panner = StereoPanner(self.state.master_pan)
        self.router = MidiRouter(self._dispatch)
        self.emit: Callable[[dict], None] = lambda event: None
        self.status = {"engine": "stopped", "audio": "stopped", "midi": [], "errors": []}
        self.levels = [0.0, 0.0]
        self.stereo_levels = [[0.0, 0.0], [0.0, 0.0]]
        self.underruns = 0
        self.midi_source: MidiSource | None = None
        self.pending_banks: dict[tuple[str, int], int] = {}
        self.audio_enabled = False
        self.device = None
        self.block_size = 256
        self.controller_settings = {}
        self.source_controllers: dict[str, str] = {}
        self.catalog_revision = 0

    def refresh_factory(self):
        self.instrument_factory = self.custom_instrument_factory or default_instrument_factory(
            self.catalog, self.sample_rate
        )
        self.chain = EffectChain(self.state.effects, self.sample_rate)
        self.master_chain = EffectChain(self.state.master_effects, self.sample_rate)
        self.panner = StereoPanner(self.state.pan)
        self.master_panner = StereoPanner(self.state.master_pan)

    def start(self, audio=True, midi=True, device: str | None = None, block_size=256):
        self.audio_enabled = audio
        self.device = device
        self.block_size = block_size
        if self.catalog.banks:
            try:
                self.catalog.validate_preset(
                    self.state.soundfont,
                    self.state.bank,
                    self.state.program,
                )
            except ValueError:
                font = self.catalog.banks[0]
                preset = font["presets"][0]
                self.state = self.state.model_copy(
                    update={
                        "soundfont": font["id"],
                        "bank": preset["bank"],
                        "program": preset["program"],
                    }
                )
        if self.state.instrument != "banks" or self.catalog.banks:
            try:
                instrument = self.instrument_factory(self.state)
                self.instrument = instrument
                self.instrument.midi([0xB0, 64, 127 if self.state.sustain else 0])
                self.status["engine"] = "ready"
            except Exception as error:
                self.status["errors"].append(
                    Diagnostic("instrument_unavailable", f"Instrument: {error}")
                )
        else:
            self.status["errors"].append(
                Diagnostic("soundfonts_missing", "No SoundFonts. Configure SONTRAMA_SOUNDFONTS.")
            )
        if audio:
            try:
                self.output = self.output_factory(
                    self._audio_callback,
                    self.sample_rate,
                    block_size,
                    resolve_audio_device(device) if self.output_factory is DeviceOutput else device,
                )
                self.output.start()
                self.status["audio"] = "ready"
            except Exception as error:
                self.status["audio"] = "unavailable"
                self.status["errors"].append(
                    Diagnostic("audio_unavailable", f"Audio output: {error}")
                )
        else:
            self.status["audio"] = "disabled"
        if midi:
            self.midi_source = self.midi_factory(
                lambda data, name: self.midi(data, name, hardware=True),
                self._ports_changed,
                self.release_source,
                self._midi_error,
            )
            if hasattr(self.midi_source, "is_enabled"):
                self.midi_source.is_enabled = lambda name: self.controller_enabled(
                    midi_device_id(name)
                )
            self.midi_source.start()

    def snapshot(self):
        with self.lock:
            return {
                "type": "state",
                "session": self.state.model_dump(),
                "catalog": self.catalog.banks,
                "status": {
                    **self.status,
                    "errors": self.status["errors"] + self.catalog.errors,
                    "issues": [
                        error_detail(error, "soundfont_invalid")
                        for error in self.status["errors"] + self.catalog.errors
                    ],
                    "underruns": self.underruns,
                    "dsp": getattr(self.instrument, "backend", "fluidsynth"),
                    "audio_latency": getattr(self.output, "latency", None),
                    "catalog_revision": self.catalog_revision,
                },
            }

    def update(self, patch: dict):
        # Serialize changes, but leave the audio lock free during disk I/O and loading.
        with self.control_lock:
            with self.lock:
                previous = self.state
                current_chain = self.chain
                current_master_chain = self.master_chain
                can_configure = isinstance(self.instrument, ConfigurableInstrument)
            candidate = Session.model_validate(previous.model_dump() | patch)
            if candidate.instrument == "banks" and candidate.soundfont:
                self.catalog.validate_preset(candidate.soundfont, candidate.bank, candidate.program)
            elif candidate.instrument == "banks" and self.catalog.banks:
                raise ValueError("Select a SoundFont")
            selection = ("instrument",) + (
                ("soundfont", "bank", "program") if candidate.instrument == "banks" else ()
            )
            changed_preset = any(
                getattr(candidate, key) != getattr(previous, key) for key in selection
            )
            reset = changed_preset or any(
                getattr(candidate, key) != getattr(previous, key)
                for key in ("octave", "output", "usb_enabled", "midi_channel")
            )
            new_chain = (
                EffectChain(candidate.effects, self.sample_rate)
                if reset or not current_chain.matches(candidate.effects)
                else current_chain
            )
            new_master_chain = (
                EffectChain(candidate.master_effects, self.sample_rate)
                if reset or not current_master_chain.matches(candidate.master_effects)
                else current_master_chain
            )
            panner, master_panner = StereoPanner(candidate.pan), StereoPanner(candidate.master_pan)
            config_changed = (
                candidate.three_osc != previous.three_osc and candidate.instrument == "three-osc"
            )
            replacement = (
                self.instrument_factory(candidate)
                if changed_preset or (config_changed and not can_configure)
                else None
            )
            try:
                self.store.save(candidate)
            except Exception:
                if replacement:
                    replacement.close()
                raise
            old = None
            with self.lock:
                if reset:
                    if self.instrument:
                        self.instrument.panic()
                    self.router.reset()
                    self.emit({"type": "panic"})
                if replacement:
                    old = self.instrument
                    self.instrument = replacement
                    self.status["engine"] = "ready"
                    self.status["errors"] = [
                        error
                        for error in self.status["errors"]
                        if getattr(error, "code", "")
                        not in ("instrument_unavailable", "soundfonts_missing")
                    ]
                if self.instrument and (reset or candidate.sustain != previous.sustain):
                    self.instrument.midi([0xB0, 64, 127 if candidate.sustain else 0])
                if config_changed and not replacement and can_configure:
                    self.instrument.configure(candidate.three_osc.model_dump())
                if new_chain is current_chain and candidate.effects != previous.effects:
                    new_chain.configure(candidate.effects)
                if (
                    new_master_chain is current_master_chain
                    and candidate.master_effects != previous.master_effects
                ):
                    new_master_chain.configure(candidate.master_effects)
                self.chain, self.master_chain = new_chain, new_master_chain
                self.panner, self.master_panner = panner, master_panner
                self.state = candidate
            if old:
                old.close()
            result = self.snapshot()
            self.emit(result)
            return result

    def apply_configuration(self, audio, *, catalog=None, audio_changed=False, persist):
        # Prepare resources outside the callback lock; publish a complete graph at once.
        with self.control_lock:
            if not audio_changed and catalog is None:
                persist()
                return
            old_catalog, old_rate = self.catalog, self.sample_rate
            old_factory, old_chain = self.instrument_factory, self.chain
            old_master_chain = self.master_chain
            old_state, old_instrument = self.state, self.instrument
            old_device, old_block = self.device, self.block_size
            old_output = self.output
            next_catalog = catalog if catalog is not None else old_catalog
            next_state = old_state
            if catalog is not None and old_state.instrument == "banks":
                try:
                    catalog.validate_preset(old_state.soundfont, old_state.bank, old_state.program)
                except ValueError:
                    if catalog.banks:
                        font = catalog.banks[0]
                        preset = font["presets"][0]
                        next_state = old_state.model_copy(
                            update={
                                "soundfont": font["id"],
                                "bank": preset["bank"],
                                "program": preset["program"],
                            }
                        )
                    elif old_instrument:
                        raise ApplicationError(
                            "banks_library_empty",
                            "The library has no Banks sounds. Select 3 Osc before emptying it.",
                        ) from None
            factory = self.custom_instrument_factory or default_instrument_factory(
                next_catalog, audio.sample_rate
            )
            replacement = None
            if next_state.instrument != "banks" or next_catalog.banks:
                replacement = factory(next_state)
                replacement.midi([0xB0, 64, 127 if next_state.sustain else 0])
            chain = EffectChain(next_state.effects, audio.sample_rate)
            master_chain = EffectChain(next_state.master_effects, audio.sample_rate)
            new_output = None
            swapped = False
            state_saved = False
            try:
                if audio_changed and self.audio_enabled and self.output_factory is DeviceOutput:
                    sd.check_output_settings(
                        device=resolve_audio_device(audio.device),
                        channels=2,
                        samplerate=audio.sample_rate,
                        dtype="float32",
                    )
                if audio_changed and old_output:
                    old_output.close()
                    self.output = None
                with self.lock:
                    self.catalog, self.sample_rate = next_catalog, audio.sample_rate
                    self.instrument_factory, self.chain = factory, chain
                    self.master_chain = master_chain
                    self.state, self.instrument = next_state, replacement
                    self.device, self.block_size = audio.device, audio.block_size
                    self.router.reset()
                    self.levels = [0.0, 0.0]
                    self.stereo_levels = [[0.0, 0.0], [0.0, 0.0]]
                    swapped = True
                if audio_changed and self.audio_enabled:
                    device = (
                        resolve_audio_device(audio.device)
                        if self.output_factory is DeviceOutput
                        else audio.device
                    )
                    new_output = self.output_factory(
                        self._audio_callback, audio.sample_rate, audio.block_size, device
                    )
                    new_output.start()
                    self.output = new_output
                if next_state != old_state:
                    self.store.save(next_state)
                    state_saved = True
                persist()
            except Exception:
                if new_output:
                    new_output.close()
                if swapped:
                    with self.lock:
                        self.catalog, self.sample_rate = old_catalog, old_rate
                        self.instrument_factory, self.chain = old_factory, old_chain
                        self.master_chain = old_master_chain
                        self.state, self.instrument = old_state, old_instrument
                        self.device, self.block_size = old_device, old_block
                        self.router.reset()
                        if old_instrument:
                            old_instrument.panic()
                    if audio_changed and self.audio_enabled:
                        try:
                            device = (
                                resolve_audio_device(old_device)
                                if self.output_factory is DeviceOutput
                                else old_device
                            )
                            self.output = self.output_factory(
                                self._audio_callback, old_rate, old_block, device
                            )
                            self.output.start()
                        except Exception as error:
                            self.status["audio"] = "unavailable"
                            self.status["errors"].append(
                                Diagnostic("audio_unavailable", f"Audio output: {error}")
                            )
                    self.emit({"type": "panic"})
                if replacement:
                    replacement.close()
                if state_saved:
                    self.store.save(old_state)
                raise
            if old_instrument:
                old_instrument.close()
            with self.lock:
                self.status["engine"] = "ready" if self.instrument else "unavailable"
                self.status["audio"] = (
                    "ready"
                    if self.output
                    else ("disabled" if not self.audio_enabled else "unavailable")
                )
                self.status["errors"] = [
                    e
                    for e in self.status["errors"]
                    if getattr(e, "code", "")
                    not in ("audio_unavailable", "instrument_unavailable", "soundfonts_missing")
                ]
                if self.instrument is None and self.state.instrument == "banks":
                    self.status["errors"].append(
                        Diagnostic("soundfonts_missing", "No SoundFonts. Configure the library.")
                    )
                if catalog is not None:
                    self.catalog_revision += 1
            self.emit({"type": "panic"})
            self.emit(self.snapshot())

    def _dispatch(self, data: list[int]):
        if self.instrument and self.state.output == "device":
            self.instrument.midi(data)
        self.emit({"type": "midi", "data": data, "output": self.state.output})

    def controller_enabled(self, identifier: str):
        profile = self.controller_settings.get(identifier)
        return profile is None or profile.enabled

    def set_controller_settings(self, settings):
        with self.lock:
            self.controller_settings = settings
            for source, identifier in list(self.source_controllers.items()):
                if not self.controller_enabled(identifier):
                    self.release_source(source)

    def midi(self, data: list[int], source: str, hardware=False, controller: str | None = None):
        with self.lock:
            identifier = (
                midi_device_id(source)
                if hardware
                else (midi_device_id(controller, browser=True) if controller else None)
            )
            if identifier:
                self.source_controllers[source] = identifier
                if not self.controller_enabled(identifier):
                    return
                profile = self.controller_settings.get(identifier)
                if profile and data[0] & 0xF0 == 0x90 and data[2]:
                    power = {"linear": 1, "soft": 0.5, "hard": 2}[profile.velocity_curve]
                    data = [
                        data[0],
                        data[1],
                        max(1, min(127, round(127 * (data[2] / 127) ** power))),
                    ]
            if hardware and (
                not self.state.usb_enabled
                or (self.state.midi_channel is not None and data[0] & 15 != self.state.midi_channel)
            ):
                return
            kind = data[0] & 0xF0
            bank_key = (source, data[0] & 15)
            if kind == 0xB0 and data[1] in (0, 32):
                bank = self.pending_banks.get(bank_key, self.state.bank)
                self.pending_banks[bank_key] = (
                    (data[2] << 7) | (bank & 127) if data[1] == 0 else (bank & 16256) | data[2]
                )
                return
            if kind != 0xC0:
                self.router.route(data, source, self.state.octave)
                return
            if self.state.instrument != "banks":
                return
            program = {
                "bank": self.pending_banks.get(bank_key, self.state.bank),
                "program": data[1],
            }
        # Loading/persisting a program must not keep the audio lock held.
        try:
            self.update(program)
        except ValueError:
            pass

    def release_source(self, source: str):
        with self.lock:
            sources = {source} | {
                key for key in self.source_controllers if key.startswith(source + ":midi:")
            }
            for identifier in sources:
                self.router.release_source(identifier)
                self.source_controllers.pop(identifier, None)
            self.pending_banks = {
                key: value for key, value in self.pending_banks.items() if key[0] not in sources
            }

    def panic(self):
        with self.lock:
            if self.instrument:
                self.instrument.panic()
                self.instrument.midi([0xB0, 64, 127 if self.state.sustain else 0])
            self.router.reset()
            self.chain = EffectChain(self.state.effects, self.sample_rate)
            self.master_chain = EffectChain(self.state.master_effects, self.sample_rate)
            self.emit({"type": "panic"})

    def render(self, frames: int):
        with self.lock:
            if not self.instrument or self.state.output != "device":
                self.levels = [0, 0]
                self.stereo_levels = [[0.0, 0.0], [0.0, 0.0]]
                return np.zeros((frames, 2), dtype=np.float32)
            block = self.instrument.render(frames)
            block = self.chain.process(block)
            block = self.panner.process(block)
            block *= 0 if self.state.mute else self.state.volume
            channel_levels = np.minimum(1, np.max(np.abs(block), axis=0)).tolist()
            block = self.master_chain.process(block)
            block = self.master_panner.process(block)
            block *= 0 if self.state.master_mute else self.state.master
            master_levels = np.minimum(1, np.max(np.abs(block), axis=0)).tolist()
            self.stereo_levels = [channel_levels, master_levels]
            self.levels = [max(channel_levels), max(master_levels)]
            return np.clip(block, -1, 1)

    def _audio_callback(self, outdata, frames, timing, status):
        if status:
            self.underruns += 1
        try:
            outdata[:] = self.render(frames)
        except Exception:
            outdata.fill(0)
            log.exception("Audio rendering failed")

    def _ports_changed(self, names):
        available = list(getattr(self.midi_source, "available_ports", names))
        recovered = any(getattr(e, "code", "") == "midi_unavailable" for e in self.status["errors"])
        if (
            names != self.status["midi"]
            or available != self.status.get("midi_available")
            or recovered
        ):
            self.status["midi"] = names
            self.status["midi_available"] = available
            self.status["errors"] = [
                e for e in self.status["errors"] if getattr(e, "code", "") != "midi_unavailable"
            ]
            self.emit(self.snapshot())

    def _midi_error(self, error):
        self.status["errors"] = [
            e for e in self.status["errors"] if getattr(e, "code", "") != "midi_unavailable"
        ]
        self.status["errors"].append(Diagnostic("midi_unavailable", error))
        self.emit(self.snapshot())

    def close(self):
        if self.midi_source:
            self.midi_source.close()
        if self.output:
            self.output.close()
        with self.lock:
            self.panic()
            if self.instrument:
                self.instrument.close()
                self.instrument = None
