#!/usr/bin/env bash
#
# Derived AIO sandbox image contract smoke.
#
# Static checks always run. Dynamic checks reuse/build the exact image when Docker
# is available. The bypass-mode image intentionally contains no Codex hook runtime;
# task isolation, not an in-process hook, is the execution boundary.
#
# Usage:
#   scripts/aio-image-smoke.sh
# Env:
#   AIO_SANDBOX_IMAGE=cap-aio-smoke:test
#   AIO_BASE_TAG=<pinned base tag>
#   SMOKE_REQUIRE_DYNAMIC=1
set -uo pipefail
cd "$(dirname "$0")/.."

DOCKERFILE="docker/aio-sandbox.Dockerfile"
IMAGE="${AIO_SANDBOX_IMAGE:-cap-aio-smoke:test}"
fail=0

log()  { printf '\n=== %s ===\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
skip() { printf '  SKIP  %s\n' "$*"; }

noncomment="$(grep -vE '^[[:space:]]*#' "$DOCKERFILE")"

log "STATIC: pinned CLI image uses a source-free Node donor stage"
if grep -Eq '^FROM node:\$\{NODE_VERSION\}[^ ]* AS node-toolchain$' "$DOCKERFILE" \
  && grep -q 'COPY --from=node-toolchain /usr/local/bin/node' "$DOCKERFILE" \
  && grep -q 'COPY --from=node-toolchain /usr/local/lib/node_modules/npm' "$DOCKERFILE"; then
  pass "Node/npm are copied from the source-free node-toolchain stage"
else
  bad "Node donor stage or final Node/npm copies are missing"
fi

for pin in CODEX_VERSION CLAUDE_CODE_VERSION OPENSPEC_VERSION; do
  if grep -Eq "^ARG ${pin}=[^[:space:]]+" "$DOCKERFILE"; then
    pass "$pin is explicitly pinned"
  else
    bad "$pin is not explicitly pinned"
  fi
done

log "STATIC: bypass launch contract has no legacy approval flags"
expected='ENV CODEX_LAUNCH_ARGV="codex -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox"'
if grep -Fqx "$expected" "$DOCKERFILE"; then
  pass "CODEX_LAUNCH_ARGV matches the composed YOLO/native-terminal policy"
else
  bad "CODEX_LAUNCH_ARGV does not match the expected native-terminal policy"
fi
if printf '%s\n' "$noncomment" | grep -Eq -- '--no-alt-screen|--ask-for-approval|--dangerously-bypass-hook-trust|--full-auto'; then
  bad "legacy terminal/approval launch flags remain in executable Dockerfile lines"
else
  pass "no inline-terminal or legacy approval/hook flags in executable Dockerfile lines"
fi

log "STATIC: dormant hook runtime is absent from the final-image definition"
if printf '%s\n' "$noncomment" | grep -Eq 'sandbox-hooks|hooks\.json|/opt/cap/dist/hooks|pnpm[[:space:]].*deploy'; then
  bad "AIO Dockerfile still builds or copies the dormant hook runtime"
  printf '%s\n' "$noncomment" \
    | grep -En 'sandbox-hooks|hooks\.json|/opt/cap/dist/hooks|pnpm[[:space:]].*deploy' \
    | sed 's/^/        /'
else
  pass "no hook package, hooks.json, hook dist, or pnpm deploy in executable lines"
fi

can_dynamic=1
why_skip=""
if ! command -v docker >/dev/null 2>&1; then
  can_dynamic=0; why_skip="docker not installed"
elif ! docker info >/dev/null 2>&1; then
  can_dynamic=0; why_skip="docker daemon not reachable"
fi

build_log="$(mktemp -t cap-aio-image-smoke.XXXXXX)"
cleanup() { rm -f "$build_log"; }
trap cleanup EXIT

build_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "DYNAMIC: reusing present image $IMAGE"
    return 0
  fi
  local base_tag="${AIO_BASE_TAG:-1.0.0.125}"
  log "DYNAMIC: building $IMAGE from pinned AIO base $base_tag"
  if ! docker build -f "$DOCKERFILE" --build-arg AIO_SANDBOX_TAG="$base_tag" \
    -t "$IMAGE" . >"$build_log" 2>&1; then
    return 1
  fi

  # Docker Desktop may acknowledge the build before the exported image becomes
  # inspectable through the daemon. Do not race straight into `docker run`, and
  # do not treat a successful build exit alone as proof that the requested tag
  # exists. Keep the wait bounded so CI still fails deterministically.
  local attempt
  for ((attempt = 0; attempt < 30; attempt += 1)); do
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf '%s\n' "docker build returned success but $IMAGE was not inspectable after 30s" \
    >>"$build_log"
  return 1
}

