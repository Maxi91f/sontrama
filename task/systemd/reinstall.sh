#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
"$APP_DIR/scripts/install-service.sh" "$@"
sudo systemctl restart sontrama.service
