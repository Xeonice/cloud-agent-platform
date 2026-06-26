#!/usr/bin/env sh
# Shared startup-provider selection helpers.
#
# Contract:
#   CAP_SANDBOX_PROVIDER=auto|aio|boxlite|control-plane
#
# `auto` is intentionally OS-based, not architecture-based:
#   Darwin -> boxlite
#   Linux  -> aio

cap_provider_uname() {
  if [ -n "${CAP_TEST_UNAME:-}" ]; then
    printf '%s\n' "$CAP_TEST_UNAME"
  else
    uname -s 2>/dev/null || printf 'unknown\n'
  fi
}

cap_provider_normalize() {
  case "${1:-auto}" in
    ""|auto) printf '%s\n' "auto" ;;
    aio) printf '%s\n' "aio" ;;
    boxlite) printf '%s\n' "boxlite" ;;
    control-plane|control-plane-only|cp|up-cp) printf '%s\n' "control-plane" ;;
    *)
      printf 'invalid CAP_SANDBOX_PROVIDER: %s (expected auto|aio|boxlite|control-plane)\n' "$1" >&2
      return 2
      ;;
  esac
}

cap_provider_resolve() {
  mode="$(cap_provider_normalize "${1:-${CAP_SANDBOX_PROVIDER:-auto}}")" || return $?
  if [ "$mode" != "auto" ]; then
    printf '%s\n' "$mode"
    return 0
  fi

  case "$(cap_provider_uname)" in
    Darwin) printf '%s\n' "boxlite" ;;
    Linux) printf '%s\n' "aio" ;;
    *)
      printf 'cannot auto-select sandbox provider for OS "%s"; set CAP_SANDBOX_PROVIDER=aio|boxlite|control-plane\n' "$(cap_provider_uname)" >&2
      return 2
      ;;
  esac
}

cap_provider_make_target() {
  mode="$(cap_provider_resolve "${1:-${CAP_SANDBOX_PROVIDER:-auto}}")" || return $?
  case "$mode" in
    aio|boxlite) printf '%s\n' "up" ;;
    control-plane) printf '%s\n' "up-cp" ;;
    *) return 2 ;;
  esac
}
