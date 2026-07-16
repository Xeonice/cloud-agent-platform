import 'reflect-metadata';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger } from 'nestjs-pino';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  authTokenConfigSchema,
  RESERVED_CREDENTIAL_PREFIXES,
  contractsZod,
} from '@cap/contracts';
import { AppModule } from './app.module';
import { AuthSessionService } from './auth/auth-session.service';
import {
  isAutoSameHostWebOrigin,
  isLegacyTokenEnabled,
  parseWebOrigins,
} from './auth/auth-config';
import {
  assertGitRuntimeAvailable,
  GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE,
} from './forge/git-runtime-preflight';

// public-v1-api (Integration 4.1): the ONCE-per-process `extendZodWithOpenApi`
// init, owned here (outside `@cap/contracts`) so the `.openapi(...)` augmentation
// is installed before ANY schema is registered into the OpenAPI document. It is
// idempotent (the registry also calls it defensively so it can generate in
// isolation), but this is the canonical single call at the bootstrap seam.
//
// CRITICAL: it must extend the EXACT zod instance the `@cap/contracts` schemas are
// built on — re-exported as `contractsZod` — NOT the api's own `import/require('zod')`.
// `@cap/contracts` is ESM (resolves zod's `index.js`) while the api is CJS (resolves
// the SEPARATE `index.cjs` class realm); extending the CJS realm would leave every
// ESM-built contract schema without `.openapi`, and OpenAPI generation would throw
// `schema.openapi is not a function`. Extending `contractsZod` patches the right realm.
extendZodWithOpenApi(contractsZod);

/**
 * Orchestrator bootstrap.
 *
 * The repo/task data plane (repos/tasks REST) and the realtime-terminal gateway
 * are wired in {@link AppModule}. The integration track layers the following
 * cross-cutting bootstrap concerns here:
 *
 *   - 11.3b: REFUSE TO BOOT (clear error, non-zero exit) when the LEGACY operator
 *            token path is enabled (`AUTH_TOKEN_LEGACY_ENABLED`) but `AUTH_TOKEN`
 *            is unset/empty — when that break-glass path is on, the token is the
 *            credential gating it, so an unconfigured token is fatal rather than
 *            fail-open. A normal local-account instance (legacy path NOT enabled)
 *            needs no `AUTH_TOKEN` at all.
 *   - 11.2b: register the operator-auth guard GLOBALLY on all REST endpoints
 *            (exempting `/health`). The global `APP_GUARD` binding lives in
 *            {@link AppModule}; this bootstrap only guarantees the token exists.
 *   - 10.1b: CORS / WebSocket-origin ALLOW-LISTING so the cross-origin Vercel web
 *            target can reach the api (the web app never assumes same-origin).
 *
 * The realtime terminal uses the raw `ws` adapter (not socket.io), registered
 * here so the gateway's custom dual-channel frame protocol is served correctly.
 */
