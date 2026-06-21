## Why

The self-update upgrader derives the cap services to upgrade from the project's **running container instances** (`DockerTopologyResolver.resolve()` calls `docker.listContainers({all:true})` and keeps the services whose containers carry a `ghcr.io/<owner>/cap-*` image). But `aio-sandbox-image` is a deliberately **never-starts, pull-only** compose service — it exists only so `docker compose pull` stages the `cap-aio-sandbox:<version>` image onto the host for the DooD sandbox provider; it has no container instance. So `listContainers` never sees it, and every self-update upgrades only `api` (+ `web`), **never pulling the new `cap-aio-sandbox` image**. When `CAP_VERSION` is then bumped to a tag the host has not staged, the api tries to provision a sandbox from `ghcr.io/<owner>/cap-aio-sandbox:<that tag>`, gets `No such image`, and **every task fails at provisioning**. This is exactly what happened on the 2026-06-21 v0.14.0 upgrade (verified live: all tasks `provision_failed` with `No such image: ghcr.io/xeonice/cap-aio-sandbox:v0.14.0`, fixed only by a manual `docker pull` on the host).

## What Changes

- Fix the self-update image-pull scope so it covers **every cap service the compose project declares — including never-starts, pull-only services like `aio-sandbox-image`** — not only the cap services that currently have a running container.
- Separate the two sets the updater acts on (currently conflated into one `services` list):
  - the **pull set** = all cap (`ghcr.io/<owner>/cap-*`) services *declared* by the running project's compose, so the new images (api, web, **and the sandbox image**) are all staged onto the host; and
  - the **recreate (`up -d`) set** = the cap services that are actually running, so a pull-only service that never starts is staged but not (futilely) recreated.
- Keep the upgrade strictly **cap-namespace-scoped** (it must NOT broaden to a full `docker compose pull` that would also pull non-cap images like postgres / loki / grafana) and keep every existing guard intact: validated-semver target, `/update-status` cross-check, detached updater, pull-before-up, admin gate, label-derived topology.
- Update the `self-update-action` spec's "bounded" requirement to make the pull-set-vs-recreate-set distinction explicit and to require that a declared-but-never-running pull-only cap service still gets its image pulled at the target version.

Non-goals: no change to the release pipeline (release.yml already builds all three images correctly); no change to how the target is validated / cross-checked; no broadening beyond the cap namespace; not touching the `web`-on-Vercel reality (web is still a declared cap service for hosts that run it). A separate, smaller doc/skill note ("after an upgrade, confirm the host has all three cap image tags") is out of scope here.

## Capabilities

### Modified Capabilities

- `self-update-action`: the "upgrade target is bounded — validated version, cap namespace, cap services only" requirement is revised so the cap-scoped image **pull set** is derived to include every cap service the compose project *declares* (so never-starts pull-only services such as `aio-sandbox-image` are pulled at the target version), while the **recreate set** stays the running cap services — closing the gap where a pull-only sandbox image was never upgraded and later broke task provisioning.

## Impact

- `apps/api/src/self-update/self-update.service.ts`: `DockerTopologyResolver.resolve()` (derive the declared cap services, not only running ones) and `buildPlan()` (scope `pull` to the pull set and `up -d` to the recreate set, instead of one shared `services` list); the `UpdateTopology` / `UpdatePlan` shapes gain a pull-vs-recreate distinction.
- `apps/api/src/self-update/self-update.spec.ts`: cover that a declared pull-only cap service is in the pull set (and not in the up set), and that the plan stays cap-scoped.
- No DB / HTTP / sandbox-runtime changes; no breaking change. The live host has already been hot-fixed (`docker pull cap-aio-sandbox:v0.14.0`); this change prevents the recurrence on every future upgrade.
