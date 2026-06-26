-- Provider-owned sandbox run metadata. Additive and nullable so existing tasks
-- require no backfill; records are written only for future successful provisions.
CREATE TABLE "sandbox_runs" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_sandbox_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "connection_json" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "terminal_at" TIMESTAMP(3),
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "sandbox_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sandbox_runs_task_id_status_idx" ON "sandbox_runs"("task_id", "status");
CREATE INDEX "sandbox_runs_provider_id_provider_sandbox_id_idx" ON "sandbox_runs"("provider_id", "provider_sandbox_id");

ALTER TABLE "sandbox_runs"
ADD CONSTRAINT "sandbox_runs_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
