"""Shared configuration, independent of the musical session and browser storage."""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Literal

import sounddevice as sd
from pydantic import Field

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


class Configuration(StrictModel):
    interface: InterfaceSettings = Field(default_factory=InterfaceSettings)
    keyboard: KeyboardSettings = Field(default_factory=KeyboardSettings)
    audio: AudioSettings = Field(default_factory=AudioSettings)
    midi: MidiSettings = Field(default_factory=MidiSettings)
    library: LibrarySettings = Field(default_factory=LibrarySettings)
    browser_preview: bool = False


def midi_device_id(name: str, *, browser=False) -> str:
    # ALSA client/port numbers change after unplugging or rebooting a controller.
    stable = name if browser else re.sub(r" \d+:\d+$", "", name)
    return ("browser:" if browser else "server:") + stable


def merge_settings(previous: dict, patch: dict) -> dict:
    result = previous.copy()
    for key, value in patch.items():
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
        self.settings = (
            Configuration.model_validate_json(self.path.read_text())
            if self.path.exists()
            else defaults
        )
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
