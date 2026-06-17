<!-- Track-annotated tasks. Numbered groups are parallel Tracks; tasks within a track run serially. -->

## 1. Track: updater-topology (depends: none)

- [x] 1.1 In `self-update.service.ts`, add a self-container compose-label reader (`DockerTopologyResolver`): resolve the api's own container (`os.hostname()` → `docker.getContainer(...).inspect()`) and read `com.docker.compose.project` / `.project.config_files` / `.project.working_dir`; return a structured `UpdateTopology`, or `null` when the labels are absent (non-compose run). Injected behind a `TOPOLOGY_RESOLVER` port so tests supply a fake without docker.
- [x] 1.2 Derive the cap services as the project's services whose image matches `ghcr.io/<owner>/cap-*` (enumerate containers by `com.docker.compose.project=<project>` label → service→image). `planUpdate` refuses with `no-cap-service` if the resolved topology has zero cap services.
- [x] 1.3 Replace the fixed `COMPOSE_FILES`/`CAP_SERVICES`/no-`-p` literals in `buildPlan` + `DockerUpdaterLauncher` with the DERIVED topology: `docker compose -p <project> -f <config_files…> pull <cap-svcs>` then `up -d <cap-svcs>`, run in the detected working dir (bind-mounted + each compose-file dir). Kept the literals/`SELF_UPDATE_COMPOSE_DIR` (+ new `SELF_UPDATE_COMPOSE_FILES`/`_PROJECT`/`_SERVICES`) as the labels-absent FALLBACK. Prepended a compose-ensure guard (`docker compose version || apk add --no-cache docker-cli-compose`; left-assoc with the `&&` chain so a failed install aborts before pull). Preserved pull-then-up, detached launch, container-env version pin.
- [x] 1.4 In the updater script, PERSIST `CAP_VERSION=<target>` into the detected working-dir `.env` (atomic: `( grep -v ^CAP_VERSION= .env; echo CAP_VERSION=<target> ) > .env.captmp && mv .env.captmp .env`) so the upgrade is durable across a later manual `up`.

## 2. Track: tests (depends: updater-topology)

- [x] 2.1 Rewrote `self-update.spec.ts`: inject a fake `TopologyResolver`; assert the plan's project / `-f` files / working dir / cap-* services are DERIVED from it (`api` + `aio-sandbox-image`, no `web`); assert the `.env` `CAP_VERSION` writeback + the compose-ensure guard; assert the labels-absent FALLBACK (literals, no `-p`); assert the `no-cap-service` refusal; re-assert the unchanged bounds (disabled/invalid/mismatch refusals, `/update-status` cross-check, pull-then-up, never postgres/loki/grafana/ghcr.io/`\brm\b`, admin/env HTTP gates). 31/31 pass. (Fixed a naive `'rm '` substring check that false-positived on "platfoRM -f" → word-boundary `\brm\b` — a test fix, not a service workaround.)

## 3. Track: docs (depends: updater-topology)

- [x] 3.1 `deploy/DEPLOY.md` §12: updated §12.2 (topology auto-detected from compose labels; cap services = ghcr cap-* images; persists `.env` pin) and §12.5 (enable on the RESIDENT stack via its `.env`: `SELF_UPDATE_ENABLED=true` + `SELF_UPDATE_ADMINS=<ids>`, recreate the api; verify e2e). Added the forward note: when a user-tiering/role system lands, the admin gate should derive from the admin role rather than `SELF_UPDATE_ADMINS`.

## 4. Track: rollout-verify (depends: tests, docs) — USER-GATED

- [ ] 4.1 (User-provisioned) Set `SELF_UPDATE_ENABLED=true` + `SELF_UPDATE_ADMINS=<your GitHub numeric id>` in `/etc/dokploy/compose/cloud-agent-platform/resident/.env`; recreate the api so the gate + admin set take effect.
- [ ] 4.2 (Maintainer-run) End-to-end: cut a `v0.2.1` Release → `/update-status` shows update available + the console banner → an admin clicks Upgrade → verify the detached updater pulls `cap-*:v0.2.1`, recreates `api` + `aio-sandbox-image` (NOT loki/grafana/postgres), the resident `.env` now pins `CAP_VERSION=v0.2.1`, `/version` reports `v0.2.1`, and an in-flight task survives the recreate.
