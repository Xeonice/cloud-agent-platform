import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Scope, SessionUser } from '@cap/contracts';
import { AuthSessionService } from './auth-session.service';
import {
  resolveOperatorPrincipal,
  type OperatorPrincipal,
} from './operator-principal';
import { SESSION_COOKIE_NAME, readCookie } from './session-token';

/**
 * Operator session guard (be-oauth-allowlist, task 2.6; supersedes the
 * shared-`AUTH_TOKEN`-only guard from single-user-auth 11.2).
 *
 * Enforces that every protected REST request carries a VALID operator principal
 * before the route handler runs. A request is admitted when EITHER:
 *   - it carries a valid GitHub-OAuth SESSION — resolved from the `cap_session`
 *     cookie OR a `bearer.<token>` subprotocol-carried token — whose owning user
 *     is STILL allowlisted (membership is RE-CONFIRMED at request time inside
 *     {@link AuthSessionService.resolveSession}, so a de-allowlisted operator is
 *     denied on their very next request); or
 *   - the legacy shared-`AUTH_TOKEN` operator bearer is presented AND the legacy
 *     path is enabled (task 2.8) — see {@link resolveOperatorPrincipal}.
 *
 * Anything else — missing/malformed credentials, an expired/revoked session, a
 * de-allowlisted user, or the legacy bearer while the legacy path is disabled —
 * is rejected with HTTP 401 (`UnauthorizedException`). The guard runs BEFORE the
 * route handler, so a rejected request never reaches business logic: NO state
 * change occurs on a denial.
 *
 * Connect-in sandbox callback exemption (migrate-execution-to-aio-sandbox, 5.5):
 * the `/v1/approvals` callback endpoint is ALSO exempt — but NOT because it is an
 * identity entry point. Under the connect-in model the per-task AIO sandbox's
 * baked Codex hook POSTs its approval/report callback IN to the orchestrator over
 * the private `cap-net` network. The sandbox is NOT a human operator and holds no
 * operator credential (neither a GitHub-OAuth session nor the legacy `AUTH_TOKEN`);
 * its security boundary is network isolation (reachable only by sibling sandbox
 * containers by container name on `cap-net`, which publish no host port), NOT an
 * operator principal. Gating it with this guard would 401 every hook callback and
 * deadlock the approval round-trip. See {@link ApprovalsController}.
 *
 * Trust-domain boundary (task 2.8): the legacy `AUTH_TOKEN` is a DISTINCT domain
 * from the runner `TASK_TOKEN` (which authenticates a sandbox dialling back, not
 * a human operator). A `TASK_TOKEN` presented as the operator bearer is simply a
 * non-matching `AUTH_TOKEN` and is rejected by the ordinary constant-time
 * comparison in {@link resolveOperatorPrincipal} — there is no special case that
 * would let it authenticate an operator.
 *
 * Exemptions (these ESTABLISH or probe identity rather than presenting one):
 *   - `/health` liveness so platform probes work without a credential;
 *   - the GitHub-OAuth entry points (`/auth/github/login`, `/auth/github/callback`)
 *     an unauthenticated operator must reach to obtain a session, plus
 *     `/auth/session` / `/auth/logout`, which read/clear the session cookie and
 *     return 401 on their own when there is no session.
 *
 * Plus the network-isolation exemption (NOT an identity probe): `/v1/approvals`,
 * the connect-in sandbox hook callback described above.
 *
 * Configuration is read at CHECK time, not module load, so the fail-closed
 * posture (e.g. `AUTH_ALLOWLIST` / `AUTH_TOKEN` unset) is evaluated against the
 * live environment on each request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authSession: AuthSessionService) {}

  /**
   * Request paths (lower-cased, slash-normalized) exempt from operator auth
   * because they expose only liveness / build-metadata / public API metadata and
   * carry NO secrets:
   *   - `/health` — the liveness probe (single-user-auth 11.2b);
   *   - `/version` — the unauthenticated build-version sibling of `/health`
   *     (versioned-release-pipeline, design D1) reporting
   *     `{ version, gitSha, buildTime }`. It is build metadata, so it needs no
   *     operator principal, exactly like `/health`.
   *   - `/v1/openapi.json` — the OpenAPI 3.1 document for the public `/v1`
   *     surface (public-v1-api, design D3 / task 4.3). It is read-only API
   *     metadata generated from the `@cap/contracts` schemas; it carries no
   *     secrets, so it needs no operator principal, exactly like `/version`.
   *   - `/v1/docs` — the interactive Swagger UI page that renders the document
   *     above (same rationale: read-only public API metadata, no secrets).
   * These two `/v1` exemptions are EXACT-MATCH (like `/version`): they exempt
   * ONLY the docs/spec endpoints. Every `/v1` DATA route (`/v1/tasks`,
   * `/v1/repos`, …) is NOT listed here and stays behind the operator guard, so an
   * unauthenticated caller is rejected with 401 before reaching any handler.
   * Kept in sync with the unauthenticated `/health` + `/version` endpoints and
   * the `OpenApiController` (`GET /v1/openapi.json` + `GET /v1/docs`).
   */
  private static readonly PUBLIC_METADATA_PATHS: readonly string[] = [
    '/health',
    '/version',
    '/v1/openapi.json',
    '/v1/docs',
  ];

  /**
   * Paths exempt because the caller is a connect-in AIO sandbox dialling back IN
   * over `cap-net`, NOT a human operator (migrate-execution-to-aio-sandbox, 5.5):
   *   - `/v1/approvals` — the baked Codex hook POSTs its approval/report callback
   *     to the orchestrator by container name on `cap-net`. The sandbox holds no
   *     operator credential; its security boundary is network isolation (no host
   *     port), so requiring an operator principal here would 401 every callback
   *     and deadlock the approval round-trip. See {@link ApprovalsController}.
   */
  private static readonly SANDBOX_EXEMPT_PATHS: readonly string[] = ['/v1/approvals'];

  /**
   * Paths exempt from the session guard because they ESTABLISH or resolve the
   * GitHub-OAuth operator session rather than presenting an operator principal
   * (be-oauth-allowlist, tasks 2.2–2.6):
   *   - `/auth/github/login` / `/auth/github/callback` — the OAuth round trip an
   *     unauthenticated operator must reach to obtain a session;
   *   - `/auth/session` / `/auth/logout` — read/clear the session cookie and
   *     enforce their own 401 when no session resolves.
   * Requiring an operator principal here would make login impossible. The
   * fail-closed allowlist gate inside the callback (not this guard) governs
   * admission; this guard protects the rest of the REST surface.
   */
  private static readonly OAUTH_EXEMPT_PATHS: readonly string[] = [
    '/auth/github/login',
    '/auth/github/callback',
    '/auth/session',
    '/auth/logout',
  ];

  /**
   * Paths exempt from the SESSION guard because the remote MCP surface
   * (`/mcp`) is bearer-protected DOWNSTREAM by the SDK `requireBearerAuth`
   * (remote-mcp-server, task 3.4 / D6), not by an operator session.
   *
   * The match is EXACT (`/mcp` only, not a `/mcp*` prefix — G8): a prefix
   * exemption would silently expose any future `/mcp…` route. `/mcp` itself
   * carries no operator session; an absent/invalid `mcp_` bearer is rejected
   * with 401 by `requireBearerAuth` (registered in `main.ts`, Track 7), so
   * removing it from the session guard does NOT open it — it merely hands the
   * gate to the MCP-token verifier. Every other path stays under the session
   * guard, where a presented `mcp_` bearer resolves (via the prefix-routed
   * {@link AuthSessionService.resolveMcpToken} slot of
   * {@link resolveOperatorPrincipal}) to an `mcp` MACHINE principal that a
   * session-only endpoint rejects.
   */
  private static readonly MCP_EXEMPT_PATHS: readonly string[] = ['/mcp'];

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (
      AuthGuard.isHealthCheck(request) ||
      AuthGuard.isOAuthEntryPoint(request) ||
      AuthGuard.isSandboxCallback(request) ||
      AuthGuard.isMcpEndpoint(request)
    ) {
      return true;
    }

    const principal = await resolveOperatorPrincipal(
      {
        sessionToken: AuthGuard.extractSessionToken(request),
        bearerToken: AuthGuard.extractBearerToken(request.headers.authorization),
      },
      {
        resolveSession: (token) => this.authSession.resolveSession(token),
        resolveApiKey: (raw) => this.authSession.resolveApiKey(raw),
        // Bind the reserved `mcp_` slot (remote-mcp-server, task 3.3): an `mcp_`
        // bearer presented to a NON-`/mcp` route resolves (hash → allowlist
        // re-check) to an `mcp` MACHINE principal carrying the token's scopes —
        // never tried as a session/legacy/api-key credential. `/mcp` itself is
        // exempt above and gated by `requireBearerAuth`; this binding makes an
        // `mcp_` token a recognised (but session-rejected) principal everywhere
        // else rather than a fail-closed denial.
        resolveMcp: async (raw) => {
          const authInfo = await this.authSession.resolveMcpToken(raw);
          if (authInfo === null) {
            return null;
          }
          return { kind: 'mcp', user: null, scopes: authInfo.scopes as Scope[] };
        },
      },
    );

    if (principal === null) {
      // Fail-closed: missing/malformed/expired/revoked/non-allowlisted, or the
      // legacy bearer while the legacy path is disabled. No state change.
      throw new UnauthorizedException('Operator authentication required');
    }

    // Attach the resolved principal for downstream handlers (e.g. per-user
    // scoping in later tracks). Never trusted from the client — set here only.
    (request as AuthenticatedRequest).operatorPrincipal = principal;
    return true;
  }

  /**
   * True when the request targets an unauthenticated public-metadata endpoint
   * (`/health` liveness or `/version` build metadata). See
   * {@link PUBLIC_METADATA_PATHS}.
   */
  private static isHealthCheck(request: Request): boolean {
    return AuthGuard.PUBLIC_METADATA_PATHS.includes(
      AuthGuard.normalizePath(request),
    );
  }

  /** True when the request targets a GitHub-OAuth session entry point. */
  private static isOAuthEntryPoint(request: Request): boolean {
    return AuthGuard.OAUTH_EXEMPT_PATHS.includes(AuthGuard.normalizePath(request));
  }

  /**
   * True when the request targets a connect-in AIO sandbox callback endpoint
   * (e.g. `/v1/approvals`), whose security boundary is `cap-net` network
   * isolation rather than an operator principal. See {@link SANDBOX_EXEMPT_PATHS}.
   */
  private static isSandboxCallback(request: Request): boolean {
    return AuthGuard.SANDBOX_EXEMPT_PATHS.includes(AuthGuard.normalizePath(request));
  }

  /**
   * True when the request targets the remote MCP endpoint (`/mcp`, EXACT match),
   * which is bearer-protected downstream by the SDK `requireBearerAuth` rather
   * than by the operator session. See {@link MCP_EXEMPT_PATHS}.
   */
  private static isMcpEndpoint(request: Request): boolean {
    return AuthGuard.MCP_EXEMPT_PATHS.includes(AuthGuard.normalizePath(request));
  }

  /**
   * Lower-cased, query-stripped, trailing-slash-normalized request path, so e.g.
   * `/health/` and `/Auth/Session?x=1` match their canonical exempt forms.
   */
  private static normalizePath(request: Request): string {
    // `path` excludes the query string; fall back to `url` for adapters that only
    // populate `url`.
    const rawPath = request.path ?? request.url ?? '';
    return rawPath.split('?')[0].replace(/\/+$/, '').toLowerCase();
  }

  /**
   * Reads the opaque GitHub-OAuth session token a REST request carries, from the
   * `cap_session` cookie. Returns `null` when no session cookie is present.
   */
  private static extractSessionToken(request: Request): string | null {
    return readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  }

  /**
   * Extracts the token from an `Authorization: Bearer <token>` header — the single
   * bearer slot that {@link resolveOperatorPrincipal} routes by token PREFIX
   * (api-key-machine-identity, task 4.3/4.4): a `cap_sk_` key, a reserved `mcp_`
   * credential, or (unprefixed) the gated legacy `AUTH_TOKEN` operator candidate
   * (task 2.8).
   *
   * Returns the token string when the header is exactly a `Bearer` scheme
   * followed by a single non-empty token, or `null` for a missing header, a
   * non-`Bearer` scheme, or a malformed value (no token, extra segments). The
   * scheme match is case-insensitive per RFC 7235; the token itself is compared
   * verbatim downstream.
   */
  private static extractBearerToken(header: string | undefined): string | null {
    if (header === undefined) {
      return null;
    }
    const parts = header.split(' ');
    if (parts.length !== 2) {
      return null;
    }
    const [scheme, token] = parts;
    if (scheme.toLowerCase() !== 'bearer' || token.length === 0) {
      return null;
    }
    return token;
  }
}

/** An Express request after the {@link AuthGuard} has attached the principal. */
export interface AuthenticatedRequest extends Request {
  operatorPrincipal?: OperatorPrincipal;
}

// Re-export for downstream consumers that only need the session-user shape.
export type { SessionUser };
