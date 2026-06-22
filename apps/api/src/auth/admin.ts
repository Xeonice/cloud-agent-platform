/**
 * Admin gate (self-update-action, design D2 — operator-admin-only).
 *
 * Auth has NO admin concept today: an allowlisted operator is an operator, full
 * stop. Self-update is the most dangerous surface in the OSS self-update epic — a
 * button that runs host-root container ops ("who can press it" == "who can run as
 * root on the host") — so it needs the NARROWEST principal available, an
 * explicitly-allowlisted ADMIN, not merely any logged-in operator.
 *
 * This module is SELF-CONTAINED on purpose (rather than editing
 * `operator-principal.ts`): it adds a separate, fail-closed env allowlist of admin
 * GitHub numeric ids (`SELF_UPDATE_ADMINS`) and a pure predicate over a resolved
 * {@link OperatorPrincipal}. It reuses the same numeric-id allowlist parsing as the
 * primary auth gate ({@link parseAllowlist}/{@link isAllowlisted} in `allowlist.ts`)
 * so the admin set and the login allowlist key on the SAME immutable `githubId`
 * and share the SAME fail-closed semantics (unset / empty / unparseable → admits
 * no one).
 *
 * Like the login gate, the env is read AT CHECK TIME (never captured at module
 * load) so the default-deny posture is evaluated against the live environment.
 * The predicate is pure (the caller supplies the raw env value), so the verify
 * phase can unit-test admit / non-admin denial / unset-denies-all directly.
 */

import { isAllowlistedRaw } from './allowlist';
import type { OperatorPrincipal } from './operator-principal';

/**
 * The env var naming the comma-separated GitHub NUMERIC ids permitted to trigger
 * a self-update (design D2). DISTINCT from `AUTH_ALLOWLIST` (who can log in): this
 * is the narrower set of those operators ALSO trusted to press the host-root
 * upgrade button. Default unset → no admins → self-update is admin-refused even
 * when `SELF_UPDATE_ENABLED` is on.
 */
export const SELF_UPDATE_ADMINS_ENV = 'SELF_UPDATE_ADMINS';

/**
 * Whether `githubId` is a self-update ADMIN per the raw `SELF_UPDATE_ADMINS`
 * value. FAIL-CLOSED via {@link isAllowlistedRaw}: an unset / empty / unparseable
 * list admits no one. Matches on the immutable numeric id, never the mutable
 * login.
 */
export function isAdminGithubId(
  githubId: number,
  rawAdmins: string | undefined,
): boolean {
  return isAllowlistedRaw(githubId, rawAdmins);
}

/**
 * Whether a resolved {@link OperatorPrincipal} is a self-update admin, evaluated
 * against the live `SELF_UPDATE_ADMINS` env (read at check time).
 *
 * FAIL-CLOSED rules:
 *   - a `null` principal (unauthenticated — the guard should have rejected first)
 *     is NEVER an admin;
 *   - a `'legacy-token'` principal has NO GitHub identity (`user === null`), so it
 *     can never be matched against the numeric-id admin set → never an admin. The
 *     host-root button requires a NAMED admin identity, not the shared bearer.
 *   - a `'session'` principal is an admin iff its immutable `githubId` is on the
 *     admin allowlist.
 */
export function isAdminPrincipal(
  principal: OperatorPrincipal | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!principal || principal.user === null) {
    return false;
  }
  // A LOCAL account (password/OTP) has no GitHub identity
  // (add-private-account-identity), so it can never appear on the NUMERIC
  // `SELF_UPDATE_ADMINS` github-id set this break-glass gate matches on → never
  // an admin here. (Console role-based admin is a separate gate; this one stays
  // strictly the numeric-github-id self-update allowlist.)
  if (principal.user.githubId === null) {
    return false;
  }
  return isAdminGithubId(principal.user.githubId, env[SELF_UPDATE_ADMINS_ENV]);
}
