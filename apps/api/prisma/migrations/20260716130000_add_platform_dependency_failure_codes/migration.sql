-- Add the secret-free, non-retryable control-plane dependency failure without
-- rewriting any existing Task or admission-work row. Both persisted allowlists
-- remain byte-for-byte aligned with the canonical TaskFailure union.

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
    'provisioning_platform_dependency_unavailable',
    'provisioning_unknown'
  )
);

ALTER TABLE "task_admission_work"
DROP CONSTRAINT "task_admission_work_cause_code_check";

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
    'provisioning_platform_dependency_unavailable',
    'provisioning_unknown'
  )
);
