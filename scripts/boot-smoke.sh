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
# ALSO exercises the default-admin SEED + ARGON2 path (add-private-account-identity
# task 10.3): it boots with `ADMIN_EMAIL` set so the `AdminSeedService` boot hook
# actually runs (it argon2-HASHES a generated password and writes the admin +
# password IdentityLink), then probes the one-time `POST /auth/admin/reveal`. A
# non-empty reveal proves the seed completed AND argon2 produced a hash — so a
# MISSING/incompatible `@node-rs/argon2` native binary, or a broken seed, fails CI
# HERE rather than silently in production (the seed itself swallows its own errors
# to never crash boot, so /health alone would NOT catch a broken seed — this probe
# does).
#
# Usage:
#   scripts/boot-smoke.sh
# Env overrides:
#   DATABASE_URL        Postgres connection string (REQUIRED).
#   BOOT_SMOKE_PORT     port the app listens on (default 8080).
#   BOOT_SMOKE_TIMEOUT  seconds to wait for `/health` to go healthy (default 60).
#   BOOT_SMOKE_ADMIN_EMAIL  email the seed keys the default admin on
#                           (default boot-smoke-admin@example.com). The throwaway
#                           DB is wiped with the runner, so this is inert.
#
# Exit status: 0 only when `/health` returns a 2xx AND the seed/argon2 reveal
# succeeds within the timeout; non-zero (and the captured app log dumped to
# stderr) on any migration, bootstrap, DI, liveness, or seed/argon2 failure — the
# signal CI gates on.

set -euo pipefail

PORT="${BOOT_SMOKE_PORT:-8080}"
TIMEOUT="${BOOT_SMOKE_TIMEOUT:-60}"
# Keying email for the default-admin seed exercised below. Throwaway-DB only.
ADMIN_EMAIL_FOR_SMOKE="${BOOT_SMOKE_ADMIN_EMAIL:-boot-smoke-admin@example.com}"
# The console origin the smoke boots with, so the trusted-origin allow-list is
# non-empty and the WebSocket handshake probe has both a trusted and an
# untrusted case to exercise.
SMOKE_WEB_ORIGIN="${BOOT_SMOKE_WEB_ORIGIN:-https://console.boot-smoke.example}"

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
#    required; PORT pins the listen port we probe below. ADMIN_EMAIL is set so the
#    default-admin seed (argon2 hash + admin/IdentityLink write) actually RUNS —
#    it is skipped when ADMIN_EMAIL is unset.
echo "boot-smoke: starting node dist/main.js on :${PORT}..."
# WEB_ORIGIN is set so the trusted-origin allow-list is NON-EMPTY, which is what
# the WebSocket handshake probe in step 5 exercises. It also matches the
# cross-origin shape the origin checks exist for.
PORT="${PORT}" AUTH_TOKEN_LEGACY_ENABLED="" ADMIN_EMAIL="${ADMIN_EMAIL_FOR_SMOKE}" \
  WEB_ORIGIN="${SMOKE_WEB_ORIGIN}" \
  node dist/main.js >>"${LOG_FILE}" 2>&1 &
APP_PID=$!

# 3) Probe `/health` until healthy or the timeout elapses. The process dying early
#    (a DI / bootstrap error → non-zero exit) is detected immediately, not waited
#    out, so the smoke fails fast on the failure class it exists to catch.
HEALTH_URL="http://127.0.0.1:${PORT}/health"
REVEAL_URL="http://127.0.0.1:${PORT}/auth/admin/reveal"
DEADLINE=$(( $(date +%s) + TIMEOUT ))
while true; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    fail "app process exited before serving /health (bootstrap/DI error)"
  fi
  if curl -fsS --max-time 2 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "boot-smoke: /health healthy — verifying default-admin seed + argon2..."
    break
  fi
  if (( $(date +%s) >= DEADLINE )); then
    fail "timed out after ${TIMEOUT}s waiting for ${HEALTH_URL}"
  fi
  sleep 1
done

# 4) Seed + argon2 probe: the one-time admin reveal returns the GENERATED
#    credential exactly once. A non-empty `email` in the response proves the seed
#    wrote the admin AND argon2 hashed its password (the plaintext is only held
#    when the hash succeeded). The seed swallows its own errors so it never crashes
#    boot — so this probe, not /health, is what catches a broken seed or a
#    missing/incompatible @node-rs/argon2 native binary.
REVEAL_BODY="$(curl -fsS --max-time 5 -X POST -H 'content-type: application/json' \
  "${REVEAL_URL}" 2>>"${LOG_FILE}" || true)"
case "${REVEAL_BODY}" in
  *'"email"'*)
    echo "boot-smoke: default-admin seed + argon2 reveal succeeded."
    ;;
  *)
    fail "default-admin seed/argon2 reveal did not return a credential (got: ${REVEAL_BODY:-<empty>}); a broken seed or missing @node-rs/argon2 native binary"
    ;;
esac

# 5) WebSocket handshake origin probe. Browsers do NOT apply the same-origin
#    policy to WebSocket connections and the HTTP CORS allow-list does not cover
#    them, so without a handshake check any page could open a terminal socket
#    with the operator's cookie attached. This needs a REAL upgrade against the
#    booted server — the unit suite can prove the decision, only this proves the
#    adapter is actually wired into the running app.
WS_URL="http://127.0.0.1:${PORT}/terminal"
ws_handshake_status() {
  # Prints the numeric status of the upgrade response. `--http1.1` because an
  # upgrade is HTTP/1.1-only; the key is fixed since we never read a frame.
  curl -sS -o /dev/null -D - --max-time 5 --http1.1 \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==' \
    -H "Origin: $1" \
    "${WS_URL}" 2>>"${LOG_FILE}" \
    | awk 'toupper($0) ~ /^HTTP\// { code = $2 } END { print code }'
}

FOREIGN_STATUS="$(ws_handshake_status 'https://evil.example')"
if [ "${FOREIGN_STATUS}" != "403" ]; then
  fail "WebSocket handshake from an untrusted origin was NOT refused (status: ${FOREIGN_STATUS:-<none>}); expected 403"
fi
echo "boot-smoke: cross-origin WebSocket handshake refused (403)."

TRUSTED_STATUS="$(ws_handshake_status "${SMOKE_WEB_ORIGIN}")"
if [ "${TRUSTED_STATUS}" != "101" ]; then
  fail "WebSocket handshake from the configured console origin did NOT complete (status: ${TRUSTED_STATUS:-<none>}); expected 101"
fi
echo "boot-smoke: console-origin WebSocket handshake completed (101)."

echo "boot-smoke: PASSED — /health healthy, default-admin seed + argon2 reveal succeeded, and the WebSocket handshake is origin-checked."
exit 0
