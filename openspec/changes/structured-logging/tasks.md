<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: logger-core (depends: none)

- [x] 1.1 Add deps to `apps/api`: `nestjs-pino`, `pino`, `pino-http`, and `pino-pretty` (the last as a dev-only transport). Pin versions; run install.
- [x] 1.2 In `apps/api/src/app.module.ts`, register `LoggerModule.forRoot({...})` (nestjs-pino): JSON output, `level: process.env.LOG_LEVEL ?? 'info'`, `genReqId` for a stable per-request id, the `redact` config from 1.4, and a `pino-pretty` transport ONLY when not production (raw JSON in prod). Place it so it is available app-wide.
- [x] 1.3 In `apps/api/src/main.ts`, create the app with `{ bufferLogs: true }` and call `app.useLogger(app.get(Logger))` (nestjs-pino `Logger`) so framework bootstrap + the ~76 existing `this.logger.*` call sites all flow through pino. Confirm no double-logging (exactly one active logger).
- [x] 1.4 Define the `redact` paths (values → `[Redacted]`): `req.headers.authorization`, `req.headers.cookie`, `req.headers["set-cookie"]`, `res.headers["set-cookie"]`, and key-name patterns `*.apiKey`/`*.api_key`/`*.token`/`*.password`/`*.secret`. Add an explicit rule/comment forbidding logging whole `process.env`/config objects (covers `CODEX_CRED_ENC_KEY` + OAuth client secret).
- [x] 1.5 Document `LOG_LEVEL` (default `info`) in `apps/api/.env.example`.

## 2. Track: correlation (depends: logger-core)

- [x] 2.1 Enable pino-http auto HTTP access logging (one line/request) carrying method, path, status, duration; include the authenticated user identity when present (map from the request principal/session), WITHOUT logging the raw token/cookie (redacted per 1.4).
- [x] 2.2 Add a task-scoped log-context mechanism so logs emitted OUTSIDE an HTTP request carry `taskId`. Prefer an `AsyncLocalStorage` context seeded at the task-scoped entrypoints (guardrails exit handling, terminal/WS events, lifecycle timers) if there are more than a handful of call sites; otherwise bind `taskId` via a child logger at the key sites. The ddba-style paths (`recordExit`/`forceFail`/`onSessionExit`) MUST carry `taskId`.
- [x] 2.3 Verify "all logs for one task" is a single `taskId` field filter and "all logs for one request" is a single `reqId` filter (jq over captured stdout).

## 3. Track: docker-log-bounds (depends: none)

- [x] 3.1 In `docker-compose.yml`, add a `logging:` block (`driver: json-file`, `options: { max-size: "20m", max-file: "5" }`) to the api service and the other long-lived services (nginx, postgres). Values are a tunable starting ceiling (~100MB/container).
- [x] 3.2 In `apps/api/src/sandbox/aio-sandbox.provider.ts`, ensure per-task `cap-aio-<taskId>` containers are created with a bounded log config (`--log-opt max-size=... --log-opt max-file=...`) so a chatty codex run cannot exhaust host disk.

## 4. Track: verify (depends: correlation, docker-log-bounds)

- [x] 4.1 Build/typecheck + lint `apps/api`; confirm the app boots and the FIRST lines on stdout are pino JSON (framework logs included), not the default Nest text format.
- [x] 4.2 Hit an unauthenticated and an authenticated route; confirm each emits a JSON access line with `reqId`, `level`, method/path/status/duration, and `userId` on the authed one; confirm logs within a request share the `reqId`.
- [x] 4.3 Exercise a task-scoped path; confirm its logs carry `taskId` and are retrievable by a single `taskId` filter.
- [x] 4.4 SECURITY: send a request with an `Authorization` header + session cookie + (a settings call with) an API key; confirm the captured logs show `[Redacted]` for all of them and contain NO session/OAuth/codex-enc/API-key value anywhere.
- [x] 4.5 `docker inspect` the api (and a per-task sandbox) container; confirm the bounded `json-file` `max-size`/`max-file` log config is present.
