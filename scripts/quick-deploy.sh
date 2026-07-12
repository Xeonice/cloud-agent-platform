#!/usr/bin/env bash
#
# quick-deploy.sh — agent-drivable, source-free, local-account self-host of cap
# from the PREBUILT GHCR release images.
#
# WHY this exists (agent-oneclick-deploy): the public one-line install path must run
# the RELEASE artifacts, not rebuild an unversioned local source image. This script
# runs the published `ghcr.io/xeonice/cap-*:${CAP_VERSION}` images and SYNTHESIZES
# or updates a local-account `.env` so they boot with email/password login and no
# GitHub OAuth app. macOS defaults to a BoxLite-backed sandbox provider; Linux
# defaults to AIO. Both still run the prebuilt api/web image.
#
# TRUST BOUNDARY — in AIO mode this path is HOST-ROOT-EQUIVALENT: the api mounts
# the host `/var/run/docker.sock` to provision sandboxes, so whoever can log in can
# run as root on this host. The prebuilt `cap-web` console bakes its VITE_* to
# localhost at build time, so the in-compose web is only correct for a SAME-HOST
# trial.
#
# It is structured as GATES: each phase fails LOUD and EARLY with a precise
# remediation, so a failure is a clean stop point rather than a half-bootstrapped
# host.
#
#   scripts/quick-deploy.sh                 # localhost trial, web on :3000
#   CAP_VERSION=v0.24.0 scripts/quick-deploy.sh
#   CAP_SANDBOX_PROVIDER=boxlite BOXLITE_ENDPOINT=... BOXLITE_API_TOKEN=... scripts/quick-deploy.sh
#   BOXLITE_ENDPOINT=http://host.docker.internal:7331 BOXLITE_READINESS_ENDPOINT=http://127.0.0.1:7331 ...
#   WITH_WEB=0 scripts/quick-deploy.sh      # api + postgres only (no console)
#   CAP_SMOKE_REPO_ID=<id> CAP_SMOKE_COOKIE=<cap_session> RUN_SMOKE=1 scripts/quick-deploy.sh
#
set -euo pipefail

# ── Tunables (env-overridable) ────────────────────────────────────────────────
REQUESTED_CAP_VERSION="${CAP_VERSION:-latest}" # latest resolves to the latest GitHub Release tag
CAP_VERSION="$REQUESTED_CAP_VERSION"
WORKDIR="${CAP_WORKDIR:-$PWD}"          # where .env + the compose file live / are written
API_PORT="${API_PORT:-8080}"
WEB_PORT="${WEB_PORT:-3000}"
WITH_WEB="${WITH_WEB:-1}"               # 1 = bring up the in-compose console
RUN_SMOKE="${RUN_SMOKE:-0}"            # 1 = create+stop a throwaway task as a provision smoke
RUN_GITHUB_VALIDATION="${RUN_GITHUB_VALIDATION:-0}" # 1 = validate GitHub API reachability/auth
REQUESTED_PROVIDER="${CAP_SANDBOX_PROVIDER:-auto}" # auto|aio|boxlite|control-plane
REQUESTED_SANDBOX_IMAGE_DELIVERY="${CAP_SANDBOX_IMAGE_DELIVERY:-auto}" # auto|registry|release-assets
CAP_IMAGE_PLATFORM="${CAP_IMAGE_PLATFORM:-}"       # defaulted for non-amd64 release images below
CAP_HEALTH_TIMEOUT_SECONDS="${CAP_HEALTH_TIMEOUT_SECONDS:-}" # defaulted after platform detection
GITHUB_RELEASES_REPO="${GITHUB_RELEASES_REPO:-Xeonice/cloud-agent-platform}"
BOXLITE_DEFAULT_IMAGE_REPO="${BOXLITE_DEFAULT_IMAGE_REPO:-ghcr.io/xeonice/cap-boxlite-sandbox}"
BOXLITE_DEFAULT_WORKSPACE_PATH="/home/gem/workspace"
BOXLITE_DEFAULT_RUNTIME_REQUIRED_TOOLS="bash claude codex git gzip node openspec sh tar tmux"
BOXLITE_RUNTIME_PROBE_CREATE_TIMEOUT_SECONDS="${BOXLITE_RUNTIME_PROBE_CREATE_TIMEOUT_SECONDS:-600}"
BOXLITE_RUNTIME_PROBE_START_TIMEOUT_SECONDS="${BOXLITE_RUNTIME_PROBE_START_TIMEOUT_SECONDS:-120}"
BOXLITE_RUNTIME_PROBE_EXEC_TIMEOUT_SECONDS="${BOXLITE_RUNTIME_PROBE_EXEC_TIMEOUT_SECONDS:-60}"
BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS="${BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS:-30}"
CAP_SANDBOX_ASSET_DIR="${CAP_SANDBOX_ASSET_DIR:-$WORKDIR/sandbox-assets}"
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

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
REPO_ROOT=""
if [ -n "$SCRIPT_SOURCE" ] && [ "$SCRIPT_SOURCE" != "-" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

step(){ printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn(){ printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
die(){ printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

load_preflight_helpers(){
  local tmp urls url
  if [ -n "${CAP_PREFLIGHT_LIB_PATH:-}" ]; then
    # shellcheck disable=SC1090
    . "$CAP_PREFLIGHT_LIB_PATH"
    return
  fi
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/install-preflight.sh" ]; then
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/install-preflight.sh"
    return
  fi
  if [ -n "$SCRIPT_DIR" ] && [ -f "$REPO_ROOT/scripts/install-preflight.sh" ]; then
    # shellcheck disable=SC1091
    . "$REPO_ROOT/scripts/install-preflight.sh"
    return
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required to fetch install preflight helpers"
  tmp="${TMPDIR:-/tmp}/cap-install-preflight.$$"
  urls=()
  [ -n "${CAP_PREFLIGHT_LIB_URL:-}" ] && urls+=("$CAP_PREFLIGHT_LIB_URL")
  urls+=("${RAW_BASE%/}/install-preflight.sh" "${RAW_BASE%/}/scripts/install-preflight.sh")
  for url in "${urls[@]}"; do
    if curl -fsSL "$url" -o "$tmp" >/dev/null 2>&1; then
      # shellcheck disable=SC1090
      . "$tmp"
      rm -f "$tmp"
      return
    fi
  done
  rm -f "$tmp"
  die "could not load install preflight helpers; set CAP_PREFLIGHT_LIB_URL or run the site install.sh wrapper"
}

load_preflight_helpers

host_os(){ [ -n "${CAP_TEST_UNAME:-}" ] && echo "$CAP_TEST_UNAME" || uname -s 2>/dev/null || echo unknown; }
host_arch(){ [ -n "${CAP_TEST_ARCH:-}" ] && echo "$CAP_TEST_ARCH" || uname -m 2>/dev/null || echo unknown; }
is_amd64(){
  case "$1" in
    x86_64|amd64) return 0 ;;
    *) return 1 ;;
  esac
}
is_arm64(){
  case "$1" in
    arm64|aarch64) return 0 ;;
    *) return 1 ;;
  esac
}
is_positive_integer(){
  case "$1" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}
validate_boxlite_runtime_probe_timeouts(){
  local name value
  for name in \
    BOXLITE_RUNTIME_PROBE_CREATE_TIMEOUT_SECONDS \
    BOXLITE_RUNTIME_PROBE_START_TIMEOUT_SECONDS \
    BOXLITE_RUNTIME_PROBE_EXEC_TIMEOUT_SECONDS \
    BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS
  do
    value="${!name}"
    is_positive_integer "$value" || die "$name must be a positive integer number of seconds"
  done
}
normalize_provider(){
  case "${1:-auto}" in
    auto|aio|boxlite|control-plane) printf '%s\n' "${1:-auto}" ;;
    *) die "invalid CAP_SANDBOX_PROVIDER: $1 (expected auto|aio|boxlite|control-plane)" ;;
  esac
}
normalize_boxlite_protocol(){
  case "${1:-native}" in
    native|cap-rest) printf '%s\n' "${1:-native}" ;;
    rest|adapter|compat) printf '%s\n' "cap-rest" ;;
    *) die "invalid BOXLITE_PROTOCOL_MODE: $1 (expected native|cap-rest)" ;;
  esac
}
normalize_sandbox_image_delivery(){
  case "${1:-auto}" in
    auto|registry|release-assets) printf '%s\n' "${1:-auto}" ;;
    *) die "invalid CAP_SANDBOX_IMAGE_DELIVERY: $1 (expected auto|registry|release-assets)" ;;
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

