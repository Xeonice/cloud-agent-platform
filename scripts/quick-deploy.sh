#!/usr/bin/env bash
#
# quick-deploy.sh — agent-drivable, source-free, legacy-token one-shot self-host of cap
# from the PREBUILT GHCR release images.
#
# WHY this exists (agent-oneclick-deploy): the public one-line install path must run
# the RELEASE artifacts, not rebuild an unversioned local source image. This script
# runs the published `ghcr.io/xeonice/cap-*:${CAP_VERSION}` images and SYNTHESIZES a
# legacy-token `.env` so they boot with no GitHub OAuth app. macOS defaults to a BoxLite-backed
# sandbox provider; Linux defaults to AIO. Both still run the prebuilt api/web image.
#
# It relies on a seam that already exists: `docker-compose.prod.yml`'s api reads
# `env_file: .env` and does NOT redeclare AUTH_TOKEN / SESSION_SECRET /
# CODEX_CRED_ENC_KEY — so a legacy-token `.env` is honored by the prebuilt image.
# No change to the compose file is required or made.
#
# TRUST BOUNDARY — this is the LEGACY-TOKEN, localhost/trial-or-single-user
# self-host path, NOT the local-account production deploy (for that, see
# docs/self-hosting.md). In AIO mode it is HOST-ROOT-EQUIVALENT: the api mounts the
# host `/var/run/docker.sock` to provision sandboxes, so whoever holds the printed
# token can run as root on this host. The prebuilt `cap-web` console bakes its VITE_*
# to localhost at build time, so the in-compose web is only correct for a SAME-HOST
# trial.
#
# It is structured as GATES: each phase fails LOUD and EARLY with a precise
# remediation, so a failure is a clean stop point rather than a half-bootstrapped
# host.
#
#   scripts/quick-deploy.sh                 # localhost trial, web on :3000
#   CAP_VERSION=v0.24.0 scripts/quick-deploy.sh
#   CAP_SANDBOX_PROVIDER=boxlite BOXLITE_ENDPOINT=... BOXLITE_API_TOKEN=... BOXLITE_IMAGE=... scripts/quick-deploy.sh
#   WITH_WEB=0 scripts/quick-deploy.sh      # api + postgres only (no console)
#   CAP_SMOKE_REPO_ID=<id> RUN_SMOKE=1 scripts/quick-deploy.sh   # + provision smoke
#
set -euo pipefail

# ── Tunables (env-overridable) ────────────────────────────────────────────────
REQUESTED_CAP_VERSION="${CAP_VERSION:-latest}" # latest resolves to the latest GitHub Release tag
CAP_VERSION="$REQUESTED_CAP_VERSION"
WORKDIR="${CAP_WORKDIR:-$PWD}"          # where .env + the compose file live / are written
API_PORT="${API_PORT:-8080}"
WEB_PORT="${WEB_PORT:-3000}"
WITH_WEB="${WITH_WEB:-1}"               # 1 = bring up the in-compose console (localhost-only)
RUN_SMOKE="${RUN_SMOKE:-0}"            # 1 = create+stop a throwaway task as a provision smoke
REQUESTED_PROVIDER="${CAP_SANDBOX_PROVIDER:-auto}" # auto|aio|boxlite|control-plane
CAP_IMAGE_PLATFORM="${CAP_IMAGE_PLATFORM:-}"       # defaulted for non-amd64 release images below
GITHUB_RELEASES_REPO="${GITHUB_RELEASES_REPO:-Xeonice/cloud-agent-platform}"
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

host_os(){ uname -s 2>/dev/null || echo unknown; }
host_arch(){ uname -m 2>/dev/null || echo unknown; }
is_amd64(){
  case "$1" in
    x86_64|amd64) return 0 ;;
    *) return 1 ;;
  esac
}
normalize_provider(){
  case "${1:-auto}" in
    auto|aio|boxlite|control-plane) printf '%s\n' "${1:-auto}" ;;
    *) die "invalid CAP_SANDBOX_PROVIDER: $1 (expected auto|aio|boxlite|control-plane)" ;;
  esac
}
resolve_provider(){
  requested="$(normalize_provider "$1")"
  if [ "$requested" != "auto" ]; then
    printf '%s\n' "$requested"
    return
  fi
  case "$(host_os)" in
    Darwin) printf '%s\n' "boxlite" ;;
    Linux) printf '%s\n' "aio" ;;
    *) die "cannot auto-select sandbox provider for OS '$(host_os)'; set CAP_SANDBOX_PROVIDER=aio|boxlite|control-plane" ;;
  esac
}
resolve_cap_version(){
  case "$1" in
    latest|"")
      latest_url="${CAP_RELEASE_LATEST_URL:-https://api.github.com/repos/${GITHUB_RELEASES_REPO}/releases/latest}"
      echo "  resolving latest Release via ${latest_url}" >&2
      latest_json="$(curl -fsSL "$latest_url" 2>/dev/null)" || \
        die "could not resolve the latest Release from ${latest_url}; set CAP_VERSION=vX.Y.Z and re-run"
      latest_tag="$(printf '%s\n' "$latest_json" | awk -F\" '/"tag_name"[[:space:]]*:/ { print $4; exit }')"
      [ -n "$latest_tag" ] || \
        die "latest Release response did not include tag_name; set CAP_VERSION=vX.Y.Z and re-run"
      printf '%s\n' "$latest_tag"
      ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# ── GATE 1 — platform + sandbox provider ───────────────────────────────────────
