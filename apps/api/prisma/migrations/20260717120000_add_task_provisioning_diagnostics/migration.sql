-- Durable, secret-free task provisioning diagnostics. Historical Task rows are
-- deliberately left unmarked: NULL means the deployment cannot promise that
-- evidence exists and read paths must project `unavailable`.

ALTER TABLE "tasks"
ADD COLUMN "provisioning_diagnostic_schema_version" INTEGER,
ADD COLUMN "provisioning_diagnostic_next_attempt" INTEGER;

-- A retry cause is durable claim provenance, not provider text. Retain the
-- existing closed cause-code check and extend only the state/shape rule so new
-- writers can preserve it for the next claim. A rolling old writer may still
-- produce NULL on retrying; readers deliberately map that bounded absence to
-- `unknown` until the rollout converges. The running row keeps either value
-- while leased; every non-retry settlement clears it in the store.
ALTER TABLE "task_admission_work"
DROP CONSTRAINT "task_admission_work_cause_shape_check";

-- Existing retry rows predate retry provenance and were required to store
-- NULL. They are still real retries, so migrate them into the bounded unknown
-- bucket rather than inventing a provider-specific classification.
UPDATE "task_admission_work"
SET "cause_code" = 'provisioning_unknown'
WHERE "state" = 'retrying' AND "cause_code" IS NULL;

ALTER TABLE "task_admission_work"
ADD CONSTRAINT "task_admission_work_cause_shape_check"
CHECK (
  ("state" = 'failed' AND "cause_code" IS NOT NULL) OR
  ("state" IN ('retrying', 'running')) OR
  (
    "state" NOT IN ('failed', 'retrying', 'running') AND
    "cause_code" IS NULL
  )
);

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_provisioning_diagnostic_expectation_check"
CHECK (
  (
    "provisioning_diagnostic_schema_version" IS NULL AND
    "provisioning_diagnostic_next_attempt" IS NULL
  ) OR (
    "provisioning_diagnostic_schema_version" IS NOT NULL AND
    "provisioning_diagnostic_next_attempt" IS NOT NULL AND
    "provisioning_diagnostic_schema_version" = 1 AND
    "provisioning_diagnostic_next_attempt" >= 1
  )
);

CREATE FUNCTION "tasks_provisioning_diagnostic_expectation_monotonic"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."provisioning_diagnostic_schema_version" IS NULL THEN
    IF NEW."provisioning_diagnostic_schema_version" IS NOT NULL OR
       NEW."provisioning_diagnostic_next_attempt" IS NOT NULL THEN
      RAISE EXCEPTION 'historical task diagnostic expectation cannot be backfilled'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."provisioning_diagnostic_schema_version" IS DISTINCT FROM
       OLD."provisioning_diagnostic_schema_version" OR
     NEW."provisioning_diagnostic_next_attempt" <
       OLD."provisioning_diagnostic_next_attempt" THEN
    RAISE EXCEPTION 'task diagnostic expectation and attempt counter are monotonic'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tasks_provisioning_diagnostic_expectation_monotonic_trigger"
BEFORE UPDATE OF "provisioning_diagnostic_schema_version", "provisioning_diagnostic_next_attempt"
ON "tasks"
FOR EACH ROW
EXECUTE FUNCTION "tasks_provisioning_diagnostic_expectation_monotonic"();

-- SandboxRun.status remains the sole cleanup authority. These fixed fields are
-- secondary evidence only and contain no provider identifier or raw error.
ALTER TABLE "sandbox_runs"
ADD COLUMN "cleanup_attempt_in_flight" BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN "cleanup_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cleanup_last_attempt_id" TEXT,
ADD COLUMN "cleanup_last_outcome" TEXT,
ADD COLUMN "cleanup_last_proof" TEXT,
ADD COLUMN "cleanup_last_cause" TEXT,
ADD COLUMN "cleanup_last_retryable" BOOLEAN,
ADD COLUMN "cleanup_last_observed_at" TIMESTAMP(3),
ADD COLUMN "cleanup_orphan_confirmed_at" TIMESTAMP(3);

-- Supports cleanup-pending and confirmed-orphan gauge hydration from durable
-- authority without reading provider identifiers into the metrics layer.
CREATE INDEX "sandbox_runs_status_cleanup_orphan_confirmed_at_idx"
ON "sandbox_runs"("status", "cleanup_orphan_confirmed_at");

-- Before this migration `failed` could be written without the dedicated
-- terminal-policy transaction, while `deleting` did not itself guarantee that
-- a worker could ever claim its Task. Preserve pending cleanup only for a
-- uniquely-current, generation-fenced, create-idle owner with a real durable
-- claim path. An entered historical create has no surviving callback that can
-- close its late-create fence, so it is retained rather than auto-reconciled.
-- A future available_at or lease_until is still a claim path; terminal work,
-- ownerless history, ambiguous duplicates, and ownerless deleting rows are not.
UPDATE "sandbox_runs" AS run
SET
  "status" = 'terminal',
  "terminal_at" = COALESCE(run."terminal_at", CURRENT_TIMESTAMP)
