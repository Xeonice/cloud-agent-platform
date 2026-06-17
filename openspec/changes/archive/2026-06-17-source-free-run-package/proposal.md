## Why

Phase 1 shipped an opt-in prebuilt-image path as an OVERLAY (`docker-compose.images.yml`, layered onto the source `docker-compose.yml`). But that still requires the SOURCE TREE (the base compose + its source-coupled bind-mounts) and single-compose-file platforms (e.g. Dokploy) cannot layer `-f a -f b`. The operator's goal is a clean BUILD/RUN split: build stays on the build platform; RUN is a dedicated, source-free, one-click unit that anyone can pull-and-run WITHOUT cloning. This change captures the source-free run package that delivers that (already implemented; this proposal brings the spec + docs in line).

> Side-car: epic context in `docs/oss-self-update-epic.md`. This refines `release-and-versioning` (Phase 1).

## What Changes

- **Add a SOURCE-FREE run package: `docker-compose.prod.yml` + `docker-compose.prod.env.example`.** A self-contained compose with NO `build:` blocks and NO source-tree bind-mounts — the cap services run `image: ghcr.io/<owner>/cap-*:${CAP_VERSION}` (required-var: an unset version fails loudly). Env comes from a `.env` next to the compose (Dokploy's `../files/api.env` also honored), both optional. The core run unit is api + per-task sandbox image + Postgres + an optional `web` profile.
- **Scope the run package to the core; drop source-coupled services.** The reverse proxy (nginx, source-coupled `nginx.conf`) and the observability stack (loki/alloy/grafana, source-coupled configs) are NOT in the run package — operators front the api with their own TLS/proxy and run observability from the full source compose. This is what makes the run package source-free.
- **Distribute the run package via Release assets.** The release workflow attaches `docker-compose.prod.yml` + `docker-compose.prod.env.example` to each GitHub Release, so a runner downloads two files, fills `.env`, and `docker compose up` — no `git clone`.
- **Document the amd64 host requirement.** The published images are amd64-only because the AIO sandbox base is amd64; the run package notes this so arm64 hosts get a clear reason rather than a cryptic "no matching manifest" error.
- **Add a "run from prebuilt images (no source)" fast path to `docs/self-hosting.md`.**

## Capabilities

### Modified Capabilities
- `release-and-versioning`: the "documented prebuilt-image self-host path" requirement evolves from an opt-in OVERLAY (needs the source tree + a layer-capable compose) to ALSO providing a SELF-CONTAINED, SOURCE-FREE run package (`docker-compose.prod.yml`, no build blocks, no source bind-mounts, env from a local `.env`) that is attached to each Release for clone-free run, splitting RUN from BUILD; the default source build and the overlay both remain.

## Impact

- **Run artifact:** `docker-compose.prod.yml` (source-free, image-pinned, `${CAP_VERSION:?}` required) + `docker-compose.prod.env.example` (new). Already implemented.
- **CI:** `.github/workflows/release.yml` gains an `attach-run-assets` job (on `release: published`) uploading the two run files to the Release; `permissions` gains `contents: write`. Already implemented; both files are attached to `v0.1.0`.
- **Docs:** `deploy/DEPLOY.md` §11 updated to the source-free run path; `docs/self-hosting.md` gains a "run from prebuilt images (no source)" fast path (THIS change's remaining doc task).
- **Not changed:** the default `docker compose up` source build; the `docker-compose.images.yml` overlay (still available for source-having users who want layering); build-side (`docker-compose.yml` + the image-build jobs).
- **Specs:** 1 modified (`release-and-versioning`). No new capability.
