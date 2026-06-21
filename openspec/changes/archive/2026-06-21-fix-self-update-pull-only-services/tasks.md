<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: pull-only-declaration (depends: none)

- [x] 1.1 In `apps/api/src/self-update/self-update.service.ts`, add an exported `PULL_ONLY_CAP_SERVICES: readonly string[] = ['aio-sandbox-image']` constant and a `SELF_UPDATE_PULL_ONLY_SERVICES` env key (parsed with the existing `parseList` helper, same pattern as `SELF_UPDATE_SERVICES`), so the never-starts pull-only cap services are declared explicitly and are operator-overridable. Do NOT remove `aio-sandbox-image` from the existing `CAP_SERVICES` fallback.

## 2. Track: topology-and-plan (depends: pull-only-declaration)

- [x] 2.1 Extend the `UpdateTopology` shape so the resolver returns the RUNNING cap services as the recreate set (rename/clarify the existing `services` to `recreateServices`, or add `recreateServices` alongside) — keep `DockerTopologyResolver.resolve()`'s `listContainers({all:true})` derivation as the source of the RUNNING cap services (unchanged logic, just the named role).
- [x] 2.2 Compute the PULL set as `recreateServices ∪ pullOnlyCapServices` (deduped, order-stable) — resolved from the `PULL_ONLY_CAP_SERVICES` constant / `SELF_UPDATE_PULL_ONLY_SERVICES` env — and carry it on `UpdateTopology` / `UpdatePlan` (e.g. `pullServices`). Keep both sets strictly cap-scoped (every entry is a cap service); never broaden to an unscoped `compose pull`.
- [x] 2.3 In `buildPlan()`, emit `docker compose … pull <pullServices>` and `docker compose … up -d <recreateServices>` (was a single shared `services` list). Preserve pull-before-up ordering, the `CAP_VERSION` `.env` pin, the compose-ensure step, and the detached-updater argv. Update the no-cap-service guard to key on the recreate set being empty.
- [x] 2.4 Update the `CAP_SERVICES`-fallback path (labels absent) so it likewise yields a recreate set (running-equivalent fallback) and a pull set that includes the pull-only services — the fallback already lists `aio-sandbox-image`, so ensure it lands in the pull set, not the recreate set, for consistency with the primary path.

## 3. Track: tests (depends: topology-and-plan)

- [x] 3.1 In `apps/api/src/self-update/self-update.spec.ts`, add/adjust cases proving: (a) a declared pull-only cap service (`aio-sandbox-image`) appears in the `pull` command but NOT in the `up -d` command; (b) the pull set = running cap services ∪ pull-only, deduped; (c) both commands stay cap-namespace-scoped (no postgres/loki/grafana, no bare `compose pull`); (d) pull still precedes up; (e) `SELF_UPDATE_PULL_ONLY_SERVICES` overrides the constant. Keep the existing topology-derivation and bound-target assertions green.

## 4. Track: verify (depends: tests)

- [x] 4.1 Run `apps/api` typecheck + the self-update test file (and the full `apps/api` test suite) to confirm the plan/topology change compiles and all assertions pass; confirm no debugger left and the change stays scoped to `apps/api/src/self-update`.
