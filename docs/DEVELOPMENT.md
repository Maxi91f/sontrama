# Development

Sontrama lives in `sontrama/`. Its [application guide](../sontrama/README.md)
covers Linux audio libraries, instruments, architecture and systemd setup.

## Set up

Requires Python 3.12, uv, Node 22.13+ (22.x) or 24+, and prek
(`uv tool install prek`). From the repository root:

```sh
./task/init/all.sh
```

This installs locked Python and frontend dependencies and the Git hooks.
Hooks run Ruff, ESLint, Prettier and file checks; they do not run tests or deploy.

## Run locally

Use separate terminals:

```sh
./task/local/backend.sh
./task/local/frontend.sh
```

The backend listens on localhost:8081. Native audio and MIDI are disabled by
default for development; browser preview remains available. Vite proxies API
and WebSocket requests to the backend. To enable native devices, set
`SONTRAMA_NO_AUDIO=0 SONTRAMA_NO_MIDI=0` before starting the backend.

## Validate

From `sontrama/`, select only the checks relevant to the change:

```sh
uv run --frozen ruff check src tests
npm run lint
npm run check
npm run build
uv run --frozen pytest tests/test_three_osc.py -q
# With the local server running:
npx playwright test tests/browser/live.spec.ts -g 'incoming MIDI'
```

The `task/test/backend.sh` and `task/test/frontend.sh` wrappers require explicit
test selections. Do not run full test scripts unless requested.
`task/update/` updates dependencies only when invoked.

## Deploy

First prepare the target's audio libraries, uv and `/etc/sontrama.env` using
the [systemd guide](../sontrama/README.md#raspberry-pi-and-systemd). Then:

```sh
./task/deploy/all.sh user@synth-host /home/user/sontrama
```

Replace the host and path with your own. Deployment builds the frontend locally,
copies runtime files over SSH, syncs locked Python dependencies on the target
and restarts systemd. Node is not required on the target. Existing state and
configuration are preserved; private deployment notes are excluded.

`task/systemd/` installs, reinstalls or removes the service on the machine where
it runs. Removing the service preserves configuration and data.

## Refresh README screenshots

From `sontrama/`:

```sh
npm run build
npm run screenshots
```

The capture script starts a temporary localhost server with isolated state and
native audio/MIDI disabled, then saves real desktop and mobile views in
`docs/assets/`. It also captures the effect chain, live browser mixer meters,
and incoming WebSocket MIDI chords as a looping GIF. ImageMagick (`convert`)
is required to encode the GIF. It closes the server and deletes temporary state afterward.
It does not connect to deployed hardware or change an existing session.
Chrome defaults to `/usr/bin/google-chrome`; override it with `CHROME_PATH`.
The original SVG logo is in `docs/assets/sontrama-logo.svg`.
