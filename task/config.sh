#!/usr/bin/env bash
TASK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$TASK_DIR/.." && pwd)"
APP_DIR="$PROJECT_ROOT/sontrama"
export TASK_DIR PROJECT_ROOT APP_DIR
export PYTHON_VERSION=3.12
