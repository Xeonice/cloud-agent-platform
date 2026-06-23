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
#   CAP_SMOKE_COOKIE   cap_session value for the provision smoke (smoke skipped if unset)
#   CAP_SMOKE_REPO_ID  repo id for the provision smoke           (smoke skipped if unset)
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

# 1) Back up + atomically pin CAP_VERSION (preserve every other line).
BACKUP=".env.bak.$(date +%Y%m%d%H%M%S)"
cp .env "$BACKUP"
echo "    backed up .env -> $BACKUP"
{ grep -v '^CAP_VERSION=' .env || true; echo "CAP_VERSION=$VERSION"; } > .env.captmp && mv .env.captmp .env
echo "    pinned CAP_VERSION=$VERSION"

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

echo "==> upgrade to $VERSION complete"
