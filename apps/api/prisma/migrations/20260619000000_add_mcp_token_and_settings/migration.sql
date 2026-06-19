-- remote-mcp-server:
--   Add the per-user remote-MCP machine token table (`mcp_tokens`) plus the
--   `mcp_server_enabled` gate column on the single-row `system_settings`.
--
-- `mcp_tokens` mirrors `api_keys` (hash-only, owner-scoped, scoped, revocable,
-- show-once) but carries the reserved `mcp_` prefix so the MCP audience stays a
-- distinct principal from the `cap_sk_` api key. Only the SHA-256 `token_hash`
-- (UNIQUE), the non-secret `prefix`/`last4`, the operator `name`, the `scopes`
-- text[], and the lifecycle timestamps are persisted — never the raw token. The
-- FK references `users.id` and cascades on user delete, like every other
-- per-user credential.
--
-- The `mcp_server_enabled` column is purely additive and DEFAULTs FALSE, so the
-- existing single `system_settings` row (if any) backfills to the inert state
-- and the remote MCP surface ships off until an admin enables it. No existing
-- tables or rows are otherwise altered.

-- CreateTable
CREATE TABLE "mcp_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[],
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tokens_token_hash_key" ON "mcp_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "mcp_tokens_user_id_idx" ON "mcp_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN "mcp_server_enabled" BOOLEAN NOT NULL DEFAULT false;
