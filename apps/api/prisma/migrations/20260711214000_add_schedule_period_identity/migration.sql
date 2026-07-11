-- Period-aware dispatch keeps one durable outcome per schedule period while
-- preserving historical run rows whose manual `scheduled_for` represented the
-- click time rather than a canonical period.
ALTER TABLE "task_schedule_runs"
ADD COLUMN "period_key" TEXT,
ADD COLUMN "trigger_source" TEXT,
ADD COLUMN "triggered_at" TIMESTAMP(3);

ALTER TABLE "task_schedule_runs"
ADD CONSTRAINT "task_schedule_runs_trigger_source_check"
CHECK ("trigger_source" IS NULL OR "trigger_source" IN ('manual', 'automatic'));

-- PostgreSQL permits multiple NULL values in a unique index, so legacy rows stay
-- nullable while every new populated period converges on one ledger outcome.
CREATE UNIQUE INDEX "task_schedule_runs_schedule_id_period_key_key"
ON "task_schedule_runs"("schedule_id", "period_key");
