#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
cd -- "$APP_DIR"
files=()
for file in "$@"; do files+=("${file#sontrama/}"); done
exec ./node_modules/.bin/eslint --fix --max-warnings 0 "${files[@]}"
