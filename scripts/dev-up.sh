#!/usr/bin/env bash
# One-command local dev bring-up (local-one-click-dev): bootstrap a usable
# `apps/api/.env` when absent, then build + start the docker-compose stack and
# wait until the api is healthy. A freshly-cloned repo becomes runnable AND
# login-able with a single command — no hand-authored secrets, no GitHub OAuth.
#
#   scripts/dev-up.sh                      # full stack (incl. cap-aio-sandbox image)
#   scripts/dev-up.sh --control-plane-only # api + postgres only (skips the heavy
#                                          # amd64 sandbox image build — fast on M-series)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CONTROL_PLANE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --control-plane-only) CONTROL_PLANE_ONLY=1 ;;
    -h|--help)
      echo "usage: dev-up.sh [--control-plane-only]"
      exit 0
      ;;
    *) echo "dev-up: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Prerequisites (all already required by the repo's workflows).
for bin in docker openssl curl awk; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "dev-up: required tool '$bin' not found on PATH" >&2
    exit 1
  }
done

ENV_FILE="apps/api/.env"
ENV_EXAMPLE="apps/api/.env.example"
if [ -e "$ENV_FILE" ]; then
  echo "dev-up: $ENV_FILE exists — reusing it as-is."
else
  echo "dev-up: bootstrapping $ENV_FILE (generated secrets + legacy-token auth)…"
  "$SCRIPT_DIR/gen-local-env.sh" "$ENV_EXAMPLE" "$ENV_FILE"
fi

if [ "$CONTROL_PLANE_ONLY" -eq 1 ]; then
  echo "dev-up: building + starting CONTROL PLANE only (api + postgres)…"
  docker compose up -d --build api postgres
else
  echo "dev-up: building + starting the FULL stack (incl. the cap-aio-sandbox:pinned image)…"
  echo "        first build on Apple Silicon emulates the amd64 AIO base — slow, then cached."
  docker compose up -d --build
fi

PORT="${PORT:-8080}"
HEALTH="http://localhost:${PORT}/health"
echo "dev-up: waiting for api /health at ${HEALTH} …"
deadline=$(( $(date +%s) + 120 ))
until curl -fsS "$HEALTH" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "dev-up: api did not become healthy within 120s — inspect: docker compose logs api" >&2
    exit 1
  fi
  sleep 2
done

TOKEN="$(awk -F= '/^AUTH_TOKEN=/{print $2; exit}' "$ENV_FILE")"
cat <<EOF

✅ Local stack ready.
   API:   http://localhost:${PORT}    (/health is open; every other route needs the token)
   Auth:  Authorization: Bearer ${TOKEN}
          curl -H "Authorization: Bearer ${TOKEN}" http://localhost:${PORT}/tasks

   Notes:
   • cap-aio-sandbox:pinned is BUILD-ONLY here — a cap-aio-<taskId> sandbox is
     provisioned per task when you create one (not a standing container).
   • The web console is NOT in compose; run it separately (apps/web: pnpm dev),
     pointed at this API via NEXT_PUBLIC_API_BASE_URL / NEXT_PUBLIC_WS_URL.
   • Tear down: scripts/dev-down.sh   (add -v to also drop the db/workspaces volumes)
EOF
