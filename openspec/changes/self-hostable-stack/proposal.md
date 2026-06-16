## Why

cap is going open-source, but a stranger cannot stand up a complete instance today: the frontend is Vercel-only (NOT in the compose stack), so `docker compose up` yields api+postgres but no console; and a few deployment-specific values are hardcoded to the maintainer's setup (`DATABASE_URL` pinned to the compose-internal `cap:cap@postgres`, a `grafana.douglasdong.com` comment, a still-required legacy `AUTH_TOKEN` path). This is **Phase 0** of the OSS self-update epic (`docs/oss-self-update-epic.md`): make cap fully self-hostable from one compose stack with real GitHub-OAuth — the prerequisite for versioned images, update-checks, and the one-click upgrade button in later phases.

> Side-car: `research-brief.md` records the grounded findings; the epic context lives in `docs/oss-self-update-epic.md`. Neither is a tracked OpenSpec artifact.

## What Changes

- **Ship the frontend in the compose stack as a self-contained Node server.** Switch the `apps/web` Nitro build from the `vercel` preset to `node-server` (via a `NITRO_PRESET` build arg defaulting to `node-server` for the image, leaving the Vercel path available), add an `apps/web/Dockerfile` (multi-stage, runs `node .output/server/index.mjs`), and add a `web` service to `docker-compose.yml` (joins the `default` network, reaches `api` by name, reuses the logging anchor). The compose stack becomes a COMPLETE cap (web + api + postgres) a stranger can bring up. **BREAKING** for nothing — the Vercel deploy path is preserved via the preset arg.
- **Make every deployment-specific value env-overridable (no maintainer-hardcoded values).** `DATABASE_URL` becomes overridable (the compose-internal `postgresql://cap:cap@postgres:5432/cap` stays the DEFAULT but an env override is honored, so a self-hoster can point at an external DB / change credentials); drop the hardcoded `grafana.douglasdong.com` from the compose comment; relax the legacy `AUTH_TOKEN` requirement so a clean OAuth-only self-host does not need a legacy token set; and complete `apps/api/.env.example` + `apps/web/.env.example` for a real (production, OAuth-first) deployment.
- **Add an operator-facing self-host setup guide.** A documented, step-by-step guide for the unavoidable human setup: creating a GitHub OAuth app (client id/secret/callback), setting the `AUTH_ALLOWLIST`, configuring the public domains (`VITE_API_BASE_URL`/`VITE_WS_URL`/`WEB_ORIGIN`/`SESSION_COOKIE_DOMAIN`), and bringing up the full compose stack. This is the operator path, distinct from the existing one-command LOCAL dev bring-up (legacy-token/mock), which is unchanged.

## Capabilities

### New Capabilities
- `self-hostable-deployment`: A stranger can stand up a COMPLETE, production-capable cap instance from the compose stack — the frontend ships as a self-contained Node-server service alongside api+postgres, every deployment-specific value (DB URL, public domains, OAuth app credentials, allowlist, secrets) is env-overridable with no maintainer-hardcoded values, and a documented setup guide covers the GitHub-OAuth-app + allowlist + domain steps so an OAuth-first (non-legacy) self-host works end to end.

### Modified Capabilities
- `multi-target-deploy`: the "Web target is Vercel web-only" requirement changes — the `apps/web` target is deployable EITHER to Vercel (preset preserved) OR as a self-contained Node-server inside the docker-compose stack (Nitro `node-server` preset → `.output/server/index.mjs`, run by a `web` compose service), so the compose topology is a complete self-host unit (web + api + postgres), still hosting no WebSocket server of its own (it proxies to the api's WS as before).

## Impact

- **Frontend:** `apps/web/vite.config.ts` (preset via `NITRO_PRESET` arg, default `node-server` for the image); new `apps/web/Dockerfile`; `apps/web/.env.example` completion. No app code/logic change (endpoint config already env-driven, `apps/web/src/lib/config.ts`).
- **Compose:** `docker-compose.yml` — new `web` service (default network, depends_on api, logging anchor, `VITE_API_BASE_URL`/`VITE_WS_URL` env, published port); `DATABASE_URL` made an overridable env (default unchanged); drop the `grafana.douglasdong.com` comment.
- **Backend config:** `apps/api/src/main.ts` legacy `AUTH_TOKEN` requirement relaxed so OAuth-only self-host needs no legacy token (the local-dev bring-up legacy path is unchanged); `apps/api/.env.example` completed for a real OAuth-first deploy.
- **Docs:** a new self-host setup guide under `docs/` (or `deploy/`); referenced from README.
- **Dependencies:** none new (Nitro already supports `node-server`; the web `start` script already targets `.output/server/index.mjs`).
- **Explicitly NOT in this change:** `/version`, CI/GHCR publishing, GitHub Releases, prod-pipeline migration (Phase 1); update-check banner (Phase 2); one-click upgrade (Phase 3); making the repo/packages public + cutting Releases (operator actions). The existing one-command LOCAL dev bring-up (`multi-target-deploy` "One-command local dev bring-up") is unchanged.
- **Specs:** 1 new (`self-hostable-deployment`) + 1 modified (`multi-target-deploy`).
