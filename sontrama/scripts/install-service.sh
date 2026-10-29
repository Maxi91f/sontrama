#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
project_dir="$PWD"
service_user="${SUDO_USER:-$USER}"
if [[ "$service_user" == root ]]; then
  echo 'Run as the intended service user, not root.' >&2
  exit 1
fi
if [[ ! -x .venv/bin/sontrama || ! -f dist/index.html ]]; then
  echo 'First run: uv sync --frozen --no-dev && npm ci && npm run build' >&2
  exit 1
fi
mkdir -p data/soundfonts
# Service paths are read-only: prepare bytecode and the native kernel beforehand.
uv run --frozen --no-sync python -m compileall -q src .venv/lib
uv run --frozen --no-sync python -c 'from sontrama.native_dsp import load_kernel; from sontrama.native_effects import load_effect_kernel; load_kernel(); load_effect_kernel()'
service_group="$(id -gn "$service_user")"
service_file="$(mktemp)"
environment_file="$(mktemp)"
trap 'rm -f "$service_file" "$environment_file"' EXIT
uv run --frozen --no-sync python - "$project_dir" "$service_user" "$service_group" > "$service_file" <<'PY'
import pathlib, sys
root, user, group = sys.argv[1:]
# systemd quoted values still interpret % specifiers.
quoted = '"' + root.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
text = pathlib.Path('deploy/sontrama.service').read_text()
text = text.replace('User=pi', f'User={user}').replace('Group=pi', f'Group={group}')
text = text.replace('WorkingDirectory=/home/pi/sontrama',
                    'WorkingDirectory=' + root.replace('%', '%%'))
text = text.replace('ReadWritePaths=/home/pi/sontrama/data',
                    'ReadWritePaths=' + quoted[:-1] + '/data"')
text = text.replace('ExecStart=/home/pi/sontrama/.venv/bin/sontrama',
                    'ExecStart=' + quoted[:-1] + '/.venv/bin/sontrama"')
print(text)
PY
uv run --frozen --no-sync python - "$project_dir" > "$environment_file" <<'PYENV'
import json, pathlib, sys
root = sys.argv[1]
text = pathlib.Path('deploy/sontrama.env.example').read_text()
for line in text.splitlines():
    if line.startswith('SONTRAMA_SOUNDFONTS='):
        line = 'SONTRAMA_SOUNDFONTS=' + json.dumps('/usr/share/sounds/sf2:' + root + '/data/soundfonts')
    elif line.startswith('SONTRAMA_STATE='):
        line = 'SONTRAMA_STATE=' + json.dumps(root + '/data/session.json')
    print(line.replace('/home/pi/sontrama', root))
PYENV
if [[ "${1:-}" == --print ]]; then
  cat "$service_file"
  exit 0
fi
sudo install -m 0644 "$service_file" /etc/systemd/system/sontrama.service
if [[ ! -e /etc/sontrama.env ]]; then
  sudo install -m 0644 "$environment_file" /etc/sontrama.env
fi
sudo systemctl daemon-reload
sudo systemctl enable --now sontrama.service
sudo systemctl --no-pager status sontrama.service
