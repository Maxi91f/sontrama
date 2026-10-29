"""Parameter contracts shared with the browser, without UI text or DSP state."""

import json
from pathlib import Path

EFFECT_SPECS = json.loads(Path(__file__).with_name("effect_specs.json").read_text())
EFFECT_KINDS = tuple(EFFECT_SPECS)


def defaults(kind: str) -> dict:
    return {name: spec["default"] for name, spec in EFFECT_SPECS[kind]["parameters"].items()}
