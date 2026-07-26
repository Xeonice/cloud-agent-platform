# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Derived AIO Sandbox image (migrate-execution-to-aio-sandbox).
#
# Built FROM a PINNED `ghcr.io/agent-infra/sandbox` tag (NEVER `:latest`) so the
# orchestrator's `AioSandboxProvider` can `createContainer` a reproducible,
# version-locked sandbox per task. On top of the stock AIO image this derived
# image bakes the PINNED Codex and Claude Code CLIs (terminal/CLI behavior is
# version-sensitive — bump deliberately, never to "latest"). It deliberately
# does NOT bake the obsolete Codex approval-hook runtime: bypass-mode tasks are
# externally contained by their per-task sandbox and do not claim a hook gate.
#
# Codex itself is launched IN-SHELL over `/v1/shell/ws` by the provider-neutral
# sandbox terminal session engine. It is NOT an ENTRYPOINT/CMD here and is NOT
# routed through request/response exec/MCP for the interactive channel.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22
# PINNED, known-good AIO Sandbox base image tag. Bump deliberately, never to
# "latest" (design risk: "Pin the AIO image (avoid `:latest`)"). The
# orchestrator provider reads the derived tag from env; this ARG pins the BASE
# the derived image is built from.
ARG AIO_SANDBOX_TAG=1.0.0.125
# PINNED, known-good Codex CLI version, set from a documented build-arg and
# OVERRIDABLE at build time (`docker build --build-arg CODEX_VERSION=<x.y.z>`).
# Default `0.144.1` is the exact latest registry release selected for the
# 2026-07-10 official image rebuild. Account-model compatibility history stays
# recorded in the matrix below.
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
#   codex 0.144.1                 -> current official image pin (2026-07-10)
#
# Override at build time for a different account model, e.g.
#   docker build --build-arg CODEX_VERSION=0.144.1 ...
#
# CLI/TUI behavior may change across these pins. Do not treat byte identity from
# an older release as valid after a bump; the real provider/browser gates own
# compatibility verification.
# ---------------------------------------------------------------------------
ARG CODEX_VERSION=0.144.1

# PINNED, known-good Claude Code CLI version, set from a documented build-arg and
# OVERRIDABLE at build time (`docker build --build-arg CLAUDE_CODE_VERSION=<x.y.z>`).
# Baked alongside the codex CLI so a `claude-code` task can launch WITHOUT a
# runtime install step (add-claude-code-runtime, design D7).
#
# WHY PINNED (NEVER "latest", design D7): the Claude launch relies on
# `CLAUDE_CODE_SANDBOXED` plus the first-run onboarding-suppression flags, which
# are UNDOCUMENTED binary internals. An unpinned bump could change native
# alternate-screen/query behavior or the trust/onboarding gate (re-introducing a
# blocking prompt with no interactive operator to answer it). Default `2.1.207`
# is the exact latest registry release
# selected for the 2026-07-10 official image rebuild. Bump DELIBERATELY, after
# re-verifying native-terminal rendering + onboarding suppression on the new version.
ARG CLAUDE_CODE_VERSION=2.1.207

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

# --- Node 22 donor stage ---------------------------------------------------
# The pinned AIO base currently carries Node 20, while the pinned Claude Code
# CLI requires Node >=22. This stage donates only Node/npm to the final image;
# no repository source or dormant hook dependency tree enters the runtime image.
FROM node:${NODE_VERSION}-bookworm-slim AS node-toolchain

# --- derived AIO sandbox image ---------------------------------------------
# This is the image the orchestrator actually provisions per task.
FROM ghcr.io/agent-infra/sandbox:${AIO_SANDBOX_TAG} AS sandbox
ARG CODEX_VERSION
ARG CLAUDE_CODE_VERSION
ARG OPENSPEC_VERSION
ARG CAP_VERSION=unknown

# The upstream AIO image currently carries Node 20, while current Claude Code
# requires Node >=22. Reuse the exact Node toolchain from the build stage so the
# runtime satisfies the CLI engine contract without replacing other AIO files.
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY --from=node-toolchain /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN ln -sfn ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sfn ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && node --version \
  && npm --version

COPY scripts/write-sandbox-metadata.mjs scripts/sandbox-version-selector.mjs scripts/runtime-artifact-checksum.mjs /usr/local/bin/

