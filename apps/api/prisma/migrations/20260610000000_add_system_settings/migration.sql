-- configurable-task-slots:
--   add the single-row `system_settings` table holding system-wide operator
--   settings shared by every account (currently just the task concurrency
--   ceiling `max_concurrent_tasks`, contracts-constrained to 1–20). The
--   service layer addresses the one row via a FIXED-id upsert, so at most one
--   row ever exists.
--
-- Purely additive — no backfill row is inserted: absence of the row means the
-- env seed applies, i.e. the effective ceiling resolves as
-- `dbSetting ?? env MAX_CONCURRENT_TASKS ?? 5`, so first boot after deploy is
-- behavior-unchanged until an operator saves.
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "max_concurrent_tasks" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);
