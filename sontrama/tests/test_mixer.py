import base64
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sontrama.app import create_app
from sontrama.catalog import BankCatalog
from sontrama.effects import StereoPanner
from sontrama.models import EffectSpec, Session, StateStore
from sontrama.runtime import Studio


class StereoTone:
    def midi(self, data):
        pass

    def panic(self):
        pass

    def close(self):
        pass

    def render(self, frames):
        return np.tile(np.array([0.1, 0.2], dtype=np.float32), (frames, 1))


@pytest.fixture
def studio(tmp_path):
    store = StateStore(tmp_path / "session.json")
    store.save(Session(instrument="three-osc", effects=[], volume=1, master=1))
    studio = Studio(BankCatalog([]), store, instrument_factory=lambda state: StereoTone())
    studio.start(audio=False, midi=False)
    yield studio
    studio.close()


@pytest.mark.parametrize("pan,expected", [(-1, [0.3, 0]), (0, [0.1, 0.2]), (1, [0, 0.3])])
def test_stereo_pan_preserves_opposite_side_when_folding(pan, expected):
    block = np.tile(np.array([0.1, 0.2], dtype=np.float32), (512, 1))
    assert np.allclose(StereoPanner(pan).process(block), expected, atol=1e-7)
    assert np.allclose(block, [0.1, 0.2])


def test_master_inserts_pan_and_mute_are_independent_of_channel(studio):
    studio.update({"effects": [{"id": "channel-gain", "kind": "gain", "value": -6}]})
    channel = studio.render(256).copy()
    master_gain = {"id": "master-gain", "kind": "gain", "value": -12}
    studio.update({"master_effects": [master_gain], "master_pan": -1})
    result = studio.render(256)
    assert np.allclose(result[:, 0], channel.sum(axis=1) * 10 ** (-12 / 20))
    assert np.allclose(result[:, 1], 0, atol=1e-7)
    assert np.allclose(studio.stereo_levels[0], np.max(np.abs(channel), axis=0))
    assert np.allclose(studio.stereo_levels[1], np.max(np.abs(result), axis=0))
    chain = studio.chain
    studio.update({"master_mute": True})
    assert not studio.render(256).any()
    assert studio.levels[0] > 0 and studio.levels[1] == 0
    assert studio.chain is chain
    assert studio.store.load().master_effects[0].id == "master-gain"
    studio.update({"master_mute": False, "master_pan": 0, "master_effects": []})
    assert np.allclose(studio.render(256), channel)


def test_session_migration_and_effect_id_validation(tmp_path):
    path = tmp_path / "session.json"
    path.write_text(
        json.dumps({"volume": 0.3, "effects": [{"id": "legacy", "kind": "gain", "value": -3}]})
    )
    migrated = StateStore(path).load()
    assert migrated.volume == 0.3 and migrated.effects[0].id == "legacy"
    assert migrated.pan == migrated.master_pan == 0
    assert migrated.master_effects == [] and not migrated.master_mute
    with pytest.raises(ValidationError):
        Session(
            effects=[EffectSpec(id="same", kind="gain")],
            master_effects=[EffectSpec(id="same", kind="gain")],
        )
    for values in (
        {"pan": 1.1},
        {"master_pan": float("nan")},
        {"master_effects": [EffectSpec(kind="gain")] * 9},
    ):
        with pytest.raises(ValidationError):
            Session(**values)


def test_master_controls_are_persisted_and_broadcast(studio):
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        with client.websocket_connect("/ws") as socket:
            socket.receive_json()
            response = client.patch(
                "/api/session", json={"master_solo": True, "master_mute": True, "pan": 0.4}
            )
            assert response.status_code == 200
            while True:
                event = socket.receive_json()
                if event["type"] == "state":
                    break
            assert event["session"]["master_solo"] and event["session"]["master_mute"]
            assert event["session"]["pan"] == 0.4
            assert studio.store.load().master_mute


