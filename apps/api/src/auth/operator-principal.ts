/**
 * Operator-principal resolution.
 *
 * A single, transport-agnostic decision point for "is this request/connection a
 * valid operator (or machine principal), and if so who?". Both the REST session
 * guard and the WS handshake guard funnel through {@link resolveOperatorPrincipal}
 * so the two surfaces cannot drift on the security-critical questions:
 *
 *   1. an opaque SESSION token (cookie on REST, query-param or `bearer.<token>`
 *      subprotocol on WS) is the primary HUMAN credential. It is resolved by
 *      {@link AuthSessionService.resolveSession}, which re-confirms the owning
 *      user's DB `allowed` flag at resolution time.
 *   2. the legacy shared `AUTH_TOKEN` operator bearer is accepted ONLY when
 *      `AUTH_TOKEN_LEGACY_ENABLED` is on (2.8), compared in CONSTANT TIME, and is
 *      a DISTINCT trust domain from the runner `TASK_TOKEN` — a `TASK_TOKEN`
 *      presented here is just a non-matching operator token and is rejected by
 *      the ordinary comparison (there is no special case admitting it).
 *   3. an API-key (`cap_sk_…`) MACHINE credential, resolved by the injected
 *      api-key resolver, which hashes → looks up → rejects revoked/expired →
 *      re-confirms the owner's DB `allowed` flag, yielding the owner + the
 *      key's granted scopes (api-key-machine-identity, task 4.1/4.3).
 *   4. a reserved `mcp_…` MACHINE slot, routed to an injected MCP resolver that
 *      DENIES until the MCP track binds it (task 4.3) — reserving the prefix
 *      without creating any dependency on that track being present.
 *
 * Token-prefix dispatch (D1) is the FIRST step: the presented bearer is routed by
 * its public, non-secret PREFIX before any session lookup runs, so each of the
 * four domains is reachable by exactly one prefix on BOTH transports and a
 * credential of one domain is never tried against another domain's resolver. The
 * WS channel supplies the same presented token to both the session and bearer
 * candidates; placing dispatch at the very top is what guarantees a `cap_sk_`/
 * `mcp_` token there never falls into the `Session` table lookup.
 *
 * The decision is pure with respect to its inputs: the caller supplies the
 * resolved session-token + bearer candidates and the resolvers, so this module
 * captures NO transport details and NO `process.env` directly. The verify phase
 * can unit-test it with stub resolvers and an explicit env, and confirm: prefix
 * dispatch never hits the session lookup, session admit, disabled-user denial,
 * legacy-on admit, legacy-off denial, `TASK_TOKEN`-as-operator denial, api-key
 * admit/deny, and the reserved-mcp deny.
 */

import type { Scope, SessionUser } from '@cap/contracts';
import { CREDENTIAL_PREFIX } from '@cap/contracts';
import { constantTimeEqual } from './constant-time';
import { ENV, isLegacyTokenEnabled } from './auth-config';

/**
 * How a request/connection was authenticated:
 *   - `'session'`     — the HUMAN console session identity;
 *   - `'legacy-token'`— the shared `AUTH_TOKEN` operator (only reachable when the
 *                       legacy path is enabled);
 *   - `'api-key'`     — a `cap_sk_…` per-user MACHINE credential (a key resolves to
 *                       its owner + the key's granted scopes);
 *   - `'mcp'`         — RESERVED for the MCP machine-identity track; no credential
 *                       resolves to this kind until that track binds its resolver.
 * There is intentionally no member for a runner `TASK_TOKEN`: a task token is
 * never an operator.
 */
export type PrincipalKind = 'session' | 'legacy-token' | 'api-key' | 'mcp';

/** A successfully-authenticated operator (or machine) principal. */
export interface OperatorPrincipal {
  readonly kind: PrincipalKind;
  /**
   * The resolved owner for a session, API key, or MCP token; `null` only for the
   * legacy shared-token operator, which has no account identity attached.
   */
  readonly user: SessionUser | null;
  /**
   * Authorization scopes carried by the principal, when it is a SCOPED machine
   * credential (an API key's granted scopes). `undefined` for session/legacy
   * principals, which carry NO scopes and are therefore treated as ALLOW-ALL by
   * {@link hasScope} (task 4.5) — preserving existing behaviour exactly.
   */
  readonly scopes?: Scope[];
  /** The API-key id for an `'api-key'` principal; `undefined` otherwise. */
  readonly keyId?: string;
}

