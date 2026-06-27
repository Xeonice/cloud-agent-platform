/**
 * Auth/session configuration readers.
 *
 * Every value here is read from `process.env` AT RUNTIME (never captured at module
 * load) so the live deployment configuration is reflected on each request.
 * External code-host login is intentionally not part of the console login surface;
 * self-hosted installs use local accounts, while repository access is configured
 * separately through forge PAT credentials.
 */

import { isSmtpConfigured, type DbSmtpConfigResolver } from '../mail/mail.service';

/** Env var names, centralised so the controller/service/tests agree on spelling. */
export const ENV = {
  SESSION_SECRET: 'SESSION_SECRET',
  AUTH_TOKEN_LEGACY_ENABLED: 'AUTH_TOKEN_LEGACY_ENABLED',
  AUTH_TOKEN: 'AUTH_TOKEN',
  WEB_ORIGIN: 'WEB_ORIGIN',
  WEB_ORIGIN_AUTO_SAME_HOST: 'WEB_ORIGIN_AUTO_SAME_HOST',
  WEB_ORIGIN_AUTO_SAME_HOST_PORT: 'WEB_ORIGIN_AUTO_SAME_HOST_PORT',
  WEB_HOST_PORT: 'WEB_HOST_PORT',
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

/**
 * Reads `SESSION_SECRET`, returning `null` when unset/empty. Password/OTP login
 * paths mint opaque sessions via `session-token`; keeping this reader here gives
 * tests and setup checks a single source of truth.
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
 * uses it to configure CORS and session-cookie helpers use {@link readWebOrigin}
 * (built on this) to decide when cross-origin cookies require SameSite=None.
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
 * Quick/self-host same-side deploys often expose web and api on the same
 * hostname but different ports (for example web :3000, api :8080 or :18080).
 * When explicitly enabled, allow exactly that browser origin without forcing
 * operators to know the LAN/Tailscale IP ahead of time.
 */
export function isAutoSameHostWebOriginEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[ENV.WEB_ORIGIN_AUTO_SAME_HOST];
  if (typeof raw !== 'string') {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export function readAutoSameHostWebOriginPort(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return nonEmpty(env[ENV.WEB_ORIGIN_AUTO_SAME_HOST_PORT])
    ?? nonEmpty(env[ENV.WEB_HOST_PORT])
    ?? '3000';
}

export function isAutoSameHostWebOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isAutoSameHostWebOriginEnabled(env)) {
    return false;
  }
  if (!origin || !requestHost) {
    return false;
  }
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(`http://${requestHost}`);
    return (
      originUrl.hostname === requestUrl.hostname &&
      effectiveUrlPort(originUrl) === readAutoSameHostWebOriginPort(env)
    );
  } catch {
    return false;
  }
}

function effectiveUrlPort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === 'https:' ? '443' : '80';
}

/**
 * The PRIMARY web origin: the FIRST entry of the `WEB_ORIGIN` allow-list
 * (trimmed), or `null` when `WEB_ORIGIN` is unset/empty.
 *
 * A `null` result signals a SAME-ORIGIN deployment (the api also serves the web
 * app), where the default `SameSite=Lax` session cookie is correct. A non-null
 * result signals a CROSS-ORIGIN deployment, where the front-end reads the session
 * via `fetch(credentials:"include")` and the cookie helper sets
 * `SameSite=None; Secure`.
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
