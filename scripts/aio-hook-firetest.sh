#!/usr/bin/env bash
#
# GATE — codex 0.131 PreToolUse hook LIVE fire-test (harden-aio-execution,
# integration task 6.8; design D8 ★, codex#16732).
#
# WHY THIS IS A GATE, NOT A UNIT TEST:
#   The cap-side approval round-trip is already proven by unit tests
#   (apps/sandbox-hooks/src/hooks/codex-0131-adapter.test.mjs) and the adapter
#   emits the correct 0.131 protocol. What those CANNOT prove is that codex 0.131
#   ACTUALLY FIRES the baked PreToolUse hook for a gated tool call — in live
#   tests it has silently NOT fired even with the correct 0.131 format,
#   `--full-auto`, hook trust, and matcher `.*` (codex#16732; 0.131 is a research
#   preview). Therefore the "approval-via-codex-hook" scenario MUST NOT be marked
#   satisfied on build-green or unit tests alone. This script is the ONLY thing
#   that may flip that scenario to PROVEN, and only against a real account.
#
# WHAT IT DOES:
#   1. Brings up the compose stack (api + postgres + cap-net + docker.sock).
#   2. Creates a task; the orchestrator provisions a sibling cap-aio-<taskId>
#      sandbox from the derived image (codex 0.131 + baked 0.131 hooks.json).
#   3. Launches codex in-shell as `codex --full-auto --dangerously-bypass-hook-trust`
#      (the CODEX_LAUNCH_ARGV launch contract; --full-auto KEEPS hooks).
#   4. Drives codex to attempt a GATED tool call (a shell command).
#   5. ASSERTS the orchestrator received a `permission_request` callback at
#      /v1/approvals — i.e. the PreToolUse hook ACTUALLY FIRED — within a timeout.
#
# OUTCOME SEMANTICS (the gate):
#   exit 0  -> the hook FIRED for a gated tool call. The codex-hook approval
#              scenario is PROVEN for this codex version/account. Record the codex
#              version + account model alongside the result.
#   exit 3  -> the hook DID NOT fire within the timeout (codex#16732 reproduced).
#              The codex-hook scenario is NOT satisfied; the cap-controlled
#              FALLBACK (task 6.9 / scripts: AioApprovalEnforcer) MUST be the
#              enforcement path. Do NOT mark the hook-fires scenario satisfied.
#   exit 2  -> could not run the gate (no account creds / no docker / build fail).
#              Inconclusive — the gate has NOT been passed.
#
# REQUIREMENTS (must be supplied by the operator; the gate refuses to fake them):
#   CODEX_HOME_AUTH   path to a real ~/.codex auth.json for a working account
#                     (e.g. a gpt-5.5 ChatGPT account). Mounted into the sandbox.
#   AIO_SANDBOX_IMAGE the derived image with codex 0.131 + 0.131 hooks baked.
#   AUTH_TOKEN        operator bearer token for the api.
set -uo pipefail
cd "$(dirname "$0")/.."

API="${API:-http://127.0.0.1:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
CODEX_HOME_AUTH="${CODEX_HOME_AUTH:-}"
FIRE_TIMEOUT_SECS="${FIRE_TIMEOUT_SECS:-90}"

inconclusive() { printf '\n[GATE INCONCLUSIVE] %s\n' "$*"; exit 2; }
fired()        { printf '\n[GATE PASS] %s\n' "$*"; exit 0; }
not_fired()    { printf '\n[GATE FAIL — hook did not fire (codex#16732)] %s\n' "$*"; exit 3; }

# --- preconditions: refuse to pretend the gate passed -----------------------
command -v docker >/dev/null 2>&1 || inconclusive "docker is required for the live fire-test"
docker info >/dev/null 2>&1        || inconclusive "docker daemon not reachable"
[ -n "$AUTH_TOKEN" ]               || inconclusive "AUTH_TOKEN (operator token) is required"
[ -n "$CODEX_HOME_AUTH" ] && [ -f "$CODEX_HOME_AUTH" ] \
  || inconclusive "CODEX_HOME_AUTH must point at a real ~/.codex auth.json for a working account — the gate will NOT fabricate a live account"

