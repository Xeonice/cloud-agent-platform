-- persist-session-transcripts:
--   add the durable `session_transcripts` index table — one row per task
--   (UNIQUE `task_id`, 1:1 with `tasks`), upserted on proactive terminal
--   capture OR a later read-through backfill. The RAW gzip-compressed rollout
--   JSONL itself lives on the durable workspace volume at `archive_path` and
--   stays the source of truth; this row is a derivable catalog entry that
--   survives container reaping and makes transcripts both id-openable AND
--   content-searchable across history.
--
-- Purely ADDITIVE and forward-only: a new table + its indexes + an FK to
-- `tasks`. No existing table is touched and no backfill row is inserted, so the
-- first boot after deploy is behavior-unchanged until the capture path writes.
-- Rollback is a clean `DROP TABLE "session_transcripts"` (which cascades the
-- unique index, the GIN FTS index, and the FK constraint).

-- CreateTable
CREATE TABLE "session_transcripts" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "model" TEXT,
    "cwd" TEXT,
    "started_at" TIMESTAMP(3),
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "is_interrupted" BOOLEAN NOT NULL DEFAULT false,
    "archive_path" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" TEXT NOT NULL,

    CONSTRAINT "session_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_transcripts_task_id_key" ON "session_transcripts"("task_id");

-- CreateIndex: Postgres full-text GIN index over the searchable `content`
-- column so transcripts are queryable ACROSS history by content. Prisma 5 has
-- no native `tsvector` column type, so the index is declared here in raw SQL as
-- an expression index on `to_tsvector('english', content)`; a content search
-- runs `WHERE to_tsvector('english', content) @@ plainto_tsquery('english', :q)`
-- and the GIN index serves it. Dropped automatically when the table is dropped.
CREATE INDEX "session_transcripts_content_fts_idx"
    ON "session_transcripts"
    USING GIN (to_tsvector('english', "content"));

-- AddForeignKey
ALTER TABLE "session_transcripts" ADD CONSTRAINT "session_transcripts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