/**
 * Resolves a presented raw API key into its owner + granted scopes, or `null`
 * when nothing authenticates. Bound by the caller to
 * {@link AuthSessionService.resolveApiKey}.
 */
export type ApiKeyResolver = (
  raw: string,
) => Promise<{ user: SessionUser; scopes: Scope[]; keyId: string } | null>;

/**
 * Resolves a presented raw `mcp_…` credential, or `null` to DENY. The default
 * ({@link denyMcpResolver}) always denies; the MCP track injects a real resolver
 * later. A `null` from this resolver is a fail-closed denial of the request.
 */
export type McpResolver = (raw: string) => Promise<OperatorPrincipal | null>;

/**
 * The default reserved-`mcp_` resolver: always DENIES (returns `null`). Until the
 * MCP machine-identity track binds a real resolver, every `mcp_…` credential is
 * rejected — the prefix is reserved but inert, creating no dependency on that
 * track being present (multi-user-oauth: "Reserved MCP credential slot denies
 * until bound").
 */
export const denyMcpResolver: McpResolver = async () => null;

/**
 * The credentials extracted from a request/connection, normalised so this module
 * is transport-agnostic.
 *
 * - `sessionToken`: the opaque SESSION token, from the REST cookie or
 *   the WS `?token=` query / `bearer.<token>` subprotocol. `null` when absent.
 *   Used ONLY by the unprefixed session path; a reserved-prefix bearer never
 *   reaches it (dispatch returns first), so a `cap_sk_`/`mcp_` token presented on
 *   the WS channel — where it also fills this slot — is never tried as a session.
 * - `bearerToken`: the SINGLE bearer slot — the token presented in an
 *   `Authorization: Bearer` header (REST) or as the WS channel token. `null` when
 *   absent. Its PREFIX is the routing key (D1): `cap_sk_` → api-key resolver only,
 *   `mcp_` → reserved MCP resolver only, anything else → the gated constant-time
 *   legacy `AUTH_TOKEN` compare. It is NEVER tried as a session token, and the
 *   session token is NEVER tried as the bearer, so the trust domains stay
 *   distinct.
 */
export interface OperatorCredentials {
  readonly sessionToken: string | null;
  readonly bearerToken: string | null;
}

/**
 * The resolvers a caller injects so this module performs NO I/O itself: the
 * session resolver re-confirms DB allowed + expiry; the api-key resolver does the
 * same for a `cap_sk_` key; the MCP resolver defaults to DENY when the MCP track
 * is absent.
 */
export interface OperatorResolvers {
  readonly resolveSession: (token: string) => Promise<SessionUser | null>;
  readonly resolveApiKey: ApiKeyResolver;
  /** Defaults to {@link denyMcpResolver} when the caller omits it. */
  readonly resolveMcp?: McpResolver;
}

/**
 * Resolves a presented set of {@link OperatorCredentials} into an
 * {@link OperatorPrincipal}, or `null` when nothing authenticates.
 *
 * Order of evaluation:
 *   0. TOKEN-PREFIX DISPATCH (FIRST, D1). If the bearer carries a reserved prefix
 *      it is routed to EXACTLY ONE domain and resolution returns its result (or a
 *      fail-closed `null`) WITHOUT ever touching the session path:
 *        - `cap_sk_` → the api-key resolver only;
 *        - `mcp_`    → the reserved MCP resolver only (denies until bound).
 *      The prefix is a non-secret routing decision; each domain still performs its
 *      own hash-lookup / constant-time compare, so dispatch leaks nothing.
 *   1. SESSION. Otherwise, if a session token is present, resolve it via
 *      `resolveSession` (which re-confirms DB allowed membership). On a
 *      `SessionUser` we admit immediately as a `'session'` principal.
 *   2. LEGACY. Otherwise, if an (unprefixed) bearer is present AND
 *      `AUTH_TOKEN_LEGACY_ENABLED` is on AND `AUTH_TOKEN` is configured non-empty,
 *      accept it iff it matches in CONSTANT TIME. With the legacy path disabled
 *      (the default) this step is skipped, so the operator bearer is rejected.
 *   3. Otherwise deny (`null`).
 *
 * The session is tried before the gated legacy bearer, but a session that does
 * NOT resolve does not by itself fail the request: the gated legacy bearer (when
 * supplied and enabled) is still considered. This unifies the two call sites:
 *   - REST passes the session cookie and the `Authorization` bearer as two
 *     distinct credentials;
 *   - the WS handshake carries ONE credential and passes it as both candidates,
 *     so a valid legacy `AUTH_TOKEN` is accepted there even though it is first
 *     (correctly) rejected as a session token.
 *
 * A `null` return is a fail-closed denial: the caller rejects with 401 (REST) /
 * closes the socket (WS) and performs no state change.
 */