step "GATE 1 — platform/provider"
HOST_OS="$(host_os)"
HOST_ARCH="$(host_arch)"
SELECTED_PROVIDER="$(resolve_provider "$REQUESTED_PROVIDER")"
echo "  host: ${HOST_OS}/${HOST_ARCH}"
echo "  sandbox provider: ${SELECTED_PROVIDER} (requested: ${REQUESTED_PROVIDER})"

if ! is_amd64 "$HOST_ARCH"; then
  # The cap release images are published as linux/amd64 today. Docker Desktop and
  # Colima can run them on Apple Silicon via emulation; pin the platform explicitly
  # so Docker does not ask GHCR for a non-existent arm64 manifest.
  CAP_IMAGE_PLATFORM="${CAP_IMAGE_PLATFORM:-linux/amd64}"
  export CAP_IMAGE_PLATFORM
  if [ -z "${DOCKER_DEFAULT_PLATFORM:-}" ]; then
    export DOCKER_DEFAULT_PLATFORM="$CAP_IMAGE_PLATFORM"
  fi
  echo "  release image platform: ${CAP_IMAGE_PLATFORM}"
fi

if [ "$SELECTED_PROVIDER" = "aio" ] && ! is_amd64 "$HOST_ARCH"; then
  die "AIO sandbox staging is only supported on an amd64/x86_64 host by default.
       This host is ${HOST_OS}/${HOST_ARCH}. Use the macOS prebuilt path with:
       CAP_SANDBOX_PROVIDER=boxlite BOXLITE_ENDPOINT=... BOXLITE_API_TOKEN=... BOXLITE_IMAGE=...
       or set CAP_SANDBOX_PROVIDER=control-plane for api-only."
fi
export CAP_SANDBOX_PROVIDER="$SELECTED_PROVIDER"

# ── GATE 2 — base tooling ──────────────────────────────────────────────────────
step "GATE 2 — base tooling"
for b in docker curl openssl awk; do
  command -v "$b" >/dev/null 2>&1 || die "missing required tool '$b' on PATH"
done
docker compose version >/dev/null 2>&1 || \
  die "the 'docker compose' v2 plugin is required (>= v2.23.1 for inline configs)"
echo "  docker + docker compose + curl + openssl + awk present"

step "GATE 2.5 — release version"
CAP_VERSION="$(resolve_cap_version "$REQUESTED_CAP_VERSION")"
echo "  release tag: ${CAP_VERSION} (requested: ${REQUESTED_CAP_VERSION})"

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

