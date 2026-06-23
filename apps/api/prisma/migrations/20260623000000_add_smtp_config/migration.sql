-- add-smtp-config-ui:
--   Persist a deployment-level SMTP configuration so an administrator can manage
--   it from the console without ssh/restart. Two additive parts:
--
--   1. A singleton `smtp_config` table (addressed via a FIXED-id upsert, like
--      `system_settings`) holding the non-secret host/port/user/from plus the
--      password ENCRYPTED at rest (`pass_ciphertext` — ciphertext only, never
--      plaintext) and a masked `pass_last4` suffix for display.
--   2. A one-time env→DB migration marker on `system_settings`
--      (`smtp_env_migrated_at`), mirroring `admin_reveal_consumed_at`: a boot
--      seed copies the `SMTP_*` env into the row at most once and stamps this so
--      a later admin edit/delete is never overwritten on a subsequent boot.
--
-- Purely additive — no backfill row is inserted: absence of the `smtp_config`
-- row means outbound mail falls back to the `SMTP_*` env (current behavior), so
-- first boot after deploy is behavior-unchanged until an admin saves (or the
-- one-time env migration runs).

-- AlterTable: add the one-time env→DB migration marker (additive, nullable).
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "smtp_env_migrated_at" TIMESTAMP(3);

-- CreateTable: the singleton SMTP configuration.
CREATE TABLE "smtp_config" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "user" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "pass_ciphertext" TEXT,
    "pass_last4" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smtp_config_pkey" PRIMARY KEY ("id")
);
