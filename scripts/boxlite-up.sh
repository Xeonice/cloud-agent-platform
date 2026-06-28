#!/usr/bin/env bash
# Validate and write local-dev BoxLite provider env.
#
# This helper implements the macOS default BoxLite path as a validated endpoint
# path. CAP does not vendor a BoxLite daemon/image yet, so the operator supplies
# BOXLITE_ENDPOINT / BOXLITE_API_TOKEN / BOXLITE_IMAGE via the environment or an
# existing env file. The helper writes safe defaults for the remaining provider
# knobs without overwriting existing values, then verifies the endpoint is
# reachable before dev-up reports the stack as sandbox-ready.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/apps/api/.env"
CHECK_ONLY=0

usage() {
  cat <<'EOF'
usage: boxlite-up.sh [--env-file <path>] [--check-only]

Required, in env or env file:
  BOXLITE_ENDPOINT
  BOXLITE_API_TOKEN
  BOXLITE_IMAGE

Optional:
  BOXLITE_HEALTH_PATH   readiness path, default /health
  BOXLITE_SKIP_HEALTHCHECK=1
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?--env-file requires a path}"
      shift 2
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "boxlite-up: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

env_get_file() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  awk -F= -v k="$key" '$1 == k { print substr($0, length(k) + 2); exit }' "$file"
}

env_get() {
  local key="$1" from_process from_file
  from_process="${!key-}"
  if [ -n "$from_process" ]; then
    printf '%s\n' "$from_process"
    return 0
  fi
  from_file="$(env_get_file "$key" "$ENV_FILE")"
  if [ -n "$from_file" ]; then
    printf '%s\n' "$from_file"
  fi
}

env_has_file_key() {
  local key="$1" file="$2"
  [ -f "$file" ] && awk -F= -v k="$key" '$1 == k { found = 1 } END { exit found ? 0 : 1 }' "$file"
}

set_if_missing() {
  local key="$1" value="$2"
  [ "$CHECK_ONLY" -eq 1 ] && return 0
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  if ! env_has_file_key "$key" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
    echo "boxlite-up: set $key in $ENV_FILE"
  fi
}

require_key() {
  local key="$1" value
  value="$(env_get "$key")"
  if [ -z "$value" ]; then
    cat >&2 <<EOF
boxlite-up: $key is required for the BoxLite startup path.

Set these before running \`make up\` on macOS:
  BOXLITE_ENDPOINT=http://127.0.0.1:7331
  BOXLITE_API_TOKEN=<token>
  BOXLITE_IMAGE=<boxlite-image>

CAP does not yet vendor a BoxLite daemon/image. This startup path validates an
operator-supplied BoxLite endpoint and fails closed when it is absent.
EOF
    exit 1
  fi
  printf '%s\n' "$value"
}

ENDPOINT="$(require_key BOXLITE_ENDPOINT)"
TOKEN="$(require_key BOXLITE_API_TOKEN)"
IMAGE="$(require_key BOXLITE_IMAGE)"

set_if_missing CAP_SANDBOX_PROVIDER boxlite
set_if_missing BOXLITE_ENDPOINT "$ENDPOINT"
set_if_missing BOXLITE_API_TOKEN "$TOKEN"
set_if_missing BOXLITE_IMAGE "$IMAGE"
set_if_missing BOXLITE_PROVIDER_ID boxlite
set_if_missing BOXLITE_PROVIDER_PRIORITY 100
set_if_missing BOXLITE_PROVIDER_LOCATION local
set_if_missing BOXLITE_WORKSPACE_PATH /home/gem/workspace
set_if_missing BOXLITE_SANDBOX_ID_PREFIX cap-boxlite-
set_if_missing BOXLITE_SANDBOX_MODE workspace-write
set_if_missing BOXLITE_CLIENT_MODE rest
set_if_missing BOXLITE_TIMEOUT_MS 30000
set_if_missing BOXLITE_TERMINAL_MODE pty
set_if_missing BOXLITE_CAPABILITIES terminal.websocket,terminal.interactive,command.exec,workspace.git.materialize,workspace.git.deliver,workspace.archive.transfer,lifecycle.readopt,lifecycle.readoption
set_if_missing BOXLITE_HEALTH_PATH /health

if [ "${BOXLITE_SKIP_HEALTHCHECK:-}" = "1" ]; then
  echo "boxlite-up: BOXLITE_SKIP_HEALTHCHECK=1 — endpoint probe skipped"
  exit 0
fi

HEALTH_PATH="$(env_get BOXLITE_HEALTH_PATH)"
HEALTH_PATH="${HEALTH_PATH:-/health}"
case "$HEALTH_PATH" in
  /*) ;;
  *) HEALTH_PATH="/$HEALTH_PATH" ;;
esac
HEALTH_URL="${ENDPOINT%/}${HEALTH_PATH}"

if ! command -v curl >/dev/null 2>&1; then
  echo "boxlite-up: curl is required to verify BoxLite readiness" >&2
  exit 1
fi

echo "boxlite-up: checking BoxLite readiness at $HEALTH_URL"
if ! curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "$HEALTH_URL" >/dev/null; then
  cat >&2 <<EOF
boxlite-up: BoxLite endpoint is not reachable: $HEALTH_URL

Start your BoxLite control plane or set BOXLITE_ENDPOINT / BOXLITE_HEALTH_PATH
to a reachable endpoint, then re-run. The macOS default does not fall back to a
sandboxless control plane.
EOF
  exit 1
fi

echo "boxlite-up: BoxLite endpoint ready; provider env is present in $ENV_FILE"
