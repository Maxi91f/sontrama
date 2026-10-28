#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
exec "$APP_DIR/scripts/install-service.sh" "$@"
