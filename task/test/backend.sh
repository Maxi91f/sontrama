#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
if (( $# == 0 )); then
  echo 'Select tests explicitly, e.g. task/test/backend.sh tests/test_three_osc.py -q' >&2
  exit 2
fi
cd -- "$APP_DIR"
exec uv run --frozen pytest "$@"
