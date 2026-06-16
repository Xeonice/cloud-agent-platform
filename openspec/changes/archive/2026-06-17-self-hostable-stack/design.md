## Context

Phase 0 of the OSS self-update epic (`docs/oss-self-update-epic.md`). Today `make up`
yields a LOCAL-ONLY mock env (legacy operator token), but a production self-host is
blocked because the frontend deploys ONLY to Vercel (not in the compose stack) and a few
values are pinned to the maintainer's deployment. The grounded findings
(`research-brief.md`) show the gap is small and mostly mechanical: the web app already
builds a Nitro server and its `start` script already targets `.output/server/index.mjs`;
endpoint config is already env-driven; the api config is ~80% env-driven. This change
makes the compose stack a complete, env-configurable, OAuth-first self-host unit.

This touches the deploy topology + a new operator doc but is low-risk (no app logic
change), so the design is short.

## Goals / Non-Goals

**Goals:**
- `docker compose up` brings up a COMPLETE cap (web + api + postgres) a stranger can use.
- The Vercel web deploy path is PRESERVED (preset selectable), not replaced.
- Every deployment-specific value is env-overridable; no maintainer-hardcoded values.
- A clean OAuth-first self-host needs no legacy `AUTH_TOKEN`.
- A documented setup guide covers the unavoidable human steps (OAuth app + allowlist + domains).

**Non-Goals:**
- `/version`, CI/GHCR images, Releases, prod-pipeline migration (Phase 1+).
- Removing or changing the existing one-command LOCAL dev bring-up (legacy-token/mock).
- Automating GitHub-OAuth-app creation (cannot be automated; guided instead).
- Making the repo/packages public or cutting Releases (operator actions, not code).

## Decisions

### D1 — Web ships in compose via the Nitro `node-server` preset, Vercel path preserved
Select the Nitro preset by a `NITRO_PRESET` build arg: the new `apps/web` image builds
with `node-server` (emits `.output/server/index.mjs`, run by `node .output/server/index.mjs`
— already the `start` script); Vercel builds continue using `vercel` (the existing
default for the Vercel project, set via its env/`NITRO_PRESET`). No app code changes — the
endpoint config already reads `VITE_API_BASE_URL`/`VITE_WS_URL` (`apps/web/src/lib/config.ts`).
- *Alternative — hard-switch the source default to `node-server`:* rejected; it would break/confuse the maintainer's Vercel deploy. A build arg keeps both targets first-class.
- *VITE_* values are build-time:* the web image bakes `VITE_API_BASE_URL`/`VITE_WS_URL` at build via build args (so a self-hoster builds with their domains), with compose passing them through; documented in the setup guide.

### D2 — `DATABASE_URL` overridable with the current value as default
Compose reads `DATABASE_URL` from env, defaulting to the existing
`postgresql://cap:cap@postgres:5432/cap` so nothing changes for the default stack, but a
self-hoster can override (external DB / different credentials). Same env-with-default
idiom already used across the compose file.

### D3 — Relax the legacy `AUTH_TOKEN` requirement for OAuth-first self-host
`apps/api/src/main.ts` no longer hard-requires a legacy `AUTH_TOKEN` value when
`AUTH_TOKEN_LEGACY_ENABLED` is not set; an OAuth-first instance boots with OAuth config
alone. The local-dev bring-up (which generates a legacy token and sets
`AUTH_TOKEN_LEGACY_ENABLED=true`) is unchanged and still works.

### D4 — Operator setup guide as a doc, not automation
A `docs/` (or `deploy/`) self-host guide walks: create a GitHub OAuth app (client
id/secret/callback = `<api-origin>/auth/github/callback`), set `AUTH_ALLOWLIST` (numeric
GitHub IDs), set the public domains + `SESSION_COOKIE_DOMAIN` for a cross-subdomain
deploy, generate `SESSION_SECRET`/`CODEX_CRED_ENC_KEY`, then `docker compose up`.
Referenced from README.

## Risks / Trade-offs

- **`node-server` preset behavior on the pinned Nitro beta.** → Verify the preset emits
  `.output/server/index.mjs` and serves SSR + the API-proxy correctly on the pinned
  Nitro version; if a `vercel`-only optimization is lost, it is irrelevant for a
  single-region self-host. Validated by building the web image + smoke-running it.
- **Build-time `VITE_*` baking.** → The web image is domain-specific (baked at build).
  Acceptable for self-host (you build for your domain); documented. (A runtime-config
  indirection is a future option, out of scope.)
- **CORS / cookie scope for a stranger's domains.** → The setup guide must make
  `WEB_ORIGIN` + `SESSION_COOKIE_DOMAIN` explicit for same-origin vs cross-subdomain
  deploys; getting these wrong is the most likely self-host failure (already env-driven,
  just needs docs).
- **Port collisions** (web 3000 vs local dev). → Container-internal port is fixed; host
  publish is configurable; documented.

## Migration Plan
1. Add the web Dockerfile + compose service + preset arg; `DATABASE_URL` override; drop the
   hardcoded comment; relax legacy `AUTH_TOKEN`; complete `.env.example`s; write the setup guide.
2. Verify locally: `docker compose up` builds + serves the web console against the api;
   an OAuth-first env (no legacy token) boots.
- **Rollback:** the web service is additive; removing it + reverting the preset arg restores
  the prior Vercel-only posture. No schema change.

## Open Questions
- Doc home: `docs/self-hosting.md` vs `deploy/SELF-HOSTING.md` (lean `docs/`, README-linked).
- Should the web image's `VITE_*` be build-arg-baked (domain-specific image) now, or add a
  runtime-config shim later? (Lean: build-arg now; shim is a future nicety.)
