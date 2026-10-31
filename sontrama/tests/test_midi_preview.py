"""Acknowledged MIDI is idempotent and keeps the canonical server route."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from sontrama.app import create_app
from sontrama.catalog import BankCatalog
from sontrama.models import Session, StateStore
from sontrama.runtime import Studio


class RecordingInstrument:
    def __init__(self):
        self.messages = []

    def midi(self, data):
        self.messages.append(list(data))

    def render(self, frames):
        return np.zeros((frames, 2), dtype=np.float32)

    def panic(self):
        pass

    def close(self):
        pass


def receive(socket, kind):
    for _ in range(32):
        event = socket.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError(f"Missing {kind} message")


@pytest.fixture
def recording_studio(tmp_path):
    store = StateStore(tmp_path / "session.json")
    store.save(Session(instrument="three-osc", octave=1))
    instrument = RecordingInstrument()
    studio = Studio(BankCatalog([]), store, instrument_factory=lambda state: instrument)
    return studio, instrument


def test_origin_identifier_acknowledgement_and_repeated_event_are_consistent(recording_studio):
    studio, instrument = recording_studio
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        with client.websocket_connect("/ws") as origin, client.websocket_connect("/ws") as observer:
            connection = receive(origin, "state")["connection_id"]
            receive(origin, "settings")
            receive(observer, "settings")
            message = {"type": "midi", "event_id": "test-1", "data": [0x91, 60, 100]}
            origin.send_json(message)
            echo = receive(origin, "midi")
            assert echo["data"] == [0x90, 72, 100]
            assert echo["origin"] == connection
            assert echo["event_id"] == "test-1"
            acknowledgement = receive(origin, "midi_ack")
            assert acknowledgement["routed"] == [[0x90, 72, 100]]
            assert receive(observer, "midi") == echo
            origin.send_json(message)
            assert receive(origin, "midi_ack") == acknowledgement
            assert instrument.messages.count([0x90, 72, 100]) == 1
            origin.send_json({"type": "midi", "event_id": "test-off", "data": [0x81, 60, 0]})
            assert receive(origin, "midi")["data"] == [0x80, 72, 0]
            assert receive(origin, "midi_ack")["routed"] == [[0x80, 72, 0]]


def test_rejected_controller_is_acknowledged_without_playing_predicted_notes(recording_studio):
    studio, instrument = recording_studio
    with TestClient(create_app(studio, audio=False, midi=False)) as client:
        response = client.patch(
            "/api/settings",
            json={
                "midi": {
                    "devices": {"browser:Keyboard": {"enabled": False, "velocity_curve": "linear"}}
                }
            },
        )
        assert response.status_code == 200
        with client.websocket_connect("/ws") as socket:
            receive(socket, "settings")
            socket.send_json(
                {
                    "type": "midi",
                    "event_id": "blocked",
                    "data": [0x90, 60, 100],
                    "controller": "Keyboard",
                }
            )
            assert receive(socket, "midi_ack")["routed"] == []
            assert [0x90, 72, 100] not in instrument.messages
            socket.send_json({"type": "midi", "event_id": [], "data": [0x90, 60, 100]})
            assert receive(socket, "error")["code"] == "invalid_midi_message"
