from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sontrama.app import create_app
from sontrama.catalog import BankCatalog
from sontrama.effects import EffectChain
from sontrama.models import EffectSpec, MidiEvent, Session, StateStore
from sontrama.runtime import MidiRouter, Studio


def test_router_transposition_overlap_and_release():
    sent = []
    router = MidiRouter(sent.append)
    router.route([0x91, 60, 100], "a", octave=1)
    router.route([0x92, 72, 70], "b")
    router.route([0x81, 60, 0], "a", octave=-1)
    assert sent == [[0x90, 72, 100], [0x90, 72, 70]]
    router.release_source("b")
    assert sent[-2:] == [[0x80, 72, 0], [0xB0, 64, 0]]
    assert not router.notes


def test_router_velocity_zero_and_out_of_range():
    sent = []
    router = MidiRouter(sent.append)
    router.route([0x90, 120, 90], "a", octave=1)
    assert not sent
    router.route([0x90, 60, 90], "a")
    router.route([0x90, 60, 0], "a")
    assert sent == [[0x90, 60, 90], [0x80, 60, 0]]


@pytest.mark.parametrize("data", [[0x90, 60], [0x90, 128, 1], [0xF0, 1], [0xC0, 1, 0]])
def test_malformed_midi_is_rejected(data):
    with pytest.raises(ValidationError):
        MidiEvent(data=data)


def test_invalid_session_and_effect_values():
    for patch in ({"volume": 2}, {"master": float("nan")}, {"octave": 9}):
        with pytest.raises(ValidationError):
            Session(**patch)
    with pytest.raises(ValidationError):
        EffectSpec(kind="gain", value=30)
    with pytest.raises(ValidationError):
        Session(
            effects=[EffectSpec(id="same", kind="chorus"), EffectSpec(id="same", kind="reverb")]
        )


def test_state_round_trip(tmp_path):
    store = StateStore(tmp_path / "nested/session.json")
    state = Session(volume=0.34, octave=-1, effects=[EffectSpec(kind="gain", value=-6)])
    store.save(state)
    assert store.load() == state
    assert not store.path.with_suffix(".tmp").exists()


def test_effect_chain_order_and_bypass():
    # A modulated delay and low-pass don't commute: reordering must change the signal.
    blocks = np.random.default_rng(12).normal(0, 0.2, (256, 2)).astype(np.float32)
    gain = EffectSpec(kind="gain", value=-6)
    bypassed = EffectSpec(kind="filter", value=100, enabled=False)
    assert np.allclose(
        EffectChain([gain, bypassed], 44100).process(blocks), blocks * 10 ** (-6 / 20)
    )
    first = EffectChain(
        [EffectSpec(kind="filter", value=1000), EffectSpec(kind="chorus", value=0.8)], 44100
    )
    second = EffectChain(
        [EffectSpec(kind="chorus", value=0.8), EffectSpec(kind="filter", value=1000)], 44100
    )
    difference = 0.0
    for _ in range(40):
        a, b = first.process(blocks), second.process(blocks)
        assert np.all(np.isfinite(a)) and np.all(np.isfinite(b))
        difference = max(difference, float(np.max(np.abs(a - b))))
    assert difference > 1e-5


@pytest.fixture
def studio(tmp_path):
    return Studio(BankCatalog([]), StateStore(tmp_path / "state.json"))


def test_api_persists_validates_and_rejects_foreign_origin(studio):
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        assert client.get("/api/state").status_code == 200
        assert client.patch("/api/session", json={"volume": 0.2}).json()["session"]["volume"] == 0.2
        assert studio.store.load().volume == 0.2
        assert client.patch("/api/session", json={"volume": 7}).status_code == 422
        assert client.patch("/api/session", json={"nonsense": 7}).status_code == 422
        assert (
            client.patch(
                "/api/session", json={"volume": 0.5}, headers={"Origin": "https://foreign.example"}
            ).status_code
            == 403
        )
        assert studio.state.volume == 0.2
        assert client.get("/api/soundfonts/unknown").status_code == 404


def receive_type(socket, kind):
    for _ in range(30):
        event = socket.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError(f"No {kind} event")


