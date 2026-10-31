# Sontrama

Live MIDI studio for Raspberry Pi 3 B and Linux, with a responsive web interface.
Code and documentation use English; the UI supports Spanish and English.

## Running locally

Requires Python 3.12, uv, Node 22.13+ (22.x) or 24+, and Linux audio libraries.
From `sontrama/`, on Debian/Raspberry Pi OS:

```sh
sudo apt install timgm6mb-soundfont libportaudio2 libasound2-dev build-essential cmake pkg-config libglib2.0-dev git
uv sync --frozen
npm ci
./scripts/build-banks.sh
../task/init/wasm.sh
npm run build
uv run --frozen sontrama
```

Node and Emscripten are build dependencies;
they are not required on a Pi receiving a frontend built on the PC.

Open <http://127.0.0.1:8081>. No Internet connection is required after installation
and building. FluidSynth WASM assets are served locally.
Local simulation is enabled by default, with preview volume at 100% and mute on.
To listen on this computer, open **Output** and unmute **Browser preview**.
Preview volume and mute affect only browser listening; visualizers keep running.
This is an additional monitor and does not change the server's main output.
The fixed **Monitor bar** contains the test keyboard. **Capture keyboard**
toggles PC keyboard capture only.
The on-screen keyboard also supports mouse and touch input.

Z/X/C/V/B/N/M play white keys starting at C4; S/D/G/H/J play black keys.
After M, comma, period and slash continue with C5, D5 and E5, with L and
semicolon playing the black keys. Q/W/E/R/T/Y/U start at C5; I/O/P/[/]/\
continue from C6. Multiple keys may trigger the same note: it stops when the
last key is released. Capture ignores editable fields and releases notes when
the window loses focus. Incoming MIDI also highlights the on-screen keys,
independently of browser preview.

To develop without opening the server's native audio or MIDI devices:

```sh
SONTRAMA_NO_AUDIO=1 SONTRAMA_NO_MIDI=1 uv run --frozen sontrama
```

The native engine remains available for rendering; the browser generates its
own audio. For frontend development, run `npm run dev` in another terminal.
Workspace-level setup, development and deployment scripts are documented in
[the development guide](../docs/DEVELOPMENT.md).

## Live

- **Inputs**: automatic connection to the server's USB MIDI devices, channel
  selection, and optional Web MIDI for devices attached to the browsing computer.
- **Instrument**: Banks (SF2 SoundFonts and their actual banks/presets) or
  3 Osc (three-oscillator synthesis without SoundFonts). Both support octave
  shifts, sustain CC64, modulation CC1, pitch bend and MIDI pressure.
- **Mixer**: select Channel 01 or Master from compact cards showing stereo
  meters, effect counts, volume and pan. Channel cards have Mute/Solo; Master has Mute only. These
  controls do not change the selected channel. Master uses
  a pink accent. One editor below contains the selected bus's ordered effects,
  volume and stereo pan. Add, remove, bypass and reorder up to eight effects
  per bus (chorus, reverb, gain, filter/EQ, compressor and limiter). The Add effect button
  beside the chain heading opens a modal picker. Channel audio passes
  through its effects and level/pan controls, then through Master effects and
  Master level/pan controls. Master mute silences the final signal, including
  effect tails. Solo states are saved; with one source and one output bus,
  they do not change which sources are audible.
- **Visualizations**: add audio analyzers and a MIDI monitor through a modal picker, choose
  Channel 01 or Master, drag views around the grid, resize them from the corner,
  then pin compact copies to the Monitor bar. Pinned views share the original's signal, zoom and pause
  settings. The bar stays available across tabs and settings; on mobile, its
  selector switches between the keyboard and pinned views. Dashboard layout,
  pins and bar preferences are shared across browsers and survive restart.
- **Output**: server audio status, stereo output meters and underruns, plus
  independent browser preview volume and mute. The server keeps playing when
  the page closes. Local simulation is controlled under **Settings → Audio**;
  simulation, preview volume/mute and keyboard capture are shared across browsers. If autoplay is blocked, audio
  resumes on the next local interaction.

