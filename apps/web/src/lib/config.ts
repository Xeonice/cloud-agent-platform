/**
 * Centralized endpoint + operator-token configuration
 * (frontend-console D10/D12; rebuild-console-tanstack-start D6).
 *
 * Explicit endpoint configuration still wins: a Vercel/web-only deploy can bake
 * `VITE_API_BASE_URL` / `VITE_WS_URL` at build time, and the compose node-server
 * image can inject `CAP_PUBLIC_API_BASE_URL` / `CAP_PUBLIC_WS_URL` at runtime.
 * When neither is set, the self-hosted console derives the browser-facing api
 * from the URL the operator actually opened: same protocol + hostname, with the
 * api port supplied by runtime config (default 8080). That keeps the published
 * release web image usable for same-host installs such as
 * `http://100.101.167.99:3000` without baking `localhost` into the client
 * bundle.
 *
 * This module is the SINGLE source of the resolved endpoints and bearer token;
 * the REST and WS clients both import from here rather than reading env
 * directly, so there is exactly one place that knows the cross-origin contract.
 *
 * NOTE: `operatorToken()` continues to read `VITE_AUTH_TOKEN` for the optional
 * legacy shared-token path; normal browser auth uses the httpOnly session cookie.
 */

export interface PublicRuntimeEndpointConfig {
  readonly apiBaseUrl?: string;
  readonly wsUrl?: string;
  readonly apiHost?: string;
  readonly apiPort?: string;
  readonly apiProtocol?: string;
}

declare global {
  interface Window {
    __CAP_RUNTIME_CONFIG__?: PublicRuntimeEndpointConfig;
  }
}

const DEFAULT_API_PORT = "8080";
const DEFAULT_SERVER_API_BASE_URL = "http://localhost:8080";

/** Read the first defined `VITE_*` value from `import.meta.env`. */
function readEnv(...names: string[]): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
  for (const name of names) {
    const value = nonEmpty(env[name]);
    if (value) return value;
  }
  return undefined;
}

function readProcessEnv(...names: string[]): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  for (const name of names) {
    const value = nonEmpty(process.env[name]);
    if (value) return value;
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function normalizePort(port: string | undefined): string {
  const value = nonEmpty(port);
  if (!value) return DEFAULT_API_PORT;
  return value.replace(/^:/, "");
}

function normalizeHttpProtocol(protocol: string | undefined): "http" | "https" {
  const value = nonEmpty(protocol)?.replace(/:$/, "").toLowerCase();
  return value === "https" ? "https" : "http";
}

function wsProtocolFor(httpProtocol: "http" | "https"): "ws" | "wss" {
  return httpProtocol === "https" ? "wss" : "ws";
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

function browserRuntimeConfig(): PublicRuntimeEndpointConfig {
  if (typeof window === "undefined") return {};
  return window.__CAP_RUNTIME_CONFIG__ ?? {};
}

function publicRuntimeConfigFromEnv(): PublicRuntimeEndpointConfig {
  return {
    apiBaseUrl: readProcessEnv("CAP_PUBLIC_API_BASE_URL"),
    wsUrl: readProcessEnv("CAP_PUBLIC_WS_URL"),
    apiHost: readProcessEnv("CAP_PUBLIC_API_HOST"),
    apiPort: readProcessEnv("CAP_PUBLIC_API_PORT", "API_HOST_PORT"),
    apiProtocol: readProcessEnv("CAP_PUBLIC_API_PROTOCOL"),
  };
}

function pruneRuntimeConfig(
  config: PublicRuntimeEndpointConfig,
): PublicRuntimeEndpointConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => nonEmpty(value) !== undefined),
  ) as PublicRuntimeEndpointConfig;
}

function escapeJsonForInlineScript(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

/**
 * Inline, pre-hydration runtime endpoint config for the node-server image.
 * The script carries PUBLIC routing data only; never put secrets here.
 */
export function runtimeEndpointConfigScript(): string {
  const config =
    typeof window === "undefined"
      ? publicRuntimeConfigFromEnv()
      : browserRuntimeConfig();
  const json = escapeJsonForInlineScript(JSON.stringify(pruneRuntimeConfig(config)));
  return `window.__CAP_RUNTIME_CONFIG__=${json};`;
}

export function deriveBrowserApiBaseUrl(
  location: Pick<Location, "protocol" | "hostname">,
  config: PublicRuntimeEndpointConfig = browserRuntimeConfig(),
): string {
  const explicit = nonEmpty(config.apiBaseUrl);
  if (explicit) return stripTrailingSlash(explicit);

  const protocol = normalizeHttpProtocol(config.apiProtocol ?? location.protocol);
  const host = formatHost(nonEmpty(config.apiHost) ?? location.hostname);
  const port = normalizePort(config.apiPort);
  return `${protocol}://${host}:${port}`;
}

export function deriveBrowserWsUrl(
  location: Pick<Location, "protocol" | "hostname">,
  config: PublicRuntimeEndpointConfig = browserRuntimeConfig(),
): string {
  const explicit = nonEmpty(config.wsUrl);
  if (explicit) return stripTrailingSlash(explicit);

  const httpProtocol = normalizeHttpProtocol(config.apiProtocol ?? location.protocol);
  const host = formatHost(nonEmpty(config.apiHost) ?? location.hostname);
  const port = normalizePort(config.apiPort);
  return `${wsProtocolFor(httpProtocol)}://${host}:${port}`;
}

function serverApiBaseUrl(): string {
  return stripTrailingSlash(
    readProcessEnv(
      "CAP_SERVER_API_BASE_URL",
      "CAP_PUBLIC_API_BASE_URL",
      "VITE_API_BASE_URL",
    ) ?? DEFAULT_SERVER_API_BASE_URL,
  );
}

function serverWsUrl(): string {
  const explicit = readProcessEnv("CAP_PUBLIC_WS_URL", "VITE_WS_URL");
  if (explicit) return stripTrailingSlash(explicit);

  const apiBase = serverApiBaseUrl();
  try {
    const url = new URL(apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return stripTrailingSlash(url.toString());
  } catch {
    return `ws://localhost:${DEFAULT_API_PORT}`;
  }
}

/**
 * The HTTP base URL of the api.
 *
 * Resolution order:
 * 1. build-time `VITE_API_BASE_URL`;
 * 2. runtime public `CAP_PUBLIC_API_BASE_URL`;
 * 3. browser same-host fallback from `window.location.hostname` + api port;
 * 4. server-side internal fallback (`CAP_SERVER_API_BASE_URL`, else localhost).
 */
export function apiBaseUrl(): string {
  const value = readEnv("VITE_API_BASE_URL");
  if (value) return stripTrailingSlash(value);

  if (typeof window !== "undefined") {
    return deriveBrowserApiBaseUrl(window.location);
  }

  return serverApiBaseUrl();
}

/**
 * The WebSocket URL of the api.
 *
 * Resolution order mirrors {@link apiBaseUrl}; when only an HTTP api base is
 * configured, the scheme is converted to `ws`/`wss`.
 */
export function wsUrl(): string {
  const value = readEnv("VITE_WS_URL");
  if (value) return stripTrailingSlash(value);

  if (typeof window !== "undefined") {
    return deriveBrowserWsUrl(window.location);
  }

  return serverWsUrl();
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