def test_meter_interval_preserves_short_peaks_and_reports_preclip_levels(studio):
    studio.update({"effects": [{"id": "meter-gain", "kind": "gain", "value": 24}]})
    output = studio.render(128)
    assert np.max(np.abs(output)) == 1
    studio.update({"volume": 0})
    assert not studio.render(512).any()
    assert studio.levels == [0, 0]
    reading = studio.read_meters()
    assert reading["channel"] == reading["master"] == 1
    assert reading["channel_stereo"][0] > 1
    assert reading["channel_stereo"][1] > reading["channel_stereo"][0]
    assert reading["master_stereo"] == reading["channel_stereo"]
    silent = studio.read_meters()
    assert silent["channel_stereo"] == silent["master_stereo"] == [0, 0]


def test_visualization_capture_is_bounded_and_preserves_both_bus_signals(studio):
    studio.render(128)
    assert not np.any(studio.read_visualization()["channel"])
    studio.enable_visualization(True)
    studio.update({"master": 0.5})
    studio.render(256)
    studio.render(256)
    frame = studio.read_visualization()
    assert frame["sample_rate"] == studio.sample_rate
    assert np.array(frame["channel"]).shape == (2, 1024)
    assert np.allclose(np.array(frame["channel"])[:, :512], 0)
    assert np.allclose(np.array(frame["channel"])[:, 512:], [[0.1], [0.2]])
    assert np.allclose(np.array(frame["master"])[:, 512:], [[0.05], [0.1]])
    studio.render(2048)
    assert np.allclose(studio.read_visualization()["channel"], [[0.1] * 1024, [0.2] * 1024])
    studio.enable_visualization(False)
    studio.render(128)
    assert not np.any(studio.read_visualization()["channel"])


def test_tuner_window_keeps_bass_periods_and_selects_a_channel_without_phase_cancellation(studio):
    phase = 0

    def render(frames):
        nonlocal phase
        values = np.sin(2 * np.pi * 55 * (np.arange(frames) + phase) / studio.sample_rate)
        phase += frames
        return np.column_stack((values * 0.1, values * -0.2)).astype(np.float32)

    studio.instrument.render = render
    studio.enable_visualization(True)
    for _ in range(8):
        studio.render(512)
    frame = studio.read_visualization()
    assert np.array(frame["channel"]).shape == (2, 1024)
    pitch = np.array(frame["pitch"]["channel"])
    assert len(pitch) == 1024
    rate = frame["pitch"]["sample_rate"]
    dominant = np.argmax(np.abs(np.fft.rfft(pitch))) * rate / len(pitch)
    assert abs(dominant - 55) < rate / len(pitch)
    assert np.sqrt(np.mean(pitch**2)) > 0.12


def test_spectral_windows_preserve_quiet_signals_below_the_meter_floor(studio):
    studio.enable_visualization(True)
    studio.update({"volume": 0.00001})
    studio.render(4096)
    frame = studio.read_visualization(4096)
    channel = np.array(frame["channel"])
    assert channel.shape == (2, 4096)
    assert np.allclose(channel[0], 0.000001, atol=1e-9)
    assert np.allclose(channel[1], 0.000002, atol=1e-9)


@pytest.mark.parametrize("window_size", [1024, 2048, 4096])
def test_packed_visualization_preserves_stereo_and_quiet_samples(studio, window_size):
    studio.enable_visualization(True)
    studio.update({"volume": 0.00001, "master": 0.5})
    studio.render(4096)
    frame = studio.read_visualization(window_size, packed=True)
    assert frame["encoding"] == "float32-base64"
    for bus, expected in (("channel", [1e-6, 2e-6]), ("master", [0.5e-6, 1e-6])):
        for side, value in zip(frame[bus], expected, strict=True):
            samples = np.frombuffer(base64.b64decode(side), dtype="<f4")
            assert len(samples) == window_size
            assert np.allclose(samples, value, rtol=1e-6, atol=0)
    pitch = np.frombuffer(base64.b64decode(frame["pitch"]["channel"]), dtype="<f4")
    assert len(pitch) == 1024
    assert np.allclose(pitch, 2e-6, rtol=1e-6, atol=0)
