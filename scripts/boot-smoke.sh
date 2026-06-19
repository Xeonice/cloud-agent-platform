#!/usr/bin/env bash
#
# Boot-smoke: start the BUILT @cap/api orchestrator against a throwaway Postgres
# and prove it reaches a healthy boot by probing the unauthenticated `/health`
# liveness endpoint.
#
# WHY this exists (api-key-machine-identity design D6 / monorepo-foundation spec
# "CI boots the built application and probes liveness", gap G5): the cross-
# provider dependency-injection / onApplicationBootstrap ordering failure class
# manifests ONLY at DI-graph instantiation / bootstrap — neither `turbo build`
# nor the unit suite catches it. A prior DI-ordering defect reached production and
# caused a multi-hour outage. This script is the single highest-leverage guard
# against re-occurrence: it actually instantiates the whole AppModule graph and
# fails loudly if the app cannot serve `/health`.
#
# It runs the SAME boot the container CMD runs (`prisma migrate deploy` then
# `node dist/main.js`), so a migration or DI break fails here exactly as it would
# in production — not a mock.
#
# CONTRACT
#   - Requires a built app: `apps/api/dist/main.js` and a generated Prisma client
#     (run `pnpm turbo build` first; the CI job does).
#   - Requires DATABASE_URL pointing at a reachable, throwaway Postgres.
#   - Boots OAuth-FIRST (legacy operator-token path OFF), so NO AUTH_TOKEN is
#     needed — the app boots on its DB alone, which is all `/health` exercises.
#
# Usage:
#   scripts/boot-smoke.sh
# Env overrides:
#   DATABASE_URL        Postgres connection string (REQUIRED).
#   BOOT_SMOKE_PORT     port the app listens on (default 8080).
#   BOOT_SMOKE_TIMEOUT  seconds to wait for `/health` to go healthy (default 60).
#
# Exit status: 0 only when `/health` returns a 2xx within the timeout; non-zero
# (and the captured app log dumped to stderr) on any migration, bootstrap, DI, or
# liveness failure — the signal CI gates on.

set -euo pipefail

PORT="${BOOT_SMOKE_PORT:-8080}"
TIMEOUT="${BOOT_SMOKE_TIMEOUT:-60}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "boot-smoke: FATAL — DATABASE_URL is unset; a throwaway Postgres is required." >&2
  exit 2
fi

# Resolve the @cap/api package dir relative to this script so the smoke runs from
# any CWD (CI checks out at the repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="${SCRIPT_DIR}/../apps/api"

if [[ ! -f "${API_DIR}/dist/main.js" ]]; then
  echo "boot-smoke: FATAL — ${API_DIR}/dist/main.js not found; build the app first (pnpm turbo build)." >&2
  exit 2
fi

LOG_FILE="$(mktemp -t boot-smoke.XXXXXX.log)"
APP_PID=""

cleanup() {
  if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT

# Dump the captured app log to stderr so CI shows WHY the boot failed (DI error,
# migration failure, port bind, etc.) instead of a bare timeout.
fail() {
  echo "boot-smoke: FAILED — $1" >&2
  echo "------- captured app log -------" >&2
  cat "${LOG_FILE}" >&2 || true
  echo "--------------------------------" >&2
  exit 1
}

cd "${API_DIR}"

# 1) Apply migrations exactly as the container CMD does, against the throwaway DB.
echo "boot-smoke: applying migrations (prisma migrate deploy)..."
if ! node node_modules/prisma/build/index.js migrate deploy >>"${LOG_FILE}" 2>&1; then
  fail "prisma migrate deploy failed"
fi

# 2) Boot the BUILT app. OAuth-first: legacy token path OFF so no AUTH_TOKEN is
#    required; PORT pins the listen port we probe below.
echo "boot-smoke: starting node dist/main.js on :${PORT}..."
PORT="${PORT}" AUTH_TOKEN_LEGACY_ENABLED="" node dist/main.js >>"${LOG_FILE}" 2>&1 &
APP_PID=$!

# 3) Probe `/health` until healthy or the timeout elapses. The process dying early
#    (a DI / bootstrap error → non-zero exit) is detected immediately, not waited
#    out, so the smoke fails fast on the failure class it exists to catch.
HEALTH_URL="http://127.0.0.1:${PORT}/health"
DEADLINE=$(( $(date +%s) + TIMEOUT ))
while true; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    fail "app process exited before serving /health (bootstrap/DI error)"
  fi
  if curl -fsS --max-time 2 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "boot-smoke: PASSED — ${HEALTH_URL} is healthy."
    exit 0
  fi
  if (( $(date +%s) >= DEADLINE )); then
    fail "timed out after ${TIMEOUT}s waiting for ${HEALTH_URL}"
  fi
  sleep 1
done