WHERE
  run."status" IN ('failed', 'deleting') AND
  NOT (
    run."owner_generation" IS NOT NULL AND
    run."resource_generation" IS NOT NULL AND
    run."create_state" = 'idle' AND
    NOT EXISTS (
      SELECT 1
      FROM "sandbox_runs" AS other
      WHERE
        other."task_id" = run."task_id" AND
        other."id" <> run."id" AND
        (
          other."status" IN ('provisioning', 'running', 'deleting') OR
          other."created_at" >= run."created_at"
        )
    ) AND
    EXISTS (
      SELECT 1
      FROM "task_admission_work" AS work
      INNER JOIN "tasks" AS task ON task."id" = work."task_id"
      WHERE
        work."task_id" = run."task_id" AND
        (
          work."state" IN ('accepted', 'queued', 'retrying', 'running') OR (
            work."state" = 'succeeded' AND
            task."status"::text IN (
              'completed', 'failed', 'cancelled', 'agent_failed_to_start'
            )
          )
        )
    )
  );

-- Every remaining historical failure now has an unambiguous automatic recovery
-- owner. Return it to pending reconciliation; existing deleting candidates stay
-- pending. After this normalization, `failed` is reserved for the guarded
-- post-migration terminal policy.
UPDATE "sandbox_runs"
SET
  "status" = 'deleting',
  "terminal_at" = NULL
WHERE "status" = 'failed';

ALTER TABLE "sandbox_runs"
ADD CONSTRAINT "sandbox_runs_cleanup_evidence_check"
CHECK (
  "cleanup_attempt_count" >= 0 AND
  (
    "status" <> 'failed' OR (
      "owner_generation" IS NOT NULL AND
      "resource_generation" IS NOT NULL AND
      "create_state" = 'idle' AND
      "cleanup_attempt_in_flight" = FALSE AND
      "cleanup_attempt_count" > 0 AND
      "cleanup_last_outcome" IN ('failed', 'indeterminate')
    )
  ) AND
  (
    (
      "cleanup_attempt_count" = 0 AND
      "cleanup_attempt_in_flight" = FALSE AND
      "cleanup_last_attempt_id" IS NULL AND
      "cleanup_last_outcome" IS NULL AND
      "cleanup_last_proof" IS NULL AND
      "cleanup_last_cause" IS NULL AND
      "cleanup_last_retryable" IS NULL AND
      "cleanup_last_observed_at" IS NULL
    ) OR (
      "cleanup_attempt_count" > 0 AND
      "cleanup_last_attempt_id" IS NOT NULL AND
      "cleanup_last_attempt_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      "cleanup_last_outcome" IS NOT NULL AND
      "cleanup_last_retryable" IS NOT NULL AND
      "cleanup_last_observed_at" IS NOT NULL AND
      (
        "cleanup_last_outcome" <> 'succeeded' OR
        "create_state" = 'idle'
      ) IS TRUE AND
      (
        (
          "cleanup_last_outcome" = 'succeeded' AND
          "cleanup_last_proof" IN ('found-and-cleaned', 'already-absent') AND
          "cleanup_last_cause" IS NULL AND
          "cleanup_last_retryable" = FALSE
        ) OR (
          "cleanup_last_outcome" = 'failed' AND
          "cleanup_last_proof" IS NULL AND
          "cleanup_last_cause" = 'cleanup_failed' AND
          "cleanup_last_retryable" IS NOT NULL
        ) OR (
          "cleanup_last_outcome" = 'indeterminate' AND
          "cleanup_last_proof" IS NULL AND
          "cleanup_last_cause" = 'cleanup_unconfirmed' AND
          "cleanup_last_retryable" = TRUE
        )
      ) IS TRUE AND
      (
        "cleanup_attempt_in_flight" = FALSE OR (
          "status" = 'deleting' AND
          "cleanup_last_outcome" = 'indeterminate' AND
          "cleanup_last_proof" IS NULL AND
          "cleanup_last_cause" = 'cleanup_unconfirmed' AND
          "cleanup_last_retryable" = TRUE
        )
      ) IS TRUE
    )
  )
);

ALTER TABLE "sandbox_runs"
ADD CONSTRAINT "sandbox_runs_cleanup_status_check"
CHECK (
  "status" IN (
    'provisioning', 'running', 'deleting', 'terminal', 'removed', 'failed'
  )
);

ALTER TABLE "sandbox_runs"
ADD CONSTRAINT "sandbox_runs_cleanup_orphan_evidence_check"
CHECK (
  "cleanup_orphan_confirmed_at" IS NULL OR (
    "owner_generation" IS NOT NULL AND
    "resource_generation" IS NOT NULL AND
    "provider_sandbox_id" IS NOT NULL
  )
);

-- `failed` is not an initial owner state. Even a structurally complete row must
-- enter through `deleting` and the guarded UPDATE terminal-policy transition,
-- so direct inserts cannot forge an authoritative policy decision.
CREATE FUNCTION "sandbox_runs_cleanup_failed_insert_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'failed' THEN
    RAISE EXCEPTION 'sandbox cleanup failure cannot be inserted directly'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sandbox_runs_cleanup_failed_insert_guard_trigger"
BEFORE INSERT ON "sandbox_runs"
FOR EACH ROW
EXECUTE FUNCTION "sandbox_runs_cleanup_failed_insert_guard"();

