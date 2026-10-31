# Sontrama

Live MIDI studio for Raspberry Pi 3 B and Linux. The application lives in
`sontrama/`; keep that subfolder and Python 3.12. Use `uv` with the existing
lockfile for Python and `npm ci` for frontend dependencies.

## Language

Write code identifiers, comments, docstrings, developer-facing messages,
documentation and commit messages in English. Localize all user-facing frontend
copy through i18next catalogs, including accessibility labels and messages.
Support English (the default) and Spanish; persist the shared language on the
server. Keep backend diagnostics in English and expose stable error codes with
parameters for frontend localization. Tests and documentation may quote UI
labels exactly when referring to controls.

## Architecture

- Python: FastAPI, RtMidi inputs, replaceable instrument adapters, ordered
  effects, mixer and PortAudio output. Contracts live in `contracts.py`.
- Banks uses pinned FluidSynth 2.4.6 and SF2 files in both targets. Prepare its
  native library with `scripts/build-banks.sh`; do not mix system FluidSynth APIs
  with the pinned library. Do not couple MIDI routing or effects to FluidSynth.
- 3 Osc voice management, MIDI controllers, oscillators, effects and mixer math
  live in portable C under `dsp/`. Compile the same sources natively and to WASM;
  do not reintroduce independent Python or TypeScript DSP implementations.
- TypeScript/Vite: preview engines share `VoiceEngine` and the shared WASM
  processing pipeline. Local simulation is enabled by default; browser listening
  starts muted at 100% preview volume. Keep preview gain/mute after analyzer taps
  and separate from the musical mixer. Visualizers analyze only local simulation;
  do not capture or stream native audio windows. Disabled/suspended simulation
  must offer an enable/resume action in audio widgets, including pinned views.
  AudioWorklet is preferred; the HTTP fallback uses one
  ScriptProcessor for the whole effects/mixer chain. Preview renders locally.
- Browser-origin MIDI plays locally before its server round trip. Preserve event
  IDs, origin-scoped echo suppression, acknowledgements and rejection handling.
  Full musical-state recovery and shared musical clocks remain separate work.
- Persist all configuration on the server and broadcast changes to connected
  browsers. Keep musical session data in `session.json` and shared configuration
  in `settings.json`. Only transient navigation (the selected Live tab) belongs
  in localStorage; do not add per-browser configuration profiles.
- Use light cream backgrounds,
  yellow accents, black borders, square corners and hard shadows. Use two-state
  buttons for toggles. Keep Inputs, Instrument, Mixer and Output in tabs. Mixer combines channel
  selection, per-channel/master effects, pan, levels and stereo meters.
- Effect parameter contracts live in `src/sontrama/effect_specs.json`. Keep the
  native and WASM builds aligned with audio parity tests. Core source revisions
  are embedded in both binaries and checked against the browser manifest.
  Preserve DSP state on parameter edits. Build WASM on the PC and prepare native
  kernels and pinned FluidSynth before systemd; never compile in an audio callback.
- The audio callback must not wait on disk writes, network, builds or preset
  loading. Compile native code before starting the service.

## Adding instruments and effects without DSP divergence

All paths in this section are relative to `sontrama/`. Treat native audio and
browser preview as two hosts of the same processor, not two implementations.

### Shared processing rules

- Implement synthesis and effects once in portable C under `src/sontrama/dsp/`.
  Keep Python/TypeScript adapters responsible only for validation, memory,
  routing and lifecycle. Do not duplicate envelopes, voice allocation, MIDI
  controller behavior, random generation, filters or smoothing in host code.
- For an external engine, require matching native/WASM versions, settings and
  assets, with reproducible pinned builds and parity tests. If the engine cannot
  run in both targets, resolve that architecture explicitly before exposing it
  as a matching preview; do not substitute an approximate browser engine.
- Define parameter names, defaults, units, ranges, enum values and vector order
  in a shared contract. Keep sample rate, stereo layout, gain staging, clipping,
  bypass, reset and panic semantics consistent. Use seeded random streams whose
  output does not depend on host block size. Express time constants in samples
  derived from the actual sample rate, not callback counts or wall-clock time.
- Parameter edits must preserve voices, envelope progress, filter history,
  delay tails and smoothing state unless a documented structural change requires
  a reset. Prepare buffers, tables and assets before processing; never load,
  compile or access disk/network in the audio callback.

