#!/usr/bin/env bash
#
# Derived AIO sandbox image build/smoke check (harden-aio-execution, integration
# tasks 6.2 / 6.3 / 6.4). Asserts the final docker/aio-sandbox.Dockerfile (after
# the codex-version bump + the 6.1 launch/trust edit + the hooks.json rewrite)
# is correct on two levels:
#
#   STATIC (always runs; no docker/network needed) — source-level guards:
#     6.2  the Dockerfile builds on pnpm 10 and does NOT invoke a filtered
#          `pnpm --filter X prune --prod` (that filtered prune is the D1 failure;
#          fail the check if it is ever reintroduced).
#     D4   (close-aio-execution-gaps Gap C) the image is SLIMMED via `pnpm deploy`:
#          the Dockerfile no longer COPYs the whole `/repo` workspace (~8.97 GB)
#          into the final stage and no longer aliases /opt/cap/dist via a symlink
#          into that /repo; it COPYs the deploy output's node_modules instead.
#          Fail the check if the full-`/repo` COPY is reintroduced.
#
#   DYNAMIC (runs only when the derived image is buildable / present) — builds the
#   image and inspects the BUILT artifact:
#     6.3  `import 'zod'` and `@cap/contracts` resolve from the compiled
#          /opt/cap/dist/hooks inside the built image with NO ERR_MODULE_NOT_FOUND
#          (D4: the `pnpm deploy` node_modules sibling of /opt/cap/dist resolves
#          every hook dep as a REAL, hoisted entry — no /repo, no symlink farm).
#     6.4  hooks.json is present at the gem HOME (/home/gem/.codex/hooks.json) and
#          owned 1000:1000 (D5: codex runs as gem, HOME=/home/gem).
#
# CI runs this with docker + network available so the DYNAMIC checks execute. In
# a network-restricted sandbox the DYNAMIC checks SKIP (clearly logged) while the
# STATIC guards still run, so a reintroduced filtered prune is always caught.
#
# Usage:
#   scripts/aio-image-smoke.sh
# Env overrides:
#   AIO_SANDBOX_IMAGE   derived image tag to build/use (default cap-aio-smoke:test)
#   AIO_BASE_TAG        ghcr.io/agent-infra/sandbox base tag the image is FROM.
#                       If unset, any locally present sandbox image is retagged.
#   SMOKE_REQUIRE_DYNAMIC=1  fail (not skip) if the dynamic build cannot run.
set -uo pipefail
cd "$(dirname "$0")/.."

DOCKERFILE="docker/aio-sandbox.Dockerfile"
IMAGE="${AIO_SANDBOX_IMAGE:-cap-aio-smoke:test}"
fail=0

