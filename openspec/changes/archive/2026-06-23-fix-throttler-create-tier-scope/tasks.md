# Tasks

> Implemented (agent) + adversarial review verdict SHIP; 432 api tests green. Recorded as done.

## 1. Track: create-tier scoping

- [x] 1.1 `apps/api/src/rate-limit/create-throttle.guard.ts` (new) — `CreateThrottleGuard` mirrors `AuthThrottleGuard`: `onModuleInit` filters `this.throttlers` to ONLY `create`; `shouldSkip` returns true for every request whose method+normalized-path is NOT `POST /v1/tasks`; `getTracker` reuses `principalTrackerKey`. + `create-throttle.guard.spec.ts`.
- [x] 1.2 `apps/api/src/rate-limit/principal.throttler-guard.ts` — `onModuleInit` filters to ONLY `default` (drop `create`, now owned by the new guard); `principalTrackerKey` prefers `user:<user.id>` over `github:<githubId>` (local accounts get their own bucket). `throttler.options.ts` — add `CREATE_THROTTLE_NAME` constant (mirrors `AUTH_THROTTLE_NAME`).
- [x] 1.3 `apps/api/src/app.module.ts` — register `CreateThrottleGuard` as an `APP_GUARD` alongside `PrincipalThrottlerGuard` + `AuthThrottleGuard`.

## 2. Track: tests

- [x] 2.1 `principal.throttler-guard.spec.ts` — assert the guard enforces only `default`; `principalTrackerKey` is user.id-first (local account → own `user:<id>` bucket; GitHub → `user:<id>`; api-key → `key:<id>`). `v1/task-create-rate-cap.spec.ts` — register BOTH guards (the create cap moved to `CreateThrottleGuard`) and give fixtures a `user.id` so distinct principals don't collapse to one bucket.

## 3. Track: verify-build

- [x] 3.1 api typecheck clean + full api test suite green (432 pass); adversarial review verdict SHIP (the v1 idempotency-scope follow-up remains separate/pre-existing).
