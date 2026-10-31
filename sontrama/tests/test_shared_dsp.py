"""Compare production native and WASM builds with identical musical timelines."""

import base64
import json
import subprocess

import numpy as np
import pytest

from sontrama.effects import EffectChain
from sontrama.models import EffectSpec, Session, ThreeOscPatch
from sontrama.native_core import NativeBus, clip, core_revision
from sontrama.three_osc import ThreeOscInstrument

SCENARIOS = (
    "sine",
    "triangle",
    "square",
    "saw",
    "rounded-saw",
    "noise",
    "hq",
    "stereo",
    "am",
    "controllers",
    "sustain",
    "edit",
    "stealing",
    "random-phase",
    "pipeline",
)


def make_case(scenario, rate):
    patch = ThreeOscPatch()
    note = 76 if scenario == "hq" else 69
    events = [
        {"at": 0, "midi": [0x90, note, 100]},
        {"at": int(0.4 * rate), "midi": [0x80, note, 0]},
    ]
    case = {
        "name": f"{scenario}-{rate}",
        "rate": rate,
        "frames": int(0.7 * rate),
        "seed": 1,
        "events": events,
    }
    if scenario in ("sine", "triangle", "square", "saw", "rounded-saw", "noise"):
        patch.oscillators[0].shape = scenario
    elif scenario == "hq":
        patch.hq = True
        patch.oscillators[0].shape = "saw"
    elif scenario == "stereo":
        patch.oscillators[0].phase_start = 70
        patch.oscillators[0].phase = 120
        patch.oscillators[0].detune = 13
        patch.oscillators[1].shape = "triangle"
        patch.oscillators[1].coarse = 7
        patch.oscillators[1].mix = 0.3
    elif scenario == "am":
        patch.am_osc3 = True
        patch.oscillators[2].coarse = -12
        patch.oscillators[2].mix = 0.7
    elif scenario == "controllers":
        controls = [
            [0xB0, 1, 100],
            [0xD0, 90],
            [0xA0, 69, 80],
            [0xB0, 7, 90],
            [0xB0, 11, 85],
            [0xB0, 10, 100],
            [0xE0, 0, 72],
        ]
        events[1:1] = [{"at": int(0.1 * rate), "midi": control} for control in controls]
    elif scenario == "sustain":
        events.insert(1, {"at": int(0.1 * rate), "midi": [0xB0, 64, 127]})
        events.append({"at": int(0.5 * rate), "midi": [0xB0, 64, 0]})
    elif scenario == "edit":
        edited = patch.model_copy(deep=True)
        edited.oscillators[0].phase_start = 180
        edited.oscillators[0].shape = "square"
        edited.envelope.sustain = 0.4
        events.insert(1, {"at": int(0.2 * rate), "patch": edited.model_dump()})
    elif scenario == "stealing":
        events[:] = [{"at": 0, "midi": [0x90, n, 60]} for n in range(48, 68)]
        events.extend({"at": int(0.4 * rate), "midi": [0x80, n, 0]} for n in range(48, 68))
    elif scenario == "random-phase":
        patch.phase_random = 1
        patch.oscillators[0].shape = "noise"
        patch.oscillators[1].mix = 0.3
    elif scenario == "pipeline":
        session = Session(
            instrument="three-osc",
            three_osc=patch,
            effects=[EffectSpec(id=kind, kind=kind) for kind in ("chorus", "filter", "gain")],
            master_effects=[
                EffectSpec(id=kind, kind=kind) for kind in ("reverb", "compressor", "limiter")
            ],
        )
        case["session"] = session.model_dump()
        edited = session.model_copy(deep=True)
        edited.volume = 0.4
        edited.pan = -0.65
        edited.master_pan = 0.35
        edited.effects[0] = EffectSpec(
            id="chorus", kind="chorus", parameters={"mix": 0.7, "feedback": 0.5}
        )
        events.insert(1, {"at": int(0.15 * rate), "session": edited.model_dump()})
        muted = edited.model_copy(deep=True)
        muted.master_mute = True
        events.insert(2, {"at": int(0.3 * rate), "session": muted.model_dump()})
        events.insert(3, {"at": int(0.35 * rate), "session": edited.model_dump()})
    case["patch"] = patch.model_dump()
    return case


