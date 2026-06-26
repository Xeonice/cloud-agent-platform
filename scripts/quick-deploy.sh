#!/usr/bin/env bash
#
# quick-deploy.sh — agent-drivable, source-free, NO-OAuth one-shot self-host of cap
# from the PREBUILT GHCR images.
#
# WHY this exists (agent-oneclick-deploy): cap's two existing deploy systems do not
# intersect — the scripted one-click path (`install.sh` -> `make up`) builds from
# SOURCE with a legacy token, while the prebuilt-image path
# (`docker-compose.prod.yml`) needs a MANUAL GitHub-OAuth-app step. So a coding
# agent on a fresh amd64 host has no fast, fully-automatable bring-up. This script
# fills that gap: it runs the published `ghcr.io/xeonice/cap-*:${CAP_VERSION}`
# images and SYNTHESIZES a legacy-token `.env` so they boot with NO OAuth.
#
# It relies on a seam that already exists: `docker-compose.prod.yml`'s api reads
# `env_file: .env` and does NOT redeclare AUTH_TOKEN / SESSION_SECRET /
# CODEX_CRED_ENC_KEY — so a legacy-token `.env` is honored by the prebuilt image.
# No change to the compose file is required or made.
#
# TRUST BOUNDARY — this is the LEGACY-TOKEN, localhost/trial-or-single-user
# self-host path, NOT the OAuth-first production deploy (for that, see
# docs/self-hosting.md). It is HOST-ROOT-EQUIVALENT: the api mounts the host
# `/var/run/docker.sock` to provision sandboxes, so whoever holds the printed
# token can run as root on this host. The prebuilt `cap-web` console bakes its
# VITE_* to localhost at build time, so the in-compose web is only correct for a
# SAME-HOST trial.
#
# It is structured as GATES: each phase fails LOUD and EARLY with a precise
# remediation, so a failure is a clean stop point rather than a half-bootstrapped
# host.
#
#   scripts/quick-deploy.sh                 # localhost trial, web on :3000
#   CAP_VERSION=v0.21.0 scripts/quick-deploy.sh
#   WITH_WEB=0 scripts/quick-deploy.sh      # api + postgres only (no console)
#   CAP_SMOKE_REPO_ID=<id> RUN_SMOKE=1 scripts/quick-deploy.sh   # + provision smoke
#
set -euo pipefail

# ── Tunables (env-overridable) ────────────────────────────────────────────────
CAP_VERSION="${CAP_VERSION:-latest}"
WORKDIR="${CAP_WORKDIR:-$PWD}"          # where .env + the compose file live / are written
API_PORT="${API_PORT:-8080}"
WEB_PORT="${WEB_PORT:-3000}"
WITH_WEB="${WITH_WEB:-1}"               # 1 = bring up the in-compose console (localhost-only)
RUN_SMOKE="${RUN_SMOKE:-0}"            # 1 = create+stop a throwaway task as a provision smoke
# Where to fetch docker-compose.prod.yml when it is not already on disk. The
# compose-base marker below is replaced at build time by the www injector with the
# publishing site (so the SITE-SERVED copy fetches the site's own compose asset). The
# `case` arm restores the raw-GitHub default when the marker was NOT substituted
# (i.e. the committed repo copy run directly), mirroring install.sh's fallback. A
# caller-set CAP_RAW_BASE always wins.
RAW_BASE="${CAP_RAW_BASE:-__CAP_COMPOSE_BASE__}"
case "$RAW_BASE" in
  __CAP_COMPOSE_BASE__) RAW_BASE="https://raw.githubusercontent.com/Xeonice/cloud-agent-platform/main" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

