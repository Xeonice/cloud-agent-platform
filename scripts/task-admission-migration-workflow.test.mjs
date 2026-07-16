import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from './public-surface-tests.mjs';

const JOB_KEY = 'task-admission-migration-compatibility';

function workflowJob(source, key) {
  const marker = `\n  ${key}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job ${key}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^  [a-z0-9-]+:\s*$/mu);
  return next === -1
    ? source.slice(start)
    : source.slice(start, start + marker.length + next);
}

test('migration compatibility has a gated disposable service job and fixed command', () => {
  const workflow = readFileSync(
    path.join(REPO_ROOT, '.github/workflows/ci.yml'),
    'utf8',
  );
  const job = workflowJob(workflow, JOB_KEY);

  assert.match(job, /^    name: task admission migration compatibility$/mu);
  assert.match(job, /^        image: \S+$/mu);
  assert.match(job, /^          - 5432:5432$/mu);
  assert.match(job, /--health-cmd "pg_isready -U cap -d cap"/u);
  assert.match(
    job,
    /^          CAP_TASK_ADMISSION_MIGRATION_TEST: "1"$/mu,
  );
  const command = job.match(
    /^        run: (pnpm --filter @cap\/api test:migration:task-admission)$/mu,
  );
  assert.equal(
    command?.[1],
    'pnpm --filter @cap/api test:migration:task-admission',
  );
  assert.doesNotMatch(command?.[1] ?? '', /(?:\||&&|;|\b(?:bash|sh)\b)/u);
});
