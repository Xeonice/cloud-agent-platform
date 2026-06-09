-- task-guardrail-controls:
--   1) add the `cancelled` terminal status (operator-initiated stop) to the
--      TaskStatus enum, distinct from `completed` (clean exit) and `failed`.
--   2) add the optional per-task guardrail columns `idle_timeout_ms` /
--      `deadline_ms` (nullable; null = no idle reclaim / no deadline — opt-in).
--
-- The enum value is added ahead of the column adds and is NOT referenced within
-- this migration, so it is safe alongside them on PostgreSQL 12+ (a newly added
-- enum value may not be USED in the same transaction, but adding it is fine).
-- `IF NOT EXISTS` + `BEFORE` keep the add idempotent and matched to the schema's
-- declared value order.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'cancelled' BEFORE 'agent_failed_to_start';

-- Nullable guardrail columns. Existing rows backfill to NULL (no idle ceiling /
-- no deadline), and omitted-on-create reads back as null — never fabricated.
ALTER TABLE "tasks" ADD COLUMN "idle_timeout_ms" INTEGER;
ALTER TABLE "tasks" ADD COLUMN "deadline_ms" INTEGER;