log() { printf '\n=== %s ===\n' "$*"; }

cleanup() {
  log "teardown"
  docker compose down -v >/dev/null 2>&1 || true
  docker ps -aq --filter 'name=cap-aio-' | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- bring the stack up ------------------------------------------------------
log "starting compose stack (api + postgres on cap-net, docker.sock mounted)"
AUTH_TOKEN="$AUTH_TOKEN" docker compose up -d --build || inconclusive "compose up failed"

log "waiting for api health at $API"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS -m 3 "$API/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[ "$healthy" = 1 ] || inconclusive "api never became healthy"

auth=(-H "authorization: Bearer ${AUTH_TOKEN}")

# --- create a task; the orchestrator provisions the sandbox ------------------
log "creating a task (provisions cap-aio-<taskId> from the derived image)"
task_json="$(curl -fsS "${auth[@]}" -H 'content-type: application/json' \
  -X POST "$API/v1/tasks" -d '{"prompt":"firetest"}' 2>/dev/null || true)"
task_id="$(printf '%s' "$task_json" | sed -n 's/.*"id"[: ]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$task_id" ] || inconclusive "could not create a task (response: ${task_json:-<empty>})"
echo "task=$task_id"

# The sandbox needs the real account auth to actually run codex. Copy it into the
# per-task sandbox's gem HOME so codex is authenticated.
sandbox="cap-aio-${task_id}"
for _ in $(seq 1 30); do
  docker inspect "$sandbox" >/dev/null 2>&1 && break; sleep 1
done
docker inspect "$sandbox" >/dev/null 2>&1 || inconclusive "sandbox $sandbox never appeared"
docker cp "$CODEX_HOME_AUTH" "$sandbox:/home/gem/.codex/auth.json" \
  && docker exec -u 0 "$sandbox" chown 1000:1000 /home/gem/.codex/auth.json \
  || inconclusive "could not install account auth into the sandbox"

# --- record the approvals callbacks BEFORE driving codex ---------------------
# The orchestrator exposes received approval activity per task; a permission_request
# callback arriving == the PreToolUse hook fired. Poll the task activity for it.
before="$(curl -fsS "${auth[@]}" "$API/v1/tasks/$task_id/activity" 2>/dev/null || echo '[]')"

# --- launch codex with the hooks-preserving launch contract + a gated call ---
# Drive a GATED tool call through the operator terminal channel: launch codex
# --full-auto --dangerously-bypass-hook-trust and ask it to run a shell command,
# which is a PreToolUse-gated tool. (The exact driver depends on the codex TUI;
# this uses the orchestrator's task-input surface.)
log "launching codex --full-auto --dangerously-bypass-hook-trust and issuing a gated tool call"
curl -fsS "${auth[@]}" -H 'content-type: application/json' \
  -X POST "$API/v1/tasks/$task_id/input" \
  -d '{"data":"codex --full-auto --dangerously-bypass-hook-trust\n"}' >/dev/null 2>&1 || true
sleep 8
curl -fsS "${auth[@]}" -H 'content-type: application/json' \
  -X POST "$API/v1/tasks/$task_id/input" \
  -d '{"data":"run: echo hook-fire-probe\n"}' >/dev/null 2>&1 || true

# --- ASSERT the PreToolUse hook fired (a permission_request callback arrived) -
log "waiting up to ${FIRE_TIMEOUT_SECS}s for a permission_request callback (hook fired?)"
deadline=$(( $(date +%s) + FIRE_TIMEOUT_SECS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  now="$(curl -fsS "${auth[@]}" "$API/v1/tasks/$task_id/activity" 2>/dev/null || echo '[]')"
  if printf '%s' "$now" | grep -q 'permission_request'; then
    fired "codex 0.131 PreToolUse hook FIRED for the gated tool call (permission_request received). Record codex version + account model with this result."
  fi
  sleep 3
done

not_fired "no permission_request callback within ${FIRE_TIMEOUT_SECS}s — the codex PreToolUse hook did not fire. Enforce approval via the cap-controlled fallback (task 6.9). Do NOT mark the hook-fires scenario satisfied."
