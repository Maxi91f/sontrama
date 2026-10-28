from __future__ import annotations

import asyncio
import contextlib
import os
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.middleware.base import BaseHTTPMiddleware

from .catalog import BankCatalog
from .models import MidiEvent, StateStore
from .runtime import Studio

ROOT = Path(__file__).resolve().parents[2]


class SameOrigin(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")
        expected = f"{request.url.scheme}://{request.headers.get('host')}"
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin != expected:
            return JSONResponse({"detail": "Cross-origin control is not allowed"}, status_code=403)
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
    clients: dict[WebSocket, asyncio.Queue] = {}

    async def meters():
        while True:
            await asyncio.sleep(0.08)
            broadcast(
                {
                    "type": "meters",
                    "channel": studio.levels[0],
                    "master": studio.levels[1],
                    "underruns": studio.underruns,
                }
            )

    def broadcast(event: dict):
        for queue in list(clients.values()):
            if queue.full():
                # Losing a note-off is unsafe. Drop the backlog and silence client voices.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "panic"})
            queue.put_nowait(event)

    @asynccontextmanager
    async def lifespan(app):
        loop = asyncio.get_running_loop()
        studio.emit = lambda event: loop.call_soon_threadsafe(broadcast, event)
        await asyncio.to_thread(
            studio.start,
            audio=audio and os.getenv("SONTRAMA_NO_AUDIO") != "1",
            midi=midi and os.getenv("SONTRAMA_NO_MIDI") != "1",
            device=os.getenv("SONTRAMA_AUDIO_DEVICE") or None,
            block_size=int(os.getenv("SONTRAMA_BLOCK_SIZE", "256")),
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
    app.add_middleware(SameOrigin)

    @app.get("/api/state")
    def state():
        return JSONResponse(studio.snapshot())

    @app.patch("/api/session")
    def update(patch: dict):
        try:
            return JSONResponse(studio.update(patch))
        except (ValidationError, ValueError) as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/api/panic")
    def panic():
        studio.panic()
        return {"ok": True}

    @app.get("/api/soundfonts/{identifier}")
    def soundfont(identifier: str):
        path = studio.catalog.paths.get(identifier)
        if path is None:
            raise HTTPException(404, "Unknown SoundFont")
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
        await socket.send_json(studio.snapshot())

        async def sender():
            while True:
                await socket.send_json(await queue.get())

        task = asyncio.create_task(sender())
        try:
            while True:
                message = await socket.receive_json()
                try:
                    if message.get("type") == "midi":
                        event = MidiEvent.model_validate({"data": message.get("data")})
                        studio.midi(event.data, source)
                    elif message.get("type") == "release":
                        studio.release_source(source)
                    elif message.get("type") == "panic":
                        studio.panic()
                    else:
                        raise ValueError("Unknown message")
                except (ValidationError, ValueError, AttributeError) as error:
                    queue.put_nowait({"type": "error", "message": str(error)})
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            clients.pop(socket, None)
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
            return JSONResponse({"detail": "Run npm ci && npm run build in sontrama/"}, 503)

    return app
