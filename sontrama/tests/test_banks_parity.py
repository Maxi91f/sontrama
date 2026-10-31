"""Pin Banks resources/version and compare real native and WASM synth renders."""

import base64
import json
import subprocess

import numpy as np
import pytest
from soundfont_fixture import sine_soundfont

from sontrama.fluid_library import fluid_version
from sontrama.instruments import BanksInstrument
from sontrama.native_core import CONTRACT


@pytest.mark.parametrize("rate", [44100, 48000])
def test_pinned_banks_engines_match_notes_bend_sustain_and_release(tmp_path, rate):
    font = sine_soundfont(tmp_path / "sine.sf2")
    assert fluid_version() == CONTRACT["fluidsynth"]
    events = [
        {"at": 0, "midi": [0x90, 69, 100]},
        {"at": round(0.1 * rate), "midi": [0xB0, 64, 127]},
        {"at": round(0.15 * rate), "midi": [0xE0, 0, 72]},
        {"at": round(0.2 * rate), "midi": [0x80, 69, 0]},
        {"at": round(0.3 * rate), "midi": [0xB0, 64, 0]},
    ]
    test = {"rate": rate, "frames": round(0.6 * rate), "events": events, "soundfont": str(font)}
    result = subprocess.run(
        ["node", "scripts/render-banks.mjs"],
        input=json.dumps([test]),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    wasm = np.frombuffer(base64.b64decode(json.loads(result.stdout)[0]), dtype="<f4").reshape(-1, 2)
    engine = BanksInstrument(rate)
    blocks = []
    offset = index = 0
    try:
        engine.select(font, 0, 0)
        while offset < test["frames"]:
            while index < len(events) and events[index]["at"] == offset:
                engine.midi(events[index]["midi"])
                index += 1
            end = min(
                offset + 512,
                test["frames"],
                events[index]["at"] if index < len(events) else test["frames"],
            )
            blocks.append(engine.render(end - offset))
            offset = end
    finally:
        engine.close()
    native = np.concatenate(blocks)
    assert np.max(np.abs(native)) > 0.01
    assert np.allclose(native, wasm, atol=2e-5, rtol=2e-5), float(np.max(np.abs(native - wasm)))
