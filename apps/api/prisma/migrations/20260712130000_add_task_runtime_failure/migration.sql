-- Keep an actionable runtime-auth failure on the Task row itself. Audit events
-- remain best-effort diagnostics and are not the source of truth for task reads.
ALTER TABLE "tasks"
ADD COLUMN "failure_code" TEXT,
ADD COLUMN "failure_at" TIMESTAMP(3),
ADD COLUMN "failure_exit_code" INTEGER;

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_failure_code_check"
CHECK (
  "failure_code" IS NULL OR
  "failure_code" IN ('runtime_auth_expired', 'runtime_auth_rejected')
);

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_failure_shape_check"
CHECK (
  ("failure_code" IS NULL AND "failure_at" IS NULL AND "failure_exit_code" IS NULL) OR
  ("failure_code" IS NOT NULL AND "failure_at" IS NOT NULL)
);

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_failure_status_check"
CHECK ("failure_code" IS NULL OR "status" = 'failed');

CREATE INDEX "tasks_failure_code_idx" ON "tasks"("failure_code");

-- Backfill already-failed tasks from the most recent bounded exit diagnostic.
-- These signatures are deliberately strict so ordinary task output mentioning
-- a 401 or an expired application token is not mislabeled as agent auth failure.
WITH latest_exit AS (
  SELECT DISTINCT ON ("task_id")
    "task_id",
    "description",
    "timestamp"
  FROM "audit_events"
  WHERE "type" = 'task.exited'
  ORDER BY "task_id", "timestamp" DESC, "id" DESC
), classified AS (
  SELECT
    t."id" AS "task_id",
    e."timestamp" AS "failure_at",
    CASE
      WHEN COALESCE(t."runtime", 'codex') = 'codex' AND (
        e."description" ILIKE '%401%' AND
        e."description" ILIKE '%"error"%' AND
        e."description" ILIKE '%Provided authentication token is expired%'
      ) THEN 'runtime_auth_expired'
      WHEN COALESCE(t."runtime", 'codex') = 'codex' AND (
        (
          e."description" ILIKE '%401%' AND
          e."description" ILIKE '%"error"%' AND
          (
            e."description" ILIKE '%invalid_api_key%' OR
            e."description" ILIKE '%Incorrect API key provided%'
          )
        ) OR
        e."description" ILIKE '%Failed to refresh token:%Your access token could not be refreshed%' OR
        (
          (e."description" ILIKE '%401%' OR e."description" ILIKE '%"error"%') AND
          (
            e."description" ILIKE '%Your access token could not be refreshed because your refresh token was already used%' OR
            e."description" ILIKE '%Your access token could not be refreshed because your refresh token was revoked%'
          )
        )
      ) THEN 'runtime_auth_rejected'
      WHEN t."runtime" = 'claude-code' AND (
        e."description" ~* E'(^|\\n)[[:space:]]*Session expired\\. Please run /login to sign in again\\.[[:space:]]*($|\\n)' OR
        e."description" ~* E'(^|\\n)[[:space:]]*OAuth refresh token is no longer valid([^[:alnum:]/]*Please run /login to sign in again\\.)?[[:space:]]*($|\\n)' OR
        (
          e."description" ILIKE '%401%' AND
          e."description" ILIKE '%authentication_error%' AND
          e."description" ILIKE '%OAuth token has expired%'
        )
      ) THEN 'runtime_auth_expired'
      WHEN t."runtime" = 'claude-code' AND (
        e."description" ~* E'(^|\\n)[[:space:]]*Invalid API key[^[:alnum:]/]*Please run /login([[:space:]]+to (authenticate|sign in again))?\\.?[[:space:]]*($|\\n)' OR
        e."description" ~* E'(^|\\n)[[:space:]]*Not logged in[^[:alnum:]/]*Please run /login([[:space:]]+to authenticate)?\\.?[[:space:]]*($|\\n)' OR
        (
          e."description" ILIKE '%401%' AND
          e."description" ILIKE '%authentication_error%' AND
          (
            e."description" ILIKE '%Invalid authentication credentials%' OR
            e."description" ILIKE '%Invalid bearer token%'
          )
        )
      ) THEN 'runtime_auth_rejected'
      ELSE NULL
    END AS "failure_code"
  FROM "tasks" t
  JOIN latest_exit e ON e."task_id" = t."id"
  WHERE t."status" = 'failed'
)
UPDATE "tasks" t
SET
  "failure_code" = c."failure_code",
  "failure_at" = c."failure_at"
FROM classified c
WHERE t."id" = c."task_id" AND c."failure_code" IS NOT NULL;
