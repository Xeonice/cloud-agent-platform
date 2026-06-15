# Design — observability-stack

## The à-la-carte ladder (the central design idea)

```
Tier 0  structured-logging (separate change)   ALWAYS ON, zero containers   ← floor
─────────────────────────────────────────────────────────────────────────────
Tier 1  Loki + Alloy        profile: observability      durable 14d store + query (LogCLI/API)
Tier 2  Grafana             profile: grafana            UI/dashboards (Loki + Postgres datasources)
Tier 3  Alerting            opt-in, independent         error spike → Telegram
```

INVARIANT: disabling any upper tier never breaks a lower one. Grafana down → Loki data intact +
queryable via LogCLI/HTTP API. Loki down → Tier 0 stdout+rotation still captures everything. This
is what "用户可以选择上也可以选择不上" requires, and it dictates every decision below.

## D1 · Collection: Alloy scrapes docker log files, NOT pino→Loki, NOT docker.sock

- pino stays stdout-only (owned by `structured-logging`); the app must NOT ship to Loki directly
  (`pino-loki`) — that couples the app to Loki's availability and pre-empts the opt-in model.
- Grafana **Alloy** (successor to promtail/grafana-agent) discovers and tails the Docker
  json-log files (`/var/lib/docker/containers/*/*-json.log`, mounted READ-ONLY) and ships to Loki.
- It reads log FILES, so it does NOT need `docker.sock` — a strictly smaller privilege surface
  than the api's root+socket. (docker_sd via the socket is the richer alternative but is rejected
  on privilege grounds; container metadata labels can be recovered from the log path / a label
  file.)
- Bonus: file-tailing also captures the per-task `cap-aio-<taskId>` sandbox logs (codex output)
  and nginx/postgres — useful for diagnosing failures at the container level.

## D2 · Storage: Loki single-binary, filesystem TSDB, 14-day retention

- Single-binary Loki (all targets in one process) with the TSDB single-store on the local
  filesystem (a named volume) — NO S3/object storage for a single node.
- `limits_config.retention_period: 336h` (14d) + `compactor { retention_enabled: true, ... }` so
  chunks older than 14d are compacted and deleted. 14d applies ONLY to Loki.
- Disk math: app+HTTP+container logs compress ~10× in Loki; even ~1–2 GB/day raw → ~14–28 GB for
  14d, comfortable on 160 GB. The real cost is MEMORY, not disk (see D5).

## D3 · Visualization: Grafana, two datasources, audit queried in place

- Grafana provisioned with TWO datasources:
  - **Loki** — LogQL over the operational logs (primary ops/debug entry; `{taskId="…"}` etc.).
  - **Postgres** — the existing `audit_events`, queried IN PLACE via a READ-ONLY role. Audit is
    "same source" in one pane WITHOUT being copied into Loki (no dual-write, no duplication, no
    bloat). `audit_events` stays the single source of truth + permanent append-only.
- Dashboards: error stream, by-`taskId` drill-down, HTTP overview, audit timeline (PG panel).
- Grafana is pure consumption: provisioned config is reproducible; its state volume is disposable.

## D4 · Alerting: opt-in, two valid homes

Alerting is OFF by default and independently enableable:
- **Grafana-native alert rules** (active only with the `grafana` profile) — simplest; no alerts
  when Grafana is down.
- **Loki ruler + webhook** (active with the `observability` profile) — alerts live in the storage
  tier, survive Grafana being down; needs a ruler config + a webhook receiver.
Either routes an error-rate/spike LogQL condition → **Telegram** (reuse the existing bot via a
webhook). Pick the home at enable-time per how "always-on" the operator wants alerting; the change
ships the wiring for the chosen one, not both forced on.

## D5 · Footprint guards (the only real cost on 8 GB)

```
Loki ~200MB + Alloy ~100MB + Grafana ~150MB ≈ 450–600MB resident
   competes with: cap-aio sandbox ~1–1.5GB each × concurrency slots
```
- Set `mem_limit` (and reservations) on Loki/Alloy/Grafana so the stack cannot starve sandboxes.
- Grafana being its own profile lets the operator reclaim ~150 MB by stopping just the UI.
- This memory pressure — not disk, not the 14d window — is the decision the operator is really
  making when enabling Tier 1/2.

## D6 · Profiles + exposure

- Compose profiles mirror the existing `proxy` (nginx) pattern: `observability` → Loki+Alloy;
  `grafana` → Grafana. `docker compose --profile observability [--profile grafana] up`.
- Loki/Alloy bind to the private compose network ONLY (no published ports).
- Grafana reachable ONLY through the existing Cloudflare tunnel WITH authentication — never a bare
  public port. (Single-operator threat model; consistent with the rest of the deploy.)

## D7 · No app/contract change

The api is unaware of Loki — it writes stdout (Tier 0). B is infra + config only. The field
vocabulary B relies on (`reqId`/`taskId`/`level`/`userId`) is the contract `structured-logging`
already pins; B turns those into Alloy labels + LogQL keys. If those field names change, B's
queries/labels change with them.

## Risks / open questions

- **Alloy docker-label recovery without docker.sock:** confirm container name/service/taskId are
  derivable from the log file path or a mounted label source; if not, weigh a minimal read-only
  docker metadata path vs accepting socket access for Alloy only.
- **Per-task sandbox log volume:** codex can be chatty; consider an Alloy drop/sample rule or a
  separate shorter retention stream for `cap-aio-*` so they don't dominate the 14d budget.
- **Alerting home (D4):** Grafana-native vs Loki ruler — decide at apply per the "always-on
  alerting?" answer.
- **mem_limit values:** start conservative (Loki 256m, Grafana 256m, Alloy 128m) and tune.
- **Grafana auth through the tunnel:** Cloudflare Access vs Grafana's own auth — pick the simplest
  that keeps it non-public.