async function bootstrap(): Promise<void> {
  // The API resolves authenticated symbolic HEADs with the local Git executable.
  // Verify that packaged dependency before Nest creates/listens on any socket.
  // The reusable preflight owns its bounded command and sanitized environment;
  // this boundary deliberately discards every raw error/diagnostic and emits only
  // the fixed platform-dependency reason.
  try {
    await assertGitRuntimeAvailable();
  } catch {
    console.error(GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE);
    process.exitCode = 1;
    return;
  }

  // 11.3b — refuse to boot on an unset/empty AUTH_TOKEN ONLY when the legacy
  // operator-token break-glass path is enabled. The constant-time helper (11.3)
  // underpins the runtime comparison; here we require the token to be a non-empty
  // string per the contracts config schema, failing fast otherwise. A local-account
  // instance leaves the legacy path off, so it needs no AUTH_TOKEN and skips this
  // gate entirely.
  if (isLegacyTokenEnabled(process.env)) {
    const tokenCheck = authTokenConfigSchema.safeParse(process.env.AUTH_TOKEN);
    if (!tokenCheck.success) {
      console.error(
        'FATAL: AUTH_TOKEN_LEGACY_ENABLED is set but AUTH_TOKEN is not configured. ' +
          'The legacy operator-token path is the credential gating every REST ' +
          'endpoint and client WebSocket connection when enabled, so the ' +
          'orchestrator refuses to boot without it. Set a non-empty AUTH_TOKEN ' +
          '(or disable the legacy path for local-account auth) and restart.',
      );
      process.exit(1);
    }
  }

  // api-key-machine-identity (task 4.6, D5/G10) — RESERVED-PREFIX boot assertion.
  // The legacy `AUTH_TOKEN` is an OPERATOR-CHOSEN free-form value, so (unlike a
  // random session/api-key token) it could begin with a reserved credential
  // prefix. A prefixed `AUTH_TOKEN` would be silently routed by the FIRST-step
  // prefix dispatch in resolveOperatorPrincipal to a MACHINE resolver (hash miss
  // -> null) and never reach its constant-time compare, breaking legacy operator
  // auth without warning. Refuse to boot when a configured `AUTH_TOKEN` collides,
  // with a clear error NAMING the reserved prefixes. Checked whenever AUTH_TOKEN
  // is set (independent of the legacy flag), since the path can be enabled later.
  const authToken = process.env.AUTH_TOKEN;
  if (typeof authToken === 'string' && authToken.length > 0) {
    const colliding = RESERVED_CREDENTIAL_PREFIXES.find((prefix) =>
      authToken.startsWith(prefix),
    );
    if (colliding !== undefined) {
      console.error(
        `FATAL: AUTH_TOKEN begins with the reserved credential prefix "${colliding}". ` +
          `Reserved prefixes (${RESERVED_CREDENTIAL_PREFIXES.join(', ')}) route a ` +
          'presented bearer to a machine-credential resolver BEFORE the legacy ' +
          'operator-token comparison, so an AUTH_TOKEN carrying one would be ' +
          'silently mis-routed and never authenticate. Choose an AUTH_TOKEN that ' +
          'does not start with any reserved prefix and restart.',
      );
      process.exit(1);
    }
  }

  // structured-logging: buffer early logs until pino is ready, then promote the
  // nestjs-pino Logger to the app logger so framework bootstrap/route-mapping
  // logs AND the existing `this.logger.*` call sites all emit structured JSON.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  // Realtime terminal: serve the custom dual-channel frame protocol over `ws`.
  app.useWebSocketAdapter(new WsAdapter(app));

  // 10.1b — CORS / WS-origin allow-listing. The Vercel web target is a different
  // origin from the Fly/compose api, so the api must explicitly allow it. The
  // allow-list is env-configured (comma-separated). The release-image self-host
  // path can additionally opt into same-host discovery: if the browser opened
  // `http://<host>:WEB_PORT`, then the api at `http://<host>:API_PORT` can echo
  // that exact Origin without hardcoding the host/IP in `.env`.
  //
  // The parse is shared with session-cookie helpers via `parseWebOrigins`
  // (auth/auth-config) so the CORS allow-list and the cookie cross-origin policy
  // use the same web-origin list. CORS behaviour is unchanged — an empty list
  // still maps to `origin: false` (no cross-origin browser app), never `*`.
  const allowedOrigins = parseWebOrigins(process.env.WEB_ORIGIN);
  // The console's CREDENTIALED CORS — but applied via a per-request DELEGATE so it
  // is NEVER applied to `/mcp` (remote-mcp-server, task 7.2). The MCP surface is a
  // distinct, bearer-only / non-credentialed CORS domain (configured below); a
  // wildcard `/mcp` origin must never inherit `Allow-Credentials`, and an
  // MCP-client origin is never folded into the console allow-list. For `/mcp` the
  // delegate disables CORS entirely (origin:false, credentials:false) so the
  // global handler writes NO credentialed header there — the `mcpCorsMiddleware`
  // owns `/mcp` CORS exclusively. Every other route gets the unchanged console
  // policy (env allow-list, credentialed).
  app.enableCors((req: Request, callback: CorsDelegateCallback): void => {
    if (isMcpPath(req.url)) {
      callback(null, { origin: false, credentials: false });
      return;
    }
    const sameHostOrigin = resolveAutoSameHostOrigin(req);
    callback(null, {
      origin:
        sameHostOrigin ??
        (allowedOrigins.length > 0 ? allowedOrigins : false),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        // Public task-create retry key. Without this entry a browser client is
        // blocked by the CORS preflight even though POST /v1/tasks accepts it.
        'Idempotency-Key',
        // Explicit for non-EventSource SSE clients that resume with this header.
        'Last-Event-ID',
      ],
    });
  });

  // remote-mcp-server (integration, task 7.2): mount the `/mcp` bearer gate +
  // a route-scoped, NON-CREDENTIALED CORS shim. Registered AFTER `enableCors` but
  // the delegate above already opted `/mcp` OUT of the credentialed handler, so
  // this is the SOLE writer of `/mcp` CORS headers. An absent/invalid `mcp_`
  // bearer is 401'd here before the request ever reaches the `McpController`.
  //
  // CORS posture is DELIBERATELY distinct from the console's credentialed
  // allow-list above: an MCP client authenticates with a STATIC bearer header and
  // never a cookie, so `/mcp` advertises a bearer-only, non-credentialed CORS
  // (`Access-Control-Allow-Origin: *`, NO `Allow-Credentials`). A wildcard origin
  // with credentials is forbidden by browsers and would be a CSRF foothold.
  const authSession = app.get(AuthSessionService);
  app.use('/mcp', mcpCorsMiddleware());
  app.use('/mcp', mcpBearerAuthMiddleware(authSession));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

