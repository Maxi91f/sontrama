#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../config.sh"
if (( $# != 2 )); then
  echo 'Usage: task/deploy/all.sh USER@HOST /absolute/install/directory' >&2
  exit 2
fi
remote_host="$1"
remote_dir="$2"
if [[ "$remote_host" == -* || ! "$remote_dir" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
  echo 'Use an SSH alias/host and an absolute remote path without spaces.' >&2
  exit 2
fi
cd -- "$APP_DIR"
npm run build
ssh "$remote_host" "mkdir -p -- '$remote_dir'"
rsync -az --relative --exclude='__pycache__/' --exclude='*.pyc' \
  --exclude='/deploy/local/' \
  .python-version pyproject.toml uv.lock LICENSE src dist deploy scripts \
  "$remote_host:$remote_dir/"
ssh "$remote_host" "bash -s -- '$remote_dir'" <<'REMOTE'
set -euo pipefail
cd -- "$1"
export PATH="$HOME/.local/bin:$PATH"
uv sync --frozen --no-dev --python 3.12
./scripts/install-service.sh
sudo systemctl restart sontrama.service
systemctl is-enabled sontrama.service
systemctl is-active sontrama.service
REMOTE
