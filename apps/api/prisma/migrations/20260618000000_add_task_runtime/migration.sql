-- add-claude-code-runtime: add the optional agent-runtime selector to tasks.
-- Nullable text column kept in sync with the `@cap/contracts` RuntimeSchema
-- values (`claude-code` | `codex`). Additive and backward-compatible: existing
-- rows backfill to NULL and an omitted-on-create value reads back as the default
-- `codex` (the service applies the default; the column stores NULL when unset),
-- so pre-existing tasks remain valid.
ALTER TABLE "tasks" ADD COLUMN "runtime" TEXT;