maybe_stop_after(){
  if [ "${CAP_QUICK_DEPLOY_STOP_AFTER:-}" = "$1" ]; then
    echo "  CAP_QUICK_DEPLOY_STOP_AFTER=$1 — stopping before later gates."
    exit 0
  fi
}
resolve_health_timeout(){
  if [ -n "$CAP_HEALTH_TIMEOUT_SECONDS" ]; then
    is_positive_integer "$CAP_HEALTH_TIMEOUT_SECONDS" || \
      die "CAP_HEALTH_TIMEOUT_SECONDS must be a positive integer number of seconds"
    printf '%s\n' "$CAP_HEALTH_TIMEOUT_SECONDS"
    return
  fi
  if is_arm64 "$HOST_ARCH" && [ "${CAP_IMAGE_PLATFORM:-}" = "linux/amd64" ]; then
    # Published release images are amd64-only today; nested macOS/Colima/QEMU
    # emulation can take several minutes to finish Node startup after compose up.
    printf '%s\n' "600"
  else
    printf '%s\n' "120"
  fi
}

# ── GATE 1 — platform + sandbox provider ───────────────────────────────────────
step "GATE 1 — platform/provider"
HOST_OS="$(host_os)"
HOST_ARCH="$(host_arch)"
SELECTED_PROVIDER="$(resolve_provider "$REQUESTED_PROVIDER")"
SANDBOX_IMAGE_DELIVERY="$(normalize_sandbox_image_delivery "$REQUESTED_SANDBOX_IMAGE_DELIVERY")"
[ "$SELECTED_PROVIDER" != "boxlite" ] || validate_boxlite_runtime_probe_timeouts
echo "  host: ${HOST_OS}/${HOST_ARCH}"
echo "  sandbox provider: ${SELECTED_PROVIDER} (requested: ${REQUESTED_PROVIDER})"
echo "  sandbox image delivery: ${SANDBOX_IMAGE_DELIVERY} (requested: ${REQUESTED_SANDBOX_IMAGE_DELIVERY})"

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
HEALTH_TIMEOUT_SECONDS="$(resolve_health_timeout)"

if [ "$SELECTED_PROVIDER" = "aio" ] && ! is_amd64 "$HOST_ARCH"; then
  die "AIO sandbox staging is only supported on an amd64/x86_64 host by default.
       This host is ${HOST_OS}/${HOST_ARCH}. Use the macOS prebuilt path with:
       CAP_SANDBOX_PROVIDER=boxlite BOXLITE_ENDPOINT=... BOXLITE_API_TOKEN=... BOXLITE_IMAGE=...
       or set CAP_SANDBOX_PROVIDER=control-plane for api-only."
fi
export CAP_SANDBOX_PROVIDER="$SELECTED_PROVIDER"

# ── GATE 2 — base tooling ──────────────────────────────────────────────────────
step "GATE 2 — base tooling"
cap_print_dependency_report
cap_require_tools curl openssl awk
cap_ensure_docker
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
engine_ok(){ cap_run_with_timeout 12 docker info >/dev/null 2>&1; }
if ! engine_ok; then
  echo "  engine unreachable on the active context — attempting self-heal…"
  # A) a non-default context (e.g. desktop-linux) may already be live.
  for ctx in $(docker context ls --format '{{.Name}}' 2>/dev/null); do
    [ "$ctx" = "default" ] && continue
    if cap_run_with_timeout 12 docker --context "$ctx" info >/dev/null 2>&1; then
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
COMPOSE_MANAGED_MARKER="cap-managed-run-package: docker-compose.prod.yml"
QUICK_DEPLOY_ROLLBACK_DIR="$(mktemp -d "${WORKDIR}/.cap-quick-deploy-rollback.XXXXXX")"
QUICK_DEPLOY_TRANSACTION_ACTIVE=1
QUICK_DEPLOY_COMPOSE_EXISTED=0
QUICK_DEPLOY_ENV_SNAPSHOT_READY=0
QUICK_DEPLOY_ENV_EXISTED=0
if [ -f "$COMPOSE" ]; then
  cp -p "$COMPOSE" "$QUICK_DEPLOY_ROLLBACK_DIR/docker-compose.prod.yml"
  QUICK_DEPLOY_COMPOSE_EXISTED=1
fi
finish_quick_deploy_transaction(){
  local status="$?"
  trap - EXIT
  if [ "$QUICK_DEPLOY_TRANSACTION_ACTIVE" = "1" ] && [ "$status" -ne 0 ]; then
    if [ "$QUICK_DEPLOY_COMPOSE_EXISTED" = "1" ]; then
      cp -p "$QUICK_DEPLOY_ROLLBACK_DIR/docker-compose.prod.yml" "$COMPOSE"
    else
      rm -f "$COMPOSE"
    fi
    if [ "$QUICK_DEPLOY_ENV_SNAPSHOT_READY" = "1" ]; then
      if [ "$QUICK_DEPLOY_ENV_EXISTED" = "1" ]; then
        cp -p "$QUICK_DEPLOY_ROLLBACK_DIR/env" "$ENV_FILE"
      else
        rm -f "$ENV_FILE"
      fi
    fi
    warn "restored compose/.env after a failed pre-deploy gate"
  fi
  rm -rf "$QUICK_DEPLOY_ROLLBACK_DIR"
  exit "$status"
}
commit_quick_deploy_transaction(){
  QUICK_DEPLOY_TRANSACTION_ACTIVE=0
  rm -rf "$QUICK_DEPLOY_ROLLBACK_DIR"
  trap - EXIT
}
trap finish_quick_deploy_transaction EXIT
compose_is_managed(){
  [ -f "$1" ] && grep -q "$COMPOSE_MANAGED_MARKER" "$1"
}
compose_refresh_forced(){
  case "${CAP_COMPOSE_REFRESH:-}" in
    1|true|TRUE|yes|YES|force|FORCE|always|ALWAYS) return 0 ;;
    *) return 1 ;;
  esac
}
compose_backup(){
  local file="$1" backup
  backup="${file}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$file" "$backup"
  echo "  backed up existing compose to $backup"
}
fetch_current_compose(){
  local target="$1"
  if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/docker-compose.prod.yml" ]; then
    cp "$REPO_ROOT/docker-compose.prod.yml" "$target"
    echo "  loaded current docker-compose.prod.yml from repo"
  else
    echo "  downloading docker-compose.prod.yml from $RAW_BASE …"
    curl -fsSL "$RAW_BASE/docker-compose.prod.yml" -o "$target" \
      || die "could not download docker-compose.prod.yml from $RAW_BASE"
  fi
  compose_is_managed "$target" || \
    die "fetched docker-compose.prod.yml is missing the CAP managed marker; refusing to run an unverifiable run package"
}

CURRENT_COMPOSE_TMP="${WORKDIR}/.docker-compose.prod.yml.captmp.$$"
fetch_current_compose "$CURRENT_COMPOSE_TMP"

if [ -f "$COMPOSE" ]; then
  if cmp -s "$COMPOSE" "$CURRENT_COMPOSE_TMP"; then
    echo "  existing $COMPOSE is current"
    rm -f "$CURRENT_COMPOSE_TMP"
  elif compose_is_managed "$COMPOSE"; then
    compose_backup "$COMPOSE"
    mv "$CURRENT_COMPOSE_TMP" "$COMPOSE"
    echo "  refreshed managed $COMPOSE"
  elif compose_refresh_forced; then
    warn "$COMPOSE has no CAP managed marker; CAP_COMPOSE_REFRESH=${CAP_COMPOSE_REFRESH} allows replacement."
    compose_backup "$COMPOSE"
    mv "$CURRENT_COMPOSE_TMP" "$COMPOSE"
    echo "  replaced user-managed $COMPOSE by explicit request"
  else
    rm -f "$CURRENT_COMPOSE_TMP"
    die "$COMPOSE already exists but has no CAP managed marker.
       Refusing to overwrite a user-managed compose file. Move it aside or set CAP_COMPOSE_REFRESH=force."
  fi
else
  mv "$CURRENT_COMPOSE_TMP" "$COMPOSE"
  echo "  wrote managed $COMPOSE"
fi
maybe_stop_after run-package

# ── GATE 5 — synthesize/update a local-account .env (non-destructive) ──────────
# prod.yml's api uses env_file:.env, so this .env makes the PREBUILT image boot
# with local email/password auth and without a GitHub OAuth app. Existing secrets
# are preserved; missing local-account secrets are generated; non-secret
# operational keys such as CAP_VERSION/provider are corrected to match this run so
# /version cannot remain unknown.
step "GATE 5 — local-account .env"
ENV_FILE="$WORKDIR/.env"
if [ -f "$ENV_FILE" ]; then
  cp -p "$ENV_FILE" "$QUICK_DEPLOY_ROLLBACK_DIR/env"
  QUICK_DEPLOY_ENV_EXISTED=1
