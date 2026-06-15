## Why

The api emits operational logs through NestJS's DEFAULT `Logger` — unstructured plain text to
stdout, captured by the Docker `json-file` driver with NO rotation configured
(`LogConfig.Config: {}`). Diagnosing the `ddba5929` production failure proved the cost: the api
logs had effectively vanished (rotated/redeployed away), there was no way to correlate "everything
that happened for task X", and an unbounded `json-file` is also a latent disk-fill risk. The
`audit_events` table covers STRUCTURED lifecycle events, but the raw operational/app/HTTP logs —
the layer that actually explains an unexpected exit — are ephemeral and unqueryable.

This change is the always-on, zero-new-infrastructure FOUNDATION (the explored "Tier 0"): make the
app emit STRUCTURED JSON logs to stdout with request/task correlation and secret redaction, and
bound the Docker log files. It is independently valuable (it immediately fixes the "can't recover
logs across a deploy / can't grep by task" pain) and is the prerequisite for a later, OPT-IN
log-aggregation stack (Loki/Alloy/Grafana — a separate `observability-stack` change). Nothing here
adds a container or a runtime dependency.

## What Changes

- **Adopt `nestjs-pino` as the app logger**, replacing the default `Logger` transparently (the
  ~76 existing `this.logger.*` call sites keep working). Output is single-line JSON to stdout,
  12-factor style — the app does NOT own a log sink.
- **Request + task correlation:** every HTTP request gets a stable `reqId` (pino-http
  `genReqId`); where a log pertains to a task, a `taskId` is bound to the log context, so
  "everything for task X" is a single field filter (`grep`/`jq` today, LogQL later).
- **HTTP access logging:** pino-http records one structured line per request (method, path,
  status, duration, `userId` when authenticated), replacing ad-hoc request logging.
- **Secret redaction (hard requirement):** pino `redact` strips credentials from logs —
  `Authorization`/`bearer.*`, the session cookie, the OAuth client secret, `CODEX_CRED_ENC_KEY`,
  and compatible-provider API keys — so structured logging never widens the secret surface
  (pino-http logs headers by default; un-redacted this would be WORSE than today).
- **Bounded Docker logs:** set `logging.driver: json-file` with `max-size` + `max-file` on the
  api service (and the other compose services) so stdout logs rotate with a hard disk ceiling
  instead of growing unbounded / vanishing unpredictably.
- **Log level via env** (`LOG_LEVEL`, default `info`), so prod can run `info` and debugging can
  raise to `debug` without a code change.

## Capabilities

### New Capabilities
- `observability`: ADD the structured-logging foundation — JSON-to-stdout app + HTTP logging with
  `reqId`/`taskId` correlation, mandatory secret redaction, env-driven level, and bounded Docker
  log rotation. (The opt-in aggregation/visualization layer — Loki/Alloy/Grafana, 14-day
  retention, alerting — is deferred to a separate `observability-stack` change that builds on this
  structured stdout.)

### Modified Capabilities
<!-- None — this is the first observability capability; it changes no existing requirement. -->

## Impact

- **Backend:** add `nestjs-pino` + `pino-http` (and `pino-pretty` as a dev-only transport);
  `app.module.ts` imports `LoggerModule.forRoot(...)` with the redaction + `genReqId` config;
  `main.ts` uses `bufferLogs: true` + `app.useLogger(app.get(Logger))` so Nest's own bootstrap
  logs also flow through pino. Existing `new Logger(Context)` / `this.logger.*` call sites are
  unchanged. A small mechanism binds `taskId` into the log context on task-scoped paths
  (guardrails/terminal/tasks).
- **Config:** `LOG_LEVEL` env (default `info`); `apps/api/.env.example` documents it.
- **Compose:** `logging:` block (json-file `max-size`/`max-file`) on the api (and sibling)
  services in `docker-compose.yml`; the per-task sandbox containers the provider creates SHOULD
  also be given a bounded log config.
- **No new container, no runtime service dependency, no contract/frontend change.** Pure logging
  shape + Docker log hygiene.
- **Security:** redaction is the load-bearing requirement — verification MUST assert no
  credential material appears in emitted logs (headers, cookies, env echoes).
- **Verification:** boot the api, hit authed + unauthed routes, confirm JSON lines carry
  `reqId`/`level`/`userId`, that a task-scoped log carries `taskId`, that
  `Authorization`/cookie/API-key values are redacted, and that `docker inspect` shows the bounded
  log config.
