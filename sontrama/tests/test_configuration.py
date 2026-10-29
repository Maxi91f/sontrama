import json
import struct
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from sontrama.app import create_app
from sontrama.catalog import BankCatalog
from sontrama.configuration import ConfigurationService, MidiDeviceSettings, midi_device_id
from sontrama.models import Session, StateStore
from sontrama.runtime import Studio


class Instrument:
    def __init__(self):
        self.received = []
        self.closed = False

    def midi(self, data):
        self.received.append(data)

    def panic(self):
        pass

    def render(self, frames):
        return np.zeros((frames, 2), dtype=np.float32)

    def close(self):
        self.closed = True


class Output:
    def __init__(self, callback, rate, block, device):
        self.rate, self.block, self.device = rate, block, device
        self.closed = False
        self.started = False

    def start(self):
        if self.device == "unavailable":
            raise RuntimeError("Device cannot be opened")
        self.started = True

    def close(self):
        self.closed = True


@pytest.fixture
def studio(tmp_path, monkeypatch):
    monkeypatch.setattr("sontrama.configuration.audio_devices", lambda: [])
    for name in ("SONTRAMA_AUDIO_DEVICE", "SONTRAMA_BLOCK_SIZE"):
        monkeypatch.delenv(name, raising=False)
    store = StateStore(tmp_path / "session.json")
    store.save(Session(instrument="three-osc"))
    return Studio(
        BankCatalog([]), store, instrument_factory=lambda state: Instrument(), output_factory=Output
    )


def receive_type(socket, kind):
    for _ in range(50):
        event = socket.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError(f"No {kind} event received")


def test_settings_persist_separately_and_broadcast_to_both_clients(studio):
    original = studio.state.model_dump()
    with (
        TestClient(create_app(studio, audio=False, midi=False)) as client,
        client.websocket_connect("/ws") as first,
        client.websocket_connect("/ws") as second,
    ):
        receive_type(first, "settings")
        receive_type(second, "settings")
        response = client.patch(
            "/api/settings",
            json={
                "keyboard": {"velocity": 75, "capture": True},
                "interface": {"motion": "reduced"},
            },
        )
        assert response.status_code == 200
        for socket in (first, second):
            event = receive_type(socket, "settings")
            assert event["settings"]["keyboard"]["velocity"] == 75
            assert event["settings"]["interface"]["motion"] == "reduced"
        assert studio.state.model_dump() == original
        assert json.loads(studio.store.path.with_name("settings.json").read_text())["keyboard"][
            "capture"
        ]
        assert json.loads(studio.store.path.read_text()) == original
    configuration = ConfigurationService(Studio(studio.catalog, studio.store))
    assert configuration.settings.keyboard.velocity == 75


@pytest.mark.parametrize(
    "patch",
    [
        {"keyboard": {"velocity": 0}},
        {"keyboard": {"velocity": 128}},
        {"interface": {"language": "fr"}},
        {"interface": {"scale": 2}},
        {"audio": {"sample_rate": 123}},
        {"audio": {"block_size": 123}},
        {"library": {"paths": ["/definitely-not-a-soundfont-directory"]}},
    ],
)
def test_invalid_configuration_does_not_overwrite_settings(studio, patch):
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        before = client.get("/api/settings").json()["settings"]
        assert client.patch("/api/settings", json=patch).status_code == 422
        assert client.get("/api/settings").json()["settings"] == before
        assert not studio.store.path.with_name("settings.json").exists()


def test_audio_rebuild_and_failed_output_restore_working_graph(studio):
    with TestClient(create_app(studio, audio=True, midi=False)) as client:
        old_instrument, old_output = studio.instrument, studio.output
        assert (
            client.patch(
                "/api/settings", json={"audio": {"sample_rate": 48000, "block_size": 512}}
            ).status_code
            == 200
        )
        assert studio.sample_rate == 48000
        assert studio.output.rate == 48000 and studio.output.block == 512
        assert old_output.closed and old_instrument.closed
        working = studio.instrument
        saved = studio.store.path.with_name("settings.json").read_text()
        assert (
            client.patch("/api/settings", json={"audio": {"device": "unavailable"}}).status_code
            == 422
        )
        assert studio.instrument is working and not working.closed
        assert studio.output.started and not studio.output.closed
        assert studio.output.device is None and studio.sample_rate == 48000
        assert studio.store.path.with_name("settings.json").read_text() == saved
        assert studio.status["audio"] == "ready"


def test_disk_failure_restores_audio_and_keeps_old_configuration(studio, monkeypatch):
    with TestClient(create_app(studio, audio=True, midi=False)) as client:
        previous = studio.instrument
        original_save = StateStore.save

        def fail_configuration_save(store, state):
            if store.path.name == "settings.json":
                raise OSError("Disk full")
            return original_save(store, state)

        monkeypatch.setattr(StateStore, "save", fail_configuration_save)
        assert (
            client.patch("/api/settings", json={"audio": {"sample_rate": 48000}}).status_code == 422
        )
        assert studio.instrument is previous and not previous.closed
        assert studio.sample_rate == 44100 and studio.output.started
        assert client.get("/api/settings").json()["settings"]["audio"]["sample_rate"] == 44100


