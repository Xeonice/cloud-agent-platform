# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Derived AIO Sandbox image (migrate-execution-to-aio-sandbox, Track
# derived-image-and-hooks, task 5.1).
#
# Built FROM a PINNED `ghcr.io/agent-infra/sandbox` tag (NEVER `:latest`) so the
# orchestrator's `AioSandboxProvider` can `createContainer` a reproducible,
# version-locked sandbox per task. On top of the stock AIO image this derived
# image bakes:
#
#   1. The PINNED Codex CLI (live-frame byte-identity is fragile across
#      terminal/Codex versions — bump deliberately, never to "latest").
#   2. The top-level `~/.codex/hooks.json` (Codex only fires hooks from the
#      user-level file; a repo-local `.codex/config.toml` does NOT fire).
#   3. The compiled hook scripts at `/opt/cap/dist/hooks/*.js` that `hooks.json`
#      points at. Under connect-in these hooks make an OUTBOUND HTTP callback to
#      the orchestrator approvals endpoint over `cap-net` (no dial-back / WS).
#
# Codex itself is launched IN-SHELL over `/v1/shell/ws` by the orchestrator's
# `AioPtyClient` bridge (execution model A) — it is NOT an ENTRYPOINT/CMD here
# and is NOT routed through the request/response `exec`/MCP surfaces for the
# interactive channel (task 5.2).
# ---------------------------------------------------------------------------

ARG NODE_VERSION=20
# PINNED, known-good AIO Sandbox base image tag. Bump deliberately, never to
# "latest" (design risk: "Pin the AIO image (avoid `:latest`)"). The
# orchestrator provider reads the derived tag from env; this ARG pins the BASE
# the derived image is built from.
ARG AIO_SANDBOX_TAG=1.0.0.125
# PINNED, known-good Codex CLI version, set from a documented build-arg and
# OVERRIDABLE at build time (`docker build --build-arg CODEX_VERSION=<x.y.z>`).
# Default `0.131` is the release verified compatible with the in-use ChatGPT
# account model `gpt-5.5` (see the codex-version compatibility matrix below).
# The prior hard-coded `0.42.0` pin is replaced because it 400s on
# gpt-5/gpt-5-codex/o4-mini and is rejected by gpt-5.5. Bump deliberately,
# never to "latest".
#
# ---------------------------------------------------------------------------
# codex-version <-> ChatGPT-account-model compatibility matrix
# ---------------------------------------------------------------------------
# Recorded next to the install layer so the next operator does NOT have to
# rediscover this by trial-and-error:
#
#   codex 0.42.0  + gpt-5        -> 400 (rejected)
#   codex 0.42.0  + gpt-5-codex  -> 400 (rejected)
#   codex 0.42.0  + o4-mini      -> 400 (rejected)
#   codex 0.42.0  + gpt-5.5      -> rejected (unusable)
#   codex 0.131.0 + gpt-5.5      -> VERIFIED WORKING
#
# Override at build time for a different account model, e.g.
#   docker build --build-arg CODEX_VERSION=0.131.0 ...
#
# BREAKING (acknowledged): codex `0.131` changes the live frame-stream / hook
# protocol relative to `0.42.0` — the `0.131` PreToolUse stdin/stdout hook
# schema differs. This bump is a deliberate BREAKING change to the frame-stream
# contract; the baked `~/.codex/hooks.json` and compiled `dist/hooks` MUST
# conform to the codex `0.131` hook protocol (delivered by the
# hooks-0131-adapter track). Do not treat byte-identity against `0.42.0` frames
# as valid after this bump.
# ---------------------------------------------------------------------------
ARG CODEX_VERSION=0.131

# PINNED OpenSpec CLI version (task-preinstall-skills). The `openspec` skill the
# operator can select drops `.codex/skills/*/SKILL.md` whose steps shell out to
# the `openspec` CLI (`openspec status`/`list`/`instructions`/`new`); without the
# CLI on PATH those skills cannot run. The per-task `/v1/shell/exec` provision
# channel runs as the unprivileged `gem` user (uid 1000) and CANNOT `npm i -g`
# (the npm prefix is root-owned `/usr`), so the CLI is BAKED here (as root, at
# build time) — exactly like the Codex CLI above — landing it at `/usr/bin/openspec`
# on everyone's PATH. The same pin drives the per-task `openspec init` scaffolding
# (skill-allowlist.ts) so the CLI and the generated skills are always one version.
ARG OPENSPEC_VERSION=1.4.1

# --- build the compiled hook scripts ---------------------------------------
# A throwaway Node toolchain stage that compiles apps/sandbox-hooks/src/hooks/**.ts
# to dist/hooks/**.js. The hook scripts were relocated OUT of the (now deleted)
# `apps/runner` into the standalone `@cap/sandbox-hooks` package so they survive
# the runner deletion; only the hook scripts (and the contracts they import) are
# needed in the derived sandbox image.
FROM node:${NODE_VERSION}-bookworm-slim AS hooks-build
WORKDIR /repo

RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
COPY apps/sandbox-hooks ./apps/sandbox-hooks

RUN pnpm install --frozen-lockfile

# Build contracts (the hooks import `@cap/contracts`) then the hooks package,
# which compiles src/hooks/**.ts to apps/sandbox-hooks/dist/hooks/**.js.
RUN pnpm --filter @cap/contracts build \
  && pnpm --filter @cap/sandbox-hooks build

# Produce a SELF-CONTAINED runtime dependency tree for the hooks
# (close-aio-execution-gaps Gap C / D4). The hooks import `zod` and
# `@cap/contracts`; pnpm makes those a symlink FARM into the virtual store
# (`node_modules/.pnpm`), so copying only the package's node_modules ships
# DANGLING symlinks (ERR_MODULE_NOT_FOUND at hook runtime). `pnpm deploy`
# rewrites that farm into a REAL, hoisted node_modules with no external store
# back-reference — exactly the problem deploy is built to solve, and the right
# tool here (pnpm 10 rejects the filtered `pnpm --filter X prune` the old
# Dockerfile tried — "Unknown option: 'recursive'").
#
# `--legacy` selects the pre-lockfile deploy implementation, which resolves the
# tree from the installed workspace node_modules (robust without an injected-
# workspace-packages config); `--prod` drops devDependencies. The deploy target
# `/opt/deploy` is OUTSIDE the `/repo` workspace, as pnpm deploy requires.
#
# ROLLBACK (design D4 / Migration step 2): if `deploy` cannot produce a tree
# that resolves at runtime, the documented fallback is the prior full-`/repo`
# COPY (functional, just ~8.97 GB). The runtime hook-resolution smoke test
# (`scripts/aio-image-smoke.sh` 6.3) is the gate that catches a missing dep.
RUN pnpm --filter=@cap/sandbox-hooks --prod deploy --legacy /opt/deploy

# --- derived AIO sandbox image ---------------------------------------------
# This is the image the orchestrator actually provisions per task.
FROM ghcr.io/agent-infra/sandbox:${AIO_SANDBOX_TAG} AS sandbox
ARG CODEX_VERSION
ARG OPENSPEC_VERSION

# Install the Codex CLI at the version pinned by the CODEX_VERSION build-arg
# (default 0.131; overridable per the matrix above; never an unpinned latest).
# The AIO base already ships Node; if `npm` is unavailable on the base this
# layer is the correct place to fail loudly during image build rather than at
# task runtime. `codex --version` asserts the derived image actually bakes the
# requested CODEX_VERSION.
RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
  && codex --version

# Bake the OpenSpec CLI (task-preinstall-skills): the `openspec` skill's
# SKILL.md steps shell out to this CLI, and the per-task provision channel (gem,
# uid 1000) cannot `npm i -g` to the root-owned prefix — so install it here as
# root, landing `/usr/bin/openspec` on PATH for the codex process. Pinned via the
# OPENSPEC_VERSION build-arg (same pin the per-task `openspec init` uses). Only
# OpenSpec needs this — BMAD's skills are self-contained agent personas that do
# not hard-depend on a `bmad` CLI at runtime. `openspec --version` asserts the bake.
RUN npm install -g "@fission-ai/openspec@${OPENSPEC_VERSION}" \
  && openspec --version

