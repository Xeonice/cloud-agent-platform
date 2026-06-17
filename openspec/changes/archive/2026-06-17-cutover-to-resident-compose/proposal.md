## Why

cap's production backend currently runs on Dokploy, which builds-from-source on push and only
ever deploys a single compose file — there is no place for the source-free run package
(`docker-compose.prod.yml`, built in the OSS-self-update epic) to actually run, and the
maintainer wants RUN split from BUILD: a plain, resident `docker compose` stack with no platform
in the middle. The blocker for adopting that run package as the resident substrate was twofold:
(1) it was never proven to reproduce the live system's behavior, and (2) it deliberately dropped
the observability stack (grafana/loki/alloy) because those services bind-mount config from the
source tree, which would break the source-free promise. Explore resolved both: a three-way parity
proof shows the cutover is behavior-neutral, and a live-verified inline-config technique lets
observability ship in the run package as an opt-in profile. Now is the time because the run
package, versioned release pipeline, and survive-redeploy adoption are all already shipped — the
remaining gap is making the run package the resident production stack.

## What Changes

- Extend `docker-compose.prod.yml` (the source-free run package) with an **opt-in observability
  stack** that mirrors the source compose's profiles — `loki` + `grafana-alloy` under the
  `observability` profile, `grafana` under the `grafana` profile — supplying every config via
  top-level inline `configs: content:` blocks (NOT source-tree bind-mounts), so the package stays
  a single file with no `git clone`. Operators self-select on startup via
  `COMPOSE_PROFILES=observability[,grafana]`; the default no-profile bring-up starts ONLY the core
  and materializes none of the observability configs.
- Narrow the run package's documented service-exclusion from "(reverse proxy / observability)" to
  "(reverse proxy)"; observability is no longer source-coupled once configs are inlined.
- Add a **release-time generator** (in `.github/workflows/release.yml`) that reads
  `deploy/observability/*` and generates/validates prod.yml's inline blocks — including the
  `$ → $$` escaping required so Grafana's own `${GRAFANA_PG_*}` runtime tokens survive Compose
  render-time interpolation — keeping the canonical source files the single editable origin and
  preventing YAML-in-YAML drift.
- Document the **Dokploy → resident-compose cutover runbook**: bring `docker-compose.prod.yml` up
  with `-p cloud-agent-platform` so it reuses the existing named volumes (`*_pgdata`,
  `*_workspaces`), the existing network, and the existing `files/api.env` verbatim — pulling the
  ghcr images first — so the resident stack reproduces the live api's env/code/data with no
  behavioral impact (proven in research-brief).
- Document the observability opt-in's out-of-band prerequisites: the Grafana **Loki** tier works
  out-of-box; the Grafana **Postgres-Audit** panel requires a one-time manual step
  (`grafana-ro-role.sql` against the cap DB + `GRAFANA_PG_USER/PASSWORD` env), plus
  `GRAFANA_ADMIN_PASSWORD`/`GRAFANA_ROOT_URL` before exposure; the run package env example gains
  these (commented, optional) keys.
- Document the **Compose Spec ≥ v2.23.1** floor (inline `configs.content:`); the target host runs
  v5.1.4 and satisfies it.

## Capabilities

### New Capabilities
<!-- none — this extends existing capabilities -->

### Modified Capabilities
- `release-and-versioning`: the "documented prebuilt-image self-host path" requirement changes —
  the source-free run package (a) no longer excludes observability (only the reverse proxy), (b)
  SHALL offer an opt-in observability stack whose config ships inline via `configs.content:` and
  is profile-gated so the default invocation is core-only, (c) is brought up as a RESIDENT stack
  that reuses an existing deployment's named volumes/env when given the matching project name, and
  (d) carries a release-time generator that keeps the inline observability config synced from the
  canonical `deploy/observability/*` source. A Compose Spec ≥ v2.23.1 floor is documented.

## Impact

- **Files**: `docker-compose.prod.yml` (add 3 profile-gated services + 5 inline configs + 3
  volumes), `docker-compose.prod.env.example` (add GRAFANA_* + observability notes),
  `.github/workflows/release.yml` (add inline-config generator/validator step),
  `openspec/specs/release-and-versioning/spec.md` (delta), `deploy/DEPLOY.md` and
  `docs/self-hosting.md` (cutover runbook + observability opt-in + grafana-ro-role.sql step).
- **Canonical config source** stays `deploy/observability/{loki-config.yaml, alloy-config.alloy,
  grafana/provisioning/*, grafana/dashboards/*}`; the generator mirrors them — no behavior change
  to the source `docker-compose.yml` observability profiles.
- **Runtime**: zero impact on the currently-running system. The added services are profile-gated
  and inert under the default no-profile bring-up (live-verified `services: {}` render). The
  cutover itself reuses existing volumes/env/network and the same-commit prebuilt image; `prisma
  migrate deploy` is a no-op on the reused DB.
- **Operational**: the maintainer must Stop/disable the Dokploy cap app's auto-deploy before/at
  cutover; the Cloudflare Tunnel → `localhost:8080` ingress is unchanged.
- **Host requirement**: amd64 (unchanged); Compose ≥ v2.23.1 for inline configs; stock Docker
  json-file logging driver at the default data-root for alloy's log scrape.
- **OUT OF SCOPE (known follow-up)**: `self-update-action`'s bounded updater pins
  `COMPOSE_FILES = [docker-compose.yml, docker-compose.images.yml]` (the source overlay), not
  `docker-compose.prod.yml`. On a resident prod.yml stack the in-app one-click Upgrade would
  target the wrong topology — the resident operator upgrades via `pull + up -d`. Reconciling the
  in-app updater with the resident run package is a separate change, not addressed here.
