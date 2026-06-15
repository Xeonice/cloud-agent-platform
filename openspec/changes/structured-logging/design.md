# Design — structured-logging

## Scope boundary (Tier 0 only)

This is the always-on foundation from the observability exploration. IN scope: structured JSON to
stdout + correlation + redaction + Docker log rotation. OUT of scope (deferred to
`observability-stack`, all opt-in via compose profiles): Loki, Grafana Alloy, Grafana, 14-day
retention, dashboards, alerting. The contract this change must honor for B: **the app emits
clean, parseable JSON to stdout and nothing else** — collection/storage is a strictly downstream,
optional concern.

## D1 · pino, not winston

`nestjs-pino` is the modern NestJS default: low-overhead async JSON, first-class request-context
binding, and a drop-in `LoggerService` so the ~76 existing `this.logger.*` call sites need no
change. winston is heavier/slower with no benefit here. Decision: `nestjs-pino` (`pino` +
`pino-http`), `pino-pretty` as a DEV-ONLY transport (prod stays raw JSON for machine parsing).

## D2 · stdout only — the app owns no sink

12-factor: the app writes JSON to stdout; the platform (Docker today, Alloy→Loki later) owns
shipping/storage. NO `pino-loki`/file transport in the app — that would couple the app to a sink's
availability and pre-empt B's opt-in design. This keeps Tier 0 dependency-free and makes B a pure
add-on.

## D3 · Correlation: reqId (HTTP) + taskId (task-scoped)

- HTTP path: `pino-http genReqId` assigns a stable `reqId` per request; all logs emitted during
  that request inherit it (pino-http child logger). One request = one `reqId`.
- Task-scoped path: guardrails/terminal/tasks logs fire OUTSIDE an HTTP request (timers, WS
  events, exit handling — exactly the ddba code paths), so there is no ambient `reqId`. Bind
  `taskId` explicitly there. Mechanism options:
  - (a) An `AsyncLocalStorage` log context that task-scoped entrypoints seed with `{ taskId }`,
    so nested `this.logger.*` calls inherit it automatically. Cleanest, no signature churn.
  - (b) Pass a child logger / structured field at each call site. Simple but verbose/leaky.
  Lean (a) for the hot task paths; (b) is an acceptable fallback for one-off lines. Either way the
  GOAL is: "all logs for task X" is a single `taskId` field filter.

## D4 · Redaction is load-bearing (security)

pino-http logs request headers by default; without redaction structured logging would PERSIST
credentials — strictly worse than today. `redact` paths (values replaced with `[Redacted]`),
covering at minimum:

```
req.headers.authorization
req.headers.cookie            (carries the session cookie)
req.headers["set-cookie"], res.headers["set-cookie"]
*.apiKey, *.api_key, *.token, *.password, *.secret
```

Plus a guard against logging whole config/env objects (no `console.log(process.env)` style dumps).
`CODEX_CRED_ENC_KEY` / OAuth client secret live in env and must never be logged — covered by the
"no env-object dumps" rule + key-name redaction. Verification asserts none of these appear in
output.

## D5 · Replace Nest's own logger

`main.ts`: `NestFactory.create(AppModule, { bufferLogs: true })` then
`app.useLogger(app.get(Logger))` so framework bootstrap/route-mapping logs ALSO become pino JSON
(no split between "Nest text logs" and "app JSON logs"). `bufferLogs` holds early logs until pino
is ready.

## D6 · Level via env

`LOG_LEVEL` (default `info`). Prod runs `info`; raise to `debug` for an incident without a
redeploy of code (Dokploy env change + restart). pino levels are numeric and cheap to filter
downstream.

## D7 · Bounded Docker logs

Root cause of the ddba log-loss: `json-file` with empty config = unbounded growth +
unpredictable loss. Set on api (and siblings):

```yaml
logging:
  driver: json-file
  options: { max-size: "20m", max-file: "5" }   # ~100MB ceiling per container
```

Per-task sandbox containers (`cap-aio-<taskId>`) the provider creates via DooD should be created
with the same bounded `--log-opt` so a chatty codex run cannot fill the disk. (Sizes are a
starting point, tunable.)

## Risks / notes

- **AsyncLocalStorage overhead:** negligible for this scale; pino+ALS is a well-trodden combo.
- **Double logging during cutover:** ensure exactly one logger is active (`useLogger` replaces the
  default) so lines aren't emitted twice.
- **Log volume:** `info` default keeps volume sane; the chatty `debug` lines stay off in prod.
- **B's dependency:** B will scrape these stdout JSON lines via Alloy; field names chosen here
  (`reqId`, `taskId`, `level`, `userId`) become B's label/query vocabulary — pick them
  deliberately now.

## Open questions

- AsyncLocalStorage (D3a) vs per-call child loggers (D3b) for `taskId` — pick during apply based
  on how many task-scoped call sites there are; ALS preferred if >a handful.
- Exact `max-size`/`max-file` values — start at 20m×5 and tune against real volume.
