-- IRREVERSIBLE DATA DELETION — read this before running it.
--
-- This change retires the legacy inline-admission pipeline and removes the
-- `legacy` member from the published admission-mode enum. That enum is not a
-- presentation detail: it validates a PERSISTED column on two tables, on the
-- READ path —
--
--   "task_provisioning_diagnostic_attempts"."admission_mode"
--   "task_provisioning_diagnostic_events"."admission_mode"
--
-- Narrowing the enum without touching the data would leave the service unable
-- to parse rows it wrote itself: every historical diagnostic row recording
-- legacy admission would fail validation when read back, surfacing as a broken
-- read of old tasks rather than as a contract break for callers.
--
-- This migration therefore removes those rows. It deliberately does NOT relabel
-- them to the surviving value. These tables exist to answer, after the fact,
-- which admission path a task took; assigning `durable` to an attempt that was
-- admitted inline would falsify exactly the answer they are kept for.
-- Destroying the record honestly is preferable to preserving a falsified one.
--
-- ROLLBACK: NONE. This deletion CANNOT BE UNDONE by reverting the code, and it
-- cannot be undone from inside the database either. The column is plain TEXT
-- carrying no history of its own, the rows are gone once this commits, and the
-- only restore path is a backup taken before this migration ran.
--
-- Two facts an operator should know, neither of them acted on here:
--
--   * Both tables still carry a `..._admission_mode_check` CHECK constraint
--     that enumerates the retired value alongside the surviving one. It is left
--     exactly as it stands: it is the historical record of the schema, and this
--     change relies on the retirement of every writer — not on the database —
--     to keep the value from reappearing. Widening it back would not restore
--     anything this deletes.
--   * "task_provisioning_diagnostic_compactions" carries no admission-mode
--     column, so per-task aggregate counts that once summarised inline-admitted
--     attempts are neither reachable by this scrub nor distinguishable within
--     it. They are aggregates over attempts that were already deleted at
--     compaction time, and rewriting them would falsify counts.
--
-- Both diagnostic tables carry BEFORE DELETE triggers
-- (`..._controlled_delete_trigger`) that reject uncontrolled deletion. This
-- migration enters the same transactionally scoped compaction section the
-- recorder uses, so the removal is deliberate rather than incidental. Prisma
-- applies each migration file inside a transaction, which is what scopes the
-- setting below; run outside one, the triggers refuse the deletion loudly
-- rather than letting it half-happen.

SET LOCAL cap.diagnostic_compaction = 'on';

-- Attempts first. Deleting an attempt cascades to its events, so an attempt
-- whose evidence records legacy admission leaves behind neither an orphaned
-- event nor a surviving attempt whose `event_count` outlives the events it
-- counted.
DELETE FROM "task_provisioning_diagnostic_attempts"
WHERE "admission_mode" = 'legacy'
   OR "id" IN (
     SELECT "attempt_id"
     FROM "task_provisioning_diagnostic_events"
     WHERE "admission_mode" = 'legacy'
   );

-- The second table carrying the column, stated in its own right rather than
-- left implicit in the cascade above. After that statement the foreign key
-- leaves nothing here to remove; this keeps the scrub true of the column
-- wherever it is persisted, and stays true if the cascade is ever relaxed.
DELETE FROM "task_provisioning_diagnostic_events"
WHERE "admission_mode" = 'legacy';
