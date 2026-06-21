## Context

`self-update-action` derives the cap services to upgrade from the running deployment (so it adapts to the resident `docker-compose.prod.yml` stack instead of fixed source-overlay literals). `DockerTopologyResolver.resolve()` reads the api container's `com.docker.compose.*` labels for the project / compose files / working dir, then resolves the cap services by listing the project's **containers** and keeping those on a `ghcr.io/<owner>/cap-*` image:

```js
const containers = await docker.listContainers({ all: true, filters: { label: [`project=${project}`] }});
const services = [...new Set(containers.filter(c => CAP_IMAGE_RE.test(c.Image)).map(c => c.Labels['…service']))];
```

`buildPlan()` then uses that single `services` list for BOTH `docker compose pull <services>` and `docker compose up -d <services>`.

The bug: `aio-sandbox-image` is a **never-starts, pull-only** compose service — its whole purpose is to make `docker compose pull` stage `cap-aio-sandbox:${CAP_VERSION}` onto the host so the DooD sandbox provider finds it. Its definition is `entrypoint: ["true"]`, `restart: "no"`, `network_mode: none`, and it is never `up`'d — so it has **no container instance**, `listContainers` never returns it, and it is silently absent from the derived `services`. Every upgrade therefore pulls only `api` (+ `web`) and **never pulls the new sandbox image**. When `CAP_VERSION` advances to a tag the host has not staged, the api provisions a sandbox from `cap-aio-sandbox:<tag>`, gets `No such image`, and all tasks fail at provisioning (observed live on v0.14.0; the existing `CAP_SERVICES` fallback list already contains `aio-sandbox-image`, but the fallback only runs when compose labels are absent — the primary label-derived path is what ships in production).

See `proposal.md` for the failure and scope; this document picks the fix.

## Goals / Non-Goals

**Goals**
- Pull the image for EVERY cap service the compose project declares — including never-starts, pull-only ones — at the target version, so the host always has the sandbox image matching `CAP_VERSION`.
- Keep recreation (`up -d`) limited to the cap services that actually run, so a pull-only service is staged but not pointlessly recreated.
- Stay strictly cap-namespace-scoped (never pull/recreate postgres / loki / grafana / a proxy) and keep every existing guard (validated target, `/update-status` cross-check, detached updater, pull-before-up, admin gate, label-derived topology).

**Non-Goals**
- No broadening to a bare `docker compose pull` (that would pull non-cap images, violating the cap-namespace bound).
- No change to target validation / cross-check / detached-updater mechanics / the release pipeline.
- No attempt to auto-discover pull-only services by parsing compose YAML inside the api container (it has the docker socket but not a compose CLI nor a mount of the host working dir).

## Decisions

### 1. Split the single `services` list into a PULL set and a RECREATE set
`UpdateTopology` / `UpdatePlan` carry two service lists instead of one:
- **recreateServices** = the running cap services (the current `listContainers` derivation, unchanged) — used for `docker compose up -d <recreateServices>`.
- **pullServices** = `recreateServices ∪ pullOnlyCapServices` (deduped) — used for `docker compose pull <pullServices>`.

`buildPlan()` emits `pull <pullServices>` then `up -d <recreateServices>`. Pull-before-up is preserved (a failed pull leaves the prior version running). This is the minimal change that fixes the gap while keeping recreation honest.

### 2. Pull-only cap services come from an explicit list, because they are unobservable from running state
A never-starts service has no container, so it CANNOT be derived from `listContainers` — by definition. It must be named explicitly. Introduce `PULL_ONLY_CAP_SERVICES = ['aio-sandbox-image']` (overridable via a `SELF_UPDATE_PULL_ONLY_SERVICES` env, same pattern as the existing `SELF_UPDATE_*` overrides). `aio-sandbox-image` is the architecture's fixed sandbox-image stager; any deployment that runs tasks has it. The pull set stays cap-scoped because every entry is a cap service. (The existing `CAP_SERVICES` fallback already lists it; this lifts that knowledge into the PRIMARY label-derived path where it was missing.)

### 3. Pull-only, NOT recreate — even though `up`'ing it would be harmless here
`aio-sandbox-image`'s `entrypoint: ["true"]` + `restart: "no"` means `up -d`'ing it would just create a container that exits 0 and stays exited — harmless, and it would even make the service visible to a future `listContainers`. We deliberately do NOT rely on that: recreating a service explicitly marked "Non-runtime: it never starts" is a semantic violation, and a future pull-only service might not have a safe `entrypoint`. Keeping pull-only services out of the recreate set is the correct, durable contract; the harmless-`up` property is noted only as defense-in-depth, not the mechanism.

### 4. Bound failure to the safe side
If a deployment somehow lacks the named pull-only service, `docker compose pull aio-sandbox-image` errors and the script aborts BEFORE `up -d` (pull-before-up), leaving the running version intact — the safe failure direction. The `SELF_UPDATE_PULL_ONLY_SERVICES` env lets such a deployment empty the list. This is an accepted, low-probability edge (the service is standard) traded for closing the always-present provisioning break.

## Risks / Trade-offs

- **Hardcoded pull-only list** → a new never-starts cap service would need adding to `PULL_ONLY_CAP_SERVICES`. Accepted: such services are rare (one today), the list is env-overridable, and the alternative (compose-YAML discovery from inside the api container) is not reachable there.
- **Pull of a non-declared service errors** → mitigated by pull-before-up (running version survives) + env override; and `aio-sandbox-image` is standard on any task-running deployment.
- **Two lists where there was one** → small surface growth in `UpdateTopology`/`UpdatePlan`/the resolver/`buildPlan`, fully covered by `self-update.spec.ts`.

## Migration Plan

Pure code change in `apps/api/src/self-update`. No data/schema/HTTP change. The running production host has already been hot-fixed by a manual `docker pull cap-aio-sandbox:v0.14.0`; once this ships, the NEXT self-update will pull the sandbox image as part of the bounded plan, so the gap does not recur. Rollback = revert the change set (the updater falls back to the prior single-list behavior). No coordination needed.

## Open Questions

None blocking. (If a future deployment adds a second pull-only cap service, add it to `PULL_ONLY_CAP_SERVICES` or set `SELF_UPDATE_PULL_ONLY_SERVICES` — already the designed extension point.)
