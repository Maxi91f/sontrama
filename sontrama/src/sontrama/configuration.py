"""Shared configuration, independent of the musical session and browser storage."""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Literal

import sounddevice as sd
from pydantic import Field, model_validator

from .catalog import BankCatalog
from .errors import ApplicationError, Diagnostic, error_detail
from .models import StateStore, StrictModel


class InterfaceSettings(StrictModel):
    language: Literal["es", "en"] = "en"
    motion: Literal["system", "reduced", "full"] = "system"


class KeyboardSettings(StrictModel):
    capture: bool = False
    velocity: int = Field(default=100, ge=1, le=127)
    labels: Literal["shortcuts", "notes", "both", "none"] = "shortcuts"
    panel_octave: int = Field(default=0, ge=-5, le=4)


class AudioSettings(StrictModel):
    device: str | None = Field(default=None, max_length=512)
    sample_rate: Literal[44100, 48000] = 44100
    block_size: Literal[256, 512, 1024] = 256


class MidiDeviceSettings(StrictModel):
    enabled: bool = True
    velocity_curve: Literal["linear", "soft", "hard"] = "linear"


class MidiSettings(StrictModel):
    devices: dict[str, MidiDeviceSettings] = Field(default_factory=dict, max_length=128)


class LibrarySettings(StrictModel):
    paths: list[str] = Field(default_factory=list, max_length=32)


class SpectralSettings(StrictModel):
    fft_size: Literal[256, 512, 1024, 2048, 4096] = 1024
    refresh_rate: Literal[5, 10, 20] = 20
    frequency_min: float = Field(default=40, ge=20, le=20000)
    frequency_max: float = Field(default=20000, ge=40, le=24000)
    frequency_scale: Literal["log", "linear"] = "log"
    window: Literal["hann", "hamming", "blackman", "rectangular"] = "hann"
    smoothing: float = Field(default=0.5, ge=0, le=0.95)
    db_min: float = Field(default=-90, ge=-120, le=-20)
    db_max: float = Field(default=0, ge=-18, le=12)
    history_seconds: Literal[2, 4, 8, 16, 32] = 8

    @model_validator(mode="after")
    def validate_ranges(self):
        if self.frequency_min >= self.frequency_max or self.db_min >= self.db_max:
            raise ValueError("Spectral ranges must have increasing limits")
        return self


