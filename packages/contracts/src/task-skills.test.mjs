/**
 * Schema round-trip for the `skills` inert run parameter (task-preinstall-skills,
 * task 2.3). Drives the REAL compiled zod schemas from dist/ — the contract is
 * the single source of truth shared by api + web, so this guards that a sent
 * `skills` value is a readable value and that omission reads back empty/absent
 * (never fabricated), exactly like branch/strategy.
 *
 * Requires `pnpm --filter @cap/contracts build` first. Run: `node task-skills.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { CreateTaskRequestSchema, TaskResponseSchema, TaskSchema } = require(
  path.join(here, '..', 'dist', 'task.js'),
);

test('CreateTaskRequest accepts a skills array', () => {
  const parsed = CreateTaskRequestSchema.parse({
    prompt: 'do the thing',
    skills: ['openspec', 'bmad'],
  });
  assert.deepEqual(parsed.skills, ['openspec', 'bmad']);
});

test('CreateTaskRequest without skills is valid (omission allowed)', () => {
  const parsed = CreateTaskRequestSchema.parse({ prompt: 'do the thing' });
  assert.equal(parsed.skills, undefined, 'omitted skills stays undefined, not fabricated');
});

test('CreateTaskRequest rejects empty-string skill ids', () => {
  assert.throws(
    () => CreateTaskRequestSchema.parse({ prompt: 'x', skills: [''] }),
    'empty skill id is rejected by min(1)',
  );
});

test('TaskResponse echoes a skills array back (sent == readable)', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    prompt: 'p',
    status: 'pending',
    createdAt: new Date().toISOString(),
    branch: null,
    strategy: null,
    skills: ['openspec'],
  };
  const parsed = TaskResponseSchema.parse(row);
  assert.deepEqual(parsed.skills, ['openspec']);
});

test('TaskResponse with empty skills reads back as [] (never fabricated)', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    prompt: 'p',
    status: 'pending',
    createdAt: new Date().toISOString(),
    branch: null,
    strategy: null,
    skills: [],
  };
  const parsed = TaskResponseSchema.parse(row);
  assert.deepEqual(parsed.skills, []);
});

test('skills is independent of status — same schema accepts any lifecycle state', () => {
  // Inert: skills does not gate lifecycle; the schema accepts skills with any
  // status value the enum allows (a structural proxy for "does not gate").
  for (const status of ['pending', 'queued', 'running', 'completed', 'failed']) {
    const parsed = TaskSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      repoId: '22222222-2222-4222-8222-222222222222',
      prompt: 'p',
      status,
      createdAt: new Date().toISOString(),
      skills: ['openspec'],
    });
    assert.equal(parsed.status, status);
    assert.deepEqual(parsed.skills, ['openspec']);
  }
});