if [ "$can_dynamic" = 1 ] && ! build_image; then
  can_dynamic=0
  why_skip="derived image build failed"
  tail -5 "$build_log" 2>/dev/null | sed 's/^/        /' || true
fi

if [ "$can_dynamic" != 1 ]; then
  log "DYNAMIC checks skipped: $why_skip"
  skip "exact image CLI parser and filesystem checks did not run"
  if [ "${SMOKE_REQUIRE_DYNAMIC:-0}" = 1 ]; then
    bad "SMOKE_REQUIRE_DYNAMIC=1 but the dynamic image gate could not run"
  fi
  printf '\n%s\n' "$( [ "$fail" = 0 ] && echo 'STATIC checks passed.' || echo 'SMOKE FAILED.' )"
  exit "$fail"
fi

log "DYNAMIC: exact pinned image parses runtime flags and has required tools"
# Run the already-inspected local tag directly. Docker Desktop's containerd store can
# mis-resolve a single-platform local image as a missing remote manifest when the same
# architecture is redundantly supplied through `--platform`.
probe="$(docker run --rm --entrypoint sh "$IMAGE" -lc '
  set -eu
  node --version
  npm --version
  codex --version
  claude --version
  openspec --version
  tmux -V
  codex --dangerously-bypass-approvals-and-sandbox --help >/dev/null
  codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --help >/dev/null
  codex exec resume --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
    00000000-0000-4000-8000-000000000000 --help >/dev/null
  claude --dangerously-skip-permissions --help >/dev/null
  claude -p --resume 00000000-0000-4000-8000-000000000000 \
    --dangerously-skip-permissions --output-format stream-json --verbose --help >/dev/null
  test -f /etc/cap/sandbox-metadata.json
  test -d /home/gem/.codex
  test -d /home/gem/workspace
  echo CLI_PROBE_OK
' 2>&1 || true)"
if printf '%s\n' "$probe" | grep -q 'CLI_PROBE_OK'; then
  pass "Codex/Claude fresh and resume flags parse; Node/OpenSpec/tmux/metadata/runtime dirs exist"
else
  bad "exact image CLI/tooling probe failed"
  printf '%s\n' "$probe" | sed 's/^/        /'
fi

log "DYNAMIC: obsolete hook artifacts are absent"
hook_probe="$(docker run --rm --entrypoint sh "$IMAGE" -lc '
  test ! -e /home/gem/.codex/hooks.json
  test ! -e /opt/cap/dist/hooks
  test ! -e /opt/cap/node_modules
  echo NO_HOOK_ARTIFACTS
' 2>&1 || true)"
if printf '%s\n' "$hook_probe" | grep -qx 'NO_HOOK_ARTIFACTS'; then
  pass "hooks.json, hook dist, and hook dependency tree are absent"
else
  bad "obsolete hook artifacts remain in the exact image"
  printf '%s\n' "$hook_probe" | sed 's/^/        /'
fi

printf '\n%s\n' "$( [ "$fail" = 0 ] && echo 'ALL SMOKE CHECKS PASSED.' || echo 'SMOKE FAILED.' )"
exit "$fail"
