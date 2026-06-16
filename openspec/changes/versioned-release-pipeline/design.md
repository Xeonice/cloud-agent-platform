## Context

Phase 1 of the OSS self-update epic (`docs/oss-self-update-epic.md`). Phase 0 made cap
self-hostable from the compose stack; Phase 1 adds the VERSION SUBSTRATE: the running
system reports its version, and a Release publishes pinned, matched GHCR images. The seam
is small (`research-brief.md`): `/health` is an unauthenticated controller a `/version`
sibling joins; the api Dockerfile gains version build-args; GHCR is greenfield and the
owner token already has `write:packages`. The decisive constraint is that the ACTIVATION
(repo/packages public, cutting a Release, migrating prod) is operator-gated — so this
change ships only INERT/SAFE code and documents the gated steps.

## Goals / Non-Goals

**Goals:**
- `GET /version` reports `{ version, gitSha, buildTime }`, honest `"unknown"` fallback.
- A web build id is baked and readable.
- A `release: published` CI workflow publishes the matched `cap-api`/`cap-web`/`cap-aio-sandbox`
  set at one cap version to GHCR, packages public, with version build-args injected.
- A documented prebuilt-image self-host path, default build-from-source unchanged.
- Committing this change is inert on the running system (no behavior flip).

**Non-Goals:**
- Making the repo/packages public, cutting a Release, or migrating the maintainer's prod
  (operator-gated; documented, not executed).
- Flipping the default compose to image-pull (images don't exist until a Release).
- Phase 2 (update-check) / Phase 3 (one-click upgrade).

## Decisions

### D1 — `/version` is unauthenticated, build-arg-fed, honest-fallback
A `GET /version` sibling of `/health` (same module, exempt from the operator guard — it is
build metadata, no secrets) returns `{ version, gitSha, buildTime }` from `process.env`
(`CAP_VERSION`/`GIT_SHA`/`BUILD_TIME`), each defaulting to `"unknown"` when unset. The api
Dockerfile declares the ARGs and ENVs them into the runtime stage; a plain source build
(no args) reports `"unknown"` rather than failing.
- *Sibling `/version` vs nested `/health/version`:* sibling — keeps `/health` a zero-IO
  liveness probe and gives a clean public version surface for the update-check.

### D2 — Single cap version unifies the three image tags (decision ⑤)
The release workflow tags `cap-api`, `cap-web`, `cap-aio-sandbox` all with the Release tag
`vX.Y.Z` and builds them as a matched set in one workflow run, injecting
`CAP_VERSION=<tag>` + `GIT_SHA` + `BUILD_TIME`. The `cap-aio-sandbox` image internally bakes
the coupled triplet (AIO base tag + codex version + hook protocol) — those are build-args of
its Dockerfile, surfaced in the release notes but hidden behind the single user-facing version.

### D3 — Release-triggered, inert-until-cut
The workflow triggers ONLY on `release: published` (plus `workflow_dispatch` for manual
re-runs). Merely committing it runs nothing; the first real publish happens when the
operator cuts a Release. It uses the built-in `GITHUB_TOKEN` with `packages: write` and sets
the published packages public so self-hosters pull without auth.

### D4 — Prebuilt-image path is additive/opt-in; default stays build-from-source
A `docker-compose.images.yml` override maps each service to `image: ghcr.io/xeonice/cap-*:${CAP_VERSION}`
so a self-hoster runs `docker compose -f docker-compose.yml -f docker-compose.images.yml up`
to pull instead of build. The base compose is unchanged (build-from-source remains the
default), so nothing breaks before images exist.

### D5 — Operator-gated activation is documented, not executed
`docs/self-hosting.md` + `deploy/DEPLOY.md` document the steps only the owner can take:
make the repo + GHCR packages public; cut the first Release (triggers CI); migrate the
maintainer's prod (Dokploy) from build-on-push to deploy-a-pinned-release. This change does
NONE of these — it surfaces them.

## Risks / Trade-offs

- **`/version` reports `unknown` on a non-CI build** (e.g. the maintainer's current Dokploy
  build-from-source that doesn't pass the args). → Acceptable + honest; becomes meaningful
  once images are CI-built. Could later wire Dokploy/compose to pass `GIT_SHA`.
- **GHCR package visibility defaults to private.** → The workflow (or a one-time owner
  setting) must set them public, else self-hosters can't pull; documented as a gate.
- **Version-triplet coupling** (codex ↔ AIO base ↔ hook protocol) → the release builds the
  matched set together; a self-hoster must pull the whole set at one version (the
  image-override file pins all three to `${CAP_VERSION}`).
- **Workflow correctness can't be fully verified without a Release.** → Lint/validate the
  YAML + `workflow_dispatch` dry-run capability; the true end-to-end is the first Release
  (operator-gated).

## Migration Plan
1. Ship `/version` + web build id + Dockerfile args + the inert release workflow + the
   image-override file + docs. Safe to deploy (no behavior change; `/version` degrades).
2. OPERATOR GATES (surfaced, not done here): make repo + packages public → cut `vX.Y.Z`
   Release → CI publishes the matched images → optionally migrate prod to deploy that tag.
- **Rollback:** all additive; remove the workflow/endpoint/override to revert.

## Open Questions
- `version` value source: the Release tag (`CAP_VERSION`) vs a `package.json` version vs
  git describe. (Lean: the Release tag, single source via the workflow.)
- Whether to also publish `:latest` / `:sha` tags alongside `:vX.Y.Z` (lean: `:vX.Y.Z`
  + `:latest` for convenience, both immutable-by-policy except latest).
