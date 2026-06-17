## MODIFIED Requirements

### Requirement: The upgrade target is bounded — validated version, cap namespace, cap services only
When enabled, the upgrade SHALL be BOUNDED and SHALL NOT accept an arbitrary image, tag, or command. The target SHALL be a validated semver tag that MUST match the latest version reported by the cached `/update-status` (a server-side cross-check), the pulled images SHALL be ONLY the cap GHCR namespace set (`ghcr.io/<owner>/cap-*:<target>`), and the recreated units SHALL be ONLY the cap compose services. The compose TOPOLOGY the updater acts on — the project name, the compose `-f` file(s), the working directory, and the set of cap services — SHALL be DERIVED from the RUNNING deployment rather than fixed source-overlay literals: read from the api's own container `com.docker.compose.*` labels (`project`, `project.config_files`, `project.working_dir`), with the cap services resolved as the project's services whose image is in the `ghcr.io/<owner>/cap-*` namespace. This keys the upgrade to whatever stack is actually running (the source compose, the images overlay, or the resident `docker-compose.prod.yml`) while keeping it strictly cap-scoped — it can never name a service the deployment does not have and never touches postgres / loki / grafana / a reverse proxy. The topology comes from Docker labels set at deploy time, NEVER from the request (the request only confirms the cross-checked target). When the api's container exposes no compose labels (a non-compose run), the updater MAY fall back to operator-set env overrides. A target that is invalid or does not match `/update-status`'s latest SHALL be rejected.

#### Scenario: Target must match the reported latest
- **WHEN** a self-update is requested with a target that does not match the latest version from `/update-status`
- **THEN** it is rejected (no arbitrary version can be forced)

#### Scenario: Only the cap namespace + services are touched
- **WHEN** an enabled, admin-confirmed self-update runs for a valid target
- **THEN** it pulls only `ghcr.io/<owner>/cap-*` images at that single target version and recreates only the cap compose services — never an arbitrary image, tag, or command

#### Scenario: Topology is derived from the running deployment, not fixed literals
- **WHEN** an enabled self-update runs on a deployment whose api container reports compose labels (e.g. the resident `docker-compose.prod.yml` stack: project `cloud-agent-platform`, config file the resident prod.yml, cap services `api` + `aio-sandbox-image`)
- **THEN** the updater uses that project / `-f` file(s) / working dir and recreates exactly the project's `ghcr.io/<owner>/cap-*` services — not the source-overlay literals — so it updates the stack that is actually running

#### Scenario: A deployment without compose labels falls back to operator env
- **WHEN** the api's container exposes no `com.docker.compose.*` labels (not run via compose)
- **THEN** the updater falls back to operator-set env overrides rather than guessing, and refuses if it cannot resolve a cap service to act on

### Requirement: Self-recreate uses a detached updater and preserves running tasks
Because the api cannot cleanly recreate its own container while running, an enabled self-update SHALL launch a DETACHED updater that runs the compose pull-then-recreate (`docker compose -p <project> -f <config files…>` for the derived cap services, pinned to the target version) and OUTLIVES the api's own restart. The endpoint SHALL acknowledge "update started" before the api goes down. The updater SHALL pull the new images BEFORE recreating, so a failed pull leaves the prior version running. The updater SHALL PERSIST the new version into the deployment's working-dir `.env` (`CAP_VERSION=<target>`, atomically; appended if absent) so the upgrade is durable — a subsequent manual `docker compose up -d` does NOT revert to the previously-pinned version. In-flight sandbox tasks SHALL be preserved across the api recreate (via `survive-api-redeploy`'s re-adoption), and the operator console SHALL reconnect via the existing WebSocket auto-reconnect.

#### Scenario: The api recreates itself via a detached updater
- **WHEN** an enabled, admin-confirmed, valid self-update is invoked
- **THEN** the api launches a detached updater that pulls the target image set and recreates the cap services, the request is acknowledged before the api restarts, and the updater survives the api going down

#### Scenario: Running tasks survive the upgrade
- **WHEN** a self-update recreates the api while a sandbox task is running
- **THEN** the running task is preserved (re-adopted by the new api per survive-api-redeploy) and the operator terminal reconnects, rather than the task being killed

#### Scenario: A failed pull does not break the running version
- **WHEN** the updater's image pull fails
- **THEN** the prior version keeps running (pull-then-recreate ordering; no destructive teardown before the new images are present)

#### Scenario: The upgraded version persists across a later manual up
- **WHEN** a self-update upgrades the stack to `<target>` and later someone runs `docker compose up -d` by hand
- **THEN** the stack stays on `<target>` because the updater rewrote `CAP_VERSION=<target>` in the working-dir `.env`, rather than reverting to the previously-pinned version
