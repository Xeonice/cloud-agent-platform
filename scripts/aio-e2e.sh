#!/usr/bin/env bash
#
# One-shot orchestrator for the AIO-sandbox compose e2e suite
# (apps/api/test/aio-e2e.mjs).
#
# The live AIO execution path can only be exercised in the compose self-host
# topology: the orchestrator must run INSIDE the api container, on cap-net, with
# the host docker.sock mounted, so it can dockerode-provision sibling
# cap-aio-<taskId> containers and dial them by name. This script builds the two
# images, brings the stack up, runs the black-box suite as an external operator
# over the published :8080, and always tears the stack down again.
#
# Usage:
#   scripts/aio-e2e.sh
# Env overrides:
#   AIO_SANDBOX_IMAGE   derived AIO image tag to build/use (default cap-aio-sandbox:e2e)
#   AIO_BASE_TAG        ghcr.io/agent-infra/sandbox base tag the derived image is FROM.
#                       If unset, any locally present sandbox image is retagged and
#                       used (offline build); otherwise the pinned default is pulled.
#   AUTH_TOKEN          operator bearer token (default: value from apps/api/.env,
#                       falling back to dev-local-operator-token-change-me)
#   API                 api base URL the suite drives (default http://127.0.0.1:8080)
set -euo pipefail
cd "$(dirname "$0")/.."

AIO_IMAGE="${AIO_SANDBOX_IMAGE:-cap-aio-sandbox:e2e}"
if [ -z "${AUTH_TOKEN:-}" ] && [ -f apps/api/.env ]; then
  AUTH_TOKEN="$(node --env-file=apps/api/.env -p 'process.env.AUTH_TOKEN || ""' 2>/dev/null || true)"
fi
AUTH_TOKEN="${AUTH_TOKEN:-dev-local-operator-token-change-me}"
API="${API:-http://127.0.0.1:8080}"
PINNED_DEFAULT="1.0.0.125"

log() { printf '\n=== %s ===\n' "$*"; }

# 1. Derived AIO image — build if absent. The Dockerfile is FROM
#    ghcr.io/agent-infra/sandbox:<AIO_BASE_TAG>. If that tag is not pullable here
#    (common offline / behind-proxy), retag any locally present sandbox image so
#    the build works without a network round trip.
if ! docker image inspect "$AIO_IMAGE" >/dev/null 2>&1; then
  base_tag="${AIO_BASE_TAG:-}"
  if [ -z "$base_tag" ]; then
    local_base="$(docker images --format '{{.Repository}}:{{.Tag}}' \
      | grep '^ghcr.io/agent-infra/sandbox:' | grep -v '<none>' | head -1 || true)"
    if [ -n "$local_base" ]; then
      base_tag="e2e-base"
      docker tag "$local_base" "ghcr.io/agent-infra/sandbox:${base_tag}"
      log "offline build: retagged local base $local_base -> ghcr.io/agent-infra/sandbox:${base_tag}"
    else
      base_tag="$PINNED_DEFAULT"
      log "no local AIO base image; will pull ghcr.io/agent-infra/sandbox:${base_tag}"
    fi
  fi
  log "building derived AIO image $AIO_IMAGE (FROM sandbox:${base_tag})"
  docker build -f docker/aio-sandbox.Dockerfile --build-arg AIO_SANDBOX_TAG="$base_tag" -t "$AIO_IMAGE" .
else
  log "derived AIO image $AIO_IMAGE already present"
fi

# 2. Always tear the stack down (and reap any leftover per-task sandboxes).
cleanup() {
  log "teardown: compose down + reap sandbox containers"
  AIO_SANDBOX_IMAGE="$AIO_IMAGE" docker compose down -v >/dev/null 2>&1 || true
  docker ps -aq --filter 'name=cap-aio-' | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 3. Bring the stack up (builds the api image too).
log "starting compose stack (postgres + api on cap-net, docker.sock mounted)"
AIO_SANDBOX_IMAGE="$AIO_IMAGE" AUTH_TOKEN="$AUTH_TOKEN" docker compose up -d --build

# 4. Wait for the api to migrate + boot.
log "waiting for api health at $API"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS -m 3 "$API/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" != 1 ]; then
  echo "api never became healthy; recent logs:"
  docker compose logs api 2>&1 | tail -40
  exit 1
fi
echo "api healthy"

# 5. Run the black-box suite against the live stack.
#    Scenarios: (C) exec-injection, (D) write-lock, (F) reconnect replay,
#    (G) clone success, (H) forced clone failure, (E) codex CPR start.
#    TASK_REPO_URL (optional): forwarded so the api container uses it for
#    provision-time git clone; tests G/H work with or without it.
log "running aio-e2e suite"
AUTH_TOKEN="$AUTH_TOKEN" API="$API" \
  node --test --test-force-exit apps/api/test/aio-e2e.mjs
