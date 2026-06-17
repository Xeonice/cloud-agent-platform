# Research Brief — cutover-to-resident-compose

Side-car (not a tracked artifact). Distills the explore-phase research that grounds this
change. All findings below were gathered by read-only probes against the live prod host
(bwg-jp) + **empirical container tests** (Compose v5.1.4, grafana/grafana:11.2.0) run during
two `Workflow` design passes. Nothing here is speculative.

## 1. Why leave Dokploy (the "B" decision)

Dokploy acts on triggers (build-from-source on push), not continuous reconcile; it deploys
ONE compose file (no `-f a -f b` overlay). The maintainer wants the production backend to be
a plain **resident `docker-compose.prod.yml` stack** (the source-free run package already built
in the OSS-self-update epic) — split RUN from BUILD, no platform in the middle — while
preserving all data and the Cloudflare edge.

## 2. Cutover has ZERO impact on current logic — proven three ways

**Env parity.** The running api's full env is reproducible by `docker-compose.prod.yml` +
the existing `/etc/dokploy/compose/cloud-agent-platform/files/api.env`. That file holds **12
keys** incl. `CODEX_CHATGPT_AUTH_JSON_B64` (codex auth fallback), `GITHUB_OAUTH_REDIRECT_URI`,
`METRICS_SAMPLING_ENABLED` — an earlier worry that these were "missing" was a MISREAD; they are
all present. prod.yml's `environment:` overrides only 7 keys (PORT/WORKSPACES_DIR/DATABASE_URL/
AIO_SANDBOX_IMAGE/CAP_VERSION/MAX_CONCURRENT_TASKS/TASK_REPO_URL) — **zero intersection** with
the 12 file keys, so nothing in the env file is clobbered.

**Code parity.** `git diff v0.1.0..HEAD -- apps/api/src apps/web/src packages` is **empty** →
ghcr `cap-api:latest` (= v0.1.0 = f8e508f) runs the SAME code as the current Dokploy
source-build. Swapping to the prebuilt image is NOT a version change.

**Data parity.** Current compose project = `cloud-agent-platform`. Named volumes
`cloud-agent-platform_pgdata` (DB: 11 finished migrations / 3 tasks / 1 codex credential) and
`cloud-agent-platform_workspaces`. Network `cap-net` (fixed name) + `_default`. Bringing prod.yml
up with **`-p cloud-agent-platform`** resolves its `pgdata`/`workspaces`/`cap-net`/`default` to
these EXISTING volumes/networks → data in place. `prisma migrate deploy` on the reused pgdata is a
no-op.

**The 3 cutover must-dos (only real failure modes):**
1. `-p cloud-agent-platform` (else new-prefixed empty volumes → data appears "lost").
2. `pull` before `up` (ghcr images not yet on host — only `cap-aio-sandbox:pinned` +
   `cloud-agent-platform-api:latest` are present).
3. Reuse the existing `files/api.env` VERBATIM — do NOT hand-rebuild from
   `docker-compose.prod.env.example` (the template is a subset, would drop the codex fallback).

Intended (benign/improvement) deltas only: AIO_SANDBOX_IMAGE → ghcr (same-commit build),
CAP_VERSION unknown→latest, GIT_SHA/BUILD_TIME unknown→real.

## 3. Opt-in observability in the source-free run package — option A, verified

prod.yml currently EXCLUDES grafana/loki/alloy because the source compose **bind-mounts their
config from the source tree** (the only thing that broke the source-free promise). The source
compose ALREADY gates them as opt-in profiles: `observability` (loki + grafana-alloy),
`grafana` (grafana). The task is to mirror that toggle into the run package source-free.

**Decision: Option A — inline `configs: content:`** (scored 23 vs C-asset-bundle 17 vs
B-baked-images 15). Embed each config as a top-level `configs.<name>.content:` block, use the
pinned UPSTREAM images. Zero new CI images, single self-contained file.

**Empirically verified on the target host (Compose v5.1.4, grafana 11.2.0):**
- Grafana directory-provisioning works via per-file inline configs mounted at distinct
  file `target:`s; uid 472 reads the default `0444 root:root` mount with NO uid override;
  Loki datasource + dashboard provisioned; injected files coexist with image dirs.
- Alloy scrapes with ONLY `/var/lib/docker/containers:ro` (no docker.sock, no host net).
- Loki boots verbatim from inline config (`/ready`, `/loki/chunks` created).
- Inactive profile → `docker compose config` renders `services: {}`; inline configs are lazy →
  **default no-profile `up` is byte-for-byte unaffected** (this is the core "zero impact" proof).

**Adversarial must-handles (2 attacks returned holds=false — real refinements):**
- **`$$` escaping**: `datasources.yaml` has `${GRAFANA_PG_USER}`/`${GRAFANA_PG_PASSWORD}` for
  Grafana's OWN runtime expansion. Under inline `content:`, Compose eats them at render time —
  must write `$${...}`. (loki/alloy have no `$` → verbatim-safe.) Proven live.
- **Grafana Postgres-Audit external dep**: inlining can't make it functional. Needs
  `grafana-ro-role.sql` EXECUTED on cap DB (creates `grafana_ro`) + `GRAFANA_PG_USER/PASSWORD`
  env. The Loki tier is fully self-sufficient; the PG/audit panel needs an out-of-band step.
- Other: long-form service `configs` (source+target file path; short form drops to `/<name>`);
  carry data volumes separately (loki-data/alloy-data/grafana-data); alloy host bind stays;
  grafana loopback `127.0.0.1:3001:3000`; admin password has no default.

## 4. Locked decisions (maintainer)

1. **Audit panel = documented manual step.** observability (loki+alloy) + grafana's Loki
   datasource work out-of-box; PG-Audit panel documents the `grafana-ro-role.sql` + `GRAFANA_PG_*`
   one-time step.
2. **Config sync = release.yml generator.** A release-time step reads `deploy/observability/*`
   and generates/validates prod.yml's inline blocks (incl. `$→$$`). Source files stay canonical.
3. **Landing = one change** (this one): cutover + opt-in observability together (observability is
   how monitoring survives the cutover).

## 5. Known follow-up (OUT OF SCOPE here)

`self-update-action`'s bounded updater pins `COMPOSE_FILES = ['docker-compose.yml',
'docker-compose.images.yml']` (the source overlay), NOT `docker-compose.prod.yml`. On a resident
prod.yml stack the in-app one-click Upgrade would target the wrong topology. The resident
operator upgrades via `pull + up -d`. Reconciling the in-app updater with the resident run
package is a SEPARATE change; flagged in proposal Impact, not fixed here.

## Sources
- Live probes: `ssh bwg-jp` docker inspect/volume ls/psql (env, volumes, migrations, images).
- `git diff v0.1.0..HEAD` (code parity).
- Repo: `docker-compose.yml` (251-339), `docker-compose.prod.yml`, `deploy/observability/*`,
  `openspec/specs/release-and-versioning/spec.md`, `apps/api/src/self-update/`.
- Workflow `observability-optin-design` (run wf_dcde798d-ada): 5 config investigators + wiring +
  inline-configs mechanism (live-tested) + option scoring + adversarial refutation.
