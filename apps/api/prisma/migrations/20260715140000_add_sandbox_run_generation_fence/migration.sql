-- Double-fence sandbox ownership so a superseded admission worker cannot tear
-- down a physical sandbox already transferred to a newer lease generation.

ALTER TABLE "sandbox_runs"
ADD COLUMN "owner_generation" TEXT,
ADD COLUMN "resource_generation" TEXT,
ADD COLUMN "create_state" TEXT NOT NULL DEFAULT 'entered';

-- Existing rows deliberately retain a NULL/NULL pair. Their physical AIO and
-- BoxLite resources predate generation labels, so manufacturing a database
-- generation here would make every exact inspect/teardown fail. The owner
-- store serializes these rows through an explicit legacy cleanup path before a
-- new generation-fenced run may be acquired.

ALTER TABLE "sandbox_runs"
ADD CONSTRAINT "sandbox_runs_generation_pair_check"
CHECK (
  ("owner_generation" IS NULL AND "resource_generation" IS NULL) OR
  (
    "owner_generation" IS NOT NULL AND
    "resource_generation" IS NOT NULL AND
    octet_length("owner_generation") BETWEEN 1 AND 512 AND
    octet_length("resource_generation") BETWEEN 1 AND 512 AND
    "owner_generation" = btrim("owner_generation") AND
    "resource_generation" = btrim("resource_generation") AND
    "owner_generation" !~ '[[:cntrl:]]' AND
    "resource_generation" !~ '[[:cntrl:]]'
  )
);

ALTER TABLE "sandbox_runs"
ADD CONSTRAINT "sandbox_runs_create_state_check"
CHECK ("create_state" IN ('idle', 'entered'));

-- A historical running row was returned by its provider and is therefore not
-- an unresolved create request. Provisioning/deleting rows remain entered as
-- the conservative rolling-upgrade default.
UPDATE "sandbox_runs"
SET "create_state" = 'idle'
WHERE "status" = 'running';

-- Never guess which historical duplicate owns a real external sandbox. Abort
-- the migration so an operator can inspect and clean duplicates explicitly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sandbox_runs"
    WHERE "status" IN ('provisioning', 'running', 'deleting')
    GROUP BY "task_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'sandbox_runs contains duplicate live owners; clean them before migration';
  END IF;
END $$;

CREATE UNIQUE INDEX "sandbox_runs_one_live_owner_per_task_idx"
ON "sandbox_runs"("task_id")
WHERE "status" IN ('provisioning', 'running', 'deleting');

CREATE INDEX "sandbox_runs_task_id_owner_generation_resource_generation_idx"
ON "sandbox_runs"("task_id", "owner_generation", "resource_generation");

-- A durable terminal transition is intentionally two-phase: Task becomes
-- terminal and the safe cause is persisted while work remains leased/running;
-- only confirmed sandbox cleanup moves work to failed and releases the lease.
ALTER TABLE "task_admission_work"
DROP CONSTRAINT "task_admission_work_cause_shape_check";

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_cause_shape_check"
CHECK (
  ("state" = 'failed' AND "cause_code" IS NOT NULL) OR
  ("state" = 'running') OR
  ("state" NOT IN ('failed', 'running') AND "cause_code" IS NULL)
);
