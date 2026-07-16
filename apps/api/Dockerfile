# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# apps/api orchestrator image (NestJS WebSocket + PTY control plane).
#
# This is the platform DEPLOY plane, not the per-task execution sandbox (see
# the sandbox-provider-port track / design D9 — Docker-as-execution forces
# danger-full-access). It runs the same NestJS WS+PTY orchestrator that the
# Fly.io and docker-compose targets run.
#
# node-pty is a native addon, so the build stage needs python3 + a C/C++
# toolchain. The runtime stage stays slim and runs as a non-root user.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=20

# --- deps + build -----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo

# Toolchain for native modules (node-pty) and Prisma's openssl needs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Enable the pinned pnpm via corepack.
RUN corepack enable

# Workspace manifests first for a cacheable install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# Install the whole workspace (api depends on packages/contracts via workspace:*).
RUN pnpm install --frozen-lockfile

# Build workspace libraries then the api (prisma generate runs inside the api build script).
# Dev deps (the prisma CLI + nest build toolchain) are intentionally kept so
# `prisma migrate deploy` can run at container start in the runtime stage.
RUN pnpm --filter @cap/contracts build \
  && pnpm --filter @cap/sandbox-core build \
  && pnpm --filter @cap/sandbox-cloud-http build \
  && pnpm --filter @cap/sandbox-provider-aio build \
  && pnpm --filter @cap/sandbox-provider-boxlite build \
  && pnpm --filter @cap/sandbox build \
  && pnpm --filter @cap/api build

# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /repo

ENV NODE_ENV=production
# Persistent volume mount point. The Fly volume (fly.toml [mounts]) and the
# docker-compose named volume both mount here so workspaces/<id>/session.log
# survives an orchestrator restart and reconnect tail-replay still works.
ENV WORKSPACES_DIR=/data/workspaces
ENV PORT=8080

# Build-version metadata (versioned-release-pipeline). The release workflow
# passes these as `docker/build-push-action` build args; carry each ARG into the
# runtime stage as an ENV so the running api self-reports them at GET /version
# (read from process.env). Each DEFAULTS to "unknown" so a plain source build
# with no build args reports honestly rather than failing — and reports NO
# secrets (build metadata only). Declared in this stage because build args do not
# cross FROM boundaries; only the runtime stage consumes them.
ARG CAP_VERSION=unknown
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV CAP_VERSION=${CAP_VERSION}
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Enable corepack so the api's own pnpm scripts (e.g. prisma:migrate) run.
RUN corepack enable

# Copy the installed workspace (incl. the prisma CLI) from the build stage.
COPY --from=build /repo /repo

# Create the volume mount target and hand it to the non-root runtime user.
RUN useradd --create-home --uid 10001 orchestrator \
  && mkdir -p /data/workspaces \
  && chown -R orchestrator:orchestrator /data /repo
USER orchestrator

VOLUME ["/data"]
EXPOSE 8080

WORKDIR /repo/apps/api
# Apply pending Prisma migrations, then start the NestJS WS+PTY orchestrator.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/main.js"]
