-- AlterTable
ALTER TABLE "repos" ADD COLUMN     "branch_count" INTEGER,
ADD COLUMN     "default_branch" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "github_id" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "strategy" TEXT;