### New instrument checklist

1. Define and validate its persisted parameters in `src/sontrama/models.py` and
   the corresponding frontend types. Keep defaults and the low-level parameter
   layout shared, following `dsp/core_contract.json` where applicable.
2. Add a thin native `Instrument` adapter from `contracts.py`, implementing
   `ConfigurableInstrument` when appropriate. Register it in
   `instruments.py`'s factory. Keep MIDI routing independent of the engine.
3. Add a browser adapter implementing `web/src/voice-engine.ts`'s `VoiceEngine`
   and register its factory in `web/src/audio.ts`. Use the same compiled engine
   in AudioWorklet and fallback paths; follow the existing WASM adapters and
   worklet lifecycle. Preserve readiness, queued MIDI, panic and cleanup behavior.
4. Add localized controls and accessible labels to both catalogs. Persist and
   broadcast instrument parameters through the existing server session path.
   Preserve browser-origin MIDI prediction, event IDs, acknowledgements and
   origin-scoped echo suppression; do not send local notes on a network round
   trip before auditioning them or replay their server echoes.

### New effect checklist

1. Add its parameter contract to `src/sontrama/effect_specs.json` and its kind to
   `EffectSpec` and the frontend types. Keep existing parameter/choice ordering
   stable: native and WASM adapters pass ordered numeric vectors to C, and effect
   kind IDs follow the shared definition order. Update the C dispatch accordingly.
2. Implement the processor and live configuration in `dsp/effects.c` (or a new
   shared C source), using `native_effects.py` and `web/src/dsp-core.ts` as thin
   adapters. Use the existing ordered Channel/Master pipeline, not an independent
   Web Audio effect or an extra ScriptProcessor per effect.
3. Add localized names, parameter labels and help. Verify defaults, bypass,
   reorder, removal and live edits; rebuilding a chain for a topology change must
   not cause ordinary parameter edits to reset its DSP state.

### Build and verification gate

- When adding C files, include them in both `native_core.py`'s `SOURCES` and
  `scripts/build-dsp.mjs`'s source list so compilation and fingerprints cover the
  same inputs. Update ctypes signatures, WASM exports and TypeScript bindings
  together. Update the shared ABI contract when its interface/layout changes.
- Build WASM with `npm run build`, rebuild/load the native core and restart the
  local backend after source changes. Preserve binary/manifest/server revision
  checks and pinned external-engine version checks; never bypass a mismatch to
  make preview start. Prepare both targets before a service installation.
- Extend `tests/test_shared_dsp.py` and `scripts/render-core.mjs` for instruments
  and complete chains; extend `tests/test_effects.py` and the production WASM
  effect runner for effects. Use the actual production adapters, identical
  assets, seeds and sample-accurate event timelines at 44.1 and 48 kHz. Include
  different host block sizes, nondefault/boundary values and live edits. Cover
  note release, sustain, bend, pressure, polyphony and randomness where relevant;
  cover stereo, tails, bypass and gain staging for effects.
- Compare rendered samples with explicit, justified tolerances and test audible
  behavior as well: two equally silent/broken outputs are not a passing parity
  test. Do not loosen tolerances merely to conceal divergent implementations.
  Add targeted browser checks for new controls and real audio in worklet/fallback
  paths. Run the smallest relevant locked pytest/Playwright selections plus
  frontend checks/build; use `tests/test_banks_parity.py` for Banks changes.
- For ARM-sensitive DSP changes, use `scripts/check-arm-parity.py` against an
  explicitly selected SSH target and isolated temporary directory when remote
  testing is authorized. Extend its cases for the new processor. This check is
  not deployment authorization; do not update the Pi service without a request.
- Document any remaining discrepancy. Shared processing does not synchronize
  independent hardware clocks, network arrival times or state after reconnect;
  do not claim those guarantees without the corresponding timing/state protocol.

## Development and validation

From the workspace root: `./task/init/all.sh`, then use separate terminals for
`./task/local/backend.sh` and `./task/local/frontend.sh`. Backend development
disables native audio/MIDI by default; browser preview remains available.

From `sontrama/`:

```sh
uv run --frozen ruff check src tests
uv run --frozen ruff format --check src tests
uv run --frozen pytest tests/test_shared_dsp.py tests/test_banks_parity.py tests/test_midi_preview.py -q
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
