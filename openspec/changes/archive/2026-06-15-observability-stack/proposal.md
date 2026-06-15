## Why

`structured-logging` makes the api emit clean JSON to stdout with `reqId`/`taskId` correlation,
but stdout + bounded `json-file` only gets you `docker logs` + `jq` on a single box — no durable
cross-deploy history, no structured query (LogQL), no UI, no error alerting. The ddba diagnosis
showed the real need: pull "everything for task X" across the deploy that reclaimed it, from a
store that outlives the container. This change adds the OPT-IN aggregation + visualization layer on
top of the structured stdout.

The hard design constraint is the single 8 GB / 160 GB VPS shared with heavy per-task sandboxes
(~1–1.5 GB resident each): the stack must be light AND fully à-la-carte. Every layer is an
independent compose profile so an operator runs only what they want — durable storage without a
UI, or the UI only while actively debugging, then bring it down to reclaim memory. Disabling any
upper layer must never break the layer below; `structured-logging`'s stdout+rotation remains the
always-on floor.

## What Changes

- **Loki (storage, opt-in `observability` profile):** single-binary Grafana Loki with the
  filesystem TSDB store (no object storage), `retention_period: 14d` + compactor delete +
  compaction. Holds the high-volume operational logs (app + HTTP + per-task sandbox + nginx).
  14-day retention applies ONLY here — `audit_events` stays permanent append-only (unchanged).
- **Grafana Alloy (collection, with the `observability` profile):** scrapes Docker container
  stdout by READING the json log files read-only (NOT mounting `docker.sock` — a smaller
  privilege surface than the api's), labels lines by `service`/`taskId`/`level`, ships to Loki.
  The app stays stdout-only; Alloy is the shipper.
- **Grafana (visualization, SEPARATE opt-in `grafana` profile):** two datasources — Loki (LogQL
  over operational logs) and Postgres (the existing `audit_events`, queried in place, NOT copied)
  — so one pane shows logs + audit "same source" with zero duplication. Bringing Grafana down
  leaves Loki's data fully intact and queryable via LogCLI / the Loki HTTP API.
- **Alerting (opt-in, independent):** error-spike → Telegram, enabled only when wanted — either
  Grafana-native alert rules (active only with the `grafana` profile) or a Loki ruler + webhook
  (active with the storage profile). Off by default.
- **Exposure hardening:** Grafana is reachable ONLY via the existing Cloudflare tunnel with
  authentication, never bound to a bare public port. Loki/Alloy bind to the private compose
  network only.
- **Footprint guards:** `mem_limit` on Loki/Alloy/Grafana so the observability stack cannot
  starve the per-task sandboxes, plus the 14-day Loki retention bounding disk.

## Capabilities

### New Capabilities
<!-- None — extends the `observability` capability introduced by `structured-logging`. -->

### Modified Capabilities
- `observability`: ADD the opt-in aggregation/visualization layer — Loki durable storage with
  14-day retention, Alloy docker-log collection (no `docker.sock`), Grafana dual-datasource
  visualization (Loki + Postgres audit, no copy), opt-in error alerting to Telegram, and the
  profile-gated à-la-carte enablement with non-breaking layering. (Builds on the structured
  stdout + correlation fields already required by `structured-logging`.)

## Impact

- **Compose / infra:** new services in `docker-compose.yml` behind profiles — `loki` + `alloy`
  under `observability`, `grafana` under `grafana`; named volumes for Loki chunks + Grafana state;
  `mem_limit` on each; Loki config (filesystem TSDB, 14d retention + compactor), Alloy config
  (docker log-file discovery, relabel to `service`/`taskId`/`level`), Grafana provisioned
  datasources (Loki + Postgres read-only role). nginx/Cloudflare route for Grafana behind auth.
- **DB:** a read-only Postgres role/grant for the Grafana datasource over `audit_events` (no
  schema change; audit stays append-only/permanent).
- **Depends on:** `structured-logging` (the stdout JSON + `reqId`/`taskId`/`level`/`userId` field
  vocabulary it defines become Alloy labels + LogQL query keys).
- **No application/contract/frontend code change** — this is infra + config; the api is unaware of
  Loki (it just writes stdout).
- **Security:** Grafana never bare-public (tunnel + auth only); Alloy avoids `docker.sock`; the PG
  datasource is read-only; redaction is already guaranteed upstream by `structured-logging`.
- **Verification:** with the profiles up, confirm a task's logs land in Loki and are retrievable by
  `taskId` via LogCLI AND via Grafana; confirm Grafana renders both Loki logs and `audit_events`
  (PG datasource) in one view; confirm Grafana-down leaves Loki queryable; confirm 14-day
  retention config + compactor are active and `audit_events` is untouched; confirm Grafana is not
  reachable except through the authenticated tunnel; confirm `mem_limit`s are set.