fi
QUICK_DEPLOY_ENV_SNAPSHOT_READY=1
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
value_or_default(){
  local key="$1" fallback="$2" value
  value="$(value_for "$key")"
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$fallback"
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
unset_env_value(){
  local key="$1" tmp
  [ -f "$ENV_FILE" ] || return 0
  has_env_key "$key" || return 0
  tmp="${ENV_FILE}.captmp"
  awk -F= -v k="$key" '$1 != k { print }' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$ENV_FILE"
  echo "  unset $key in $ENV_FILE"
}
require_value(){
  local key="$1" value
  value="$(value_for "$key")"
  [ -n "$value" ] || die "$key is required for CAP_SANDBOX_PROVIDER=$SELECTED_PROVIDER"
  printf '%s\n' "$value"
}
boxlite_default_readiness_endpoint(){
  local endpoint="$1"
  case "$endpoint" in
    http://host.docker.internal*)
      printf 'http://127.0.0.1%s\n' "${endpoint#http://host.docker.internal}"
      ;;
    https://host.docker.internal*)
      printf 'https://127.0.0.1%s\n' "${endpoint#https://host.docker.internal}"
      ;;
    *)
      printf '%s\n' "$endpoint"
      ;;
  esac
}
boxlite_readiness_endpoint_value(){
  local runtime_endpoint="$1" configured
  configured="$(value_for BOXLITE_READINESS_ENDPOINT)"
  if [ -n "$configured" ]; then
    printf '%s\n' "$configured"
  else
    boxlite_default_readiness_endpoint "$runtime_endpoint"
  fi
}
boxlite_endpoint_is_local_host(){
  case "$1" in
    http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*|https://127.0.0.1|https://127.0.0.1:*|https://127.0.0.1/*|\
    http://localhost|http://localhost:*|http://localhost/*|https://localhost|https://localhost:*|https://localhost/*|\
    http://[::1]|http://[::1]:*|http://[::1]/*|https://[::1]|https://[::1]:*|https://[::1]/*|\
    http://0.0.0.0|http://0.0.0.0:*|http://0.0.0.0/*|https://0.0.0.0|https://0.0.0.0:*|https://0.0.0.0/*|\
    http://host.docker.internal|http://host.docker.internal:*|http://host.docker.internal/*|https://host.docker.internal|https://host.docker.internal:*|https://host.docker.internal/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}
boxlite_macos_product_version(){
  if [ -n "${CAP_TEST_MACOS_VERSION:-}" ]; then
    printf '%s\n' "$CAP_TEST_MACOS_VERSION"
  elif command -v sw_vers >/dev/null 2>&1; then
    sw_vers -productVersion 2>/dev/null || true
  fi
}
boxlite_macos_hv_support(){
  if [ -n "${CAP_TEST_KERN_HV_SUPPORT+x}" ]; then
    printf '%s\n' "$CAP_TEST_KERN_HV_SUPPORT"
  elif command -v sysctl >/dev/null 2>&1; then
    sysctl -n kern.hv_support 2>/dev/null || true
  fi
}
boxlite_kvm_device_path(){
  printf '%s\n' "${CAP_TEST_DEV_KVM_PATH:-/dev/kvm}"
}
validate_boxlite_local_host_dependencies(){
  local readiness_endpoint="$1" os arch version major hv_support kvm_device
  if ! boxlite_endpoint_is_local_host "$readiness_endpoint"; then
    echo "  BoxLite host dependencies: external endpoint; local Hypervisor/KVM check skipped"
    return 0
  fi
  os="$(host_os)"
  arch="$(host_arch)"
  case "$os" in
    Darwin)
      if ! is_arm64 "$arch"; then
        die "BoxLite local control plane requires Apple Silicon arm64; this host is ${os}/${arch}. Use a supported Mac or set BOXLITE_ENDPOINT to a reachable external BoxLite host."
      fi
      version="$(boxlite_macos_product_version)"
      major="$(printf '%s\n' "$version" | awk -F. '{ print $1; exit }')"
      if ! is_positive_integer "$major" || [ "$major" -lt 12 ]; then
        die "BoxLite local control plane requires macOS 12.0+; this host reports macOS ${version:-unknown}. Use a supported Mac or set BOXLITE_ENDPOINT to a reachable external BoxLite host."
      fi
      hv_support="$(boxlite_macos_hv_support)"
      if [ "$hv_support" != "1" ]; then
        die "BoxLite local control plane requires Apple Hypervisor.framework (kern.hv_support=1); this host reports kern.hv_support=${hv_support:-unknown}. Nested macOS VMs can report 0; run BoxLite on a physical Apple Silicon host or set BOXLITE_ENDPOINT to a reachable external BoxLite host."
      fi
      echo "  BoxLite host dependencies: macOS ${version} Apple Silicon with Hypervisor.framework available"
      ;;
    Linux)
      kvm_device="$(boxlite_kvm_device_path)"
      if [ ! -e "$kvm_device" ]; then
        die "BoxLite local control plane requires Linux KVM; ${kvm_device} is missing. Enable hardware virtualization/KVM, load the KVM module, or set BOXLITE_ENDPOINT to a reachable external BoxLite host."
      fi
      if [ ! -r "$kvm_device" ] || [ ! -w "$kvm_device" ]; then
        die "BoxLite local control plane requires read/write access to ${kvm_device}. Fix KVM permissions, add this user to the kvm group and start a new session, or set BOXLITE_ENDPOINT to a reachable external BoxLite host."
      fi
      echo "  BoxLite host dependencies: Linux KVM device accessible at ${kvm_device}"
      ;;
    *)
      die "BoxLite local control plane is supported only on macOS Apple Silicon or Linux/WSL2 with KVM; this host is ${os}/${arch}. Set BOXLITE_ENDPOINT to a reachable external BoxLite host."
      ;;
  esac
}
json_escape(){
  printf '%s' "$1" | awk '
    BEGIN { ORS = "" }
    {
      gsub(/\\/, "\\\\")
      gsub(/"/, "\\\"")
      printf "%s", $0
    }
  '
}
shell_quote(){
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
boxlite_runtime_required_tools(){
  value_or_default BOXLITE_RUNTIME_REQUIRED_TOOLS "$BOXLITE_DEFAULT_RUNTIME_REQUIRED_TOOLS" \
    | tr ',' ' ' \
    | awk '
      {
        for (i = 1; i <= NF; i++) {
          if ($i != "" && !seen[$i]++) print $i
        }
      }
    '
}
boxlite_default_image(){
  printf '%s:%s\n' "$BOXLITE_DEFAULT_IMAGE_REPO" "$CAP_VERSION"
}
boxlite_default_map_value(){
  local raw="$1"
  case "$raw" in
    \{*)
      printf '%s\n' "$raw" | sed -n 's/.*"default"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
      ;;
    *)
      printf '%s\n' "$raw" | sed -n 's/.*default=\([^,]*\).*/\1/p' | head -1
      ;;
  esac
}
boxlite_default_rootfs_path(){
  local value map_value
  value="$(value_for BOXLITE_ROOTFS_PATH)"
  [ -n "$value" ] && { printf '%s\n' "$value"; return 0; }
  map_value="$(boxlite_default_map_value "$(value_for BOXLITE_ROOTFS_PATH_MAP)")"
  [ -n "$map_value" ] && { printf '%s\n' "$map_value"; return 0; }
  return 0
}
boxlite_default_image_value(){
  local value map_value
  value="$(value_for BOXLITE_IMAGE)"
  [ -n "$value" ] && { printf '%s\n' "$value"; return 0; }
  map_value="$(boxlite_default_map_value "$(value_for BOXLITE_IMAGE_MAP)")"
  [ -n "$map_value" ] && { printf '%s\n' "$map_value"; return 0; }
  return 0
}
release_asset_base(){
  printf '%s\n' "${CAP_RELEASE_ASSET_BASE:-https://github.com/${GITHUB_RELEASES_REPO}/releases/download/${CAP_VERSION}}"
}
release_asset_url(){
  printf '%s/%s\n' "$(release_asset_base | sed 's:/*$::')" "$1"
}
download_release_asset(){
  local name target tmp url
  name="$1"
  target="$2"
  mkdir -p "$(dirname "$target")"
  tmp="${target}.captmp"
  url="$(release_asset_url "$name")"
  echo "  sandbox asset: downloading ${name}" >&2
  rm -f "$tmp"
  curl -fL --retry 3 -o "$tmp" "$url" >/dev/null 2>&1 || {
    rm -f "$tmp"
    return 1
  }
  [ -f "$tmp" ] || return 1
  mv "$tmp" "$target"
}
sha256_of_file(){
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    die "sha256sum or shasum is required to verify sandbox image Release assets"
  fi
}
sha256_of_stream(){
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{ print $1 }'
  else
    die "sha256sum or shasum is required to verify sandbox image Release assets"
  fi
}
verify_asset_checksum(){
  local asset_path checksum_path expected actual
  asset_path="$1"
  checksum_path="$2"
  [ -f "$asset_path" ] || die "sandbox image asset missing after download: $asset_path"
  [ -f "$checksum_path" ] || die "sandbox image checksum missing after download: $checksum_path"
  expected="$(awk '{ print $1; exit }' "$checksum_path")"
  actual="$(sha256_of_file "$asset_path")"
  [ -n "$expected" ] || die "sandbox image checksum file is empty: $checksum_path"
  [ "$actual" = "$expected" ] || die "sandbox image asset checksum mismatch for $(basename "$asset_path")"
  echo "  sandbox asset: checksum verified for $(basename "$asset_path")" >&2
}
fetch_asset_manifest(){
  local manifest_path
  manifest_path="${CAP_SANDBOX_ASSET_DIR}/downloads/${CAP_VERSION}/cap-image-assets.json"
  download_release_asset cap-image-assets.json "$manifest_path" || return 1
  grep -q "\"version\"[[:space:]]*:[[:space:]]*\"${CAP_VERSION}\"" "$manifest_path" || return 1
  printf '%s\n' "$manifest_path"
}
asset_manifest_contains(){
  local manifest_path="$1" asset_name="$2"
  grep -F '"asset"' "$manifest_path" | grep -Fq "\"${asset_name}\""
}
stage_release_asset_pair(){
  local manifest_path asset_name asset_path checksum_path
  manifest_path="$1"
  asset_name="$2"
  asset_manifest_contains "$manifest_path" "$asset_name" || return 1
  asset_path="${CAP_SANDBOX_ASSET_DIR}/downloads/${CAP_VERSION}/${asset_name}"
  checksum_path="${asset_path}.sha256"
  download_release_asset "$asset_name" "$asset_path" || return 1
  download_release_asset "${asset_name}.sha256" "$checksum_path" || return 1
  verify_asset_checksum "$asset_path" "$checksum_path"
  printf '%s\n' "$asset_path"
}
stream_release_asset(){
  local source="$1" part
  case "$source" in
    *.parts)
      while IFS= read -r part; do
        [ -f "$part" ] || return 1
        cat "$part" || return 1
      done < "$source"
      ;;
    *)
      cat "$source"
      ;;
  esac
}
stage_release_asset_source(){
  local manifest_path asset_name download_dir part_name part_path descriptor descriptor_tmp
  local checksum_path expected actual index
  manifest_path="$1"
  asset_name="$2"
  download_dir="${CAP_SANDBOX_ASSET_DIR}/downloads/${CAP_VERSION}"
  part_name="${asset_name}.part-0001"

  if ! asset_manifest_contains "$manifest_path" "$part_name"; then
    stage_release_asset_pair "$manifest_path" "$asset_name"
    return
  fi

  descriptor="${download_dir}/${asset_name}.parts"
  descriptor_tmp="${descriptor}.captmp"
  checksum_path="${download_dir}/${asset_name}.sha256"
  rm -f "$descriptor" "$descriptor_tmp"
  : > "$descriptor_tmp"
  index=1
  while :; do
    part_name="${asset_name}.part-$(printf '%04d' "$index")"
    asset_manifest_contains "$manifest_path" "$part_name" || break
    part_path="$(stage_release_asset_pair "$manifest_path" "$part_name")" || {
      rm -f "$descriptor_tmp"
      return 1
    }
    printf '%s\n' "$part_path" >> "$descriptor_tmp"
    index=$((index + 1))
  done
  [ "$index" -gt 1 ] || {
    rm -f "$descriptor_tmp"
    return 1
  }
  download_release_asset "${asset_name}.sha256" "$checksum_path" || {
    rm -f "$descriptor_tmp"
    return 1
  }
  mv "$descriptor_tmp" "$descriptor"
  expected="$(awk '{ print $1; exit }' "$checksum_path")"
  actual="$(stream_release_asset "$descriptor" | sha256_of_stream)" || {
    rm -f "$descriptor"
    return 1
  }
  [ -n "$expected" ] && [ "$actual" = "$expected" ] || {
    rm -f "$descriptor"
    die "sandbox image asset checksum mismatch for ${asset_name} parts"
  }
  echo "  sandbox asset: combined checksum verified for ${asset_name} parts" >&2
  printf '%s\n' "$descriptor"
}
boxlite_asset_platform_slug(){
  if is_arm64 "$HOST_ARCH"; then
    printf '%s\n' "linux-arm64"
  else
    printf '%s\n' "linux-amd64"
  fi
}
boxlite_managed_rootfs_path(){
  printf '%s/boxlite/cap-boxlite-sandbox/%s/%s/oci\n' \
    "${CAP_SANDBOX_ASSET_DIR%/}" "$CAP_VERSION" "$(boxlite_asset_platform_slug)"
}
boxlite_rootfs_path_is_managed(){
  local path="$1" prefix remainder version suffix
  [ -n "$path" ] || return 1
  prefix="${CAP_SANDBOX_ASSET_DIR%/}/boxlite/cap-boxlite-sandbox/"
  case "$path" in
    "$prefix"*) ;;
    *) return 1 ;;
  esac
  remainder="${path#"$prefix"}"
  version="${remainder%%/*}"
  [ -n "$version" ] && [ "$remainder" != "$version" ] || return 1
  suffix="${remainder#*/}"
  case "$suffix" in
    linux-amd64/oci|linux-arm64/oci) return 0 ;;
    *) return 1 ;;
  esac
}
boxlite_managed_rootfs_is_complete(){
  [ -f "$1/oci-layout" ]
}
stage_aio_release_asset(){
  local manifest_path asset_name asset_source image
  manifest_path="$(fetch_asset_manifest)" || return 1
  asset_name="cap-aio-sandbox-${CAP_VERSION}-linux-amd64.docker.tar.zst"
  asset_source="$(stage_release_asset_source "$manifest_path" "$asset_name")" || return 1
  command -v zstd >/dev/null 2>&1 || die "zstd is required to load AIO sandbox Release assets"
  echo "  AIO readiness: loading sandbox Docker archive from Release asset"
  stream_release_asset "$asset_source" | zstd -dc | docker load >/dev/null || \
    die "AIO readiness failed: could not docker load ${asset_name}"
  image="ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}"
  docker image inspect "$image" >/dev/null 2>&1 || \
    die "AIO readiness failed: loaded archive did not provide ${image}"
  echo "  AIO readiness: staged ${image} from Release asset"
}
stage_boxlite_release_asset(){
  local manifest_path slug asset_name asset_source rootfs_dir tmp_dir parent
  manifest_path="$(fetch_asset_manifest)" || return 1
  slug="$(boxlite_asset_platform_slug)"
  asset_name="cap-boxlite-sandbox-${CAP_VERSION}-${slug}.oci.tar.zst"
  asset_source="$(stage_release_asset_source "$manifest_path" "$asset_name")" || return 1
  command -v zstd >/dev/null 2>&1 || die "zstd is required to extract BoxLite sandbox Release assets"
  command -v tar >/dev/null 2>&1 || die "tar is required to extract BoxLite sandbox Release assets"
  rootfs_dir="$(boxlite_managed_rootfs_path)"
  tmp_dir="${rootfs_dir}.captmp.$$"
  parent="$(dirname "$rootfs_dir")"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir" "$parent"
  echo "  BoxLite readiness: extracting sandbox OCI asset to ${rootfs_dir}" >&2
  stream_release_asset "$asset_source" | zstd -dc | tar -C "$tmp_dir" -xf - || {
    rm -rf "$tmp_dir"
    die "BoxLite readiness failed: could not extract ${asset_name}"
  }
  rm -rf "$rootfs_dir"
  mv "$tmp_dir" "$rootfs_dir"
  printf '%s\n' "$rootfs_dir"
}
try_stage_boxlite_release_asset(){
  if [ "$SANDBOX_IMAGE_DELIVERY" = "registry" ]; then
    return 1
  fi
  if rootfs_path="$(stage_boxlite_release_asset)"; then
    BOXLITE_STAGED_ROOTFS_PATH="$rootfs_path"
    SANDBOX_IMAGE_DELIVERY_EFFECTIVE="release-assets"
    return 0
  fi
  [ "$SANDBOX_IMAGE_DELIVERY" = "release-assets" ] && \
    die "BoxLite sandbox Release-asset delivery failed; set CAP_SANDBOX_IMAGE_DELIVERY=registry to use GHCR image pulls"
  warn "BoxLite sandbox Release asset unavailable; falling back to registry delivery"
  SANDBOX_IMAGE_DELIVERY_EFFECTIVE="registry"
  return 1
}
maybe_stage_aio_release_asset(){
  [ "$SELECTED_PROVIDER" = "aio" ] || return 0
  [ "$SANDBOX_IMAGE_DELIVERY" = "release-assets" ] || {
    SANDBOX_IMAGE_DELIVERY_EFFECTIVE="registry"
    return 0
  }
  stage_aio_release_asset || \
    die "AIO sandbox Release-asset delivery failed; set CAP_SANDBOX_IMAGE_DELIVERY=registry to use GHCR image pulls"
  SANDBOX_IMAGE_DELIVERY_EFFECTIVE="release-assets"
}
boxlite_required_tools_probe_command(){
  local tool command
  command=""
  for tool in $(boxlite_runtime_required_tools); do
    case "$tool" in
      *[!A-Za-z0-9._+-]*|"")
        die "BOXLITE_RUNTIME_REQUIRED_TOOLS contains invalid tool name: $tool"
        ;;
    esac
    if [ -z "$command" ]; then
      command="command -v $(shell_quote "$tool")"
    else
      command="${command} && command -v $(shell_quote "$tool")"
    fi
  done
  [ -n "$command" ] || die "BOXLITE_RUNTIME_REQUIRED_TOOLS must include at least one tool"
  printf '%s\n' "$command"
}
if [ -f "$ENV_FILE" ]; then
  echo "  $ENV_FILE exists — preserving secrets and updating local-account pins."
