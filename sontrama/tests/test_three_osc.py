import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sontrama.app import create_app
from sontrama.catalog import BankCatalog
from sontrama.models import Session, StateStore, ThreeOscPatch
from sontrama.runtime import Studio
from sontrama.three_osc import ThreeOscInstrument


def render(synth, blocks=40):
    return np.concatenate([synth.render(256) for _ in range(blocks)])


def peak_frequency(audio, sample_rate=44100):
    signal = audio[-8192:, 0]
    spectrum = np.abs(np.fft.rfft(signal * np.hanning(len(signal))))
    return np.argmax(spectrum) * sample_rate / len(signal)


def test_pitch_coarse_tuning_bend_and_release():
    patch = ThreeOscPatch()
    synth = ThreeOscInstrument(44100, patch)
    synth.midi([0x90, 69, 100])
    audio = render(synth)
    assert abs(peak_frequency(audio) - 440) < 6
    assert np.max(np.abs(audio)) > 0.05
    for oscillator in patch.oscillators:
        oscillator.coarse = 12
    synth.configure(patch.model_dump())
    assert abs(peak_frequency(render(synth)) - 880) < 6
    synth.midi([0xE0, 127, 127])
    assert abs(peak_frequency(render(synth)) - 880 * 2 ** (2 / 12)) < 7
    synth.midi([0x80, 69, 0])
    assert not np.any(render(synth)[-256:])
    assert not synth.voices


@pytest.mark.parametrize("shape", ["sine", "triangle", "square", "saw", "rounded-saw", "noise"])
def test_shapes_are_finite_and_sustain_releases(shape):
    patch = ThreeOscPatch()
    patch.oscillators[0].shape = shape
    patch.oscillators[1].mix = patch.oscillators[2].mix = 0
    synth = ThreeOscInstrument(44100, patch)
    synth.midi([0x90, 60, 110])
    synth.midi([0xB0, 64, 127])
    synth.midi([0x80, 60, 0])
    audio = render(synth)
    assert np.all(np.isfinite(audio))
    assert np.max(np.abs(audio)) > 0.03
    assert synth.voices[60].release_age is None
    synth.midi([0xB0, 64, 0])
    assert not np.any(render(synth)[-256:])


def test_phase_offset_mix_and_pan():
    patch = ThreeOscPatch()
    patch.oscillators[1].mix = 0.5
    patch.oscillators[2].mix = 0
    patch.oscillators[1].phase_start = 180
    synth = ThreeOscInstrument(44100, patch)
    synth.midi([0x90, 60, 100])
    assert np.max(np.abs(render(synth))) < 1e-7
    patch.oscillators[1].mix = 0
    patch.oscillators[0].pan = -1
    synth.configure(patch.model_dump())
    audio = render(synth)
    assert np.max(np.abs(audio[:, 0])) > 0.03
    assert np.max(np.abs(audio[:, 1])) < 1e-7
    synth.panic()
    assert not np.any(synth.render(256))


def test_voice_limit_and_controllers():
    synth = ThreeOscInstrument(44100, ThreeOscPatch())
    for note in range(48, 72):
        synth.midi([0x90, note, 100])
    assert len(synth.voices) == 16
    for data in ([0xB0, 1, 100], [0xD0, 80], [0xA0, 65, 80], [0xB0, 10, 64]):
        synth.midi(data)
    assert np.all(np.isfinite(render(synth, 3)))
    synth.midi([0xB0, 11, 0])
    assert not np.any(synth.render(256))
    synth.midi([0xB0, 121, 0])
    assert np.max(np.abs(synth.render(256))) > 0.005
    synth.midi([0xB0, 120, 0])
    assert not np.any(synth.render(256))


def test_am_phase_random_hq_and_stereo():
    patch = ThreeOscPatch(am_osc3=True, phase_random=0.5, hq=False)
    patch.oscillators[2].mix = 0.5
    patch.oscillators[0].detune = 15
    patch.oscillators[1].phase = 90
    synth = ThreeOscInstrument(44100, patch)
    synth.midi([0x90, 60, 100])
    audio = render(synth)
    assert np.all(np.isfinite(audio))
    assert not np.allclose(audio[:, 0], audio[:, 1])
    patch.hq = True
    synth.configure(patch.model_dump())
    assert np.all(np.isfinite(render(synth)))


