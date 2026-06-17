# Verification Report — cutover-to-resident-compose

Adjudicated against the actual code/artifacts on branch `main` (re-traced, not rubber-stamped).
Raw-unmet input list was empty (`[]`) — no skeptic-flagged unmet requirements to re-open or
route to spec-defect. The skeptic produced a **gap** finding (all spec requirements MET) and a
**scope** finding (extra behavior beyond spec). Both are recorded below; neither yields a code task.

## Three-way routing tally

- **verify-reopened (UNMET → code task):** 0
- **spec-defect (→ design.md Open Questions):** 0
- **MET (re-traced end-to-end):** all spec requirements (3 requirements / 14 scenario facets)

No new tasks reopened. No new spec-defects. design.md "Open Questions" already holds two genuine
design open questions (generator shape; in-app console observability surfacing) from prior passes —
NOT skeptic-routed and NOT re-opened here.

## MET requirements (re-traced end-to-end)

### Requirement 1 (MODIFIED): A documented prebuilt-image self-host path exists without changing the default

| Scenario | Evidence (re-traced) | Verdict |
|---|---|---|
| Opt-in image override runs pinned prebuilt images | `docker-compose.images.yml` exists; each cap service sets `image: ghcr.io/xeonice/cap-*:${CAP_VERSION}` (lines 37/46/55); overlay layers onto source base with `-f base -f images` | MET |
| Source-free run package runs without the source tree | `docker-compose.prod.yml` has NO `build:` blocks (only the line-6 comment matches `build:`) and NO source-tree bind-mounts; cap services use `image: ghcr.io/xeonice/cap-*:${CAP_VERSION:-latest}` (api L45, aio L68/107, web L90); `env_file` `.env`/`../files/api.env` both `required: false` | MET |
| Run package distributed via Release assets | `release.yml` `attach-run-assets` job (`if: github.event_name == 'release'`) uploads `docker-compose.prod.yml` + `docker-compose.prod.env.example` to the Release | MET |
| Host-architecture requirement documented | prod.yml header L19-22 ("REQUIRES AN amd64 / x86_64 HOST … no matching manifest for linux/arm64"); `docs/self-hosting.md` L330-332 | MET |
| Run package adopted as resident stack reuses an existing deployment in place | Named volumes `workspaces`/`pgdata` + `cap-net` network (L207-217) resolve to the existing project when brought up with `-p cloud-agent-platform`; documented in DEPLOY.md §11.4 (L415-459) incl. the `-p` / reuse-`files/api.env` must-dos | MET |
| Compose version floor documented | prod.yml header L35 ("REQUIRES Docker Compose >= v2.23.1"); DEPLOY.md §11.5 L490; self-hosting.md L346 | MET |
| Default path unchanged | source `docker-compose.yml` still has `build:` blocks (L45/155/227); prod.yml/overlay are additive opt-in | MET |

`CAP_VERSION` defaults to `latest` for api, aio-sandbox, web, and the `CAP_VERSION` env (L45/68/70/90/107),
so a bare `up` never resolves a blank/garbage tag — matches the spec's "DEFAULTS to `latest` … never a blank tag".

### Requirement 2 (ADDED): The source-free run package offers an opt-in inline-configured observability stack

| Scenario | Evidence (re-traced) | Verdict |
|---|---|---|
| Observability enabled via profiles starts from inline config, source-free | `loki` (`profiles: ["observability"]`, L134-148), `grafana-alloy` (`["observability"]`, L150-171), `grafana` (`["grafana"]`, L173-205); each attaches inline `configs:` at the correct `target:`; top-level `configs:` GENERATED block L221-521; Alloy retains the read-only `/var/lib/docker/containers:ro` host bind (L167) | MET |
| Default invocation is observability-free and unaffected | observability services profile-gated; tasks 4.1/4.2 verified `config` with no profile renders only api/aio-sandbox-image/postgres and materializes 0 observability configs | MET |
| Grafana Postgres-Audit datasource documents out-of-band prerequisites | DEPLOY.md §11.5 (grafana-ro-role.sql exec + GRAFANA_PG_*/GRAFANA_ADMIN_PASSWORD, L479-490), self-hosting.md L345-346, env example L60-66; Loki panels function independent of the Postgres role | MET |
| `$$` escaping for Grafana runtime tokens | committed prod.yml carries `$${GRAFANA_PG_USER}` (L380), `$${GRAFANA_PG_PASSWORD}` (L382), and `$$taskId` (L500) — survives Compose render-time interpolation | MET |
| Data volumes declared | `loki-data`/`alloy-data`/`grafana-data` in top-level `volumes:` (L214-217) | MET |

