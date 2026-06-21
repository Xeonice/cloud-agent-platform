# Verification Report — fix-self-update-pull-only-services

Status: **PASS** — every spec requirement re-traces end-to-end to implementing code, and the full self-update suite is green.

## Method

Static trace of `specs/self-update-action/spec.md` against the working-tree implementation in
`apps/api/src/self-update/self-update.service.ts` + `self-update.spec.ts`, plus a dynamic run:
forced `nest build` (so `dist` reflects the unstaged change), `node --test dist/self-update/self-update.spec.js`,
and `tsc --noEmit -p tsconfig.json`.

- Test run: **18/18 pass**, 0 fail.
- Typecheck: **exit 0**.
- No `debugger` / stray `console.log` in `apps/api/src/self-update/`.
- Change stays scoped to `apps/api/src/self-update/{self-update.service.ts,self-update.spec.ts}`.

## Requirement: The upgrade target is bounded — validated version, cap namespace, cap services only

All six scenarios MET. Each maps to traceable implementation:

1. **Target must match the reported latest** — `versionsMatch(normalized, status.latestVersion)`
   in `planUpdate()` (gated also on `status.updateAvailable` and `latestVersion !== null`);
   covered by the `target-mismatch` / `no update available` tests.
2. **Pull covers every declared cap image; recreate covers only running cap services** —
   `resolveServiceSets()` splits declared cap services into `services` (recreate) and
   `pullServices` (= recreate ∪ pull-only, deduped); `buildPlan()` emits
   `compose pull <pullServices>` then `up -d <services>`. `PULL_ONLY_CAP_SERVICES` /
   `SELF_UPDATE_PULL_ONLY_SERVICES` supply the never-starts members. Both sets stay
   cap-scoped (forbidden-token assertions for postgres/loki/grafana/nginx/ghcr.io).
3. **A never-starts pull-only cap service is pulled but not recreated** — `resolveServiceSets()`
   filters pull-only entries out of `services` while keeping them in `pullServices`; the plan
   test asserts `pull ... aio-sandbox-image` is present and `up -d` does NOT contain
   `aio-sandbox-image`.
4. **The sandbox image is staged so post-upgrade task provisioning succeeds** — the chain is
   complete: `AIO_SANDBOX_IMAGE: ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION:-latest}`
   (`docker-compose.prod.yml:68`) means that when the api container is recreated with the new
   `CAP_VERSION` (persisted into `.env` by `buildPlan()`'s atomic pin), it picks up the updated
   sandbox image reference; the `aio-sandbox-image` pull-only service (`docker-compose.prod.yml:113-114`)
   ensures the image is staged before `up -d` via the pull set. This is fully implemented across
   the diff + compose definitions.
5. **Topology is derived from the running deployment, not fixed literals** — `DockerTopologyResolver.resolve()`
   reads the api container's `com.docker.compose.{project,project.config_files,project.working_dir}`
   labels and derives the RUNNING cap services from `listContainers({all:true})` filtered on
   `ghcr.io/<owner>/cap-*` images.
6. **A deployment without compose labels falls back to operator env** — `fallbackTopology()`
   (env overrides else documented literals), with the `no-cap-service` refusal guard when the
   recreate set is empty.

## Gap analysis (cross-file chain — Scenario 4)

The chain is complete: `AIO_SANDBOX_IMAGE: ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION:-latest}`
in compose means when the api container is recreated with the new `CAP_VERSION`, it picks up the
updated sandbox image reference. The `aio-sandbox-image` pull-only service ensures the image is
staged before `up -d`. This is fully implemented.

All 6 scenarios from the spec have traceable implementation:

1. Target must match reported latest — `versionsMatch` in `planUpdate()`
2. Pull covers every declared cap image including never-starts — `resolveServiceSets()`, `PULL_ONLY_CAP_SERVICES`
3. Never-starts pull-only cap service pulled but not recreated — `resolveServiceSets()` filters pull-only from `services`
4. Sandbox image staged so post-upgrade provisioning succeeds — pull set includes `aio-sandbox-image`; compose resolves `AIO_SANDBOX_IMAGE` from `CAP_VERSION` at container recreation
5. Topology derived from running deployment — `DockerTopologyResolver` reads `com.docker.compose.*` labels
6. Fallback to operator env when no compose labels — `fallbackTopology()` with `no-cap-service` refusal guard

## Scope analysis (no scope creep)

Confirmed: `ensureImage`, `updaterBindDirs`, and `parentDir` are all **pre-existing** in `HEAD`
(already committed on the branch — verified via `git show HEAD:…`). The current unstaged change
does NOT introduce them. Conversely, `resolveServiceSets`, `PULL_ONLY_CAP_SERVICES`,
`PULL_ONLY_SERVICES_ENV`, and the `pullServices` field are absent from `HEAD` (0 hits) — they are
exactly the additions this change introduces.

The analysis is complete. Every implemented behavior in the diff maps cleanly to a requirement in
the spec. There is no scope creep.

## Three-way routing tally

- verify-reopened code tasks: **0**
- spec defects (design.md Open Questions): **0**
- reclassified MET (folded above): **1** requirement ("The upgrade target is bounded — validated
  version, cap namespace, cap services only", all 6 scenarios)

No raw-unmet findings were supplied by the skeptic; the independent re-trace confirms the
requirement is MET end-to-end.
