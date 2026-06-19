import { z } from 'zod';
import { ScopeSchema } from './scope.js';
import { API_KEY_PREFIX } from './credential-prefix.js';

/**
 * API-key management DTOs (api-key-auth spec, task 2.3).
 *
 * The wire shapes for the session-authenticated mint / list / revoke endpoints.
 * A minted key is a per-user, revocable, attributable machine credential stored
 * HASH-ONLY: the raw `cap_sk_…` value is returned to the caller EXACTLY ONCE at
 * creation ({@link ApiKeyMintResponseSchema}) and never again — no list or read
 * shape carries the raw key or its stored hash ({@link ApiKeyListItemSchema}).
 *
 * These are the OPERATOR-facing CRUD shapes only; the resolution path (hashing a
 * presented key, re-confirming the owner's allowlist, yielding the principal)
 * lives in `apps/api` and never returns any of these shapes to a key holder.
 */

// ---------------------------------------------------------------------------
// Mint request
// ---------------------------------------------------------------------------

/**
 * Request body to mint a new API key bound to the caller's own user.
 *
 * `name` is an operator-chosen display label. `scopes` is the granted scope set
 * (an explicit, non-empty selection from the shared vocabulary). `expiresAt` is
 * an OPTIONAL absolute expiry (ISO-8601); omit it for a non-expiring key.
 */
export const ApiKeyMintRequestSchema = z.object({
  /** Operator-chosen display label for the key. */
  name: z.string().min(1).max(200),
  /** Granted scopes — an explicit, non-empty selection from the shared vocabulary. */
  scopes: z.array(ScopeSchema).min(1),
  /** Optional absolute expiry (ISO-8601); omit for a non-expiring key. */
  expiresAt: z.string().datetime().nullable().optional(),
});
export type ApiKeyMintRequest = z.infer<typeof ApiKeyMintRequestSchema>;

// ---------------------------------------------------------------------------
// Mint response (show-once)
// ---------------------------------------------------------------------------

/**
 * Response body returned EXACTLY ONCE at key creation.
 *
 * `key` is the full raw `cap_sk_…` value — the only time it is ever transmitted;
 * the server persists only its SHA-256 hash. The remaining fields are the same
 * non-secret metadata a list entry carries, so the caller can render the new key
 * inline without a follow-up list call.
 */
export const ApiKeyMintResponseSchema = z.object({
  /** The full raw API key (`cap_sk_…`), shown ONCE and never returned again. */
  key: z.string().startsWith(API_KEY_PREFIX),
  /** Stable id of the persisted key record. */
  id: z.string().uuid(),
  /** Operator-chosen display label. */
  name: z.string().min(1),
  /** Granted scopes. */
  scopes: z.array(ScopeSchema),
  /** Public display prefix (the reserved `cap_sk_` marker). */
  prefix: z.string().min(1),
  /** Last 4 characters of the raw key, for disambiguating list entries. */
  last4: z.string().length(4),
  /** Absolute expiry (ISO-8601), or null when the key does not expire. */
  expiresAt: z.string().datetime().nullable(),
});
export type ApiKeyMintResponse = z.infer<typeof ApiKeyMintResponseSchema>;

// ---------------------------------------------------------------------------
// List item (never the raw key or hash)
// ---------------------------------------------------------------------------

/**
 * A single entry in the operator's API-key list. Carries only non-secret
 * metadata — NEITHER the raw key value NOR the stored hash ever appears here.
 *
 * `lastUsedAt`/`expiresAt`/`revokedAt` are nullable: null means never-used /
 * non-expiring / not-revoked respectively. A revoked key remains listed (with a
 * `revokedAt` timestamp) but never resolves to a principal.
 */
export const ApiKeyListItemSchema = z.object({
  /** Stable id of the key record. */
  id: z.string().uuid(),
  /** Operator-chosen display label. */
  name: z.string().min(1),
  /** Granted scopes. */
  scopes: z.array(ScopeSchema),
  /** Public display prefix (the reserved `cap_sk_` marker). */
  prefix: z.string().min(1),
  /** Last 4 characters of the raw key, for disambiguating entries. */
  last4: z.string().length(4),
  /** When the key was last presented on a request, or null if never used. */
  lastUsedAt: z.string().datetime().nullable(),
  /** Absolute expiry (ISO-8601), or null when the key does not expire. */
  expiresAt: z.string().datetime().nullable(),
  /** When the key was revoked, or null when still active. */
  revokedAt: z.string().datetime().nullable(),
});
export type ApiKeyListItem = z.infer<typeof ApiKeyListItemSchema>;

/**
 * Response body for the list endpoint: the caller's own keys, each a
 * {@link ApiKeyListItemSchema} (never a raw key or hash).
 */
export const ApiKeyListResponseSchema = z.object({
  keys: z.array(ApiKeyListItemSchema),
});
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponseSchema>;

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/**
 * Path parameter shape for revoking one of the caller's own keys. Revocation is
 * idempotent and takes effect on the key's next use; a revoked key stays listed
 * with its `revokedAt` timestamp but never resolves to a principal.
 */
export const ApiKeyRevokeParamsSchema = z.object({
  /** Id of the key to revoke. */
  id: z.string().uuid(),
});
export type ApiKeyRevokeParams = z.infer<typeof ApiKeyRevokeParamsSchema>;

/** Response body confirming a revoke: the revoked key's post-revocation list view. */
export const ApiKeyRevokeResponseSchema = z.object({
  key: ApiKeyListItemSchema,
});
export type ApiKeyRevokeResponse = z.infer<typeof ApiKeyRevokeResponseSchema>;
