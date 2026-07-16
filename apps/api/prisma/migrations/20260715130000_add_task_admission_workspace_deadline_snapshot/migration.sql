-- Rolling-compatible immutable workspace materialization deadline. Existing
-- admission work remains null and uses the core compatibility default; every
-- newly accepted durable task writes the selected policy value atomically.

ALTER TABLE "task_admission_work"
ADD COLUMN "workspace_materialization_deadline_ms" INTEGER;

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_workspace_materialization_deadline_ms_check"
CHECK (
  "workspace_materialization_deadline_ms" IS NULL OR
  "workspace_materialization_deadline_ms" BETWEEN 1000 AND 86400000
);

-- Extend the existing write-once snapshot fence. A rolling-upgrade row may
-- fill its initial null once, but retries cannot replace a resolved deadline.
CREATE OR REPLACE FUNCTION "task_admission_work_preserve_snapshots"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."resolved_branch" IS NOT NULL AND
     NEW."resolved_branch" IS DISTINCT FROM OLD."resolved_branch" THEN
    RAISE EXCEPTION 'task admission resolved branch is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."resource_snapshot" IS NOT NULL AND
     NEW."resource_snapshot" IS DISTINCT FROM OLD."resource_snapshot" THEN
    RAISE EXCEPTION 'task admission resource snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."workspace_materialization_deadline_ms" IS NOT NULL AND
     NEW."workspace_materialization_deadline_ms" IS DISTINCT FROM
       OLD."workspace_materialization_deadline_ms" THEN
    RAISE EXCEPTION 'task admission workspace deadline snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "task_admission_work_preserve_snapshots_trigger"
ON "task_admission_work";

CREATE TRIGGER "task_admission_work_preserve_snapshots_trigger"
BEFORE UPDATE OF
  "resolved_branch",
  "resource_snapshot",
  "workspace_materialization_deadline_ms"
ON "task_admission_work"
FOR EACH ROW
EXECUTE FUNCTION "task_admission_work_preserve_snapshots"();
