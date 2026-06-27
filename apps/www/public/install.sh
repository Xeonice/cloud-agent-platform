#!/bin/sh
# Cloud Agent Platform — one-line release-image self-host installer.
#
#   curl -fsSL https://__CAP_SITE_DOMAIN__/install.sh | sh
#
# This is a THIN WRAPPER around the release-image installer (`quick-deploy.sh`),
# not a source-build path. It preflights Docker/curl/bash, then executes the
# site-served quick-deploy script, which downloads `docker-compose.prod.yml`,
# resolves the latest Release tag when CAP_VERSION is unset, runs the published
# `ghcr.io/xeonice/cap-*:${CAP_VERSION}` images, waits for /health, and PRINTS
# the `Authorization: Bearer <token>` you log in with.
# No `git clone`, no `make up`, and no local `cloud-agent-platform-api` image.
#
# The site domain below is a TEMPLATE MARKER replaced with a literal value when
# the site is built (so the published file contains no placeholders).
# If a marker is still present (e.g. running the source copy directly), the
# script falls back to the known public defaults.
set -eu

# --- Build-time injected configuration (markers replaced by the www build) -----
SITE_DOMAIN="__CAP_SITE_DOMAIN__"

# Fall back to public defaults if the markers were not substituted at build time.
case "$SITE_DOMAIN" in
  __CAP_SITE_DOMAIN__) SITE_DOMAIN="the install page" ;;
esac

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

# --- Preflight: Docker + docker.sock + downloader ------------------------------
# Fail BEFORE fetching the release installer or mutating the system so an unmet
# prerequisite never leaves a half-bootstrapped host.
info "Cloud Agent Platform installer"
info "Checking prerequisites…"

command -v docker >/dev/null 2>&1 || die \
  "Docker is required but was not found on PATH. Install Docker, then re-run this installer."
command -v curl >/dev/null 2>&1 || die \
  "curl is required but was not found on PATH. Install curl, then re-run this installer."
command -v bash >/dev/null 2>&1 || die \
  "bash is required but was not found on PATH. Install bash, then re-run this installer."

# A reachable Docker daemon (the engine that backs docker.sock). `docker info`
# returns non-zero when the daemon socket is unavailable or permission-denied.
if ! docker info >/dev/null 2>&1; then
  die "Docker is installed but the daemon (docker.sock) is not reachable.
       Start Docker (or your user's access to the docker socket) and re-run.
       This tool talks to the host docker.sock — see the security note on $SITE_DOMAIN."
fi

# --- Delegate to the release-image installer -----------------------------------
if [ "$SITE_DOMAIN" = "the install page" ]; then
  QUICK_DEPLOY_URL="https://raw.githubusercontent.com/Xeonice/cloud-agent-platform/main/scripts/quick-deploy.sh"
else
  QUICK_DEPLOY_URL="https://${SITE_DOMAIN}/quick-deploy.sh"
fi

info "Running release-image installer: $QUICK_DEPLOY_URL"
info "Set CAP_VERSION to pin a release; unset resolves the latest Release tag."
info "On macOS, set BOXLITE_ENDPOINT / BOXLITE_API_TOKEN / BOXLITE_IMAGE for the BoxLite sandbox provider."
curl -fsSL "$QUICK_DEPLOY_URL" | bash

printf '\n%s%s Done.%s Cloud Agent Platform is running from published release images.\n' "$B" "$GRN" "$R"
printf '%sLog in with the Authorization: Bearer token printed above.%s\n' "$DIM" "$R"
printf '%sapi/web host ports bind to 0.0.0.0 by default; configure DNS/TLS/proxy/firewall/auth origins yourself before public exposure.%s\n' "$DIM" "$R"