Preview reproduces the same MIDI, instrument, parameters, effects and levels
in the browser; Banks uses the same SoundFont. Audio is generated independently
in each browser, while enabling or disabling local simulation is shared across clients
connected to the same server. Preview does not reroute the server output.
Web MIDI requires HTTPS or localhost and a compatible browser; USB MIDI on the
Pi does not depend on Web MIDI. Over LAN HTTP, browser audio falls back to the
main thread when AudioWorklet is unavailable; HTTPS enables AudioWorklet.
Browser-origin notes play immediately in the preview, without waiting for the
server echo. Event IDs and acknowledgements prevent duplicate playback and
reconcile rejected or differently routed notes. MIDI from the Pi still travels
to the browser over WebSocket. Events received during engine loading are bounded
and queued until initialization completes. Preview requests the server's sample
rate and uses the same processing code, but each device has its own audio buffers
and clock. Enabling preview or reconnecting does not reconstruct already-held
notes, controller state or existing effect tails.

Meters show stereo sample peaks after each bus's effects, pan and level controls.
They use a −60 to 0 dBFS scale: green below −12 dBFS, yellow up to −3 dBFS,
and red above it. The peak marker holds for 900 ms before falling; reaching
full scale lights the overload indicator for two seconds. Mixer meters use local simulation, independently of preview volume and mute.
The server output meters in **Output** preserve the highest peak between
broadcasts. Turning off simulation clears the mixer meters. These are sample-peak meters, not true-peak or
loudness meters.

Drag the grip beside a view's title to reorder it; drag its lower-right corner
to snap its width and height to the grid. Escape cancels an active gesture.
The handles also support arrow keys. Dock items can be reordered independently of the dashboard, including
placing them in empty space. A shadow previews the committed position. All dock
items share a yellow panel and height. The keyboard's width reveals more or fewer
fixed-size keys. Its octave buttons shift only the on-screen panel; PC letter keys
and external MIDI retain their pitches. Dragging across keys releases the previous
note and plays the next; leaving the piano releases it too.

The monitor bar always stays in one row and scrolls horizontally when panels do
not fit. Resize handles stop at its visible boundary. Positions, widths and panel
octave are shared across browsers. The collapsed bar is a thin strip with a
chevron toggle. Layout changes are saved on release.

The visualization picker includes:

| View               | Reading                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oscilloscope       | L/R waveforms with a rising zero-crossing trigger and vertical zoom.                                                                                             |
| Spectrum           | Configurable FFT, window function, frequency/dB range, axis scale, smoothing and refresh rate.                                                                   |
| Spectrogram        | Configurable frequency history from 2 to 32 seconds, with intensity shown in color.                                                                              |
| Vectorscope        | L/R relationship: mono is vertical, opposite polarity is horizontal.                                                                                             |
| Stereo correlation | Normalized channel correlation from −1 to +1; silence or a missing channel has no reading.                                                                       |
| Tuner              | Monophonic note, frequency and cents relative to A4 = 440 Hz, from 50 to 2,000 Hz.                                                                               |
| MIDI monitor       | The last 64 routed MIDI events, including velocity, CC, pressure, program changes and pitch bend.                                                                |
| VU meter           | Stereo sample-peak bars or a smoothed RMS needle, switchable on each widget. The needle uses 0 VU = −18 dBFS RMS; it is not a loudness or true-peak measurement. |

Spectrum and spectrogram expose **Analysis settings** with 256–4,096 sample FFTs,
Hann/Hamming/Blackman/rectangular windows, 5/10/20 Hz display refresh, linear or
logarithmic frequency axes, frequency and dBFS limits, and smoothing. Spectrogram
scroll speed is expressed as the time across the full width (2–32 seconds).
The source-rate readout shows the actual sampling rate and FFT resolution in Hz
per bin. It is not a per-view audio-rate switch: native output rate is configured
in Audio settings, while preview uses its browser AudioContext rate. Larger FFTs
use real contiguous samples from the local engine.

