#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
if (( $# == 0 )); then
  echo 'Select tests explicitly, e.g. task/test/frontend.sh tests/browser/live.spec.ts' >&2
  exit 2
fi
cd -- "$APP_DIR"
exec ./node_modules/.bin/playwright test "$@"
