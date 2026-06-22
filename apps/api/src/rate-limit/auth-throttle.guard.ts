import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AUTH_THROTTLE_NAME } from './throttler.options';

/**
 * The public, pre-authentication auth endpoints this guard scopes its IP+email
 * brute-force tier to. Kept in one place so the throttle surface and the auth
 * guard's `OAUTH_EXEMPT_PATHS` cannot silently drift: every path here is an
 * unauthenticated POST that mints/changes a credential, so it is exactly the set
 * that must be brute-force throttled WITHOUT a resolved principal. Normalized
 * (no trailing slash, lower-cased) the same way {@link normalizeAuthPath} treats
 * the incoming request path.
 *
 * NOTE: `/auth/password` and `/auth/change-password` are listed for completeness
 * — the password-auth track owns those controllers — so the moment those routes
 * exist they are throttled with no further wiring. Routes that do not yet exist
 * simply never match, so listing them is inert until then.
 */
const AUTH_THROTTLED_PATHS: readonly string[] = [
  '/auth/password',
  '/auth/otp/request',
  '/auth/otp/verify',
  '/auth/change-password',
];

/**
 * Anonymous brute-force throttler guard for the PUBLIC, pre-authentication auth
 * endpoints (add-private-account-identity, track `rate-limit-auth`, task 8.2;
 * spec `request-rate-limiting` — "Anonymous brute-force throttle on pre-auth auth
 * endpoints").
 *
 * The endpoints this guards — password login, OTP request, OTP verify, and
 * change-password attempts — run BEFORE a principal is resolved (they are in
 * `OAUTH_EXEMPT_PATHS`), so the global {@link PrincipalThrottlerGuard} has no
 * `req.operatorPrincipal` to key on and would lump every anonymous attempt into a
 * single shared per-IP bucket. This guard instead keys its bucket on the client
 * IP COMBINED WITH the submitted email, so:
 *
 *   - a single attacker (one IP) cannot brute-force a password or mass-issue OTP
 *     codes for a victim email — repeated attempts for the SAME `ip|email` pair
 *     trip the cap (this is IN ADDITION to the per-email OTP resend cooldown the
 *     OTP service enforces, a separate mechanism);
 *   - the decision never depends on a resolved principal — there isn't one yet —
 *     it is derived purely from request attributes (IP + body email).
 *
 * The IP component comes from the framework's own tracker resolution
 * (`super.getTracker`), so it honors any configured proxy/`trust proxy` handling
 * exactly as the default limiter does. The email is normalized (trimmed +
 * lower-cased) so trivial `Foo@x.com ` / `foo@x.com` variants share one bucket
 * rather than each minting a fresh window. When no email is present on the body
 * (e.g. a change-password attempt that omits it) the email component degrades to
 * a stable sentinel so the IP still meaningfully buckets the request — it never
 * fails open into an unlimited path.
 *
 * This guard intentionally keys EVERY tier it is asked to enforce on IP+email; it
 * is meant to be applied only to the auth routes (via the `auth` named throttle
 * tier — see {@link AUTH_THROTTLE_NAME} in `throttler.options.ts`). Its
 * registration (global `APP_GUARD` ordering / the `@Throttle({ auth: … })` opt-in
 * on the auth controllers) is wired by the integration track (10.1) so this track
 * stays file-disjoint.
 */
@Injectable()
export class AuthThrottleGuard extends ThrottlerGuard {
  /**
   * Narrow this guard to enforce ONLY the {@link AUTH_THROTTLE_NAME} tier.
   *
   * `ThrottlerModule.forRoot` registers three named tiers (`default`, `create`,
   * `auth`) and a vanilla {@link ThrottlerGuard} iterates ALL of them on every
   * request. Two global throttler guards are registered (this one and the
   * {@link PrincipalThrottlerGuard}); without this filter BOTH would enforce all
   * three tiers, double-counting and — worse — imposing the tiny `auth` cap on
   * authenticated traffic via the principal guard. The principal guard keeps
   * `default`/`create`; this guard keeps `auth` only, so the two are disjoint.
   */
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter(
      (tier) => tier.name === AUTH_THROTTLE_NAME,
    );
  }

  /**
   * Apply the IP+email tier ONLY to the public pre-auth endpoints
   * ({@link AUTH_THROTTLED_PATHS}). Every other route is skipped here so the
   * `auth` cap never lands on authenticated traffic — those routes are throttled
   * per-principal by the {@link PrincipalThrottlerGuard} instead.
   */
  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    const { req } = this.getRequestResponse(context);
    return !AUTH_THROTTLED_PATHS.includes(normalizeAuthPath(req));
  }

  /**
   * Key the rate bucket on client IP + submitted email rather than on a
   * principal (there is none pre-auth). The IP part reuses the framework's
   * resolution so proxy handling matches the default limiter.
   */
  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const ip = await super.getTracker(req);
    const email = extractEmail(req);
    return authThrottleTrackerKey(ip, email);
  }
}

/**
 * Normalize a request's path for the {@link AUTH_THROTTLED_PATHS} membership
 * check: take the path portion (drop any query string), strip a single trailing
 * slash (except the root), and lower-case it, so `/auth/OTP/request/` and
 * `/auth/otp/request` resolve to the same throttled route.
 */
function normalizeAuthPath(req: Record<string, unknown>): string {
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

/**
 * Pull a usable email off the request body for keying. Returns `undefined` when
 * the body carries no non-empty string email (the caller substitutes a sentinel),
 * so a malformed/absent body can never crash the tracker.
 */
function extractEmail(req: Record<string, unknown>): string | undefined {
  const body = req.body;
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const raw = (body as Record<string, unknown>).email;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The stable per-(IP, email) tracker key. Pure and exported so the rate-limit
 * spec can assert the keying axis directly without booting the guard (mirrors
 * `principalTrackerKey`). The email is lower-cased so case variants of the same
 * address share one bucket; an absent email degrades to a `-` sentinel so the IP
 * component still buckets the request.
 */
export function authThrottleTrackerKey(
  ip: string,
  email: string | undefined,
): string {
  const normalizedEmail = email !== undefined ? email.toLowerCase() : '-';
  return `ip:${ip}|email:${normalizedEmail}`;
}
