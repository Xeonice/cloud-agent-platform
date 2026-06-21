## MODIFIED Requirements

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
