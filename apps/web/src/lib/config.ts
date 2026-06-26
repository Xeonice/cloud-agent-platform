/**
 * Centralized cross-origin endpoint + operator-token configuration
 * (frontend-console D10/D12; rebuild-console-tanstack-start D6).
 *
 * The web app NEVER assumes the api is same-origin: it reads the api base URL
 * and WebSocket URL from environment configuration so a Vercel web-only deploy
 * can target a Fly/compose api origin. Under Vite, only `VITE_`-prefixed vars
 * are exposed to the client bundle via `import.meta.env`, so the public
 * endpoints use the `VITE_` prefix.
 *
 * This module is the SINGLE source of the resolved endpoints and bearer token;
 * the REST and WS clients both import from here rather than reading env
 * directly, so there is exactly one place that knows the cross-origin contract.
 *
 * NOTE: `operatorToken()` continues to read `VITE_AUTH_TOKEN` for the optional
 * legacy shared-token path; normal browser auth uses the httpOnly session cookie.
 */

/** Read the first defined `VITE_*` value from `import.meta.env`. */
function readEnv(...names: string[]): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
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
 * Reads `VITE_API_BASE_URL`.
 */
export function apiBaseUrl(): string {
  const value = readEnv("VITE_API_BASE_URL");
  if (!value) {
    throw new Error(
      "API_BASE_URL is not configured. Set VITE_API_BASE_URL to the cross-origin api HTTP origin.",
    );
  }
  return stripTrailingSlash(value);
}

/**
 * The cross-origin WebSocket URL of the api (e.g. `wss://api.example.fly.dev`).
 * Reads `VITE_WS_URL`.
 */
export function wsUrl(): string {
  const value = readEnv("VITE_WS_URL");
  if (!value) {
    throw new Error(
      "WS_URL is not configured. Set VITE_WS_URL to the cross-origin api WebSocket origin.",
    );
  }
  return stripTrailingSlash(value);
}

/**
 * The operator bearer token (`AUTH_TOKEN`, D12) attached to every REST and WS
 * call. Returns `undefined` when unset so callers can surface an
 * unauthenticated state rather than throw.
 */
export function operatorToken(): string | undefined {
  return readEnv("VITE_AUTH_TOKEN");
}

/**
 * The build identifier baked into the console bundle at build time
 * (versioned-release-pipeline web-buildid). `VITE_BUILD_ID` is defined as a
 * compile-time constant in `vite.config.ts` (from the CI/Dockerfile build arg),
 * so the running console can report its own build. Falls back to the `"dev"`
 * sentinel for a plain source build rather than failing.
 */
export function buildId(): string {
  return readEnv("VITE_BUILD_ID") ?? "dev";
}
