import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { constantTimeEqual } from './constant-time';

/**
 * Operator-auth guard (auth 11.2).
 *
 * Enforces that every protected REST request carries an
 * `Authorization: Bearer <token>` whose token matches the configured operator
 * token (`AUTH_TOKEN`). On a missing, malformed, or non-matching token it rejects
 * with HTTP 401 (`UnauthorizedException`) and performs NO state change — the guard
 * runs before the route handler, so a rejected request never reaches business
 * logic.
 *
 * Scope boundaries (kept deliberately narrow for this track):
 * - The unauthenticated `/health` liveness endpoint is exempt so platform probes
 *   (Fly, docker-compose) work without injecting the secret.
 * - This operator token is a DISTINCT trust domain from the runner `TASK_TOKEN`
 *   (which authenticates a sandbox dialling back, not a human operator). A
 *   per-task `TASK_TOKEN` presented here is simply a non-matching operator token
 *   and is rejected with 401 by the ordinary comparison — there is no special
 *   case that would let it through.
 * - Comparison is delegated to {@link constantTimeEqual} to avoid timing leaks.
 *
 * Intentionally NOT done here (owned by the integration track, Track 14):
 * - Registering this guard GLOBALLY across all REST endpoints (via `APP_GUARD` /
 *   `app.useGlobalGuards`) — that edits the shared bootstrap.
 * - Refusing to boot when `AUTH_TOKEN` is unset/empty — a bootstrap concern.
 * - Authenticating client WebSocket connections at connect time — that edits the
 *   shared realtime-terminal gateway.
 *
 * The guard reads `AUTH_TOKEN` from the process environment at check time. When it
 * is unset/empty there is no token any presented credential could match, so the
 * guard rejects every protected request with 401 (fail-closed) until the
 * refuse-to-boot bootstrap check (Track 14) makes an unconfigured token fatal.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /**
   * Request path (lower-cased, slash-normalized) exempt from operator auth.
   * Kept in sync with the `/health` liveness endpoint contract.
   */
  private static readonly HEALTH_PATH = '/health';

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (AuthGuard.isHealthCheck(request)) {
      return true;
    }

    const presented = AuthGuard.extractBearerToken(request.headers.authorization);
    if (presented === null) {
      // Missing header or malformed (non-`Bearer`) authorization.
      throw new UnauthorizedException('Missing or malformed operator bearer token');
    }

    const configured = process.env.AUTH_TOKEN;
    if (configured === undefined || configured.length === 0) {
      // Fail closed: with no configured token, nothing can authenticate. The
      // refuse-to-boot check (Track 14) turns this into a startup failure.
      throw new UnauthorizedException('Operator token is not configured');
    }

    if (!constantTimeEqual(presented, configured)) {
      throw new UnauthorizedException('Invalid operator bearer token');
    }

    return true;
  }

  /** True when the request targets the unauthenticated `/health` endpoint. */
  private static isHealthCheck(request: Request): boolean {
    // `path` excludes the query string; fall back to `url` for adapters that only
    // populate `url`. Trailing slashes are normalized so `/health/` also matches.
    const rawPath = request.path ?? request.url ?? '';
    const path = rawPath.split('?')[0].replace(/\/+$/, '').toLowerCase();
    return path === AuthGuard.HEALTH_PATH;
  }

  /**
   * Extracts the token from an `Authorization: Bearer <token>` header.
   *
   * Returns the token string when the header is exactly a `Bearer` scheme
   * followed by a single non-empty token, or `null` for a missing header, a
   * non-`Bearer` scheme, or a malformed value (no token, extra segments). The
   * scheme match is case-insensitive per RFC 7235; the token itself is compared
   * verbatim.
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
