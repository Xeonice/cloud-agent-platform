import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  API_KEY_PREFIX,
  type ApiKeyListItem,
  type ApiKeyMintRequest,
  type ApiKeyMintResponse,
  type Scope,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { hashSessionToken } from '../auth/session-token';

/**
 * API-key CRUD service (api-key-machine-identity, tasks 5.1 / 5.3).
 *
 * Mints, lists, and revokes the per-user, revocable, attributable MACHINE
 * credentials whose resolution path lives in {@link AuthSessionService.resolveApiKey}
 * (auth-core, task 4.1). This service owns only the OPERATOR-facing management
 * side; it is reached exclusively by a human SESSION principal (the
 * controller rejects any `api-key`/legacy/mcp principal, so a key can never mint
 * another key — no escalation chain, task 5.3).
 *
 * Every method is scoped to a single account by the caller's account primary key
 * `userId` (the `ApiKey.userId` FK directly — no reverse lookup), which is present
 * for BOTH local (password/OTP) and GitHub accounts (fix-local-account-api-keys-scope):
 * the body/path can never name a different account, and list/revoke only ever
 * touch the caller's own keys.
 *
 * Storage discipline (hash-only) — the load-bearing secret-handling property:
 *   - the raw `cap_sk_<random>` key is generated from `randomBytes(32).base64url`
 *     (≥256 bits of entropy, so the plain SHA-256 the resolver hashes with is
 *     sound) and returned to the caller EXACTLY ONCE by {@link mint};
 *   - only the SHA-256 HASH of the raw key is persisted (via the SAME
 *     {@link hashSessionToken} the resolver re-hashes a presented key with, so a
 *     minted key resolves), alongside the non-secret `prefix`/`last4` for display;
 *   - NO read path ({@link list}/{@link revoke}) ever returns the raw key OR the
 *     stored hash — list items carry only non-secret metadata.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mints a new API key bound to the caller's own user and returns the raw key
   * EXACTLY ONCE.
   *
   * The raw key body is `randomBytes(32).base64url` (high-entropy) carrying the
   * reserved {@link API_KEY_PREFIX}; the server persists ONLY its SHA-256 hash,
   * never the raw value. The response is the only time the full `cap_sk_…` value
   * is ever transmitted — a later list/read shape can never recover it.
   */
  async mint(userId: string, body: ApiKeyMintRequest): Promise<ApiKeyMintResponse> {
    // High-entropy random body so the plain SHA-256 storage hash is sound (no slow
    // KDF needed), identical to the session-token justification. The reserved
    // prefix makes the issued key dispatch-routable to the api-key resolver.
    const rawKey = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const last4 = rawKey.slice(-4);
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

    const record = await this.prisma.apiKey.create({
      data: {
        userId,
        // Store ONLY the hash — the same primitive the resolver re-hashes a
        // presented key with, so a freshly minted key resolves on its next use.
        tokenHash: hashSessionToken(rawKey),
        prefix: API_KEY_PREFIX,
        last4,
        name: body.name,
        scopes: body.scopes,
        expiresAt,
      },
    });

    return {
      // The raw key, shown ONCE and never persisted or returned again.
      key: rawKey,
      id: record.id,
      name: record.name,
      scopes: record.scopes as Scope[],
      prefix: record.prefix,
      last4: record.last4,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    };
  }

  /**
   * Lists the caller's own API keys as non-secret metadata. NEITHER the raw key
   * value NOR the stored hash appears in any entry. Newest first.
   */
  async list(userId: string): Promise<ApiKeyListItem[]> {
    const records = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return records.map((record) => this.toListItem(record));
  }

  /**
   * Revokes one of the caller's own keys by stamping `revokedAt` (idempotent:
   * an already-revoked key keeps its original timestamp; the call still succeeds).
   * A revoked key stays listed (with its `revokedAt`) but never resolves to a
   * principal again. Returns the key's post-revocation list view. Throws 404 when
   * the id is unknown OR owned by a different account (never reveals another
   * account's key existence).
   */
  async revoke(userId: string, keyId: string): Promise<ApiKeyListItem> {
    const existing = await this.prisma.apiKey.findFirst({
      where: { id: keyId, userId },
    });
    if (!existing) {
      throw new NotFoundException(`No API key ${keyId} for this account`);
    }

    // Idempotent: revoke once, then leave the original timestamp untouched on
    // subsequent calls so the revocation instant is stable.
    const record =
      existing.revokedAt !== null
        ? existing
        : await this.prisma.apiKey.update({
            where: { id: existing.id },
            data: { revokedAt: new Date() },
          });

    return this.toListItem(record);
  }

  /**
   * Projects a persisted key row into the non-secret list shape. By construction
   * this NEVER reads `tokenHash` — the stored hash and the raw key are both
   * absent from every list/read response.
   */
  private toListItem(record: {
    id: string;
    name: string;
    scopes: string[];
    prefix: string;
    last4: string;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  }): ApiKeyListItem {
    return {
      id: record.id,
      name: record.name,
      scopes: record.scopes as Scope[],
      prefix: record.prefix,
      last4: record.last4,
      lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
      revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
    };
  }
}
