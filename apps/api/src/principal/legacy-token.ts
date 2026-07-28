/**
 * Legacy bearer-token support, as a principal concern.
 *
 * `isLegacyTokenEnabled` and the env-var name it reads lived in
 * `auth/auth-config.ts`. `operator-principal` needed them, which chained the
 * principal primitives to auth's config module — and through it, before this
 * change, all the way to mail. They are small and self-contained, so they live
 * with the principal that uses them.
 */
export const LEGACY_TOKEN_ENV = {
  AUTH_TOKEN: 'AUTH_TOKEN',
  AUTH_TOKEN_LEGACY_ENABLED: 'AUTH_TOKEN_LEGACY_ENABLED',
} as const;

/** True when the operator has explicitly opted the legacy bearer token in. */
export function isLegacyTokenEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[LEGACY_TOKEN_ENV.AUTH_TOKEN_LEGACY_ENABLED];
  if (typeof raw !== 'string') {
    return false;
  }
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}
