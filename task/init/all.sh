#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
"$TASK_DIR/init/backend.sh"
"$TASK_DIR/init/frontend.sh"
cd -- "$PROJECT_ROOT"
prek install
