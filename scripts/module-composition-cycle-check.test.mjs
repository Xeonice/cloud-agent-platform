import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EDGE,
  checkEdge,
  findForwardRefViolations,
  main,
} from './module-composition-cycle-check.mjs';

// ---- the live repository ----------------------------------------------------

test('the adjudicated edge is clean in this tree', () => {
  const { missing, violations } = checkEdge();
  assert.deepEqual(missing, [], 'both module files must be where the gate reads them');
  assert.deepEqual(violations, [], 'neither module may wrap the other in forwardRef');
});

test('the gate reads exactly the two files phase 4 criterion (d) names', () => {
  assert.equal(EDGE.length, 2);
  assert.deepEqual(
    EDGE.map((entry) => entry.file).sort(),
    [
      'apps/api/src/guardrails/guardrails.module.ts',
      'apps/api/src/tasks/tasks.module.ts',
    ],
    'widening this set without an adjudication would be inventing policy under a gate',
  );
});

// ---- direction 1: a reintroduced forwardRef -----------------------------------

test('a forwardRef wrapping the other module is a violation', () => {
  const hits = findForwardRefViolations(
    `import { forwardRef, Module } from '@nestjs/common';
@Module({
  imports: [
    forwardRef(() => GuardrailsModule),
  ],
})`,
    'GuardrailsModule',
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 4);
});

test('whitespace inside the forwardRef call does not hide it', () => {
  const hits = findForwardRefViolations(
    '    forwardRef( ( ) => GuardrailsModule ),',
    'GuardrailsModule',
  );
  assert.equal(hits.length, 1);
});

test('a forwardRef naming a DIFFERENT module is not this edge', () => {
  const hits = findForwardRefViolations(
    '    forwardRef(() => SomeOtherModule),',
    'GuardrailsModule',
  );
  assert.deepEqual(hits, []);
});

test('prose naming the retired forwardRef is kept, not counted', () => {
  const hits = findForwardRefViolations(
    ` * one kept a \`forwardRef\` after the edge it wrapped was removed, and
 * GuardrailsModule is imported plainly now.
    // forwardRef(() => GuardrailsModule) used to live here`,
    'GuardrailsModule',
  );
  assert.deepEqual(
    hits,
    [],
    'counting comments would push a future author to delete the explanation to make the number zero',
  );
});

// ---- direction 2: the gate losing its subject ---------------------------------

test('a missing module file FAILS rather than passing over a file it never opened', () => {
  const { missing, violations } = checkEdge({
    exists: (absolute) => !absolute.endsWith('tasks.module.ts'),
    read: () => '',
  });
  assert.deepEqual(missing, ['apps/api/src/tasks/tasks.module.ts']);
  assert.deepEqual(violations, [], 'a file that is absent cannot also be in violation');
});

test('main exits non-zero when either file is missing', () => {
  const previousError = console.error;
  console.error = () => {};
  try {
    assert.equal(main({ root: '/nonexistent-root-for-this-test' }), 1);
  } finally {
    console.error = previousError;
  }
});

test('main exits zero on the live tree', () => {
  const previousLog = console.log;
  console.log = () => {};
  try {
    assert.equal(main(), 0);
  } finally {
    console.log = previousLog;
  }
});
