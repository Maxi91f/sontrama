# Sontrama

Live MIDI studio for Raspberry Pi 3 B and Linux, with a responsive web interface.
Code and documentation use English; the UI currently uses Spanish.
Spanish labels below refer to the controls displayed in the application.

## Running locally

Requires Python 3.12, uv, Node 22.13+ (22.x) or 24+, and Linux audio libraries.
On Debian/Raspberry Pi OS:

```sh
sudo apt install libfluidsynth3 timgm6mb-soundfont libportaudio2 libasound2-dev build-essential pkg-config
uv sync --frozen
npm ci
npm run build
uv run --frozen sontrama
```

Open <http://127.0.0.1:8081>. No Internet connection is required after installation
and building. FluidSynth WASM assets are served locally.
To listen on this computer, open **Salida** and enable **Preview en navegador**.
This is an additional monitor and does not change the server's main output.
In **Teclado de prueba**, **Capturar teclado** toggles PC keyboard capture only.
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

- **Entradas**: automatic connection to the server's USB MIDI devices, channel
  selection, and optional Web MIDI for devices attached to the browsing computer.
- **Instrumento**: Banks (SF2 SoundFonts and their actual banks/presets) or
  3 Osc (three-oscillator synthesis without SoundFonts). Both support octave
  shifts, sustain CC64, modulation CC1, pitch bend and MIDI pressure.
- **Efectos**: chorus, reverb, gain and low-pass filtering in series.
  Add, remove, bypass and reorder up to eight effects.
- **Mixer**: channel 01 and Master, levels, meters, mute and solo. With only
  one channel, Solo does not affect the sound; its state is saved for expansion.
- **Salida**: the server's main output and independent browser preview.
  The server keeps playing when the page closes. Each browser remembers its
  preview and keyboard capture preferences. If autoplay is blocked, audio
  resumes on the next local interaction.

Preview reproduces the same MIDI, instrument, parameters, effects and levels
in the browser; Banks uses the same SoundFont.
Web MIDI requires HTTPS or localhost and a compatible browser; USB MIDI on the
Pi does not depend on Web MIDI. Over LAN HTTP, browser audio falls back to the
main thread when AudioWorklet is unavailable; HTTPS enables AudioWorklet.

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

The server uses a compiled C kernel cached in `data/native`, with a NumPy
fallback (`SONTRAMA_PYTHON_DSP=1`). Preview uses its own DSP in an AudioWorklet,
with a ScriptProcessor fallback for HTTP without a secure context.
The C kernel accelerates oscillators and modulation for live audio on the Pi 3 B.
The installer prepares the kernel and bytecode before enabling systemd.

## SoundFonts and state

By default, `.sf2` files are discovered in `data/soundfonts`,
`/usr/share/sounds/sf2` and `/usr/share/soundfonts`. The `timgm6mb-soundfont`
package provides TimGM6mb with 136 presets.
To use other files or directories, set
`SONTRAMA_SOUNDFONTS` to colon-separated paths. SoundFonts are excluded from Git.

Session state is saved automatically with atomic replacement in
`data/session.json`: preset, effects, levels, inputs, octave and output.
The selected tab, keyboard capture and preview preferences are saved separately
for each browser under `sontrama.preferences.v1` in localStorage.
Active notes are not persisted. The application exposes the catalog but does
not support file uploads.

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

The generic service profile uses port **8081**. From the same network, open
`http://PI-IP:8081`. The service listens on the LAN according to its environment
file; it is intended for a trusted network and has no authentication.

For the 3.5 mm jack, choose the device by its name as listed by
`uv run --frozen python -m sounddevice`, then set `SONTRAMA_AUDIO_DEVICE` in
`/etc/sontrama.env`. Check the underrun counter in **Salida**; if needed,
increase `SONTRAMA_BLOCK_SIZE` from 256 to 512 or 1024.
Two synthesizers must not compete for the same audio device. Stop any other
application using the selected device before enabling Sontrama.

Configuration changes require `sudo systemctl restart sontrama`.
The UI reports audio/MIDI errors rather than simulating device availability.
An example Pi 3 audio profile and hardware validation are described below.

## Raspberry Pi 3 profile

`deploy/raspi3.env.example` provides a starting point for the Pi 3 B:
bcm2835 headphones, 512-frame blocks and 30 ms requested buffering.
Adjust the installation paths and audio device name for your system, then
apply the settings in `/etc/sontrama.env` and restart the service.
Paths under `/home/pi/sontrama` in templates are examples; the installer
generates the generic service configuration for the current user and directory.

Testing on a Pi 3 B running Debian arm64 covered virtual ALSA MIDI,
16 simultaneous notes, modulation CC and effects with Banks and 3 Osc,
while measuring audio underruns. Automatic startup was verified by rebooting.
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
  EffectChain → Channel 01 → Master
          ↓
Output (AudioOutput)
```

`contracts.py` defines the Instrument, AudioEffect and AudioOutput contracts.
`catalog.py` reads SF2 metadata independently of the synthesizer.
`instruments.py` adapts FluidSynth; `effects.py` processes NumPy buffers
separately; `three_osc.py` implements the three-oscillator instrument without
FluidSynth; `runtime.py` coordinates MIDI, the mixer and PortAudio output.
`app.py` exposes REST, WebSocket and static files.

The TypeScript client selects an engine through the `VoiceEngine` contract:
Banks uses FluidSynth WASM, while 3 Osc uses custom DSP. Both deliver dry audio
to the same Web Audio effect chain and mixer, using session parameters.
Effects have the same purpose and order in both environments, but are not
guaranteed to produce identical samples in Web Audio and native processing.

To add an instrument, implement Instrument and register its adapter.
To add an effect, register its factory in EFFECTS and add the corresponding
web adapter. This version has two instruments and one channel; it does not
include a sequencer, patches, pads, recording or MIDI file playback.

## Validation

Run only the checks relevant to the change. For example:

```sh
uv run --frozen pytest tests/test_three_osc.py -q
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
