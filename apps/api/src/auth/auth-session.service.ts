import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Scope, SessionUser } from '@cap/contracts';
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
 * A successfully-resolved API key: the owning {@link SessionUser}, the key's
 * granted authorization {@link Scope}s, and the key id (for audit/attribution).
 * Returned by {@link AuthSessionService.resolveApiKey} and lifted onto the
 * operator principal as the `'api-key'` kind.
 */
export interface ResolvedApiKey {
  readonly user: SessionUser;
  readonly scopes: Scope[];
  readonly keyId: string;
}

/**
 * The canonical RFC 8707 resource identifier the resolved {@link McpAuthInfo}
 * carries — a fixed `/mcp` URI (no OAuth audience negotiation in the
 * settings-minted model). The SDK transport advertises the same resource so the
 * `requireBearerAuth` resource match holds.
 */
export const MCP_RESOURCE_URI = 'cap:mcp';

/**
 * The validated-access-token shape the SDK `requireBearerAuth` consumes
 * (`AuthInfo`), narrowed to the fields {@link AuthSessionService.resolveMcpToken}
 * populates. `expiresAt` is seconds-since-epoch and is MANDATORY (G1): the SDK
 * rejects a token whose `expiresAt` is unset and would 401 every valid token.
 * Mirrors `@modelcontextprotocol/sdk/server/auth/types.js#AuthInfo` without
 * importing it, so the auth core stays free of an SDK type dependency.
 */
export interface McpAuthInfo {
  /** The presented raw access token. */
  readonly token: string;
  /** The client id this credential is attributed to (the settings-minted model). */
  readonly clientId: string;
  /** The token's granted scopes, carried onto the resolved `mcp` principal. */
  readonly scopes: string[];
  /** Absolute expiry in SECONDS since epoch — MANDATORY (G1), never unset. */
  readonly expiresAt: number;
  /** The canonical `/mcp` resource URI this token is valid for. */
  readonly resource: string;
  /** The owning operator's immutable GitHub numeric id (for the `mcp` principal). */
  readonly ownerGithubId: number;
}

/**
 * Throttle window for the best-effort `lastUsedAt` bump: a key used again within
 * this window of its last recorded use skips the write. Keeps the hot auth path
 * from issuing a DB write on every single request for a busy key while still
 * surfacing a usefully-fresh "last used" timestamp.
 */