# ── GATE 5 — synthesize/update a legacy-token .env (non-destructive) ───────────
# prod.yml's api uses env_file:.env and does NOT redeclare AUTH_TOKEN/SESSION_SECRET,
# so this .env makes the PREBUILT image boot without a GitHub OAuth app. Existing
# secrets are preserved; non-secret operational keys such as CAP_VERSION/provider
# are corrected to match this run so /version cannot remain unknown.
step "GATE 5 — legacy-token .env"
ENV_FILE="$WORKDIR/.env"
env_file_value(){
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  awk -F= -v k="$key" '$1 == k { print substr($0, length(k) + 2); exit }' "$ENV_FILE" 2>/dev/null || true
}
value_for(){
  local key="$1"
  local from_process="${!key:-}"
  if [ -n "$from_process" ]; then
    printf '%s\n' "$from_process"
  else
    env_file_value "$key"
  fi
}
has_env_key(){
  local key="$1"
  [ -f "$ENV_FILE" ] && awk -F= -v k="$key" '$1 == k { found = 1 } END { exit found ? 0 : 1 }' "$ENV_FILE" 2>/dev/null
}
set_env_if_missing(){
  local key="$1" value="$2"
  [ -n "$value" ] || return 0
  if ! has_env_key "$key"; then
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
    echo "  set $key in $ENV_FILE"
  fi
}
set_env_value(){
  local key="$1" value="$2" tmp
  [ -n "$value" ] || return 0
  if [ ! -f "$ENV_FILE" ]; then
    printf '%s=%s\n' "$key" "$value" >"$ENV_FILE"
    echo "  set $key in $ENV_FILE"
    return
  fi
  tmp="${ENV_FILE}.captmp"
  awk -F= -v k="$key" -v v="$value" '
    $1 == k && !done { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$ENV_FILE"
  echo "  set $key in $ENV_FILE"
}
require_value(){
  local key="$1" value
  value="$(value_for "$key")"
  [ -n "$value" ] || die "$key is required for CAP_SANDBOX_PROVIDER=$SELECTED_PROVIDER"
  printf '%s\n' "$value"
}
if [ -f "$ENV_FILE" ]; then
  echo "  $ENV_FILE exists — preserving secrets and updating operational pins."
  TOKEN="$(awk -F= '/^AUTH_TOKEN=/{print $2; exit}' "$ENV_FILE")"
else
  TOKEN="cap_$(openssl rand -hex 24)"
  ( umask 077; cat > "$ENV_FILE" <<EOF
# Generated by scripts/quick-deploy.sh — LOCAL TRIAL via PREBUILT images, legacy-token auth.
# This is NOT a local-account production deploy. Keep this file out of version control.
CAP_VERSION=${CAP_VERSION}
CAP_SANDBOX_PROVIDER=${SELECTED_PROVIDER}
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

set_env_value CAP_VERSION "$CAP_VERSION"
set_env_value CAP_SANDBOX_PROVIDER "$SELECTED_PROVIDER"
[ -n "$CAP_IMAGE_PLATFORM" ] && set_env_value CAP_IMAGE_PLATFORM "$CAP_IMAGE_PLATFORM"

if [ "$SELECTED_PROVIDER" = "boxlite" ]; then
  boxlite_endpoint="$(require_value BOXLITE_ENDPOINT)"
  boxlite_token="$(require_value BOXLITE_API_TOKEN)"
  boxlite_image="$(value_for BOXLITE_IMAGE)"
  boxlite_image_map="$(value_for BOXLITE_IMAGE_MAP)"
  [ -n "$boxlite_image" ] || [ -n "$boxlite_image_map" ] || \
    die "BOXLITE_IMAGE or BOXLITE_IMAGE_MAP is required for CAP_SANDBOX_PROVIDER=boxlite"
  set_env_if_missing BOXLITE_ENDPOINT "$boxlite_endpoint"
  set_env_if_missing BOXLITE_API_TOKEN "$boxlite_token"
  set_env_if_missing BOXLITE_IMAGE "$boxlite_image"
  set_env_if_missing BOXLITE_IMAGE_MAP "$boxlite_image_map"
  set_env_if_missing BOXLITE_PROVIDER_ID boxlite
  set_env_if_missing BOXLITE_PROVIDER_PRIORITY 100
  set_env_if_missing BOXLITE_PROVIDER_LOCATION local
  set_env_if_missing BOXLITE_WORKSPACE_PATH /workspace
  set_env_if_missing BOXLITE_SANDBOX_ID_PREFIX cap-boxlite-
  set_env_if_missing BOXLITE_SANDBOX_MODE workspace-write
  set_env_if_missing BOXLITE_CLIENT_MODE rest
  set_env_if_missing BOXLITE_TIMEOUT_MS 30000
  set_env_if_missing BOXLITE_TERMINAL_MODE pty
  set_env_if_missing BOXLITE_CAPABILITIES terminal.websocket,terminal.interactive,command.exec,workspace.git.materialize,workspace.git.deliver,workspace.archive.transfer,lifecycle.readopt,lifecycle.readoption
fi

# ── GATE 6 — pull + up (prebuilt images; no --build) ───────────────────────────
step "GATE 6 — pull + up (CAP_VERSION=$CAP_VERSION, provider=$SELECTED_PROVIDER)"
profiles=""; [ "$WITH_WEB" = "1" ] && profiles="web"
services=(api postgres)
[ "$WITH_WEB" = "1" ] && services+=(web)
[ "$SELECTED_PROVIDER" = "aio" ] && services+=(aio-sandbox-image)
( cd "$WORKDIR"
  COMPOSE_PROFILES="$profiles" CAP_VERSION="$CAP_VERSION" CAP_SANDBOX_PROVIDER="$SELECTED_PROVIDER" CAP_IMAGE_PLATFORM="$CAP_IMAGE_PLATFORM" docker compose -f "$COMPOSE" pull "${services[@]}"
  COMPOSE_PROFILES="$profiles" CAP_VERSION="$CAP_VERSION" CAP_SANDBOX_PROVIDER="$SELECTED_PROVIDER" CAP_IMAGE_PLATFORM="$CAP_IMAGE_PLATFORM" docker compose -f "$COMPOSE" up -d "${services[@]}"
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

✅ cap is up (source-free, PREBUILT images, legacy-token auth).
   version: ${ver}
   provider: ${SELECTED_PROVIDER}
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
  if [ "$SELECTED_PROVIDER" = "control-plane" ]; then
    warn "RUN_SMOKE=1 but CAP_SANDBOX_PROVIDER=control-plane — SKIPPING the provision smoke."
  elif [ -z "${CAP_SMOKE_REPO_ID:-}" ]; then
    warn "RUN_SMOKE=1 but CAP_SMOKE_REPO_ID is unset — SKIPPING the provision smoke."
    warn "  (import/select a repo, then set CAP_SMOKE_REPO_ID to enable it.)"
  else
    auth="Authorization: Bearer ${TOKEN}"
    tid="$(curl -fsS -X POST "http://localhost:${API_PORT}/repos/${CAP_SMOKE_REPO_ID}/tasks" \
      -H "$auth" -H 'content-type: application/json' \
      -d '{"prompt":"provision smoke (quick-deploy.sh) - confirm the sandbox provider is runnable"}' \
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
