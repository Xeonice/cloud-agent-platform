-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM (
    'pending',
    'queued',
    'running',
    'awaiting_input',
    'completed',
    'failed',
    'agent_failed_to_start'
);

-- CreateTable
CREATE TABLE "repos" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "git_source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_repo_id_idx" ON "tasks"("repo_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
