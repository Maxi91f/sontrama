#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
version=2.4.6
revision=a7792513b032f1ff422cc928eecc6c660f236720
install_dir="$PWD/data/native/fluidsynth-$version"
if [[ -f "$install_dir/.sontrama-revision" ]] && [[ "$(cat "$install_dir/.sontrama-revision")" == "$revision" ]]; then
  exit 0
fi
if ! pkg-config --exists glib-2.0; then
  echo 'Pinned FluidSynth needs GLib headers. Install cmake, pkg-config and libglib2.0-dev.' >&2
  exit 1
fi
source_dir="$PWD/.cache/banks/source"
build_dir="$PWD/.cache/banks/build"
mkdir -p .cache/banks data/native
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --depth 1 --branch "v$version" https://github.com/FluidSynth/fluidsynth.git "$source_dir"
fi
if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]]; then
  echo 'The cached FluidSynth sources do not match the pinned revision.' >&2
  exit 1
fi
cmake -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$install_dir" -Denable-shared=ON -Denable-floats=ON \
  -Denable-libsndfile=OFF -Denable-pulseaudio=OFF -Denable-alsa=OFF \
  -Denable-jack=OFF -Denable-oss=OFF -Denable-sdl2=OFF -Denable-aufile=OFF \
  -Denable-network=OFF -Denable-ladspa=OFF -Denable-libinstpatch=OFF \
  -Denable-dbus=OFF -Denable-readline=OFF -Denable-systemd=OFF -Denable-portaudio=OFF
cmake --build "$build_dir" --parallel "${SONTRAMA_BUILD_JOBS:-2}"
cmake --install "$build_dir"
printf '%s\n' "$revision" > "$install_dir/.sontrama-revision"
