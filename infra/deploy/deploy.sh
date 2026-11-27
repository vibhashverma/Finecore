#!/usr/bin/env bash
# Deploy a released image tag to this VM (called by the CD workflow over SSH, or by hand).
#   ./infra/deploy/deploy.sh <env: staging|production> <image tag, e.g. v1.2.0>
# Steps: pull signed images → run migrations (forward-only) → rolling restart → smoke test → on failure, roll back
# to the previously deployed tag automatically. The DB is never rolled back automatically (forward-only migrations).
set -euo pipefail
env="${1:?staging|production}"
tag="${2:?image tag}"
cd /opt/fincore
envfile="/etc/fincore/$env.env"
compose=(docker compose --env-file "$envfile" -f compose.yaml -f infra/compose/compose.prod.yaml)
prev="$(cat ".deployed-$env" 2>/dev/null || echo "")"

echo "== deploying $tag to $env (previous: ${prev:-none})"
export IMAGE_TAG="$tag"
# Prometheus does not expand env vars: render the uptime-check target for this environment.
SITE_ADDRESS="$(grep -E '^SITE_ADDRESS=' "$envfile" | cut -d= -f2)" envsubst < infra/monitoring/prometheus.yml > infra/monitoring/prometheus.rendered.yml
"${compose[@]}" pull api workers web analytics
"${compose[@]}" up -d --no-build --wait --wait-timeout 180

smoke() {
  local base="https://$(grep -E '^SITE_ADDRESS=' "$envfile" | cut -d= -f2)"
  curl -fsS "$base/" | grep -q "SIMULATED FUNDS" &&
  test "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/v1/me")" = "401" &&
  test "$(curl -s -o /dev/null -w '%{http_code}' "$base/metrics")" = "404" &&
  "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U fincore_api -d fincore -f - < scripts/invariant-check.sql >/dev/null
}

if smoke; then
  echo "$tag" > ".deployed-$env"
  echo "== $env now on $tag (smoke OK)"
else
  echo "!! smoke test failed on $tag"
  if [[ -n "$prev" ]]; then
    echo "== rolling back to $prev"
    export IMAGE_TAG="$prev"
    "${compose[@]}" up -d --no-build --wait --wait-timeout 180
  fi
  exit 1
fi
