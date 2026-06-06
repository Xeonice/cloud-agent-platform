import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { authTokenConfigSchema } from '@cap/contracts';
import { AppModule } from './app.module';
import { parseWebOrigins } from './auth/oauth-config';

/**
 * Orchestrator bootstrap.
 *
 * The repo/task data plane (repos/tasks REST) and the realtime-terminal gateway
 * are wired in {@link AppModule}. The integration track layers the following
 * cross-cutting bootstrap concerns here:
 *
 *   - 11.3b: REFUSE TO BOOT (clear error, non-zero exit) when `AUTH_TOKEN` is
 *            unset or empty — the operator token is the single credential gating
 *            the whole control plane, so an unconfigured token is fatal rather
 *            than fail-open.
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
  // 11.3b — refuse to boot on an unset/empty AUTH_TOKEN. The constant-time helper
  // (11.3) underpins the runtime comparison; here we only require the token to be
  // a non-empty string per the contracts config schema, failing fast otherwise.
  const tokenCheck = authTokenConfigSchema.safeParse(process.env.AUTH_TOKEN);
  if (!tokenCheck.success) {
    console.error(
      'FATAL: AUTH_TOKEN is not configured. The orchestrator refuses to boot ' +
        'without the operator token that gates every REST endpoint and client ' +
        'WebSocket connection. Set a non-empty AUTH_TOKEN and restart.',
    );
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // Realtime terminal: serve the custom dual-channel frame protocol over `ws`.
  app.useWebSocketAdapter(new WsAdapter(app));

  // 10.1b — CORS / WS-origin allow-listing. The Vercel web target is a different
  // origin from the Fly/compose api, so the api must explicitly allow it. The
  // allow-list is env-configured (comma-separated); an unset list allows no
  // cross-origin browser app (same-origin/cURL still work) rather than `*`,
  // because the operator bearer token travels on these requests.
  //
  // The parse is shared with the OAuth callback via `parseWebOrigins`
  // (auth/oauth-config) so the CORS allow-list and the post-login redirect
  // target can never diverge: the callback's `readWebOrigin` is the FIRST entry
  // of this very list. CORS behaviour is unchanged — an empty list still maps to
  // `origin: false` (no cross-origin browser app), never `*`.
  const allowedOrigins = parseWebOrigins(process.env.WEB_ORIGIN);
  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
