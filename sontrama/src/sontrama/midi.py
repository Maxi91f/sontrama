"""Hot-plug MIDI source; independent of synthesis, effects and web transport."""

import logging
import threading
import time
from collections.abc import Callable

import mido

log = logging.getLogger(__name__)


class RtMidiSource:
    def __init__(
        self, receive: Callable, ports_changed: Callable, disconnected: Callable, error: Callable
    ):
        self.receive = receive
        self.ports_changed = ports_changed
        self.disconnected = disconnected
        self.error = error
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None
        self.ports: dict = {}

    def start(self):
        self.thread = threading.Thread(target=self._run, name="sontrama-midi", daemon=True)
        self.thread.start()

    def _run(self):
        mido.set_backend("mido.backends.rtmidi/LINUX_ALSA")
        next_scan = 0.0
        last_error = ""
        try:
            while not self.stopping.is_set():
                try:
                    if time.monotonic() >= next_scan:
                        names = {
                            name for name in mido.get_input_names() if "Midi Through" not in name
                        }
                        for name in self.ports.keys() - names:
                            self._remove(name)
                        for name in names - self.ports.keys():
                            self.ports[name] = mido.open_input(name)
                        self.ports_changed(sorted(self.ports))
                        next_scan = time.monotonic() + 1
                        last_error = ""
                    for name, port in list(self.ports.items()):
                        try:
                            for message in port.iter_pending():
                                data = message.bytes()
                                if 0x80 <= data[0] < 0xF0:
                                    self.receive(data, name)
                        except (OSError, RuntimeError):
                            self._remove(name)
                            next_scan = 0
                    self.stopping.wait(0.003)
                except Exception as error:
                    detail = f"MIDI: {error}"
                    if detail != last_error:
                        self.error(detail)
                        last_error = detail
                    self.stopping.wait(1)
                    next_scan = 0
        finally:
            for name in list(self.ports):
                self._remove(name)

    def _remove(self, name):
        port = self.ports.pop(name)
        try:
            port.close()
        except Exception:
            log.exception("Closing MIDI port %s", name)
        self.disconnected(name)
        self.ports_changed(sorted(self.ports))

    def close(self):
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=3)