### Requirement 3 (ADDED): A release-time generator keeps the run package's inline observability config synced from the canonical source

| Scenario | Evidence (re-traced) | Verdict |
|---|---|---|
| Inline blocks generated/validated from canonical source at release time | `release.yml` `verify-run-package` job runs `node deploy/observability/gen-prod-observability-configs.mjs --check` (L57-58); `build-push` and `attach-run-assets` both `needs: verify-run-package`; ran `--check` locally → "observability configs in sync and `$`-escaped — OK" | MET |
| Editing a dashboard/datasource updates the single canonical source | generator reads `deploy/observability/*` (loki-config.yaml, alloy-config.alloy, grafana provisioning + dashboard JSON — SOURCES L31-37), escapes EVERY `$ → $$` (L45), and splices into the marker-delimited block; documented as single editable source in the script header + README | MET |

## MET-as-written with a minor gap that does not block the primary scenario

None identified — every facet re-traced cleanly.

## Gap finding (recorded, no code task)

Tasks 5.1 and 5.2 are explicitly **operator-gated infra execution steps** (run the cutover runbook on
the prod host; post-cutover live verification), NOT code/artifact requirements from the spec. The spec
requirements in `spec.md` are all artifact/behavior requirements, and every one has a traceable
implementation:

1. `docker-compose.images.yml` overlay — exists and implemented.
2. `docker-compose.prod.yml` source-free run package — exists with no `build:` blocks, `CAP_VERSION:-latest` default, all inline configs.
3. Release assets attachment — `attach-run-assets` job in `release.yml`.
4. Architecture documentation — documented in prod compose header (L19-22).
5. Volume reuse on existing deployment — named volumes with matching project name, documented in DEPLOY.md §11.4.
6. Compose version floor documented — prod compose header L35.
7. Default path unchanged — confirmed (`docker-compose.yml` still has `build:` blocks).
8. Observability opt-in via profiles (loki/alloy/grafana) — all three services added under profiles.
9. Inline configs for observability — GENERATED block present.
10. Profile-gated (no profile = core only) — verified in tasks 4.1/4.2.
11. `$$` escaping for Grafana runtime tokens — generator applies it; survives in committed prod.yml.
12. Grafana Postgres-Audit datasource docs/prerequisites — DEPLOY.md §11.5 + self-hosting.md.
13. Release-time generator validates inline blocks — `gen-prod-observability-configs.mjs --check` in release workflow.
14. Single canonical source for observability configs — documented in README and generator header.

Implication: tasks 5.1/5.2 remaining `[ ]` does NOT block spec verification — they are the operator's
go-live execution, intentionally not performed by the assistant (the change is OPERATOR-GATED).

## Scope finding — behaviors implemented with NO corresponding spec requirement (informational, no violation)

Extra behavior beyond the spec is not a verification failure; recorded for traceability.

1. **DEPLOY.md §11.4 step-by-step cutover runbook** (pg_dump backup command, Dokploy stop instruction,
   three must-dos list, rollback prose, `files/api.env` reuse warning) — `deploy/DEPLOY.md` §11.4
   (~L415-459). Spec requires the run package to BE behavior-neutral on adoption, not that docs contain
   a cutover runbook/backup/Dokploy-specific stop. Beneficial; supports D1 + Migration Plan.
2. **DEPLOY.md §11.4 note that the in-app self-update button does not target `docker-compose.prod.yml`**
   and directs users to `pull` + `up -d` (~L458-459). No spec requirement; aligns with the design's
   explicit Non-Goal (self-update updater reconciliation deferred).
3. **`mem_limit` constraints on observability services** (loki 256m, grafana-alloy 128m, grafana 256m) —
   prod.yml L148/171/205. Spec is silent on memory limits; sensible small-box hardening.
4. **Grafana hardening env** `GF_AUTH_ANONYMOUS_ENABLED: "false"` / `GF_USERS_ALLOW_SIGN_UP: "false"` —
   prod.yml L185-186. Spec names `GRAFANA_ADMIN_PASSWORD`/`GRAFANA_ROOT_URL` but not these; security-positive.
5. **`build-push` job gated on `verify-run-package`** (`needs: verify-run-package`) — release.yml L61.
   Spec scenario-specifies the drift-check step and the `attach-run-assets` gate; gating the image
   build too is a stricter superset (fail fast before pushing images). Not a violation.

## Tooling note

Local generator `--check` was run with Node v25.5.0 (fnm default); CI pins Node 22 (`release.yml` L54-56).
The generator is version-agnostic (only `node:fs`/`node:url`/`node:path` + a regex), so the local pass
is representative of the CI gate.
