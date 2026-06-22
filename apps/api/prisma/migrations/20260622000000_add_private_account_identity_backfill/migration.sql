-- add-private-account-identity (track contracts-schema-deps, task 1.3):
--   The EXPAND step of an expand-contract migration that decouples `User` from
--   GitHub. It is additive + backfilling ONLY — it never drops the legacy
--   `users.github_id` / `users.github_access_token` columns (that CONTRACT step is
--   a separate, later migration once all reads route through the github-identity
--   helper, preserving a rollback window).
--
-- This migration:
--   1. adds the `Role` enum + the `identity_links` and `email_otps` tables;
--   2. adds the new `users` account columns (`email`, `role`, `must_change_password`)
--      WITHOUT relaxing the existing GitHub-only columns — keeping this contracts-
--      schema step additive + non-breaking to the existing GitHub-identity reads
--      (relaxing `github_id`/`login`/`name`/`avatar_url` to NULLABLE for local
--      accounts is deferred to the tracks that create local accounts);
--   3. adds the one-time admin-reveal gate column on `system_settings`;
--   4. BACKFILLS a `github` `identity_links` row for every existing user
--      (provider_account_id = github_id::text, secret = the existing — already
--      encrypted-at-rest — access token) and sets `email` where derivable.
--
-- IDEMPOTENT / RE-RUNNABLE: every DDL uses IF (NOT) EXISTS and the backfill INSERT
-- uses `ON CONFLICT (provider, provider_account_id) DO NOTHING`, so re-applying it
-- against a partially-migrated database makes no further change.

-- CreateEnum (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role') THEN
        CREATE TYPE "Role" AS ENUM ('admin', 'member');
    END IF;
END
$$;

-- AlterTable: add the new account columns (additive only). ADD COLUMN IF NOT EXISTS
-- is idempotent.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" "Role" NOT NULL DEFAULT 'member';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: one-time admin-credential reveal gate.
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "admin_reveal_consumed_at" TIMESTAMP(3);

-- CreateTable: identity_links
CREATE TABLE IF NOT EXISTS "identity_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_provider_provider_account_id_key" ON "identity_links"("provider", "provider_account_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "identity_links_user_id_idx" ON "identity_links"("user_id");

-- AddForeignKey (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'identity_links_user_id_fkey'
    ) THEN
        ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- CreateTable: email_otps
CREATE TABLE IF NOT EXISTS "email_otps" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_otps_email_idx" ON "email_otps"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_otps_expires_at_idx" ON "email_otps"("expires_at");

-- CreateIndex: enforce the UNIQUE email constraint Prisma models as `email String? @unique`.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");

-- ---------------------------------------------------------------------------
-- DATA BACKFILL (idempotent)
-- ---------------------------------------------------------------------------

-- `gen_random_uuid()` is in core Postgres 13+; ensure it resolves on older PG by
-- providing the pgcrypto extension (idempotent, no-op when already present/built-in).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Backfill a `github` identity for every existing GitHub-keyed user. The legacy
-- `github_access_token` value (already the encrypted-at-rest envelope where a key
-- is configured, or legacy plaintext otherwise) is copied verbatim into the
-- identity's `secret`; the shared github-identity helper (`readMaybeEncrypted`)
-- decrypts it at point of use, so no re-encryption happens here. `gen_random_uuid()`
-- supplies the row id. `ON CONFLICT DO NOTHING` against the UNIQUE
-- (provider, provider_account_id) makes a re-run a no-op.
INSERT INTO "identity_links" ("id", "user_id", "provider", "provider_account_id", "secret", "created_at")
SELECT
    gen_random_uuid()::text,
    u."id",
    'github',
    u."github_id"::text,
    u."github_access_token",
    u."created_at"
FROM "users" u
WHERE u."github_id" IS NOT NULL
ON CONFLICT ("provider", "provider_account_id") DO NOTHING;

-- Set `email` where derivable from existing data. The legacy GitHub-only schema
-- stored no email column, so there is no in-row email to derive for pre-migration
-- users; this UPDATE is written defensively (only fills a NULL email, never
-- clobbers, and only from a value that already looks like an email) so it stays a
-- safe no-op on this schema and a correct backfill if a derivable source exists.
-- GitHub users acquire their primary verified email at their next login (the
-- `user:email` scope added in the auth-core track), not here.
UPDATE "users"
SET "email" = "login"
WHERE "email" IS NULL
  AND "login" IS NOT NULL
  AND "login" LIKE '%@%';
