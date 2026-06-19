#!/bin/sh
# Cloud Agent Platform — one-line self-host installer.
#
#   curl -fsSL https://__CAP_SITE_DOMAIN__/install.sh | sh
#
# This is a THIN WRAPPER, not a re-implementation. It (1) preflights Docker and
# the host docker.sock, (2) clones the public repository, (3) cd's into it, and
# (4) runs `make up` (or `make up-cp` on arm64) — which is the real, source-of-
# truth bring-up. `make up` itself bootstraps the env, builds + starts the
# stack, waits for /health, and PRINTS the `Authorization: Bearer <token>` you
# log in with; this script simply surfaces that output unmodified.
#
# The repo URL and site domain below are TEMPLATE MARKERS replaced with literal
# values when the site is built (so the published file contains no placeholders).
# If a marker is still present (e.g. running the source copy directly), the
# script falls back to the known public defaults.
set -eu

# --- Build-time injected configuration (markers replaced by the www build) -----
REPO_URL="__CAP_REPO_URL__"
SITE_DOMAIN="__CAP_SITE_DOMAIN__"

# Fall back to public defaults if the markers were not substituted at build time.
case "$REPO_URL" in
  __CAP_REPO_URL__) REPO_URL="https://github.com/Xeonice/cloud-agent-platform.git" ;;
esac
case "$SITE_DOMAIN" in
  __CAP_SITE_DOMAIN__) SITE_DOMAIN="the install page" ;;
esac

CLONE_DIR="${CAP_CLONE_DIR:-cloud-agent-platform}"

# --- Tiny output helpers -------------------------------------------------------
if [ -t 1 ]; then
  B="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; R="$(printf '\033[0m')"
  YEL="$(printf '\033[33m')"; RED="$(printf '\033[31m')"; GRN="$(printf '\033[32m')"
else
  B=""; DIM=""; R=""; YEL=""; RED=""; GRN=""
fi
info() { printf '%s==>%s %s\n' "$B" "$R" "$*"; }
warn() { printf '%s warn:%s %s\n' "$YEL" "$R" "$*" >&2; }
die()  { printf '%s error:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

# --- Preflight: Docker + docker.sock + git -------------------------------------
# Fail BEFORE cloning or mutating the system so an unmet prerequisite never
# leaves a half-bootstrapped host.
info "Cloud Agent Platform installer"
info "Checking prerequisites…"

command -v git >/dev/null 2>&1 || die "git is required but was not found on PATH."

command -v docker >/dev/null 2>&1 || die \
  "Docker is required but was not found on PATH. Install Docker, then re-run this installer."

# A reachable Docker daemon (the engine that backs docker.sock). `docker info`
# returns non-zero when the daemon socket is unavailable or permission-denied.
if ! docker info >/dev/null 2>&1; then
  die "Docker is installed but the daemon (docker.sock) is not reachable.
       Start Docker (or your user's access to the docker socket) and re-run.
       This tool talks to the host docker.sock — see the security note on $SITE_DOMAIN."
fi

# --- Architecture guidance (arm64 / Apple Silicon) -----------------------------
# `make up` builds the amd64 AIO sandbox image. On arm64 that first build runs
# under emulation and is slow; `make up-cp` brings up the control plane only and
# skips that heavy build. Detect arm64 and prefer the fast path.
UP_TARGET="up"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$ARCH" in
  arm64|aarch64)
    UP_TARGET="up-cp"
    warn "Detected an arm64 host (e.g. Apple Silicon)."
    warn "The full \`make up\` builds the amd64 AIO sandbox image under emulation —"
    warn "the FIRST run is slow (then cached). Defaulting to the fast control-plane-"
    warn "only path: \`make up-cp\` (api + postgres). Set CAP_UP_TARGET=up to force the"
    warn "full bring-up, or run \`make up\` yourself later to build the sandbox image."
    ;;
esac
# Allow an explicit override of the chosen make target.
UP_TARGET="${CAP_UP_TARGET:-$UP_TARGET}"

# --- Clone the public repository -----------------------------------------------
if [ -e "$CLONE_DIR" ]; then
  die "Destination '$CLONE_DIR' already exists. Remove it (or set CAP_CLONE_DIR=<dir>) and re-run."
fi
info "Cloning $REPO_URL → $CLONE_DIR …"
git clone --depth 1 "$REPO_URL" "$CLONE_DIR"
cd "$CLONE_DIR"

# --- Bring up the stack via the real make target -------------------------------
# We do NOT reimplement provisioning — `make $UP_TARGET` is the source of truth.
# Its output includes the `Authorization: Bearer <token>` line; by not capturing
# or filtering stdout we surface that token to the user verbatim.
info "Running \`make $UP_TARGET\` (this is the real bring-up; the Bearer token is printed below)…"
make "$UP_TARGET"

printf '\n%s%s Done.%s Cloud Agent Platform is bootstrapping in %s/\n' "$B" "$GRN" "$R" "$CLONE_DIR"
printf '%sLog in with the Authorization: Bearer token printed by "make %s" above.%s\n' "$DIM" "$UP_TARGET" "$R"
if [ "$UP_TARGET" = "up-cp" ]; then
  printf '%sControl-plane only was started. To build the per-task sandbox image, run "make up" in %s/.%s\n' "$DIM" "$CLONE_DIR" "$R"
fi
