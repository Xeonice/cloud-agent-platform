/**
 * Admin gate for host-root and instance-level operations.
 *
 * The account system now has an explicit `role` field. Dangerous operator
 * actions use that DB-backed role instead of a GitHub-id env gate, so
 * self-hosted local accounts can administer the instance without any GitHub
 * login integration.
 */
import type { OperatorPrincipal } from './operator-principal';

/**
 * Whether a resolved {@link OperatorPrincipal} is an admin.
 *
 * FAIL-CLOSED rules:
 *   - a `null` principal (unauthenticated — the guard should have rejected first)
 *     is NEVER an admin;
 *   - a machine or legacy principal is never an admin;
 *   - a session principal is an admin iff its user is enabled and has
 *     `role === "admin"`.
 */
export function isAdminPrincipal(
  principal: OperatorPrincipal | null | undefined,
): boolean {
  if (!principal || principal.kind !== 'session' || principal.user === null) {
    return false;
  }
  return principal.user.allowed === true && principal.user.role === 'admin';
}
