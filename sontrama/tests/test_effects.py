import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from sontrama.effect_parameters import EFFECT_KINDS, EFFECT_SPECS
from sontrama.effects import EffectChain
from sontrama.models import EffectSpec
from sontrama.native_effects import NativeEffect, parameter_vector

RATE = 48000


def signal(frames=12288):
    time = np.arange(frames) / RATE
    return (
        np.column_stack(
            (np.sin(time * 2 * np.pi * 440), 0.4 * np.sin(time * 2 * np.pi * 950))
        ).astype(np.float32)
        * 0.4
    )


def render(effect, samples, chunks=(256,)):
    output = []
    offset, iteration = 0, 0
    while offset < len(samples):
        count = chunks[iteration % len(chunks)]
        output.append(effect.process(samples[offset : offset + count]))
        offset += count
        iteration += 1
    return np.concatenate(output)


@pytest.mark.parametrize("kind", EFFECT_KINDS)
def test_legacy_controls_and_full_parameter_round_trip(kind):
    definition = EFFECT_SPECS[kind]
    spec = EffectSpec(kind=kind)
    assert spec.value == definition["parameters"][definition["primary"]]["default"]
    assert spec.parameters.keys() == definition["parameters"].keys()
    assert EffectSpec.model_validate(spec.model_dump()) == spec
    scalar = definition["parameters"][definition["primary"]]["min"]
    legacy = EffectSpec(kind=kind, value=scalar)
    assert legacy.parameters[definition["primary"]] == scalar
    # A parameter-only request also accepts the canonical multi-parameter shape.
    assert EffectSpec(kind=kind, parameters={definition["primary"]: scalar}).value == scalar


@pytest.mark.parametrize(
    "parameters",
    [
        {"frequency": 0},
        {"q": 100},
        {"type": "unknown"},
        {"type": 0},
        {"gain": float("inf")},
        {"mix": True},
        {"extra": 1},
    ],
)
def test_invalid_filter_parameters_are_rejected(parameters):
    with pytest.raises(ValidationError):
        EffectSpec(kind="filter", parameters=parameters)


