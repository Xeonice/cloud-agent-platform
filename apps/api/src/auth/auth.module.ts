import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { GitHubOAuthController } from './github-oauth.controller';
import { GitHubOAuthService } from './github-oauth.service';
import { AuthSessionService } from './auth-session.service';

/**
 * Operator-auth module: GitHub-OAuth identity & session core (be-oauth-allowlist,
 * tasks 2.2–2.5) + the session guard (task 2.6) with the gated legacy-token path
 * (task 2.8).
 *
 * 2.6 — registers the {@link AuthGuard} GLOBALLY across every REST endpoint via
 * the `APP_GUARD` provider. The guard exempts `/health` (liveness probes) and the
 * GitHub-OAuth session entry points (`/auth/github/login`, `/auth/github/callback`,
 * `/auth/session`, `/auth/logout`) so an unauthenticated operator can complete
 * login, plus the connect-in AIO sandbox callback `/v1/approvals` (whose boundary
 * is `cap-net` network isolation, not an operator principal —
 * migrate-execution-to-aio-sandbox 5.5). Every other request must resolve a VALID
 * operator principal — a still-allowlisted GitHub-OAuth session (cookie or
 * `bearer.<token>` subprotocol), or, only when `AUTH_TOKEN_LEGACY_ENABLED` is on,
 * the legacy `AUTH_TOKEN` bearer (task 2.8) — or it is rejected with 401. The
 * guard injects {@link AuthSessionService} so the allowlist re-check happens at
 * request time.
 *
 * OAuth core wired here:
 *   - {@link GitHubOAuthController} — the four routes (login / callback / session /
 *     logout);
 *   - {@link GitHubOAuthService} — the GitHub HTTP boundary (authorize URL, code
 *     exchange, user fetch);
 *   - {@link AuthSessionService} — the SINGLE session-mint point: fail-closed
 *     allowlist gate, gated user upsert, and opaque revocable sessions. It also
 *     hosts `resolveMcpToken` (remote-mcp-server, task 3.2) — the security-critical
 *     `mcp_`-token resolve/allowlist-recheck decision, kept next to `resolveSession`.
 *     It injects the global `PrismaService` and is EXPORTED so the WS handshake
 *     guard (`TerminalModule`, task 2.7) can resolve sessions at connect time AND
 *     the integration track can mount `requireBearerAuth({ verifyAccessToken:
 *     resolveMcpToken })` on `/mcp`.
 *
 * MCP surface (remote-mcp-server, tasks 3.3 / 3.4): the guard prefix-routes an
 * `mcp_` bearer through the `resolveMcp` slot of `resolveOperatorPrincipal` to an
 * `mcp` machine principal (scopes), and EXACT-MATCH exempts `/mcp` from the
 * session guard (it stays bearer-protected downstream by `requireBearerAuth`).
 * Both reuse the already-injected {@link AuthSessionService}, so no new provider
 * or export is required.
 */
@Module({
  controllers: [GitHubOAuthController],
  providers: [
    GitHubOAuthService,
    AuthSessionService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthSessionService],
})
export class AuthModule {}