def test_configuration_validation_and_persistence(tmp_path):
    with pytest.raises(ValidationError):
        ThreeOscPatch(oscillators=[])
    config = ThreeOscPatch().model_dump()
    config["oscillators"][0]["fine"] = 101
    with pytest.raises(ValidationError):
        ThreeOscPatch.model_validate(config)
    state = Session(instrument="three-osc")
    store = StateStore(tmp_path / "session.json")
    store.save(state)
    assert store.load() == state


def test_live_switch_without_soundfonts_keeps_notes_during_parameter_changes(tmp_path):
    studio = Studio(BankCatalog([]), StateStore(tmp_path / "session.json"))
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        response = client.patch("/api/session", json={"instrument": "three-osc"})
        assert response.status_code == 200
        assert response.json()["status"]["engine"] == "ready"
        assert not response.json()["status"]["errors"]
        studio.midi([0x90, 60, 100], "test")
        instrument = studio.instrument
        assert np.max(np.abs(render(studio))) > 0.005
        config = studio.state.three_osc.model_dump()
        config["oscillators"][0]["shape"] = "square"
        assert client.patch("/api/session", json={"three_osc": config}).status_code == 200
        assert studio.instrument is instrument
        assert 60 in instrument.voices
        assert np.max(np.abs(render(studio))) > 0.005
        assert studio.store.load().instrument == "three-osc"


def test_service_restart_restores_three_osc_without_soundfonts(tmp_path):
    store = StateStore(tmp_path / "session.json")
    store.save(Session(instrument="three-osc"))
    studio = Studio(BankCatalog([]), store)
    studio.start(audio=False, midi=False)
    try:
        assert studio.status["engine"] == "ready"
        assert not studio.status["errors"]
        studio.midi([0x90, 60, 100], "test")
        assert np.max(np.abs(render(studio))) > 0.005
    finally:
        studio.close()


def test_common_phase_moves_both_channels_and_preserves_stereo_offset():
    patch = ThreeOscPatch()
    patch.oscillators[0].phase_start = 90
    patch.oscillators[0].phase = 45
    synth = ThreeOscInstrument(44100, patch)
    synth.midi([0x90, 60, 100])
    assert np.allclose(synth.voices[60].phases[0], [0.25, 0.375])
    synth.render(256)
    before = synth.voices[60].phases[0].copy()
    age = synth.voices[60].age
    patch.oscillators[0].phase_start = 180
    synth.configure(patch.model_dump())
    assert np.allclose((synth.voices[60].phases[0] - before) % 1, [0.25, 0.25])
    assert synth.voices[60].age == age
    before = synth.voices[60].phases[0].copy()
    patch.oscillators[0].phase = 90
    synth.configure(patch.model_dump())
    assert np.allclose((synth.voices[60].phases[0] - before) % 1, [0, 0.125])
    assert np.all(np.isfinite(render(synth)))


def test_legacy_inverter_settings_load_as_phase_slider(tmp_path):
    import json

    state = Session(instrument="three-osc").model_dump()
    oscillator = state["three_osc"]["oscillators"][0]
    oscillator.pop("phase_start")
    oscillator["invert"] = True
    path = tmp_path / "session.json"
    path.write_text(json.dumps(state))
    loaded = StateStore(path).load()
    assert loaded.three_osc.oscillators[0].phase_start == 180
    assert "invert" not in loaded.three_osc.oscillators[0].model_dump()


@pytest.mark.parametrize("am", [False, True])
def test_native_kernel_matches_reference_audio(am):
    patch = ThreeOscPatch(am_osc3=am)
    for oscillator, shape in zip(patch.oscillators, ["saw", "triangle", "square"], strict=True):
        oscillator.shape = shape
    patch.oscillators[0].phase_start = 40
    patch.oscillators[0].detune = 11
    patch.oscillators[1].phase = 90
    patch.oscillators[1].mix = 0.4
    patch.oscillators[2].mix = 0.2
    native = ThreeOscInstrument(44100, patch)
    if native.kernel is None:
        pytest.skip("Native DSP needs a C compiler")
    reference = ThreeOscInstrument(44100, patch)
    reference.kernel = None
    for synth in (native, reference):
        for note in (48, 60, 67):
            synth.midi([144, note, 90])
        synth.midi([176, 1, 80])
    for _ in range(20):
        actual = native.render(256)
        expected = reference.render(256)
        assert np.allclose(actual, expected, atol=0.002, rtol=0)
