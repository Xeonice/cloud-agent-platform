import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CREATE_THROTTLE_NAME } from './throttler.options';
import { principalTrackerKey } from './principal.throttler-guard';
import type { OperatorPrincipal } from '../auth/operator-principal';

/**
 * The ONE route the {@link CreateThrottleGuard} scopes its stricter task-admission
 * tier to: `POST /v1/tasks`. Kept as an explicit method+path pair (normalized the
 * same way {@link normalizeCreatePath} treats the incoming request) so the create
 * cap can NEVER silently spread to another route — every other request is skipped.
 */
const CREATE_THROTTLED_METHOD = 'POST';
const CREATE_THROTTLED_PATH = '/v1/tasks';

/**
 * Dedicated `create`-tier throttler guard for the task-admission endpoint
 * (`POST /v1/tasks`).
 *
 * This guard exists to FIX a production rate-limit regression: a vanilla
 * {@link ThrottlerGuard} iterates EVERY registered named tier on EVERY request,
 * and the {@link PrincipalThrottlerGuard} used to retain the `create` tier (10/60s)
 * alongside `default`. Because the `create` cap is tiny, that meant any authenticated
 * request — dashboard polling of `/auth/session`, `/metrics`, `/tasks`, etc. — was
 * counted against the per-principal `create` bucket and tripped 429 well before the
 * intended `default` cap. The `create` tier is supposed to bound ONLY task admission
 * (the v1-tasks controller opts `POST /v1/tasks` into it via
 * `@Throttle({ create: … })`), not general authenticated traffic.
 *
 * The fix mirrors {@link AuthThrottleGuard}: this guard (a) narrows
 * `this.throttlers` to the `create` tier ALONE in {@link onModuleInit}, and
 * (b) {@link shouldSkip}s every request that is not exactly `POST /v1/tasks`, so the
 * `create` cap lands on the task-creation route and nowhere else. The
 * {@link PrincipalThrottlerGuard} keeps `default` only; this guard keeps `create`
 * only; the {@link AuthThrottleGuard} keeps `auth` only — three disjoint global
 * guards that never double-count a request.
 *
 * The bucket is keyed PER-PRINCIPAL via the shared {@link principalTrackerKey}
 * (the same key the {@link PrincipalThrottlerGuard} uses), so the create cap is
 * per-credential — two distinct accounts behind one NAT each get their own admission
 * window, and a missing principal degrades to the default per-IP tracker rather than
 * failing open.
 */
@Injectable()
export class CreateThrottleGuard extends ThrottlerGuard {
  /**
   * Narrow this guard to enforce ONLY the {@link CREATE_THROTTLE_NAME} tier.
   *
   * `ThrottlerModule.forRoot` registers three named tiers (`default`, `create`,
   * `auth`) and a vanilla {@link ThrottlerGuard} iterates ALL of them on every
   * request. Three global throttler guards are registered (this one, the
   * {@link PrincipalThrottlerGuard}, and the {@link AuthThrottleGuard}); without
   * this filter THIS guard would also enforce `default`/`auth`. The principal guard
   * keeps `default` only, the auth guard keeps `auth` only, and this guard keeps
   * `create` only, so the three are disjoint and never double-count a request.
   */
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter(
      (tier) => tier.name === CREATE_THROTTLE_NAME,
    );
  }

  /**
   * Apply the `create` tier ONLY to `POST /v1/tasks`. Every other request — every
   * GET poll, every other POST — is skipped here so the stricter task-admission cap
   * never lands on general authenticated traffic (which the
   * {@link PrincipalThrottlerGuard}'s `default` tier governs instead). This is the
   * root-cause fix for the dashboard-polling 429s.
   */
  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    const { req } = this.getRequestResponse(context);
    const method =
      typeof req.method === 'string' ? req.method.toUpperCase() : '';
    return !(
      method === CREATE_THROTTLED_METHOD &&
      normalizeCreatePath(req) === CREATE_THROTTLED_PATH
    );
  }

  /**
   * Key the rate bucket on the resolved principal the auth guard attached, so the
   * create cap is per-CREDENTIAL, not per-IP — identical to the
   * {@link PrincipalThrottlerGuard} (it reuses the SAME {@link principalTrackerKey}).
   * Falls back to the default IP tracker when no principal is present.
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
 * Normalize a request's path for the `POST /v1/tasks` membership check: take the
 * path portion (drop any query string), strip a single trailing slash (except the
 * root), and lower-case it, so `/v1/tasks/` and `/v1/tasks` resolve the same.
 * Mirrors `normalizeAuthPath` in `auth-throttle.guard.ts`.
 */
function normalizeCreatePath(req: Record<string, unknown>): string {
  const raw =
    typeof req.url === 'string'
      ? req.url
      : typeof (req as { originalUrl?: unknown }).originalUrl === 'string'
        ? (req as { originalUrl: string }).originalUrl
        : '';
  const pathOnly = raw.split('?', 1)[0] ?? '';
  const trimmed =
    pathOnly.length > 1 && pathOnly.endsWith('/')
      ? pathOnly.slice(0, -1)
      : pathOnly;
  return trimmed.toLowerCase();
}
