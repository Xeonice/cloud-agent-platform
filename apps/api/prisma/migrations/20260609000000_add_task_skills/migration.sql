-- task-preinstall-skills: add the inert `skills` run parameter to tasks.
-- Postgres text[] with an empty-array default so existing rows backfill to {}
-- and omitted-on-create reads back as an empty list (never null/fabricated).
ALTER TABLE "tasks" ADD COLUMN     "skills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