def test_websocket_midi_and_disconnect_release(studio):
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["type"] == "state"
            socket.send_json({"type": "midi", "data": [0x90, 60, 100]})
            assert receive_type(socket, "midi")["data"] == [0x90, 60, 100]
            assert studio.router.notes
            socket.send_json({"type": "midi", "data": [0x90, 200, 1]})
            assert receive_type(socket, "error")["message"]
        assert not studio.router.notes


def test_native_soundfont_audio_and_panic(tmp_path):
    path = Path("/usr/share/sounds/sf2/TimGM6mb.sf2")
    if not path.exists():
        pytest.skip("Install timgm6mb-soundfont to exercise the native engine")
    catalog = BankCatalog([path])
    assert len(catalog.banks[0]["presets"]) == 136
    studio = Studio(catalog, StateStore(tmp_path / "state.json"))
    studio.start(audio=False, midi=False)
    try:
        assert studio.status["engine"] == "ready"
        studio.midi([0x90, 60, 100], "test")
        sounding = np.concatenate([studio.render(256) for _ in range(30)])
        assert np.max(np.abs(sounding)) > 0.005
        studio.midi([0xB0, 1, 70], "test")
        studio.midi([0xB0, 64, 127], "test")
        studio.midi([0xE0, 0, 64], "test")
        studio.midi([0xD0, 30], "test")
        studio.midi([0xA0, 60, 30], "test")
        studio.panic()
        tail = np.concatenate([studio.render(256) for _ in range(20)])
        assert np.max(np.abs(tail[-256:])) < 1e-5
        studio.update({"mute": True})
        studio.midi([0x90, 64, 100], "test")
        assert not np.any(studio.render(256))
    finally:
        studio.close()


def test_instrument_and_output_are_replaceable(tmp_path):
    class FakeInstrument:
        closed = False

        def midi(self, data):
            pass

        def panic(self):
            pass

        def render(self, frames):
            return np.ones((frames, 2), dtype=np.float32) * 0.2

        def close(self):
            self.closed = True

    class FakeOutput:
        def __init__(self, render, sample_rate, block_size, device):
            self.started = False
            self.closed = False

        def start(self):
            self.started = True

        def close(self):
            self.closed = True

    catalog = BankCatalog([])
    catalog.banks = [
        {
            "id": "test",
            "name": "Test",
            "presets": [
                {"name": "First", "bank": 0, "program": 0},
                {"name": "Second", "bank": 0, "program": 1},
            ],
        }
    ]
    created = []

    def factory(state):
        instrument = FakeInstrument()
        created.append(instrument)
        return instrument

    studio = Studio(
        catalog,
        StateStore(tmp_path / "session.json"),
        instrument_factory=factory,
        output_factory=FakeOutput,
    )
    studio.start(audio=True, midi=False)
    output = studio.output
    assert output.started
    studio.update({"effects": []})
    assert np.allclose(studio.render(256), 0.2 * 0.78 * 0.85)
    studio.update({"program": 1})
    assert len(created) == 2 and created[0].closed
    studio.midi([0xC0, 0], "test")
    assert studio.state.program == 0
    studio.close()
    assert created[-1].closed and output.closed


def test_saving_settings_does_not_block_audio(tmp_path):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    saving = threading.Event()
    finish = threading.Event()

    class SlowStore(StateStore):
        def save(self, state):
            saving.set()
            assert finish.wait(3)
            super().save(state)

    class Tone:
        def render(self, frames):
            return np.ones((frames, 2), dtype=np.float32) * 0.1

    studio = Studio(BankCatalog([]), SlowStore(tmp_path / "state.json"))
    studio.instrument = Tone()
    studio.state = Session(effects=[])
    studio.chain = EffectChain([], 44100)
    with ThreadPoolExecutor(max_workers=2) as executor:
        update = executor.submit(studio.update, {"volume": 0.5})
        try:
            assert saving.wait(1)
            block = executor.submit(studio.render, 256).result(timeout=0.2)
            assert np.max(block) > 0
        finally:
            finish.set()
        update.result(timeout=2)
    assert studio.state.volume == 0.5
