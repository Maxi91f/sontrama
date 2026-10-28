from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class EffectSpec(StrictModel):
    id: str = Field(default_factory=lambda: uuid4().hex, min_length=1, max_length=64)
    kind: Literal["chorus", "reverb", "gain", "filter"]
    enabled: bool = True
    value: float = 0.25

    @model_validator(mode="after")
    def parameter_range(self):
        low, high = {"gain": (-24, 12), "filter": (100, 18000)}.get(self.kind, (0, 1))
        if not low <= self.value <= high:
            raise ValueError(f"{self.kind}: value must be between {low} and {high}")
        return self


class OscillatorSpec(StrictModel):
    enabled: bool = True
    shape: Literal["sine", "triangle", "square", "saw", "rounded-saw", "noise"] = "sine"
    coarse: int = Field(default=0, ge=-24, le=24)
    fine: float = Field(default=0, ge=-100, le=100)
    pan: float = Field(default=0, ge=-1, le=1)
    phase: float = Field(default=0, ge=0, le=360)
    detune: float = Field(default=0, ge=-100, le=100)
    phase_start: float = Field(default=0, ge=0, le=360)
    mix: float = Field(default=0, ge=0, le=1)

    @model_validator(mode="before")
    @classmethod
    def legacy_phase(cls, value):
        if isinstance(value, dict) and "invert" in value:
            value = dict(value)
            inverted = value.pop("invert")
            value.setdefault("phase_start", 180 if inverted else 0)
        return value


class EnvelopeSpec(StrictModel):
    attack: float = Field(default=0.005, ge=0.001, le=5)
    decay: float = Field(default=0.12, ge=0.001, le=5)
    sustain: float = Field(default=0.8, ge=0, le=1)
    release: float = Field(default=0.18, ge=0.001, le=5)


class ThreeOscPatch(StrictModel):
    oscillators: list[OscillatorSpec] = Field(
        default_factory=lambda: [
            OscillatorSpec(),
            OscillatorSpec(),
            OscillatorSpec(),
        ],
        min_length=3,
        max_length=3,
    )
    envelope: EnvelopeSpec = Field(default_factory=EnvelopeSpec)
    am_osc3: bool = False
    phase_random: float = Field(default=0, ge=0, le=1)
    hq: bool = True


class Session(StrictModel):
    instrument: Literal["banks", "three-osc"] = "banks"
    three_osc: ThreeOscPatch = Field(default_factory=ThreeOscPatch)
    soundfont: str = ""
    bank: int = Field(default=0, ge=0, le=16383)
    program: int = Field(default=0, ge=0, le=127)
    octave: int = Field(default=0, ge=-2, le=2)
    sustain: bool = False
    usb_enabled: bool = True
    midi_channel: int | None = Field(default=None, ge=0, le=15)
    volume: float = Field(default=0.78, ge=0, le=1)
    master: float = Field(default=0.85, ge=0, le=1)
    mute: bool = False
    solo: bool = False
    output: Literal["device"] = "device"
    effects: list[EffectSpec] = Field(
        default_factory=lambda: [
            EffectSpec(kind="chorus", value=0.18),
            EffectSpec(kind="reverb", value=0.26),
        ],
        max_length=8,
    )

    @model_validator(mode="after")
    def unique_effect_ids(self):
        if len({effect.id for effect in self.effects}) != len(self.effects):
            raise ValueError("Effect IDs must be unique")
        return self


class MidiEvent(StrictModel):
    data: list[int] = Field(min_length=2, max_length=3)

    @model_validator(mode="after")
    def valid_channel_message(self):
        status = self.data[0]
        if not 0x80 <= status < 0xF0:
            raise ValueError("Only MIDI channel messages are supported")
        size = 2 if status & 0xF0 in (0xC0, 0xD0) else 3
        if len(self.data) != size or any(not 0 <= v <= 127 for v in self.data[1:]):
            raise ValueError("Invalid MIDI bytes")
        return self


class StateStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> Session:
        if not self.path.exists():
            return Session()
        saved = json.loads(self.path.read_text())
        # Older sessions used browser audio as a destination; it is now a local preview.
        if saved.get("output") == "browser":
            saved["output"] = "device"
        return Session.model_validate(saved)

    def save(self, state: BaseModel):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w") as file:
            json.dump(state.model_dump(), file, indent=2)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(self.path)
