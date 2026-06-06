/**
 * GitHub-OAuth + session configuration readers (be-oauth-allowlist, tasks 2.2–2.5).
 *
 * Every value here is read from `process.env` AT RUNTIME (never captured at module
 * load) so the flow's fail-closed posture is evaluated against the live
 * environment on each request. The OAuth flow is the load-bearing control over
 * host-root task execution, so each reader either returns a fully-configured,
 * non-empty value or signals "unconfigured" — there is NO partial/defaulted
 * fallback that could silently weaken the gate.
 *
 * The pure parsing/normalisation here (no NestJS, no I/O) is unit-testable in
 * isolation; the verify phase exercises {@link readOAuthAppConfig} returning
 * `null` when credentials are missing and {@link readSessionSecret} failing
 * closed on an unset secret.
 */

/** Env var names, centralised so the controller/service/tests agree on spelling. */
export const ENV = {
  GITHUB_CLIENT_ID: 'GITHUB_CLIENT_ID',
  GITHUB_CLIENT_SECRET: 'GITHUB_CLIENT_SECRET',
  GITHUB_OAUTH_REDIRECT_URI: 'GITHUB_OAUTH_REDIRECT_URI',
  AUTH_ALLOWLIST: 'AUTH_ALLOWLIST',
  SESSION_SECRET: 'SESSION_SECRET',
  AUTH_TOKEN_LEGACY_ENABLED: 'AUTH_TOKEN_LEGACY_ENABLED',
  AUTH_TOKEN: 'AUTH_TOKEN',
} as const;

/** GitHub OAuth 2.0 endpoints (authorize / token / user). */
export const GITHUB_ENDPOINTS = {
  AUTHORIZE: 'https://github.com/login/oauth/authorize',
  TOKEN: 'https://github.com/login/oauth/access_token',
  USER: 'https://api.github.com/user',
} as const;

/**
 * Scopes requested at authorize time: `read:user` for the operator identity and
 * `repo` so a later `/user/repos` import (be-github-import) can enumerate the
 * operator's repositories. The space-joined value is what GitHub expects in the
 * `scope` query parameter.
 */
export const GITHUB_OAUTH_SCOPES = ['read:user', 'repo'] as const;
export const GITHUB_OAUTH_SCOPE_PARAM = GITHUB_OAUTH_SCOPES.join(' ');

/** The fully-resolved OAuth app credentials needed to run the authorization-code flow. */
export interface OAuthAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Registered redirect URI, when configured; GitHub falls back to the app default when absent. */
  readonly redirectUri: string | null;
}

/**
 * Reads the OAuth app credentials, FAILING CLOSED to `null` when either
 * `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is unset or empty. The flow MUST
 * NOT proceed (no authorize redirect, no code exchange) on a `null` result — this
 * is the "refuse to run the flow without OAuth credentials" boundary, never a
 * fall-back to unauthenticated or shared-token login.
 *
 * `redirectUri` is optional: GitHub uses the app's registered default when it is
 * absent, so an unset redirect does not by itself disable the flow.
 */
export function readOAuthAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): OAuthAppConfig | null {
  const clientId = nonEmpty(env[ENV.GITHUB_CLIENT_ID]);
  const clientSecret = nonEmpty(env[ENV.GITHUB_CLIENT_SECRET]);
  if (clientId === null || clientSecret === null) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    redirectUri: nonEmpty(env[ENV.GITHUB_OAUTH_REDIRECT_URI]),
  };
}

/**
 * Reads `SESSION_SECRET` (used to sign the anti-CSRF state cookie and as the
 * opaque-session HMAC key), returning `null` when unset/empty. Callers FAIL
 * CLOSED on `null`: an unsigned state cookie would let an attacker forge the
 * CSRF token, so the flow must not run without it.
 */
export function readSessionSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return nonEmpty(env[ENV.SESSION_SECRET]);
}

/**
 * Whether the legacy shared-`AUTH_TOKEN` operator path is enabled. Defaults to
 * `false` (the migration retires shared-token operator login); only an explicit
 * truthy string (`"true"`/`"1"`/`"yes"`, case-insensitive) turns it back on.
 * Task 2.8 consumes this; included here so the env contract lives in one place.
 */
export function isLegacyTokenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ENV.AUTH_TOKEN_LEGACY_ENABLED];
  if (typeof raw !== 'string') {
    return false;
  }
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** Returns a trimmed non-empty string, or `null` for undefined/blank input. */
function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
