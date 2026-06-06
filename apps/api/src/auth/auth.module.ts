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
 * login. Every other request must resolve a VALID operator principal — a
 * still-allowlisted GitHub-OAuth session (cookie or `bearer.<token>` subprotocol),
 * or, only when `AUTH_TOKEN_LEGACY_ENABLED` is on, the legacy `AUTH_TOKEN` bearer
 * (task 2.8) — or it is rejected with 401. The guard injects
 * {@link AuthSessionService} so the allowlist re-check happens at request time.
 *
 * OAuth core wired here:
 *   - {@link GitHubOAuthController} — the four routes (login / callback / session /
 *     logout);
 *   - {@link GitHubOAuthService} — the GitHub HTTP boundary (authorize URL, code
 *     exchange, user fetch);
 *   - {@link AuthSessionService} — the SINGLE session-mint point: fail-closed
 *     allowlist gate, gated user upsert, and opaque revocable sessions. It injects
 *     the global `PrismaService` and is EXPORTED so the WS handshake guard
 *     (`TerminalModule`, task 2.7) can resolve sessions at connect time.
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
