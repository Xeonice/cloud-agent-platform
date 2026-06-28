# Epic: Open-source self-hostable + self-updating cap

> Planning / reference doc (the "母文档") for turning cap into an open-source project
> that strangers can self-host AND update from inside the app. NOT an OpenSpec change
> itself — it is the shared background each phase's change proposal references.
> Captured from an explore session (2026-06-17) grounded in a 5-investigator
> read-only codebase survey; file:line citations are from that survey.

## Why

cap is going open-source: others will clone/download it, run it on their own infra,
and need a place to discover + apply updates. The enabler already shipped —
`survive-api-redeploy` means a backend redeploy no longer kills running tasks — so an
in-app one-click upgrade is uniquely feasible (cap already holds `docker.sock` for
sandbox provisioning).

## Current state (honest, grounded)

cap is **close** to self-hostable but not there. `make up` yields a LOCAL-ONLY mock
env in ~5 min; production self-host is blocked on a handful of gaps:

- **Frontend is Vercel-only, not in compose.** `apps/web/vite.config.ts:41` uses Nitro
  `preset: "vercel"`; `package.json` `start` already expects the `node-server` output
  (`.output/server/index.mjs`). So a stranger `docker compose up` gets api+postgres but
  NO frontend.
- **api + aio-sandbox build from source** (compose `build:`, not `image:`); no prebuilt
  images.
- **No CI / no `.github/workflows`** — no release automation, no GHCR publishing.
- **No `/version`** — `/health` exists (`apps/api/src/health/health.controller.ts`) but
  reports no build identity.
- **Config is ~80% env-driven** (OAuth client/secret/redirect, `AUTH_ALLOWLIST`,
  `SESSION_SECRET`, `CODEX_CRED_ENC_KEY`, `WEB_ORIGIN`, `SESSION_COOKIE_DOMAIN`,
  `VITE_API_BASE_URL`/`VITE_WS_URL`) but has gaps: `DATABASE_URL` hardcoded to the
  compose-internal `postgresql://cap:cap@postgres:5432/cap`, a cosmetic
  `grafana.douglasdong.com` in a compose comment, a still-required legacy `AUTH_TOKEN`
  path, and the vercel preset default.
- **Repo is currently PRIVATE** (`gh`: `Xeonice/cloud-agent-platform`, owner type=User).

## Locked decisions

| # | Decision |
|---|----------|
| Distribution | **GHCR prebuilt images**: `ghcr.io/xeonice/cap-api`, `cap-web`, `cap-aio-sandbox`, `cap-boxlite-sandbox` (owner `Xeonice` is a User account; GHCR names are lowercase). Token already has `write:packages` + `workflow`. |
| Repo visibility | Repo → **public** (the open-source premise); **GHCR packages must be set public** so self-hosters `docker pull` without auth. |
| Update UX | **Both**: a notify banner ("vY available" + changelog) AND a one-click **upgrade button** (in-app self-update). |
| Release line | **Unified release-gated**: even the maintainer's own prod deploys via cut Releases (consuming the same GHCR images) — NOT continuous-on-main. |
| Versioning | **One user-facing cap version unifies all release image tags** (`:vX.Y.Z`); the sandbox images internally bake their coupled runtime tool versions. A release ships a matched set; the compose/installer pins the selected runtime image to the same version, so there is no naive partial upgrade. |

## Four-layer architecture

| Layer | Home | Today |
|-------|------|-------|
| ① Version catalog + changelog | **GitHub Releases** (public API, free) | none |
| ② Running identity ("what am I running") | **`GET /version`** (extend `/health`) + web `VITE_BUILD_ID`, baked via Docker build-arg `GIT_SHA`/tag | `/health` exists, no version |
| ③ Availability check | instance polls Releases `latest` vs `/version` | none |
| ④ Update action | notify banner + one-click self-update (docker.sock + survive-api-redeploy) | none |

Licensing note: the AIO base `ghcr.io/agent-infra/sandbox` is **Apache-2.0** (ByteDance
agent-infra) — redistribution of a derived image is permitted, so publishing
`ghcr.io/xeonice/cap-aio-sandbox:<ver>` is clear.

## Phased plan (each phase ≈ one OpenSpec change)