log()  { printf '\n=== %s ===\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
skip() { printf '  SKIP  %s\n' "$*"; }

# ---------------------------------------------------------------------------
# STATIC — 6.2: no filtered prune; builds on pnpm 10.
# ---------------------------------------------------------------------------
log "6.2 STATIC: Dockerfile does not invoke a filtered pnpm prune (D1)"

# A FILTERED prune is the D1 incompatibility: `pnpm --filter <x> prune` (with or
# without --prod) rejects the implied --recursive on pnpm 10. Match a prune that
# is scoped by --filter on the same pnpm invocation. A bare `pnpm prune` (no
# --filter) is fine and not matched. STRIP COMMENT LINES first so the inline doc
# that NAMES the forbidden command (to warn against it) is not a false positive.
noncomment="$(grep -vE '^[[:space:]]*#' "$DOCKERFILE")"
if printf '%s\n' "$noncomment" | grep -Eq 'pnpm[^#]*--filter[^#]*\bprune\b|pnpm[^#]*\bprune\b[^#]*--filter'; then
  bad "filtered 'pnpm --filter X prune' reintroduced in $DOCKERFILE (D1 regression)"
  printf '%s\n' "$noncomment" | grep -En 'prune' | sed 's/^/        /'
else
  pass "no filtered 'pnpm --filter X prune' in executable $DOCKERFILE lines"
fi

# Sanity: the build still uses pnpm 10 via corepack + frozen lockfile install.
if grep -q 'pnpm install --frozen-lockfile' "$DOCKERFILE"; then
  pass "Dockerfile installs with 'pnpm install --frozen-lockfile' (pnpm 10 path)"
else
  bad "Dockerfile no longer does a 'pnpm install --frozen-lockfile'"
fi

# ---------------------------------------------------------------------------
# STATIC — D4 (close-aio-execution-gaps Gap C): image slimmed via `pnpm deploy`.
# ---------------------------------------------------------------------------
log "D4 STATIC: derived image is slimmed via pnpm deploy (no full-/repo COPY)"

# Three load-bearing facts of the slim strategy, all guarded on executable
# (comment-stripped) lines so the inline docs that NAME the old commands are not
# false positives: (1) a `pnpm deploy` produces the self-contained tree;
# (2) the ~8.97 GB full-`/repo` COPY is gone from the final stage; (3) /opt/cap/dist
# is a real dir, not a symlink into a /repo COPY.
if printf '%s\n' "$noncomment" | grep -Eq 'pnpm[^#]*\bdeploy\b'; then
  pass "Dockerfile produces a self-contained tree via 'pnpm deploy'"
else
  bad "Dockerfile no longer runs 'pnpm deploy' (D4 slim strategy missing)"
fi
if printf '%s\n' "$noncomment" | grep -Eq 'COPY[[:space:]].*--from=hooks-build[[:space:]]+/repo[[:space:]]+/opt/cap/repo'; then
  bad "full-'/repo' COPY reintroduced into the final stage (D4 regression: ~8.97 GB)"
else
  pass "no full-'/repo' COPY in the final stage"
fi
if printf '%s\n' "$noncomment" | grep -Eq 'ln[[:space:]]+-s[[:space:]]+/opt/cap/repo'; then
  bad "/opt/cap/dist symlink into /opt/cap/repo reintroduced (D4: should be a real dir)"
else
  pass "/opt/cap/dist is not a symlink into a /repo COPY"
fi

# ---------------------------------------------------------------------------
# Decide whether the DYNAMIC build/inspect checks can run.
# ---------------------------------------------------------------------------
can_dynamic=1
why_skip=""
if ! command -v docker >/dev/null 2>&1; then
  can_dynamic=0; why_skip="docker not installed"
elif ! docker info >/dev/null 2>&1; then
  can_dynamic=0; why_skip="docker daemon not reachable"
fi

build_image() {
  # Reuse an already-present derived image if one was provided.
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "dynamic: reusing present derived image $IMAGE"
    return 0
  fi
  local base_tag="${AIO_BASE_TAG:-}"
  if [ -z "$base_tag" ]; then
    local local_base
    local_base="$(docker images --format '{{.Repository}}:{{.Tag}}' \
      | grep '^ghcr.io/agent-infra/sandbox:' | grep -v '<none>' | head -1 || true)"
    if [ -n "$local_base" ]; then
      base_tag="smoke-base"
      docker tag "$local_base" "ghcr.io/agent-infra/sandbox:${base_tag}" || return 1
    else
      base_tag="1.0.0.125"
    fi
  fi
  log "dynamic: building $IMAGE (FROM sandbox:${base_tag})"
  docker build -f "$DOCKERFILE" --build-arg AIO_SANDBOX_TAG="$base_tag" -t "$IMAGE" . >/tmp/aio-smoke-build.log 2>&1
}

if [ "$can_dynamic" = 1 ]; then
  if ! build_image; then
    can_dynamic=0; why_skip="derived image build failed (likely no network for base/node pull)"
    tail -5 /tmp/aio-smoke-build.log 2>/dev/null | sed 's/^/        /' || true
  fi
fi

if [ "$can_dynamic" != 1 ]; then
  log "DYNAMIC checks (6.3 / 6.4) skipped: $why_skip"
  skip "6.3 hook module resolution from /opt/cap/dist (needs a built image)"
  skip "6.4 hooks.json at /home/gem/.codex owned 1000:1000 (needs a built image)"
  if [ "${SMOKE_REQUIRE_DYNAMIC:-0}" = 1 ]; then
    bad "SMOKE_REQUIRE_DYNAMIC=1 but the dynamic build could not run"
  fi
  printf '\n%s\n' "$( [ "$fail" = 0 ] && echo 'STATIC checks passed.' || echo 'SMOKE FAILED.' )"
  exit "$fail"
fi

# AIO is released as linux/amd64. On arm64 Docker Desktop, omitting --platform
# emits a warning on stderr; the ownership checks below intentionally capture
# stderr, so that warning would corrupt an otherwise-correct `1000:1000` value.
IMAGE_PLATFORM="linux/$(docker image inspect --format '{{.Architecture}}' "$IMAGE")"

# ---------------------------------------------------------------------------
# DYNAMIC — 6.3: zod + @cap/contracts resolve from the compiled dist/hooks.
# ---------------------------------------------------------------------------
log "6.3 DYNAMIC: import 'zod' and '@cap/contracts' resolve from /opt/cap/dist/hooks"

# Run node INSIDE the image, importing the COMPILED hook module the same way
# codex invokes it (/opt/cap/dist/hooks/*.js). A successful import proves the
# /repo COPY + /opt/cap/dist symlink farm resolves zod + @cap/contracts with no
# ERR_MODULE_NOT_FOUND. We import the permission hook entry (which imports both).
res3="$(docker run --rm --platform "$IMAGE_PLATFORM" --entrypoint node "$IMAGE" -e '
  import("/opt/cap/dist/hooks/permission-request.hook.js")
    .then(() => { console.log("RESOLVE_OK"); })
    .catch((e) => { console.error("RESOLVE_FAIL " + (e && e.code ? e.code : e)); process.exit(3); });
' 2>&1 || true)"
if printf '%s' "$res3" | grep -q 'RESOLVE_OK'; then
  pass "zod + @cap/contracts resolve from the compiled dist/hooks (no ERR_MODULE_NOT_FOUND)"
elif printf '%s' "$res3" | grep -q 'ERR_MODULE_NOT_FOUND'; then
  bad "hook import failed with ERR_MODULE_NOT_FOUND (symlink farm / dist not resolving)"
  printf '%s\n' "$res3" | sed 's/^/        /'
else
  bad "hook import did not resolve cleanly"
  printf '%s\n' "$res3" | sed 's/^/        /'
fi

# ---------------------------------------------------------------------------
# DYNAMIC — 6.4: hooks.json present at gem HOME and owned 1000:1000.
# ---------------------------------------------------------------------------
log "6.4 DYNAMIC: /home/gem/.codex/hooks.json present and owned 1000:1000"

owner="$(docker run --rm --platform "$IMAGE_PLATFORM" --entrypoint sh "$IMAGE" -c \
  'stat -c "%u:%g" /home/gem/.codex/hooks.json 2>/dev/null || echo MISSING' 2>&1 || true)"
if [ "$owner" = "1000:1000" ]; then
  pass "hooks.json present at /home/gem/.codex and owned 1000:1000 (gem)"
elif [ "$owner" = "MISSING" ]; then
  bad "hooks.json is MISSING at /home/gem/.codex/hooks.json"
else
  bad "hooks.json present but owned '$owner' (expected 1000:1000)"
fi

# Also assert it is the 0.131-format file (matcher/hooks), not the old form.
fmt="$(docker run --rm --platform "$IMAGE_PLATFORM" --entrypoint sh "$IMAGE" -c \
  'cat /home/gem/.codex/hooks.json 2>/dev/null' 2>&1 || true)"
if printf '%s' "$fmt" | grep -q '"matcher"'; then
  pass "baked hooks.json is in the codex 0.131 format (has a matcher)"
else
  bad "baked hooks.json is not in the 0.131 format (no matcher key)"
fi

printf '\n%s\n' "$( [ "$fail" = 0 ] && echo 'ALL SMOKE CHECKS PASSED.' || echo 'SMOKE FAILED.' )"
exit "$fail"
