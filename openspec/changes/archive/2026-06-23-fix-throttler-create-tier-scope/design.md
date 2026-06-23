# Design

## Context

`ThrottlerModule.forRoot` registers three named tiers: `default` (120/60s, broad), `create` (10/60s,
task-admission), `auth` (10/60s, pre-auth brute force). Two global guards existed: `AuthThrottleGuard`
(filters to `auth` + `shouldSkip` everything but the pre-auth endpoints) and `PrincipalThrottlerGuard`
(intended to be the broad per-principal default). But the latter filtered out only `auth`, leaving
`default` AND `create` both enforced on every authenticated request — so the 10/60s create cap
throttled normal console traffic. The fix introduces a third guard so each tier is scoped to exactly
where it belongs, mirroring how `AuthThrottleGuard` already scopes `auth`.

## Goals / Non-goals

- **Goal:** `create` (10/60s) applies ONLY to `POST /v1/tasks`; `default` (120/60s) bounds all other
  authenticated traffic; each account (local or GitHub) gets its own per-principal bucket.
- **Non-goal:** changing the tier limits/TTLs themselves, or the pre-auth `auth` tier; this is purely
  about which guard enforces which tier on which routes.

## Decisions

**D1 — Three disjoint guards, one tier each.** `AuthThrottleGuard` → `auth` (pre-auth endpoints);
`CreateThrottleGuard` → `create` (`POST /v1/tasks` only); `PrincipalThrottlerGuard` → `default` (all
authenticated routes). Each `onModuleInit`-filters `this.throttlers` to its single tier, so no guard
double-counts another's tier.

**D2 — `CreateThrottleGuard` mirrors `AuthThrottleGuard`.** Same proven shape: filter to the one
tier, override `shouldSkip(ctx)` to return true for every request whose method+path is NOT
`POST /v1/tasks` (path normalized like `normalizeAuthPath`), and `getTracker` reuses the shared
`principalTrackerKey` so the create cap is per-credential. The route already carries
`@Throttle({ create: {limit:10, ttl:60_000} })`; the guard simply makes that tier land only there.

**D3 — `principalTrackerKey` is `user.id`-first.** Order: `key:<keyId>` (machine api-key) →
`user:<user.id>` (any authenticated account — local OR GitHub, since `user.id` is the PK present for
both) → `kind:<kind>` fallback. This removes the shared `kind:session` bucket local accounts
previously collapsed into.

**D4 — `task-create-rate-cap.spec` registers both guards.** That spec previously wired only
`PrincipalThrottlerGuard` and relied on it to enforce `create`. With `create` moved to
`CreateThrottleGuard`, the spec now registers both (matching prod) and its fixtures carry `user.id`
(so two principals don't collapse to one bucket under the new tracker key). This is the one v1 file
the change touches — it is the create-cap test and could not stay green otherwise; it is NOT part of
any other in-flight change.

**D5 — Env mitigation is removable post-deploy.** Production currently runs
`V1_RATE_CREATE_LIMIT=100000` to neutralize the global create cap. Once this ships, the create cap is
correctly scoped to `POST /v1/tasks`, so that env override can be dropped (the v1-tasks route's
hardcoded `@Throttle({create:10})` remains the real admission cap).

## Risks / Trade-offs

- **Guard ordering / double-count:** mitigated by D1 (each guard filters to a disjoint tier) — proven
  by the existing throttler tests + the updated create-cap spec (create lands on POST /v1/tasks; a
  high-frequency GET is NOT create-throttled).
- **Tracker-key change touching auth principals:** `user.id` is always present on a session/api-key
  principal, so the key is always well-formed; the `kind:` fallback remains for any id-less case.

## Migration

None (guard wiring + tracker-key logic only). Operationally, remove `V1_RATE_CREATE_LIMIT=100000`
from prod `.env` after deploy (optional cleanup; harmless if left).
