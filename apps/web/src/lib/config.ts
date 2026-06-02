/**
 * Centralized cross-origin endpoint + operator-token configuration
 * (frontend-console spec 13.6, D10/D12).
 *
 * The web app NEVER assumes the api is same-origin: it reads the api base URL
 * and WebSocket URL from environment configuration so a Vercel web-only deploy
 * can target a Fly/compose api origin. `NEXT_PUBLIC_*` variants are read first
 * because only `NEXT_PUBLIC_`-prefixed vars are exposed to the browser bundle
 * under Next.js; the bare names are accepted as a server-side fallback.
 *
 * This module is the SINGLE source of the resolved endpoints and bearer token;
 * the REST and WS clients both import from here rather than reading env
 * directly, so there is exactly one place that knows the cross-origin contract.
 */

function readEnv(...names: string[]): string | undefined {
  // `process.env` is statically replaced by Next at build for NEXT_PUBLIC_*.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (!env) return undefined;
  for (const name of names) {
    const value = env[name];
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * The cross-origin HTTP base URL of the api (e.g. `https://api.example.fly.dev`).
 * Reads `NEXT_PUBLIC_API_BASE_URL` then `API_BASE_URL`.
 */
export function apiBaseUrl(): string {
  const value = readEnv("NEXT_PUBLIC_API_BASE_URL", "API_BASE_URL");
  if (!value) {
    throw new Error(
      "API_BASE_URL is not configured. Set NEXT_PUBLIC_API_BASE_URL (or API_BASE_URL) to the cross-origin api HTTP origin.",
    );
  }
  return stripTrailingSlash(value);
}

/**
 * The cross-origin WebSocket URL of the api (e.g. `wss://api.example.fly.dev`).
 * Reads `NEXT_PUBLIC_WS_URL` then `WS_URL`.
 */
export function wsUrl(): string {
  const value = readEnv("NEXT_PUBLIC_WS_URL", "WS_URL");
  if (!value) {
    throw new Error(
      "WS_URL is not configured. Set NEXT_PUBLIC_WS_URL (or WS_URL) to the cross-origin api WebSocket origin.",
    );
  }
  return stripTrailingSlash(value);
}

/**
 * The operator bearer token (`AUTH_TOKEN`, D12) attached to every REST and WS
 * call. Distinct from the per-task runner `TASK_TOKEN`. Returns `undefined`
 * when unset so callers can surface an unauthenticated state rather than throw.
 */
export function operatorToken(): string | undefined {
  return readEnv("NEXT_PUBLIC_AUTH_TOKEN", "AUTH_TOKEN");
}
