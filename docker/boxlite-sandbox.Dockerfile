# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# BoxLite task runtime image.
#
# This is the BoxLite-compatible sibling of docker/aio-sandbox.Dockerfile. It
# does not embed the AIO HTTP bridge; BoxLite supplies exec/terminal/archive
# operations. It does bake the same task-runtime dependency contract CAP relies
# on: Codex CLI, Claude Code CLI, OpenSpec CLI, git, bash, tar, gzip, tmux, and
# the canonical /home/gem/workspace layout used by the agent launch code.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG CODEX_VERSION=0.131
ARG CLAUDE_CODE_VERSION=2.1.181
ARG OPENSPEC_VERSION=1.4.1
ARG CAP_VERSION=unknown
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown

ENV NODE_ENV=production
ENV CAP_VERSION=${CAP_VERSION}
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV HOME=/home/gem
ENV CODEX_LAUNCH_ARGV="codex --no-alt-screen -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gzip \
    openssh-client \
    procps \
    tar \
    tmux \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
  && codex --version

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && claude --version

RUN npm install -g "@fission-ai/openspec@${OPENSPEC_VERSION}" \
  && openspec --version

RUN useradd --create-home --uid 1000 --shell /bin/bash gem \
  && mkdir -p /home/gem/workspace /home/gem/.codex /home/gem/.claude \
  && chown -R gem:gem /home/gem

USER gem
WORKDIR /home/gem/workspace

CMD ["sleep", "2147483647"]