export async function resolveOperatorPrincipal(
  credentials: OperatorCredentials,
  resolvers: OperatorResolvers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorPrincipal | null> {
  const bearer = credentials.bearerToken;

  // 0. TOKEN-PREFIX DISPATCH — the FIRST step (D1). A reserved-prefix bearer is
  //    routed to EXACTLY ONE domain and NEVER falls through to the session path,
  //    so a `cap_sk_`/`mcp_` token (incl. on the WS channel, where it also fills
  //    `sessionToken`) never produces a `Session` table lookup. The prefix is a
  //    public, non-secret routing decision — it leaks nothing.
  if (typeof bearer === 'string' && bearer.length > 0) {
    if (bearer.startsWith(CREDENTIAL_PREFIX.API_KEY)) {
      const resolved = await resolvers.resolveApiKey(bearer);
      if (resolved === null) {
        return null;
      }
      return {
        kind: 'api-key',
        user: resolved.user,
        scopes: resolved.scopes,
        keyId: resolved.keyId,
      };
    }
    if (bearer.startsWith(CREDENTIAL_PREFIX.MCP)) {
      const resolveMcp = resolvers.resolveMcp ?? denyMcpResolver;
      return resolveMcp(bearer);
    }
  }

  // 1. Session-first (for an UNPREFIXED credential). A valid, still-enabled
  //    session is authoritative.
  const sessionToken = credentials.sessionToken;
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const user = await resolvers.resolveSession(sessionToken);
    if (user !== null) {
      return { kind: 'session', user };
    }
    // Session did not resolve: do NOT admit on the session domain, but fall
    // through to consider the gated legacy bearer below.
  }

  // 2. Legacy shared-token operator bearer, gated by AUTH_TOKEN_LEGACY_ENABLED.
  //    Reached only for an UNPREFIXED bearer (reserved prefixes returned in step
  //    0), so the legacy compare runs against the same candidate as before.
  if (typeof bearer === 'string' && bearer.length > 0 && isLegacyTokenEnabled(env)) {
    const configured = env[ENV.AUTH_TOKEN];
    if (typeof configured === 'string' && configured.length > 0) {
      // Constant-time comparison. A runner TASK_TOKEN presented here is simply a
      // non-matching operator token and fails this comparison — no special case.
      if (constantTimeEqual(bearer, configured)) {
        return { kind: 'legacy-token', user: null };
      }
    }
  }

  // 3. Nothing authenticated -> fail closed.
  return null;
}

/**
 * Scope gate (api-key-machine-identity, task 4.5). Returns `true` iff `principal`
 * is permitted the operation requiring scope `required`.
 *
 * A principal that carries NO scopes (`scopes === undefined` — every `'session'`
 * and `'legacy-token'` principal) is ALLOW-ALL: it passes every gate, so existing
 * human/legacy behaviour is unchanged (G9). A scoped principal (an `'api-key'`)
 * passes ONLY when its granted scopes include `required`; otherwise the caller
 * rejects with 403 (insufficient scope), distinct from the 401 for an
 * absent/invalid credential.
 *
 * `principal` accepts `undefined` so route handlers can pass the post-guard
 * `AuthenticatedRequest.operatorPrincipal` (typed optional because the property
 * is only attached by {@link AuthGuard}) without a non-null assertion: an absent
 * principal carries no scopes and is treated as ALLOW-ALL, identical to the
 * scopeless case. (In practice a scoped route only runs behind the guard, so the
 * principal is present at runtime.)
 */
export function hasScope(
  principal: OperatorPrincipal | undefined,
  required: Scope,
): boolean {
  if (principal?.scopes === undefined) {
    return true; // no principal / no scopes carried -> allow-all (session / legacy).
  }
  return principal.scopes.includes(required);
}
