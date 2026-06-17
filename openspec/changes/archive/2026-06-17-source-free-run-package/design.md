## Context

A refinement of `release-and-versioning` (Phase 1), capturing the BUILD/RUN split the
operator asked for. Phase 1's prebuilt-image path was an overlay (`docker-compose.images.yml`)
that still needs the source tree and a layer-capable compose runner — Dokploy and "just give
me a file to run" self-hosters can't use it. The fix (already implemented) is a self-contained,
source-free `docker-compose.prod.yml` distributed via Release assets. This doc records the
decisions; the code shipped (commits f1e1bf7 / 5a8b850), and the only open task is the
`docs/self-hosting.md` fast-path addition.

## Goals / Non-Goals

**Goals:**
- A RUN unit usable with NO source clone: download the compose + an `.env`, `docker compose up`.
- Fully source-free: no `build:` blocks, no source-tree bind-mounts.
- Distributed via Release assets (clone-free).
- Build side and the default source path unchanged.

**Non-Goals:**
- Multi-arch images (cap is amd64 — the AIO sandbox base is amd64-only; documented, not chased).
- A runtime-config web (the prebuilt web image bakes VITE_* at build; future work).
- Changing the default `docker compose up` source build or removing the overlay.

## Decisions

### D1 — Self-contained, source-free run compose (not an overlay)
`docker-compose.prod.yml` is COMPLETE on its own: cap services use `image: ghcr.io/<owner>/cap-*:${CAP_VERSION:?…}`,
no `build:` blocks (can only pull), no `./deploy` or `apps/` bind-mounts. Env from a local
`.env` (+ Dokploy `../files/api.env`), both optional. This is what single-file platforms
(Dokploy) and clone-free runners need; the overlay (`docker-compose.images.yml`) stays for
source-having users who prefer layering.

### D2 — Run package is the CORE unit; source-coupled services dropped
nginx (source-coupled `nginx.conf`) and observability (loki/alloy/grafana, source-coupled
configs) are excluded — keeping them would break source-freeness. The run package = api +
per-task sandbox image (pull vehicle) + Postgres + optional `web` profile. Operators front the
api with their own TLS/reverse-proxy and run observability from the full source compose if wanted.

### D3 — Distribute via Release assets
`release.yml` attaches `docker-compose.prod.yml` + `docker-compose.prod.env.example` to each
Release (`attach-run-assets` job, `contents: write`), so RUN is downloadable independently of
the source — the build/run split made concrete.

### D4 — amd64-only, documented (not multi-arch)
The published images are amd64-only because the AIO sandbox base is amd64-only; cap is an amd64
platform. The run package documents "requires an amd64 host" so arm64 users get a clear reason,
rather than building multi-arch (not viable while the AIO base is amd64-only).

## Risks / Trade-offs

- **`docker-compose.prod.yml` drifts from `docker-compose.yml`** (parallel hand-maintained file).
  → Documented "keep in sync"; the run file is small (core services only), limiting drift.
- **Prebuilt web image is localhost-VITE-baked** → only correct for same-host; custom domains
  serve the console elsewhere or rebuild. Documented; the `web` service is opt-in (profile).
- **amd64-only** → arm64 hosts can't run natively; documented (the AIO base constrains this).

## Migration Plan
Already shipped (f1e1bf7 / 5a8b850); this change adds the `docs/self-hosting.md` fast path and
brings the spec in line. No deploy impact (additive run artifact + a Release-only CI job + docs).
- **Rollback:** remove `docker-compose.prod.yml` / the attach job; the overlay + source build remain.

## Open Questions
- A runtime-config web (drop build-time VITE baking) to make the prebuilt web image domain-portable — future.
- Whether to eventually generate `docker-compose.prod.yml` from the base to remove drift — future.
