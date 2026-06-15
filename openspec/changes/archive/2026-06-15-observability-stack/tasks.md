<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     PREREQUISITE: `structured-logging` (Tier 0) must be applied — its stdout JSON +
     reqId/taskId/level/userId fields are the labels/queries this change builds on. -->

## 1. Track: loki-storage (depends: none)

- [x] 1.1 Add a `loki` service to `docker-compose.yml` under `profiles: [observability]`: single-binary Grafana Loki, pinned image, bound to the private compose network ONLY (no published port), named volume for chunks/index, `mem_limit` (~256m start).
- [x] 1.2 Add the Loki config (mounted file): TSDB single-store on filesystem, `limits_config.retention_period: 336h` (14d), `compactor { retention_enabled: true, delete_request_store: filesystem }` + compaction interval. Confirm NO object-storage dependency.
- [x] 1.3 Sanity-boot Loki alone (`--profile observability`) and confirm it's ready + the retention/compactor config is loaded (Loki `/config` or logs).

## 2. Track: alloy-collection (depends: loki-storage)

- [x] 2.1 Add a `grafana-alloy` service under `profiles: [observability]`: pinned image, READ-ONLY mount of `/var/lib/docker/containers`, `mem_limit` (~128m), private network, depends_on loki. Do NOT mount `docker.sock`.
- [x] 2.2 Author the Alloy config: discover/tail `*-json.log`, parse the JSON line, relabel to Loki labels `service` (container), `level`, and `taskId` (from the structured field). Push to Loki. Keep label cardinality bounded (taskId is high-cardinality — keep it as a STRUCTURED field/filter, not necessarily a stream label, per Loki best practice; decide and document).
- [x] 2.3 Recover container identity WITHOUT docker.sock (from the log file path / a label file). If genuinely impossible, document the tradeoff (minimal read-only docker metadata vs accepting socket for Alloy only) and pick.
- [ ] 2.4 Consider per-task `cap-aio-*` log volume: add an Alloy drop/sample rule or a shorter-retention stream so chatty codex runs don't dominate the 14d budget; log what is dropped (no silent truncation).

## 3. Track: grafana-ui (depends: loki-storage)

- [x] 3.1 Add a `grafana` service under a SEPARATE `profiles: [grafana]`: pinned image, named volume for state, `mem_limit` (~256m), reachable ONLY via the existing Cloudflare tunnel + auth (nginx route; never a bare public port).
- [x] 3.2 Provision two datasources (as code): Loki, and Postgres pointed at `audit_events` via a READ-ONLY DB role/grant (add the role; no schema change; audit stays append-only/permanent).
- [x] 3.3 Provision baseline dashboards: error stream, by-`taskId` drill-down, HTTP overview (from Loki), and an audit-timeline panel (from the Postgres datasource).
- [x] 3.4 Confirm the layering invariant: stop the `grafana` profile and verify Loki data is still queryable via LogCLI / the Loki HTTP API.

## 4. Track: alerting (depends: grafana-ui)

- [x] 4.1 Decide the alert home per the "always-on alerting?" intent: Grafana-native alert rules (active only with `grafana`) OR Loki ruler + webhook (active with `observability`). Document the choice.
- [x] 4.2 Wire an error-rate/spike condition (LogQL) → Telegram via a webhook to the existing bot. Keep it OFF by default (no rules provisioned unless explicitly enabled).
- [ ] 4.3 Verify: trigger the condition (inject error logs) and confirm a Telegram alert fires only when alerting is enabled; confirm logging+storage work with alerting disabled.

## 5. Track: verify (depends: alloy-collection, grafana-ui)

- [x] 5.1 `--profile observability` up: produce task logs, restart the api, and confirm the task's logs are still retrievable from Loki by a single `taskId` query (the ddba scenario).
- [x] 5.2 `--profile observability --profile grafana` up: confirm Grafana renders Loki logs AND `audit_events` (PG datasource) in one view, audit read in place (not copied).
- [x] 5.3 Confirm 14-day retention/compactor is active and that `audit_events` is NOT affected by it (old audit rows persist).
- [x] 5.4 Confirm Grafana is unreachable except via the authenticated tunnel; Loki/Alloy expose no public port; `mem_limit`s are set on all three.
- [x] 5.5 Confirm `docker compose up` with NO profiles starts none of these services and the api still logs to stdout (Tier 0 floor intact).
