# Development

Sontrama lives in `sontrama/`. Its [application guide](../sontrama/README.md)
covers Linux audio libraries, instruments, architecture and systemd setup.

## Set up

Requires Python 3.12, uv, Node 22.13+ (22.x) or 24+, and prek
(`uv tool install prek`). From the repository root:

```sh
./task/init/all.sh
```

This installs locked Python/frontend dependencies, the pinned native FluidSynth
library, the local Emscripten SDK, shared WASM artifacts and the Git hooks.
System prerequisites include a C/C++ compiler, CMake, pkg-config, Git and GLib
headers (`libglib2.0-dev` on Debian); see the application guide's
[system dependencies](../sontrama/README.md#running-locally).
The Emscripten SDK stays under ignored `sontrama/.cache/emsdk` on the PC and is
not deployed. The pinned native FluidSynth library is built on each Linux host
under `sontrama/data/native/`; normal builds reuse cached artifacts.
Hooks run Ruff, ESLint, Prettier and file checks; they do not run tests or deploy.

## Run locally

Use separate terminals:

```sh
./task/local/backend.sh
./task/local/frontend.sh
```

The backend listens on localhost:8081. Native audio and MIDI are disabled by
default for development; local simulation starts enabled and muted. Unmute its
independent preview in Output to listen. Visualizations use that local engine;
the server no longer streams audio windows. Vite proxies API
and WebSocket requests to the backend. To enable native devices, set
`SONTRAMA_NO_AUDIO=0 SONTRAMA_NO_MIDI=0` before starting the backend.

To use the same server from a phone on your LAN, start the backend with
`SONTRAMA_HOST=0.0.0.0 ./task/local/backend.sh` and open
`http://COMPUTER-IP:8081` on the phone. All configuration is stored on the server
and synchronized across browsers; each screen keeps its own navigation.

## Validate

From `sontrama/`, select only the checks relevant to the change:

```sh
uv run --frozen ruff check src tests
npm run lint
npm run check
npm run build
uv run --frozen pytest tests/test_shared_dsp.py tests/test_banks_parity.py tests/test_midi_preview.py -q
# With the local server running:
npx playwright test tests/browser/live.spec.ts -g 'incoming MIDI'
```

The `task/test/backend.sh` and `task/test/frontend.sh` wrappers require explicit
test selections. Do not run full test scripts unless requested.
`task/update/` updates dependencies only when invoked.

The shared audio core lives in `src/sontrama/dsp/`. After changing it, run
`npm run build` to rebuild WASM and restart the backend to load the corresponding
native artifact. Source revisions are embedded in both binaries; a mismatch
blocks preview with a localized message. Add parity cases for new processors
rather than maintaining a second implementation of the DSP in TypeScript.
Follow the [instrument and effect checklists](../AGENTS.md#adding-instruments-and-effects-without-dsp-divergence)
when adding engines, parameters or processors. Include new source files in both
build/fingerprint lists and update the native/WASM bindings together.

For ARM/native versus WASM checks without deployment, see the isolated
`scripts/check-arm-parity.py` command in the application guide. Full state
recovery and synchronized musical clocks are intentionally not part of the
immediate local MIDI/acknowledgement protocol.

## Deploy

First prepare the target's audio libraries, uv and `/etc/sontrama.env` using
the [systemd guide](../sontrama/README.md#raspberry-pi-and-systemd). Then:

```sh
./task/deploy/all.sh user@synth-host /home/user/sontrama
```

Replace the host and path with your own. Deployment builds the frontend locally,
copies runtime files over SSH and syncs locked Python dependencies on the target.
The installer builds pinned FluidSynth and prepares the shared native kernel
before the deployment script restarts systemd. The target needs the C/C++ build
tools, CMake, pkg-config, Git and GLib headers, plus sudo access to install/restart
the service. Node and Emscripten are not required on the target. First installation
requires Internet access for the locked packages and pinned FluidSynth sources.
Existing state and `/etc/sontrama.env` are preserved; private deployment notes
are excluded.

After deployment, verify the state API reports ready audio, expected MIDI devices,
the matching `status.engine_contract.core_revision` and FluidSynth version. Check
that systemd is enabled/active and has no restart loop. Exercise native audio and
browser preview, including note release, effects and sustain; browser tests do
not replace listening to the physical output. Monitor underrun deltas during
representative playing and preserve any observed limitations in local notes.
When browser tests temporarily edit a real installation, restore its original
session and shared settings afterward. Remote tests and deployment require the
user's authorization; local validation does not imply permission to deploy.

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
all eight visualization types, the Monitor bar with the keyboard between a VU
meter and vectorscope, and incoming WebSocket MIDI chords as a looping GIF. ImageMagick (`convert`)
is required to encode the GIF. It closes the server and deletes temporary state afterward.
It does not connect to deployed hardware or change an existing session.
Chrome defaults to `/usr/bin/google-chrome`; override it with `CHROME_PATH`.
The original SVG logo is in `docs/assets/sontrama-logo.svg`.
