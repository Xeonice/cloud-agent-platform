## ADDED Requirements

### Requirement: Self-update is hard-disabled by default and refuses unless explicitly enabled
The `POST /self-update` endpoint SHALL be REFUSED (an error status, e.g. 403/404) unless `SELF_UPDATE_ENABLED=true` is set, which SHALL default to OFF. Merely shipping/deploying the change SHALL therefore be INERT — no live upgrade capability exists until an operator deliberately enables it. The console upgrade action SHALL likewise be ABSENT unless self-update is enabled (gated by a `selfUpdate` capability flag, default `false`).

#### Scenario: Disabled by default refuses the endpoint
- **WHEN** `POST /self-update` is requested and `SELF_UPDATE_ENABLED` is not `true`
- **THEN** it is refused (no upgrade is performed), and shipping the change has added no live upgrade capability

#### Scenario: Console action absent when disabled
- **WHEN** the console renders and self-update is not enabled (the `selfUpdate` flag is false)
- **THEN** no "Upgrade" action is shown — the update banner is notify-only (Phase 2 behavior)

### Requirement: Self-update is operator-admin-only and confirmed
When enabled, `POST /self-update` SHALL require the operator-auth guard AND an admin principal (the narrowest available admin gate), and the console SHALL require an explicit confirmation (with a host-root warning) before invoking it. A non-admin operator SHALL NOT be able to trigger an upgrade.

#### Scenario: Non-admin cannot trigger an upgrade
- **WHEN** an authenticated but non-admin operator calls `POST /self-update` (even when enabled)
- **THEN** it is rejected and no upgrade is performed

#### Scenario: Console confirms before upgrading
- **WHEN** an admin operator clicks "Upgrade"
- **THEN** a confirmation dialog with an explicit host-root warning is shown, and the upgrade is only invoked after explicit confirmation

### Requirement: The upgrade target is bounded — validated version, cap namespace, cap services only
When enabled, the upgrade SHALL be BOUNDED and SHALL NOT accept an arbitrary image, tag, or command. The target SHALL be a validated semver tag that MUST match the latest version reported by the cached `/update-status` (a server-side cross-check), the pulled images SHALL be ONLY the cap GHCR namespace set (`ghcr.io/<owner>/cap-*:<target>`), and the recreated units SHALL be ONLY the cap compose services. A target that is invalid or does not match `/update-status`'s latest SHALL be rejected.

#### Scenario: Target must match the reported latest
- **WHEN** a self-update is requested with a target that does not match the latest version from `/update-status`
- **THEN** it is rejected (no arbitrary version can be forced)

#### Scenario: Only the cap namespace + services are touched
- **WHEN** an enabled, admin-confirmed self-update runs for a valid target
- **THEN** it pulls only `ghcr.io/<owner>/cap-*` images at that single target version and recreates only the cap compose services — never an arbitrary image, tag, or command

### Requirement: Self-recreate uses a detached updater and preserves running tasks
Because the api cannot cleanly recreate its own container while running, an enabled self-update SHALL launch a DETACHED updater that runs the compose pull-then-recreate (`docker compose` with the image override, pinned to the target version) and OUTLIVES the api's own restart. The endpoint SHALL acknowledge "update started" before the api goes down. In-flight sandbox tasks SHALL be preserved across the api recreate (via `survive-api-redeploy`'s re-adoption), and the operator console SHALL reconnect via the existing WebSocket auto-reconnect. The updater SHALL pull the new images BEFORE recreating, so a failed pull leaves the prior version running.

#### Scenario: The api recreates itself via a detached updater
- **WHEN** an enabled, admin-confirmed, valid self-update is invoked
- **THEN** the api launches a detached updater that pulls the target image set and recreates the cap services, the request is acknowledged before the api restarts, and the updater survives the api going down

#### Scenario: Running tasks survive the upgrade
- **WHEN** a self-update recreates the api while a sandbox task is running
- **THEN** the running task is preserved (re-adopted by the new api per survive-api-redeploy) and the operator terminal reconnects, rather than the task being killed

#### Scenario: A failed pull does not break the running version
- **WHEN** the updater's image pull fails
- **THEN** the prior version keeps running (pull-then-recreate ordering; no destructive teardown before the new images are present)