### Phase 0 — "a stranger can run it" (mostly mechanical; highest leverage; unblocks all)
- Frontend into compose: Nitro `preset` `vercel`→`node-server` (or `NITRO_PRESET` env, zero source change) + a `apps/web/Dockerfile` + a `web` compose service (~15–30 lines).
- Config-ization closeout: make `DATABASE_URL` overridable, drop the hardcoded
  `grafana.douglasdong.com` comment, relax/justify the legacy `AUTH_TOKEN` requirement,
  complete `.env.example`.
- Self-host setup guide: the OAuth-app creation + allowlist is the hardest HUMAN step
  (~30 min, cannot be automated away) — provide a wizard-style guide.
- Goal: `docker compose up` → a working cap for a self-hoster.

### Phase 1 — "versions exist + are pullable" (depends: 0)
- `GET /version` (api: tag + gitSha + buildTime) + web build id, baked via build-arg.
- CI (GitHub Actions): on Release-publish, build + push `ghcr.io/xeonice/cap-api`,
  `cap-web`, `cap-aio-sandbox` at `:vX.Y.Z`; **set the GHCR packages public**.
- GitHub Releases as the catalog + changelog.
- Switch compose defaults to pull `image: ghcr.io/xeonice/...:vX.Y.Z` (keep
  build-from-source available for air-gapped).
- **Migrate the maintainer's own prod (Dokploy) from build-on-push to deploy-a-release**
  (pull the GHCR image for the tag) — the unified-release-line decision. This also means
  routine merges to main stop redeploying prod at all.

### Phase 2 — "the instance knows there's an update" (depends: 1)
- Update-check: poll Releases `latest` vs `/version` → console banner + changelog +
  the documented upgrade path. Universal and safe (no mutation).

### Phase 3 — "one-click self-update" (depends: 2; the differentiator; opt-in) — SHIPPED INERT (`self-update-action`)
- Console **upgrade button** → api uses `docker.sock` to pull the new image tags +
  recreate the cap services → `survive-api-redeploy` keeps running tasks alive.
- Two hard design points, both resolved in `self-update-action`:
  1. **Security**: the button exposes host-root-equivalent `docker.sock` power. Gated
     hard — hard env gate `SELF_UPDATE_ENABLED` (default off → endpoint refuses),
     allowlisted admin only behind OAuth, with confirmation, and BOUNDED (target
     validated against `/update-status`'s latest; pull only the cap GHCR namespace's
     pinned tags + recreate only cap services; never arbitrary container ops).
  2. **The api cannot cleanly recreate itself** while running. Resolved with a detached
     one-shot updater (a `compose pull && up -d` at the target `CAP_VERSION` that
     outlives the api's own restart) — same detached-process idiom as
     survive-api-redeploy's tmux approach.
- **Ships INERT**: `SELF_UPDATE_ENABLED` default off → `POST /self-update` refuses, and
  the `selfUpdate` capability flag is false → no button. Deploying it adds no live
  host-root button; activation (the env + flag + a real Release) is a deliberate
  operator step, documented in `deploy/DEPLOY.md` + `docs/self-hosting.md`.

## Risks / trade-offs

- **AIO image is large** (derived from a multi-GB base) — pulling on every update is
  heavy; pinned tags + layer caching matter.
- **One-click self-update = docker.sock behind a button** → security gating is critical.
- **Version-triplet coupling** (codex ↔ AIO base ↔ hook protocol) → a release MUST ship a
  matched image set; never allow upgrading api without its matching sandbox image.
- **Unified release line migrates the maintainer's current deploy** (build-on-push →
  release-gated) — intentional, but a real change to today's pipeline.
- **Human setup friction remains** — creating one's own GitHub OAuth app + allowlist
  cannot be fully automated.
- **Transcript host-loss backup** (`workspaces` volume) is still documented as out of
  scope — worth surfacing in self-host docs.

## Open follow-ups (not blocking Phase 0)
- Exact `/version` shape (semver vs git-only); nested `/health/version` vs sibling `/version`.
- Image-name casing + whether to later move to a GitHub org for branding.
- Watchtower-style auto-update as an opt-in beyond the manual button (future).

## Recommendation
Start at **Phase 0** (it's mostly mechanical, turns cap into something others can run, and
unblocks everything), then 1 → 2 → 3. Phase 3 (the button) is the differentiator but must
come last and opt-in.
