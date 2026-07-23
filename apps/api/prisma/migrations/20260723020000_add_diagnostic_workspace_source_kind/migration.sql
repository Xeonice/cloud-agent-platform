-- Workspace-source variant on provisioning diagnostic evidence
-- (add-repo-content-store).
--
-- The three injection variants (repo-store volume mount, repo-store archive
-- transfer, legacy in-sandbox network clone) share one closed stage/operation
-- vocabulary, so retained evidence could not say WHICH variant materialized a
-- workspace. This column names it.
--
-- Additive and nullable by construction: every event retained before this
-- migration keeps NULL, and operations that materialize no workspace (sandbox
-- create, runtime setup, cleanup, native execution) never set it. No backfill
-- is attempted — an immutable ledger is never rewritten to invent evidence
-- that was not observed.
ALTER TABLE "task_provisioning_diagnostic_events"
ADD COLUMN "workspace_source_kind" TEXT;

-- Closed vocabulary, mirroring WORKSPACE_SOURCE_KINDS and the wire contract.
ALTER TABLE "task_provisioning_diagnostic_events"
ADD CONSTRAINT "task_provisioning_diagnostic_events_workspace_source_kind_check"
CHECK (
  "workspace_source_kind" IS NULL OR
  "workspace_source_kind" IN ('volume', 'archive', 'git')
);
