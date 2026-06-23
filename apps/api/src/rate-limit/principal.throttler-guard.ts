import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OperatorPrincipal } from '../auth/operator-principal';

/**
 * The single tier this guard enforces — the global per-request cap. The `create`
 * tier now belongs to `CreateThrottleGuard` and the `auth` tier to
 * `AuthThrottleGuard`, so this guard filters `this.throttlers` down to `default`
 * ALONE (see {@link PrincipalThrottlerGuard.onModuleInit}).
 */
const DEFAULT_THROTTLE_NAME = 'default';

/**
 * Per-principal request throttler guard (public-v1-api, Track `rate-limiting`,
 * task 6.1; spec `request-rate-limiting`).
 *
 * The SECOND global guard, registered AFTER the {@link AuthGuard} (global-guard
 * order = provider order in `app.module.ts`, design D7). Because it runs after
 * auth, the resolved {@link OperatorPrincipal} the auth guard attached as
 * `req.operatorPrincipal` is available, and this guard keys its rate bucket on
 * THAT principal — NOT the client IP. So two distinct credentials issuing from
 * the SAME IP (e.g. behind one NAT, or two api-keys from one host) get
 * INDEPENDENT buckets, and a per-IP DoS can't starve every principal behind a
 * shared egress.
 *
 * The per-principal tracker key (most-specific first):
 *   - an `api-key` principal → its immutable per-key id (`key:<keyId>`), so each
 *     api-key from one owner has its OWN bucket (a key, not the owner, is the
 *     rate axis for machine traffic);
 *   - any principal carrying a resolved user (a `session`, an OTP/password LOCAL
 *     account, or an api-key whose owner is known but with no keyId) → the user's
 *     immutable PRIMARY KEY (`user:<user.id>`). Keying on `user.id` rather than the
 *     GitHub id is what lets a LOCAL account (which has `githubId === null`) get its
 *     OWN bucket instead of collapsing every local account onto the shared
 *     `kind:session` sentinel;
 *   - the legacy shared-`AUTH_TOKEN` operator (no user, no key) → a stable per-kind
 *     sentinel (`kind:legacy-token`), so the single shared operator is one bucket
 *     rather than aliasing onto another principal.
 *
 * This guard enforces ONLY the per-request `default` tier. The stricter `create`
 * (task-admission) tier has been MOVED to the dedicated `CreateThrottleGuard`, which
 * applies it solely to `POST /v1/tasks` — so the small `create` cap no longer lands
 * on every authenticated request (dashboard polling of `/auth/session`, `/metrics`,
 * `/tasks`, …), which was tripping spurious 429s. See {@link onModuleInit}.
 *
 * Fail-safe: if no principal is attached (the auth guard would normally have
 * 401'd first, so this only happens for a guard-exempt route that still passes
 * through the throttler, or a wiring error), the guard falls back to the default
 * IP tracker — it never throws here, so a missing principal degrades to per-IP
 * limiting rather than failing open (no limit) or crashing the request.
 *
 * Registered as a global `APP_GUARD` by the Integration track alongside
 * `ThrottlerModule.forRoot(...)` (the in-memory store + env-overridable limits).
 */
@Injectable()
export class PrincipalThrottlerGuard extends ThrottlerGuard {
  /**
   * Narrow this guard to enforce ONLY the per-request `default` tier.
   *
   * `ThrottlerModule.forRoot` registers three named tiers (`default`, `create`,
   * `auth`) and a vanilla {@link ThrottlerGuard} iterates ALL of them on every
   * request. THREE global throttler guards are registered (this one, the
   * `CreateThrottleGuard`, and the {@link AuthThrottleGuard}); each narrows to a
   * single tier so they are disjoint and never double-count a request:
   *   - this guard keeps `default` only;
   *   - `CreateThrottleGuard` keeps `create` only (and applies it solely to
   *     `POST /v1/tasks`);
   *   - {@link AuthThrottleGuard} keeps `auth` only (and applies it solely to the
   *     pre-auth endpoints).
   *
   * Crucially, this guard no longer retains `create`. When it did, the small
   * `create` cap (10/60s) — keyed on the post-auth principal — was charged against
   * EVERY authenticated request (dashboard polling of `/auth/session`, `/metrics`,
   * `/tasks`, …), tripping spurious 429s long before the intended `default` cap.
   * The `create` tier now belongs exclusively to `CreateThrottleGuard`, which only
   * lets it fire on the task-creation route.
   */
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter(
      (tier) => tier.name === DEFAULT_THROTTLE_NAME,
    );
  }

  /**
   * Key the rate bucket on the resolved principal the auth guard attached, so the
   * limit is per-CREDENTIAL, not per-IP. Falls back to the default IP tracker
   * when no principal is present (see the class doc's fail-safe note).
   */
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const principal = req.operatorPrincipal as OperatorPrincipal | undefined;
    if (principal) {
      return Promise.resolve(principalTrackerKey(principal));
    }
    return super.getTracker(req);
  }
}

/**
 * The stable per-principal tracker key. Pure and exported so the rate-limit spec
 * can assert the keying axis directly without booting the guard. See the class
 * doc for the precedence rationale.
 */
export function principalTrackerKey(principal: OperatorPrincipal): string {
  if (principal.keyId) {
    return `key:${principal.keyId}`;
  }
  // Prefer the resolved user's PRIMARY KEY (`users.id`), which is present for BOTH
  // GitHub `session` principals AND local password/OTP accounts. A local account
  // carries `githubId === null`, so keying on the GitHub id would collapse every
  // local account onto the shared `kind:session` sentinel — one rate bucket for
  // all of them. Keying on `user.id` gives each account its OWN bucket.
  const userId = principal.user?.id;
  if (userId !== undefined && userId !== null) {
    return `user:${userId}`;
  }
  return `kind:${principal.kind}`;
}
