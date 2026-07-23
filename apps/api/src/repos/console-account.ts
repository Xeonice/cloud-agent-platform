import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard';

/**
 * Repository WRITE authority: an authenticated human Console session.
 *
 * Deliberately not `repos:read`: API-key and MCP principals are rejected even
 * when they resolve to an account and carry that read scope, and the owner id
 * comes only from the session — never from a request body.
 *
 * Shared by every repository write surface (import, default-branch refresh,
 * content-copy refresh, local-path import) so they cannot drift apart.
 */
export function requireConsoleAccountId(req: AuthenticatedRequest): string {
  const principal = req.operatorPrincipal;
  if (principal?.kind !== 'session' || !principal.user?.id) {
    throw new ForbiddenException({
      error: 'session_operator_required',
      message: 'Repository import requires an authenticated Console session.',
    });
  }
  return principal.user.id;
}
