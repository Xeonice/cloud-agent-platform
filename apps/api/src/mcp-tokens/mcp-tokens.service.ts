import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type {
  McpTokenListItem,
  McpTokenMintResponse,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The granted-scope element type, derived from the contract list shape so this
 * module needs no separate `Scope` export (the DB column is an untyped
 * `String[]`; scopes are validated against `ScopeSchema` at the mint wire, so a
 * persisted value narrows back to this on projection).
 */
type Scope = McpTokenListItem['scopes'][number];

/**
 * Settings-minted MCP-token service (remote-mcp-server, task 3.1).
 *
 * An `mcp_` token is the credential an operator pastes into their MCP client's
 * `Authorization` header. It is an `ApiKey` near-clone — owner-scoped, scoped,
 * revocable, and stored HASH-ONLY (the raw value is returned EXACTLY ONCE at
 * mint and never again). Mirroring {@link AuthSessionService}, the SHA-256 hash
 * is the only server-side representation, so a database read can never recover a
 * usable credential.
 *
 * Trust-domain separation (D1): a distinct `McpToken` model + the reserved
 * `mcp_` prefix keeps the MCP audience (`mcp` principal) separate from both the
 * human `session` operator and the `cap_sk_` API-key principal, so MCP tokens
 * are listed/revoked independently in their own settings card.
 *
 * This service owns the CREDENTIAL lifecycle only (mint / list / revoke). The
 * RESOLUTION path (hashing a presented token, re-confirming the owner's DB
 * `allowed` gate, yielding an `mcp` principal with a full SDK `AuthInfo`) lives in
 * {@link AuthSessionService.resolveMcpToken} so the security-critical resolve
 * decision sits next to `resolveSession` in the auth core.
 */
@Injectable()
export class McpTokensService {
  private readonly logger = new Logger(McpTokensService.name);

  /**
   * The reserved, non-secret credential prefix marking an MCP token. Persisted
   * on the record for display and used to route a presented bearer to
   * `resolveMcpToken` (never to the session/legacy/api-key domains).
   */
  static readonly TOKEN_PREFIX = 'mcp_';

  /** Bytes of entropy in the random token body (256-bit). */
  private static readonly TOKEN_BYTES = 32;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mints a new MCP token bound to the owning operator (the account primary key
   * `userId`), returning the raw `mcp_…` value EXACTLY ONCE (the
   * {@link McpTokenMintResponse} the operator pastes into their client). The body
   * is `randomBytes(32).base64url`; only the SHA-256 hash is persisted, alongside
   * the display `prefix` + `last4` and the granted scopes.
   *
   * Ordering mirrors the session-mint point: compute the secret, then persist
   * ONLY its hash — the raw token is never written to the database. The token is
   * bound to the caller's OWN user row (the FK `userId`), so an operator can only
   * ever mint tokens for themselves. The `userId` is the account primary key
   * supplied by the controller from the guard-attached session principal (present
   * for BOTH local and GitHub accounts), never a client-named value.
   */
  async mint(
    userId: string,
    input: { name: string; scopes: string[]; expiresAt?: string | null },
  ): Promise<McpTokenMintResponse> {
    const body = randomBytes(McpTokensService.TOKEN_BYTES).toString('base64url');
    const raw = `${McpTokensService.TOKEN_PREFIX}${body}`;
    const tokenHash = hashMcpToken(raw);
    const last4 = raw.slice(-4);
    const expiresAt =
      input.expiresAt != null ? new Date(input.expiresAt) : null;

    const record = await this.prisma.mcpToken.create({
      data: {
        userId,
        tokenHash,
        prefix: McpTokensService.TOKEN_PREFIX,
        last4,
        name: input.name,
        scopes: input.scopes,
        expiresAt,
      },
    });

    // Return the raw token ONCE. No read path ever surfaces it again. The DB
    // column is an untyped `String[]`; the granted scopes were validated against
    // `ScopeSchema` at the wire (the mint pipe), so they narrow to `Scope[]`.
    return {
      token: raw,
      id: record.id,
      name: record.name,
      scopes: record.scopes as Scope[],
      prefix: record.prefix,
      last4: record.last4,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    };
  }

  /**
   * Lists the caller's own MCP tokens as non-secret metadata only (prefix +
   * last4, scopes, lifecycle timestamps). NEITHER the raw token NOR the stored
   * hash is ever projected, so a list response can never leak a usable
   * credential. A revoked token stays listed with its `revokedAt` timestamp.
   */
  async list(userId: string): Promise<McpTokenListItem[]> {
    const rows = await this.prisma.mcpToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row: McpTokenRow) => toListItem(row));
  }

  /**
   * Revokes one of the caller's own MCP tokens by id (idempotent). Scoping the
   * update to `{ id, userId }` means a caller can only revoke their OWN token;
   * re-revoking (or revoking an unknown id) is a no-op that leaves any existing
   * `revokedAt` untouched. Returns the post-revocation list view, or `null` when
   * no such token belongs to the caller.
   */
  async revoke(userId: string, id: string): Promise<McpTokenListItem | null> {
    const existing = await this.prisma.mcpToken.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return null;
    }
    // Idempotent: only stamp `revokedAt` the first time; preserve the original
    // revocation instant on a repeat call.
    const revoked = existing.revokedAt
      ? existing
      : await this.prisma.mcpToken.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
        });
    return toListItem(revoked);
  }
}

/**
 * Hashes a presented raw MCP token into its stored representation. A plain
 * SHA-256 is sufficient (and matches {@link hashSessionToken}) because the input
 * is high-entropy random bytes, so a slow KDF buys nothing.
 */
export function hashMcpToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** The persisted MCP-token columns this module reads (a structural subset). */
interface McpTokenRow {
  id: string;
  name: string;
  scopes: string[];
  prefix: string;
  last4: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Projects a persisted row into the non-secret {@link McpTokenListItem} wire
 * shape — never the raw token or its hash.
 */
function toListItem(row: McpTokenRow): McpTokenListItem {
  return {
    id: row.id,
    name: row.name,
    // The DB column is an untyped `String[]`; scopes were validated against
    // `ScopeSchema` at mint, so they narrow to the contract `Scope[]`.
    scopes: row.scopes as Scope[],
    prefix: row.prefix,
    last4: row.last4,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}