step(){ printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn(){ printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
die(){ printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ── GATE 1 — architecture (prebuilt images are amd64-only) ─────────────────────
step "GATE 1 — architecture"
arch="$(uname -m 2>/dev/null || echo unknown)"
case "$arch" in
  x86_64|amd64) echo "  amd64 OK ($arch)";;
  *) die "The prebuilt cap images are amd64/AIO-oriented and this host is '$arch'.
       On arm64/macOS use the source installer or run \`make up\` from a clone;
       that platform-aware path defaults macOS to BoxLite. To override manually:
       CAP_SANDBOX_PROVIDER=boxlite make up  (or CAP_SANDBOX_PROVIDER=control-plane make up).";;
esac

# ── GATE 2 — base tooling ──────────────────────────────────────────────────────
step "GATE 2 — base tooling"
for b in docker curl openssl awk; do
  command -v "$b" >/dev/null 2>&1 || die "missing required tool '$b' on PATH"
done
docker compose version >/dev/null 2>&1 || \
  die "the 'docker compose' v2 plugin is required (>= v2.23.1 for inline configs)"
echo "  docker + docker compose + curl + openssl + awk present"

# ── GATE 3 — Docker ENGINE reachable (with bounded, non-destructive self-heal) ─
# The engine must be reachable BEFORE any fetch/pull/up so a dead engine never
# leaves a half-bootstrapped host. Self-heal is limited to reversible moves;
# anything needing sudo or the Windows GUI is emitted as an exact human step.
step "GATE 3 — Docker engine reachable"
engine_ok(){ timeout 12 docker info >/dev/null 2>&1; }
if ! engine_ok; then
  echo "  engine unreachable on the active context — attempting self-heal…"
  # A) a non-default context (e.g. desktop-linux) may already be live.
  for ctx in $(docker context ls --format '{{.Name}}' 2>/dev/null); do
    [ "$ctx" = "default" ] && continue
    if timeout 12 docker --context "$ctx" info >/dev/null 2>&1; then
      echo "  -> context '$ctx' is live; selecting it."
      docker context use "$ctx" >/dev/null 2>&1 || true
      break
    fi
  done
  # B) Docker Desktop on Windows, reachable via WSL interop.
  if ! engine_ok && [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]; then
    dd='/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe'
    if [ -x "$dd" ]; then
      echo "  -> WSL detected; requesting Docker Desktop start via interop (waiting up to ~4m)…"
      nohup "$dd" >/dev/null 2>&1 & disown 2>/dev/null || true
      for _ in $(seq 1 40); do engine_ok && break; sleep 6; done
    fi
  fi
fi
if ! engine_ok; then
  die "Docker engine is not reachable and headless self-heal failed. A HUMAN must do ONE of:
       • Docker Desktop (WSL): start it AND enable Settings -> Resources -> WSL
         Integration for THIS distro, then re-run; OR
       • Native docker in WSL/Linux:  sudo systemctl restart docker
         (a native dockerd reporting 'active' but serving no socket is a common
          WSL failure mode — restart fixes it); OR
       • Ensure 'docker context' is not pinned to a dead default socket.
       Re-run once 'docker info' succeeds."
fi
docker version --format '  engine OK: server {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'

# ── GATE 4 — locate / fetch the source-free run package (no app-source clone) ──
step "GATE 4 — run package in $WORKDIR"
mkdir -p "$WORKDIR"
COMPOSE="$WORKDIR/docker-compose.prod.yml"
if [ -f "$COMPOSE" ]; then
  echo "  using existing $COMPOSE"
elif [ -f "$REPO_ROOT/docker-compose.prod.yml" ] && [ "$WORKDIR" != "$REPO_ROOT" ]; then
  cp "$REPO_ROOT/docker-compose.prod.yml" "$COMPOSE"
  echo "  copied docker-compose.prod.yml from the repo into $WORKDIR"
elif [ -f "$REPO_ROOT/docker-compose.prod.yml" ]; then
  COMPOSE="$REPO_ROOT/docker-compose.prod.yml"
  echo "  using the repo's docker-compose.prod.yml"
else
  echo "  downloading docker-compose.prod.yml from $RAW_BASE …"
  curl -fsSL "$RAW_BASE/docker-compose.prod.yml" -o "$COMPOSE" \
    || die "could not download docker-compose.prod.yml from $RAW_BASE"
fi

# ── GATE 5 — synthesize a legacy-token .env (idempotent, non-destructive) ──────
# prod.yml's api uses env_file:.env and does NOT redeclare AUTH_TOKEN/SESSION_SECRET,
# so this .env makes the PREBUILT image boot with NO GitHub OAuth app.
step "GATE 5 — legacy-token .env"
ENV_FILE="$WORKDIR/.env"
if [ -f "$ENV_FILE" ]; then
  echo "  $ENV_FILE exists — reusing as-is (not overwriting)."
  TOKEN="$(awk -F= '/^AUTH_TOKEN=/{print $2; exit}' "$ENV_FILE")"
else
  TOKEN="cap_$(openssl rand -hex 24)"
  ( umask 077; cat > "$ENV_FILE" <<EOF
# Generated by scripts/quick-deploy.sh — LOCAL TRIAL via PREBUILT images, legacy-token auth.
# This is NOT an OAuth-first production deploy. Keep this file out of version control.
CAP_VERSION=${CAP_VERSION}
AUTH_TOKEN_LEGACY_ENABLED=true
AUTH_TOKEN=${TOKEN}
SESSION_SECRET=$(openssl rand -hex 32)
CODEX_CRED_ENC_KEY=$(openssl rand -hex 32)
# Same-host trial: web (:${WEB_PORT}) and api (:${API_PORT}) on localhost.
WEB_ORIGIN=http://localhost:${WEB_PORT}
EOF
  )
  echo "  wrote $ENV_FILE with a random legacy token (gitignored)"
fi
[ -n "${TOKEN:-}" ] || die "could not resolve AUTH_TOKEN from $ENV_FILE"

# ── GATE 6 — pull + up (prebuilt images; no --build) ───────────────────────────
step "GATE 6 — pull + up (CAP_VERSION=$CAP_VERSION)"
profiles=""; [ "$WITH_WEB" = "1" ] && profiles="web"
( cd "$WORKDIR"
  COMPOSE_PROFILES="$profiles" CAP_VERSION="$CAP_VERSION" docker compose -f "$COMPOSE" pull
  COMPOSE_PROFILES="$profiles" CAP_VERSION="$CAP_VERSION" docker compose -f "$COMPOSE" up -d
)

# ── GATE 7 — wait for /health, surface the token ───────────────────────────────
step "GATE 7 — wait for api /health"
deadline=$(( $(date +%s) + 120 ))
until curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    die "api did not become healthy in 120s — inspect: docker compose -f $COMPOSE logs api"
  fi
  sleep 3
done
ver="$(curl -fsS "http://localhost:${API_PORT}/version" 2>/dev/null || echo '{}')"
# Teardown hint must match the profiles that were brought up: a bare `docker compose
# down` does NOT remove the profile-gated `cap-web`, so include COMPOSE_PROFILES=web
# when the web console was started.
if [ "$WITH_WEB" = "1" ]; then
  DOWN_HINT="COMPOSE_PROFILES=web docker compose -f $COMPOSE down"
else
  DOWN_HINT="docker compose -f $COMPOSE down"
fi
cat <<EOF

✅ cap is up (source-free, PREBUILT images, NO OAuth).
   version: ${ver}
   api:   http://localhost:${API_PORT}    (/health open; everything else needs the token)
   web:   $( [ "$WITH_WEB" = 1 ] && echo "http://localhost:${WEB_PORT}  (localhost-only — prebuilt cap-web VITE_* baked to localhost)" || echo "(web profile off)" )
   auth:  Authorization: Bearer ${TOKEN}
   try:   curl -H "Authorization: Bearer ${TOKEN}" http://localhost:${API_PORT}/tasks
   down:  ${DOWN_HINT}            (add -v to also drop the volumes)
EOF

# ── GATE 8 (optional) — provision smoke: create -> running -> stop ─────────────
# Mirrors scripts/upgrade.sh's smoke (create a throwaway task, wait for `running`
# = sandbox provisioned, then stop), but authenticates with the legacy bearer.
if [ "$RUN_SMOKE" = "1" ]; then
  step "GATE 8 — provision smoke"
  if [ -z "${CAP_SMOKE_REPO_ID:-}" ]; then
    warn "RUN_SMOKE=1 but CAP_SMOKE_REPO_ID is unset — SKIPPING the provision smoke."
    warn "  (import/select a repo, then set CAP_SMOKE_REPO_ID to enable it.)"
  else
    auth="Authorization: Bearer ${TOKEN}"
    tid="$(curl -fsS -X POST "http://localhost:${API_PORT}/repos/${CAP_SMOKE_REPO_ID}/tasks" \
      -H "$auth" -H 'content-type: application/json' \
      -d '{"prompt":"provision smoke (quick-deploy.sh) - confirm the sandbox image is runnable"}' \
      2>/dev/null | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$tid" ] || die "smoke task creation failed (check CAP_SMOKE_REPO_ID / token)"
    echo "  task $tid created; polling for running…"
    ok=0; sdl=$(( $(date +%s) + 180 ))
    while [ "$(date +%s)" -lt "$sdl" ]; do
      st="$(curl -fsS "http://localhost:${API_PORT}/tasks/$tid" -H "$auth" 2>/dev/null \
        | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)"
      [ "$st" = "running" ] && { ok=1; break; }
      # Early-break on a terminal failure (mirrors upgrade.sh) so a failed task does
      # not wait out the full deadline.
      { [ "$st" = "failed" ] || [ "$st" = "agent_failed_to_start" ]; } && break
      sleep 3
    done
    curl -fsS -X POST "http://localhost:${API_PORT}/tasks/$tid/stop" -H "$auth" >/dev/null 2>&1 || true
    [ "$ok" = 1 ] || die "smoke task did not reach 'running' — sandbox provision is broken"
    echo "  sandbox provisioned (task reached running, now stopped) ✓"
  fi
fi
