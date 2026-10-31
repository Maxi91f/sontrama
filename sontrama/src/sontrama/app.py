from __future__ import annotations

import asyncio
import contextlib
import os
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import sounddevice as sd
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.middleware.base import BaseHTTPMiddleware

from .catalog import BankCatalog
from .configuration import ConfigurationService
from .errors import error_detail
from .models import MidiEvent, StateStore
from .runtime import Studio

ROOT = Path(__file__).resolve().parents[2]


class SameOrigin(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")
        expected = f"{request.url.scheme}://{request.headers.get('host')}"
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin != expected:
            return JSONResponse(
                {
                    "detail": error_detail(
                        "Cross-origin control is not allowed", "cross_origin_forbidden"
                    )
                },
                status_code=403,
            )
        return await call_next(request)


def create_app(studio: Studio | None = None, *, audio=True, midi=True):
    if studio is None:
        paths = os.environ.get(
            "SONTRAMA_SOUNDFONTS",
            f"{ROOT / 'data/soundfonts'}:/usr/share/sounds/sf2:/usr/share/soundfonts",
        )
        studio = Studio(
            BankCatalog([Path(path).expanduser() for path in paths.split(os.pathsep)]),
            StateStore(Path(os.environ.get("SONTRAMA_STATE", ROOT / "data/session.json"))),
        )
    configuration = ConfigurationService(studio)
    clients: dict[WebSocket, asyncio.Queue] = {}

    async def meters():
        while True:
            await asyncio.sleep(0.08)
            broadcast({"type": "meters", **studio.read_meters()})

    def broadcast(event: dict):
        for queue in list(clients.values()):
            if queue.full():
                # Losing a note-off is unsafe. Drop the backlog and silence client voices.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "panic"})
            queue.put_nowait(event)

    last_ports = None

    def studio_event(event):
        nonlocal last_ports
        broadcast(event)
        if event.get("type") == "state":
            ports = event["status"].get("midi_available", [])
            if ports != last_ports:
                last_ports = ports
                broadcast(configuration.snapshot())

    @asynccontextmanager
    async def lifespan(app):
        loop = asyncio.get_running_loop()
        studio.emit = lambda event: loop.call_soon_threadsafe(studio_event, event)
        await asyncio.to_thread(
            studio.start,
            audio=audio and os.getenv("SONTRAMA_NO_AUDIO") != "1",
            midi=midi and os.getenv("SONTRAMA_NO_MIDI") != "1",
            device=configuration.settings.audio.device,
            block_size=configuration.settings.audio.block_size,
        )
        task = asyncio.create_task(meters())
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await asyncio.to_thread(studio.close)
        studio.emit = lambda event: None

    app = FastAPI(title="Sontrama", lifespan=lifespan)
    app.state.studio = studio
    app.state.configuration = configuration
    app.add_middleware(SameOrigin)

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(request: Request, error: RequestValidationError):
        return JSONResponse(
            {"detail": error_detail(str(error), "validation_failed")}, status_code=422
        )

    @app.get("/api/settings")
    def get_settings(refresh: bool = False):
        if refresh:
            configuration.refresh_audio_devices()
        return JSONResponse(configuration.snapshot())

    @app.patch("/api/settings")
    async def update_settings(patch: dict, initialize_only: bool = False):
        try:
            result = await asyncio.to_thread(
                configuration.update, patch, initialize_only=initialize_only
            )
        except (ValueError, OSError, RuntimeError, sd.PortAudioError) as error:
            raise HTTPException(422, error_detail(error)) from error
        broadcast(result)
        return JSONResponse(result)

    @app.post("/api/settings/library/refresh")
    async def refresh_library():
        try:
            result = await asyncio.to_thread(configuration.update, {}, rescan=True)
        except (ValueError, OSError, RuntimeError, sd.PortAudioError) as error:
            raise HTTPException(422, error_detail(error)) from error
        broadcast(result)
        return JSONResponse(result)

    @app.get("/api/state")
    def state():
        return JSONResponse(studio.snapshot())

    @app.patch("/api/session")
    def update(patch: dict):
        try:
            return JSONResponse(studio.update(patch))
        except (ValidationError, ValueError) as error:
            raise HTTPException(422, error_detail(error)) from error

    @app.post("/api/panic")
    def panic():
        studio.panic()
        return {"ok": True}

    @app.get("/api/soundfonts/{identifier}")
    def soundfont(identifier: str):
        path = studio.catalog.paths.get(identifier)
        if path is None:
            raise HTTPException(404, error_detail("Unknown SoundFont", "soundfont_unknown"))
        return FileResponse(path, media_type="application/octet-stream", filename=path.name)

    @app.websocket("/ws")
    async def websocket(socket: WebSocket):
        origin = socket.headers.get("origin")
        scheme = "https" if socket.url.scheme == "wss" else "http"
        if origin and origin != f"{scheme}://{socket.headers.get('host')}":
            await socket.close(code=1008)
            return
        await socket.accept()
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        source = "web:" + uuid4().hex
        clients[socket] = queue
        await socket.send_json({**studio.snapshot(), "connection_id": source})
        await socket.send_json(configuration.snapshot())

        async def sender():
            while True:
                await socket.send_json(await queue.get())

        task = asyncio.create_task(sender())
        acknowledged = OrderedDict()
        try:
            while True:
                message = await socket.receive_json()
                try:
                    if message.get("type") == "midi":
                        event = MidiEvent.model_validate({"data": message.get("data")})
                        controller = message.get("controller")
                        if controller is not None and (
                            not isinstance(controller, str) or not 1 <= len(controller) <= 200
                        ):
                            raise ValueError("Invalid MIDI controller name")
                        routed_source = source + ":midi:" + controller if controller else source
                        event_id = message.get("event_id")
                        if event_id is not None and (
                            not isinstance(event_id, str) or not 1 <= len(event_id) <= 100
                        ):
                            raise ValueError("Invalid MIDI event identifier")
                        if event_id is not None and event_id in acknowledged:
                            queue.put_nowait(acknowledged[event_id])
                            continue
                        routed = studio.midi(
                            event.data, routed_source, controller=controller, event_id=event_id
                        )
                        if event_id is not None:
                            # Native MIDI events are enqueued by call_soon_threadsafe; keep
                            # their echoes ahead of the acknowledgement on this connection.
                            await asyncio.sleep(0)
                            acknowledgement = {
                                "type": "midi_ack",
                                "event_id": event_id,
                                "routed": routed,
                            }
                            acknowledged[event_id] = acknowledgement
                            if len(acknowledged) > 512:
                                acknowledged.popitem(last=False)
                            queue.put_nowait(acknowledgement)
                    elif message.get("type") == "midi_devices":
                        names = message.get("names")
                        if not isinstance(names, list):
                            raise ValueError("Invalid MIDI devices")
                        previous_names = configuration.browser_devices.get(source, [])
                        configuration.register_browser(source, names)
                        for name in set(previous_names) - set(names):
                            studio.release_source(source + ":midi:" + name)
                        broadcast(configuration.snapshot())
                    elif message.get("type") == "release":
                        studio.release_source(source)
                    elif message.get("type") == "panic":
                        studio.panic()
                    else:
                        raise ValueError("Unknown message")
                except (ValidationError, ValueError, AttributeError) as error:
                    queue.put_nowait(
                        {
                            "type": "error",
                            "event_id": message.get("event_id")
                            if isinstance(message, dict)
                            else None,
                            **error_detail(error, "invalid_midi_message"),
                        }
                    )
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            clients.pop(socket, None)
            configuration.browser_devices.pop(source, None)
            broadcast(configuration.snapshot())
            studio.release_source(source)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, RuntimeError):
                await task

    distribution = Path(os.environ.get("SONTRAMA_WEB", ROOT / "dist"))
    if distribution.is_dir():
        app.mount("/", StaticFiles(directory=distribution, html=True), name="web")
    else:

        @app.get("/")
        def missing_frontend():
            return JSONResponse(
                {
                    "detail": error_detail(
                        "Run npm ci && npm run build in sontrama/", "frontend_unavailable"
                    )
                },
                503,
            )

    return app
