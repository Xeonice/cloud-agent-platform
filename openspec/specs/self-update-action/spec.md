# self-update-action Specification

## Purpose
A hard-gated (SELF_UPDATE_ENABLED, default off), operator-admin-only, bounded one-click upgrade: POST /self-update validates the target against /update-status's latest, then launches a detached updater that pulls the pinned cap GHCR image set and recreates the cap services (running tasks preserved by survive-api-redeploy); the console surfaces a confirm-gated Upgrade action only when enabled + admin. Ships inert; host-root-equivalent, so activated deliberately. (created by archiving change self-update-action)
## Requirements
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

When enabled, the upgrade SHALL be BOUNDED and SHALL NOT accept an arbitrary image, tag, or command. The target SHALL be a validated semver tag that MUST match the latest version reported by the cached `/update-status` (a server-side cross-check), and every image the upgrade pulls SHALL be ONLY in the cap GHCR namespace (`ghcr.io/<owner>/cap-*:<target>`). The compose TOPOLOGY the updater acts on — the project name, the compose `-f` file(s), the working directory, and the cap service sets — SHALL be DERIVED from the RUNNING deployment rather than fixed source-overlay literals: read from the api's own container `com.docker.compose.*` labels (`project`, `project.config_files`, `project.working_dir`). The topology comes from Docker labels set at deploy time, NEVER from the request (the request only confirms the cross-checked target).

The upgrader SHALL distinguish two strictly cap-scoped service sets:

- The **recreate set** (used for `up -d`) SHALL be the project's RUNNING services whose image is in the `ghcr.io/<owner>/cap-*` namespace — so only cap units that actually run are recreated.
- The **pull set** (used for `compose pull`) SHALL cover EVERY cap service the project declares, INCLUDING never-starts, pull-only cap services that have no running container — in particular the per-task sandbox-image stager (`aio-sandbox-image`), whose only purpose is to stage `cap-aio-sandbox:<target>` onto the host for the DooD sandbox provider. Because a never-starts service has no container instance and therefore cannot be derived from running state, the pull set SHALL include such pull-only cap services from an explicit, cap-scoped, operator-overridable declaration (so the host always stages the sandbox image matching the upgraded `CAP_VERSION`).

Both sets SHALL remain strictly within the cap namespace — neither may ever name postgres / loki / grafana / a reverse proxy, and the pull set SHALL NOT broaden to an unscoped `compose pull` that would fetch non-cap images. `pull` SHALL precede `up -d` so a failed pull leaves the prior version running. When the api's container exposes no compose labels (a non-compose run), the updater MAY fall back to operator-set env overrides. A target that is invalid or does not match `/update-status`'s latest SHALL be rejected.

#### Scenario: Target must match the reported latest

- **WHEN** a self-update is requested with a target that does not match the latest version from `/update-status`
- **THEN** it is rejected (no arbitrary version can be forced)

#### Scenario: Pull covers every declared cap image; recreate covers only running cap services

- **WHEN** an enabled, admin-confirmed self-update runs for a valid target
- **THEN** it pulls, at that single target version, the cap-namespace image of every cap service the project declares — including the never-starts pull-only `aio-sandbox-image` — and recreates only the RUNNING cap services, never an arbitrary image, tag, or command and never a non-cap image

#### Scenario: A never-starts pull-only cap service is pulled but not recreated

