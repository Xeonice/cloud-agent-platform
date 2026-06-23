# Verification Report — fix-throttler-create-tier-scope

Three-way routing adjudication of the raw-unmet findings. Each requirement was
re-traced end-to-end against the actual code (not rubber-stamped from the skeptic).
Both requirements re-trace as **MET**; no code task was re-opened and no spec defect
was found.

## MET (re-traced end-to-end, refutation does not hold)

### Requirement: The create rate-limit tier applies only to task creation — MET

End-to-end trace:

- `apps/api/src/rate-limit/create-throttle.guard.ts` — `CreateThrottleGuard.onModuleInit`
  narrows `this.throttlers` to `CREATE_THROTTLE_NAME` ALONE; `shouldSkip` returns true for
  every request whose `method !== POST` or whose normalized path `!== /v1/tasks`
  (`normalizeCreatePath` drops query + trailing slash + lower-cases). So the `create`
  tier lands ONLY on `POST /v1/tasks`.
- `apps/api/src/rate-limit/principal.throttler-guard.ts` — `PrincipalThrottlerGuard.onModuleInit`
  narrows to `default` ALONE (no longer retains `create`), so the broad tier bounds all
  other authenticated traffic and the small create cap no longer leaks onto polling.
- `apps/api/src/app.module.ts` — both guards registered as `APP_GUARD` (PrincipalThrottlerGuard,
  CreateThrottleGuard, AuthThrottleGuard), three disjoint tiers.
- `apps/api/src/v1/v1-tasks.controller.ts` — `POST /v1/tasks` carries `@Throttle(V1_CREATE_RATE)`
  with `create: { limit: 10, ttl: 60_000 }`.

Both scenarios are proven behaviorally in `apps/api/src/rate-limit/create-throttle.guard.spec.ts`:
- "Create cap does not land on non-creation routes" → `GET /v1/tasks/poll` burst at `LIMIT*4`
  stays all-200 (the create guard `shouldSkip`s it).
- "Task creation is still create-capped" → `POST /v1/tasks` past the window returns 429.

### Requirement: Rate-limit buckets are per-account by account id — MET

End-to-end trace:

- `apps/api/src/rate-limit/principal.throttler-guard.ts` — exported `principalTrackerKey`:
  precedence `key:<keyId>` (machine api-key) → `user:<user.id>` (any authenticated account,
  local OR GitHub, since `user.id` is the PK present for both) → `kind:<kind>` fallback. The
  former `kind:session` collapse for local accounts (githubId=null) is removed because keying
  is on `user.id`, not the GitHub id.
- Both `CreateThrottleGuard.getTracker` and `PrincipalThrottlerGuard.getTracker` reuse the
  shared `principalTrackerKey`, so both tiers are per-account.

Both scenarios are proven in `apps/api/src/rate-limit/principal.throttler-guard.spec.ts`:
- "Local account gets its own bucket" → two distinct local principals (githubId=null) yield
  distinct `user:<id>` keys (asserted `notEqual`), not a shared sentinel.
- "API-key principal keys by key id" → an api-key principal keys `key:key-abc` (keyId wins
  over the owner's user.id).

The skeptic's own "gap" analysis concluded all four scenarios across both requirements have
traceable implementations and that "No requirement has zero implementation." That matches the
re-trace; the refutation does not hold.

## Scope findings (NOT defects in this change's requirements)

The change's spec (`specs/request-rate-limiting/spec.md`) covers exactly two requirements:
create-tier scoping and per-account bucket keying. The working tree, however, carries a large
set of edits beyond rate-limiting — the `fix-local-account-*` family (api-keys scope, mcp-token
scope, task attribution by user.id, settings/github-import scope, audit recorder userId,
mcp-tools userId threading, etc.). Those touch:

- `apps/api/src/api-keys/*` (controller/service/spec — user.id scoping, dropped github gate)
- `apps/api/src/mcp-tokens/*` (controller/service/spec — user.id scoping)
- `apps/api/src/tasks/*`, `apps/api/src/v1/v1-tasks.controller.ts` (accountId/userId attribution)
- `apps/api/src/audit/*` (AuditRecorderPort + AuditService userId)
- `apps/api/src/auth/*`, `apps/api/src/mcp/*`, `apps/api/src/sandbox/prisma-codex-auth-source.ts`
- `apps/api/src/repos/github-import.*`

These are NOT regressions of this change's two requirements and do NOT re-open a task here; they
belong to the separate `fix-local-account-github-identity-gates` change present in the same tree.
Recorded as a scope note so the bundled working tree is documented: this change's commit should
be isolated to the rate-limit files (`rate-limit/*`, `throttler.options.ts`, `app.module.ts`
guard wiring, `v1/task-create-rate-cap.spec.ts`) per design D4.

## Tally

- reopenedTasks: none (both requirements MET).
- specDefects: none.
- reclassifiedMet: both requirements.
