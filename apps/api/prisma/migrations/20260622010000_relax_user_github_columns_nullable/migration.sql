-- add-private-account-identity (integration track, step 10.1):
--   ENABLE local (non-GitHub) accounts by relaxing the legacy GitHub-only NOT NULL
--   constraints on `users`. The contracts-schema backfill (1.3) deliberately kept
--   `github_id` / `login` / `avatar_url` NOT NULL so it stayed additive + non-
--   breaking to the existing GitHub-identity reads; relaxing them was explicitly
--   deferred to "the tracks that create local accounts" (the admin seed +
--   admin-created accounts). This is that step.
--
--   Without this, creating a local account (the default-admin seed, or an
--   admin-created password account) fails at INSERT with a null-constraint
--   violation on `github_id`, because a local account legitimately has NO GitHub
--   identity — the github numeric id, login handle, and avatar all live only on a
--   `github` IdentityLink, never on a local `User`.
--
--   This is the NULLABILITY RELAX, distinct from the later CONTRACT step (10.4)
--   that DROPS `github_id` / `github_access_token` entirely once every read routes
--   through the github-identity helper. Here the columns REMAIN (the rollback
--   window is preserved) — they merely stop being mandatory.
--
--   The matching Prisma model already declares `githubId Int? @unique`,
--   `login String?`, `avatarUrl String?`, so after this migration the schema and
--   the database agree.
--
-- IDEMPOTENT / RE-RUNNABLE: `DROP NOT NULL` is a no-op when the column is already
-- nullable, so re-applying this migration against a partially-migrated database
-- makes no further change. `@unique` on `github_id` is unaffected (Postgres does
-- not unique-constrain NULLs, so many local accounts — all with NULL github_id —
-- coexist alongside the one-to-one GitHub rows).

ALTER TABLE "users" ALTER COLUMN "github_id" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "login" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "avatar_url" DROP NOT NULL;
