/**
 * Minimal smoke test for the Postgres + Prisma data model.
 *
 * Scenario:
 *  1. Create a Repo
 *  2. Create a Task scoped to that Repo (status defaults to `pending`)
 *  3. Read the Task back and verify FK relationship and default status
 *  4. Cascade delete: deleting the Repo removes its Tasks
 *
 * Run:
 *   DATABASE_URL="postgresql://tanghehui@localhost:5432/cap_test?schema=public" \
 *     node prisma/test-model.mjs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

async function run() {
  // Clean slate
  await prisma.task.deleteMany();
  await prisma.repo.deleteMany();

  console.log('\n--- 1. Create Repo ---');
  const repo = await prisma.repo.create({
    data: { name: 'test-repo', gitSource: 'https://github.com/test/repo.git' },
  });
  assert(typeof repo.id === 'string' && repo.id.length > 0, 'repo.id is a non-empty string (cuid)');
  assert(repo.name === 'test-repo', 'repo.name matches');
  assert(repo.gitSource === 'https://github.com/test/repo.git', 'repo.gitSource matches');
  assert(repo.createdAt instanceof Date, 'repo.createdAt is a Date');

  console.log('\n--- 2. Create Task scoped to Repo ---');
  const task = await prisma.task.create({
    data: { repoId: repo.id, prompt: 'Fix the bug' },
  });
  assert(typeof task.id === 'string' && task.id.length > 0, 'task.id is a non-empty string');
  assert(task.repoId === repo.id, 'task.repoId FK matches repo.id');
  assert(task.prompt === 'Fix the bug', 'task.prompt matches');
  assert(task.status === 'pending', 'task.status defaults to `pending`');
  assert(task.createdAt instanceof Date, 'task.createdAt is a Date');

  console.log('\n--- 3. Read Task back and verify via relation ---');
  const found = await prisma.task.findUnique({
    where: { id: task.id },
    include: { repo: true },
  });
  assert(found !== null, 'task found by id');
  assert(found.repo.id === repo.id, 'included repo relation has correct id');
  assert(found.repo.name === 'test-repo', 'included repo relation has correct name');

  console.log('\n--- 4. Index: list tasks by repoId ---');
  const byRepo = await prisma.task.findMany({ where: { repoId: repo.id } });
  assert(byRepo.length === 1, 'findMany by repoId returns exactly 1 task');
  assert(byRepo[0].id === task.id, 'returned task id matches');

  console.log('\n--- 5. Status update (pending -> running) ---');
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'running' },
  });
  assert(updated.status === 'running', 'task status updated to `running`');

  console.log('\n--- 6. Cascade delete: deleting Repo removes Tasks ---');
  await prisma.repo.delete({ where: { id: repo.id } });
  const orphan = await prisma.task.findUnique({ where: { id: task.id } });
  assert(orphan === null, 'task is deleted when parent repo is deleted (ON DELETE CASCADE)');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('Unexpected error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
