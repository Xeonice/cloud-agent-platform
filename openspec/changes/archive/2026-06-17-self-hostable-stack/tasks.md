<!-- Track-annotated tasks. Each numbered group is a parallel Track.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: web-image (depends: none)

<!-- Files: apps/web/vite.config.ts (1.1), apps/web/Dockerfile [new] (1.2),
     apps/web/.env.example (1.3); 1.4 is verify-only (builds the image, runs
     .output/server/index.mjs), no file edit. Verified disjoint from tracks 2/3:
     no other track edits any apps/web file. Track 2's web compose service (2.1)
     references apps/web/Dockerfile only by build-context PATH — it does not edit
     the file — so the Dockerfile is not a shared file. -->

- [x] 1.1 In `apps/web/vite.config.ts`, select the Nitro preset from a `NITRO_PRESET` env/build arg, defaulting to `node-server` when unset for the image build while leaving `vercel` selectable (the Vercel project sets `NITRO_PRESET=vercel`). No app-code/logic change.
- [x] 1.2 Add `apps/web/Dockerfile` (multi-stage, Node 22 to match `engines.node`): install workspace deps with pnpm, `pnpm --filter @cap/web build` with `NITRO_PRESET=node-server`, runtime stage runs `node .output/server/index.mjs` on `PORT` (default 3000). Accept `VITE_API_BASE_URL`/`VITE_WS_URL` as build args (baked at build, domain-specific image) and document that.
- [x] 1.3 Complete `apps/web/.env.example` for a real (production, cross-origin) deployment: `VITE_API_BASE_URL`/`VITE_WS_URL` with guidance that they are build-time values.
- [x] 1.4 Verify the web image builds and `node .output/server/index.mjs` serves the console (SSR + assets) against a configured api base — confirm the `node-server` preset emits `.output/server/index.mjs` on the pinned Nitro version.

## 2. Track: compose-and-config (depends: none)

<!-- Files: docker-compose.yml (2.1 adds web service; 2.2 edits DATABASE_URL @line82
     + drops the grafana.douglasdong.com comment @line270 — both same-file, kept in
     ONE track so they serialize), apps/api/src/main.ts (2.3 — read-only imports
     isLegacyTokenEnabled from auth/oauth-config.ts, does not edit it),
     apps/api/.env.example (2.4), apps/api/src/main.test.mjs [new] (2.5 — no top-level
     api test exists yet; mirrors the auth/*.test.mjs style). Verified disjoint from
     tracks 1/3: only this track edits docker-compose.yml / apps/api source. The web
     service references apps/web/Dockerfile by build-context PATH only — not a shared
     edit. -->

- [x] 2.1 In `docker-compose.yml`, add a `web` service: `build` from `apps/web/Dockerfile`, `restart: unless-stopped`, reuse the `*default-logging` anchor, join the `default` network, `depends_on: api`, pass `VITE_API_BASE_URL`/`VITE_WS_URL` (and `PORT`), publish the host port (default 3000). It runs NO WebSocket server (points at the api's WS via env).
- [x] 2.2 In `docker-compose.yml`, make `DATABASE_URL` an env-overridable value with the current `postgresql://cap:cap@postgres:5432/cap` as the default (honor an external override), and REMOVE the hardcoded `grafana.douglasdong.com` reference from the compose comment.
- [x] 2.3 In `apps/api/src/main.ts`, relax the legacy `AUTH_TOKEN` requirement so an OAuth-first instance (legacy path NOT enabled) boots with GitHub-OAuth config alone and no `AUTH_TOKEN`; leave the local-dev legacy-token path (`AUTH_TOKEN_LEGACY_ENABLED=true`) behavior unchanged.
- [x] 2.4 Complete `apps/api/.env.example` for a real OAuth-first deploy (OAuth client/secret/redirect, `AUTH_ALLOWLIST`, `SESSION_SECRET`, `CODEX_CRED_ENC_KEY`, `WEB_ORIGIN`, `SESSION_COOKIE_DOMAIN`, `DATABASE_URL`), with the legacy token clearly marked optional/dev-only.
- [x] 2.5 Add/extend a focused test for the relaxed boot: the api bootstrap does NOT throw when OAuth is configured and no legacy `AUTH_TOKEN` is set + legacy path disabled (mirror the existing main/auth-config test style; `.mjs`).

## 3. Track: setup-guide (depends: none)

<!-- Files: docs/self-hosting.md [new] (3.1), README.md (3.2 — adds a link).
     Verified disjoint from tracks 1/2: no other track edits docs/ or README.md. -->

- [x] 3.1 Write `docs/self-hosting.md`: an operator-facing guide covering — create a GitHub OAuth app (client id/secret, callback URL = `<api-origin>/auth/github/callback`), set `AUTH_ALLOWLIST` (numeric GitHub IDs), configure public domains (`VITE_API_BASE_URL`/`VITE_WS_URL`/`WEB_ORIGIN`) + `SESSION_COOKIE_DOMAIN` for same-origin AND cross-subdomain deploys (call out this is the most error-prone step), generate `SESSION_SECRET`/`CODEX_CRED_ENC_KEY`, then `docker compose up`. Note it is OAuth-first (no legacy token needed) and references the epic doc.
- [x] 3.2 Link `docs/self-hosting.md` from `README.md` so it is GitHub-discoverable.

## 4. Track: integration-verify (depends: web-image, compose-and-config, setup-guide)

<!-- Integration track: runs serially AFTER the parallel tracks 1/2/3. Both tasks are
     verify-only (no file edits): there are NO shared-file tasks to isolate here — the
     three draft tracks already touch disjoint files. This track only validates the
     composed result end-to-end. -->

- [x] 4.1 Bring up the compose stack locally with the `web` profile (`COMPOSE_PROFILES=web docker compose up --build`): confirm the `web` service image builds (Nitro `node-server` → `.output/server/index.mjs`) and serves the console, the api boots OAuth-first (no legacy token), `DATABASE_URL` override is honored, the `web` service is profile-gated (absent without the profile), and no maintainer-hardcoded domain remains. (VERIFIED LOCAL 2026-06-17: web image builds via node-server preset → .output/server/index.mjs, container serves HTTP 200 "Listening on :3000"; api OAuth-first boot covered by main.test.mjs 4/4; docker compose config shows web only under the web profile (0 default); DATABASE_URL override honored; grafana.douglasdong.com removed. Full OAuth login flow is a deploy-time check needing a real GitHub OAuth app.)
- [x] 4.2 Run the api test suite + web build + workspace typecheck/lint to confirm nothing regressed.