@pytest.mark.parametrize("kind", EFFECT_KINDS)
def test_effects_are_block_size_independent_and_match_browser(kind):
    samples = signal()
    spec = EffectSpec(kind=kind)
    reference = render(NativeEffect(spec, RATE), samples)
    assert np.isfinite(reference).all()
    assert np.allclose(
        reference, render(NativeEffect(spec, RATE), samples, (64, 127, 512, 1024, 2048)), atol=2e-6
    )
    if not shutil.which("node") or not Path("node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to compare browser DSP")
    result = subprocess.run(
        ["node", "scripts/render-effects.mjs"],
        input=json.dumps(
            {
                "kind": kind,
                "rate": RATE,
                "parameters": parameter_vector(spec).tolist(),
                "samples": samples.tolist(),
                "chunks": [128, 512, 1024],
            }
        ),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    browser = np.array(json.loads(result.stdout), dtype=np.float32)
    assert np.allclose(reference, browser, atol=2e-5, rtol=2e-5), np.max(
        np.abs(reference - browser)
    )


@pytest.mark.parametrize(
    "kind,keep,reject",
    [
        ("lowpass", 100, 8000),
        ("highpass", 8000, 100),
        ("bandpass", 1000, 100),
        ("notch", 100, 1000),
    ],
)
def test_filter_types_have_the_expected_frequency_response(kind, keep, reject):
    def energy(frequency):
        tone = np.sin(2 * np.pi * frequency * np.arange(RATE // 2) / RATE)
        samples = np.column_stack((tone, tone)).astype(np.float32)
        effect = NativeEffect(
            EffectSpec(kind="filter", parameters={"type": kind, "frequency": 1000, "q": 2}), RATE
        )
        return np.mean(render(effect, samples)[RATE // 4 :] ** 2)

    assert energy(keep) > energy(reject) * 20


def test_steeper_filter_and_eq_gain_are_audible():
    samples = np.tile(np.sin(2 * np.pi * 6000 * np.arange(12000) / RATE)[:, None], (1, 2)).astype(
        np.float32
    )
    energy = []
    for slope in ("12", "24"):
        effect = NativeEffect(
            EffectSpec(kind="filter", parameters={"frequency": 1000, "slope": slope}), RATE
        )
        energy.append(np.mean(render(effect, samples)[6000:] ** 2))
    assert energy[1] < energy[0] / 20
    effect = NativeEffect(
        EffectSpec(kind="filter", parameters={"type": "peaking", "frequency": 6000, "gain": 12}),
        RATE,
    )
    assert np.mean(render(effect, samples)[6000:] ** 2) > np.mean(samples[6000:] ** 2) * 10


def test_compressor_reduces_dynamic_range_and_links_stereo():
    samples = signal(RATE)
    plain = render(
        NativeEffect(EffectSpec(kind="compressor", parameters={"ratio": 1}), RATE), samples
    )
    compressed = render(
        NativeEffect(
            EffectSpec(
                kind="compressor",
                parameters={"threshold": -30, "ratio": 8, "attack": 0.1, "release": 300, "knee": 0},
            ),
            RATE,
        ),
        samples,
    )
    assert np.mean(compressed[RATE // 2 :] ** 2) < np.mean(plain[RATE // 2 :] ** 2) * 0.1
    active = (np.abs(samples[:, 0]) > 0.05) & (np.abs(samples[:, 1]) > 0.05)
    assert np.allclose(
        compressed[active, 0] / samples[active, 0],
        compressed[active, 1] / samples[active, 1],
        atol=1e-6,
    )


@pytest.mark.parametrize("lookahead", [0, 3, 10])
def test_limiter_catches_transients_and_obeys_its_ceiling(lookahead):
    rng = np.random.default_rng(12)
    samples = rng.normal(0, 2, (12000, 2)).astype(np.float32)
    effect = NativeEffect(
        EffectSpec(kind="limiter", parameters={"ceiling": -6, "drive": 12, "lookahead": lookahead}),
        RATE,
    )
    result = render(effect, samples, (128, 257, 512))
    assert np.isfinite(result).all()
    assert np.max(np.abs(result)) <= 10 ** (-6 / 20) + 1e-7
    delay = int(lookahead * 0.001 * RATE)
    if delay:
        assert not result[:delay].any()
    assert np.max(np.abs(result)) > 0.49


def test_reverb_decay_and_predelay_and_parameter_edits_preserve_tails():
    impulse = np.zeros((RATE * 2, 2), dtype=np.float32)
    impulse[0] = [1, 0.3]
    energies = []
    for decay in (0.2, 6):
        effect = NativeEffect(
            EffectSpec(kind="reverb", parameters={"mix": 1, "pre_delay": 100, "decay": decay}), RATE
        )
        result = render(effect, impulse)
        assert not result[: int(RATE * 0.1)].any()
        energies.append(np.sum(result[RATE:] ** 2))
    assert energies[1] > energies[0] * 100
    chain = EffectChain([EffectSpec(id="reverb", kind="reverb", value=1)], RATE)
    chain.process(impulse[:2048])
    chain.configure([EffectSpec(id="reverb", kind="reverb", value=1, parameters={"damping": 1500})])
    assert np.max(np.abs(render(chain, impulse[2048 : RATE // 2]))) > 0.001


AUDIBLE_CHANGES = {
    "gain": {"gain": -12, "width": 0},
    "filter": {"frequency": 120, "q": 8, "slope": "24", "mix": 0},
    "chorus": {"rate": 3, "depth": 12, "delay": 5, "spread": 0, "feedback": 0.7, "mix": 0.9},
    "reverb": {
        "decay": 0.2,
        "pre_delay": 100,
        "room": 0.1,
        "damping": 1000,
        "diffusion": 0,
        "width": 0,
        "low_cut": 800,
        "high_cut": 1000,
        "mix": 0.9,
    },
    "compressor": {
        "threshold": -45,
        "ratio": 1,
        "attack": 90,
        "release": 900,
        "knee": 24,
        "makeup": 6,
        "sidechain_hp": 1000,
        "mix": 0,
    },
    "limiter": {"ceiling": -12, "drive": 12, "release": 500, "lookahead": 0},
}


@pytest.mark.parametrize(
    "kind,name,value",
    [
        (kind, name, value)
        for kind, parameters in AUDIBLE_CHANGES.items()
        for name, value in parameters.items()
    ],
)
def test_exposed_parameter_changes_the_audio(kind, name, value):
    samples = signal(RATE) * (4 if kind == "limiter" else 1)
    baseline = render(NativeEffect(EffectSpec(kind=kind), RATE), samples)
    result = render(NativeEffect(EffectSpec(kind=kind, parameters={name: value}), RATE), samples)
    assert np.max(np.abs(result - baseline)) > 1e-5


@pytest.mark.parametrize(
    "kind,parameters",
    [
        ("filter", {"type": kind, "gain": 9, "q": 4, "slope": "24", "mix": 0.7})
        for kind in ("lowpass", "highpass", "bandpass", "notch", "peaking", "lowshelf", "highshelf")
    ]
    + [
        ("chorus", {"rate": 3, "feedback": -0.5, "depth": 15, "spread": 150}),
        ("reverb", {"decay": 6, "room": 1, "pre_delay": 0, "width": 1.5}),
        ("compressor", {"threshold": -35, "ratio": 8, "knee": 24, "makeup": 3, "attack": 0.5}),
        ("limiter", {"ceiling": -12, "drive": 12, "lookahead": 10, "release": 5}),
    ],
)
def test_browser_native_parity_with_nondefault_settings_and_live_edits(kind, parameters):
    if not shutil.which("node") or not Path("node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to compare browser DSP")
    samples = signal()
    original = EffectSpec(kind=kind)
    edited = EffectSpec(kind=kind, parameters=parameters)
    native = NativeEffect(original, RATE)
    first = render(native, samples[:4096])
    native.configure(edited)
    reference = np.concatenate((first, render(native, samples[4096:])))
    result = subprocess.run(
        ["node", "scripts/render-effects.mjs"],
        input=json.dumps(
            {
                "kind": kind,
                "rate": RATE,
                "parameters": parameter_vector(original).tolist(),
                "samples": samples.tolist(),
                "chunks": [256],
                "updates": [{"at": 4096, "parameters": parameter_vector(edited).tolist()}],
            }
        ),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    browser = np.array(json.loads(result.stdout), dtype=np.float32)
    assert np.allclose(reference, browser, atol=2e-5, rtol=2e-5), np.max(
        np.abs(reference - browser)
    )