All views can be paused and pinned; their shared configuration persists. Audio
views inspect Channel 01 or Master from local simulation, before preview volume
and mute. When simulation is off, each audio view offers a button to enable it;
MIDI monitoring remains available. Suspended browser audio offers a resume action.
The MIDI monitor follows received WebSocket MIDI independently of audio preview,
and does not request audio frames by itself. Clearing it only clears that widget's
local history. Histories and frozen samples are transient browser state.

The server sends MIDI, shared settings and compact peak-meter readings; it does
not capture or stream audio samples to the browser. FFT, pitch detection and
visual rendering run locally. The tuner uses the stronger channel to avoid
opposite-polarity cancellation and is intended for one sustained note at a time.

## Effects

Every channel and Master can host any of these effects, in any order:

| Effect      | Controls                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Chorus      | Rate, modulation depth, base delay, stereo spread, feedback and Dry/Wet                                                   |
| Reverb      | Decay, pre-delay, room size, damping frequency, diffusion, stereo width, low/high cuts and Dry/Wet                        |
| Filter / EQ | Low-pass, high-pass, band-pass, notch, bell or low/high shelf; frequency, resonance, 12/24 dB slopes, EQ gain and Dry/Wet |
| Gain        | Gain from −48 to +24 dB and stereo width                                                                                  |
| Compressor  | Threshold, ratio, attack, release, soft knee, makeup gain, sidechain HPF and parallel Dry/Wet                             |
| Limiter     | Peak ceiling, input gain, release and 0–10 ms lookahead                                                                   |

Frequency and timing controls use logarithmic sliders where appropriate.
At 0%, Dry/Wet outputs the original signal; at 100%, it outputs the processed signal. Click or tap a
parameter name for an explanation; controls also expose the help to screen readers.
EQ gain appears for bell and shelf types. Parameter edits preserve DSP state,
including reverb/delay tails; bypassing, reordering or replacing the chain resets
that bus. The compressor and limiter link their detectors across stereo channels.
The limiter controls sample peaks at its own output; it is not a true-peak limiter.
Each limiter adds its selected lookahead to the signal latency. Effects placed
after it, stereo folding, or later gain changes can raise peaks again.

Existing single-value sessions migrate automatically to full parameter sets.
The legacy `value` field remains the primary parameter alias and takes precedence
when supplied together with `parameters`. Upgraded chorus and reverb algorithms
may sound different from older versions even with the same mix value.

## 3 Osc