else
  ( umask 077
    {
      printf '%s\n' "# Generated by scripts/quick-deploy.sh — PREBUILT images, local-account auth."
      printf '%s\n' "# Keep this file out of version control."
    } >"$ENV_FILE"
  )
  echo "  wrote $ENV_FILE (gitignored)"
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true

# Respect host-port pins already present in the run-package .env. This keeps the
# script's own health/version/login checks aligned with compose interpolation
# when the default 8080/3000 ports were moved aside for another local service.
API_HOST_PORT_VALUE="$(value_for API_HOST_PORT)"
[ -n "$API_HOST_PORT_VALUE" ] && API_PORT="$API_HOST_PORT_VALUE"
WEB_HOST_PORT_VALUE="$(value_for WEB_HOST_PORT)"
[ -n "$WEB_HOST_PORT_VALUE" ] && WEB_PORT="$WEB_HOST_PORT_VALUE"

ADMIN_EMAIL_VALUE="$(value_for ADMIN_EMAIL)"
[ -n "$ADMIN_EMAIL_VALUE" ] || ADMIN_EMAIL_VALUE="admin@example.com"

ADMIN_PASSWORD_VALUE="$(value_for ADMIN_PASSWORD)"
if [ -z "$ADMIN_PASSWORD_VALUE" ]; then
  ADMIN_PASSWORD_VALUE="cap_admin_$(openssl rand -hex 16)"
