#!/usr/bin/env bash
# Generate a LOCAL-DEV `apps/api/.env` from the committed example, filling strong
# random secrets and enabling the LEGACY operator-token auth path so a freshly
# cloned repo can authenticate WITHOUT registering a GitHub OAuth app
# (local-one-click-dev).
#
# Idempotent + NON-DESTRUCTIVE: refuses to overwrite an existing OUT (a real local
# env is reused as-is). The whole example is COPIED first (so any key the example
# declares flows through), then only the local-dev fields below are overridden.
# The generated file is gitignored; secrets are never written to a tracked file.
#
# Usage: gen-local-env.sh <example-path> <out-path>
set -euo pipefail

EXAMPLE="${1:?usage: gen-local-env.sh <example-path> <out-path>}"
OUT="${2:?usage: gen-local-env.sh <example-path> <out-path>}"

if [ ! -f "$EXAMPLE" ]; then
  echo "gen-local-env: example not found: $EXAMPLE" >&2
  exit 1
fi

# NON-DESTRUCTIVE: never clobber an existing env. Success (idempotent reuse).
if [ -e "$OUT" ]; then
  echo "gen-local-env: $OUT already exists — reusing as-is (not overwriting)." >&2
  exit 0
fi

command -v openssl >/dev/null 2>&1 || {
  echo "gen-local-env: 'openssl' is required to generate secrets" >&2
  exit 1
}

# Copy the WHOLE example so future example keys flow through automatically.
cp "$EXAMPLE" "$OUT"

# set_var KEY VALUE FILE — replace the FIRST `KEY=` line in FILE, or append it.
# The `=` anchor means KEY never matches a longer KEY_… line (portable awk).
set_var() {
  local key="$1" val="$2" file="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$val" '
    BEGIN { done = 0 }
    !done && $0 ~ "^"k"=" { print k"="v; done = 1; next }
    { print }
    END { if (!done) print k"="v }
  ' "$file" >"$tmp"
  mv "$tmp" "$file"
}

# Local-dev overrides: legacy operator-token auth (no OAuth app needed) + secrets.
set_var AUTH_TOKEN_LEGACY_ENABLED "true" "$OUT"
set_var AUTH_TOKEN "$(openssl rand -hex 32)" "$OUT"
set_var SESSION_SECRET "$(openssl rand -hex 32)" "$OUT"
set_var CODEX_CRED_ENC_KEY "$(openssl rand -hex 32)" "$OUT"
set_var WEB_ORIGIN "http://localhost:3000" "$OUT"

echo "gen-local-env: wrote $OUT (legacy operator-token auth, generated secrets)" >&2