# --- tmux build-time guarantee (survive-api-redeploy, image-guarantee) ------
# The detached-session sidestep this image enables (codex launched in a detached
# NAMED tmux session that outlives the terminal WebSocket) DEPENDS on tmux being
# present in the sandbox. tmux 3.2a is ALREADY in the pinned AIO base above — this
# layer is INSURANCE: if a future base bump (AIO_SANDBOX_TAG) silently drops tmux,
# this build-time check fails the IMAGE BUILD (loud, early) rather than letting a
# tmux-less image reach production where every detached launch/re-adoption would
# break (design Risk: "tmux socket / image drift"). When tmux is already present
# (the expected case) the `command -v tmux` short-circuits and nothing installs.
RUN command -v tmux >/dev/null 2>&1 || (apt-get update && apt-get install -y tmux && rm -rf /var/lib/apt/lists/*)

# Ship ONLY the slim hook runtime (close-aio-execution-gaps Gap C / D4),
# replacing the prior full-`/repo` COPY (~8.97 GB) that existed only so the pnpm
# symlink farm resolved. Two real, self-contained pieces:
#   1. the deploy output's hoisted node_modules — `zod` and `@cap/contracts` as
#      REAL entries (no `.pnpm` store back-reference), so `import 'zod'` /
#      `@cap/contracts` resolve at hook runtime with no ERR_MODULE_NOT_FOUND;
#   2. the compiled `dist` straight from the build stage (the authoritative
#      artifact; copied directly rather than via the deploy output so it never
#      depends on deploy's file-inclusion rules for a private, files-less pkg).
# `node` resolving /opt/cap/dist/hooks/*.js walks up to /opt/cap/node_modules —
# so /opt/cap/dist is a REAL directory (no symlink indirection) and its sibling
# node_modules satisfies every hook import.
COPY --from=hooks-build /opt/deploy/node_modules /opt/cap/node_modules
COPY --from=hooks-build /repo/apps/sandbox-hooks/dist /opt/cap/dist

# Ship the hook configuration at the user-level ~/.codex/hooks.json (the only
# location Codex fires hooks from). The AIO base image's interactive
# /v1/shell/ws shell runs as the `gem` user (HOME=/home/gem) — NOT root — so
# the hooks.json (and codex auth/config) MUST live under /home/gem/.codex, owned
# by gem. Verified against the live sandbox: codex runs as `gem@...`; a
# /root/.codex/hooks.json is never read and the hooks would silently never fire.
# NOTE: the AIO base image does NOT define the `gem` user at build time — it is
# created by the base entrypoint at RUNTIME (uid/gid 1000). So we cannot
# `chown gem:gem` here; we chown to the numeric 1000:1000 that gem resolves to at
# runtime. mkdir creates /home/gem ahead of the entrypoint's useradd, which keeps
# the existing home (and our hooks.json) rather than clobbering it.
RUN mkdir -p /home/gem/.codex
COPY apps/sandbox-hooks/hooks.json /home/gem/.codex/hooks.json

# --- 6.1/6.3 codex launch path: --full-auto + bypass-hook-trust ------------
# codex 0.131 only fires the baked PreToolUse/PostToolUse hooks when (1) codex is
# launched with `--full-auto` (the `-s` sandbox / `--dangerously-bypass-approvals
# -and-sandbox` flags DISABLE hooks, so they MUST NOT be used) and (2) the baked
# `~/.codex/hooks.json` is TRUSTED. There is no interactive operator in the
# sandbox to answer codex's trust prompt, so the orchestrator launches
# `codex --full-auto --dangerously-bypass-hook-trust` (see CODEX_LAUNCH_ARGV
# below + the bridge launch path) to trust the baked hooks non-interactively.
#
# We deliberately do NOT bake a config.toml `[hooks.state] trusted_hash`: codex
# 0.131 expects that as a PER-HOOK SUB-TABLE
# (`[hooks.state."<path>:<event>:<n>:<n>"]`), and a flat
# `[hooks.state] trusted_hash = "..."` makes codex FAIL TO START
# ("invalid type: string, expected struct HookStateToml" — verified). The
# bypass-hook-trust launch flag IS the trust path; a config.toml trust hash is
# both error-prone and redundant here.
#
# NOTE (codex#16732, design D8 ★): even with --full-auto + bypass-hook-trust +
# matcher `.*`, codex 0.131's PreToolUse hook was VERIFIED to NOT fire (task 6.8
# fire-test). This launch path therefore does NOT enforce approval on its own;
# the cap-controlled fallback (task 6.9, AioApprovalEnforcer) is the actual
# approval path.

# The exact launch argv the orchestrator bridge injects in-shell over
# /v1/shell/ws (kept here as the launch contract; the bridge mirrors it as its
# DEFAULT_CODEX_LAUNCH_ARGV). Updated for codex 0.131: `--full-auto` was REMOVED
# upstream (0.131 rejects it as "unexpected argument"). `-C /home/gem/workspace`
# runs codex in the cloned task repo; `--ask-for-approval never --sandbox
# danger-full-access` is the 0.131 non-interactive auto-run (LONG-form `--sandbox`
# is deliberate — the bridge guard rejects short `-s`/bypass-approvals/`--yolo`);
# `--dangerously-bypass-hook-trust` trusts the baked hooks.json. The DIRECTORY
# trust prompt is handled separately by the provider writing
# ~/.codex/config.toml at provision time, NOT a launch flag. NEVER add
# `--dangerously-bypass-approvals-and-sandbox`/`-s`/bypass-approvals — those
# DISABLE the baked hooks.
#
# TASK PROMPT (aio-codex-prompt-autostart): this argv is the BASE launch only.
# The orchestrator bridge appends the task's prompt as codex's positional
# `[PROMPT]` via `"$(cat /home/gem/.codex/task-prompt.txt)"` (the prompt file is
# written into the sandbox at provision time), so codex starts with the operator
# goal PRE-FILLED. The prompt text is NEVER inlined here or into the launch argv
# (it rides the injected file), keeping it shell-injection-safe and clear of the
# hook-disabling guard. Do NOT add a positional prompt to this ENV.
ENV CODEX_LAUNCH_ARGV="codex -C /home/gem/workspace --ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust"

RUN chown -R 1000:1000 /home/gem

# No CMD/ENTRYPOINT override: the AIO base image's own entrypoint starts the
# sandbox HTTP/WS server. Codex is launched in-shell over /v1/shell/ws by the
# orchestrator bridge (as `codex --full-auto --dangerously-bypass-hook-trust`,
# CODEX_LAUNCH_ARGV above), not by this image.
