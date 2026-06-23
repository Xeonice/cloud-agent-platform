import { seconds, type ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * The named tier the pre-auth {@link AuthThrottleGuard} keys on (IP + submitted
 * email). Exported so the guard's `@Throttle({ [AUTH_THROTTLE_NAME]: … })`
 * decorator and this registration cannot drift apart — an unknown throttler name
 * is silently inert, so the decorator and the option MUST agree on the literal.
 */
export const AUTH_THROTTLE_NAME = 'auth';

/**
 * The named tier the dedicated {@link CreateThrottleGuard} keys on (per-principal)
 * and that the v1-tasks controller's `@Throttle({ [CREATE_THROTTLE_NAME]: … })`
 * route override references for `POST /v1/tasks`. Exported as a single literal so
 * the registration here, the per-route override, and the guard's `onModuleInit`
 * filter cannot drift — an unknown throttler name is silently inert.
 */
export const CREATE_THROTTLE_NAME = 'create';

/**
 * Throttler configuration for the public API (public-v1-api, Integration 6.1).
 *
 * Builds the in-memory (default store) named throttlers the global
 * {@link PrincipalThrottlerGuard} and the per-route `@Throttle` decorators key
 * off. Three named throttlers are registered so the guards can enforce a broad
 * per-request cap, a stricter task-creation cap, and a dedicated pre-auth tier:
 *
 *   - `default` — the GLOBAL per-request rate cap applied to every guarded route.
 *     The {@link PrincipalThrottlerGuard} keys it on the resolved principal, so it
 *     is per-api-key / per-owner, not per-IP.
 *   - `create`  — the STRICTER `POST /v1/tasks` task-admission cap the v1-tasks
 *     controller opts a single route into via `@Throttle({ create: … })`. An
 *     unknown throttler name is silently inert, so this name MUST be registered
 *     here for that per-route override to bite. The running-task semaphore bounds
 *     RUNNING tasks, not CREATED ones, so an unbounded queued backlog is the real
 *     abuse surface this caps. The per-route `@Throttle` already sets the create
 *     limit/ttl; this registration only has to make the `create` name exist.
 *   - `auth`    — the pre-authentication brute-force tier for the public auth
 *     endpoints (password login, OTP request/verify, change-password). These run
 *     BEFORE a principal exists, so the principal throttler has nothing to key on;
 *     the {@link AuthThrottleGuard} keys this tier on client IP + submitted email
 *     instead, so one attacker can neither brute-force a password nor mass-issue
 *     OTP codes from a single source (this caps issuance ON TOP OF the per-email
 *     resend cooldown the OTP service enforces). The limit is intentionally much
 *     tighter than `default` because a pre-auth caller is anonymous.
 *
 * All limits/TTLs are env-overridable for ops (a deploy can tighten or loosen the
 * caps without a code change) and floored so a misconfiguration can never disable
 * the limiter:
 *   - `V1_RATE_DEFAULT_LIMIT` / `V1_RATE_DEFAULT_TTL_SEC`  (default 120 / 60s)
 *   - `V1_RATE_CREATE_LIMIT`  / `V1_RATE_CREATE_TTL_SEC`   (default  10 / 60s)
 *   - `AUTH_RATE_LIMIT`       / `AUTH_RATE_TTL_SEC`         (default  10 / 60s)
 *
 * The in-memory store is intentional: a single API instance with a per-principal
 * tracker key needs no shared store, and the polling floor + idempotency dedup
 * make the limiter a best-effort backstop, not a correctness boundary.
 */
export function buildThrottlerOptions(): ThrottlerModuleOptions {
  return [
    {
      name: 'default',
      limit: positiveIntEnv(process.env.V1_RATE_DEFAULT_LIMIT, 120),
      ttl: seconds(positiveIntEnv(process.env.V1_RATE_DEFAULT_TTL_SEC, 60)),
    },
    {
      name: CREATE_THROTTLE_NAME,
      limit: positiveIntEnv(process.env.V1_RATE_CREATE_LIMIT, 10),
      ttl: seconds(positiveIntEnv(process.env.V1_RATE_CREATE_TTL_SEC, 60)),
    },
    {
      name: AUTH_THROTTLE_NAME,
      limit: positiveIntEnv(process.env.AUTH_RATE_LIMIT, 10),
      ttl: seconds(positiveIntEnv(process.env.AUTH_RATE_TTL_SEC, 60)),
    },
  ];
}

/**
 * Parse a positive-integer env override, falling back to `fallback` for an
 * absent / non-numeric / non-positive value so a bad config can never disable the
 * limiter (a `0`/negative/NaN limit would let every request through).
 */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
