-- Durable asynchronous task admission. Existing Task rows intentionally receive
-- only a zero-valued lifecycle fence and no admission-work row; new acceptance
-- transactions create one task_admission_work row keyed by the Task id.

ALTER TABLE "tasks"
ADD COLUMN "lifecycle_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_lifecycle_version_check"
CHECK ("lifecycle_version" >= 0);

-- Provisioning settlement writes the canonical safe cause to the Task row.
-- Keep the persisted allowlist byte-for-byte aligned with the full contracts
-- union rather than leaving the pre-provisioning four-code constraint in place.
ALTER TABLE "tasks"
DROP CONSTRAINT "tasks_failure_code_check";

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_failure_code_check"
CHECK (
  "failure_code" IS NULL OR
  "failure_code" IN (
    'runtime_auth_expired',
    'runtime_auth_rejected',
    'runtime_model_setup_failed',
    'runtime_model_rejected',
    'provisioning_capacity_exhausted',
    'provisioning_workspace_timeout',
    'provisioning_forge_auth_failed',
    'provisioning_tls_network_failed',
    'provisioning_ref_not_found',
    'provisioning_unknown'
  )
);

CREATE TABLE "task_admission_work" (
    "task_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'accepted',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_until" TIMESTAMP(3),
    "stage" TEXT NOT NULL DEFAULT 'accepted',
    "cause_code" TEXT,
    "resolved_branch" TEXT,
    "resource_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_admission_work_pkey" PRIMARY KEY ("task_id")
);

-- Stable, provider-neutral values only. These CHECKs deliberately mirror the
-- canonical contracts and prevent raw provider states/diagnostics from becoming
-- durable recovery data.
ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_state_check"
CHECK (
  "state" IN (
    'accepted',
    'queued',
    'running',
    'retrying',
    'succeeded',
    'failed',
    'cancelled'
  )
);

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_stage_check"
CHECK (
  "stage" IN (
    'accepted',
    'sandbox_creation',
    'credential_setup',
    'remote_ref_resolution',
    'workspace_transfer',
    'checkout',
    'submodules',
    'credential_cleanup',
    'runtime_setup',
    'readiness',
    'agent_launch',
    'complete'
  )
);

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_cause_code_check"
CHECK (
  "cause_code" IS NULL OR
  "cause_code" IN (
    'provisioning_capacity_exhausted',
    'provisioning_workspace_timeout',
    'provisioning_forge_auth_failed',
    'provisioning_tls_network_failed',
    'provisioning_ref_not_found',
    'provisioning_unknown'
  )
);

-- Retry scheduling is represented by state/attempt/available_at. A durable
-- cause is terminal classification, so it is written atomically with `failed`
-- and cannot linger on accepted, queued, running, retrying, or successful work.
ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_cause_shape_check"
CHECK (
  ("state" = 'failed' AND "cause_code" IS NOT NULL) OR
  ("state" <> 'failed' AND "cause_code" IS NULL)
);

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_attempt_check"
CHECK ("attempt" >= 0);

-- Claiming atomically enters the active `running` state. Every other state is
-- unleased: accepted/queued/retrying rows are durable polling candidates, and
-- terminal rows have already released ownership.
ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_lease_shape_check"
CHECK (
  (
    "state" = 'running' AND
    "lease_owner" IS NOT NULL AND
    "lease_until" IS NOT NULL AND
    "attempt" >= 1
  ) OR (
    "state" <> 'running' AND
    "lease_owner" IS NULL AND
    "lease_until" IS NULL
  )
);

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_lease_owner_check"
CHECK (
  "lease_owner" IS NULL OR (
    octet_length("lease_owner") BETWEEN 1 AND 512 AND
    "lease_owner" = btrim("lease_owner") AND
    "lease_owner" !~ '[[:cntrl:]]'
  )
);

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_resolved_branch_check"
CHECK (
  "resolved_branch" IS NULL OR (
    octet_length("resolved_branch") BETWEEN 1 AND 1024 AND
    "resolved_branch" = btrim("resolved_branch") AND
    "resolved_branch" !~ '[[:cntrl:]]'
  )
);

-- The initial resource contract is intentionally narrow and secret-free.
-- Null/{} remains valid for legacy or provider-neutral work. Any future resource
-- key must be added to the canonical contract and this constraint together.
ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_resource_snapshot_check"
CHECK (
  "resource_snapshot" IS NULL OR (
    jsonb_typeof("resource_snapshot") = 'object' AND
    ("resource_snapshot" - 'diskSizeGb') = '{}'::jsonb AND
    CASE
      WHEN NOT ("resource_snapshot" ? 'diskSizeGb') THEN true
      WHEN jsonb_typeof("resource_snapshot" -> 'diskSizeGb') <> 'number' THEN false
      WHEN ("resource_snapshot" ->> 'diskSizeGb') !~ '^[0-9]+$' THEN false
      ELSE ("resource_snapshot" ->> 'diskSizeGb')::integer BETWEEN 1 AND 1024
    END
  )
);

-- Durable polling is the floor beneath the optional in-process wake-up. The
-- first index supports deterministic available-work claims; the second makes
-- expired-lease recovery efficient after a worker or API process exits.
CREATE INDEX "task_admission_work_state_available_at_created_at_task_id_idx"
ON "task_admission_work"("state", "available_at", "created_at", "task_id");

CREATE INDEX "task_admission_work_state_lease_until_created_at_task_id_idx"
ON "task_admission_work"("state", "lease_until", "created_at", "task_id");

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Resolution may fill a legacy/null snapshot exactly once. After a non-null
-- branch or resource snapshot is present, retries and lease replays cannot
-- replace it with a different mutable default.
CREATE FUNCTION "task_admission_work_preserve_snapshots"()
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_admission_work_preserve_snapshots_trigger"
BEFORE UPDATE OF "resolved_branch", "resource_snapshot"
ON "task_admission_work"
FOR EACH ROW
EXECUTE FUNCTION "task_admission_work_preserve_snapshots"();