- **WHEN** the topology includes a pull-only cap service that has no running container (e.g. `aio-sandbox-image`, defined `entrypoint: ["true"]`, never `up`'d)
- **THEN** that service IS in the `compose pull` set (its `cap-aio-sandbox:<target>` image is staged onto the host) and is NOT in the `up -d` recreate set (a service marked never-starts is not recreated)

#### Scenario: The sandbox image is staged so post-upgrade task provisioning succeeds

- **WHEN** an upgrade advances `CAP_VERSION` to a new target and then a task is provisioned afterward
- **THEN** the host has the `cap-aio-sandbox:<target>` image present (because the pull set staged it), so the sandbox provisions instead of failing with `No such image`

#### Scenario: Topology is derived from the running deployment, not fixed literals

- **WHEN** an enabled self-update runs on a deployment whose api container reports compose labels (e.g. the resident `docker-compose.prod.yml` stack: project `cloud-agent-platform`, config file the resident prod.yml, running cap service `api`, declared pull-only cap service `aio-sandbox-image`)
- **THEN** the updater uses that project / `-f` file(s) / working dir, pulls the cap images for `api` + `aio-sandbox-image`, and recreates `api` — not the source-overlay literals — so it updates the stack that is actually running

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

### Requirement: The updater image is ensured present before the updater container is created
The detached updater container is created from a fixed, server-side updater image (default `docker:27-cli`, overridable via `SELF_UPDATE_UPDATER_IMAGE`). Because container creation does NOT pull a missing image, an enabled self-update SHALL ensure that updater image is present locally BEFORE creating the updater container: it SHALL inspect the image first and pull it ONLY when absent. A host that has never staged the updater image (e.g. a fresh deploy whose image cache is empty) SHALL self-heal by pulling it, rather than failing the whole request with the Docker daemon's "no such image" error. A host that already has the image staged SHALL NOT incur a pull (the steady-state path stays offline-friendly).

This applies only to the updater helper image; the cap GHCR target images remain pulled by the updater's own pull-then-recreate step and are unaffected.

#### Scenario: A fresh host with no updater image self-heals
- **WHEN** an enabled, admin-confirmed, valid self-update is invoked on a host whose updater image is not present locally
- **THEN** the launcher pulls the updater image first and then creates the updater container, rather than the request failing with a `no such image` 404

#### Scenario: A host that already staged the updater image does not re-pull
- **WHEN** an enabled self-update is invoked on a host whose updater image is already present locally
- **THEN** the launcher creates the updater container directly without pulling the updater image again

### Requirement: Self-update stages sandbox runtimes by delivery mode

When self-update is enabled, the updater SHALL preserve the selected sandbox
runtime delivery mode for the target version before it recreates CAP services.
Registry-backed deployments SHALL keep the existing pull-before-recreate
behavior. Release-asset-backed deployments SHALL download, verify, and stage the
target version's sandbox runtime asset before the API is recreated or the
deployment is reported upgraded. A target manifest MAY represent a logical asset
as ordered parts; the updater SHALL verify each part and the combined logical
checksum, then stream the ordered content into the same load/extract path without
requiring a second assembled copy on disk.

#### Scenario: Asset-backed AIO upgrade loads the target archive before recreate

- **WHEN** an enabled self-update targets `vX.Y.Z` on an AIO deployment using
  Release-asset sandbox image delivery
- **THEN** the updater downloads and verifies the matching AIO sandbox asset
- **AND** it loads the Docker archive so `cap-aio-sandbox:vX.Y.Z` is inspectable
  locally before recreating the API

#### Scenario: Asset-backed BoxLite upgrade stages the target rootfs before recreate

- **WHEN** an enabled self-update targets `vX.Y.Z` on a BoxLite deployment using
  Release-asset sandbox image delivery
- **THEN** the updater downloads and verifies the matching BoxLite sandbox asset
- **AND** it extracts or activates the target rootfs path and persists the
  corresponding `BOXLITE_ROOTFS_PATH` or `BOXLITE_ROOTFS_PATH_MAP` value before
  recreating the API

#### Scenario: Failed asset staging leaves the prior version running

- **WHEN** self-update cannot download, verify, load, or extract the target
  sandbox runtime asset
- **THEN** the updater fails before recreating CAP services
- **AND** the prior version remains running

#### Scenario: Post-upgrade tasks use the staged sandbox runtime

- **WHEN** a self-update completes on an asset-backed deployment and a new task
  is created afterward
- **THEN** the selected provider uses the target version's locally staged sandbox
  runtime
- **AND** task provisioning does not fail because the target sandbox image or
  rootfs is missing

### Requirement: Self-update preserves custom sandbox environments

Self-update SHALL preserve managed custom sandbox environment records and SHALL
NOT overwrite them with the release default sandbox image/rootfs. When the target
CAP version changes the sandbox contract or required runtime tooling, self-update
SHALL either revalidate custom environments or mark them stale before future task
creation can use them.

#### Scenario: Custom environments survive upgrade

- **WHEN** an enabled self-update upgrades CAP to a new version
- **THEN** managed custom sandbox environments remain in the registry
- **AND** their source descriptors are not replaced by the release default image
  or rootfs

#### Scenario: Contract change marks custom environments stale

- **WHEN** the target CAP version requires a newer sandbox contract than a custom
  environment last validated against
- **THEN** that environment is marked stale or scheduled for revalidation
- **AND** new task creation cannot select it until it becomes ready again

#### Scenario: Release default staging remains available

- **WHEN** self-update stages the target release's default sandbox runtime asset
- **THEN** the staged release default remains available as the deployment fallback
- **AND** custom environments are preserved as separate managed choices

### Requirement: Sandbox asset extraction is portable across shared-mount hosts

The updater's BoxLite rootfs extraction SHALL NOT attempt to restore archive-recorded file ownership, so staging succeeds on hosts whose Docker bind mounts forbid `chown` (macOS/colima and equivalent VM file-sharing stacks) as well as on plain Linux hosts. Before extracting, staging SHALL remove stale temporary extraction directories left at the target rootfs path by previously failed attempts. Extraction failures SHALL continue to abort staging before any CAP service is recreated.

#### Scenario: Extraction succeeds on a chown-restricted shared mount

- **WHEN** the updater stages a BoxLite rootfs asset onto a bind mount that rejects `chown` operations
- **THEN** the archive extracts without attempting ownership restore
- **AND** the staged rootfs is moved into place and `BOXLITE_ROOTFS_PATH` is persisted as on any other host

#### Scenario: Stale temp directories from failed attempts are swept

- **WHEN** a prior staging attempt aborted and left a temporary extraction directory beside the target rootfs path
- **THEN** the next staging run removes such stale temporary directories before creating its own
- **AND** the live rootfs directories of other versions are untouched

#### Scenario: The generated staging script pins both properties

- **WHEN** the self-update unit suite inspects the generated BoxLite staging script
- **THEN** it asserts the extraction pipeline disables ownership restore with a flag accepted by both busybox tar and GNU tar
- **AND** it asserts the stale-temp sweep precedes the creation of the new temporary extraction directory

### Requirement: Self-update stages the attestation asset and persists the gate env keys with the version pin

When an enabled self-update targets a version, the updater SHALL fetch the target's `cap-task-model-attestation-<version>.json` asset and its `.sha256` companion through the existing release-asset staging conventions (`releases/download/<target>/<asset>` with the `CAP_RELEASE_ASSET_BASE` override honored) and SHALL verify the checksum before use. Before persisting any gate env key, the updater SHALL evaluate the same local single-instance preconditions as the manual path, using its existing cap-container enumeration:

1. exactly one running cap api container in the derived topology;
2. no cap-namespace container at a version other than the target;
3. `CAP_INSTANCE_ID` unset or exactly `cap-api-1`.

When the asset is verified and the preconditions pass, the updater SHALL persist `CAP_TASK_MODEL_SELECTION_ENABLED=true` and `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON=<verified asset content>` into the deployment's working-dir `.env` using the SAME atomic KEY=VALUE persist seam as the `CAP_VERSION` pin, in the same update run, so the gate configuration and the version pin land together and survive a later manual `docker compose up -d`.

#### Scenario: A successful self-update persists gate env keys alongside CAP_VERSION

- **WHEN** an enabled, admin-confirmed self-update to `vX.Y.Z` runs on a deployment satisfying the local preconditions and the attestation asset checksum-verifies
- **THEN** the deployment `.env` afterwards contains `CAP_VERSION=vX.Y.Z`, `CAP_TASK_MODEL_SELECTION_ENABLED=true`, and `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` equal to the verified asset content, each written via the atomic persist seam

#### Scenario: The recreated api opens the gate from the persisted attestation

- **WHEN** the self-update completes its recreate after persisting the gate env keys for `vX.Y.Z`
- **THEN** the recreated api evaluates the persisted attestation against its own baked `GIT_SHA` and reports the `task-model-selection-v1` gate open, so a subsequent task-model catalog query does not return 503

### Requirement: Attestation writeback failures degrade the update, not fail it

When a local precondition fails, the attestation asset is missing for the target, or its checksum does not verify, the self-update SHALL skip the attestation writeback — leaving any existing gate env keys unmodified and never persisting unverified attestation content — and SHALL surface the skip reason in the update's observable outcome (updater log/status), while the rest of the update (image pull, sandbox staging, recreate, `CAP_VERSION` persist) proceeds and completes. A skipped attestation writeback SHALL NOT mark the whole self-update as failed.

#### Scenario: Precondition failure skips writeback with a surfaced reason

- **WHEN** an enabled self-update runs and the cap-container enumeration finds a second cap api container, an N-1 cap container, or a `CAP_INSTANCE_ID` other than `cap-api-1`
- **THEN** the update still pulls, stages, recreates, and persists `CAP_VERSION`, the gate env keys are not written or modified, and the update outcome records the named precondition as the skip reason

#### Scenario: Unverifiable asset is never persisted

- **WHEN** the target version's attestation asset is absent or fails its `.sha256` verification
- **THEN** no attestation content is persisted into `.env`, the skip reason identifies the asset defect, and the update otherwise completes

### Requirement: Pinned updater script assertions cover attestation staging in lockstep

The self-update unit suite's pinned script assertions (`self-update.spec.ts`) SHALL be extended in lockstep so the generated updater script provably contains the attestation behavior: the checksum verification preceding any persist, the precondition gating, and the atomic gate-env persist using the same seam as the `CAP_VERSION` pin.

#### Scenario: Unit suite pins the attestation staging and persist behavior

- **WHEN** the self-update unit suite inspects the generated updater script for a target with attestation staging enabled
- **THEN** it asserts that checksum verification precedes the gate-env persist, that the persist is conditional on the precondition checks, and that the gate env keys are written through the same atomic KEY=VALUE persist mechanism as `CAP_VERSION`
