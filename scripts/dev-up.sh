#!/usr/bin/env bash
# One-command local dev bring-up (local-one-click-dev): bootstrap a usable
# `apps/api/.env` when absent, then build + start the docker-compose stack and
# wait until the api is healthy. A freshly-cloned repo becomes runnable AND
# login-able with a single command — no hand-authored secrets, no GitHub OAuth.
#
#   scripts/dev-up.sh                      # auto: macOS -> BoxLite, Linux -> AIO
#   scripts/dev-up.sh --aio                # force full AIO stack
#   scripts/dev-up.sh --boxlite            # force BoxLite endpoint-backed stack
#   scripts/dev-up.sh --control-plane-only # api + postgres only, no sandbox provider
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PROVIDER_CLI=""
for arg in "$@"; do
  case "$arg" in
    --provider=*) PROVIDER_CLI="${arg#--provider=}" ;;
    --aio) PROVIDER_CLI="aio" ;;
    --boxlite) PROVIDER_CLI="boxlite" ;;
    --control-plane-only) PROVIDER_CLI="control-plane" ;;
    -h|--help)
      echo "usage: dev-up.sh [--provider auto|aio|boxlite|control-plane] [--aio] [--boxlite] [--control-plane-only]"
      exit 0
      ;;
    *) echo "dev-up: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

. "$SCRIPT_DIR/sandbox-provider-selection.sh"

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

env_file_value_from() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  awk -F= -v k="$key" '$1 == k { print substr($0, length(k) + 2); exit }' "$file" 2>/dev/null || true
}

env_file_value() {
  env_file_value_from "$ENV_FILE" "$1"
}

compose_env_value() {
  env_file_value_from ".env" "$1"
}

set_env_if_missing() {
  local key="$1" value="$2"
  if ! awk -F= -v k="$key" '$1 == k { found = 1 } END { exit found ? 0 : 1 }' "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
    echo "dev-up: set $key=$value in $ENV_FILE"
  fi
}

REQUESTED_PROVIDER="${PROVIDER_CLI:-${CAP_SANDBOX_PROVIDER:-}}"
if [ -z "$REQUESTED_PROVIDER" ]; then
  REQUESTED_PROVIDER="$(env_file_value CAP_SANDBOX_PROVIDER)"
  if [ -n "$REQUESTED_PROVIDER" ]; then
    echo "dev-up: using CAP_SANDBOX_PROVIDER=$REQUESTED_PROVIDER from existing $ENV_FILE."
  fi
fi
REQUESTED_PROVIDER="${REQUESTED_PROVIDER:-auto}"
SELECTED_PROVIDER="$(cap_provider_resolve "$REQUESTED_PROVIDER")"
echo "dev-up: selected sandbox provider: $SELECTED_PROVIDER (requested: $REQUESTED_PROVIDER)"

case "$SELECTED_PROVIDER" in
  control-plane)
    set_env_if_missing CAP_SANDBOX_PROVIDER control-plane
    echo "dev-up: building + starting CONTROL PLANE only (api + postgres)…"
    docker compose up -d --build api postgres
    ;;
  boxlite)
    echo "dev-up: validating BoxLite provider configuration…"
    "$SCRIPT_DIR/boxlite-up.sh" --env-file "$ENV_FILE"
    echo "dev-up: building + starting BoxLite-backed control plane (api + postgres)…"
    docker compose up -d --build api postgres
    ;;
  aio)
    set_env_if_missing CAP_SANDBOX_PROVIDER aio
    echo "dev-up: building + starting the AIO-backed FULL stack (incl. cap-aio-sandbox:pinned image)…"
    echo "        Linux auto mode uses AIO. On macOS use CAP_SANDBOX_PROVIDER=boxlite or make up-boxlite."
    docker compose up -d --build
    ;;
  *)
    echo "dev-up: internal error: unsupported provider '$SELECTED_PROVIDER'" >&2
    exit 2
    ;;
esac

API_HOST_PORT="${API_HOST_PORT:-$(compose_env_value API_HOST_PORT)}"
API_HOST_PORT="${API_HOST_PORT:-8080}"
API_HOST_BIND="${API_HOST_BIND:-$(compose_env_value API_HOST_BIND)}"
API_HOST_BIND="${API_HOST_BIND:-0.0.0.0}"
WEB_HOST_PORT="${WEB_HOST_PORT:-$(compose_env_value WEB_HOST_PORT)}"
WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
WEB_HOST_BIND="${WEB_HOST_BIND:-$(compose_env_value WEB_HOST_BIND)}"
WEB_HOST_BIND="${WEB_HOST_BIND:-0.0.0.0}"
HEALTH="http://127.0.0.1:${API_HOST_PORT}/health"
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
   Provider: ${SELECTED_PROVIDER}
   API:   http://127.0.0.1:${API_HOST_PORT}    (/health is open; every other route needs the token)
          listening on ${API_HOST_BIND}:${API_HOST_PORT} by default; public DNS/TLS/proxy/firewall are yours to configure
   Auth:  Authorization: Bearer ${TOKEN}
          curl -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:${API_HOST_PORT}/tasks

   Notes:
   • AIO mode: cap-aio-sandbox:pinned is BUILD-ONLY here — a cap-aio-<taskId> sandbox is
     provisioned per task when you create one (not a standing container).
   • BoxLite mode: the API uses the validated BOXLITE_* endpoint from ${ENV_FILE}.
   • The web console ships in compose behind the \`web\` profile (off by default
     here); enable it with COMPOSE_PROFILES=web (bind default ${WEB_HOST_BIND}:${WEB_HOST_PORT}), or run it standalone
     (apps/web: pnpm dev) pointed at this API via VITE_API_BASE_URL / VITE_WS_URL.
   • Tear down: scripts/dev-down.sh   (add -v to also drop the db/workspaces volumes)
EOF