@pytest.mark.parametrize("curve,expected", [("linear", 64), ("soft", 90), ("hard", 32)])
def test_controller_velocity_curve_preserves_note_offs_and_reconnect_identity(
    studio, curve, expected
):
    studio.start(audio=False, midi=False)
    try:
        identifier = midi_device_id("Keyboard 20:0")
        studio.set_controller_settings({identifier: MidiDeviceSettings(velocity_curve=curve)})
        studio.midi([0x90, 60, 64], "Keyboard 30:0", hardware=True)
        assert studio.instrument.received[-1] == [0x90, 60, expected]
        studio.midi([0x90, 60, 0], "Keyboard 30:0", hardware=True)
        assert studio.instrument.received[-1] == [0x80, 60, 0]
        studio.midi([0x90, 61, 100], "Keyboard 30:0", hardware=True)
        studio.set_controller_settings({identifier: MidiDeviceSettings(enabled=False)})
        assert not studio.router.notes
        count = len(studio.instrument.received)
        studio.midi([0x90, 62, 100], "Keyboard 40:0", hardware=True)
        assert len(studio.instrument.received) == count
    finally:
        studio.close()


def test_browser_controller_preferences_apply_to_routed_midi(studio):
    with (
        TestClient(create_app(studio, audio=False, midi=False)) as client,
        client.websocket_connect("/ws") as socket,
    ):
        receive_type(socket, "settings")
        socket.send_json({"type": "midi_devices", "names": ["USB Keys"]})
        assert (
            receive_type(socket, "settings")["resources"]["midi_inputs"][0]["id"]
            == "browser:USB Keys"
        )
        client.patch(
            "/api/settings",
            json={"midi": {"devices": {"browser:USB Keys": {"velocity_curve": "soft"}}}},
        )
        socket.send_json({"type": "midi", "controller": "USB Keys", "data": [0x90, 60, 64]})
        assert receive_type(socket, "midi")["data"] == [0x90, 60, 90]
        socket.send_json({"type": "midi_devices", "names": []})
        assert receive_type(socket, "midi")["data"] == [0x80, 60, 0]
        assert not studio.router.notes


def soundfont(path: Path, name: bytes):
    preset = struct.pack("<20sHHHIII", name, 0, 0, 0, 0, 0, 0)
    terminal = struct.pack("<20sHHHIII", b"EOP", 0, 0, 0, 0, 0, 0)
    pdta = b"pdta" + b"phdr" + struct.pack("<I", 76) + preset + terminal
    body = b"sfbkLIST" + struct.pack("<I", len(pdta)) + pdta
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


def test_rescan_updates_catalog_and_preserves_or_replaces_active_preset(studio, tmp_path):
    folder = tmp_path / "fonts"
    folder.mkdir()
    first = folder / "first.sf2"
    soundfont(first, b"First")
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        assert (
            client.patch("/api/settings", json={"library": {"paths": [str(folder)]}}).status_code
            == 200
        )
        catalog = client.get("/api/state").json()["catalog"]
        client.patch(
            "/api/session",
            json={"instrument": "banks", "soundfont": catalog[0]["id"], "bank": 0, "program": 0},
        )
        soundfont(folder / "second.sf2", b"Second")
        assert client.post("/api/settings/library/refresh").status_code == 200
        assert len(studio.catalog.banks) == 2
        assert studio.state.soundfont == catalog[0]["id"]
        first.unlink()
        assert client.post("/api/settings/library/refresh").status_code == 200
        assert studio.state.soundfont != catalog[0]["id"]
        assert studio.store.load().soundfont == studio.state.soundfont
        assert studio.catalog_revision == 3
        (folder / "second.sf2").unlink()
        assert client.post("/api/settings/library/refresh").status_code == 422
        assert studio.instrument is not None


def test_foreign_origin_cannot_modify_shared_settings(studio):
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        assert (
            client.patch(
                "/api/settings",
                json={"keyboard": {"velocity": 12}},
                headers={"Origin": "https://other.example"},
            ).status_code
            == 403
        )


def test_real_three_osc_engine_rebuilds_at_the_selected_sample_rate(tmp_path, monkeypatch):
    monkeypatch.setattr("sontrama.configuration.audio_devices", lambda: [])
    store = StateStore(tmp_path / "session.json")
    store.save(Session(instrument="three-osc", effects=[]))
    studio = Studio(BankCatalog([]), store, output_factory=Output)
    with TestClient(create_app(studio, audio=True, midi=False)) as client:
        assert (
            client.patch(
                "/api/settings", json={"audio": {"sample_rate": 48000, "block_size": 512}}
            ).status_code
            == 200
        )
        assert studio.instrument.sample_rate == 48000
        studio.midi([0x90, 69, 100], "test")
        block = studio.render(4096)
        assert np.max(np.abs(block)) > 0.01
        spectrum = np.abs(np.fft.rfft(block[:, 0] * np.hanning(4096)))
        assert abs(np.argmax(spectrum) * 48000 / 4096 - 440) < 12