def render_native(case, chunks=(512,)):
    engine = ThreeOscInstrument(
        case["rate"], ThreeOscPatch.model_validate(case["patch"]), seed=case["seed"]
    )
    session = Session.model_validate(case["session"]) if "session" in case else None
    if session:
        channel, master = (
            EffectChain(session.effects, case["rate"]),
            EffectChain(session.master_effects, case["rate"]),
        )
        channel_bus = NativeBus(case["rate"], session.volume, session.pan, session.mute)
        master_bus = NativeBus(
            case["rate"], session.master, session.master_pan, session.master_mute
        )
    offset = index = iteration = 0
    out, channel_out, master_out = [], [], []
    try:
        while offset < case["frames"]:
            while index < len(case["events"]) and case["events"][index]["at"] == offset:
                event = case["events"][index]
                index += 1
                if "midi" in event:
                    engine.midi(event["midi"])
                if "patch" in event:
                    engine.configure(event["patch"])
                if "session" in event:
                    session = Session.model_validate(event["session"])
                    for chain, specs in (
                        (channel, session.effects),
                        (master, session.master_effects),
                    ):
                        chain.configure(specs)
                    channel_bus.configure(session.volume, session.pan, session.mute)
                    master_bus.configure(session.master, session.master_pan, session.master_mute)
            end = min(
                offset + chunks[iteration % len(chunks)],
                case["frames"],
                case["events"][index]["at"] if index < len(case["events"]) else case["frames"],
            )
            block = engine.render(end - offset)
            if session:
                block = channel_bus.process(channel.process(block))
                channel_out.append(block.copy())
                block = master_bus.process(master.process(block))
                master_out.append(block.copy())
                block = clip(block)
            else:
                channel_out.append(block.copy())
                master_out.append(block.copy())
            out.append(block)
            iteration += 1
            offset = end
    finally:
        engine.close()
    return {
        "samples": np.concatenate(out),
        "channel": np.concatenate(channel_out),
        "master": np.concatenate(master_out),
    }


@pytest.fixture(scope="module")
def compiled_pairs():
    subprocess.run(["node", "scripts/build-dsp.mjs"], check=True, capture_output=True, text=True)
    cases = [make_case(scenario, rate) for scenario in SCENARIOS for rate in (44100, 48000)]
    result = subprocess.run(
        ["node", "scripts/render-core.mjs"],
        input=json.dumps(cases),
        text=True,
        capture_output=True,
        check=True,
        timeout=120,
    )
    assert all(row["revision"] == core_revision() for row in json.loads(result.stdout))
    wasm = {
        row["name"]: {
            key: np.frombuffer(base64.b64decode(row[key]), dtype="<f4").reshape(-1, 2)
            for key in ("samples", "channel", "master")
        }
        for row in json.loads(result.stdout)
    }
    return {case["name"]: (case, render_native(case), wasm[case["name"]]) for case in cases}


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("scenario", SCENARIOS)
def test_native_and_wasm_share_instruments_effects_and_mixer(compiled_pairs, scenario, rate):
    case, native, wasm = compiled_pairs[f"{scenario}-{rate}"]
    for bus in native:
        assert np.isfinite(wasm[bus]).all()
        assert np.allclose(native[bus], wasm[bus], atol=2e-5, rtol=2e-5), (
            case["name"],
            bus,
            float(np.max(np.abs(native[bus] - wasm[bus]))),
        )
    assert np.max(np.abs(native["samples"])) > 0.001


@pytest.mark.parametrize(
    "scenario", ["noise", "random-phase", "hq", "controllers", "sustain", "stealing", "pipeline"]
)
def test_host_block_sizes_do_not_change_the_shared_engine(compiled_pairs, scenario):
    case, reference, _ = compiled_pairs[f"{scenario}-44100"]
    actual = render_native(case, chunks=(37, 127, 1024))
    assert np.allclose(reference["samples"], actual["samples"], atol=2e-5, rtol=2e-5)
