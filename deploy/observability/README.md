# Observability stack (observability-stack)

Opt-in, à-la-carte log aggregation + visualization on top of the always-on
structured stdout logging (`structured-logging`). Nothing here runs unless its
compose profile is enabled.

## Layers (each independently toggleable)

| Tier | Profile | Services | What you get |
|------|---------|----------|--------------|
| 1 storage+collect | `observability` | `loki`, `grafana-alloy` | durable 14-day logs, queryable via LogCLI / Loki HTTP API |
| 2 UI | `grafana` | `grafana` | dashboards over Loki + the audit Postgres datasource |
| 3 alerting | (opt-in file) | — | error-spike → Telegram (off by default) |

```bash
docker compose up -d                                   # Tier 0 only (stdout + rotation)
docker compose --profile observability up -d           # + Loki + Alloy
docker compose --profile observability --profile grafana up -d   # + Grafana
```

Disabling an upper tier never breaks a lower one: stop `grafana` and Loki data is
still queryable; stop `observability` and the api still logs to stdout with
bounded Docker rotation.

## Retention

14 days, in Loki ONLY (`loki-config.yaml` `retention_period: 336h` + compactor).
`audit_events` (Postgres) is permanent append-only and is queried in place by
Grafana — never copied into Loki, never subject to the 14-day window.

## Collection (Alloy, no docker.sock)

`grafana-alloy` tails the Docker json-log files READ-ONLY
(`/var/lib/docker/containers:ro`) — it does NOT mount `docker.sock` (design D1).
The api lines are pino JSON, so `taskId`/`reqId` ride inside the line and are
queried with `| json | taskId="…"` (kept OUT of stream labels to bound
cardinality). Stream labels are `container` (id from the file path), `stream`,
`level`.

**Limitation:** without the socket, the only container identity is the container
ID. Per-task `cap-aio-<taskId>` sandbox stdout is not pino JSON, so it carries the
`container` (id) label only; map an id to its task via `docker ps` out-of-band. If
friendly compose-service labels become worth the privilege, switch Alloy to
`loki.source.docker` (needs the socket) — a deliberate, separate decision.

## Grafana — never bare-public

`grafana` publishes NO host port; it is on the private compose network only.
Expose it ONLY through the existing authenticated Cloudflare tunnel (route the
tunnel / an nginx `location` to `grafana:3000`); Grafana's own login is the gate
(`GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false`). Set
`GRAFANA_ROOT_URL` to the tunnel URL.

## Required env / one-time setup

1. **Read-only Postgres role** for the audit datasource — run once:
   ```bash
   psql -U cap -d cap -f deploy/observability/grafana-ro-role.sql   # edit the password first
   ```
2. **Grafana env** (Dokploy file mount / compose env):
   ```
   GRAFANA_PG_USER=grafana_ro
   GRAFANA_PG_PASSWORD=<the password set in the SQL>
   GRAFANA_ROOT_URL=https://<grafana-tunnel-host>/
   ```
3. **Alerting (opt-in, Tier 3):** fill + rename
   `provisioning/alerting/error-spike.yaml.example` → `error-spike.yaml`, set
   `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, restart the `grafana` profile.

## Persisting across Dokploy redeploys (IMPORTANT)

The profiles above are enabled by the OPERATOR — a plain Dokploy auto-deploy runs
`docker compose up` WITHOUT them, so a manual `--profile … up` is NOT managed by
Dokploy and may be dropped on the next deploy (`--remove-orphans`). To make the
stack durable, set these in the Dokploy compose ENV for this app:

```
COMPOSE_PROFILES=observability,grafana        # or just `observability` for no UI
GRAFANA_PG_USER=grafana_ro
GRAFANA_PG_PASSWORD=<the password from grafana-ro-role.sql / the live setup>
GRAFANA_ROOT_URL=https://<grafana-tunnel-host>/
GF_SECURITY_ADMIN_PASSWORD=<set a strong admin password before exposing>
```

Then Dokploy manages loki/alloy/grafana like the other services on every deploy.

## Security before exposing Grafana

Grafana ships with `admin/admin` and is reachable ONLY inside the compose network
(no published port) until you route the Cloudflare tunnel to `grafana:3000`.
BEFORE pointing the tunnel at it: set `GF_SECURITY_ADMIN_PASSWORD` (or change the
admin password on first login). Anonymous + sign-up are already disabled.

## Operational note: dashboard/provisioning changes need a Grafana restart

Grafana mounts `deploy/observability/grafana/{provisioning,dashboards}` as bind
mounts. Docker does NOT recreate a container when only bind-mount CONTENT changes,
and on a Dokploy redeploy the `code` dir is re-cloned (new inode) while a
config-unchanged Grafana container is left running — so it keeps serving the OLD
provisioned dashboards/datasources. After changing anything under
`deploy/observability/grafana/` and deploying, if the UI still shows the old
version:

```bash
docker restart cloud-agent-platform-grafana-1
```

(Loki/Alloy config changes are picked up the same way — restart that container.)

## Footprint

`mem_limit`: loki 256m, grafana 256m, alloy 128m (~640m ceiling). Stop the
`grafana` profile to reclaim ~256m when not actively debugging. The real cost on
the 8 GB box is memory (competes with per-task sandboxes), not the 14-day disk.
