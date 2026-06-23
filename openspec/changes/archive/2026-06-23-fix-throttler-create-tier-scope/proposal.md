# Fix: the create-tier rate limit throttled EVERY authenticated request

## Why

The `create` throttle tier (10 req / 60s — meant ONLY for `POST /v1/tasks`) was being enforced on
EVERY authenticated request. `PrincipalThrottlerGuard.onModuleInit` filtered out only the `auth`
tier, leaving BOTH `default` and `create` active; a vanilla `ThrottlerGuard` iterates ALL its tiers
per request, so the tiny 10/60s create cap landed on `/auth/session`, `/metrics`, `/tasks`, … — an
admin's dashboard polling breaks 10/min in seconds → **429** (the response carried
`retry-after-create` with `x-ratelimit-remaining: 105`, proving `create` — not `default` — fired).
Production was hot-mitigated with `V1_RATE_CREATE_LIMIT=100000`; this is the root fix that lets that
env hack be removed.

Separately, `principalTrackerKey` keyed local accounts (`githubId = null`) under a SHARED
`kind:session` bucket — a noisy-neighbor / fairness defect the review flagged (same
`githubId-as-identity-key` anti-pattern as the per-account scope fixes).

## What Changes

- **New `CreateThrottleGuard`** (mirrors the existing `AuthThrottleGuard` pattern): filters its
  tiers to ONLY `create`, and `shouldSkip` returns true for everything EXCEPT `POST /v1/tasks` — so
  the create cap lands ONLY on task creation. Keyed per-principal via the shared `principalTrackerKey`.
- **`PrincipalThrottlerGuard` now enforces ONLY `default`** (drops `create`, which moved to the new
  guard) — so authenticated traffic is bounded by the broad 120/60s default, never the create cap.
- **`principalTrackerKey` prefers `user.id`** (`user:<id>`) over `githubId`, so a local account gets
  its OWN bucket instead of a shared `kind:session` one.
- Registered `CreateThrottleGuard` as an `APP_GUARD` alongside the existing two; added a
  `CREATE_THROTTLE_NAME` constant (mirrors `AUTH_THROTTLE_NAME`). The three guards are disjoint —
  each filters to exactly one tier and scopes it.

## Impact

- Affected spec: `request-rate-limiting`.
- Affected code: `apps/api/src/rate-limit/{create-throttle.guard.ts (new), principal.throttler-guard.ts,
  throttler.options.ts}`, `app.module.ts`; tests (`create-throttle.guard.spec`,
  `principal.throttler-guard.spec`, `v1/task-create-rate-cap.spec`). **432 api tests green**;
  adversarial review verdict SHIP.
- After this deploys, the production `V1_RATE_CREATE_LIMIT=100000` mitigation can be removed.