const LAST_USED_STALENESS_MS = 60_000;

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
   * Resolves a presented raw API key (`cap_sk_…`) to its owner + granted scopes,
   * or `null` when nothing authenticates. This MIRRORS {@link resolveSession}
   * exactly — hash → lookup → expiry → allowlist re-check — so an API key inherits
   * the same load-bearing per-request allowlist re-confirmation a session has: a
   * de-allowlisted owner's keys stop working on their very next call.
   *
   * Resolution fails closed (returns `null`) when the key is:
   *   - absent/empty or unknown (hash miss);
   *   - revoked (`revokedAt` set);
   *   - expired (`expiresAt` in the past);
   *   - owned by a user no longer on the allowlist (RE-CONFIRMED here).
   *
   * The presented key is hashed with the SAME plain SHA-256 used for sessions —
   * sound because the key body is high-entropy `randomBytes(32).base64url` (a slow
   * KDF buys nothing over high-entropy input), identical to the session-token
   * justification.
   *
   * On success the owner becomes the principal's `user` and the key's stored
   * `scopes` are returned verbatim (the route boundary enforces them). The
   * `lastUsedAt` bump is fired BEST-EFFORT and async (see {@link bumpLastUsedAt}):
   * it is staleness-throttled and never awaited, so a write failure or latency on
   * the audit column can never block or fail the hot auth path.
   */
  async resolveApiKey(
    raw: string | undefined | null,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ResolvedApiKey | null> {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    const tokenHash = hashSessionToken(raw);
    const key = await this.prisma.apiKey.findFirst({
      where: { tokenHash },
      include: { user: true },
    });
    if (!key) {
      return null;
    }
    // Revoked or expired keys never resolve (revocation/expiry take effect on the
    // key's next use). `expiresAt` is optional; only enforce it when present.
    if (key.revokedAt !== null) {
      return null;
    }
    if (key.expiresAt !== null && isSessionExpired(key.expiresAt)) {
      return null;
    }

    // Re-confirm allowlist membership at resolution time (fail-closed on removal),
    // exactly as resolveSession does for sessions.
    const stillAllowed = isAllowlistedRaw(key.user.githubId, env[ENV.AUTH_ALLOWLIST]);
    if (!stillAllowed) {
      return null;
    }

    // Best-effort, async, staleness-throttled lastUsedAt bump. Deliberately NOT
    // awaited so it never blocks or fails the auth path.
    this.bumpLastUsedAt(key.id, key.lastUsedAt);

    return {
      user: {
        githubId: key.user.githubId,
        login: key.user.login,
        name: key.user.name,
        avatarUrl: key.user.avatarUrl,
        allowed: true,
      },
      // `scopes` is persisted as `String[]`; the shared ScopeSchema vocabulary is
      // enforced at mint time, so the stored values are the granted Scope set.
      scopes: key.scopes as Scope[],
      keyId: key.id,
    };
  }

  /**
   * Best-effort, fire-and-forget `lastUsedAt` bump for a resolved API key.
   *
   * Staleness-throttled: skips the write entirely when the recorded `lastUsedAt`
   * is younger than {@link LAST_USED_STALENESS_MS}, so a key hammered in a tight
   * loop writes at most once per window instead of once per request. The promise
   * is intentionally swallowed (logged at debug) — a failure here is an audit
   * nicety, never an authentication outcome, so it must not surface to the caller.
   */
  private bumpLastUsedAt(keyId: string, lastUsedAt: Date | null): void {
    const now = Date.now();
    if (lastUsedAt !== null && now - lastUsedAt.getTime() < LAST_USED_STALENESS_MS) {
      return; // throttled: a recent enough bump already stands.
    }
    void this.prisma.apiKey
      .update({ where: { id: keyId }, data: { lastUsedAt: new Date(now) } })
      .catch((error) => {
        this.logger.debug(
          `lastUsedAt bump failed for api key ${keyId} (non-fatal): ${String(error)}`,
        );
      });
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

  /**
   * Resolves a presented raw `mcp_` token into a FULL {@link McpAuthInfo}
   * (remote-mcp-server, task 3.2), or `null` when the token is
   * absent/unknown/revoked/expired OR the owning user is no longer allowlisted.
   *
   * The pipeline mirrors `resolveApiKey` and re-uses the same fail-closed
   * primitives as {@link resolveSession}:
   *   1. hash the raw token (SHA-256) and `findUnique` on the unique `tokenHash`;
   *   2. reject a revoked token (`revokedAt` set) or an expired one
   *      (`expiresAt <= now`);
   *   3. RE-CONFIRM the owner's allowlist membership on the immutable GitHub id
   *      (`isAllowlistedRaw`) on EVERY call — never cached — so de-allowlisting
   *      denies the token on its very next request;
   *   4. return a FULL `AuthInfo`: `{ token, clientId, scopes, expiresAt,
   *      resource }` plus the owner's GitHub id for the `mcp` principal.
   *
   * G1 — `expiresAt` is MANDATORY and seconds-since-epoch: the SDK
   * `requireBearerAuth` rejects an `AuthInfo` with an unset `expiresAt`, which
   * would 401 EVERY valid token. A token with no stored expiry is given a far
   * future bound so a valid, non-revoked token still resolves (its real
   * lifecycle is governed by revocation + the allowlist re-check, not the
   * synthetic bound).
   *
   * `lastUsedAt` is bumped BEST-EFFORT / asynchronously: a failed or slow update
   * must never deny an otherwise-valid token, so the bump is fire-and-forget and
   * its result is not awaited by the resolution decision.
   */
  async resolveMcpToken(
    rawToken: string | undefined | null,
    env: NodeJS.ProcessEnv = process.env,
    now: Date = new Date(),
  ): Promise<McpAuthInfo | null> {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      return null;
    }
    const tokenHash = hashMcpTokenValue(rawToken);
    const record = await this.prisma.mcpToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!record) {
      return null;
    }

    // Reject revoked / expired tokens (treated as unauthenticated, like an
    // expired session). Expiry is inclusive at the boundary.
    if (record.revokedAt != null) {
      return null;
    }
    if (record.expiresAt != null && record.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    // RE-CONFIRM allowlist membership at resolution time (fail-closed on removal),
    // keyed on the immutable numeric GitHub id — identical to resolveSession.
    const stillAllowed = isAllowlistedRaw(
      record.user.githubId,
      env[ENV.AUTH_ALLOWLIST],
    );
    if (!stillAllowed) {
      return null;
    }

    // Best-effort, non-blocking last-use bump. Never gate the resolution on it.
    void this.prisma.mcpToken
      .update({ where: { id: record.id }, data: { lastUsedAt: now } })
      .catch((error: unknown) => {
        this.logger.debug(
          `mcp-token lastUsedAt bump failed for id=${record.id}: ${String(error)}`,
        );
      });

    return {
      token: rawToken,
      clientId: 'settings',
      scopes: record.scopes,
      // G1: full AuthInfo with a MANDATORY seconds-since-epoch expiresAt. A
      // never-expiring token gets a far-future bound so requireBearerAuth admits
      // it (its real revocation is the allowlist re-check + revokedAt above).
      expiresAt: record.expiresAt
        ? Math.floor(record.expiresAt.getTime() / 1000)
        : MCP_NON_EXPIRING_AUTHINFO_EXPIRES_AT,
      resource: MCP_RESOURCE_URI,
      ownerGithubId: record.user.githubId,
    };
  }
}

/**
 * A far-future absolute bound (seconds since epoch) used as the `AuthInfo`
 * `expiresAt` for a token with NO stored expiry, so the SDK `requireBearerAuth`
 * admits it (G1: an unset `expiresAt` would 401 every valid token). Year-9999;
 * the token's REAL lifecycle is governed by `revokedAt` + the per-request
 * allowlist re-check, not by this synthetic bound.
 */
const MCP_NON_EXPIRING_AUTHINFO_EXPIRES_AT = Math.floor(
  Date.UTC(9999, 0, 1) / 1000,
);

/**
 * Hashes a presented raw `mcp_` token into its stored representation. SHA-256
 * over the high-entropy token body — identical discipline to
 * {@link hashSessionToken} (a slow KDF buys nothing for random bytes).
 */
function hashMcpTokenValue(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}
