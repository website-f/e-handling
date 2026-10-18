#!/usr/bin/env bash
# Run from the repo root on the dev machine: ships the source to /opt/e-handling and rebuilds there.
# The VPS keeps its own .env (never overwritten) and its Postgres volume.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${VPS_HOST:-root@84.46.249.133}"
KEY="${VPS_KEY:-$HOME/.ssh/vps_rizqmall}"
DIR="${VPS_DIR:-/opt/e-handling}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=20 "$HOST")

echo "==> shipping source to $HOST:$DIR"
tar --exclude='./.git' --exclude='./.env' --exclude='*/node_modules' --exclude='./frontend/dist' --exclude='*.exe' \
  -czf - . | "${SSH[@]}" "mkdir -p '$DIR' && tar -xzf - -C '$DIR' && chmod +x '$DIR'/deploy/*.sh"

echo "==> remote build"
"${SSH[@]}" "'$DIR'/deploy/remote-up.sh"
