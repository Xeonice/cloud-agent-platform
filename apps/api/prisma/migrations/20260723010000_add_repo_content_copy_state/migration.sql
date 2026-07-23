-- Repo-store content-copy state (add-repo-content-store).
--
-- Every Repo now owns a bare-mirror copy in the shared repo-store volume. The
-- copy is materialized at import time and refreshed only on operator request,
-- so the row must carry both the copy state and the instant the copy content
-- last completed.
--
-- Existing rows deliberately land on `missing` with a NULL timestamp: no copy
-- exists for them yet and the system never mass-backfills on upgrade. Operators
-- promote them one at a time via refresh/re-import.
ALTER TABLE "repos"
ADD COLUMN "copy_status" TEXT NOT NULL DEFAULT 'missing',
ADD COLUMN "copy_updated_at" TIMESTAMP(3);

-- Closed state vocabulary; application code owns the transitions.
ALTER TABLE "repos"
ADD CONSTRAINT "repos_copy_status_check"
CHECK ("copy_status" IN ('missing', 'refreshing', 'ready', 'failed'));

-- State/timestamp coherence:
--   missing    -> no copy ever completed, so no timestamp may be claimed.
--   ready      -> a copy completed, so the timestamp is mandatory.
--   refreshing -> in flight; NULL on a first acquisition, retained on a refresh.
--   failed     -> a last-good copy may still exist (refresh failure) or not
--                 (import failure); both timestamp shapes are legal.
ALTER TABLE "repos"
ADD CONSTRAINT "repos_copy_state_shape_check"
CHECK (
  ("copy_status" = 'missing' AND "copy_updated_at" IS NULL) OR
  ("copy_status" = 'ready' AND "copy_updated_at" IS NOT NULL) OR
  ("copy_status" IN ('refreshing', 'failed'))
);

-- Task-creation gating and console listings read Repos by copy state.
CREATE INDEX "repos_copy_status_idx" ON "repos"("copy_status");
