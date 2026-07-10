import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthSessionController } from './auth-session.controller';
import { AuthSessionService } from './auth-session.service';

/**
 * Operator-auth module: local account sessions plus the global session guard.
 *
 * 2.6 — registers the {@link AuthGuard} GLOBALLY across every REST endpoint via
 * the `APP_GUARD` provider. The guard exempts `/health` (liveness probes) and the
 * local session entry points (`/auth/session`, `/auth/logout`, password/OTP
 * login, forced password change, admin reveal) so an unauthenticated operator can
 * complete login, plus `/internal/sandbox/approvals` for the connect-in AIO callback (whose
 * boundary is `cap-net` network isolation, not an operator principal —
 * migrate-execution-to-aio-sandbox 5.5). Every other request must resolve a VALID
 * operator principal — a still-enabled local session (cookie or `bearer.<token>`
 * subprotocol), an API key, an MCP token on its reserved route, or, only when
 * `AUTH_TOKEN_LEGACY_ENABLED` is on, the legacy `AUTH_TOKEN` bearer — or it is
 * rejected with 401.
 *
 * Session core wired here:
 *   - {@link AuthSessionController} — current session + logout;
 *   - {@link AuthSessionService} — opaque session, API-key, and MCP-token
 *     resolution. It is EXPORTED so the WS handshake guard and the MCP bearer
 *     verifier can resolve credentials at connect time.
 *
 * MCP surface (remote-mcp-server, tasks 3.3 / 3.4): the guard prefix-routes an
 * `mcp_` bearer through the `resolveMcp` slot of `resolveOperatorPrincipal` to an
 * `mcp` machine principal (scopes), and EXACT-MATCH exempts `/mcp` from the
 * session guard (it stays bearer-protected downstream by `requireBearerAuth`).
 * Both reuse the already-injected {@link AuthSessionService}, so no new provider
 * or export is required.
 */
@Module({
  controllers: [AuthSessionController],
  providers: [
    AuthSessionService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthSessionService],
})
export class AuthModule {}