def test_audio_selection_survives_alsa_card_renumbering(monkeypatch):
    from sontrama.configuration import audio_devices, resolve_audio_device

    devices = [{"name": "USB Audio (hw:2,0)", "hostapi": 0, "max_output_channels": 2}]
    monkeypatch.setattr("sontrama.configuration.sd.query_hostapis", lambda: [{"name": "ALSA"}])
    monkeypatch.setattr("sontrama.configuration.sd.query_devices", lambda: devices)
    identifier = audio_devices()[0]["id"]
    devices[0]["name"] = "USB Audio (hw:4,0)"
    assert audio_devices()[0]["id"] == identifier
    assert resolve_audio_device(identifier) == 0


def test_midi_source_keeps_ignored_devices_discoverable_and_reconnects(monkeypatch):
    from sontrama.midi import RtMidiSource

    opened, closed = [], []
    iteration = [0]

    class Stop:
        def is_set(self):
            return iteration[0] >= 3

        def wait(self, timeout):
            iteration[0] += 1

    class Port:
        def iter_pending(self):
            return []

        def close(self):
            closed.append(True)

    def open_port(name):
        opened.append(name)
        return Port()

    monkeypatch.setattr("sontrama.midi.mido.set_backend", lambda name: None)
    monkeypatch.setattr("sontrama.midi.mido.get_input_names", lambda: ["Keys 20:0"])
    monkeypatch.setattr("sontrama.midi.mido.open_input", open_port)
    monkeypatch.setattr("sontrama.midi.time.monotonic", lambda: iteration[0] * 2)
    states = []
    source = RtMidiSource(
        lambda *args: None,
        lambda names: states.append((names, list(source.available_ports))),
        lambda name: None,
        lambda error: pytest.fail(error),
    )
    source.is_enabled = lambda name: iteration[0] != 1
    source.stopping = Stop()
    source._run()
    assert opened == ["Keys 20:0", "Keys 20:0"]
    assert len(closed) == 2
    assert any(active == [] and available == ["Keys 20:0"] for active, available in states)


def test_missing_saved_soundfont_folder_does_not_prevent_startup(studio, tmp_path):
    folder = tmp_path / "removable-fonts"
    folder.mkdir()
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        assert (
            client.patch("/api/settings", json={"library": {"paths": [str(folder)]}}).status_code
            == 200
        )
    folder.rmdir()
    restarted = Studio(BankCatalog([]), studio.store, instrument_factory=lambda state: Instrument())
    with TestClient(create_app(restarted, audio=False, midi=False)) as client:
        state = client.get("/api/state").json()
        assert state["status"]["engine"] == "ready"
        assert any("does not exist" in error for error in state["status"]["errors"])
        assert client.get("/api/settings").json()["settings"]["library"]["paths"] == [str(folder)]


def test_legacy_initialization_cannot_overwrite_another_clients_saved_settings(studio):
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        assert not client.get("/api/settings").json()["initialized"]
        first = client.patch(
            "/api/settings?initialize_only=true", json={"keyboard": {"capture": True}}
        )
        assert first.json()["settings"]["keyboard"]["capture"]
        second = client.patch(
            "/api/settings?initialize_only=true", json={"keyboard": {"capture": False}}
        )
        assert second.json()["settings"]["keyboard"]["capture"]


@pytest.mark.parametrize("language", ["es", "en"])
def test_language_is_shared_and_persisted_without_translating_api_errors(studio, language):
    with (
        TestClient(create_app(studio, audio=False, midi=False)) as client,
        client.websocket_connect("/ws") as socket,
    ):
        receive_type(socket, "settings")
        response = client.patch("/api/settings", json={"interface": {"language": language}})
        assert response.status_code == 200
        assert receive_type(socket, "settings")["settings"]["interface"]["language"] == language
        missing = "/missing-soundfonts"
        response = client.patch("/api/settings", json={"library": {"paths": [missing]}})
        assert response.status_code == 422
        assert response.json()["detail"] == {
            "code": "library_path_missing",
            "message": f"Directory or SoundFont does not exist: {missing}",
            "params": {"path": missing},
        }
        invalid = client.patch("/api/settings", json={"keyboard": {"velocity": 0}})
        assert invalid.json()["detail"]["code"] == "validation_failed"
        socket.send_json({"type": "unknown"})
        error = receive_type(socket, "error")
        assert error["code"] == "invalid_midi_message"
        assert error["message"] == "Unknown message"
    assert (
        ConfigurationService(Studio(studio.catalog, studio.store)).settings.interface.language
        == language
    )
