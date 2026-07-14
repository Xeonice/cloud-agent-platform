-- Requested runtime model intent and its exact non-secret execution snapshot.
-- Existing tasks remain NULL/NULL and retain runtime-default behavior.
ALTER TABLE "sandbox_environment_validations"
ADD COLUMN "resolved_locator" TEXT,
ADD COLUMN "runtime_artifact_checksums" JSONB,
ADD COLUMN "cli_artifact_checksum" TEXT;

ALTER TABLE "tasks"
ADD COLUMN "model" TEXT,
ADD COLUMN "execution_environment_snapshot" JSONB;

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_model_selector_check"
CHECK (
  "model" IS NULL OR (
    octet_length("model") BETWEEN 1 AND 2048 AND
    "model" = btrim("model") AND
    "model" !~ '[[:cntrl:]]'
  )
);

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_model_snapshot_shape_check"
CHECK (
  ("model" IS NULL AND "execution_environment_snapshot" IS NULL) OR
  ("model" IS NOT NULL AND "execution_environment_snapshot" IS NOT NULL)
);

-- Used by rollout/rollback preflight without indexing high-cardinality model ids.
CREATE INDEX "tasks_explicit_model_idx"
ON "tasks"("id")
WHERE "model" IS NOT NULL;

-- Expand the existing persisted failure-code constraint for the two model
-- failure branches. Action/message projection remains in application code.
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_failure_code_check";
ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_failure_code_check"
CHECK (
  "failure_code" IS NULL OR
  "failure_code" IN (
    'runtime_auth_expired',
    'runtime_auth_rejected',
    'runtime_model_setup_failed',
    'runtime_model_rejected'
  )
);

-- Pre-task schedule retry state. All columns are additive so historical rows
-- remain readable with null machine metadata.
ALTER TABLE "task_schedule_runs"
ADD COLUMN "error_code" TEXT,
ADD COLUMN "retry_at" TIMESTAMP(3),
ADD COLUMN "retry_attempt" INTEGER,
ADD COLUMN "retry_horizon_at" TIMESTAMP(3),
ADD COLUMN "retry_task_template" JSONB;

ALTER TABLE "task_schedule_runs"
ADD CONSTRAINT "task_schedule_runs_error_code_check"
CHECK (
  "error_code" IS NULL OR
  "error_code" IN (
    'runtime_model_not_available',
    'runtime_model_catalog_unavailable'
  )
);

ALTER TABLE "task_schedule_runs"
ADD CONSTRAINT "task_schedule_runs_retry_attempt_check"
CHECK ("retry_attempt" IS NULL OR "retry_attempt" >= 1);

ALTER TABLE "task_schedule_runs"
ADD CONSTRAINT "task_schedule_runs_retry_shape_check"
CHECK (
  "status" <> 'retrying' OR (
    "task_id" IS NULL AND
    "error_code" = 'runtime_model_catalog_unavailable' AND
    "retry_at" IS NOT NULL AND
    "retry_attempt" IS NOT NULL AND
    "retry_horizon_at" IS NOT NULL AND
    "retry_task_template" IS NOT NULL
  )
);

CREATE INDEX "task_schedule_runs_status_retry_at_idx"
ON "task_schedule_runs"("status", "retry_at");
