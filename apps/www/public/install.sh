#!/bin/sh
# Cloud Agent Platform — one-line release-image self-host installer.
#
#   curl -fsSL https://__CAP_SITE_DOMAIN__/install.sh | sh
#
# This is a THIN WRAPPER around the release-image installer (`quick-deploy.sh`),
# not a source-build path. It preflights host tools and Docker, installing Docker
# only when it is absent, then executes the site-served quick-deploy script, which
# downloads `docker-compose.prod.yml`,
# resolves the latest Release tag when CAP_VERSION is unset, runs the published
# `ghcr.io/xeonice/cap-*:${CAP_VERSION}` images, waits for /health, and PRINTS
# the admin email/password you log in with.
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

command -v curl >/dev/null 2>&1 || die \
  "curl is required but was not found on PATH. Install curl, then re-run this installer."

if [ -n "${CAP_INSTALL_BASE:-}" ]; then
  CAP_INSTALL_BASE="${CAP_INSTALL_BASE%/}"
  QUICK_DEPLOY_URL="${CAP_INSTALL_BASE}/quick-deploy.sh"
  PREFLIGHT_LIB_URL="${CAP_INSTALL_BASE}/install-preflight.sh"
elif [ "$SITE_DOMAIN" = "the install page" ]; then
  QUICK_DEPLOY_URL="https://raw.githubusercontent.com/Xeonice/cloud-agent-platform/main/scripts/quick-deploy.sh"
  PREFLIGHT_LIB_URL="https://raw.githubusercontent.com/Xeonice/cloud-agent-platform/main/scripts/install-preflight.sh"
else
  QUICK_DEPLOY_URL="https://${SITE_DOMAIN}/quick-deploy.sh"
  PREFLIGHT_LIB_URL="https://${SITE_DOMAIN}/install-preflight.sh"
fi

PREFLIGHT_TMP=""
cleanup_preflight_tmp() {
  [ -z "$PREFLIGHT_TMP" ] || rm -f "$PREFLIGHT_TMP"
}
trap cleanup_preflight_tmp EXIT HUP INT TERM

if [ -n "${CAP_INSTALL_PREFLIGHT_LIB_PATH:-}" ]; then
  # Test/dev hook: use a local checked-out helper instead of fetching it.
  # shellcheck disable=SC1090
  . "$CAP_INSTALL_PREFLIGHT_LIB_PATH"
else
  PREFLIGHT_TMP="${TMPDIR:-/tmp}/cap-install-preflight.$$"
  curl -fsSL "$PREFLIGHT_LIB_URL" -o "$PREFLIGHT_TMP" || die \
    "could not fetch install preflight helper from $PREFLIGHT_LIB_URL"
  # shellcheck disable=SC1090
  . "$PREFLIGHT_TMP"
fi

cap_print_dependency_report
cap_require_tools curl bash openssl awk
cap_ensure_docker

if [ "${CAP_INSTALL_PREFLIGHT_ONLY:-}" = "1" ]; then
  info "Preflight complete; CAP_INSTALL_PREFLIGHT_ONLY=1 so delegation is skipped."
  exit 0
fi

# --- Delegate to the release-image installer -----------------------------------
info "Running release-image installer: $QUICK_DEPLOY_URL"
info "Set CAP_VERSION to pin a release; unset resolves the latest Release tag."
info "On macOS, set BOXLITE_ENDPOINT / BOXLITE_API_TOKEN for the BoxLite sandbox provider; leave BOXLITE_IMAGE unset to use the matching Release-asset rootfs, or set it to force registry image mode."
info "Same-host BoxLite also requires Apple Silicon macOS 12+ with kern.hv_support=1; Linux/WSL2 same-host BoxLite requires read/write /dev/kvm."
info "For same-host BoxLite, use BOXLITE_ENDPOINT=http://host.docker.internal:7331 and BOXLITE_READINESS_ENDPOINT=http://127.0.0.1:7331."
curl -fsSL "$QUICK_DEPLOY_URL" | CAP_PREFLIGHT_LIB_URL="$PREFLIGHT_LIB_URL" bash

printf '\n%s%s Done.%s Cloud Agent Platform is running from published release images.\n' "$B" "$GRN" "$R"
printf '%sLog in with the admin email/password printed above; the first login requires changing that initial password.%s\n' "$DIM" "$R"
printf '%sapi/web host ports bind to 0.0.0.0 by default; configure DNS/TLS/proxy/firewall/auth origins yourself before public exposure.%s\n' "$DIM" "$R"