fi

SESSION_SECRET_VALUE="$(value_for SESSION_SECRET)"
[ -n "$SESSION_SECRET_VALUE" ] || SESSION_SECRET_VALUE="$(openssl rand -hex 32)"

CODEX_CRED_ENC_KEY_VALUE="$(value_for CODEX_CRED_ENC_KEY)"
[ -n "$CODEX_CRED_ENC_KEY_VALUE" ] || CODEX_CRED_ENC_KEY_VALUE="$(openssl rand -hex 32)"

set_env_value CAP_VERSION "$CAP_VERSION"
set_env_value CAP_SANDBOX_PROVIDER "$SELECTED_PROVIDER"
SANDBOX_IMAGE_DELIVERY_EFFECTIVE="$SANDBOX_IMAGE_DELIVERY"
set_env_value CAP_SANDBOX_IMAGE_DELIVERY "$SANDBOX_IMAGE_DELIVERY_EFFECTIVE"
[ -n "$CAP_IMAGE_PLATFORM" ] && set_env_value CAP_IMAGE_PLATFORM "$CAP_IMAGE_PLATFORM"
set_env_value ADMIN_EMAIL "$ADMIN_EMAIL_VALUE"
set_env_value ADMIN_PASSWORD "$ADMIN_PASSWORD_VALUE"
set_env_value PASSWORD_AUTH_ENABLED true
set_env_value AUTH_TOKEN_LEGACY_ENABLED false
set_env_value SESSION_SECRET "$SESSION_SECRET_VALUE"
set_env_value CODEX_CRED_ENC_KEY "$CODEX_CRED_ENC_KEY_VALUE"
set_env_value API_HOST_PORT "$API_PORT"
set_env_value WEB_HOST_PORT "$WEB_PORT"
set_env_value CAP_PUBLIC_API_PORT "$API_PORT"
set_env_value CAP_PUBLIC_WEB_PORT "$WEB_PORT"
set_env_value CAP_SERVER_API_BASE_URL "http://api:8080"
set_env_value WEB_ORIGIN "http://localhost:${WEB_PORT}"
set_env_value WEB_ORIGIN_AUTO_SAME_HOST true
set_env_value WEB_ORIGIN_AUTO_SAME_HOST_PORT "$WEB_PORT"
ADMIN_LOGIN_PAYLOAD="{\"email\":\"$(json_escape "$ADMIN_EMAIL_VALUE")\",\"password\":\"$(json_escape "$ADMIN_PASSWORD_VALUE")\"}"

if [ -n "$(env_file_value AUTH_TOKEN)" ]; then
  warn "AUTH_TOKEN remains in $ENV_FILE but AUTH_TOKEN_LEGACY_ENABLED=false disables legacy bearer auth for this install path."
fi

