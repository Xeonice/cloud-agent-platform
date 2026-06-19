-- public-v1-api:
--   add the per-principal `idempotency_keys` dedup table backing
--   `POST /v1/tasks`'s optional `Idempotency-Key` header. The dedup row is
--   INSERTED in the SAME transaction as the `tasks` create, so a raced retry can
--   never double-admit a sandbox: the UNIQUE (`scope_user_id`, `key`) makes the
--   second insert fail and the handler returns the already-recorded `task_id`.
--   `request_hash` lets a reused key carrying a DIFFERENT body be rejected (409);
--   `expires_at` bounds the dedup window to 24h.
--
-- Purely ADDITIVE and forward-only: a new table + its indexes + an FK to
-- `tasks`. No existing table is touched and no row is backfilled, so the first
-- boot after deploy is behavior-unchanged until the `/v1` create path writes.
-- `scope_user_id` is a plain scoped identifier (per-principal), intentionally NOT
-- an FK to `users` — the principal kind is not guaranteed to be a `users.id` row.
-- Rollback is a clean `DROP TABLE "idempotency_keys"` (which cascades its unique
-- index, the secondary indexes, and the FK constraint).

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope_user_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_task_id_idx" ON "idempotency_keys"("task_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_user_id_key_key" ON "idempotency_keys"("scope_user_id", "key");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
