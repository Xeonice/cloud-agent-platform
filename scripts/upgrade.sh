#!/usr/bin/env bash
#
# upgrade.sh — the ONE manual production-upgrade path for the cloud-agent-platform
# resident stack. It FORCES both same-versioned images together (cap-api AND
# cap-aio-sandbox) so a hand upgrade can NEVER stage only the api and leave the
# per-task sandbox image missing (add-release-upgrade-scripts, design D1/D2/D5).
#
# WHY this exists: the in-app one-click self-update already pulls the
# `aio-sandbox-image` pull-only stager alongside api. The manual path did NOT —
# running only `docker compose pull api` on the v0.20.0 deploy left
# `cap-aio-sandbox:v0.20.0` unstaged, so every new task's sandbox provision hit
# `(HTTP 404) No such image` and force-failed. This script removes that footgun:
# there is NO single-service door — `pull` and `up -d` ALWAYS cover BOTH services.
#
# It mirrors self-update.service.ts's CAP_SERVICES / PULL_ONLY_CAP_SERVICES (prod
# runs no `web`, so the set is `api aio-sandbox-image`). If the cap topology ever
# changes, this list and self-update must move together — guarded by
# scripts/docker-compose.deploy-config.test.mjs.
#
# USAGE
#   scripts/upgrade.sh <version>            # e.g. scripts/upgrade.sh v0.21.0
#
# ENV (all optional; defaults target the resident prod stack)
#   CAP_COMPOSE_DIR    dir holding the compose file + .env   (default: cwd)
#   CAP_PROJECT        compose -p project                    (default: cloud-agent-platform)
#   CAP_COMPOSE_FILE   compose -f file                       (default: docker-compose.prod.yml)
#   CAP_API_URL        base URL for the /version verify + smoke (verify skipped if unset)
#   CAP_SMOKE_COOKIE   cap_session value for the provision + gate smokes (skipped if unset)
#   CAP_SMOKE_REPO_ID  repo id for the provision smoke           (smoke skipped if unset)
#   CAP_RELEASE_ASSET_BASE  override base URL for release assets (default:
#                           https://github.com/<GITHUB_RELEASES_REPO>/releases/download/<version>)
#   GITHUB_RELEASES_REPO    owner/repo for release assets (default: Xeonice/cloud-agent-platform)
#
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version>  (e.g. $0 v0.21.0)" >&2
  exit 2
fi
# Validate a semver tag (optional leading v) — never an arbitrary/moving tag.
if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$VERSION' is not a semver version tag" >&2
  exit 2
fi

COMPOSE_DIR="${CAP_COMPOSE_DIR:-.}"
PROJECT="${CAP_PROJECT:-cloud-agent-platform}"
COMPOSE_FILE="${CAP_COMPOSE_FILE:-docker-compose.prod.yml}"
# FORCE BOTH — no single-service door. Mirrors self-update CAP_SERVICES (prod runs
# no web) UNION PULL_ONLY (the aio-sandbox-image stager).
SERVICES=(api aio-sandbox-image)

cd "$COMPOSE_DIR"
[[ -f "$COMPOSE_FILE" ]] || { echo "error: $COMPOSE_FILE not found in $COMPOSE_DIR" >&2; exit 1; }
[[ -f .env ]] || { echo "error: .env not found in $COMPOSE_DIR" >&2; exit 1; }

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

echo "==> upgrading $PROJECT to $VERSION (services: ${SERVICES[*]})"

# ── task-model attestation (automate-task-model-attestation-in-ci) ──────────
# CI publishes cap-task-model-attestation-<version>.json (+ .sha256) per release,
# attesting ONLY what it witnessed: buildIdentity + compatibilityChecksPassed.
# The deployment-time facts are OURS to prove, locally, right here (design D1
# honesty split). Only when the asset is checksum-verified AND the local
# single-instance preconditions pass does step 1 additionally persist
# CAP_TASK_MODEL_SELECTION_ENABLED / CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON.
# ANY failure fails closed on the attestation WRITEBACK ONLY — the rest of the
# upgrade (image staging, CAP_VERSION pin, recreate, smoke) proceeds unchanged,
# and existing gate env keys are left untouched (pre-change UX).
GITHUB_RELEASES_REPO="${GITHUB_RELEASES_REPO:-Xeonice/cloud-agent-platform}"
ATT_ASSET="cap-task-model-attestation-${VERSION}.json"
ATT_BASE="${CAP_RELEASE_ASSET_BASE:-https://github.com/${GITHUB_RELEASES_REPO}/releases/download/${VERSION}}"
ATT_JSON=""          # non-empty => verified single-line content; writeback happens
ATT_SKIP_REASON=""   # non-empty => why the writeback was skipped (fail-closed)

