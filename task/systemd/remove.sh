#!/usr/bin/env bash
set -euo pipefail
sudo systemctl disable --now sontrama.service
sudo rm -f /etc/systemd/system/sontrama.service
sudo systemctl daemon-reload
echo 'Service removed. Application data and /etc/sontrama.env preserved.'