CREATE FUNCTION "sandbox_runs_cleanup_evidence_monotonic"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."cleanup_orphan_confirmed_at" IS DISTINCT FROM
       OLD."cleanup_orphan_confirmed_at" THEN
    IF NEW."cleanup_orphan_confirmed_at" IS NULL THEN
      IF NEW."provider_sandbox_id" IS NOT DISTINCT FROM OLD."provider_sandbox_id" AND
         NEW."resource_generation" IS NOT DISTINCT FROM OLD."resource_generation" THEN
        RAISE EXCEPTION 'sandbox cleanup orphan evidence clears only for a new incarnation'
          USING ERRCODE = '23514';
      END IF;
    ELSIF (
      current_setting('cap.sandbox_cleanup_orphan_confirmation', true) = 'on' AND
      OLD."cleanup_orphan_confirmed_at" IS NULL AND
      OLD."status" = 'deleting' AND
      NEW."status" = 'deleting' AND
      OLD."owner_generation" IS NOT NULL AND
      NEW."owner_generation" IS NOT DISTINCT FROM OLD."owner_generation" AND
      OLD."resource_generation" IS NOT NULL AND
      NEW."resource_generation" IS NOT DISTINCT FROM OLD."resource_generation" AND
      OLD."provider_id" IS NOT DISTINCT FROM NEW."provider_id" AND
      OLD."provider_sandbox_id" IS NOT NULL AND
      NEW."provider_sandbox_id" IS NOT DISTINCT FROM OLD."provider_sandbox_id"
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'sandbox cleanup orphan confirmation requires exact fresh inventory authority'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Legacy has no restart-safe exact owner. Persist its one bounded physical
  -- disposition and terminal evidence in one transaction, without ever
  -- manufacturing a durable deleting authority.
  IF OLD."status" IN ('provisioning', 'running') AND
     NEW."status" IN ('terminal', 'removed') AND
     NEW."cleanup_attempt_count" = OLD."cleanup_attempt_count" + 1 AND
     current_setting('cap.sandbox_cleanup_legacy_settlement', true) = 'on' THEN
    IF OLD."owner_generation" IS NOT NULL OR
       OLD."resource_generation" IS NOT NULL OR
       OLD."cleanup_attempt_in_flight" OR
       NEW."owner_generation" IS NOT NULL OR
       NEW."resource_generation" IS NOT NULL OR
       NEW."cleanup_attempt_in_flight" OR
       NEW."cleanup_last_attempt_id" IS NULL OR
       NEW."cleanup_last_attempt_id" IS NOT DISTINCT FROM OLD."cleanup_last_attempt_id" OR
       NEW."cleanup_last_observed_at" IS NULL OR
       (
         NEW."cleanup_last_outcome" = 'succeeded' AND
         NEW."status" IN ('terminal', 'removed') AND
         NEW."cleanup_last_proof" IN ('found-and-cleaned', 'already-absent') AND
         NEW."cleanup_last_cause" IS NULL AND
         NEW."cleanup_last_retryable" = FALSE
       ) IS NOT TRUE AND (
         NEW."cleanup_last_outcome" IN ('failed', 'indeterminate') AND
         NEW."status" = 'terminal' AND
         NEW."cleanup_last_proof" IS NULL
       ) IS NOT TRUE THEN
      RAISE EXCEPTION 'legacy sandbox cleanup settlement is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('terminal', 'removed', 'failed') AND
     NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'settled sandbox cleanup authority cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('terminal', 'removed', 'failed') AND (
       NEW."owner_generation" IS DISTINCT FROM OLD."owner_generation" OR
       NEW."resource_generation" IS DISTINCT FROM OLD."resource_generation"
     ) THEN
    RAISE EXCEPTION 'settled sandbox cleanup generation is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'deleting' AND
     NEW."status" IN ('provisioning', 'running') THEN
    RAISE EXCEPTION 'deleting sandbox cleanup authority cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'deleting' AND
     NEW."status" = 'failed' AND
     NEW."status" IS DISTINCT FROM OLD."status" AND (
       current_setting('cap.sandbox_cleanup_terminal_policy', true) = 'on' AND
       NEW."owner_generation" IS NOT NULL AND
       NEW."owner_generation" IS NOT DISTINCT FROM OLD."owner_generation" AND
       NEW."resource_generation" IS NOT NULL AND
       NEW."resource_generation" IS NOT DISTINCT FROM OLD."resource_generation" AND
       OLD."create_state" = 'idle' AND
       NEW."create_state" = 'idle' AND
       NEW."cleanup_attempt_in_flight" = FALSE AND
       NEW."cleanup_attempt_count" > 0 AND
       NEW."cleanup_attempt_count" = OLD."cleanup_attempt_count" AND
       NEW."cleanup_last_attempt_id" IS NOT NULL AND
       NEW."cleanup_last_outcome" IN ('failed', 'indeterminate') AND
       NEW."cleanup_last_proof" IS NULL AND
       NEW."cleanup_last_observed_at" IS NOT NULL
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'sandbox cleanup failure requires atomic terminal policy'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('provisioning', 'running') AND
     NEW."status" = 'failed' AND
     NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'sandbox cleanup failure requires bounded legacy settlement'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'deleting' AND
     NEW."status" IN ('terminal', 'removed') AND
     NEW."status" IS DISTINCT FROM OLD."status" AND (
       NEW."create_state" = 'idle' AND
       NEW."cleanup_attempt_in_flight" = FALSE AND
       NEW."cleanup_attempt_count" > 0 AND
       NEW."cleanup_last_outcome" = 'succeeded' AND
       NEW."cleanup_last_proof" IN ('found-and-cleaned', 'already-absent') AND
       NEW."cleanup_last_cause" IS NULL AND
       NEW."cleanup_last_retryable" = FALSE
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'sandbox cleanup completion requires settled success proof'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'deleting' AND
     NEW."resource_generation" IS DISTINCT FROM OLD."resource_generation" THEN
    RAISE EXCEPTION 'sandbox cleanup resource generation is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'deleting' AND
     NEW."owner_generation" IS DISTINCT FROM OLD."owner_generation" AND
     OLD."cleanup_attempt_in_flight" AND (
       NEW."cleanup_attempt_in_flight" OR
       NEW."cleanup_attempt_count" IS DISTINCT FROM OLD."cleanup_attempt_count" OR
       NEW."cleanup_last_attempt_id" IS DISTINCT FROM OLD."cleanup_last_attempt_id" OR
       NEW."cleanup_last_outcome" IS DISTINCT FROM OLD."cleanup_last_outcome" OR
       NEW."cleanup_last_proof" IS DISTINCT FROM OLD."cleanup_last_proof" OR
       NEW."cleanup_last_cause" IS DISTINCT FROM OLD."cleanup_last_cause" OR
       NEW."cleanup_last_retryable" IS DISTINCT FROM OLD."cleanup_last_retryable" OR
       NEW."cleanup_last_observed_at" IS DISTINCT FROM OLD."cleanup_last_observed_at"
     ) THEN
    RAISE EXCEPTION 'sandbox cleanup takeover must settle the inherited placeholder'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."cleanup_attempt_count" < OLD."cleanup_attempt_count" OR
     NEW."cleanup_attempt_count" > OLD."cleanup_attempt_count" + 1 THEN
    RAISE EXCEPTION 'sandbox cleanup attempt count advances one step'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."cleanup_attempt_count" = OLD."cleanup_attempt_count" + 1 THEN
    IF OLD."cleanup_attempt_in_flight" OR
       NOT NEW."cleanup_attempt_in_flight" OR
       NEW."cleanup_last_attempt_id" IS NULL OR
       NEW."cleanup_last_attempt_id" IS NOT DISTINCT FROM OLD."cleanup_last_attempt_id" OR
       NEW."cleanup_last_outcome" IS DISTINCT FROM 'indeterminate' OR
       NEW."cleanup_last_proof" IS NOT NULL OR
       NEW."cleanup_last_cause" IS DISTINCT FROM 'cleanup_unconfirmed' OR
       NEW."cleanup_last_retryable" IS DISTINCT FROM TRUE OR
       NEW."cleanup_last_observed_at" IS NULL THEN
      RAISE EXCEPTION 'sandbox cleanup begin must allocate one new placeholder'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."cleanup_attempt_in_flight" IS NOT DISTINCT FROM OLD."cleanup_attempt_in_flight" AND
     NEW."cleanup_last_attempt_id" IS NOT DISTINCT FROM OLD."cleanup_last_attempt_id" AND
     NEW."cleanup_last_outcome" IS NOT DISTINCT FROM OLD."cleanup_last_outcome" AND
     NEW."cleanup_last_proof" IS NOT DISTINCT FROM OLD."cleanup_last_proof" AND
     NEW."cleanup_last_cause" IS NOT DISTINCT FROM OLD."cleanup_last_cause" AND
     NEW."cleanup_last_retryable" IS NOT DISTINCT FROM OLD."cleanup_last_retryable" AND
     NEW."cleanup_last_observed_at" IS NOT DISTINCT FROM OLD."cleanup_last_observed_at" THEN
    RETURN NEW;
  END IF;

  IF OLD."cleanup_attempt_in_flight" AND
     NOT NEW."cleanup_attempt_in_flight" AND
     NEW."cleanup_last_attempt_id" IS NOT DISTINCT FROM OLD."cleanup_last_attempt_id" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'sandbox cleanup replay cannot replace settled evidence'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sandbox_runs_cleanup_evidence_monotonic_trigger"
BEFORE UPDATE OF "status", "owner_generation", "resource_generation", "cleanup_attempt_in_flight", "cleanup_attempt_count", "cleanup_last_attempt_id", "cleanup_last_outcome", "cleanup_last_proof", "cleanup_last_cause", "cleanup_last_retryable", "cleanup_last_observed_at", "cleanup_orphan_confirmed_at"
ON "sandbox_runs"
FOR EACH ROW
EXECUTE FUNCTION "sandbox_runs_cleanup_evidence_monotonic"();

CREATE TABLE "task_provisioning_diagnostic_attempts" (
  "id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "admission_mode" TEXT NOT NULL,
  "provider_family" TEXT,
  "state" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "coverage" TEXT NOT NULL,

  "primary_outcome" TEXT,
  "primary_cause" TEXT,
  "primary_retryable" BOOLEAN,
  "primary_exit_code" INTEGER,
  "primary_observed_at" TIMESTAMP(3),

  "cleanup_state" TEXT NOT NULL DEFAULT 'not_required',
  "cleanup_cause" TEXT,
  "cleanup_attempt_count" INTEGER NOT NULL DEFAULT 0,
  "cleanup_last_attempt_outcome" TEXT,
  "cleanup_observed_at" TIMESTAMP(3),

  "event_count" INTEGER NOT NULL DEFAULT 0,
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "completeness_marked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "task_provisioning_diagnostic_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_provisioning_diagnostic_attempts_id_check"
    CHECK (
      "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_schema_check"
    CHECK ("schema_version" = 1),
  CONSTRAINT "task_provisioning_diagnostic_attempts_attempt_check"
    CHECK ("attempt_number" >= 1),
  CONSTRAINT "task_provisioning_diagnostic_attempts_admission_mode_check"
    CHECK ("admission_mode" IN ('legacy', 'durable')),
  CONSTRAINT "task_provisioning_diagnostic_attempts_provider_family_check"
    CHECK (
      "provider_family" IS NULL OR
      "provider_family" IN ('aio', 'cloud-http', 'boxlite', 'unknown')
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_state_check"
    CHECK ("state" IN ('active', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  CONSTRAINT "task_provisioning_diagnostic_attempts_stage_check"
    CHECK (
      "stage" IN (
        'accepted', 'sandbox_creation', 'credential_setup',
        'remote_ref_resolution', 'workspace_transfer', 'checkout',
        'submodules', 'credential_cleanup', 'runtime_setup', 'readiness',
        'agent_launch', 'complete', 'provider_selection', 'sandbox_start',
        'sandbox_inspect', 'native_execution', 'settlement', 'cleanup'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_coverage_check"
    CHECK ("coverage" IN ('not_started', 'partial', 'complete', 'unavailable')),
  CONSTRAINT "task_provisioning_diagnostic_attempts_primary_outcome_check"
    CHECK (
      "primary_outcome" IS NULL OR
      "primary_outcome" IN (
        'succeeded', 'failed', 'timed_out', 'cancelled', 'degraded', 'indeterminate'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_safe_causes_check"
    CHECK (
      (
        "primary_cause" IS NULL OR
        "primary_cause" IN (
          'capacity_exhausted', 'authentication_failed', 'access_denied',
          'tls_network_failed', 'ref_not_found', 'workspace_timeout',
          'transport_failed', 'protocol_failed', 'provider_unavailable',
          'settlement_unknown', 'missing_exit_code', 'command_failed',
          'cancelled', 'superseded', 'cleanup_failed', 'cleanup_unconfirmed',
          'coordination_failed', 'diagnostic_write_failed', 'unknown'
        )
      ) AND (
        "cleanup_cause" IS NULL OR
        "cleanup_cause" IN (
          'capacity_exhausted', 'authentication_failed', 'access_denied',
          'tls_network_failed', 'ref_not_found', 'workspace_timeout',
          'transport_failed', 'protocol_failed', 'provider_unavailable',
          'settlement_unknown', 'missing_exit_code', 'command_failed',
          'cancelled', 'superseded', 'cleanup_failed', 'cleanup_unconfirmed',
          'coordination_failed', 'diagnostic_write_failed', 'unknown'
        )
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_primary_shape_check"
    CHECK (
      (
        "state" = 'active' AND
        "primary_outcome" IS NULL AND
        "primary_cause" IS NULL AND
        "primary_retryable" IS NULL AND
        "primary_exit_code" IS NULL AND
        "primary_observed_at" IS NULL AND
        "finished_at" IS NULL
      ) OR (
        "state" <> 'active' AND
        "primary_outcome" IS NOT NULL AND
        "primary_retryable" IS NOT NULL AND
        "primary_observed_at" IS NOT NULL AND
        "finished_at" IS NOT NULL
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_state_outcome_check"
    CHECK (
      ("state" = 'active' AND "primary_outcome" IS NULL) OR
      ("state" = 'succeeded' AND "primary_outcome" IN ('succeeded', 'degraded')) OR
      ("state" = 'failed' AND "primary_outcome" IN ('failed', 'timed_out', 'indeterminate')) OR
      ("state" = 'cancelled' AND "primary_outcome" = 'cancelled') OR
      ("state" = 'interrupted' AND "primary_outcome" = 'indeterminate')
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_cleanup_state_check"
    CHECK ("cleanup_state" IN ('not_required', 'pending', 'succeeded', 'failed')),
  CONSTRAINT "task_provisioning_diagnostic_attempts_cleanup_outcome_check"
    CHECK (
      "cleanup_last_attempt_outcome" IS NULL OR
      "cleanup_last_attempt_outcome" IN (
        'succeeded', 'failed', 'timed_out', 'cancelled', 'degraded', 'indeterminate'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_cleanup_shape_check"
    CHECK (
      "cleanup_attempt_count" >= 0 AND
      (
        (
          "cleanup_state" = 'not_required' AND
          "cleanup_attempt_count" = 0 AND
          "cleanup_cause" IS NULL AND
          "cleanup_last_attempt_outcome" IS NULL AND
          "cleanup_observed_at" IS NULL
        ) OR (
          "cleanup_state" = 'pending' AND
          (
            ("cleanup_attempt_count" = 0 AND "cleanup_last_attempt_outcome" IS NULL AND "cleanup_observed_at" IS NULL) OR
            ("cleanup_attempt_count" > 0 AND "cleanup_last_attempt_outcome" IS NOT NULL AND "cleanup_observed_at" IS NOT NULL)
          )
        ) OR (
          "cleanup_state" = 'succeeded' AND
          "cleanup_attempt_count" > 0 AND
          "cleanup_cause" IS NULL AND
          "cleanup_last_attempt_outcome" = 'succeeded' AND
          "cleanup_observed_at" IS NOT NULL
        ) OR (
          "cleanup_state" = 'failed' AND
          "cleanup_attempt_count" > 0 AND
          "cleanup_cause" IS NOT NULL AND
          "cleanup_last_attempt_outcome" IS NOT NULL AND
          "cleanup_observed_at" IS NOT NULL
        )
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_attempts_event_count_check"
    CHECK ("event_count" BETWEEN 0 AND 64),
  CONSTRAINT "task_provisioning_diagnostic_attempts_completeness_check"
    CHECK (
      (
        "completeness_marked_at" IS NULL AND
        "coverage" <> 'complete'
      ) OR (
        "completeness_marked_at" IS NOT NULL AND
        "coverage" = 'complete' AND
        "state" <> 'active' AND
        "cleanup_state" <> 'pending'
      )
    )
);

CREATE UNIQUE INDEX "task_provisioning_diagnostic_attempts_task_id_attempt_number_key"
ON "task_provisioning_diagnostic_attempts"("task_id", "attempt_number");

CREATE UNIQUE INDEX "task_provisioning_diagnostic_attempts_id_task_id_key"
ON "task_provisioning_diagnostic_attempts"("id", "task_id");

CREATE INDEX "task_provisioning_diagnostic_attempts_task_id_started_at_id_idx"
ON "task_provisioning_diagnostic_attempts"("task_id", "started_at", "id");

CREATE INDEX "task_provisioning_diagnostic_attempts_task_id_state_cleanup_state_idx"
ON "task_provisioning_diagnostic_attempts"("task_id", "state", "cleanup_state");

-- Supports always-on low-cardinality active-attempt gauge hydration without a
-- per-task read or identifier-labeled metric series.
CREATE INDEX "task_provisioning_diagnostic_attempts_state_started_at_idx"
ON "task_provisioning_diagnostic_attempts"("state", "started_at");

ALTER TABLE "task_provisioning_diagnostic_attempts"
ADD CONSTRAINT "task_provisioning_diagnostic_attempts_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "task_provisioning_diagnostic_events" (
  "id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "operation_id" TEXT NOT NULL,
  "admission_mode" TEXT NOT NULL,
  "provider_family" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "command_kind" TEXT,
  "outcome" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "duration_ms" INTEGER,
  "cause" TEXT,
  "retryable" BOOLEAN,
  "http_status_class" TEXT,
  "native_state" TEXT,
  "anomaly" TEXT,
  "exit_code" INTEGER,
  "timeout_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_provisioning_diagnostic_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_provisioning_diagnostic_events_schema_check"
    CHECK ("schema_version" = 1),
  CONSTRAINT "task_provisioning_diagnostic_events_id_check"
    CHECK (
      "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      "operation_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_sequence_check"
    CHECK ("sequence" BETWEEN 1 AND 64),
  CONSTRAINT "task_provisioning_diagnostic_events_idempotency_key_check"
    CHECK (
      octet_length("idempotency_key") BETWEEN 1 AND 160 AND
      "idempotency_key" = btrim("idempotency_key") AND
      "idempotency_key" ~ '^[a-z0-9][a-z0-9._:-]*$'
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_admission_mode_check"
    CHECK ("admission_mode" IN ('legacy', 'durable')),
  CONSTRAINT "task_provisioning_diagnostic_events_provider_family_check"
    CHECK ("provider_family" IN ('aio', 'cloud-http', 'boxlite', 'unknown')),
  CONSTRAINT "task_provisioning_diagnostic_events_stage_check"
    CHECK (
      "stage" IN (
        'accepted', 'sandbox_creation', 'credential_setup',
        'remote_ref_resolution', 'workspace_transfer', 'checkout',
        'submodules', 'credential_cleanup', 'runtime_setup', 'readiness',
        'agent_launch', 'complete', 'provider_selection', 'sandbox_start',
        'sandbox_inspect', 'native_execution', 'settlement', 'cleanup'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_operation_check"
    CHECK (
      "operation" IN (
        'provider_select', 'sandbox_create', 'sandbox_start', 'sandbox_inspect',
        'workspace_materialize', 'credential_setup', 'remote_ref_resolve',
        'repository_transfer', 'checkout', 'submodules', 'credential_cleanup',
        'runtime_preflight', 'runtime_setup', 'native_exec_start',
        'native_exec_poll', 'native_exec_attach', 'native_exec_settlement',
        'agent_launch', 'sandbox_delete', 'sandbox_absence_confirm'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_channel_check"
    CHECK ("channel" IN ('primary', 'cleanup', 'coordination')),
  CONSTRAINT "task_provisioning_diagnostic_events_command_kind_check"
    CHECK (
      "command_kind" IS NULL OR
      "command_kind" IN (
        'git_remote_ref', 'git_clone', 'git_checkout', 'git_submodules',
        'credential_setup', 'credential_cleanup', 'runtime_preflight',
        'runtime_setup', 'agent_launch', 'sandbox_cleanup'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_outcome_check"
    CHECK (
      "outcome" IN (
        'started', 'succeeded', 'failed', 'timed_out', 'cancelled',
        'degraded', 'indeterminate'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_cause_check"
    CHECK (
      "cause" IS NULL OR
      "cause" IN (
        'capacity_exhausted', 'authentication_failed', 'access_denied',
        'tls_network_failed', 'ref_not_found', 'workspace_timeout',
        'transport_failed', 'protocol_failed', 'provider_unavailable',
        'settlement_unknown', 'missing_exit_code', 'command_failed',
        'cancelled', 'superseded', 'cleanup_failed', 'cleanup_unconfirmed',
        'coordination_failed', 'diagnostic_write_failed', 'unknown'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_http_status_class_check"
    CHECK (
      "http_status_class" IS NULL OR
      "http_status_class" IN ('1xx', '2xx', '3xx', '4xx', '5xx')
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_native_state_check"
    CHECK (
      "native_state" IS NULL OR
      "native_state" IN ('pending', 'running', 'completed', 'failed', 'killed', 'timed_out', 'unknown')
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_anomaly_check"
    CHECK (
      "anomaly" IS NULL OR
      "anomaly" IN (
        'missing_exit_code', 'invalid_poll_settlement', 'poll_timeout',
        'poll_transport_failure', 'attach_degraded'
      )
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_numeric_bounds_check"
    CHECK (
      ("duration_ms" IS NULL OR "duration_ms" >= 0) AND
      ("timeout_ms" IS NULL OR "timeout_ms" > 0)
    ),
  CONSTRAINT "task_provisioning_diagnostic_events_fact_shape_check"
    CHECK (
      (
        "outcome" = 'started' AND
        "duration_ms" IS NULL AND
        "cause" IS NULL AND
        "retryable" IS NULL AND
        "http_status_class" IS NULL AND
        "native_state" IS NULL AND
        "anomaly" IS NULL AND
        "exit_code" IS NULL AND
        "timeout_ms" IS NULL
      ) OR (
        "outcome" <> 'started' AND
        "retryable" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "task_provisioning_diagnostic_events_attempt_id_idempotency_key_key"
ON "task_provisioning_diagnostic_events"("attempt_id", "idempotency_key");

CREATE UNIQUE INDEX "task_provisioning_diagnostic_events_attempt_id_sequence_key"
ON "task_provisioning_diagnostic_events"("attempt_id", "sequence");

CREATE INDEX "task_provisioning_diagnostic_events_task_id_observed_at_id_idx"
ON "task_provisioning_diagnostic_events"("task_id", "observed_at", "id");

ALTER TABLE "task_provisioning_diagnostic_events"
ADD CONSTRAINT "task_provisioning_diagnostic_events_attempt_id_task_id_fkey"
FOREIGN KEY ("attempt_id", "task_id")
REFERENCES "task_provisioning_diagnostic_attempts"("id", "task_id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "task_provisioning_diagnostic_compactions" (
  "task_id" TEXT NOT NULL,
  "compacted_attempt_from" INTEGER NOT NULL,
  "compacted_attempt_to" INTEGER NOT NULL,
  "compacted_attempt_count" INTEGER NOT NULL,
  "compacted_event_count" INTEGER NOT NULL,
  "truncation_count" INTEGER NOT NULL,
  "primary_succeeded_count" INTEGER NOT NULL DEFAULT 0,
  "primary_failed_count" INTEGER NOT NULL DEFAULT 0,
  "primary_timed_out_count" INTEGER NOT NULL DEFAULT 0,
  "primary_cancelled_count" INTEGER NOT NULL DEFAULT 0,
  "primary_degraded_count" INTEGER NOT NULL DEFAULT 0,
  "primary_indeterminate_count" INTEGER NOT NULL DEFAULT 0,
  "cleanup_not_required_count" INTEGER NOT NULL DEFAULT 0,
  "cleanup_pending_count" INTEGER NOT NULL DEFAULT 0,
  "cleanup_succeeded_count" INTEGER NOT NULL DEFAULT 0,
  "cleanup_failed_count" INTEGER NOT NULL DEFAULT 0,
  "compacted_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "task_provisioning_diagnostic_compactions_pkey" PRIMARY KEY ("task_id"),
  CONSTRAINT "task_provisioning_diagnostic_compactions_shape_check"
    CHECK (
      "compacted_attempt_from" >= 1 AND
      "compacted_attempt_to" >= "compacted_attempt_from" AND
      "compacted_attempt_count" >= 1 AND
      "compacted_event_count" >= 0 AND
      "truncation_count" >= 1 AND
      "primary_succeeded_count" >= 0 AND
      "primary_failed_count" >= 0 AND
      "primary_timed_out_count" >= 0 AND
      "primary_cancelled_count" >= 0 AND
      "primary_degraded_count" >= 0 AND
      "primary_indeterminate_count" >= 0 AND
      "cleanup_not_required_count" >= 0 AND
      "cleanup_pending_count" = 0 AND
      "cleanup_succeeded_count" >= 0 AND
      "cleanup_failed_count" >= 0 AND
      (
        "primary_succeeded_count" + "primary_failed_count" +
        "primary_timed_out_count" + "primary_cancelled_count" +
        "primary_degraded_count" + "primary_indeterminate_count"
      ) = "compacted_attempt_count" AND
      (
        "cleanup_not_required_count" + "cleanup_succeeded_count" +
        "cleanup_failed_count"
      ) = "compacted_attempt_count"
    )
);

ALTER TABLE "task_provisioning_diagnostic_compactions"
ADD CONSTRAINT "task_provisioning_diagnostic_compactions_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Identity and already-settled primary evidence are immutable. Mutable summary
-- fields may only advance monotonically as append-only events and cleanup
-- reconciliation are observed.
CREATE FUNCTION "task_provisioning_diagnostic_attempt_monotonic_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."task_id" IS DISTINCT FROM OLD."task_id" OR
     NEW."schema_version" IS DISTINCT FROM OLD."schema_version" OR
     NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number" OR
     NEW."admission_mode" IS DISTINCT FROM OLD."admission_mode" OR
     NEW."started_at" IS DISTINCT FROM OLD."started_at" OR
     NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'task provisioning diagnostic attempt identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  -- Provider selection may start at the safe `unknown` sentinel and then
  -- converge exactly once to the selected closed family. Once a concrete
  -- family has been recorded it is immutable, and the sentinel cannot regress
  -- to NULL.
  IF (
       OLD."provider_family" IS NOT NULL AND
       OLD."provider_family" <> 'unknown' AND
       NEW."provider_family" IS DISTINCT FROM OLD."provider_family"
     ) OR (
       OLD."provider_family" = 'unknown' AND
       NEW."provider_family" IS NULL
     ) THEN
    RAISE EXCEPTION 'task provisioning diagnostic provider family is immutable once selected'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."state" <> 'active' AND NEW."state" IS DISTINCT FROM OLD."state" THEN
    RAISE EXCEPTION 'task provisioning diagnostic terminal state is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."primary_outcome" IS NOT NULL AND (
    NEW."primary_outcome" IS DISTINCT FROM OLD."primary_outcome" OR
    NEW."primary_cause" IS DISTINCT FROM OLD."primary_cause" OR
    NEW."primary_retryable" IS DISTINCT FROM OLD."primary_retryable" OR
    NEW."primary_exit_code" IS DISTINCT FROM OLD."primary_exit_code" OR
    NEW."primary_observed_at" IS DISTINCT FROM OLD."primary_observed_at" OR
    NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
  ) THEN
    RAISE EXCEPTION 'task provisioning diagnostic primary outcome is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."event_count" < OLD."event_count" OR
     NEW."cleanup_attempt_count" < OLD."cleanup_attempt_count" THEN
    RAISE EXCEPTION 'task provisioning diagnostic counters are monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."cleanup_attempt_count" = OLD."cleanup_attempt_count" AND (
       NEW."cleanup_state" IS DISTINCT FROM OLD."cleanup_state" OR
       NEW."cleanup_cause" IS DISTINCT FROM OLD."cleanup_cause" OR
       NEW."cleanup_last_attempt_outcome" IS DISTINCT FROM OLD."cleanup_last_attempt_outcome" OR
       NEW."cleanup_observed_at" IS DISTINCT FROM OLD."cleanup_observed_at"
     ) AND NOT (
       OLD."cleanup_state" = 'not_required' AND
       NEW."cleanup_state" = 'pending' AND
       NEW."cleanup_attempt_count" = 0
     ) AND NOT (
       OLD."cleanup_state" = 'pending' AND
       NEW."cleanup_state" IN ('succeeded', 'failed') AND
       NEW."cleanup_last_attempt_outcome" IS NOT DISTINCT FROM
         OLD."cleanup_last_attempt_outcome" AND
       NEW."cleanup_observed_at" IS NOT DISTINCT FROM
         OLD."cleanup_observed_at"
     ) THEN
    RAISE EXCEPTION 'task provisioning diagnostic cleanup evidence requires a monotonic attempt'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."completeness_marked_at" IS NOT NULL AND
     NEW."completeness_marked_at" IS DISTINCT FROM OLD."completeness_marked_at" THEN
    RAISE EXCEPTION 'task provisioning diagnostic completeness marker is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_provisioning_diagnostic_attempt_monotonic_update_trigger"
BEFORE UPDATE ON "task_provisioning_diagnostic_attempts"
FOR EACH ROW
EXECUTE FUNCTION "task_provisioning_diagnostic_attempt_monotonic_update"();

-- Event evidence is append-only. Attempt deletion is allowed only as part of a
-- Task cascade or inside the recorder's transactionally controlled compaction
-- section (`SET LOCAL cap.diagnostic_compaction = 'on'`).
CREATE FUNCTION "task_provisioning_diagnostic_event_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'task provisioning diagnostic events are immutable'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_provisioning_diagnostic_event_immutable_trigger"
BEFORE UPDATE ON "task_provisioning_diagnostic_events"
FOR EACH ROW
EXECUTE FUNCTION "task_provisioning_diagnostic_event_immutable"();

CREATE FUNCTION "task_provisioning_diagnostic_event_controlled_delete"()
RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR
     current_setting('cap.diagnostic_compaction', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'task provisioning diagnostic events require controlled deletion'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_provisioning_diagnostic_event_controlled_delete_trigger"
BEFORE DELETE ON "task_provisioning_diagnostic_events"
FOR EACH ROW
EXECUTE FUNCTION "task_provisioning_diagnostic_event_controlled_delete"();

CREATE FUNCTION "task_provisioning_diagnostic_attempt_controlled_delete"()
RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR
     current_setting('cap.diagnostic_compaction', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'task provisioning diagnostic attempts require controlled deletion'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_provisioning_diagnostic_attempt_controlled_delete_trigger"
BEFORE DELETE ON "task_provisioning_diagnostic_attempts"
FOR EACH ROW
EXECUTE FUNCTION "task_provisioning_diagnostic_attempt_controlled_delete"();
