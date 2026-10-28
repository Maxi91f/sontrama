#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
cd -- "$APP_DIR"
export SONTRAMA_NO_AUDIO="${SONTRAMA_NO_AUDIO:-1}"
export SONTRAMA_NO_MIDI="${SONTRAMA_NO_MIDI:-1}"
export OPENBLAS_NUM_THREADS=1
exec uv run --frozen uvicorn sontrama.app:create_app --factory --reload \
  --host "${SONTRAMA_HOST:-127.0.0.1}" --port "${SONTRAMA_PORT:-8081}" "$@"
