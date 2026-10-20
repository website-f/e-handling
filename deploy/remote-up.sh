#!/usr/bin/env bash
# Runs ON the VPS inside /opt/e-handling. Idempotent: safe to re-run on every deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.vps.yml)

if [[ ! -f .env ]]; then
  echo "==> creating .env with fresh secrets"
  cp .env.vps.example .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^ADMIN_API_KEY=.*|ADMIN_API_KEY=eh_$(openssl rand -hex 24)|" .env
  sed -i "s|^IP_HASH_SALT=.*|IP_HASH_SALT=$(openssl rand -hex 24)|" .env
  chmod 600 .env
fi
# Keys added after first deploy: append with a default, never overwrite what is there.
[[ -z "$(tail -c1 .env)" ]] || echo >> .env
ensure_key() { grep -q "^$1=" .env || echo "$1=$2" >> .env; }
ensure_key VOTER_SOURCE demo
ensure_key SPR_REQUIRE_CANDIDATE_PHASE true
ensure_key SPR_MAX_CONCURRENT_PAGES 3
if ! grep -q '^SPR_INTERNAL_TOKEN=.' .env; then
  sed -i '/^SPR_INTERNAL_TOKEN=/d' .env
  echo "SPR_INTERNAL_TOKEN=$(openssl rand -hex 24)" >> .env
fi
set -a; . ./.env; set +a

echo "==> building and starting"
"${COMPOSE[@]}" up -d --build --remove-orphans

echo "==> waiting for health"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-8800}/api/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-8800}/api/health"; echo
    "${COMPOSE[@]}" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
    echo "Deployed e-handling on 127.0.0.1:${GATEWAY_PORT:-8800}"
    exit 0
  fi
  sleep 2
done
echo "FAILED: gateway not healthy" >&2
"${COMPOSE[@]}" logs --tail=60 >&2
exit 1