att_sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{ print $1 }'
  else echo ""; fi
}

# curl WITHOUT -f so a 404 ("no attestation published for this release", e.g. a
# pre-attestation version) is distinguishable from transport/defect failures.
# Prints the HTTP status code; the body lands in $2.
att_fetch() {
  curl -sSL --retry 3 -o "$2" -w '%{http_code}' "${ATT_BASE%/}/$1" 2>/dev/null || true
}

stage_attestation() {
  local dir code expected actual
  dir="$(mktemp -d "${TMPDIR:-/tmp}/cap-attestation.XXXXXX")"
  code="$(att_fetch "$ATT_ASSET" "$dir/$ATT_ASSET")"
  if [[ "$code" == "404" ]]; then
    ATT_SKIP_REASON="no attestation asset for $VERSION (HTTP 404 — release predates CI attestation)"
    return 0
  fi
  if [[ "$code" != "200" ]]; then
    ATT_SKIP_REASON="attestation asset download failed (HTTP ${code:-?}) for $ATT_ASSET"
    return 0
  fi
  code="$(att_fetch "${ATT_ASSET}.sha256" "$dir/${ATT_ASSET}.sha256")"
  if [[ "$code" != "200" ]]; then
    ATT_SKIP_REASON="attestation checksum companion download failed (HTTP ${code:-?}) for ${ATT_ASSET}.sha256"
    return 0
  fi
  expected="$(awk '{ print $1; exit }' "$dir/${ATT_ASSET}.sha256")"
  actual="$(att_sha256_of "$dir/$ATT_ASSET")"
  if [[ -z "$actual" ]]; then
    ATT_SKIP_REASON="sha256sum/shasum unavailable — cannot verify $ATT_ASSET"
    return 0
  fi
  if [[ -z "$expected" || "$actual" != "$expected" ]]; then
    ATT_SKIP_REASON="attestation checksum MISMATCH for $ATT_ASSET (expected '${expected:-?}', got '$actual')"
    return 0
  fi
  # .env values are single-line. Valid JSON cannot contain raw newlines inside
  # strings, so stripping CR/LF is lossless for the verified content.
  ATT_JSON="$(tr -d '\r\n' < "$dir/$ATT_ASSET")"
  if [[ "${ATT_JSON:0:1}" != "{" ]]; then
    ATT_SKIP_REASON="attestation asset is not a JSON object (starts with '${ATT_JSON:0:1}')"
    ATT_JSON=""
    return 0
  fi
}

# Local single-instance preconditions (design D1/D3). CI attested the build; WE
# must prove the deployment-time facts. A stop-the-world single-instance compose
# upgrade makes them structurally true — verify that IS what this host runs:
#   1. exactly one running cap api container (no second api instance);
#   2. no running cap-namespace container that will stay at a version other than
#      the target (this project's own services are recreated by this script;
#      anything else — e.g. a lingering per-task cap-aio-<taskId> sandbox — is a
#      potential N-1 legacy worker and fails the check);
#   3. CAP_INSTANCE_ID unset or exactly 'cap-api-1' (the attestation's sole
#      instanceId — anything else would fail worker_report_missing at runtime).
# Prints the failed-precondition reason to stdout; empty output = all pass.
att_preconditions_failed_reason() {
  local rows cid image cproject tag api_count=0 api_cid="" stray="" iid=""
  rows="$(docker ps --format '{{.ID}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}' 2>/dev/null || true)"
  while IFS=$'\t' read -r cid image cproject _; do
    [[ -n "$cid" ]] || continue
    case "$image" in
      *cap-api:*|*cap-api@*|*cap-api) api_count=$((api_count + 1)); api_cid="$cid" ;;
    esac
    case "$image" in
      *cap-api*|*cap-web*|*cap-aio-sandbox*)
        # Containers of THIS compose project are recreated at $VERSION by this
        # very script; every other cap-namespace container must already match.
        if [[ "$cproject" != "$PROJECT" ]]; then
          tag=""
          [[ "$image" == *:* ]] && tag="${image##*:}"
          if [[ "$tag" != "$VERSION" && -z "$stray" ]]; then
            stray="container $cid ($image) is outside project '$PROJECT' and not at $VERSION — stop/drain it first (running tasks keep N-1 sandboxes alive)"
          fi
        fi
        ;;
    esac
  done <<< "$rows"
  if [[ "$api_count" -eq 0 ]]; then
    printf '%s' "no running cap api container found (need exactly one running instance to assert single-instance facts)"
    return 0
  fi
  if [[ "$api_count" -gt 1 ]]; then
    printf '%s' "$api_count cap api containers are running (need exactly one — multi-instance deployments must use the manual runbook)"
    return 0
  fi
  if [[ -n "$stray" ]]; then
    printf '%s' "$stray"
    return 0
  fi
  # CAP_INSTANCE_ID: the running api container is authoritative; fall back to
  # the env files the compose file feeds it (.env, ../files/api.env).
  iid="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$api_cid" 2>/dev/null | sed -n 's/^CAP_INSTANCE_ID=//p' | head -1 || true)"
  [[ -z "$iid" ]] && iid="$(sed -n 's/^CAP_INSTANCE_ID=//p' .env 2>/dev/null | head -1 || true)"
  [[ -z "$iid" && -f ../files/api.env ]] && iid="$(sed -n 's/^CAP_INSTANCE_ID=//p' ../files/api.env | head -1 || true)"
  if [[ -n "$iid" && "$iid" != "cap-api-1" ]]; then
    printf '%s' "CAP_INSTANCE_ID='$iid' != 'cap-api-1' (the attestation's sole instanceId)"
    return 0
  fi
}