if [ "$SELECTED_PROVIDER" = "boxlite" ]; then
  boxlite_endpoint="$(require_value BOXLITE_ENDPOINT)"
  boxlite_readiness_endpoint="$(boxlite_readiness_endpoint_value "$boxlite_endpoint")"
  boxlite_token="$(require_value BOXLITE_API_TOKEN)"
  boxlite_rootfs_process_override="${BOXLITE_ROOTFS_PATH:-}"
  boxlite_rootfs_map_process_override="${BOXLITE_ROOTFS_PATH_MAP:-}"
  boxlite_image="$(value_for BOXLITE_IMAGE)"
  boxlite_image_map="$(value_for BOXLITE_IMAGE_MAP)"
  boxlite_rootfs_path="$(value_for BOXLITE_ROOTFS_PATH)"
  boxlite_rootfs_path_map="$(value_for BOXLITE_ROOTFS_PATH_MAP)"
  if [ -n "$boxlite_rootfs_process_override" ] && [ -z "$boxlite_rootfs_map_process_override" ]; then
    boxlite_rootfs_path_map=""
  elif [ -n "$boxlite_rootfs_map_process_override" ] && [ -z "$boxlite_rootfs_process_override" ]; then
    boxlite_rootfs_path=""
  fi
  if [ -z "$boxlite_rootfs_process_override" ] && \
    [ -z "$boxlite_rootfs_map_process_override" ] && \
    boxlite_rootfs_path_is_managed "$boxlite_rootfs_path"; then
    if [ "$SANDBOX_IMAGE_DELIVERY" = "registry" ]; then
      echo "  replacing managed BoxLite rootfs with registry delivery"
      boxlite_rootfs_path=""
    elif [ "$boxlite_rootfs_path" != "$(boxlite_managed_rootfs_path)" ]; then
      echo "  replacing stale managed BoxLite rootfs for CAP_VERSION=${CAP_VERSION}"
      boxlite_rootfs_path=""
    elif ! boxlite_managed_rootfs_is_complete "$boxlite_rootfs_path"; then
      echo "  restaging incomplete managed BoxLite rootfs for CAP_VERSION=${CAP_VERSION}"
      boxlite_rootfs_path=""
    fi
  fi
  if [ -n "$boxlite_rootfs_path" ] || [ -n "$boxlite_rootfs_path_map" ]; then
    SANDBOX_IMAGE_DELIVERY_EFFECTIVE="release-assets"
  elif try_stage_boxlite_release_asset; then
    boxlite_rootfs_path="$BOXLITE_STAGED_ROOTFS_PATH"
    boxlite_image=""
    boxlite_image_map=""
  elif [ -z "$boxlite_image" ] && [ -z "$boxlite_image_map" ]; then
    boxlite_image="$(boxlite_default_image)"
  fi
  boxlite_protocol_mode="$(value_for BOXLITE_PROTOCOL_MODE)"
  boxlite_protocol_mode="$(normalize_boxlite_protocol "$boxlite_protocol_mode")"
  if [ -n "$boxlite_rootfs_path" ] || [ -n "$boxlite_rootfs_path_map" ]; then
    [ "$boxlite_protocol_mode" = "native" ] || \
      die "BOXLITE_ROOTFS_PATH requires BOXLITE_PROTOCOL_MODE=native"
  fi
  [ -n "$boxlite_image" ] || [ -n "$boxlite_image_map" ] || [ -n "$boxlite_rootfs_path" ] || [ -n "$boxlite_rootfs_path_map" ] || \
    die "BOXLITE_IMAGE/BOXLITE_IMAGE_MAP or BOXLITE_ROOTFS_PATH/BOXLITE_ROOTFS_PATH_MAP is required for CAP_SANDBOX_PROVIDER=boxlite"
  if { [ -n "$boxlite_image" ] || [ -n "$boxlite_image_map" ]; } && { [ -n "$boxlite_rootfs_path" ] || [ -n "$boxlite_rootfs_path_map" ]; }; then
    die "BoxLite sandbox source is ambiguous: set image/image map or rootfs path/map, not both"
  fi
  set_env_value CAP_SANDBOX_IMAGE_DELIVERY "$SANDBOX_IMAGE_DELIVERY_EFFECTIVE"
  set_env_value BOXLITE_ENDPOINT "$boxlite_endpoint"
  if [ -n "$(value_for BOXLITE_READINESS_ENDPOINT)" ] || [ "$boxlite_readiness_endpoint" != "$boxlite_endpoint" ]; then
    set_env_value BOXLITE_READINESS_ENDPOINT "$boxlite_readiness_endpoint"
  fi
  set_env_value BOXLITE_API_TOKEN "$boxlite_token"
  if [ -n "$boxlite_rootfs_path" ] || [ -n "$boxlite_rootfs_path_map" ]; then
    unset_env_value BOXLITE_IMAGE
    unset_env_value BOXLITE_IMAGE_MAP
    if [ -n "$boxlite_rootfs_path" ]; then
      unset_env_value BOXLITE_ROOTFS_PATH_MAP
      set_env_value BOXLITE_ROOTFS_PATH "$boxlite_rootfs_path"
    else
      unset_env_value BOXLITE_ROOTFS_PATH
      set_env_value BOXLITE_ROOTFS_PATH_MAP "$boxlite_rootfs_path_map"
    fi
  else
    unset_env_value BOXLITE_ROOTFS_PATH
    unset_env_value BOXLITE_ROOTFS_PATH_MAP
    set_env_value BOXLITE_IMAGE "$boxlite_image"
    set_env_value BOXLITE_IMAGE_MAP "$boxlite_image_map"
  fi
  set_env_value BOXLITE_PROTOCOL_MODE "$boxlite_protocol_mode"
  set_env_value BOXLITE_RUNTIME_REQUIRED_TOOLS "$(boxlite_runtime_required_tools | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  set_env_value BOXLITE_PATH_PREFIX "$(value_or_default BOXLITE_PATH_PREFIX default)"
  set_env_value BOXLITE_PROVIDER_ID "$(value_or_default BOXLITE_PROVIDER_ID boxlite)"
  set_env_value BOXLITE_PROVIDER_PRIORITY "$(value_or_default BOXLITE_PROVIDER_PRIORITY 100)"
  set_env_value BOXLITE_PROVIDER_LOCATION "$(value_or_default BOXLITE_PROVIDER_LOCATION local)"
  set_env_value BOXLITE_WORKSPACE_PATH "$(value_or_default BOXLITE_WORKSPACE_PATH "$BOXLITE_DEFAULT_WORKSPACE_PATH")"
  set_env_value BOXLITE_SANDBOX_ID_PREFIX "$(value_or_default BOXLITE_SANDBOX_ID_PREFIX cap-boxlite-)"
  set_env_value BOXLITE_SANDBOX_PROXY "$(value_for BOXLITE_SANDBOX_PROXY)"
  set_env_value BOXLITE_SANDBOX_HTTP_PROXY "$(value_for BOXLITE_SANDBOX_HTTP_PROXY)"
  set_env_value BOXLITE_SANDBOX_HTTPS_PROXY "$(value_for BOXLITE_SANDBOX_HTTPS_PROXY)"
  set_env_value BOXLITE_SANDBOX_NO_PROXY "$(value_for BOXLITE_SANDBOX_NO_PROXY)"
  set_env_value BOXLITE_SANDBOX_MODE "$(value_or_default BOXLITE_SANDBOX_MODE workspace-write)"
  set_env_value BOXLITE_CLIENT_MODE "$(value_or_default BOXLITE_CLIENT_MODE rest)"
  set_env_value BOXLITE_TIMEOUT_MS "$(value_or_default BOXLITE_TIMEOUT_MS 30000)"
  set_env_value BOXLITE_TERMINAL_MODE "$(value_or_default BOXLITE_TERMINAL_MODE pty)"
  set_env_value BOXLITE_CAPABILITIES "$(value_or_default BOXLITE_CAPABILITIES terminal.websocket,terminal.interactive,command.exec,workspace.git.materialize,workspace.git.deliver,workspace.archive.transfer,lifecycle.readopt,lifecycle.readoption)"
fi
maybe_stage_aio_release_asset
set_env_value CAP_SANDBOX_IMAGE_DELIVERY "$SANDBOX_IMAGE_DELIVERY_EFFECTIVE"
maybe_stop_after env

github_validation_token(){
  if [ -n "${GITHUB_VALIDATION_TOKEN:-}" ]; then
    printf '%s\n' "$GITHUB_VALIDATION_TOKEN"
    return 0
  fi
  for file in "$WORKDIR/.env.github-validation" "$REPO_ROOT/.env.github-validation"; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue
    awk -F= '$1 == "GITHUB_VALIDATION_TOKEN" { print substr($0, length($1) + 2); exit }' "$file"
    return 0
  done
}

validate_github_dependency(){
  [ "$RUN_GITHUB_VALIDATION" = "1" ] || return 0
  local token status curl_args
  token="$(github_validation_token)"
  curl_args=(-sS -o /dev/null -w '%{http_code}' -H 'accept: application/vnd.github+json')
  if [ -n "$token" ]; then
    curl_args+=(-H "authorization: Bearer ${token}")
    echo "  GitHub validation: using local token from env/ignored file (redacted)"
  else
    echo "  GitHub validation: no local token found; using unauthenticated API reachability check"
  fi
  status="$(curl "${curl_args[@]}" https://api.github.com/rate_limit 2>/dev/null || true)"
  case "$status" in
    2*) echo "  GitHub validation: API reachable (HTTP $status)" ;;
    401|403) die "GitHub validation failed with HTTP $status; check GITHUB_VALIDATION_TOKEN or network policy" ;;
    "") die "GitHub validation failed; no HTTP status returned" ;;
    *) die "GitHub validation failed with HTTP $status" ;;
  esac
}

boxlite_readiness_url(){
  local endpoint="$1" protocol="$2" path
  path="$(value_or_default BOXLITE_READINESS_PATH "")"
  if [ -z "$path" ]; then
    case "$protocol" in
      native) path="/v1/default/boxes" ;;
      cap-rest) path="/health" ;;
      *) die "unsupported BOXLITE_PROTOCOL_MODE=$protocol (expected native|cap-rest)" ;;
    esac
  fi
  case "$path" in
    /*) ;;
    *) path="/$path" ;;
  esac
  printf '%s%s\n' "${endpoint%/}" "$path"
}

boxlite_native_api_path(){
  local prefix
  prefix="$(value_or_default BOXLITE_PATH_PREFIX default)"
  prefix="${prefix#/}"
  prefix="${prefix%/}"
  if [ -n "$prefix" ]; then
    printf '/v1/%s\n' "$prefix"
  else
    printf '/v1\n'
  fi
}

boxlite_json_string(){
  json_escape "$1"
}

boxlite_extract_json_string(){
  local key="$1"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -1
}

boxlite_extract_exit_code(){
  sed -n 's/.*"exit_code"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9]*\).*/\1/p' | head -1
}

boxlite_extract_camel_exit_code(){
  sed -n 's/.*"exitCode"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9]*\).*/\1/p' | head -1
}

