"""SoundFont metadata is independent of the synthesis engine."""

from __future__ import annotations

import hashlib
import struct
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Preset:
    name: str
    bank: int
    program: int


def presets_from_sf2(path: Path) -> list[Preset]:
    with path.open("rb") as file:
        header = file.read(12)
        if header[:4] != b"RIFF" or header[8:] != b"sfbk":
            raise ValueError(f"Not a SoundFont: {path.name}")
        limit = min(path.stat().st_size, 8 + struct.unpack_from("<I", header, 4)[0])
        while file.tell() + 8 <= limit:
            chunk, size = struct.unpack("<4sI", file.read(8))
            end = file.tell() + size
            if chunk == b"LIST" and file.read(4) == b"pdta":
                while file.tell() + 8 <= end:
                    subchunk, subsize = struct.unpack("<4sI", file.read(8))
                    if subchunk == b"phdr":
                        raw = file.read(subsize)
                        if len(raw) != subsize or subsize % 38:
                            raise ValueError("Invalid SoundFont preset headers")
                        return [
                            Preset(name.split(b"\0", 1)[0].decode("latin1"), bank, program)
                            for name, program, bank, *_ in struct.iter_unpack("<20sHHHIII", raw)
                            if name.split(b"\0", 1)[0] != b"EOP"
                        ]
                    file.seek(subsize + (subsize % 2), 1)
            file.seek(end + (size % 2))
    raise ValueError(f"No presets found in {path.name}")


class BankCatalog:
    def __init__(self, paths: list[Path]):
        self.paths: dict[str, Path] = {}
        self.banks: list[dict] = []
        self.errors: list[str] = []
        seen: set[Path] = set()
        for root in paths:
            candidates = [root] if root.is_file() else sorted(root.glob("*.sf2"))
            for candidate in candidates:
                candidate = candidate.resolve()
                if candidate in seen:
                    continue
                seen.add(candidate)
                try:
                    presets = sorted(presets_from_sf2(candidate), key=lambda p: (p.bank, p.program))
                    if not presets:
                        raise ValueError("SoundFont has no playable presets")
                except (OSError, ValueError, struct.error) as error:
                    self.errors.append(f"{candidate.name}: {error}")
                    continue
                identifier = hashlib.sha256(str(candidate).encode()).hexdigest()[:16]
                self.paths[identifier] = candidate
                self.banks.append(
                    {
                        "id": identifier,
                        "name": candidate.stem,
                        "presets": [asdict(preset) for preset in presets],
                    }
                )

    def validate_preset(self, identifier: str, bank: int, program: int):
        for entry in self.banks:
            if entry["id"] == identifier:
                if any(p["bank"] == bank and p["program"] == program for p in entry["presets"]):
                    return
                raise ValueError("Preset unavailable in this SoundFont")
        raise ValueError("Unknown SoundFont")