echo "==> task-model attestation: staging $ATT_ASSET"
stage_attestation
if [[ -n "$ATT_JSON" ]]; then
  ATT_PRECOND_REASON="$(att_preconditions_failed_reason)"
  if [[ -n "$ATT_PRECOND_REASON" ]]; then
    ATT_SKIP_REASON="single-instance precondition failed: $ATT_PRECOND_REASON"
    ATT_JSON=""
  fi
fi
if [[ -n "$ATT_JSON" ]]; then
  echo "    attestation verified + single-instance preconditions passed — gate env keys will be written"
else
  echo "    SKIPPING task-model attestation writeback: $ATT_SKIP_REASON" >&2
  echo "    gate env keys left untouched; the rest of the upgrade proceeds unchanged." >&2
  echo "    Manual attestation path: deploy/TASK_MODEL_SELECTION_CUTOVER.md" >&2
fi

# 1) Back up + atomically pin CAP_VERSION (preserve every other line). When the
#    attestation was verified AND preconditions passed, the SAME atomic rewrite
#    also persists the task-model gate env keys; otherwise the gate keys are
#    not written or modified (fail-closed on the writeback only).
BACKUP=".env.bak.$(date +%Y%m%d%H%M%S)"
cp .env "$BACKUP"
echo "    backed up .env -> $BACKUP"
if [[ -n "$ATT_JSON" ]]; then
  {
    grep -v -e '^CAP_VERSION=' -e '^CAP_TASK_MODEL_SELECTION_ENABLED=' -e '^CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON=' .env || true
    echo "CAP_VERSION=$VERSION"
    echo "CAP_TASK_MODEL_SELECTION_ENABLED=true"
    echo "CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON=$ATT_JSON"
  } > .env.captmp && mv .env.captmp .env
  echo "    pinned CAP_VERSION=$VERSION + task-model gate env keys"
else
  { grep -v '^CAP_VERSION=' .env || true; echo "CAP_VERSION=$VERSION"; } > .env.captmp && mv .env.captmp .env
  echo "    pinned CAP_VERSION=$VERSION"
fi

# 2) Pull BOTH images BEFORE recreating (a failed pull leaves the prior version up).
echo "==> pull ${SERVICES[*]}"
dc pull "${SERVICES[@]}"

# 3) up -d BOTH. aio-sandbox-image is entrypoint:["true"] / restart:no — `up` runs
#    it, it stages the image onto the host, and it exits immediately.
echo "==> up -d ${SERVICES[*]}"
dc up -d "${SERVICES[@]}"

# 4) Verify the served /version == target (only when CAP_API_URL is provided).
if [[ -n "${CAP_API_URL:-}" ]]; then
  echo "==> verify /version == $VERSION"
  got=""
  for i in $(seq 1 20); do
    got="$(curl -fsS "${CAP_API_URL%/}/version" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
    [[ "$got" == "$VERSION" ]] && { echo "    /version = $got ✓"; break; }
    [[ $i -eq 20 ]] && { echo "error: /version='$got' != '$VERSION' after recreate" >&2; exit 1; }
    sleep 3
  done
else
  echo "    (CAP_API_URL unset — skipping /version verify)"
fi

