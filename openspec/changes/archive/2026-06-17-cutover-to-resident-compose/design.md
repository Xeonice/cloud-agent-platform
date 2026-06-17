## Context

cap's production api currently runs on **Dokploy** (build-from-source on push, deploys a single
compose file, no overlay). The OSS-self-update epic already produced a source-free run package
(`docker-compose.prod.yml`) that pulls prebuilt GHCR images, but it has nowhere to actually run
in production and it deliberately omits the observability stack (grafana/loki/alloy) because the
source compose bind-mounts their config from `deploy/observability/*` — a source-tree dependency
the run package forbids.

Two questions had to be answered before adopting the run package as the resident production
substrate, and both were settled in explore (see `research-brief.md`, all findings
empirically verified — live host probes + real container tests on Compose v5.1.4):

1. Does a plain-compose resident stack reproduce the live api's behavior? **Yes** — env, code,
   and data parity all proven.
2. Can observability ship in a source-free package as an opt-in toggle? **Yes** — via inline
   `configs: content:`, live-verified to provision Grafana, scrape via Alloy, and stay inert when
   the profile is off.

Constraints: amd64-only (AIO base); Compose Spec ≥ v2.23.1 (inline configs); single-user
host-root-equivalent self-host; the Cloudflare Tunnel edge (`localhost:8080`) must be preserved;
no data loss; the currently-running tasks/sandboxes must not be disturbed by the change itself.

## Goals / Non-Goals

**Goals:**
- Make `docker-compose.prod.yml` runnable as the **resident production stack**, reusing the
  existing deployment's named volumes, network, and `files/api.env` so the cutover is
  behavior-neutral.
- Add an **opt-in observability stack** to the run package (profiles `observability` + `grafana`)
  with all config supplied INLINE (no source-tree bind-mounts), default-off.
- Keep the canonical observability config in `deploy/observability/*` and auto-sync the inline
  blocks at release time (no hand-maintained YAML-in-YAML).
- Document the Dokploy→resident cutover runbook + the observability opt-in prerequisites.

**Non-Goals:**
- Changing the source `docker-compose.yml` observability profiles (unchanged; canonical source).
- Reconciling the in-app one-click `self-update-action` updater with the resident prod.yml stack
  (its `COMPOSE_FILES` still point at the source overlay) — explicitly a separate follow-up.
- Multi-arch images, an HA/clustered observability backend, or a runtime-config web console
  (the prebuilt cap-web stays localhost-baked; out of scope here).
- Automating the Grafana Postgres-Audit role provisioning (kept a documented manual step).

## Decisions

### D1 — Resident `docker-compose.prod.yml` stack, cutover reuses the existing project
Bring the run package up with **`-p cloud-agent-platform`** (the current compose project name) so
its `pgdata`/`workspaces` volumes and `cap-net`/`default` networks resolve to the EXISTING ones,
and feed it the existing `files/api.env` verbatim. Rationale: this is what makes the cutover
behavior-neutral — proven by env parity (the 12-key `files/api.env` reproduces all secrets incl.
the codex `CODEX_CHATGPT_AUTH_JSON_B64` fallback; prod.yml's 7 `environment:` keys don't intersect
it), code parity (`git diff v0.1.0..HEAD -- apps/api/src apps/web/src packages` is empty, so ghcr
`cap-api:latest` == the running source-build), and data parity (`prisma migrate deploy` is a no-op
on the reused, fully-migrated pgdata). Alternative considered: a fresh project + DB restore from
`pg_dump` — rejected as higher-risk and unnecessary when the volumes can be reused in place
(pg_dump is still taken as a pre-cutover safety net, not the migration path).

### D2 — Opt-in observability via inline `configs: content:` (Option A)
Mirror the source compose's profile tiers into prod.yml using the pinned UPSTREAM images
(loki:3.1.1 / alloy:v1.3.1 / grafana:11.2.0), and supply each config as a top-level
`configs.<name>.content:` block attached to its service in **long form** (`source` + a full-file
`target:`). Scored decisively over alternatives:

| Option | source-free | opt-in UX | pipeline burden | maintainability | total |
|---|---|---|---|---|---|
| **A inline configs** | 5 | 5 | 5 | 4 | **23** |
| C config asset bundle | 3 | 2 | 4 | 4 | 17 |
| B baked cap-* images | 5 | 4 | 1 | 2 | 15 |

- **C** reintroduces relative bind-mounts into the file the spec says must have none, and degrades
  "self-select" into a two-artifact download+extract dance.
- **B** adds three Dockerfiles + three release build legs + perpetual CVE-patching of forked stock
  images, all to ship ~9KB of text.

Verified live on Compose v5.1.4: Grafana directory-provisioning is satisfied by per-file config
mounts (uid 472 reads the default `0444 root:root` mount, no uid override; injected files coexist
with image dirs); an inactive profile renders `services: {}` so the default `up` is byte-for-byte
unaffected. The one dependency no option can inline — Alloy's `/var/lib/docker/containers:ro`
host-log bind — is a host path (not source-tree), so it does not dent source-free integrity.

