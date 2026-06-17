## Context

`self-update-action` shipped with the updater's compose topology as fixed source-overlay literals
(`COMPOSE_FILES = [docker-compose.yml, docker-compose.images.yml]`, working dir `/srv/cap`, no `-p`,
services `[api, web, aio-sandbox-image]`). Production has since cut over to a resident
`docker-compose.prod.yml` stack (project `cloud-agent-platform`, dir
`/etc/dokploy/compose/cloud-agent-platform/resident/`, no `web`). Verified on the live host: the
api's own container carries `com.docker.compose.project / .project.config_files /
.project.working_dir` labels pointing at the resident prod.yml, `/srv/cap` does not exist, and the
cap-image services are `api` + `aio-sandbox-image`. So the one-click upgrade, even if enabled, would
`docker compose` the wrong files/dir/project and not update the running stack. The notification half
(`/update-status`) already works; this fixes the self-execute half.

This is the most dangerous surface in the epic (a host-root container op behind a button), so the
redesign is judged first on whether it PRESERVES the existing containment, second on correctness.

## Goals / Non-Goals

**Goals:**
- The one-click upgrade correctly targets whatever compose stack is actually running (resident
  prod.yml today; source/overlay too) with no per-deploy topology configuration.
- The new version STICKS (a later manual `up -d` does not revert it).
- Preserve every existing containment bound (gates, version cross-check, cap-only, detached,
  pull-then-recreate).

**Non-Goals:**
- Fully-automatic / unattended upgrades (poll → auto-trigger). One-click stays — deliberate, like
  release-please's human-merged release PR.
- Changing the admin gate itself. It stays the standalone `SELF_UPDATE_ADMINS` env allowlist; the
  role-based evolution waits for a user-tiering system.
- Building the user-tiering / role system.

## Decisions

### D1 — Derive topology from the api's OWN container compose labels (not literals, not env)
The api identifies its own container (`os.hostname()` → the container id → `docker inspect` over the
existing docker.sock, the same `new Docker()` idiom `AioSandboxProvider` uses) and reads:
- `com.docker.compose.project` → the `-p` project name,
- `com.docker.compose.project.config_files` → the `-f <file>` set (comma-separated absolute paths),
- `com.docker.compose.project.working_dir` → the dir to run in / bind-mount.
It reconstructs `docker compose -p <project> -f <files…>` exactly as the stack was created.
Rationale: self-correcting — works for the resident prod.yml, the source compose, and the images
overlay with zero config, and it removes the `/srv/cap` + wrong-files + missing-`-p` footguns at
once. Alternatives: (B) make `COMPOSE_FILES`/project/services env-configurable — simpler code but
re-introduces per-deploy config that can be misconfigured and keeps a bad default; (C) status quo
literals — broken for the resident stack. We keep B's env knobs only as a FALLBACK when labels are
absent (a non-compose run).

### D2 — Derive the cap services from `ghcr.io/<owner>/cap-*` images, not a fixed list
The services to pull + recreate = the project's services whose image matches the cap GHCR namespace.
On the resident stack that resolves to `api` + `aio-sandbox-image` (and would include `web` only
where it actually runs). This is a TIGHTER, reality-derived bound than the fixed `[api, web,
aio-sandbox-image]` — it can never name a service the deployment doesn't have, and never touches
postgres/loki/grafana. The "cap namespace only" containment is strengthened, not loosened.

### D3 — Persist `CAP_VERSION=<target>` into the working-dir `.env` on upgrade
The resident `.env` pins `CAP_VERSION` (so `/version` reports the exact release). The updater sets
`CAP_VERSION=<target>` in its own container env for the recreate, but unless it ALSO rewrites the
working-dir `.env`, the next manual `docker compose up -d` (reading the old pinned `.env`) would
REVERT the api to the prior version. So the updater SHALL atomically update the `CAP_VERSION` line in
the detected working-dir `.env` as part of the upgrade. (If `.env` has no `CAP_VERSION` line, append
it.) This makes the upgrade durable.

### D4 — Containment unchanged; one-click only
All four gates stay exactly as in `self-update.controller.ts` (operator 401 → admin 403 via
`SELF_UPDATE_ADMINS` → `SELF_UPDATE_ENABLED` 404 → bounded-target 422), the `/update-status`
server-side cross-check stays, pull-then-recreate + detached + survive-api-redeploy stay. Topology
now comes from Docker labels on the api's own container — set at deploy time, never from the request
— so the request still only confirms the already-cross-checked target version. No new client input
surface.

## Risks / Trade-offs

- **[api can't identify its own container]** (`os.hostname()` overridden, or not container-id) →
  the prod.yml api sets no custom `hostname:`, so hostname = container id and `docker inspect`
  resolves it. Mitigation: if inspection finds no compose labels, FALL BACK to the env-knob /
  literal path (D1 fallback) rather than failing.
- **[`config_files` paths outside the working dir]** → bind-mount the working dir AND each config
  file's directory into the updater so `-f <abs path>` resolves; in practice config_files live in
  the working dir.
- **[`.env` writeback races / ownership]** → the updater runs as root over the bind mount; rewrite
  via a temp file + rename (atomic), touching only the `CAP_VERSION` line.
- **[updater image lacks `docker compose`]** → the updater image must include the compose plugin;
  validate/choose an image that does (e.g. a `docker:cli` variant with compose, or install on the
  fly) and keep `SELF_UPDATE_UPDATER_IMAGE` overridable.
- **[no cap-* service found]** (mis-detected project) → refuse the launch rather than recreate
  nothing / everything; surface a clear error.
- **[observability recreated unintentionally]** → scoping `up -d` to the derived cap services
  (api + aio-sandbox-image) means `COMPOSE_PROFILES` in `.env` does NOT cause loki/grafana to be
  recreated; verify the `up -d <services>` form leaves the profiled obs services untouched.

## Migration Plan

1. Ship the updater changes (topology auto-detect + cap-service derivation + `.env` writeback;
   env fallback retained). Inert by default (`SELF_UPDATE_ENABLED` unset).
2. On the resident stack, add to `/etc/dokploy/compose/cloud-agent-platform/resident/.env`:
   `SELF_UPDATE_ENABLED=true` and `SELF_UPDATE_ADMINS=<operator GitHub numeric id>`; recreate the api
   (`docker compose -p cloud-agent-platform up -d api`).
3. Verify end-to-end: cut a `v0.2.1` Release → `/update-status` shows update available → the admin
   clicks Upgrade in the console → the detached updater pulls `cap-*:v0.2.1`, recreates `api` +
   `aio-sandbox-image`, `.env` now pins `v0.2.1`, `/version` reports `v0.2.1`, running tasks survive.
- **Rollback:** unset `SELF_UPDATE_ENABLED` (button gone). The updater never touches non-cap units.

## Open Questions

- **Updater image: RESOLVED.** The official `docker:*-cli` image family bundles the compose v2
  plugin — verified `docker:cli` → v5.1.4 locally AND `docker:27-cli` → `docker compose version` =
  v2.33.0 on the prod host (bwg-jp) itself. The default stays a pinned
  `docker:<ver>-cli`; to be bulletproof regardless of the exact tag, the updater script idempotently
  ENSURES compose first — `docker compose version >/dev/null 2>&1 || apk add --no-cache
  docker-cli-compose` (no-op when already present; installs from alpine repos via the updater's host
  network otherwise). `SELF_UPDATE_UPDATER_IMAGE` remains overridable.
- **Admin gate evolution (forward):** when a user-tiering / role system lands, derive the
  self-update admin gate from the admin role rather than the standalone `SELF_UPDATE_ADMINS` env
  list (the `admin.ts` design already anticipates this). Tracked as a future change, not here.
