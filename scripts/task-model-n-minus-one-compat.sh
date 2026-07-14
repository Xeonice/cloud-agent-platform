#!/usr/bin/env bash
#
# Real N/N-1 compatibility proof for task model selection.
#
# Boots the pinned linux/amd64 API image from the immediately preceding release
# against the current additive database schema, then drives Console REST, Public
# V1, and Streamable HTTP MCP writes. The companion Node runner proves that N-1
# silently strips both direct and nested model intent and can erase an existing
# schedule model during a full-template update. This is the executable reason the
# maintenance cutover in deploy/TASK_MODEL_SELECTION_CUTOVER.md is mandatory.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${ROOT_DIR}/apps/api/test/fixtures/task-model-n-minus-one-release.json"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
NETWORK="cap-task-model-n1-${RUN_ID}"
PG_CONTAINER="cap-task-model-n1-pg-${RUN_ID}"
API_CONTAINER="cap-task-model-n1-api-${RUN_ID}"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cap-task-model-n1.XXXXXX")"
API_LOG="${LOG_DIR}/api.log"
PG_LOG="${LOG_DIR}/postgres.log"
EVIDENCE_PATH="${TASK_MODEL_N_MINUS_ONE_EVIDENCE:-${TMPDIR:-/tmp}/cap-task-model-n1-evidence-${RUN_ID}.json}"
NETWORK_CREATED=0
PG_STARTED=0
API_STARTED=0
PASSED=0

die() {
  printf 'task-model-n-minus-one: FATAL: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    if [[ "$API_STARTED" == 1 ]]; then
      docker logs "$API_CONTAINER" >"$API_LOG" 2>&1 || true
      printf '%s\n' '------- N-1 API log -------' >&2
      tail -120 "$API_LOG" >&2 || true
    fi
    if [[ "$PG_STARTED" == 1 ]]; then
      docker logs "$PG_CONTAINER" >"$PG_LOG" 2>&1 || true
      printf '%s\n' '------- N-1 Postgres log -------' >&2
      tail -120 "$PG_LOG" >&2 || true
    fi
  fi
  if [[ "$API_STARTED" == 1 ]]; then
    docker rm -f "$API_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ "$PG_STARTED" == 1 ]]; then
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ "$NETWORK_CREATED" == 1 ]]; then
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi
  if [[ "$PASSED" == 1 ]]; then
    rm -rf -- "$LOG_DIR"
  else
    printf 'task-model-n-minus-one: diagnostics retained at %s\n' "$LOG_DIR" >&2
  fi
  return "$status"
}
trap cleanup EXIT

require_command docker
require_command node
require_command curl
require_command pnpm
[[ -f "$FIXTURE" ]] || die "release fixture not found: $FIXTURE"

RELEASE_FIELDS=()
while IFS= read -r release_field; do
  RELEASE_FIELDS+=("$release_field")
done < <(
  node -e '
    const fs = require("node:fs");
    const fixture = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const key of ["release", "image", "platform", "tagDigest", "platformDigest"]) {
      const value = fixture[key];
      if (typeof value !== "string" || value.length === 0 || value.includes("\n")) {
        process.exit(2);
      }
      process.stdout.write(`${value}\n`);
    }
  ' "$FIXTURE"
)
[[ "${#RELEASE_FIELDS[@]}" == 5 ]] || die 'invalid release fixture'
RELEASE="${RELEASE_FIELDS[0]}"
IMAGE="${RELEASE_FIELDS[1]}"
PLATFORM="${RELEASE_FIELDS[2]}"
TAG_DIGEST="${RELEASE_FIELDS[3]}"
PLATFORM_DIGEST="${RELEASE_FIELDS[4]}"
IMAGE_REF="${IMAGE}@${PLATFORM_DIGEST}"