### D3 — Release-time generator keeps inline blocks synced from the canonical source
`deploy/observability/*` stays the single editable origin. A step in `release.yml` reads those
files and generates/validates the inline blocks in `docker-compose.prod.yml`, applying the
`$ → $$` escaping for Grafana's `${GRAFANA_PG_*}` runtime tokens. Rationale: hand-syncing
YAML-in-YAML block scalars is drift-prone and the `$$` escape is easy to forget. Alternative: hand
copy with a "synced from X" comment — rejected for drift risk (the maintainer chose the generator).

### D4 — Grafana Postgres-Audit panel = documented manual step
The `observability` tier (loki + alloy) and Grafana's **Loki** datasource work out-of-box once
inlined. Grafana's **Postgres-Audit** datasource cannot be made functional by inlining alone: it
needs `grafana-ro-role.sql` EXECUTED against the cap DB (creates the `grafana_ro` SELECT-only role)
plus `GRAFANA_PG_USER/PASSWORD` env. We ship the SQL + env as a documented one-time step rather
than an auto-run init container, to avoid adding a privileged moving part and a password-handling
surface to the run package. Alternative (init container that execs the SQL) is noted but deferred.

### D5 — Self-select on startup via `COMPOSE_PROFILES`, durable in `.env`
Operators enable observability with `COMPOSE_PROFILES=observability[,grafana]` (or `--profile`).
Persisting it in `.env` survives a bare `docker compose up --remove-orphans` (which drops ad-hoc
`--profile` flags). This does not change the default no-profile behavior.

## Risks / Trade-offs

- **Wrong/absent project name on cutover** → empty new-prefixed volumes, data appears lost.
  Mitigation: the runbook mandates `-p cloud-agent-platform`; verify `docker volume ls` shows the
  existing `cloud-agent-platform_pgdata`/`_workspaces` are reused, and take a `pg_dump` first.
- **ghcr images not yet on host** → `up` fails / new tasks have no sandbox image. Mitigation:
  `docker compose ... pull` before `up` (runbook step).
- **Rebuilding `.env` from the example template** → drops `CODEX_CHATGPT_AUTH_JSON_B64` and other
  keys the template omits. Mitigation: runbook says reuse the existing `files/api.env` verbatim;
  the example is for fresh self-hosters only.
- **Compose render eats Grafana's `${GRAFANA_PG_*}`** when inlined → datasource gets empty creds.
  Mitigation: D3 generator emits `$${...}`; a release-time validator asserts the escape is present.
- **Alloy host-log assumptions** (stock json-file driver at default data-root) → no logs on
  rootless Docker / remapped data-root / Podman. Mitigation: documented host requirement; the
  observability profile is opt-in so a non-conforming host simply doesn't enable it.
- **In-app self-update updater mismatch** on the resident stack (it targets the source overlay,
  not prod.yml) → the one-click Upgrade would act on the wrong topology. Mitigation: out of scope
  here; the resident operator upgrades via `pull + up -d`; flagged as a follow-up change.
- **Loki has `auth_enabled: false`** → must never be published to a host port. Mitigation: mirror
  the source compose exactly — loki/alloy publish NO host port; only grafana binds loopback
  `127.0.0.1:3001:3000`.

## Migration Plan

1. **Pre-flight** (no downtime): land the prod.yml + generator + docs change; cut a Release so
   ghcr has the matched image set; on the host `docker compose -p cloud-agent-platform -f
   docker-compose.prod.yml pull`.
2. **Backup**: `pg_dump` the cap DB to an off-volume file.
3. **Stop the builder**: in Dokploy, Stop/disable the cap app's auto-deploy (so it won't fight the
   resident stack).
4. **Cut over**: `docker compose -p cloud-agent-platform -f docker-compose.prod.yml up -d`
   (optionally `COMPOSE_PROFILES=observability,grafana` in `.env` to keep monitoring). Reuses the
   existing volumes/network/`files/api.env`.
5. **Verify**: `/health` + `/version` (now reports real gitSha), a task end-to-end (sandbox
   provisions from the ghcr AIO image), DB rows intact, Cloudflare edge still serves.
6. **Rollback**: re-enable the Dokploy app (the volumes are shared; the source-build image is still
   on the host) — or `docker compose ... down` and redeploy via Dokploy. Data is untouched
   throughout because both paths share `cloud-agent-platform_pgdata`.

## Open Questions

- Generator shape: a tiny Node/shell script invoked from `release.yml` vs a check-in-time
  pre-commit that regenerates prod.yml. Leaning release-time generate + CI validate; finalize in
  tasks.
- Whether to also surface the observability opt-in in the in-app console (out of scope now;
  depends on the self-update follow-up).
