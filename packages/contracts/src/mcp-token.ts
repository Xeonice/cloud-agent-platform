import { z } from 'zod';
import { ScopeSchema } from './scope.js';
import { MCP_TOKEN_PREFIX } from './credential-prefix.js';

/**
 * MCP-token management DTOs (remote-mcp-server spec, task 2.1).
 *
 * The wire shapes for the session-authenticated mint / list / revoke endpoints
 * of the settings-minted MCP credential. An `mcp_` token is a per-user,
 * revocable, attributable MACHINE credential stored HASH-ONLY: the raw
 * `mcp_…` value is returned to the caller EXACTLY ONCE at creation
 * ({@link McpTokenMintResponseSchema}) and never again — no list or read shape
 * carries the raw token or its stored hash ({@link McpTokenListItemSchema}).
 *
 * This DELIBERATELY mirrors the API-key CRUD shapes (`./api-key.ts`) — the
 * `McpToken` model is an `ApiKey` near-clone (hash-only, owner-scoped, scoped,
 * revocable, show-once) — but is a DISTINCT contract so the two audiences stay
 * separate: the `mcp_` prefix yields an `mcp` principal listed/revoked in its
 * own settings card, never confused with the `cap_sk_` API-key principal.
 *
 * These are the OPERATOR-facing CRUD shapes only; the resolution path (hashing a
 * presented token, re-confirming the owner's allowlist, yielding the `mcp`
 * principal) lives in `apps/api` and never returns any of these shapes to a
 * token holder.
 */

// ---------------------------------------------------------------------------
// Mint request
// ---------------------------------------------------------------------------

/**
 * Request body to mint a new MCP token bound to the caller's own user.
 *
 * `name` is an operator-chosen display label. `scopes` is the granted scope set
 * (an explicit, non-empty selection from the shared vocabulary). `expiresAt` is
 * an OPTIONAL absolute expiry (ISO-8601); omit it for a non-expiring token.
 */
export const McpTokenMintRequestSchema = z.object({
  /** Operator-chosen display label for the token. */
  name: z.string().min(1).max(200),
  /** Granted scopes — an explicit, non-empty selection from the shared vocabulary. */
  scopes: z.array(ScopeSchema).min(1),
  /** Optional absolute expiry (ISO-8601); omit for a non-expiring token. */
  expiresAt: z.string().datetime().nullable().optional(),
});
export type McpTokenMintRequest = z.infer<typeof McpTokenMintRequestSchema>;

// ---------------------------------------------------------------------------
// Mint response (show-once)
// ---------------------------------------------------------------------------

/**
 * Response body returned EXACTLY ONCE at token creation.
 *
 * `token` is the full raw `mcp_…` value — the only time it is ever transmitted;
 * the server persists only its SHA-256 hash. The remaining fields are the same
 * non-secret metadata a list entry carries, so the caller can render the new
 * token inline (and paste it into the MCP client `Authorization` header) without
 * a follow-up list call.
 */
export const McpTokenMintResponseSchema = z.object({
  /** The full raw MCP token (`mcp_…`), shown ONCE and never returned again. */
  token: z.string().startsWith(MCP_TOKEN_PREFIX),
  /** Stable id of the persisted token record. */
  id: z.string().uuid(),
  /** Operator-chosen display label. */
  name: z.string().min(1),
  /** Granted scopes. */
  scopes: z.array(ScopeSchema),
  /** Public display prefix (the reserved `mcp_` marker). */
  prefix: z.string().min(1),
  /** Last 4 characters of the raw token, for disambiguating list entries. */
  last4: z.string().length(4),
  /** Absolute expiry (ISO-8601), or null when the token does not expire. */
  expiresAt: z.string().datetime().nullable(),
});
export type McpTokenMintResponse = z.infer<typeof McpTokenMintResponseSchema>;

// ---------------------------------------------------------------------------
// List item (never the raw token or hash)
// ---------------------------------------------------------------------------

/**
 * A single entry in the operator's MCP-token list. Carries only non-secret
 * metadata — NEITHER the raw token value NOR the stored hash ever appears here.
 *
 * `lastUsedAt`/`expiresAt`/`revokedAt` are nullable: null means never-used /
 * non-expiring / not-revoked respectively. A revoked token remains listed (with
 * a `revokedAt` timestamp) but never resolves to a principal.
 */
export const McpTokenListItemSchema = z.object({
  /** Stable id of the token record. */
  id: z.string().uuid(),
  /** Operator-chosen display label. */
  name: z.string().min(1),
  /** Granted scopes. */
  scopes: z.array(ScopeSchema),
  /** Public display prefix (the reserved `mcp_` marker). */
  prefix: z.string().min(1),
  /** Last 4 characters of the raw token, for disambiguating entries. */
  last4: z.string().length(4),
  /** When the token was last presented on a request, or null if never used. */
  lastUsedAt: z.string().datetime().nullable(),
  /** Absolute expiry (ISO-8601), or null when the token does not expire. */
  expiresAt: z.string().datetime().nullable(),
  /** When the token was revoked, or null when still active. */
  revokedAt: z.string().datetime().nullable(),
});
export type McpTokenListItem = z.infer<typeof McpTokenListItemSchema>;

/**
 * Response body for the list endpoint: the caller's own MCP tokens, each a
 * {@link McpTokenListItemSchema} (never a raw token or hash).
 */
export const McpTokenListResponseSchema = z.object({
  tokens: z.array(McpTokenListItemSchema),
});
export type McpTokenListResponse = z.infer<typeof McpTokenListResponseSchema>;

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/**
 * Path parameter shape for revoking one of the caller's own MCP tokens.
 * Revocation is idempotent and takes effect on the token's next use; a revoked
 * token stays listed with its `revokedAt` timestamp but never resolves to a
 * principal.
 */
export const McpTokenRevokeParamsSchema = z.object({
  /** Id of the token to revoke. */
  id: z.string().uuid(),
});
export type McpTokenRevokeParams = z.infer<typeof McpTokenRevokeParamsSchema>;

/** Response body confirming a revoke: the revoked token's post-revocation list view. */
export const McpTokenRevokeResponseSchema = z.object({
  token: McpTokenListItemSchema,
});
export type McpTokenRevokeResponse = z.infer<typeof McpTokenRevokeResponseSchema>;
