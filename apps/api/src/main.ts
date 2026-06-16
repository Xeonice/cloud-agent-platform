import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger } from 'nestjs-pino';
import { authTokenConfigSchema } from '@cap/contracts';
import { AppModule } from './app.module';
import { isLegacyTokenEnabled, parseWebOrigins } from './auth/oauth-config';

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
 *            fail-open. An OAuth-FIRST instance (legacy path NOT enabled) needs no
 *            `AUTH_TOKEN` at all and boots on GitHub-OAuth config alone
 *            (self-hostable-deployment — "OAuth-first self-host boots without a
 *            legacy operator token").
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
  // 11.3b — refuse to boot on an unset/empty AUTH_TOKEN ONLY when the legacy
  // operator-token break-glass path is enabled. The constant-time helper (11.3)
  // underpins the runtime comparison; here we require the token to be a non-empty
  // string per the contracts config schema, failing fast otherwise. An OAuth-first
  // instance leaves the legacy path off and authenticates operators via GitHub
  // OAuth, so it needs no AUTH_TOKEN and skips this gate entirely.
  if (isLegacyTokenEnabled(process.env)) {
    const tokenCheck = authTokenConfigSchema.safeParse(process.env.AUTH_TOKEN);
    if (!tokenCheck.success) {
      console.error(
        'FATAL: AUTH_TOKEN_LEGACY_ENABLED is set but AUTH_TOKEN is not configured. ' +
          'The legacy operator-token path is the credential gating every REST ' +
          'endpoint and client WebSocket connection when enabled, so the ' +
          'orchestrator refuses to boot without it. Set a non-empty AUTH_TOKEN ' +
          '(or disable the legacy path for an OAuth-first deploy) and restart.',
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
