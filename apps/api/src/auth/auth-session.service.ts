import { Injectable, Logger } from '@nestjs/common';
import type { SessionUser } from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { isAllowlistedRaw } from './allowlist';
import { ENV } from './oauth-config';
import {
  hashSessionToken,
  isSessionExpired,
  mintSessionToken,
  sessionExpiryFrom,
  type MintedSessionToken,
} from './session-token';
import type { GitHubUser } from './github-oauth.service';

/**
 * Allowlist-gated identity + revocable-session service (be-oauth-allowlist,
 * tasks 2.4 / 2.5).
 *
 * This is the SINGLE session-mint point. The fail-closed allowlist gate lives
 * here, in {@link establishSessionForGitHubUser}, so there is exactly one place
 * that decides "who may obtain a session" — and therefore root-on-host
 * execution. The gate keys on the immutable numeric GitHub `id`; `login` is
 * display-only and is never used for the admit decision.
 *
 * Ordering guarantees (so record persistence never bypasses the gate):
 *   1. evaluate the allowlist FIRST;
 *   2. only on admit do we upsert the user record and mint a session;
 *   3. a denied identity gets NO user row and NO session.
 *
 * Sessions are opaque: only the SHA-256 HASH of the token is stored, and a
 * presented token is resolved by hashing it and matching the stored hash, with
 * expiry checked and allowlist membership RE-CONFIRMED at resolution time
 * (de-allowlisting denies an in-flight session on its next request — used by the
 * session guard in task 2.6).
 */
@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The single session-mint point with the load-bearing allowlist gate.
   *
   * Returns the raw session token (to be set on the cookie) and the resolved
   * {@link SessionUser} on admit, or `null` when the identity is NOT allowlisted
   * — a fail-closed security denial, NOT a recoverable error. On `null` the
   * caller establishes no session and returns the operator to the login gate.
   *
   * `accessToken` (the operator's GitHub OAuth token) is stored server-side on
   * the user record for later import calls; it is only ever persisted for an
   * already-admitted identity.
   */
  async establishSessionForGitHubUser(
    githubUser: GitHubUser,
    accessToken: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ token: string; user: SessionUser } | null> {
    // 1. Allowlist gate FIRST. Denies fail-closed when AUTH_ALLOWLIST is
    //    unset/empty/unparseable, and matches on the immutable numeric id only.
    const admitted = isAllowlistedRaw(githubUser.id, env[ENV.AUTH_ALLOWLIST]);
    if (!admitted) {
      this.logger.warn(
        `Denied non-allowlisted GitHub identity id=${githubUser.id} login=${githubUser.login}`,
      );
      return null;
    }

    // 2. Upsert the user record (create on first login, refresh mutable profile
    //    fields after) keyed on the numeric id. Reached ONLY after admit, so
    //    record persistence cannot bypass the gate.
    const user = await this.prisma.user.upsert({
      where: { githubId: githubUser.id },
      create: {
        githubId: githubUser.id,
        login: githubUser.login,
        name: githubUser.name,
        avatarUrl: githubUser.avatarUrl,
        allowed: true,
        githubAccessToken: accessToken,
      },
      update: {
        login: githubUser.login,
        name: githubUser.name,
        avatarUrl: githubUser.avatarUrl,
        allowed: true,
        githubAccessToken: accessToken,
      },
    });

    // 3. Mint an opaque, revocable session storing only the token HASH.
    const minted: MintedSessionToken = mintSessionToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: minted.tokenHash,
        expiresAt: sessionExpiryFrom(),
      },
    });

    return {
      token: minted.token,
      user: {
        githubId: user.githubId,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        allowed: true,
      },
    };
  }

  /**
   * Resolves a presented opaque session token to its {@link SessionUser}, or
   * `null` when the token is absent/unknown/expired/revoked, OR when the owning
   * user is no longer allowlisted (membership is RE-CONFIRMED here so a
   * de-allowlisted user is denied on their next request). Pure-ish: no mutation
   * except none; the guard (task 2.6) and `GET /auth/session` consume this.
   */
  async resolveSession(
    token: string | undefined | null,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<SessionUser | null> {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }
    const tokenHash = hashSessionToken(token);
    const session = await this.prisma.session.findFirst({
      where: { tokenHash },
      include: { user: true },
    });
    if (!session) {
      return null;
    }
    if (isSessionExpired(session.expiresAt)) {
      return null;
    }

    // Re-confirm allowlist membership at resolution time (fail-closed on removal).
    const stillAllowed = isAllowlistedRaw(session.user.githubId, env[ENV.AUTH_ALLOWLIST]);
    if (!stillAllowed) {
      return null;
    }

    return {
      githubId: session.user.githubId,
      login: session.user.login,
      name: session.user.name,
      avatarUrl: session.user.avatarUrl,
      allowed: true,
    };
  }

  /**
   * Revokes the session identified by a presented opaque token (logout).
   * Deletes the server-side row so a stolen-but-logged-out token can never be
   * replayed. Idempotent: revoking an unknown/already-revoked token is a no-op.
   */
  async revokeSession(token: string | undefined | null): Promise<void> {
    if (typeof token !== 'string' || token.length === 0) {
      return;
    }
    const tokenHash = hashSessionToken(token);
    await this.prisma.session.deleteMany({ where: { tokenHash } });
  }
}
