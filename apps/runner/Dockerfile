# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# apps/runner image — runs the interactive Codex CLI under node-pty for one task.
#
# Two requirements this image satisfies (agent-events-and-approvals +
# terminal-execution specs, design D6/risks):
#
#   1. PIN a specific, known-good Codex version (live-frame byte-identity is
#      fragile across terminal/Codex versions, so we never install an unpinned
#      "latest").
#   2. SHIP the hook configuration at the top-level ~/.codex/hooks.json (a
#      repo-local .codex/config.toml does NOT fire hooks). The hook *scripts*
#      are authored by the agent-events track (apps/runner/src/hooks/**) and
#      compiled to dist/hooks/*.js; this image only ships them + the hooks.json
#      that wires Codex to them. It does not edit those scripts.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=20
# Pinned, known-good Codex CLI version. Bump deliberately, never to "latest".
ARG CODEX_VERSION=0.42.0

# --- build the runner workspace --------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo

# Toolchain for node-pty's native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
COPY apps/runner ./apps/runner

RUN pnpm install --frozen-lockfile

# Build contracts then the runner (compiles src/hooks/** to dist/hooks/**).
RUN pnpm --filter @cap/contracts build \
  && pnpm --filter @cap/runner build

RUN pnpm --filter @cap/runner... prune --prod

# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG CODEX_VERSION
WORKDIR /opt/runner

ENV NODE_ENV=production
# Per-task isolated workspaces/<id> live under here (terminal-execution spec).
ENV WORKSPACES_DIR=/work/workspaces

# git is required for the PostToolUse git-diff fallback report; ca-certificates
# for outbound TLS to the orchestrator dial-back.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install the PINNED Codex CLI version (never an unpinned latest).
RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
  && codex --version

# Non-root user with a real HOME so ~/.codex/hooks.json resolves correctly.
RUN useradd --create-home --uid 10001 runner \
  && mkdir -p /work/workspaces \
  && chown -R runner:runner /work

# Copy the built runner workspace (includes dist/hooks/*.js the hooks.json points at).
COPY --from=build --chown=runner:runner /repo /repo
RUN ln -s /repo/apps/runner/dist /opt/runner/dist \
  && ln -s /repo/apps/runner/node_modules /opt/runner/node_modules

USER runner

# Ship the hook configuration at the TOP-LEVEL ~/.codex/hooks.json (the only
# location Codex fires hooks from — a repo-local .codex/config.toml does not).
RUN mkdir -p /home/runner/.codex
COPY --chown=runner:runner apps/runner/hooks.json /home/runner/.codex/hooks.json

WORKDIR /work
# The orchestrator launches this image per task; the runner dials back out (no
# inbound port) and spawns the interactive codex under node-pty.
CMD ["node", "/repo/apps/runner/dist/main.js"]
