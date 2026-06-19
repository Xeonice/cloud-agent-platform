# Verification Report — public-v1-api

Three-way adjudication of verify findings. Each raw-unmet finding was re-traced
end-to-end against the actual code before routing.

## Tally

- Reopened as code tasks (UNMET): 2 — "Idempotent /v1 task creation",
  "/v1 operations are scope-gated".
- Spec defects routed to design.md Open Questions: 0.
- Reclassified as MET (folded below): 1 — "Per-principal request rate limiting".

## MET (reclassified from raw-unmet)

### Per-principal request rate limiting (capability: request-rate-limiting)

Re-traced and confirmed MET end-to-end; the skeptic's own evidence describes a
fully wired implementation, and the spec (`specs/request-rate-limiting/spec.md`)
maps clause-for-clause to code:

- **Per-principal tracker, not per-IP** — `PrincipalThrottlerGuard.getTracker`
  (`apps/api/src/rate-limit/principal.throttler-guard.ts:45-51`) keys on
  `req.operatorPrincipal` via `principalTrackerKey` (`:59-68`): `key:<keyId>` for
  an api-key, `github:<githubId>` for a session/owner, `kind:<kind>` sentinel for
  the legacy shared token, with an IP fallback only when no principal is attached.
- **Second global guard, ordered AFTER auth (D7)** — `AuthModule` is imported
  first (registers the auth `APP_GUARD`), then `ThrottlerModule.forRoot(...)` and
  `PrincipalThrottlerGuard` are provided as the second `APP_GUARD`
  (`apps/api/src/app.module.ts:112-138`), so the principal is already attached
  when the limiter keys on it.
- **Named throttlers + env-overridable floors** — `buildThrottlerOptions()`
  (`apps/api/src/rate-limit/throttler.options.ts:32-45`) registers `default`
  (120/60s) and `create` (10/60s), each env-overridable through a positive-int
  floor guard so a bad config can never disable the limiter.
- **Per-principal task-creation cap** — `POST /v1/tasks` is decorated
  `@Throttle(V1_CREATE_RATE)` targeting the `create` throttler
  (`apps/api/src/v1/v1-tasks.controller.ts:54-56,99`), capping enqueue rate
  independently of the running-task semaphore (the unbounded queued backlog is the
  real abuse surface, exactly as the spec requires).
- **429 on window exhaustion + independent buckets** — the three behavioral tests
  in `apps/api/src/rate-limit/principal.throttler-guard.spec.ts:170-218` prove
  429 on window exhaustion, independent buckets for two principals from one IP,
  and throttler-runs-after-auth ordering.

Skeptic's refutation does not refute the requirement: it lists the guard, options,
ordering, decorator, and tests as PRESENT. No clause of the rate-limiting spec is
unmet. Routed to MET.

## Out-of-scope / extra behaviors observed (not spec-required, not defects)

These implementation details exceed or sit beside the spec; recorded for traceability,
none reopened:

- SSE poll re-entrancy guard (`let polling = false`) preventing overlapping DB
  reads across timer ticks — `apps/api/src/v1/v1-events.controller.ts:144-145`.
- SSE initial `:ok\n\n` flush comment forcing headers through a buffering proxy —
  `apps/api/src/v1/v1-events.controller.ts:137`.
- SSE `Connection: keep-alive` header (spec mandates only `text/event-stream`,
  `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`) —
  `apps/api/src/v1/v1-events.controller.ts:130`.
- `serializeSseEvent` emits extra fields not in `V1TaskEventSchema` (`userId`,
  `level`, `resultCode`, `runId`) — `apps/api/src/v1/v1-events.controller.ts:270-281`.
- SSE heartbeat/poll intervals env-overridable (`V1_SSE_HEARTBEAT_MS`,
  `V1_SSE_POLL_MS`) — `apps/api/src/v1/v1-events.controller.ts:67-83`.
- Rate-limit per-IP fallback when no principal is attached (guard-exempt routes) —
  `apps/api/src/rate-limit/principal.throttler-guard.ts:48-51`.
- Legacy shared-`AUTH_TOKEN` principal mapped to a `kind:legacy-token` sentinel
  bucket — `apps/api/src/rate-limit/principal.throttler-guard.ts:66-68`.
- Rate-limit env overrides (`V1_RATE_DEFAULT_LIMIT`/`_TTL_SEC`,
  `V1_RATE_CREATE_LIMIT`/`_TTL_SEC`) — `apps/api/src/rate-limit/throttler.options.ts:25-42`.
- Idempotency deterministic key-sorted SHA-256 canonicalization (`{a,b}` and
  `{b,a}` hash identically) — `apps/api/src/v1/idempotency.service.ts:45-48,163-183`.
- Idempotency expired-row replacement (DELETE + re-INSERT in one transaction) —
  `apps/api/src/v1/idempotency.service.ts:102-115`.
- Idempotency concurrent-retry race recovery (catch `P2002`, re-read winner,
  return its task or re-raise 409) — `apps/api/src/v1/idempotency.service.ts:120-138`.
  NOTE: this covers concurrent retries that both reach the dedup INSERT; it does
  NOT cover the commit-ordering window reopened as task V.1.
- Transcript short-circuit `status: empty, reason: agent-failed-to-start` for an
  `agent_failed_to_start` task — `apps/api/src/v1/v1-transcript.controller.ts:63-68`.
- Swagger UI HTML loaded from the unpkg CDN — `apps/api/src/openapi/openapi.registry.ts:387-391`.
- `buildV1DocsHtml` parameterizable `specUrl` argument — `apps/api/src/openapi/openapi.registry.ts:378`.

## Coverage gap note

Every named requirement across the three spec files has at least some traceable
implementation; no named requirement is wholly unimplemented. The only explicitly
pending sub-clause is the G7 live SSE probe (task 5.3, deploy-time `curl -N`
through the Cloudflare tunnel) — a sub-clause within the otherwise-implemented
"SSE lifecycle observation" requirement, not a missing requirement.
