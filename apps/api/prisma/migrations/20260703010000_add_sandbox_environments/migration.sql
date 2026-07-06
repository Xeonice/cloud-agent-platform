-- CreateTable
CREATE TABLE "sandbox_environments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "provider_families" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "runtime_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "last_validation_id" TEXT,
    "contract_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_environment_validations" (
    "id" TEXT NOT NULL,
    "environment_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_family" TEXT NOT NULL,
    "runtime_id" TEXT,
    "source_kind" TEXT NOT NULL,
    "resolved_digest" TEXT,
    "resolved_checksum" TEXT,
    "probes" JSONB,
    "error" TEXT,
    "contract_version" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_environment_validations_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "sandbox_environment_id" TEXT;

-- CreateIndex
CREATE INDEX "sandbox_environments_status_is_default_idx" ON "sandbox_environments"("status", "is_default");

-- CreateIndex
CREATE INDEX "sandbox_environment_validations_environment_id_checked_at_idx" ON "sandbox_environment_validations"("environment_id", "checked_at");

-- CreateIndex
CREATE INDEX "tasks_sandbox_environment_id_idx" ON "tasks"("sandbox_environment_id");

-- AddForeignKey
ALTER TABLE "sandbox_environment_validations" ADD CONSTRAINT "sandbox_environment_validations_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "sandbox_environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sandbox_environment_id_fkey" FOREIGN KEY ("sandbox_environment_id") REFERENCES "sandbox_environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
