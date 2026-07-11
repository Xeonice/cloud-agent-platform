-- Persist task ownership and the winner of each admission lifecycle CAS in the
-- same durable row as task creation. Separate queued/running tokens preserve the
-- queued winner even after a later promotion, which makes an ambiguous database
-- acknowledgement recoverable without guessing who may provision.
ALTER TABLE "tasks"
ADD COLUMN "owner_user_id" TEXT,
ADD COLUMN "queued_admission_token" TEXT,
ADD COLUMN "running_admission_token" TEXT;

UPDATE "tasks" AS task
SET "owner_user_id" = owner_event."user_id"
FROM (
  SELECT DISTINCT ON ("task_id") "task_id", "user_id"
  FROM "audit_events"
  WHERE "type" = 'task.created' AND "user_id" IS NOT NULL
  ORDER BY "task_id", "timestamp" ASC, "id" ASC
) AS owner_event
WHERE task."id" = owner_event."task_id";

-- A scheduled task can be committed before task.created audit recording. Recover
-- its canonical owner from the durable run -> schedule relationship when audit
-- history is absent.
UPDATE "tasks" AS task
SET "owner_user_id" = schedule."owner_user_id"
FROM "task_schedule_runs" AS run
JOIN "task_schedules" AS schedule ON schedule."id" = run."schedule_id"
WHERE run."task_id" = task."id"
  AND task."owner_user_id" IS NULL;

CREATE INDEX "tasks_owner_user_id_idx" ON "tasks"("owner_user_id");

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_owner_user_id_fkey"
FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Make only the singular creation event idempotent; other audit events retain
-- append-only semantics because PostgreSQL permits multiple NULL unique values.
ALTER TABLE "audit_events" ADD COLUMN "dedupe_key" TEXT;

UPDATE "audit_events" AS event
SET "dedupe_key" = 'task.created:' || event."task_id"
FROM (
  SELECT DISTINCT ON ("task_id") "id"
  FROM "audit_events"
  WHERE "type" = 'task.created'
  ORDER BY "task_id", "timestamp" ASC, "id" ASC
) AS canonical
WHERE event."id" = canonical."id";

CREATE UNIQUE INDEX "audit_events_dedupe_key_key" ON "audit_events"("dedupe_key");

-- Admission recovery is leased per occurrence so one pending run cannot freeze
-- the owning schedule's future cadence.
ALTER TABLE "task_schedule_runs"
ADD COLUMN "admission_claim_token" TEXT,
ADD COLUMN "admission_claim_until" TIMESTAMP(3);

UPDATE "task_schedule_runs" AS run
SET
  "admission_claim_token" = schedule."claim_token" || ':' || run."id",
  "admission_claim_until" = schedule."claim_until"
FROM "task_schedules" AS schedule, "tasks" AS task
WHERE run."schedule_id" = schedule."id"
  AND run."task_id" = task."id"
  AND run."status" = 'created'
  AND task."status" = 'pending'
  AND schedule."claim_token" IS NOT NULL
  AND schedule."claim_until" IS NOT NULL;

CREATE INDEX "task_schedule_runs_status_admission_claim_until_idx"
ON "task_schedule_runs"("status", "admission_claim_until");
