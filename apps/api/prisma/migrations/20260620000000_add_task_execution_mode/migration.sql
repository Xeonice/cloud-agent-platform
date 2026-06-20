-- add-headless-execution-track: per-task execution mode (interactive-pty | headless-exec).
-- Additive + NULLABLE so existing rows backfill to NULL (read back as the default
-- interactive-pty in the service), mirroring the `runtime` column.
ALTER TABLE "tasks" ADD COLUMN "execution_mode" TEXT;
