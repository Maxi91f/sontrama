#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
cd -- "$PROJECT_ROOT"
mode="$1"
shift
exec uv run --project "$APP_DIR" --frozen ruff "$mode" \
  --config "$APP_DIR/pyproject.toml" "$@"