validate_boxlite_native_runtime_probe(){
  local endpoint token image rootfs_path api_path sandbox_id probe_box_id workspace create_json start_json exec_json exec_id status_json exit_code probe_command attempts create_body source_label
  [ "$(normalize_boxlite_protocol "$(value_or_default BOXLITE_PROTOCOL_MODE native)")" = "native" ] || return 0
  if [ "${CAP_BOXLITE_SKIP_RUNTIME_PROBE:-}" = "1" ]; then
    warn "CAP_BOXLITE_SKIP_RUNTIME_PROBE=1 — BoxLite image/tool runtime probe skipped"
    return 0
  fi
  endpoint="$(boxlite_readiness_endpoint_value "$(require_value BOXLITE_ENDPOINT)")"
  token="$(require_value BOXLITE_API_TOKEN)"
  rootfs_path="$(boxlite_default_rootfs_path)"
  image="$(boxlite_default_image_value)"
  if [ -n "$rootfs_path" ] && [ -n "$image" ]; then
    die "BoxLite runtime probe failed: both image and rootfs path are configured"
  fi
  [ -n "$rootfs_path" ] || [ -n "$image" ] || die "BoxLite runtime probe failed: image or rootfs path default is required"
  api_path="$(boxlite_native_api_path)"
  sandbox_id="cap-quick-deploy-preflight-$$"
  workspace="$(value_or_default BOXLITE_WORKSPACE_PATH "$BOXLITE_DEFAULT_WORKSPACE_PATH")"
  if [ -n "$rootfs_path" ]; then
    create_body="{\"name\":\"$(boxlite_json_string "$sandbox_id")\",\"rootfs_path\":\"$(boxlite_json_string "$rootfs_path")\"}"
    source_label="rootfs path ${rootfs_path}"
  else
    create_body="{\"name\":\"$(boxlite_json_string "$sandbox_id")\",\"image\":\"$(boxlite_json_string "$image")\"}"
    source_label="image ${image}"
  fi
  echo "  BoxLite readiness: creating runtime probe sandbox ${sandbox_id} from ${source_label}"
  create_json="$(curl -fsS -m "$BOXLITE_RUNTIME_PROBE_CREATE_TIMEOUT_SECONDS" \
    -H "authorization: Bearer ${token}" \
    -H 'content-type: application/json' \
    -H 'accept: application/json' \
    -d "$create_body" \
    "${endpoint%/}${api_path}/boxes" 2>/dev/null || true)"
  printf '%s\n' "$create_json" | grep -Eq '"(box_id|id|name)"' || \
    die "BoxLite runtime probe failed: could not create a probe sandbox with ${source_label}"
  probe_box_id="$(printf '%s\n' "$create_json" | boxlite_extract_json_string box_id)"
  [ -n "$probe_box_id" ] || probe_box_id="$(printf '%s\n' "$create_json" | boxlite_extract_json_string id)"
  [ -n "$probe_box_id" ] || probe_box_id="$(printf '%s\n' "$create_json" | boxlite_extract_json_string name)"
  [ -n "$probe_box_id" ] || \
    die "BoxLite runtime probe failed: create response did not include a usable box id"
  start_json="$(curl -fsS -m "$BOXLITE_RUNTIME_PROBE_START_TIMEOUT_SECONDS" -X POST \
    -H "authorization: Bearer ${token}" \
    -H 'accept: application/json' \
    "${endpoint%/}${api_path}/boxes/${probe_box_id}/start" 2>/dev/null || true)"
  printf '%s\n' "$start_json" | grep -Eq '"(box_id|id|name|status)"' || {
    curl -fsS -m "$BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS" -X DELETE -H "authorization: Bearer ${token}" "${endpoint%/}${api_path}/boxes/${probe_box_id}" >/dev/null 2>&1 || true
    die "BoxLite runtime probe failed: could not start probe sandbox ${probe_box_id}"
  }
  probe_command="mkdir -p $(shell_quote "$workspace") && test -d $(shell_quote "$workspace") && test -w $(shell_quote "$workspace") && $(boxlite_required_tools_probe_command)"
  exec_json="$(curl -fsS -m "$BOXLITE_RUNTIME_PROBE_EXEC_TIMEOUT_SECONDS" \
    -H "authorization: Bearer ${token}" \
    -H 'content-type: application/json' \
    -H 'accept: application/json' \
    -d "{\"command\":\"sh\",\"args\":[\"-lc\",\"$(boxlite_json_string "$probe_command")\"],\"working_dir\":\"/\",\"tty\":false}" \
    "${endpoint%/}${api_path}/boxes/${probe_box_id}/exec" 2>/dev/null || true)"
  exec_id="$(printf '%s\n' "$exec_json" | boxlite_extract_json_string execution_id)"
  [ -n "$exec_id" ] || {
    curl -fsS -m "$BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS" -X DELETE -H "authorization: Bearer ${token}" "${endpoint%/}${api_path}/boxes/${probe_box_id}" >/dev/null 2>&1 || true
    die "BoxLite runtime probe failed: exec did not return execution_id"
  }
  exit_code=""
  attempts=0
  while [ "$attempts" -lt 40 ]; do
    attempts=$((attempts + 1))
    status_json="$(curl -fsS -m 10 \
      -H "authorization: Bearer ${token}" \
      -H 'accept: application/json' \
      "${endpoint%/}${api_path}/boxes/${probe_box_id}/executions/${exec_id}" 2>/dev/null || true)"
    exit_code="$(printf '%s\n' "$status_json" | boxlite_extract_exit_code)"
    [ -n "$exit_code" ] && break
    sleep 1
  done
  curl -fsS -m "$BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS" -X DELETE -H "authorization: Bearer ${token}" "${endpoint%/}${api_path}/boxes/${probe_box_id}" >/dev/null 2>&1 || true
  [ "$exit_code" = "0" ] || \
    die "BoxLite runtime probe failed: sandbox source/workspace/tools check exited ${exit_code:-unknown}"
  echo "  BoxLite readiness: runtime sandbox source/workspace/tools probe passed"
}

validate_boxlite_cap_rest_runtime_probe(){
  local endpoint token image sandbox_id create_json exec_json exit_code probe_command workspace
  [ "$(normalize_boxlite_protocol "$(value_or_default BOXLITE_PROTOCOL_MODE native)")" = "cap-rest" ] || return 0
  [ "${CAP_BOXLITE_SKIP_RUNTIME_PROBE:-}" = "1" ] && {
    warn "CAP_BOXLITE_SKIP_RUNTIME_PROBE=1 — BoxLite image/tool runtime probe skipped"
    return 0
  }
  endpoint="$(boxlite_readiness_endpoint_value "$(require_value BOXLITE_ENDPOINT)")"
  token="$(require_value BOXLITE_API_TOKEN)"
  if [ -n "$(boxlite_default_rootfs_path)" ]; then
    die "BoxLite runtime probe failed: BOXLITE_ROOTFS_PATH requires BOXLITE_PROTOCOL_MODE=native"
  fi
  image="$(boxlite_default_image_value)"
  [ -n "$image" ] || die "BoxLite runtime probe failed: BOXLITE_IMAGE or BOXLITE_IMAGE_MAP default is required"
  sandbox_id="cap-quick-deploy-preflight-$$"
  workspace="$(value_or_default BOXLITE_WORKSPACE_PATH "$BOXLITE_DEFAULT_WORKSPACE_PATH")"
  echo "  BoxLite readiness: creating cap-rest runtime probe sandbox ${sandbox_id}"
  create_json="$(curl -fsS -m "$BOXLITE_RUNTIME_PROBE_CREATE_TIMEOUT_SECONDS" \
    -H "authorization: Bearer ${token}" \
    -H 'content-type: application/json' \
    -H 'accept: application/json' \
    -d "{\"taskId\":\"quick-deploy-preflight\",\"sandboxId\":\"$(boxlite_json_string "$sandbox_id")\",\"image\":\"$(boxlite_json_string "$image")\"}" \
    "${endpoint%/}/v1/sandboxes" 2>/dev/null || true)"
  printf '%s\n' "$create_json" | grep -Eq '"id"[[:space:]]*:' || \
    die "BoxLite runtime probe failed: could not create a cap-rest probe sandbox with image ${image}"
  probe_command="mkdir -p $(shell_quote "$workspace") && test -d $(shell_quote "$workspace") && test -w $(shell_quote "$workspace") && $(boxlite_required_tools_probe_command)"
  exec_json="$(curl -fsS -m "$BOXLITE_RUNTIME_PROBE_EXEC_TIMEOUT_SECONDS" \
    -H "authorization: Bearer ${token}" \
    -H 'content-type: application/json' \
    -H 'accept: application/json' \
    -d "{\"command\":\"$(boxlite_json_string "$probe_command")\",\"timeoutMs\":30000}" \
    "${endpoint%/}/v1/sandboxes/${sandbox_id}/exec" 2>/dev/null || true)"
  exit_code="$(printf '%s\n' "$exec_json" | boxlite_extract_camel_exit_code)"
  curl -fsS -m "$BOXLITE_RUNTIME_PROBE_DELETE_TIMEOUT_SECONDS" -X DELETE -H "authorization: Bearer ${token}" "${endpoint%/}/v1/sandboxes/${sandbox_id}" >/dev/null 2>&1 || true
  [ "$exit_code" = "0" ] || \
    die "BoxLite runtime probe failed: cap-rest image/workspace/tools check exited ${exit_code:-unknown}"
  echo "  BoxLite readiness: cap-rest runtime image/workspace/tools probe passed"
}

