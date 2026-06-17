## Why

The one-click self-update (`self-update-action`) is hard-wired to the SOURCE-overlay compose
topology — `COMPOSE_FILES = [docker-compose.yml, docker-compose.images.yml]`, working dir
`/srv/cap`, no `-p`, services `[api, web, aio-sandbox-image]`. After the resident-compose cutover,
production no longer runs that: it is `docker-compose.prod.yml` at
`/etc/dokploy/compose/cloud-agent-platform/resident/`, project `cloud-agent-platform`, and it does
NOT run `web` (the console is on Vercel). Verified live: the api's own container carries
`com.docker.compose.project.config_files = .../resident/docker-compose.prod.yml`, `/srv/cap` does
not exist, and the cap-image services are exactly `api` + `aio-sandbox-image`. So even with the
feature enabled, the updater would `docker compose` the wrong files / dir / project and **fail to
update the running stack**. The notification half (`/update-status` banner) already works; this
closes the self-execute half so the in-app upgrade actually upgrades THIS deployment.

## What Changes

- The detached updater SHALL DERIVE its compose topology from the api's OWN container's
  `com.docker.compose.*` labels — `project`, `project.config_files`, `project.working_dir` — and
  reconstruct the exact `docker compose -p <project> -f <config_files…>` invocation that created the
  running stack, instead of the fixed source-overlay literals. This auto-adapts to whatever stack
  is running (source compose, the images overlay, or the resident `docker-compose.prod.yml`) with
  no per-deploy configuration.
- The cap services to pull + recreate SHALL be DERIVED as the project's services whose image is
  `ghcr.io/<owner>/cap-*` (so it targets `api` + `aio-sandbox-image` on the resident stack, includes
  `web` only where present, and NEVER touches postgres/loki/grafana). This is a tighter, reality-
  derived bound than the previous fixed list.
- On a successful upgrade the updater SHALL PERSIST `CAP_VERSION=<target>` into the detected working
  dir's `.env`, so the new version sticks — a later manual `docker compose up -d` will not revert to
  the previously-pinned version.
- Env overrides remain as an escape hatch / fallback (e.g. `SELF_UPDATE_COMPOSE_DIR`) for a
  deployment whose api container lacks compose labels (non-compose run); when labels are present
  they are authoritative.
- Containment is UNCHANGED: one-click only (no autonomous updates), the four layered gates stay
  (operator 401 → admin 403 via `SELF_UPDATE_ADMINS` → `SELF_UPDATE_ENABLED` 404 → bounded-target
  422), version still cross-checked against `/update-status`, pull-then-recreate, detached, cap-only.

## Capabilities

### New Capabilities
<!-- none — modifies the existing self-update-action capability -->

### Modified Capabilities
- `self-update-action`: the bounded-updater requirement changes WHERE the compose topology comes
  from — derived from the running deployment's compose labels (cap services = `ghcr` cap-* images),
  rather than fixed source-overlay literals — so the one-click upgrade correctly targets the
  resident `docker-compose.prod.yml` stack (and any other compose topology), and persists the new
  `CAP_VERSION` pin. All existing containment bounds are preserved.

## Impact

- **Files:** `apps/api/src/self-update/self-update.service.ts` (derive topology from own-container
  labels; derive cap services from cap-* images; `.env` `CAP_VERSION` writeback; keep env-override
  fallback), its `self-update.spec.ts`; `openspec/specs/self-update-action/spec.md` (delta);
  `deploy/DEPLOY.md` §12 (enable on the resident stack: `SELF_UPDATE_ENABLED=true` +
  `SELF_UPDATE_ADMINS=<id>` in the resident `.env`; note the topology is now auto-detected).
- **Behavior:** no change while `SELF_UPDATE_ENABLED` is unset (still inert/404). Once enabled +
  admin + a real newer Release, the button launches a detached updater that pulls + recreates the
  cap services of the ACTUAL running stack and pins the new version. `survive-api-redeploy` keeps
  in-flight tasks alive across the recreate.
- **Security:** topology is read from Docker labels on the api's own container (set at deploy, not
  from the request) — the request still only confirms the cross-checked target version; the bound is
  preserved (and the service set is now reality-derived to cap-* images only).
- **OUT OF SCOPE (forward-looking):** (1) fully-automatic "detect new version → auto-upgrade" with
  no human click — explicitly NOT done; one-click stays. (2) The admin gate stays the standalone
  `SELF_UPDATE_ADMINS` env allowlist; when a user-tiering / role system (building on
  `multi-user-oauth`) lands, the admin gate SHOULD derive from the admin role instead of the
  standalone env list (the `admin.ts` design already anticipates this) — a separate future change.
