-- Durable scheduled-task definitions and per-occurrence run ledger.
-- Schedules are separate from TaskStatus; each successful fire creates an
-- ordinary task and links it through task_schedule_runs.task_id.

CREATE TABLE "task_schedules" (
    "id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "name" TEXT,
    "task_template" JSONB NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3),
    "overlap_policy" TEXT NOT NULL DEFAULT 'skip',
    "misfire_policy" TEXT NOT NULL DEFAULT 'fire-once',
    "claim_token" TEXT,
    "claim_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_schedule_runs" (
    "id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "task_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_schedule_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_schedules_owner_user_id_created_at_id_idx"
  ON "task_schedules"("owner_user_id", "created_at", "id");

CREATE INDEX "task_schedules_enabled_next_run_at_idx"
  ON "task_schedules"("enabled", "next_run_at");

CREATE INDEX "task_schedules_claim_until_idx"
  ON "task_schedules"("claim_until");

CREATE UNIQUE INDEX "task_schedule_runs_task_id_key"
  ON "task_schedule_runs"("task_id");

CREATE UNIQUE INDEX "task_schedule_runs_schedule_id_scheduled_for_key"
  ON "task_schedule_runs"("schedule_id", "scheduled_for");

CREATE INDEX "task_schedule_runs_schedule_id_scheduled_for_id_idx"
  ON "task_schedule_runs"("schedule_id", "scheduled_for", "id");

CREATE INDEX "task_schedule_runs_status_idx"
  ON "task_schedule_runs"("status");

ALTER TABLE "task_schedules"
  ADD CONSTRAINT "task_schedules_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_schedules"
  ADD CONSTRAINT "task_schedules_repo_id_fkey"
  FOREIGN KEY ("repo_id") REFERENCES "repos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_schedule_runs"
  ADD CONSTRAINT "task_schedule_runs_schedule_id_fkey"
  FOREIGN KEY ("schedule_id") REFERENCES "task_schedules"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_schedule_runs"
  ADD CONSTRAINT "task_schedule_runs_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