# 5) Provision smoke — prove the freshly-staged sandbox image ACTUALLY runs: create
#    a throwaway task, wait for `running` (= sandbox provisioned), then stop it. This
#    is exactly the check that would have caught v0.20.0's missing image at deploy
#    time instead of when a user created a task.
if [[ -n "${CAP_API_URL:-}" && -n "${CAP_SMOKE_COOKIE:-}" && -n "${CAP_SMOKE_REPO_ID:-}" ]]; then
  echo "==> provision smoke (create task -> running -> stop)"
  tid="$(curl -fsS -X POST "${CAP_API_URL%/}/repos/${CAP_SMOKE_REPO_ID}/tasks" \
    -H "cookie: cap_session=${CAP_SMOKE_COOKIE}" -H 'content-type: application/json' \
    -d '{"prompt":"provision smoke (upgrade.sh) - confirm the sandbox image is runnable"}' \
    2>/dev/null | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1 || true)"
  if [[ -z "$tid" ]]; then
    echo "error: smoke task creation failed (check CAP_SMOKE_COOKIE / CAP_SMOKE_REPO_ID)" >&2
    exit 1
  fi
  echo "    task $tid created; polling for running..."
  ok=""
  for i in $(seq 1 20); do
    st="$(curl -fsS "${CAP_API_URL%/}/tasks/$tid" -H "cookie: cap_session=${CAP_SMOKE_COOKIE}" 2>/dev/null \
      | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1 || true)"
    echo "    status: ${st:-?}"
    [[ "$st" == "running" ]] && { ok=1; break; }
    [[ "$st" == "failed" || "$st" == "agent_failed_to_start" ]] && break
    sleep 4
  done
  curl -fsS -X POST "${CAP_API_URL%/}/tasks/$tid/stop" \
    -H "cookie: cap_session=${CAP_SMOKE_COOKIE}" >/dev/null 2>&1 || true
  if [[ -z "$ok" ]]; then
    echo "error: smoke task did not reach 'running' — sandbox provision is broken" >&2
    echo "       (is cap-aio-sandbox:$VERSION staged? this script's pull should have done it)" >&2
    exit 1
  fi
  echo "    sandbox provisioned (task reached running, now stopped) ✓"
else
  echo "    (CAP_API_URL / CAP_SMOKE_COOKIE / CAP_SMOKE_REPO_ID unset — SKIPPING provision smoke;"
  echo "     the force-both pull above is the hard guarantee; set those vars to enable the smoke)"
fi

# 6) Task-model gate smoke (automate-task-model-attestation-in-ci): after a
#    successful attestation writeback, the recreated api's gate MUST be open —
#    a 503/closed gate here is an upgrade verification FAILURE (the whole point
#    was ending the recurring catalog 503). When the writeback was skipped, a
#    closed gate is the expected outcome and never fails the upgrade. Uses the
#    session-guarded diagnostics endpoint, so it needs CAP_API_URL + cookie.
if [[ -n "$ATT_JSON" ]]; then
  if [[ -n "${CAP_API_URL:-}" && -n "${CAP_SMOKE_COOKIE:-}" ]]; then
    echo "==> task-model gate smoke (GET /deployment-capabilities/task-model-selection-v1)"
    gate_body="$(mktemp "${TMPDIR:-/tmp}/cap-gate-smoke.XXXXXX")"
    gate_code=""
    for i in $(seq 1 5); do
      gate_code="$(curl -sS -o "$gate_body" -w '%{http_code}' \
        "${CAP_API_URL%/}/deployment-capabilities/task-model-selection-v1" \
        -H "cookie: cap_session=${CAP_SMOKE_COOKIE}" 2>/dev/null || true)"
      [[ "$gate_code" == "200" ]] && break
      [[ $i -lt 5 ]] && sleep 3
    done
    if [[ "$gate_code" == "200" ]] && grep -q '"open"[[:space:]]*:[[:space:]]*true' "$gate_body"; then
      echo "    task-model gate is OPEN — catalog queries will not 503 ✓"
    else
      gate_reason="$(sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' "$gate_body" | head -1)"
      echo "error: task-model gate check FAILED after attestation writeback" >&2
      echo "       HTTP ${gate_code:-?}${gate_reason:+, gate closed reason: $gate_reason}" >&2
      echo "       (the upgrade wrote CAP_TASK_MODEL_SELECTION_* but the recreated api did not open the gate;" >&2
      echo "        see deploy/TASK_MODEL_SELECTION_CUTOVER.md for diagnosis)" >&2
      exit 1
    fi
  else
    echo "    WARNING: attestation was written but the task-model gate check is SKIPPED" >&2
    echo "             (CAP_API_URL / CAP_SMOKE_COOKIE unset — no session credential to query" >&2
    echo "              /deployment-capabilities/task-model-selection-v1; verify manually)" >&2
  fi
else
  echo "    task-model gate check: writeback was skipped (${ATT_SKIP_REASON}) — gate expectedly closed, not a failure"
fi

echo "==> upgrade to $VERSION complete"
