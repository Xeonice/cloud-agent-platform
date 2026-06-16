# Research Brief — self-hostable-stack (OSS self-update epic, Phase 0)

> Side-car. NOT a tracked artifact. This change is **Phase 0** of the epic captured
> in `docs/oss-self-update-epic.md` ("a stranger can run it"). Grounding below is
> from the explore session's 5-investigator read-only survey (2026-06-17).

## Goal of Phase 0

A stranger who clones/downloads cap can stand up a COMPLETE, production-capable
instance from one `docker compose up` (real GitHub-OAuth, not the local legacy
token), with the FRONTEND included in the stack and every deployment-specific value
env-overridable (no maintainer-hardcoded domains/DB). This unblocks the rest of the
epic (versioned images, update-check, one-click upgrade).

## Grounded findings (with citations)

- **Frontend can ship in compose, minimal change.** `apps/web/vite.config.ts:41` uses
  Nitro `preset: "vercel"`; the `node-server` preset emits `.output/server/index.mjs`,
  which `apps/web/package.json` `start` already runs. The endpoint config is already
  env-driven (`apps/web/src/lib/config.ts:39-46` reads `VITE_API_BASE_URL`/`VITE_WS_URL`,
  cross-origin ready). Gap = preset switch (or `NITRO_PRESET` env) + an `apps/web`
  Dockerfile + a `web` compose service (~15–30 lines), reusing the existing logging
  anchor + `default` network.
- **Config is ~80% env-driven already.** OAuth (`oauth-config.ts`), `AUTH_ALLOWLIST`,
  `SESSION_SECRET`, `CODEX_CRED_ENC_KEY`, `WEB_ORIGIN`, `SESSION_COOKIE_DOMAIN`,
  `VITE_*` are all env. Gaps: `DATABASE_URL` hardcoded to compose-internal
  `postgresql://cap:cap@postgres:5432/cap` (docker-compose.yml ~:82) — not overridable
  for an external DB / different creds; a cosmetic `grafana.douglasdong.com` in a compose
  comment (~:270); a still-required legacy `AUTH_TOKEN` value path (`main.ts:33-41`); and
  the vercel preset default.
- **Existing `multi-target-deploy` spec already covers** docker-compose api topology
  (DooD, cap-net, root, volume) and a one-command LOCAL dev bring-up (legacy-token/mock).
  Phase 0 MODIFIES "Web target is Vercel web-only" (web now ALSO ships in compose) and
  ADDS the production self-host story (full env-config + setup guide). The local
  bring-up requirement is NOT removed — it stays the dev path; this adds the real
  OAuth-gated self-host path.
- **Hardest human step is unavoidable**: creating one's own GitHub OAuth app + setting
  the allowlist (~30 min, no in-app UI). Phase 0 addresses it with a documented,
  wizard-style setup guide, not automation.

## Scope (Phase 0)

- Web into the compose stack (node-server preset + Dockerfile + `web` service).
- Config-ization closeout: `DATABASE_URL` overridable; drop the hardcoded prod domain
  comment; relax/justify the legacy `AUTH_TOKEN` requirement so OAuth-only self-host is
  clean; complete `.env.example` for a real (non-legacy) deployment.
- A self-host setup guide (OAuth app creation + allowlist + domains/cookie scope), as an
  operator-facing doc.

## Anti-scope (later phases)
- `/version`, CI/GHCR image publishing, GitHub Releases, prod-pipeline migration (Phase 1).
- Update-check banner (Phase 2). One-click upgrade button (Phase 3).
- Making the repo/packages public + cutting Releases are operator actions, not code.
