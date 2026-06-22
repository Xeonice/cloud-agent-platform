import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { AUTH_THROTTLE_NAME } from './throttler.options';

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
 *   - any principal carrying a GitHub identity (a `session`, or an api-key whose
 *     owner id is known but with no keyId) → the owner's immutable GitHub id
 *     (`github:<githubId>`);
 *   - the legacy shared-`AUTH_TOKEN` operator (no GitHub identity, no key) → a
 *     stable per-kind sentinel (`kind:legacy-token`), so the single shared
 *     operator is one bucket rather than aliasing onto another principal.
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
   * Drop the pre-auth {@link AUTH_THROTTLE_NAME} tier from this guard so it
   * enforces ONLY the principal-keyed tiers (`default`, `create`).
   *
   * `ThrottlerModule.forRoot` registers three named tiers (`default`, `create`,
   * `auth`) and a vanilla {@link ThrottlerGuard} iterates ALL of them on every
   * request. Two global throttler guards are registered (this one and the
   * {@link AuthThrottleGuard}); without this filter THIS guard would also enforce
   * the tiny anonymous `auth` cap — keyed on the post-auth principal — on EVERY
   * authenticated route, throttling legitimate authenticated traffic far below
   * `default`. The {@link AuthThrottleGuard} keeps `auth` only (and applies it
   * solely to the pre-auth endpoints); this guard keeps everything BUT `auth`, so
   * the two are disjoint and never double-count a request.
   */
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter(
      (tier) => tier.name !== AUTH_THROTTLE_NAME,
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
  const githubId = principal.user?.githubId;
  if (githubId !== undefined && githubId !== null) {
    return `github:${githubId}`;
  }
  return `kind:${principal.kind}`;
}
