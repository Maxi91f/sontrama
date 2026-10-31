#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
# The pinned SDK stays local; deployed machines do not need Emscripten.
version=4.0.23
revision=c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56
sdk_dir="$APP_DIR/.cache/emsdk"
if [[ ! -d "$sdk_dir/.git" ]]; then
  git clone --depth 1 --branch "$version" https://github.com/emscripten-core/emsdk.git "$sdk_dir"
fi
if [[ "$(git -C "$sdk_dir" rev-parse HEAD)" != "$revision" ]]; then
  echo 'The cached Emscripten SDK does not match the pinned revision.' >&2
  exit 1
fi
"$sdk_dir/emsdk" install "$version"
"$sdk_dir/emsdk" activate "$version"
cd -- "$APP_DIR"
node scripts/build-dsp.mjs
