-- Additive detached-transfer parking. A parked row keeps its lease pair: the
-- retained lease_owner is the parked ownership generation compared during the
-- resume re-stamp, and lease_until expiry is the recovery path through the
-- existing expired-lease claim branch (restart recovery and rollback both ride
-- it). Nothing here is destructive: no column is dropped, all new columns are
-- nullable, and existing rows keep passing every rewritten constraint.

ALTER TABLE "task_admission_work"
DROP CONSTRAINT "task_admission_work_state_check";

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_state_check"
CHECK (
  "state" IN (
    'accepted',
    'queued',
    'running',
    'parked',
    'retrying',
    'succeeded',
    'failed',
    'cancelled'
  )
);

-- Parked work remains leased. Unlike every other settled state, parking keeps
-- the lease pair: lease_owner is the parked ownership generation and
-- lease_until is the recovery horizon the parked poll loop keeps extending
-- while the detached job proves alive. Parked rows always have a claimed
-- attempt (parking is not a retry event and never resets the counter).
ALTER TABLE "task_admission_work"
DROP CONSTRAINT "task_admission_work_lease_shape_check";

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_lease_shape_check"
CHECK (
  (
    "state" IN ('running', 'parked') AND
    "lease_owner" IS NOT NULL AND
    "lease_until" IS NOT NULL AND
    "attempt" >= 1
  ) OR (
    "state" NOT IN ('running', 'parked') AND
    "lease_owner" IS NULL AND
    "lease_until" IS NULL
  )
);

-- Latest detached workspace-transfer progress snapshot persisted by the parked
-- poll loop; the provisioning-summary projection reads it from here. Numeric
-- only — no free-form text can carry raw git/provider diagnostics. NULL
-- percent explicitly models an indeterminate/unknown phase (AIP-151): it is
-- never a synonym for 0%.
ALTER TABLE "task_admission_work"
ADD COLUMN "progress_percent" INTEGER,
ADD COLUMN "progress_received_objects" BIGINT,
ADD COLUMN "progress_total_objects" BIGINT,
ADD COLUMN "progress_received_bytes" BIGINT,
ADD COLUMN "progress_throughput_bytes_per_second" BIGINT;

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_progress_snapshot_check"
CHECK (
  ("progress_percent" IS NULL OR "progress_percent" BETWEEN 0 AND 100) AND
  ("progress_received_objects" IS NULL OR "progress_received_objects" >= 0) AND
  ("progress_total_objects" IS NULL OR "progress_total_objects" >= 0) AND
  ("progress_received_bytes" IS NULL OR "progress_received_bytes" >= 0) AND
  (
    "progress_throughput_bytes_per_second" IS NULL OR
    "progress_throughput_bytes_per_second" >= 0
  )
);
