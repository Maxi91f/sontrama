# Sontrama

Live MIDI studio for Raspberry Pi 3 B and Linux. The application lives in
`sontrama/`; keep that subfolder and Python 3.12. Use `uv` with the existing
lockfile for Python and `npm ci` for frontend dependencies.

## Language

Write code identifiers, comments, docstrings, developer-facing messages,
documentation and commit messages in English. Keep the user interface in
Spanish for now, including visible labels, accessibility labels and user-facing
messages. Tests and documentation may quote existing Spanish UI labels exactly
when referring to controls. Do not translate UI copy as part of code cleanup.

## Architecture

- Python: FastAPI, RtMidi inputs, replaceable instrument adapters, ordered
  effects, mixer and PortAudio output. Contracts live in `contracts.py`.
- Banks uses FluidSynth and SF2 files. 3 Osc uses our own native C kernel with
  a NumPy fallback. Do not couple MIDI routing or effects to FluidSynth.
- TypeScript/Vite: independent browser preview engines share `VoiceEngine`,
  Web Audio effects and mixer. Preview is independent of server audio.
- Persistent musical settings belong to the server. Capture, preview and tab
  preferences belong to each browser's localStorage.
- Use light cream backgrounds,
  yellow accents, black borders, square corners and hard shadows. Use two-state
  buttons for toggles. Keep Inputs, Instrument, Effects, Mixer and Output in tabs.
- The audio callback must not wait on disk writes, network, builds or preset
  loading. Compile native code before starting the service.

## Development and validation

From the workspace root: `./task/init/all.sh`, then use separate terminals for
`./task/local/backend.sh` and `./task/local/frontend.sh`. Backend development
disables native audio/MIDI by default; browser preview remains available.

From `sontrama/`:

```sh
uv run --frozen ruff check src tests
uv run --frozen ruff format --check src tests
uv run --frozen pytest tests/test_three_osc.py -q
npm run lint
npm run check
npm run build
npx playwright test tests/browser/live.spec.ts -g 'incoming MIDI'
```

Do not run `task test` or the full test scripts unless the user explicitly asks.
Prefer the smallest relevant pytest/Playwright selection. Tests use functions;
parametrize similar cases. Do not add tests that only mirror implementation.
Keep dependencies locked and do not update them as part of unrelated work.

## Deployment

`./task/deploy/all.sh` builds on the PC, copies runtime files over SSH, syncs
locked Python dependencies on the Pi and restarts systemd. It does not need
Node on the Pi or deploy local state, backups, keys or development dependencies.
Pass the SSH destination and installation directory explicitly.
The generic service profile uses port 8081. Preserve existing
`/etc/sontrama.env` during updates. `deploy/raspi3.env.example` provides a
sample Pi 3 audio profile; installation-specific settings belong in the ignored
`deploy/local/` directory and must not be copied by deployment scripts.

Do not commit credentials, SSH keys, SoundFonts, runtime state, private backups
or local configuration. Keep machine-specific inventory outside tracked files.
