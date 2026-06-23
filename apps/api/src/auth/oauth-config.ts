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

import { isSmtpConfigured, type DbSmtpConfigResolver } from '../mail/mail.service';

/** Env var names, centralised so the controller/service/tests agree on spelling. */
export const ENV = {
  GITHUB_CLIENT_ID: 'GITHUB_CLIENT_ID',
  GITHUB_CLIENT_SECRET: 'GITHUB_CLIENT_SECRET',
  GITHUB_OAUTH_REDIRECT_URI: 'GITHUB_OAUTH_REDIRECT_URI',
  AUTH_ALLOWLIST: 'AUTH_ALLOWLIST',
  SESSION_SECRET: 'SESSION_SECRET',
  AUTH_TOKEN_LEGACY_ENABLED: 'AUTH_TOKEN_LEGACY_ENABLED',
  AUTH_TOKEN: 'AUTH_TOKEN',
  WEB_ORIGIN: 'WEB_ORIGIN',
  SESSION_COOKIE_DOMAIN: 'SESSION_COOKIE_DOMAIN',
  /**
   * Disables the email+password login METHOD when set to an explicit falsy value
   * (add-private-account-identity, task 2.8 / D11). Password auth is ON by default
   * (the default admin is always seeded with a password identity), so the flag is
   * `true` unless the operator explicitly turns it off.
   */
  PASSWORD_AUTH_ENABLED: 'PASSWORD_AUTH_ENABLED',
  /**
   * SMTP host (task 5.1: `SMTP_HOST/PORT/USER/PASS/FROM`). Its presence is the
   * proxy for "SMTP configured" — the email-OTP login method is only advertised
   * (and only works) when a host is configured (task 2.8 / D11 `otpAuthEnabled =
   * SMTP configured`).
   */
  SMTP_HOST: 'SMTP_HOST',
} as const;

/** GitHub OAuth 2.0 endpoints (authorize / token / user / emails). */
export const GITHUB_ENDPOINTS = {
  AUTHORIZE: 'https://github.com/login/oauth/authorize',
  TOKEN: 'https://github.com/login/oauth/access_token',
  USER: 'https://api.github.com/user',
  /** Lists the operator's emails (verified/primary flags) under `user:email`. */
  EMAILS: 'https://api.github.com/user/emails',
} as const;

/**
 * Scopes requested at authorize time: `read:user` for the operator identity,
 * `user:email` so the callback can read the operator's PRIMARY VERIFIED email
 * (add-private-account-identity, task 2.3 — canonical handle for local accounts +
 * the verified-email auto-link, D4/D8), and `repo` so a later `/user/repos` import
 * (be-github-import) can enumerate the operator's repositories. The space-joined
 * value is what GitHub expects in the `scope` query parameter.
 */
export const GITHUB_OAUTH_SCOPES = ['read:user', 'user:email', 'repo'] as const;
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

/**
 * Whether the email+password login method is enabled (add-private-account-identity,
 * task 2.8 / D11). DEFAULTS to `true` — the default admin is always seeded with a
 * password identity, so password login is the baseline self-host method. Only an
 * explicit falsy `PASSWORD_AUTH_ENABLED` (`"false"`/`"0"`/`"no"`,
 * case-insensitive) turns it off; any other value (including unset) leaves it on.
 *
 * This is the capability flag the frontend reads to decide whether to RENDER the
 * password method in the login modal — it is NOT itself a security gate (the
 * password login endpoint enforces its own fail-closed checks).
 */
export function isPasswordAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ENV.PASSWORD_AUTH_ENABLED];
  if (typeof raw !== 'string') {
    return true; // default ON
  }
  const v = raw.trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no');
}

/**
 * Whether the email-OTP login method is available — i.e. SMTP is configured via
 * EITHER source (add-smtp-config-ui, D7 `otpAuthEnabled = DB config OR env`).
 * Without a mail transport the OTP method cannot send a code, so it is neither
 * advertised to the frontend nor served. The OTP endpoints additionally fail
 * closed at request time when SMTP is unset, so this flag is the display/advertise
 * gate, not the sole security gate.
 *
 * ASYNC + either-source (D4/D7): it delegates to the SAME full-config check the
 * mailer uses (a console-saved DB config first, falling back to all five `SMTP_*`
 * env vars + a valid port), so the advertised availability can never over-advertise
 * relative to what the OTP send path will actually accept. Saving SMTP in the
 * console flips this true (after the session re-resolves) without an env change.
 * `resolveDb` is injected (defaults to env-only) so the gate stays unit-testable
 * without a DB.
 */
export async function isOtpAuthEnabled(
  resolveDb?: DbSmtpConfigResolver,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return isSmtpConfigured(resolveDb, env);
}

/**
 * Parse the comma-separated `WEB_ORIGIN` allow-list into a trimmed, de-duplicated
 * list of cross-origin web origins permitted to reach the api.
 *
 * This is the SINGLE source of truth for the web-origin allow-list: `main.ts`
 * uses it to configure CORS (the set of origins allowed to call the api with the
 * operator credentials) and the OAuth callback uses {@link readWebOrigin} (built
 * on this) to know where to send the browser after login. Keeping both on the
 * same parser guarantees the CORS allow-list and the post-login redirect target
 * never diverge — e.g. we can never accept a fetch from an origin we then refuse
 * to redirect to, or redirect to an origin CORS would reject.
 */
export function parseWebOrigins(raw: string | undefined): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  ];
}

/**
 * The PRIMARY web origin the operator's browser should be sent to after the
 * OAuth callback resolves: the FIRST entry of the `WEB_ORIGIN` allow-list
 * (trimmed), or `null` when `WEB_ORIGIN` is unset/empty.
 *
 * A `null` result signals a SAME-ORIGIN deployment (the api also serves the web
 * app), where the callback must keep using relative redirect paths and the
 * default `SameSite=Lax` session cookie. A non-null result signals a CROSS-ORIGIN
 * deployment (web on Vercel / a different host from the Fly/compose api), where
 * the callback must redirect to an ABSOLUTE URL on this origin and — because the
 * front-end reads the session via a cross-origin `fetch(credentials:"include")` —
 * set the session cookie `SameSite=None; Secure`.
 */
export function readWebOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const origins = parseWebOrigins(env[ENV.WEB_ORIGIN]);
  return origins.length > 0 ? origins[0] : null;
}

/**
 * The `Domain` attribute to set on the session cookie, or `null` when unset.
 *
 * Default (`null`) keeps the cookie HOST-ONLY — scoped to the exact api host —
 * which is correct for same-origin and same-host deploys. Set
 * `SESSION_COOKIE_DOMAIN` to a registrable parent (e.g. `.douglasdong.com`) for
 * a cross-SUBDOMAIN deploy where the web app lives on a SIBLING subdomain of the
 * api (web `cap.douglasdong.com`, api `cap-api.douglasdong.com`): the cookie
 * then rides BOTH the browser's top-level requests to the web origin (so the
 * SSR loader, fetching the api server-side, receives it) AND the api's own
 * cross-origin reads. Leave UNSET for cross-SITE deploys (web on `*.vercel.app`,
 * api on `*.douglasdong.com`) — no parent domain can bridge two registrable
 * domains, so a host-only `SameSite=None` cookie is the only (browser-limited)
 * option there.
 */
export function readSessionCookieDomain(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return nonEmpty(env[ENV.SESSION_COOKIE_DOMAIN]);
}

/** Returns a trimmed non-empty string, or `null` for undefined/blank input. */
function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
