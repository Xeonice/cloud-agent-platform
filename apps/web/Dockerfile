# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# apps/web console image (TanStack Start, self-hostable-stack D1).
#
# Ships the web console as a self-contained Node server inside the compose
# stack: the Nitro `node-server` preset emits `.output/server/index.mjs`, run
# as a long-running Node process (`node .output/server/index.mjs`, the `start`
# script). The Vercel deploy path is unaffected — that target is selected by
# `NITRO_PRESET=vercel` in the Vercel project, not here.
#
# Node 22 to match the workspace `engines.node` (>=22.0.0). The web app hosts
# NO WebSocket server of its own; it points at the api's WS via the baked
# `VITE_WS_URL`.
#
# `VITE_*` are BUILD-TIME values: Vite inlines only `VITE_`-prefixed vars into
# the client bundle at build, so `VITE_API_BASE_URL` / `VITE_WS_URL` are passed
# as build args and BAKED IN — the resulting image is domain-specific. A
# self-hoster builds the image for their own api origin (see docs/self-hosting.md).
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22

# --- deps + build -----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo

# Build-time api endpoints, baked into the client bundle by Vite. These MUST be
# provided at build time for a real (cross-origin) deploy; the defaults are the
# local-dev fallbacks only.
ARG VITE_API_BASE_URL=http://localhost:8080
ARG VITE_WS_URL=ws://localhost:8080
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_WS_URL=${VITE_WS_URL}

# Build id baked into the client bundle (versioned-release-pipeline web-buildid).
# CI passes the release tag as this build arg so the running console reports its
# own build; defaults to the "dev" sentinel for a plain source build (matching
# the vite.config.ts `define` fallback).
ARG VITE_BUILD_ID=dev
ENV VITE_BUILD_ID=${VITE_BUILD_ID}

# Select the compose-hosted Node-server target (vite.config.ts reads this).
ENV NITRO_PRESET=node-server

# Enable the pinned pnpm via corepack.
RUN corepack enable

# Workspace manifests first for a cacheable install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web

# Install the whole workspace (web depends on packages/contracts + packages/ui
# via workspace:*).
RUN pnpm install --frozen-lockfile

# Build the workspace deps first — @cap/contracts and @cap/ui both resolve via
# their `dist/` build output (package `exports`), and @cap/ui itself depends on
# @cap/contracts, so the order is contracts -> ui -> web. Then build the web app
# with the node-server preset (emits .output/server/index.mjs).
RUN pnpm --filter @cap/contracts build \
  && pnpm --filter @cap/ui build \
  && pnpm --filter @cap/web build

# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy only the self-contained Nitro server output. `node-server` bundles its
# runtime deps into .output, so no node_modules / pnpm install is needed here.
COPY --from=build /repo/apps/web/.output ./.output

# Run as a non-root user.
RUN useradd --create-home --uid 10001 web \
  && chown -R web:web /app
USER web

EXPOSE 3000

# Long-running Node server (the `start` script target). Nitro's node-server
# listens on PORT (default 3000).
CMD ["node", ".output/server/index.mjs"]
