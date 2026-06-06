/**
 * Operator-principal resolution (be-oauth-allowlist, tasks 2.6 / 2.7 / 2.8).
 *
 * A single, transport-agnostic decision point for "is this request/connection a
 * valid operator, and if so who?". Both the REST session guard (2.6) and the WS
 * handshake guard (2.7) funnel through {@link resolveOperatorPrincipal} so the
 * two surfaces cannot drift on the security-critical questions:
 *
 *   1. an opaque GitHub-OAuth SESSION token (cookie on REST, query-param or
 *      `bearer.<token>` subprotocol on WS) is the primary credential. It is
 *      resolved by {@link AuthSessionService.resolveSession}, which RE-CONFIRMS
 *      allowlist membership at resolution time — so a de-allowlisted operator is
 *      denied on their very next request/connect (the membership re-check stays a
 *      property of the session service, exercised here through the injected
 *      resolver).
 *   2. the legacy shared `AUTH_TOKEN` operator bearer is accepted ONLY when
 *      `AUTH_TOKEN_LEGACY_ENABLED` is on (2.8), compared in CONSTANT TIME, and is
 *      a DISTINCT trust domain from the runner `TASK_TOKEN` — a `TASK_TOKEN`
 *      presented here is just a non-matching operator token and is rejected by
 *      the ordinary comparison (there is no special case admitting it).
 *
 * The decision is pure with respect to its inputs: the caller supplies the
 * resolved session-token + legacy-bearer candidates and a session resolver, so
 * this module captures NO transport details and NO `process.env` directly. The
 * verify phase can unit-test it with a stub resolver and an explicit env, and
 * confirm: session admit, de-allowlisted denial, legacy-on admit, legacy-off
 * denial, and `TASK_TOKEN`-as-operator denial.
 */

import type { SessionUser } from '@cap/contracts';
import { constantTimeEqual } from './constant-time';
import { ENV, isLegacyTokenEnabled } from './oauth-config';

/**
 * How a request/connection was authenticated. `'session'` is the GitHub-OAuth
 * operator identity; `'legacy-token'` is the shared `AUTH_TOKEN` operator (only
 * reachable when the legacy path is enabled). There is intentionally no member
 * for a runner `TASK_TOKEN`: a task token is never an operator.
 */
export type PrincipalKind = 'session' | 'legacy-token';

/** A successfully-authenticated operator principal. */
export interface OperatorPrincipal {
  readonly kind: PrincipalKind;
  /**
   * The resolved session user for a `'session'` principal; `null` for the
   * legacy shared-token operator (which has no GitHub identity attached).
   */
  readonly user: SessionUser | null;
}

/**
 * The credentials extracted from a request/connection, normalised so this
 * module is transport-agnostic.
 *
 * - `sessionToken`: the opaque GitHub-OAuth session token, from the REST cookie
 *   or the WS `?token=` query / `bearer.<token>` subprotocol. `null` when absent.
 * - `legacyBearerToken`: the token presented in an `Authorization: Bearer`
 *   header (REST) or as the legacy operator bearer (WS). `null` when absent.
 *   This is the candidate the gated constant-time `AUTH_TOKEN` comparison runs
 *   against; it is NEVER tried as a session token, and the session token is
 *   NEVER tried as the legacy bearer, so the two trust domains stay distinct.
 */
export interface OperatorCredentials {
  readonly sessionToken: string | null;
  readonly legacyBearerToken: string | null;
}

/**
 * Resolves a presented set of {@link OperatorCredentials} into an
 * {@link OperatorPrincipal}, or `null` when nothing authenticates.
 *
 * Order of evaluation (session-FIRST; legacy is a gated fallback):
 *   1. If a session token is present, resolve it via `resolveSession`. The
 *      resolver returns `null` for an absent/unknown/expired/revoked token OR a
 *      now-de-allowlisted user (allowlist RE-CONFIRMED at request time). On a
 *      `SessionUser` we admit immediately as a `'session'` principal.
 *   2. Otherwise (no session token, or the session did not resolve), if a legacy
 *      bearer is present AND `AUTH_TOKEN_LEGACY_ENABLED` is on AND `AUTH_TOKEN`
 *      is configured non-empty, accept it iff it matches in CONSTANT TIME. With
 *      the legacy path disabled (the default) this step is skipped entirely, so
 *      the operator bearer is rejected.
 *   3. Otherwise deny (`null`).
 *
 * The session is always tried first, but a session that does NOT resolve does not
 * by itself fail the request: the gated legacy bearer (when supplied and enabled)
 * is still considered. This unifies the two call sites:
 *   - REST passes the session cookie and the `Authorization` bearer as two
 *     distinct credentials;
 *   - the WS handshake carries ONE credential on one channel and passes it as
 *     both candidates, so a valid legacy `AUTH_TOKEN` is accepted there even
 *     though it is first (correctly) rejected as a session token.
 * The legacy path being opt-in (off by default) and constant-time keeps this
 * fallback safe.
 *
 * A `null` return is a fail-closed denial: the caller rejects with 401 (REST) /
 * closes the socket (WS) and performs no state change.
 */
export async function resolveOperatorPrincipal(
  credentials: OperatorCredentials,
  resolveSession: (token: string) => Promise<SessionUser | null>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorPrincipal | null> {
  // 1. Session-first. A valid, still-allowlisted session is authoritative.
  const sessionToken = credentials.sessionToken;
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const user = await resolveSession(sessionToken);
    if (user !== null) {
      return { kind: 'session', user };
    }
    // Session did not resolve: do NOT admit on the session domain, but fall
    // through to consider the gated legacy bearer below.
  }

  // 2. Legacy shared-token operator bearer, gated by AUTH_TOKEN_LEGACY_ENABLED.
  const legacy = credentials.legacyBearerToken;
  if (typeof legacy === 'string' && legacy.length > 0 && isLegacyTokenEnabled(env)) {
    const configured = env[ENV.AUTH_TOKEN];
    if (typeof configured === 'string' && configured.length > 0) {
      // Constant-time comparison. A runner TASK_TOKEN presented here is simply a
      // non-matching operator token and fails this comparison — no special case.
      if (constantTimeEqual(legacy, configured)) {
        return { kind: 'legacy-token', user: null };
      }
    }
  }

  // 3. Nothing authenticated -> fail closed.
  return null;
}