class VisualizationWidget(StrictModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    kind: Literal[
        "oscilloscope",
        "spectrum",
        "spectrogram",
        "vectorscope",
        "correlation",
        "tuner",
        "midi",
        "vu",
    ] = "oscilloscope"
    bus: Literal["channel", "master"] = "master"
    width: Literal[1, 2, 3] = 2
    height: Literal[160, 240, 320] = 240
    dock_width: int = Field(default=300, ge=220, le=800)
    pinned: bool = False
    paused: bool = False
    scale: Literal[0.5, 1, 2, 4] = 1
    meter_style: Literal["bars", "needle"] = "bars"
    spectral: SpectralSettings = Field(default_factory=SpectralSettings)


class VisualizationSettings(StrictModel):
    keyboard_width: int = Field(default=600, ge=280, le=1200)
    widgets: list[VisualizationWidget] = Field(default_factory=list, max_length=12)
    dock_positions: dict[str, int] = Field(default_factory=dict, max_length=13)
    dock_order: list[str] = Field(default_factory=lambda: ["keyboard"], max_length=13)
    collapsed: bool = False
    active: str = Field(default="keyboard", max_length=64)

    @model_validator(mode="after")
    def validate_widgets(self):
        identifiers = [widget.id for widget in self.widgets]
        if len(set(identifiers)) != len(identifiers) or "keyboard" in identifiers:
            raise ValueError("Visualization identifiers must be unique and cannot be keyboard")
        available = ["keyboard", *(widget.id for widget in self.widgets if widget.pinned)]
        if any(position < 0 or position > 16384 for position in self.dock_positions.values()):
            raise ValueError("Dock positions must be between 0 and 16384 pixels")
        self.dock_positions = {
            key: value for key, value in self.dock_positions.items() if key in available
        }
        self.dock_order = list(
            dict.fromkeys(identifier for identifier in self.dock_order if identifier in available)
        )
        self.dock_order.extend(
            identifier for identifier in available if identifier not in self.dock_order
        )
        if self.active != "keyboard" and not any(
            widget.id == self.active and widget.pinned for widget in self.widgets
        ):
            self.active = "keyboard"
        return self


class Configuration(StrictModel):
    interface: InterfaceSettings = Field(default_factory=InterfaceSettings)
    keyboard: KeyboardSettings = Field(default_factory=KeyboardSettings)
    audio: AudioSettings = Field(default_factory=AudioSettings)
    midi: MidiSettings = Field(default_factory=MidiSettings)
    library: LibrarySettings = Field(default_factory=LibrarySettings)
    browser_preview: bool = True
    preview_volume: float = Field(default=1.0, ge=0, le=1)
    preview_muted: bool = True
    visualizations: VisualizationSettings = Field(default_factory=VisualizationSettings)


def midi_device_id(name: str, *, browser=False) -> str:
    # ALSA client/port numbers change after unplugging or rebooting a controller.
    stable = name if browser else re.sub(r" \d+:\d+$", "", name)
    return ("browser:" if browser else "server:") + stable


def merge_settings(previous: dict, patch: dict) -> dict:
    result = previous.copy()
    for key, value in patch.items():
        if key == "dock_positions" and isinstance(value, dict):
            result[key] = {
                identifier: position
                for identifier, position in value.items()
                if position is not None
            }
            continue
        if key == "devices" and isinstance(value, dict):
            devices = result.get(key, {}).copy()
            for identifier, profile in value.items():
                if profile is None:
                    devices.pop(identifier, None)
                else:
                    devices[identifier] = (
                        merge_settings(devices.get(identifier, {}), profile)
                        if isinstance(profile, dict)
                        else profile
                    )
            result[key] = devices
            continue
        result[key] = (
            merge_settings(result[key], value)
            if isinstance(value, dict) and isinstance(result.get(key), dict)
            else value
        )
    return result


def audio_devices():
    devices = []
    apis = sd.query_hostapis()
    for device in sd.query_devices():
        if device["max_output_channels"] < 2:
            continue
        api = apis[device["hostapi"]]["name"]
        stable = re.sub(r" \(hw:\d+,\d+\)$", "", device["name"])
        devices.append({"id": f"{api}/{stable}", "name": device["name"], "api": api})
    return devices


def resolve_audio_device(name):
    if name is None:
        return None
    apis = sd.query_hostapis()
    for index, device in enumerate(sd.query_devices()):
        if device["max_output_channels"] >= 2:
            api = apis[device["hostapi"]]["name"]
            stable = re.sub(r" \(hw:\d+,\d+\)$", "", device["name"])
            if name == f"{api}/{stable}":
                return index
    # Preserve support for device names in existing environment files.
    return name


class ConfigurationService:
    def __init__(self, studio, path: Path | None = None):
        self.studio = studio
        self.path = path or studio.store.path.with_name("settings.json")
        self.lock = threading.RLock()
        self.browser_devices: dict[str, list[str]] = {}
        self.resources = {"audio_devices": [], "audio_error": None, "audio_issue": None}
        defaults = Configuration(
            audio=AudioSettings(
                device=os.getenv("SONTRAMA_AUDIO_DEVICE") or None,
                block_size=int(os.getenv("SONTRAMA_BLOCK_SIZE", "256")),
                sample_rate=studio.sample_rate,
            ),
            library=LibrarySettings(
                paths=[str(path) for path in studio.catalog.roots if path.exists()]
            ),
        )
        if self.path.exists():
            saved = json.loads(self.path.read_text())
            if "preview_volume" not in saved and "preview_muted" not in saved:
                # The old toggle controlled listening, not silent local simulation.
                saved["browser_preview"] = True
            self.settings = Configuration.model_validate(saved)
        else:
            self.settings = defaults
        if self.settings.library != defaults.library:
            studio.catalog = self._catalog(self.settings.library, validate=False)
        studio.sample_rate = self.settings.audio.sample_rate
        studio.refresh_factory()
        studio.controller_settings = self.settings.midi.devices
        self.refresh_audio_devices()

    def refresh_audio_devices(self):
        try:
            self.resources = {
                "audio_devices": audio_devices(),
                "audio_error": None,
                "audio_issue": None,
            }
        except Exception as error:
            self.resources = {
                "audio_devices": [],
                "audio_error": str(error),
                "audio_issue": error_detail(error, "audio_unavailable"),
            }

    def snapshot(self):
        available = getattr(self.studio.midi_source, "available_ports", [])
        inputs = {
            midi_device_id(name): {
                "id": midi_device_id(name),
                "name": re.sub(r" \d+:\d+$", "", name),
                "location": "server",
                "connected": True,
            }
            for name in available
        }
        for names in self.browser_devices.values():
            for name in names:
                identifier = midi_device_id(name, browser=True)
                inputs[identifier] = {
                    "id": identifier,
                    "name": name,
                    "location": "browser",
                    "connected": True,
                }
        for identifier in self.settings.midi.devices:
            inputs.setdefault(
                identifier,
                {
                    "id": identifier,
                    "name": identifier.split(":", 1)[-1],
                    "location": identifier.split(":", 1)[0],
                    "connected": False,
                },
            )
        return {
            "type": "settings",
            "settings": self.settings.model_dump(),
            "initialized": self.path.exists(),
            "resources": {
                **self.resources,
                "midi_inputs": list(inputs.values()),
                "audio_enabled": self.studio.audio_enabled,
            },
        }

    def register_browser(self, source: str, names: list[str]):
        if len(names) > 64 or any(
            not isinstance(name, str) or not 1 <= len(name) <= 200 for name in names
        ):
            raise ValueError("Invalid browser MIDI device names")
        self.browser_devices[source] = names

    def _catalog(self, settings: LibrarySettings, *, validate=True):
        paths = []
        errors = []
        for name in settings.paths:
            if not name.strip() or len(name) > 2048:
                raise ApplicationError("invalid_library_path", "Invalid SoundFont directory.")
            path = Path(name).expanduser().resolve()
            if not path.is_dir() and not (path.is_file() and path.suffix.lower() == ".sf2"):
                message = f"Directory or SoundFont does not exist: {name}"
                if validate:
                    raise ApplicationError("library_path_missing", message, path=name)
                errors.append(Diagnostic("library_path_missing", message, path=name))
                continue
            if path not in paths:
                paths.append(path)
        catalog = BankCatalog(paths)
        catalog.errors.extend(errors)
        return catalog

    def update(self, patch: dict, *, rescan=False, initialize_only=False):
        with self.lock:
            if initialize_only and self.path.exists():
                return self.snapshot()
            candidate = Configuration.model_validate(
                merge_settings(self.settings.model_dump(), patch)
            )
            library_changed = rescan or candidate.library != self.settings.library
            catalog = self._catalog(candidate.library) if library_changed else None
            audio_changed = candidate.audio != self.settings.audio
            previous = self.settings

            def persist():
                StateStore(self.path).save(candidate)

            self.studio.apply_configuration(
                candidate.audio, catalog=catalog, audio_changed=audio_changed, persist=persist
            )
            self.studio.set_controller_settings(candidate.midi.devices)
            self.settings = candidate
            if previous.audio != candidate.audio:
                self.refresh_audio_devices()
            return self.snapshot()
