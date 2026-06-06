-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result_code" INTEGER,
    "run_id" TEXT,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_settings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "default_repo_id" TEXT,
    "retention" INTEGER NOT NULL,
    "write_confirm" BOOLEAN NOT NULL,

    CONSTRAINT "account_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "base_url" TEXT,
    "api_key_ciphertext" TEXT,
    "api_key_last4" TEXT,
    "default_model" TEXT,

    CONSTRAINT "codex_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_task_id_timestamp_idx" ON "audit_events"("task_id", "timestamp");

-- CreateIndex
CREATE INDEX "audit_events_timestamp_idx" ON "audit_events"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "account_settings_user_id_key" ON "account_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_credentials_user_id_key" ON "codex_credentials"("user_id");

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_credentials" ADD CONSTRAINT "codex_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
