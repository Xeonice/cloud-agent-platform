#!/usr/bin/env bash
#
# Isolated scheduled-task control-plane E2E.
#
# This runner deliberately avoids the normal CAP ports, databases, credentials,
# and env files. It owns one uniquely named Postgres container plus two local
# processes, and removes only those resources when it exits.
#
# Usage:
#   pnpm test:e2e:schedules:local
#
# Options:
#   KEEP_E2E_STACK=1              keep the disposable stack after the run
#   KEEP_E2E_ARTIFACTS=1          keep artifacts after a successful run
#   SCHEDULE_E2E_WALL_CLOCK=1     wait for a real minute boundary instead of
#                                 accelerating nextRunAt through the control port
#   SCHEDULE_E2E_ARTIFACT_DIR=... override the artifact root directory
#   SCHEDULE_E2E_SKIP_BUILD=1     reuse an already-built API

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALLER_DIR="$(pwd -P)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
PG_CONTAINER="cap-schedule-e2e-pg-${RUN_ID}"
ARTIFACT_ROOT_INPUT="${SCHEDULE_E2E_ARTIFACT_DIR:-${TMPDIR:-/tmp}/cap-scheduled-tasks-e2e}"
if [[ "$ARTIFACT_ROOT_INPUT" == /* ]]; then
  ARTIFACT_ROOT="$ARTIFACT_ROOT_INPUT"
else
  ARTIFACT_ROOT="${CALLER_DIR}/${ARTIFACT_ROOT_INPUT}"
fi
ARTIFACT_DIR="${ARTIFACT_ROOT%/}/${RUN_ID}"
OWNERSHIP_MARKER="${ARTIFACT_DIR}/.cap-scheduled-tasks-e2e-owned"
EMPTY_ENV_DIR="${ARTIFACT_DIR}/empty-env"
ISOLATED_HOME="${ARTIFACT_DIR}/home"
PRISMA_WORK_DIR="${ARTIFACT_DIR}/prisma-runtime"
WEB_PORT_FILE="${ARTIFACT_DIR}/web-port"
API_LOG="${ARTIFACT_DIR}/api.log"
WEB_LOG="${ARTIFACT_DIR}/web.log"
DB_LOG="${ARTIFACT_DIR}/postgres.log"
DIAGNOSTICS_FILE="${ARTIFACT_DIR}/diagnostics.json"

API_PID=""
WEB_PID=""
WEB_PORT_RESERVATION_PID=""
ARTIFACT_CREATED=0
PG_STARTED=0
API_PORT=""
WEB_PORT=""
CONTROL_PORT=""
PG_PORT=""

ADMIN_EMAIL="schedule-e2e-admin@example.test"
ADMIN_PASSWORD="ScheduleE2e-Initial-Password-01"
ADMIN_NEW_PASSWORD="ScheduleE2e-Rotated-Password-02"
TEST_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"

log() {
  printf '\n=== scheduled-tasks-e2e: %s ===\n' "$*"
}

die() {
  printf 'scheduled-tasks-e2e: FATAL: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local pid="${3:-}"
  local attempts="${4:-90}"
  local attempt

  for attempt in $(seq 1 "$attempts"); do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      printf 'scheduled-tasks-e2e: %s ready at %s\n' "$label" "$url"
      return 0
    fi
    sleep 1
  done
  return 1
}

reserve_web_port() {
  rm -f -- "$WEB_PORT_FILE"
  # JavaScript template literals belong to Node and must stay single-quoted here.
  # shellcheck disable=SC2016
  env -i \
    PATH="$PATH" \
    HOME="$ISOLATED_HOME" \
    TMPDIR="${ARTIFACT_DIR}/tmp" \
    node -e '
      const fs = require("node:fs");
      const net = require("node:net");
      const output = process.argv[1];
      const server = net.createServer();

      server.on("error", (error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exit(1);
      });
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const address = server.address();
        if (!address || typeof address === "string") process.exit(1);
        fs.writeFileSync(output, `${address.port}\n`, { mode: 0o600 });
      });
    ' "$WEB_PORT_FILE" >"${ARTIFACT_DIR}/web-port-reservation.log" 2>&1 &
  WEB_PORT_RESERVATION_PID=$!

  local attempt
  for attempt in $(seq 1 100); do
    if [[ -s "$WEB_PORT_FILE" ]]; then
      WEB_PORT="$(tr -d '[:space:]' <"$WEB_PORT_FILE")"
      [[ "$WEB_PORT" =~ ^[0-9]+$ ]] || return 1
      return 0
    fi
    if ! kill -0 "$WEB_PORT_RESERVATION_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.1
  done
  return 1
}

wait_for_api_ready() {
  local attempts="${1:-90}"
  local attempt
  local payload
  local ports

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if ! kill -0 "$API_PID" 2>/dev/null; then
      return 1
    fi
    payload="$(sed -n 's/^CAP_SCHEDULE_E2E_READY //p' "$API_LOG" | tail -1)"
    # JavaScript template literals belong to Node and must stay single-quoted here.
    # shellcheck disable=SC2016
    if [[ -n "$payload" ]] && ports="$(node -e '
      const ready = JSON.parse(process.argv[1]);
      if (!Number.isInteger(ready.apiPort) || !Number.isInteger(ready.controlPort)) {
        process.exit(1);
      }
      process.stdout.write(`${ready.apiPort} ${ready.controlPort}\n`);
    ' "$payload" 2>/dev/null)"; then
      read -r API_PORT CONTROL_PORT <<<"$ports"
      [[ "$API_PORT" =~ ^[0-9]+$ && "$CONTROL_PORT" =~ ^[0-9]+$ ]] || return 1
      return 0
    fi
    sleep 1
  done
  return 1
}

collect_failure_evidence() {
  log "collecting failure evidence"

  if ! owns_artifact_dir; then
    printf '%s\n' \
      'scheduled-tasks-e2e: no invocation-owned artifact directory is available' >&2
    return 0
  fi

  if [[ -n "$CONTROL_PORT" ]]; then
    curl -fsS --max-time 5 \
      "http://127.0.0.1:${CONTROL_PORT}/control/diagnostics" \
      >"${DIAGNOSTICS_FILE}" 2>/dev/null || true
  fi
  if [[ "$PG_STARTED" == 1 ]]; then
    docker logs "$PG_CONTAINER" >"${DB_LOG}" 2>&1 || true
    docker inspect --format \
      '{"name":{{json .Name}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}}}' \
      "$PG_CONTAINER" >"${ARTIFACT_DIR}/postgres-status.json" 2>/dev/null || true
  fi

  printf 'scheduled-tasks-e2e: failure artifacts: %s\n' "$ARTIFACT_DIR" >&2
}

freeze_live_log() {
  local log_path="$1"
  local snapshot_path="${log_path}.snapshot-${RUN_ID}"

  [[ -f "$log_path" ]] || return 0
  cp -- "$log_path" "$snapshot_path"
  rm -f -- "$log_path"
  mv -- "$snapshot_path" "$log_path"
}

freeze_retained_stack_logs() {
  owns_artifact_dir || return 1

  # API/Vite keep writing through their original file descriptors. Replacing the
  # paths with point-in-time snapshots makes the retained evidence immutable while
  # the live descriptors continue writing only to unlinked files.
  freeze_live_log "$API_LOG"
  freeze_live_log "$WEB_LOG"
}

finalize_retained_evidence() {
  local print_recent_logs="${1:-0}"

  if sanitize_artifacts; then
    if [[ "$print_recent_logs" == 1 && -s "$API_LOG" ]]; then
      printf '%s\n' '------- recent API log -------' >&2
      tail -80 "$API_LOG" >&2 || true
    fi
    if [[ "$print_recent_logs" == 1 && -s "$WEB_LOG" ]]; then
      printf '%s\n' '------- recent web log -------' >&2
      tail -50 "$WEB_LOG" >&2 || true
    fi
  else
    printf '%s\n' \
      'scheduled-tasks-e2e: sanitizer failed; refusing to print potentially sensitive logs' >&2
    discard_sensitive_artifacts || printf '%s\n' \
      'scheduled-tasks-e2e: failed to discard potentially sensitive artifacts' >&2
    return 1
  fi
}

sanitize_artifacts() {
  owns_artifact_dir || return 1
  if [[ ! -f "$ROOT_DIR/scripts/sanitize-scheduled-tasks-e2e-artifacts.mjs" ]]; then
    printf '%s\n' \
      'scheduled-tasks-e2e: artifact sanitizer is missing' >&2
    return 1
  fi
  node "$ROOT_DIR/scripts/sanitize-scheduled-tasks-e2e-artifacts.mjs" "$ARTIFACT_DIR"
}

discard_sensitive_artifacts() {
  owns_artifact_dir || return 1
  rm -rf -- \
    "$ARTIFACT_DIR/playwright" \
    "$ARTIFACT_DIR/workspaces" \
    "$API_LOG" \
    "$WEB_LOG" \
    "$DB_LOG" \
    "$DIAGNOSTICS_FILE" \
    "$ARTIFACT_DIR/postgres-status.json" \
    "$ARTIFACT_DIR/web-port-reservation.log"
}

owns_artifact_dir() {
  [[ "$ARTIFACT_CREATED" == 1 ]] &&
    [[ -f "$OWNERSHIP_MARKER" ]] &&
    [[ "$(cat "$OWNERSHIP_MARKER" 2>/dev/null)" == "$RUN_ID" ]]
}

remove_owned_artifacts() {
  local attempt
  if ! owns_artifact_dir; then
    printf 'scheduled-tasks-e2e: refusing to delete unowned artifact directory: %s\n' \
      "$ARTIFACT_DIR" >&2
    return 1
  fi
  # macOS can briefly report ENOTEMPTY while a just-exited Node process finishes
  # closing its compile-cache files. Retry only this invocation-owned directory.
  for ((attempt = 1; attempt <= 10; attempt += 1)); do
    rm -rf -- "$ARTIFACT_DIR" 2>/dev/null || true
    [[ ! -e "$ARTIFACT_DIR" ]] && return 0
    sleep 0.1
  done
  rm -rf -- "$ARTIFACT_DIR"
}

stop_process() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

print_retained_cleanup_command() {
  local has_process=0

  printf '  cleanup:'
  if [[ -n "$WEB_PID" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    printf ' kill %q' "$WEB_PID"
    has_process=1
  fi
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    printf ' kill %q' "$API_PID"
    has_process=1
  fi
  if [[ -n "$WEB_PORT_RESERVATION_PID" ]] &&
    kill -0 "$WEB_PORT_RESERVATION_PID" 2>/dev/null; then
    printf ' kill %q' "$WEB_PORT_RESERVATION_PID"
    has_process=1
  fi
  if [[ "$has_process" == 1 ]]; then
    printf ' 2>/dev/null || true;'
  fi
  if [[ "$PG_STARTED" == 1 ]]; then
    printf ' docker rm -f %q >/dev/null 2>&1 || true;' "$PG_CONTAINER"
  fi
  if [[ "$has_process" == 0 && "$PG_STARTED" != 1 ]]; then
    printf ' true'
  fi
  printf '\n'
}

cleanup() {
  local status=$?
  local retain_evidence=0
  local print_recent_logs=0
  trap - EXIT INT TERM

  if [[ "$status" != 0 ]]; then
    collect_failure_evidence || true
    retain_evidence=1
    print_recent_logs=1
  elif [[ "${KEEP_E2E_STACK:-0}" == 1 || "${KEEP_E2E_ARTIFACTS:-0}" == 1 ]]; then
    retain_evidence=1
  fi

  if [[ "${KEEP_E2E_STACK:-0}" == 1 ]]; then
    if ! freeze_retained_stack_logs ||
      ! finalize_retained_evidence "$print_recent_logs"; then
      status=1
    fi
    printf '\nscheduled-tasks-e2e: retained stack\n'
    printf '  postgres: %s (127.0.0.1:%s)\n' "$PG_CONTAINER" "$PG_PORT"
    printf '  api pid: %s (127.0.0.1:%s)\n' "${API_PID:-not-started}" "$API_PORT"
    printf '  web pid: %s (127.0.0.1:%s)\n' "${WEB_PID:-not-started}" "$WEB_PORT"
    printf '  artifacts: %s\n' "$ARTIFACT_DIR"
    print_retained_cleanup_command
    exit "$status"
  fi

  stop_process "$WEB_PID"
  stop_process "$API_PID"
  stop_process "$WEB_PORT_RESERVATION_PID"
  if [[ "$PG_STARTED" == 1 ]]; then
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi

  # Non-retained processes are stopped before the final sanitizer pass, so no
  # writer can append sensitive data after the artifacts have been declared safe.
  if [[ "$retain_evidence" == 1 ]] &&
    ! finalize_retained_evidence "$print_recent_logs"; then
    status=1
  fi

  if [[ "$status" == 0 && "${KEEP_E2E_ARTIFACTS:-0}" != 1 ]]; then
    remove_owned_artifacts || status=1
  fi
  exit "$status"
}

trap cleanup EXIT INT TERM

require_command node
require_command pnpm
require_command docker
require_command curl
require_command nohup
PNPM_RUNTIME_HOME="${PNPM_HOME:-$(dirname "$(command -v pnpm)")}"

docker info >/dev/null 2>&1 || die "Docker daemon is not reachable"

mkdir -p "$ARTIFACT_ROOT"
mkdir "$ARTIFACT_DIR" || die "artifact run directory already exists: $ARTIFACT_DIR"
printf '%s\n' "$RUN_ID" >"$OWNERSHIP_MARKER"
ARTIFACT_CREATED=1
mkdir -p \
  "$EMPTY_ENV_DIR" \
  "$ISOLATED_HOME" \
  "$PRISMA_WORK_DIR" \
  "$ARTIFACT_DIR/tmp" \
  "$ARTIFACT_DIR/workspaces" \
  "$ARTIFACT_DIR/playwright"
cp "$ROOT_DIR/apps/api/package.json" "$PRISMA_WORK_DIR/package.json"
cp -R "$ROOT_DIR/apps/api/prisma" "$PRISMA_WORK_DIR/prisma"
ln -s "$ROOT_DIR/apps/api/node_modules" "$PRISMA_WORK_DIR/node_modules"

log "starting disposable Postgres ${PG_CONTAINER} on a Docker-assigned loopback port"
docker run --detach --rm \
  --name "$PG_CONTAINER" \
  --publish "127.0.0.1::5432" \
  --env POSTGRES_USER=cap \
  --env POSTGRES_PASSWORD=cap \
  --env POSTGRES_DB=cap \
  --health-cmd 'pg_isready -U cap -d cap' \
  --health-interval 1s \
  --health-timeout 3s \
  --health-retries 30 \
  postgres:16-alpine >/dev/null
PG_STARTED=1
for _ in $(seq 1 20); do
  PG_PORT="$(docker inspect --format \
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' \
    "$PG_CONTAINER" 2>/dev/null || true)"
  [[ "$PG_PORT" =~ ^[0-9]+$ ]] && break
  sleep 0.1
done
[[ "$PG_PORT" =~ ^[0-9]+$ ]] || die "could not resolve the disposable Postgres port"
DATABASE_URL="postgresql://cap:cap@127.0.0.1:${PG_PORT}/cap?schema=public"
printf 'scheduled-tasks-e2e: Postgres bound at 127.0.0.1:%s\n' "$PG_PORT"

for _ in $(seq 1 60); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$PG_CONTAINER" 2>/dev/null || true)"
  [[ "$health" == healthy ]] && break
  sleep 1
done
[[ "${health:-}" == healthy ]] || die "disposable Postgres did not become healthy"

cd "$ROOT_DIR"
if [[ "${SCHEDULE_E2E_SKIP_BUILD:-0}" != 1 ]]; then
  log "building API workspace dependencies with an explicit environment"
  env -i \
    PATH="$PATH" \
    PNPM_HOME="$PNPM_RUNTIME_HOME" \
    HOME="$ISOLATED_HOME" \
    TMPDIR="${ARTIFACT_DIR}/tmp" \
    CI=true \
    pnpm --filter @cap/sandbox build

  log "building web workspace dependencies with an explicit environment"
  env -i \
    PATH="$PATH" \
    PNPM_HOME="$PNPM_RUNTIME_HOME" \
    HOME="$ISOLATED_HOME" \
    TMPDIR="${ARTIFACT_DIR}/tmp" \
    CI=true \
    pnpm --filter @cap/ui build

  log "generating Prisma client from the isolated schema copy"
  (
    cd "$PRISMA_WORK_DIR"
    exec env -i \
      PATH="$PATH" \
      HOME="$ISOLATED_HOME" \
      TMPDIR="${ARTIFACT_DIR}/tmp" \
      CI=true \
      NODE_ENV=test \
      DATABASE_URL="$DATABASE_URL" \
      PRISMA_HIDE_UPDATE_MESSAGE=true \
      node "$ROOT_DIR/apps/api/node_modules/prisma/build/index.js" \
        generate --schema "$PRISMA_WORK_DIR/prisma/schema.prisma"
  )

  log "building the real API without loading application env files"
  (
    cd "$ROOT_DIR/apps/api"
    exec env -i \
      PATH="$PATH" \
      HOME="$ISOLATED_HOME" \
      TMPDIR="${ARTIFACT_DIR}/tmp" \
      CI=true \
      NODE_ENV=test \
      node node_modules/@nestjs/cli/bin/nest.js build
  )
fi
[[ -f apps/api/dist/app.module.js ]] || die "apps/api/dist/app.module.js is missing; build the API first"
[[ -f packages/ui/dist/index.js ]] || die "packages/ui/dist/index.js is missing; build @cap/ui first"

log "applying Prisma migrations from the isolated schema copy"
(
  cd "$PRISMA_WORK_DIR"
  exec env -i \
    PATH="$PATH" \
    HOME="$ISOLATED_HOME" \
    TMPDIR="${ARTIFACT_DIR}/tmp" \
    CI=true \
    NODE_ENV=test \
    DATABASE_URL="$DATABASE_URL" \
    PRISMA_HIDE_UPDATE_MESSAGE=true \
    node "$ROOT_DIR/apps/api/node_modules/prisma/build/index.js" \
      migrate deploy --schema "$PRISMA_WORK_DIR/prisma/schema.prisma"
)

log "reserving the web origin until Vite is ready to bind it"
reserve_web_port || die "could not reserve a loopback port for the web console"
WEB_URL="http://127.0.0.1:${WEB_PORT}"

log "starting the real AppModule with the test-only outer provider port"
cd "$ROOT_DIR/apps/api"
nohup env -i \
  PATH="$PATH" \
  HOME="$ISOLATED_HOME" \
  TMPDIR="${ARTIFACT_DIR}/tmp" \
  TZ=UTC \
  NODE_ENV=test \
  DATABASE_URL="$DATABASE_URL" \
  E2E_API_PORT=0 \
  E2E_CONTROL_PORT=0 \
  E2E_WEB_ORIGIN="$WEB_URL" \
  WEB_ORIGIN="$WEB_URL" \
  ADMIN_EMAIL="$ADMIN_EMAIL" \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  PASSWORD_AUTH_ENABLED=true \
  AUTH_TOKEN_LEGACY_ENABLED=false \
  CODEX_CRED_ENC_KEY="$TEST_ENCRYPTION_KEY" \
  SCHEDULED_TASKS_POLL_MS=100 \
  SCHEDULED_TASKS_CLAIM_LEASE_MS=5000 \
  MAX_CONCURRENT_TASKS=2 \
  METRICS_SAMPLING_ENABLED=false \
  CAP_WORKSPACE_GIT_FALLBACK_ENABLED=true \
  WORKSPACES_DIR="$ARTIFACT_DIR/workspaces" \
  node test/scheduled-tasks-live-e2e-server.mjs \
  >"$API_LOG" 2>&1 </dev/null &
API_PID=$!
disown "$API_PID" 2>/dev/null || true
cd "$ROOT_DIR"

if ! wait_for_api_ready 90; then
  die "E2E API did not report its bound ports"
fi
API_URL="http://127.0.0.1:${API_PORT}"
CONTROL_URL="http://127.0.0.1:${CONTROL_PORT}"
if ! wait_for_url api "$API_URL/health" "$API_PID" 90; then
  die "E2E API failed to become healthy"
fi
if ! wait_for_url control "$CONTROL_URL/control/provider-calls" "$API_PID" 30; then
  die "E2E control port failed to become healthy"
fi

log "starting the real web console with an empty Vite env directory"
stop_process "$WEB_PORT_RESERVATION_PID"
WEB_PORT_RESERVATION_PID=""
cd "$ROOT_DIR/apps/web"
nohup env -i \
  PATH="$PATH" \
  HOME="$ISOLATED_HOME" \
  TMPDIR="${ARTIFACT_DIR}/tmp" \
  NODE_ENV=test \
  E2E_EMPTY_ENV_DIR="$EMPTY_ENV_DIR" \
  VITE_API_BASE_URL="$API_URL" \
  VITE_WS_URL="ws://127.0.0.1:${API_PORT}" \
  node node_modules/vite/bin/vite.js \
    --config e2e/scheduled-tasks/vite.config.ts \
    --host 127.0.0.1 \
    --port "$WEB_PORT" \
    --strictPort \
  >"$WEB_LOG" 2>&1 </dev/null &
WEB_PID=$!
disown "$WEB_PID" 2>/dev/null || true
cd "$ROOT_DIR"

if ! wait_for_url web "$WEB_URL/login" "$WEB_PID" 120; then
  die "E2E web console failed to become healthy"
fi

log "running the owner-authenticated scheduled-task browser story"
(
  cd "$ROOT_DIR/apps/web"
  E2E_API_URL="$API_URL" \
  E2E_WEB_URL="$WEB_URL" \
  E2E_CONTROL_URL="$CONTROL_URL" \
  E2E_ADMIN_EMAIL="$ADMIN_EMAIL" \
  E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  E2E_ADMIN_NEW_PASSWORD="$ADMIN_NEW_PASSWORD" \
  E2E_ARTIFACT_DIR="$ARTIFACT_DIR/playwright" \
  E2E_WALL_CLOCK="${SCHEDULE_E2E_WALL_CLOCK:-0}" \
    pnpm exec playwright test --config e2e/scheduled-tasks/playwright.config.ts
)

if [[ "${KEEP_E2E_STACK:-0}" == 1 ]]; then
  log "PASSED; retained stack evidence will be frozen and sanitized"
else
  log "PASSED; isolated processes, records, and Postgres will be removed"
fi