validate_boxlite_readiness(){
  [ "$SELECTED_PROVIDER" = "boxlite" ] || return 0
  local endpoint readiness_endpoint token image image_map rootfs_path rootfs_path_map protocol url status
  endpoint="$(require_value BOXLITE_ENDPOINT)"
  readiness_endpoint="$(boxlite_readiness_endpoint_value "$endpoint")"
  token="$(require_value BOXLITE_API_TOKEN)"
  image="$(value_for BOXLITE_IMAGE)"
  image_map="$(value_for BOXLITE_IMAGE_MAP)"
  rootfs_path="$(value_for BOXLITE_ROOTFS_PATH)"
  rootfs_path_map="$(value_for BOXLITE_ROOTFS_PATH_MAP)"
  protocol="$(normalize_boxlite_protocol "$(value_or_default BOXLITE_PROTOCOL_MODE native)")"
  [ -n "$image" ] || [ -n "$image_map" ] || [ -n "$rootfs_path" ] || [ -n "$rootfs_path_map" ] || \
    die "BoxLite readiness failed: image/image map or rootfs path/map is required"
  if { [ -n "$image" ] || [ -n "$image_map" ]; } && { [ -n "$rootfs_path" ] || [ -n "$rootfs_path_map" ]; }; then
    die "BoxLite readiness failed: image and rootfs path are both configured"
  fi
  if { [ -n "$rootfs_path" ] || [ -n "$rootfs_path_map" ]; } && [ "$protocol" != "native" ]; then
    die "BoxLite readiness failed: BOXLITE_ROOTFS_PATH requires BOXLITE_PROTOCOL_MODE=native"
  fi
  if [ "$readiness_endpoint" != "$endpoint" ]; then
    echo "  BoxLite runtime endpoint for api containers: ${endpoint}"
    echo "  BoxLite host-side readiness endpoint: ${readiness_endpoint}"
  fi
  validate_boxlite_local_host_dependencies "$readiness_endpoint"
  url="$(boxlite_readiness_url "$readiness_endpoint" "$protocol")"
  echo "  BoxLite readiness: probing ${url} (protocol=${protocol}, token redacted)"
  status="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' \
    -H "authorization: Bearer ${token}" \
    -H 'accept: application/json' \
    "$url" 2>/dev/null || true)"
  case "$status" in
    2*) echo "  BoxLite readiness: endpoint accepted request (HTTP $status)" ;;
    401|403) die "BoxLite readiness failed with HTTP $status; check BOXLITE_API_TOKEN" ;;
    404) die "BoxLite readiness failed with HTTP 404 at $url; BOXLITE_PROTOCOL_MODE=$protocol is not compatible with this endpoint" ;;
    "") die "BoxLite readiness failed: endpoint did not return an HTTP status at $url" ;;
    *) die "BoxLite readiness failed with HTTP $status at $url" ;;
  esac
  validate_boxlite_native_runtime_probe
  validate_boxlite_cap_rest_runtime_probe
}

validate_selected_provider_before_pull(){
  case "$SELECTED_PROVIDER" in
    boxlite) validate_boxlite_readiness ;;
    aio)
      if [ "$SANDBOX_IMAGE_DELIVERY_EFFECTIVE" = "release-assets" ]; then
        validate_aio_image_staged
      else
        echo "  AIO readiness: matching sandbox image will be staged during docker compose pull"
      fi
      ;;
    control-plane) echo "  provider readiness: control-plane mode has no local sandbox image to stage" ;;
  esac
}

validate_aio_image_staged(){
  [ "$SELECTED_PROVIDER" = "aio" ] || return 0
  local image="ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}"
  docker image inspect "$image" >/dev/null 2>&1 || \
    die "AIO readiness failed: expected sandbox image is not staged locally: $image"
  echo "  AIO readiness: staged $image"
}

validate_github_dependency
validate_selected_provider_before_pull
commit_quick_deploy_transaction
maybe_stop_after provider-readiness

# ── GATE 6 — pull + up (prebuilt images; no --build) ───────────────────────────
step "GATE 6 — pull + up (CAP_VERSION=$CAP_VERSION, provider=$SELECTED_PROVIDER)"
profiles=""; [ "$WITH_WEB" = "1" ] && profiles="web"
services=(api postgres)
[ "$WITH_WEB" = "1" ] && services+=(web)
[ "$SELECTED_PROVIDER" = "aio" ] && [ "$SANDBOX_IMAGE_DELIVERY_EFFECTIVE" != "release-assets" ] && services+=(aio-sandbox-image)
( cd "$WORKDIR"
  COMPOSE_PROFILES="$profiles" CAP_VERSION="$CAP_VERSION" CAP_SANDBOX_PROVIDER="$SELECTED_PROVIDER" CAP_IMAGE_PLATFORM="$CAP_IMAGE_PLATFORM" docker compose -f "$COMPOSE" pull "${services[@]}"
  COMPOSE_PROFILES="$profiles" CAP_VERSION="$CAP_VERSION" CAP_SANDBOX_PROVIDER="$SELECTED_PROVIDER" CAP_IMAGE_PLATFORM="$CAP_IMAGE_PLATFORM" validate_aio_image_staged
  COMPOSE_PROFILES="$profiles" CAP_VERSION="$CAP_VERSION" CAP_SANDBOX_PROVIDER="$SELECTED_PROVIDER" CAP_IMAGE_PLATFORM="$CAP_IMAGE_PLATFORM" docker compose -f "$COMPOSE" up -d "${services[@]}"
)

# ── GATE 7 — wait for /health, surface the local-account credentials ───────────
step "GATE 7 — wait for api /health"
echo "  waiting up to ${HEALTH_TIMEOUT_SECONDS}s for api /health"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
until curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    die "api did not become healthy in ${HEALTH_TIMEOUT_SECONDS}s — inspect: docker compose -f $COMPOSE logs api"
  fi
  sleep 3
done
ver="$(curl -fsS "http://localhost:${API_PORT}/version" 2>/dev/null || echo '{}')"
login_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d "$ADMIN_LOGIN_PAYLOAD" \
  "http://localhost:${API_PORT}/auth/password" 2>/dev/null || true)"
if [ "$login_status" = "200" ]; then
  AUTH_NOTE="credential check passed; freshly seeded admins must change this initial password on first login"
else
  AUTH_NOTE="credential check returned HTTP ${login_status:-000}; if this admin already existed, use its current password"
  warn "$AUTH_NOTE"
fi
# Teardown hint must match the profiles that were brought up: a bare `docker compose
# down` does NOT remove the profile-gated `cap-web`, so include COMPOSE_PROFILES=web
# when the web console was started.
if [ "$WITH_WEB" = "1" ]; then
  DOWN_HINT="COMPOSE_PROFILES=web docker compose -f $COMPOSE down"
else
  DOWN_HINT="docker compose -f $COMPOSE down"
fi
cat <<EOF

✅ cap is up (source-free, PREBUILT images, local-account auth).
   version: ${ver}
   provider: ${SELECTED_PROVIDER}
   api:   http://localhost:${API_PORT}    (/health open; protected routes need a session cookie)
   web:   $( [ "$WITH_WEB" = 1 ] && echo "http://localhost:${WEB_PORT}  (same-host runtime endpoint discovery)" || echo "(web profile off)" )
   user:  ${ADMIN_EMAIL_VALUE}
   pass:  ${ADMIN_PASSWORD_VALUE}
   note:  ${AUTH_NOTE}
   try:   curl -H 'content-type: application/json' -d '${ADMIN_LOGIN_PAYLOAD}' http://localhost:${API_PORT}/auth/password
   down:  ${DOWN_HINT}            (add -v to also drop the volumes)
EOF

# ── GATE 8 (optional) — provision smoke: create -> running -> stop ─────────────
# Mirrors scripts/upgrade.sh's smoke (create a throwaway task, wait for `running`
# = sandbox provisioned, then stop), and authenticates with a post-first-login
# session cookie. The printed initial admin password cannot be used for this
# protected action until the operator completes the required first-login password
# change.
if [ "$RUN_SMOKE" = "1" ]; then
  step "GATE 8 — provision smoke"
  if [ "$SELECTED_PROVIDER" = "control-plane" ]; then
    warn "RUN_SMOKE=1 but CAP_SANDBOX_PROVIDER=control-plane — SKIPPING the provision smoke."
  elif [ -z "${CAP_SMOKE_REPO_ID:-}" ]; then
    warn "RUN_SMOKE=1 but CAP_SMOKE_REPO_ID is unset — SKIPPING the provision smoke."
    warn "  (import/select a repo, then set CAP_SMOKE_REPO_ID to enable it.)"
  elif [ -z "${CAP_SMOKE_COOKIE:-}" ]; then
    warn "RUN_SMOKE=1 but CAP_SMOKE_COOKIE is unset — SKIPPING the provision smoke."
    warn "  (log in, complete the first password change, then set CAP_SMOKE_COOKIE to the cap_session value.)"
  else
    auth="cookie: cap_session=${CAP_SMOKE_COOKIE}"
    tid="$(curl -fsS -X POST "http://localhost:${API_PORT}/repos/${CAP_SMOKE_REPO_ID}/tasks" \
      -H "$auth" -H 'content-type: application/json' \
      -d '{"prompt":"provision smoke (quick-deploy.sh) - confirm the sandbox provider is runnable"}' \
      2>/dev/null | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$tid" ] || die "smoke task creation failed (check CAP_SMOKE_REPO_ID / CAP_SMOKE_COOKIE)"
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
