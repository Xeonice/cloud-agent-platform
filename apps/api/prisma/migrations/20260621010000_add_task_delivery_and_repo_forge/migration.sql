-- add-multi-forge-task-delivery: source forge on repos + opt-in result delivery
-- columns on tasks. All additive + NULLABLE (existing rows backfill to NULL; the
-- service reads a null `deliver` as `none` and a null `forge` is inferred from the
-- gitSource host), mirroring the `runtime` / `execution_mode` convention.

-- Repo: source forge + cached GitLab project id.
ALTER TABLE "repos" ADD COLUMN "forge" TEXT;
ALTER TABLE "repos" ADD COLUMN "gitlab_project_id" TEXT;

-- Task: opt-in delivery selector + push-back result.
ALTER TABLE "tasks" ADD COLUMN "deliver" TEXT;
ALTER TABLE "tasks" ADD COLUMN "deliver_status" TEXT;
ALTER TABLE "tasks" ADD COLUMN "branch_pushed" TEXT;
ALTER TABLE "tasks" ADD COLUMN "commit_sha" TEXT;
ALTER TABLE "tasks" ADD COLUMN "change_request_url" TEXT;
ALTER TABLE "tasks" ADD COLUMN "change_request_number" INTEGER;
