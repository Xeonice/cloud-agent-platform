-- Operational rollback prerequisite: drain admission before running this file,
-- then restore the previous matched API/Web release. The widened constraints
-- are additive and intentionally remain in place.

UPDATE "tasks"
SET "failure_code" = 'provisioning_unknown'
WHERE "failure_code" = 'provisioning_platform_dependency_unavailable';

UPDATE "task_admission_work"
SET "cause_code" = 'provisioning_unknown'
WHERE "cause_code" = 'provisioning_platform_dependency_unavailable';