A custom instrument inspired by [Image-Line's 3x Osc](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/3x%20Osc.htm).
It does not run the FL Studio plugin or use its binaries or presets.

All three oscillators default to sine waves with centered tuning and pan.
Oscillator 2 and 3 mixes default to zero, so only the first oscillator is audible.
Waveforms are selected with mutually exclusive graphic buttons.

The three oscillators offer sine, triangle, square, saw, rounded saw and white
noise. Each has an enable toggle, ±24-semitone coarse tuning, ±100-cent fine
tuning, pan, initial phase from 0° to 360°, stereo phase offset and stereo detune.
Initial phase shifts both channels together; stereo phase offset adds a
difference to the right channel. Both can be adjusted while notes are held.
Oscillator 2 and 3 mixes are sequential proportions: 50% and 33% yield roughly
three equal contributions. The third oscillator can provide AM modulation.
Random initial phase and HQ harmonic-limited wavetables are also available.
Custom waveform loading is not supported, and the instrument does not claim
to sound identical to the original plugin.

An ADSR envelope controls attack, decay, sustain and release. Polyphony is
limited to 16 voices. CC1 adds vibrato; pitch bend spans ±2 semitones. CC7,
CC10 and CC11 control volume, pan and expression. Parameters are saved on the
server and can be edited while notes are held. Switching to Banks preserves
both instruments' settings.

The complete 3 Osc engine is portable C, including voice allocation, envelopes,
controller handling, wavetable generation and per-voice random generators.
`native_core.py` loads its native build; the browser executes the same sources
as WebAssembly. The mixer and all six effects use this shared core too.
There is no separate Python or TypeScript synthesis implementation.

## Shared audio core

The pinned Emscripten SDK is installed in `.cache/emsdk` by `../task/init/wasm.sh`.
`npm run build` rebuilds changed DSP sources and writes the WASM binary and
revision manifest into ignored `public/vendor/`. Native kernels are cached in
`data/native`. Both artifacts embed their source revision; preview rejects a
mismatched binary/manifest or server revision instead of silently diverging.
The browser requests the server's sample rate and rebuilds when it changes.

Banks uses FluidSynth 2.4.6 in both targets. `scripts/build-banks.sh` builds the
pinned native revision locally, without replacing the system library; the
frontend vendors the matching WASM release from the locked dependency. Startup
and preview compatibility checks reject unexpected versions. Installation needs
Internet access to obtain pinned build tools/sources; runtime does not.

## SoundFonts and state

By default, `.sf2` files are discovered in `data/soundfonts`,
`/usr/share/sounds/sf2` and `/usr/share/soundfonts`. The `timgm6mb-soundfont`
package provides TimGM6mb with 136 presets.
To use other files or directories, edit **Settings → Library**.
`SONTRAMA_SOUNDFONTS` supplies the initial colon-separated paths before a shared
configuration has been saved. SoundFonts are excluded from Git.

Session state is saved automatically with atomic replacement in
`data/session.json`: preset, channel/Master effects, levels, pan, mute/solo, inputs, octave and output.
Shared configuration is saved separately in `data/settings.json` (next to the
configured session file). Updates are broadcast over WebSocket, so changes on
the computer appear on a phone connected to the same server without reloading.
Only the selected Live tab remains local under `sontrama.preferences.v1`.
Legacy keyboard capture preferences migrate once, only if the server has no
saved configuration; later connections cannot overwrite shared settings with
old browser values. Older preview on/off settings migrate to enabled simulation
with volume at 100% and mute on; subsequent simulation choices are preserved.
Active notes are not persisted. The application exposes the catalog but does
not support file uploads.

The gear button opens **Settings**. Navigation appears on the left on
desktop and above the content on smaller screens. Its sections are:

- **Interface:** shared Spanish/English language and system/reduced/full motion preferences.
- **Keyboard:** capture on opening, fixed velocity from 1 to 127, and shortcut,
  note, combined or hidden labels. The capture toggle also updates the
  shared configuration from Live.
- **Audio:** local simulation on/off, plus the server's stereo output device,
  44.1/48 kHz sample rate and 256/512/1024-frame buffer. The simulation toggle
  saves immediately without rebuilding native audio. Apply explicitly to rebuild the output and release active notes.
  Failed changes restore the previous engine and output configuration.
- **MIDI:** automatic connection and linear/soft/hard velocity curves per
  controller, including devices reported by Web MIDI browsers. Preferences use
  device names, ignoring volatile ALSA client/port numbers when reconnecting.
- **Library:** server SoundFont folders or SF2 files, and catalog rescanning.
  Rescanning preserves the selected preset when available, selects another
  available preset if necessary, and rejects an empty library while Banks is
  active. It does not download or upload files.

Successful saves show a bottom toast for 1.8 seconds. Errors remain visible
in the form. Audio, MIDI and library settings refer to the server; preview audio
is still generated independently in each browser. Environment audio settings
provide initial defaults; saved configuration takes precedence on restart.

## Raspberry Pi and systemd

Copy this directory to your target installation path and install the system dependencies
listed above. Create the environment with
`uv sync --frozen --no-dev --python 3.12`. Build the frontend on the PC and copy
`dist/` to the Pi to avoid installing Node there; the Python service does not
need Node at runtime.

```sh
mkdir -p data/soundfonts
./scripts/install-service.sh
```

The installer generates a service for the current user and directory, installs
`/etc/sontrama.env` if it does not exist, and runs
`systemctl enable --now sontrama`. The service starts automatically after a
reboot. Inspect it with `journalctl -u sontrama -f` and
`systemctl status sontrama`.

Before starting the service, the installer builds pinned FluidSynth for the
target CPU and prepares the shared native kernel. The target therefore needs
the build dependencies listed above, including Git, CMake and GLib headers.
The first build needs Internet access; subsequent installations reuse artifacts.
It preserves an existing `/etc/sontrama.env`. When manually updating an already
running installation, finish with `sudo systemctl restart sontrama`;
`enable --now` alone does not restart an active service. The workspace deployment
script performs that restart automatically.

The generic service profile uses port **8081**. From the same network, open
`http://PI-IP:8081`. The service listens on the LAN according to its environment
file; it is intended for a trusted network and has no authentication.

For the 3.5 mm jack, choose the headphones device under **Settings → Audio**.
Check the underrun counter in **Output**; if needed, increase the buffer to 512
or 1024 frames. `SONTRAMA_AUDIO_DEVICE` and `SONTRAMA_BLOCK_SIZE` in
`/etc/sontrama.env` are initial defaults for installations without saved settings.
Two synthesizers must not compete for the same audio device. Stop any other
application using the selected device before enabling Sontrama.

Changes made in the configuration UI apply without restarting the service.
Changes to its environment file require `sudo systemctl restart sontrama`.
The UI reports audio/MIDI errors rather than simulating device availability.
An example Pi 3 audio profile and hardware validation are described below.

## Raspberry Pi 3 profile

`deploy/raspi3.env.example` provides a starting point for the Pi 3 B:
bcm2835 headphones, 512-frame blocks and 30 ms requested buffering.
Adjust the installation paths and audio device name for your system before the
first start. Later, use the configuration UI to save changes.
Paths under `/home/pi/sontrama` in templates are examples; the installer
generates the generic service configuration for the current user and directory.

Validation on a Pi 3 B running Debian arm64 covered physical MIDI input and
3.5 mm jack output, effects and browser preview. Automated hardware checks covered
virtual ALSA MIDI, 16 simultaneous notes with all six effects in Banks and 3 Osc,
and underrun monitoring. ARM/WASM comparisons covered the shared core and pinned
Banks at 44.1 and 48 kHz. Browser checks against the Pi covered MIDI highlighting,
immediate preview without echoed retriggers, and sustain during live edits.
These checks do not guarantee glitch-free output under every workload; monitor
underruns for the selected device and buffer. Systemd automatic startup and service restarts have also been checked on hardware.
For browser tests against a running server, replace the example hostname:

```sh
SONTRAMA_TEST_URL=http://synth-host:8081 npx playwright test tests/browser/three-osc.spec.ts
```

## Architecture

```text
Input (USB MIDI / Web MIDI / keyboard)
          ↓
Instrument (Banks / 3 Osc)
          ↓ dry audio
Effects / Mixer
  Channel EffectChain → Channel level/pan → Master EffectChain → Master level/pan
          ↓
Output (AudioOutput)
```

`contracts.py` defines the Instrument, AudioEffect and AudioOutput contracts.
`catalog.py` reads SF2 metadata independently of the synthesizer.
`instruments.py` adapts FluidSynth; `effects.py` routes NumPy buffers through
the stateful C kernel in `dsp/effects.c`; `three_osc.py` adapts the shared
three-oscillator engine in `dsp/three_osc.c`. `dsp/mixer.c` implements the shared
bus processing and output clipping. `runtime.py` coordinates MIDI, the mixer
and PortAudio output.
`app.py` exposes REST, WebSocket and static files.

The TypeScript client selects an engine through the `VoiceEngine` contract.
Banks uses pinned FluidSynth WASM; 3 Osc uses the shared C/WASM engine.
Both feed one shared processing pipeline with taps after Channel and Master,
followed by final output clipping. Gain/pan transitions use identical 10 ms
smoothing in both targets; mute silences immediately. Effect parameter edits
preserve state, while changing a bus topology rebuilds that bus's chain.
Effect ranges/defaults come from `effect_specs.json`; the low-level ABI and
pinned engine versions live in `dsp/core_contract.json`.

`tests/test_shared_dsp.py` compares native/WASM instruments and complete chains
at 44.1/48 kHz, including HQ, seeded noise, random phase, controller changes,
sustain, voice stealing, live edits and different host block sizes.
`tests/test_banks_parity.py` creates an original synthetic SF2 fixture and compares
pinned native/WASM Banks renders. Browser tests cover immediate MIDI, delayed
echoes, rejection, sample-rate changes and pedal preservation during edits.

For an isolated ARM comparison without deploying or changing an audio service:

```sh
uv run --frozen python scripts/check-arm-parity.py user@synth-host /absolute/path/to/.venv/bin/python /tmp/sontrama-parity-check
```

The SSH target needs a C compiler and the locked runtime dependencies. The tool
copies only source/test data into a new temporary directory, compares native
renders against the production WASM adapter, and removes the directory afterward.

Shared DSP avoids maintaining separate processing algorithms. Small floating-point
differences between compiler targets remain subject to explicit parity tolerances.
It does not synchronize hardware
output clocks, recover all voices after reconnect, or restore old effect tails.
Those require a separate musical-state/time protocol. AudioWorklet needs HTTPS
or localhost. Configure `SONTRAMA_TLS_CERT` and `SONTRAMA_TLS_KEY` with trusted
certificate paths for HTTPS on the LAN; the HTTP fallback remains available.
A C compiler is needed during setup/startup, and the service installer prepares
all native artifacts before starting audio. No build, file loading or network
operation occurs in the audio callback.

To add an instrument or effect, follow the shared-DSP
[checklists in AGENTS.md](../AGENTS.md#adding-instruments-and-effects-without-dsp-divergence).
Implement processing once, register both host adapters, update shared contracts
and bindings, then rebuild and verify native/WASM parity. The effect picker and
editor use the shared parameter contract. This version has two instruments and one channel; it does not
include a sequencer, patches, pads, recording or MIDI file playback.

## Validation

Run only the checks relevant to the change. For example:

```sh
uv run --frozen pytest tests/test_three_osc.py -q
# For shared DSP, Banks or MIDI protocol changes, select the relevant cases:
uv run --frozen pytest tests/test_shared_dsp.py tests/test_banks_parity.py tests/test_midi_preview.py -q
uv run --frozen ruff check src tests
npm run lint
npm run format:check
npm run build
# With the local server running:
npx playwright test tests/browser/live.spec.ts -g 'incoming MIDI'
```

Playwright uses Chrome installed at `/usr/bin/google-chrome`; override it with
`CHROME_PATH`. Browser tests cover tabs, persistence, effects, layouts at
320/768/1440px and actual WebAssembly audio.

## Dependencies and licenses

Sontrama's own code and documentation use the [MIT License](LICENSE).
Third-party dependencies and assets retain their respective licenses.

The frontend uses [js-synthesizer](https://github.com/jet2jet/js-synthesizer)
(BSD-3-Clause) and [FluidSynth Emscripten](https://github.com/jet2jet/fluidsynth-emscripten)
(LGPL-2.1). `npm run build` copies their licenses alongside the served assets.
The SoundFont comes from its system package and retains its own license.

## Localization

User-facing copy lives in `web/src/locales/es.ts` and `en.ts`, using i18next.
English is the default. The server persists and broadcasts the selected language;
changing it updates connected screens without restarting audio or releasing notes.
Keep complete sentences in the catalogs and interpolate variable content. Device,
SoundFont and preset names are external data and retain their original names.
Escape external values when inserting translated text into HTML; use `textContent`
for notifications. Translation keys are checked by TypeScript against both catalogs.

The backend always uses English diagnostics, independently of the selected language.
HTTP errors expose `detail: { code, message, params }`; WebSocket errors expose
`{ type: "error", code, message, params }`. State snapshots include structured
`status.issues` alongside the English `status.errors` diagnostics. Audio discovery
includes `resources.audio_issue` alongside `audio_error`. Frontend notifications
translate codes and parameters, with a generic localized fallback for unknown codes;
raw diagnostic messages remain available to API clients.