/**
 * The callback Nest's `enableCors` delegate form invokes with the per-request CORS
 * options. Typed locally (the `cors` option shape Nest forwards to the underlying
 * `cors` package) so the delegate stays free of a direct `cors`/`@types/cors`
 * dependency. `credentials: false` + `origin: false` disables CORS for the route.
 */
type CorsDelegateCallback = (
  err: Error | null,
  options: {
    origin?: boolean | string | string[];
    credentials?: boolean;
    methods?: string[];
    allowedHeaders?: string[];
  },
) => void;

function resolveAutoSameHostOrigin(req: Request): string | null {
  const origin = headerValue(req.headers.origin);
  if (!origin) {
    return null;
  }
  return isAutoSameHostWebOrigin(origin, headerValue(req.headers.host))
    ? origin
    : null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

/**
 * True when a request URL targets the `/mcp` endpoint (EXACT match on the path,
 * ignoring the query string), so the global credentialed CORS delegate opts it
 * OUT and the bearer-only `mcpCorsMiddleware` owns its CORS exclusively. Matches
 * `/mcp` only — not a `/mcp*` prefix — mirroring the guard's exact-match exemption.
 */
function isMcpPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0].replace(/\/+$/, '');
  return path === '/mcp';
}

/**
 * Route-scoped, NON-CREDENTIALED CORS for `/mcp` (remote-mcp-server, task 7.2).
 *
 * An MCP client presents a STATIC `Authorization: Bearer mcp_…` header and no
 * cookie, so the endpoint advertises a bearer-only CORS: any origin (`*`) may
 * call it, but WITHOUT `Access-Control-Allow-Credentials` — so no browser ever
 * attaches the console's session cookie here, and the `mcp_` bearer is the sole
 * credential. A preflight `OPTIONS` is answered 204 directly. This is mounted
 * ONLY on `/mcp`; the console's credentialed CORS (configured above) is
 * untouched, and an MCP-client origin is never folded into it.
 */
function mcpCorsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, DELETE, OPTIONS',
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Mcp-Session-Id, Mcp-Protocol-Version',
    );
    // Bearer-only: deliberately NO `Access-Control-Allow-Credentials`.
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}

/**
 * The SDK `requireBearerAuth` middleware bound to {@link AuthSessionService}'s
 * `resolveMcpToken` (remote-mcp-server, task 7.2 / G1). The verifier hashes ->
 * looks up -> re-confirms the owner's enabled state and returns a FULL `AuthInfo`
 * (`expiresAt` populated in seconds, so the SDK never 401s a valid token); a
 * null resolution (unknown / revoked / expired / disabled owner) is surfaced as
 * an `InvalidTokenError`, which the SDK renders as a 401 that ENDS the request —
 * no OAuth discovery header is configured because the token is settings-minted,
 * not negotiated. The transport threads the resolved `AuthInfo` into each tool's
 * `extra.authInfo`, where the per-tool scope gate reads it.
 */
function mcpBearerAuthMiddleware(
  authSession: AuthSessionService,
): RequestHandler {
  return requireBearerAuth({
    verifier: {
      verifyAccessToken: async (token: string): Promise<AuthInfo> => {
        const info = await authSession.resolveMcpToken(token);
        if (info === null) {
          // Fail-closed: the SDK catches this and replies 401, ending the request.
          throw new InvalidTokenError('Invalid or revoked MCP token');
        }
        return {
          token: info.token,
          clientId: info.clientId,
          scopes: info.scopes,
          // G1: a populated seconds-since-epoch expiry — the SDK 401s a token
          // with no `expiresAt`. `resolveMcpToken` always sets it (far-future for
          // a never-expiring token).
          expiresAt: info.expiresAt,
          // Carry the owner's ACCOUNT primary key under `extra.userId` — the exact
          // key `mcp.server.ts#userIdFromExtra` reads for best-effort audit
          // attribution on create/stop, and so the owner-scoped Codex credential
          // resolves for a LOCAL account too (fix-local-account-task-attribution).
          // The numeric `githubId` is kept alongside for any GitHub-keyed consumer.
          // `resource` is intentionally omitted (no audience negotiation in the
          // settings-minted model, so no resource-match 401 risk).
          extra: { userId: info.ownerId, githubId: info.ownerGithubId },
        };
      },
    },
  });
}

void bootstrap();