# Install the Codex CLI at the version pinned by the CODEX_VERSION build-arg
# (default 0.144.1; overridable per the matrix above; never an unpinned latest).
# The AIO base already ships Node; if `npm` is unavailable on the base this
# layer is the correct place to fail loudly during image build rather than at
# task runtime. `codex --version` asserts the derived image actually bakes the
# requested CODEX_VERSION.
RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
  && codex --version

# Bake the Claude Code CLI at the version pinned by the CLAUDE_CODE_VERSION
# build-arg (default 2.1.207; overridable; NEVER an unpinned latest — design D7).
# A `claude-code` task is launched IN-SHELL over /v1/shell/ws by the orchestrator
# bridge (exactly like codex), so the binary MUST be present in the image; there
# is no per-task install step (the gem user, uid 1000, cannot `npm i -g` to the
# root-owned prefix). `claude --version` asserts the derived image actually bakes
# the requested CLAUDE_CODE_VERSION (parity with the codex/openspec bake checks).
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && claude --version

# Bake the OpenSpec CLI (task-preinstall-skills): the `openspec` skill's
# SKILL.md steps shell out to this CLI, and the per-task provision channel (gem,
# uid 1000) cannot `npm i -g` to the root-owned prefix — so install it here as
# root, landing `/usr/bin/openspec` on PATH for the codex process. Pinned via the
# OPENSPEC_VERSION build-arg (same pin the per-task `openspec init` uses). Only
# OpenSpec needs this — BMAD's skills are self-contained agent personas that do
# not hard-depend on a `bmad` CLI at runtime. `openspec --version` asserts the bake.
RUN npm install -g "@fission-ai/openspec@${OPENSPEC_VERSION}" \
  && openspec --version

RUN node /usr/local/bin/write-sandbox-metadata.mjs \
  --sandbox-version "${CAP_VERSION}" \
  --dependency "codex=${CODEX_VERSION}" \
  --dependency "claude-code=${CLAUDE_CODE_VERSION}" \
  --dependency "openspec=${OPENSPEC_VERSION}" \
  --output /etc/cap/sandbox-metadata.json

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

# The AIO base creates `gem` at runtime (uid/gid 1000). Create only the runtime
# directories needed for credentials/workspace, then assign numeric ownership;
# no hooks.json or /opt/cap hook runtime is copied into the final image.
RUN mkdir -p /home/gem/.codex /home/gem/workspace

# --- 6.1/6.3 codex launch path: YOLO-style bypass -------------------------
# The orchestrator launches interactive Codex tasks with Codex's documented
# `--dangerously-bypass-approvals-and-sandbox` mode (the long form of the newer
# `--yolo` alias) so the in-task agent does not stop for per-command approvals.
# The platform's isolation boundary is the per-task AIO container, not Codex's
# inner sandbox.
#
# The interactive PTY is intentionally not a pre-execution approval-gated
# surface. `SandboxApprovalEnforcer` remains a dormant fail-closed class with no
# production exec caller; it is not a fallback guarantee for this launch path.

# The exact launch argv the orchestrator bridge injects in-shell over
# /v1/shell/ws (kept here as the launch contract; the bridge mirrors it as its
# DEFAULT_CODEX_LAUNCH_ARGV). `-C /home/gem/workspace` runs codex in the cloned
# task repo. The DIRECTORY trust prompt is handled separately by the provider writing
# ~/.codex/config.toml at provision time, NOT a launch flag. NEVER add
# `--ask-for-approval`/`--sandbox` here unless deliberately changing the task
# approval contract back away from YOLO-style execution.
#
# TASK PROMPT (aio-codex-prompt-autostart): this argv is the BASE launch only.
# The orchestrator bridge appends the task's prompt as codex's positional
# `[PROMPT]` via `"$(cat /home/gem/.codex/task-prompt.txt)"` (the prompt file is
# written into the sandbox at provision time), so codex starts with the operator
# goal PRE-FILLED. The prompt text is NEVER inlined here or into the launch argv
# (it rides the injected file), keeping it shell-injection-safe and clear of the
# launch flags. Do NOT add a positional prompt to this ENV.
ENV CODEX_LAUNCH_ARGV="codex -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox"

RUN chown -R 1000:1000 /home/gem

# No CMD/ENTRYPOINT override: the AIO base image's own entrypoint starts the
# sandbox HTTP/WS server. Codex is launched in-shell over /v1/shell/ws by the
# orchestrator bridge (as `codex --dangerously-bypass-approvals-and-sandbox`,
# CODEX_LAUNCH_ARGV above), not by this image.