[[ "$PLATFORM" == 'linux/amd64' ]] || die "unsupported fixture platform: $PLATFORM"
[[ "$TAG_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'invalid tag digest'
[[ "$PLATFORM_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'invalid platform digest'

printf 'task-model-n-minus-one: pulling %s (%s, tag index %s)\n' \
  "$IMAGE_REF" "$PLATFORM" "$TAG_DIGEST"

# Prove the complete source chain instead of trusting the fixture's labels:
# tagged release -> exact OCI index digest -> unique requested platform child.
TAG_MANIFEST="${LOG_DIR}/tag-manifest.json"
docker buildx imagetools inspect --raw "${IMAGE}:${RELEASE}" >"$TAG_MANIFEST"
ACTUAL_TAG_DIGEST="sha256:$(
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const bytes = fs.readFileSync(process.argv[1]);
    process.stdout.write(crypto.createHash("sha256").update(bytes).digest("hex"));
  ' "$TAG_MANIFEST"
)"
[[ "$ACTUAL_TAG_DIGEST" == "$TAG_DIGEST" ]] || \
  die "release tag digest is ${ACTUAL_TAG_DIGEST}, expected ${TAG_DIGEST}"
ACTUAL_PLATFORM_DIGEST="$(
  node -e '
    const fs = require("node:fs");
    const index = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const parts = process.argv[2].split("/");
    if (parts.length < 2 || !Array.isArray(index.manifests)) process.exit(2);
    const [os, architecture, variant] = parts;
    const matches = index.manifests.filter((entry) =>
      entry?.platform?.os === os &&
      entry?.platform?.architecture === architecture &&
      (variant === undefined || entry?.platform?.variant === variant));
    if (matches.length !== 1 ||
        !/^sha256:[a-f0-9]{64}$/.test(matches[0]?.digest ?? "")) process.exit(3);
    process.stdout.write(matches[0].digest);
  ' "$TAG_MANIFEST" "$PLATFORM"
)"
[[ "$ACTUAL_PLATFORM_DIGEST" == "$PLATFORM_DIGEST" ]] || \
  die "${PLATFORM} manifest is ${ACTUAL_PLATFORM_DIGEST}, expected ${PLATFORM_DIGEST}"

docker pull --platform "$PLATFORM" "$IMAGE_REF" >/dev/null
docker image inspect "$IMAGE_REF" >/dev/null
IMAGE_ARCH="$(docker image inspect --format '{{.Architecture}}' "$IMAGE_REF")"
IMAGE_OS="$(docker image inspect --format '{{.Os}}' "$IMAGE_REF")"
[[ "$IMAGE_ARCH" == 'amd64' ]] || die "pulled image architecture is $IMAGE_ARCH, expected amd64"
[[ "$IMAGE_OS" == 'linux' ]] || die "pulled image OS is $IMAGE_OS, expected linux"

docker network create "$NETWORK" >/dev/null
NETWORK_CREATED=1
docker run -d \
  --name "$PG_CONTAINER" \
  --network "$NETWORK" \
  --network-alias postgres \
  -p 127.0.0.1::5432 \
  -e POSTGRES_USER=cap \
  -e POSTGRES_PASSWORD=cap \
  -e POSTGRES_DB=cap \
  --health-cmd 'pg_isready -U cap -d cap' \
  --health-interval 1s \
  --health-timeout 3s \
  --health-retries 30 \
  postgres:16-alpine >/dev/null
PG_STARTED=1

for _attempt in $(seq 1 60); do
  if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$PG_CONTAINER")" == 'healthy' ]]; then
    break
  fi
  sleep 1
done
[[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$PG_CONTAINER")" == 'healthy' ]] || \
  die 'Postgres did not become healthy'

PG_PORT="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$PG_CONTAINER")"
[[ "$PG_PORT" =~ ^[0-9]+$ ]] || die 'could not resolve Postgres host port'
HOST_DATABASE_URL="postgresql://cap:cap@127.0.0.1:${PG_PORT}/cap?schema=public"
CONTAINER_DATABASE_URL='postgresql://cap:cap@postgres:5432/cap?schema=public'

printf 'task-model-n-minus-one: applying current migrations before booting %s\n' "$RELEASE"
(
  cd "${ROOT_DIR}/apps/api"
  DATABASE_URL="$HOST_DATABASE_URL" \
    pnpm exec prisma migrate deploy --schema prisma/schema.prisma
)

docker run -d \
  --name "$API_CONTAINER" \
  --network "$NETWORK" \
  --platform "$PLATFORM" \
  -p 127.0.0.1::8080 \
  -e DATABASE_URL="$CONTAINER_DATABASE_URL" \
  -e PORT=8080 \
  -e AUTH_TOKEN_LEGACY_ENABLED=false \
  -e CAP_SANDBOX_PROVIDER=control-plane \
  -e SCHEDULED_TASKS_DISABLED=1 \
  -e MAX_CONCURRENT_TASKS=1 \
  -e LOG_LEVEL=warn \
  "$IMAGE_REF" >/dev/null
API_STARTED=1
API_PORT="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$API_CONTAINER")"
[[ "$API_PORT" =~ ^[0-9]+$ ]] || die 'could not resolve N-1 API host port'
API_BASE_URL="http://127.0.0.1:${API_PORT}"

for _attempt in $(seq 1 120); do
  if ! docker inspect "$API_CONTAINER" >/dev/null 2>&1; then
    die 'N-1 API exited during bootstrap'
  fi
  if curl -fsS --max-time 2 "${API_BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 2 "${API_BASE_URL}/health" >/dev/null || \
  die 'N-1 API did not become healthy'

VERSION_RESPONSE="${LOG_DIR}/version.json"
curl -fsS --max-time 2 "${API_BASE_URL}/version" >"$VERSION_RESPONSE"
OBSERVED_RELEASE="$(
  node -e '
    const fs = require("node:fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof body.version !== "string") process.exit(2);
    process.stdout.write(body.version);
  ' "$VERSION_RESPONSE"
)"
[[ "$OBSERVED_RELEASE" == "$RELEASE" ]] || \
  die "N-1 /version reported ${OBSERVED_RELEASE}, expected ${RELEASE}"

printf 'task-model-n-minus-one: exercising real Console, V1, and MCP writers\n'
DATABASE_URL="$HOST_DATABASE_URL" \
N1_API_BASE_URL="$API_BASE_URL" \
N1_OBSERVED_RELEASE="$OBSERVED_RELEASE" \
TASK_MODEL_N_MINUS_ONE_FIXTURE="$FIXTURE" \
TASK_MODEL_N_MINUS_ONE_EVIDENCE="$EVIDENCE_PATH" \
  node "${ROOT_DIR}/apps/api/test/task-model-n-minus-one-compat.mjs"

[[ -s "$EVIDENCE_PATH" ]] || die "evidence was not written: $EVIDENCE_PATH"
PASSED=1
printf 'task-model-n-minus-one: PASSED — evidence: %s\n' "$EVIDENCE_PATH"
