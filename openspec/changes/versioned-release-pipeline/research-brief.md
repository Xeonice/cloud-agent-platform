# Research Brief — versioned-release-pipeline (OSS self-update epic, Phase 1)

> Side-car. NOT a tracked artifact. Phase 1 of `docs/oss-self-update-epic.md`
> ("versions exist + are pullable"). Builds on Phase 0 (`self-hostable-stack`, shipped).

## Goal of Phase 1

cap reports the version it is running, and cutting a GitHub Release publishes a matched
set of versioned container images to GHCR so self-hosters (and, later, the maintainer's
own prod) can pull a pinned `vX.Y.Z` instead of building from source. This is the
substrate the update-check (Phase 2) and one-click upgrade (Phase 3) consume.

## Grounded findings (with citations)

- **Version seam is small.** `apps/api/src/health/health.controller.ts` is an
  unauthenticated `@Controller('health')` with a single `check()`. A sibling
  `GET /version` (also unauthenticated — build metadata, no secrets) returns
  `{ version, gitSha, buildTime }` read from `process.env`, injected via Docker
  `ARG`→`ENV` in `apps/api/Dockerfile` (which today has NO version ARG). The web build
  id rides on a Vite `define`/`import.meta.env.VITE_BUILD_ID` baked at build
  (`apps/web/vite.config.ts`), surfaced via the existing `apps/web/src/lib/config.ts`.
- **GHCR is greenfield + permitted.** Owner is the User `Xeonice`; images are
  `ghcr.io/xeonice/cap-api|cap-web|cap-aio-sandbox` (lowercase). The auth token already
  has `write:packages` + `workflow`. The AIO base `ghcr.io/agent-infra/sandbox` is
  Apache-2.0, so publishing a derived `cap-aio-sandbox` image is allowed.
- **No CI exists** (`.github/workflows` absent) — the release workflow is net-new.
- **Single version unifies the three tags** (locked decision ⑤): a Release `vX.Y.Z`
  publishes `cap-api:vX.Y.Z`, `cap-web:vX.Y.Z`, `cap-aio-sandbox:vX.Y.Z` as a matched set;
  the `cap-aio-sandbox` image internally bakes the coupled triplet (AIO base tag + codex
  version + hook protocol).

## Autonomous vs operator-gated (honest split)

**Autonomous (authored + shippable in this change):**
- `GET /version` + api Dockerfile ARG/ENV + web `VITE_BUILD_ID` (deployable now; degrades
  to "unknown" when the build args are not injected).
- `.github/workflows/release.yml` — triggers ONLY on `release: published`; committing it
  is INERT until a Release is cut, so it changes nothing about the running system.
- A documented prebuilt-image self-host path (compose `image:` override) WITHOUT flipping
  the default build-from-source.

**Operator-gated (DOCUMENTED here, NOT executed by the change):**
- Making the repo PUBLIC and the GHCR packages PUBLIC (identity/visibility — owner action).
- Cutting the first GitHub Release (the outward action that triggers CI to publish).
- Migrating the maintainer's prod (Dokploy) from build-on-push to deploy-a-release
  (touches the maintainer's infra; the unified-release-line decision ④).

## Anti-scope
- Phase 2 (update-check banner) and Phase 3 (one-click upgrade button) are later changes.
- This change does NOT flip the compose default to image-pull (images do not exist until a
  Release is published); image-pull is a documented alternative until activation.
