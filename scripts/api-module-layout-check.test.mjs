/**
 * Guards the API module layout gate.
 *
 * Two rules, and the second has a boundary that is easy to get wrong: DI
 * composition is exempt, but only when EVERY import forming the cycle is written
 * in a `*.module.ts`. A gate that exempts a cycle because one side happens to be
 * a module file would have passed the `tasks ⟷ guardrails` cycle this change
 * actually had to invert. Both directions are exercised below.
 *
 * Run: node --test scripts/api-module-layout-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { findLayoutViolations } from './api-module-layout-check.mjs';

const DIR = 'apps/api/src';

/** Build a throwaway package tree and scan it with the real implementation. */
function scan(files, { allowed = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'layout-gate-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, DIR, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return findLayoutViolations({
      root,
      governed: [{ dir: DIR, alias: '@/' }],
      allowed,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a relative traversal import is reported', () => {
  const found = scan({
    'tasks/tasks.service.ts': "import { x } from '../guardrails/thing';\n",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'relative-traversal');
  assert.match(found[0].file, /tasks\/tasks\.service\.ts$/);
});

test('an aliased import and a same-directory import are both fine', () => {
  const found = scan({
    'tasks/tasks.service.ts': [
      "import { a } from '@/guardrails/thing';",
      "import { b } from './helper';",
    ].join('\n'),
    'tasks/helper.ts': 'export const b = 1;\n',
    'guardrails/thing.ts': 'export const a = 1;\n',
  });
  assert.deepEqual(found, []);
});

test('two directories importing each other through ordinary source fail', () => {
  const found = scan({
    'tasks/tasks.service.ts': "import { g } from '@/guardrails/guardrails.service';\n",
    'guardrails/guardrails.service.ts': "import { t } from '@/tasks/tasks.service';\n",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'directory-cycle');
  assert.match(found[0].detail, /ordinary source/);
});

test('a cycle written entirely in module files is composition and passes', () => {
  const found = scan({
    'tasks/tasks.module.ts': [
      "import { GuardrailsModule } from '@/guardrails/guardrails.module';",
      "import { GuardrailsService } from '@/guardrails/guardrails.service';",
    ].join('\n'),
    'guardrails/guardrails.module.ts': "import { TasksModule } from '@/tasks/tasks.module';\n",
    'guardrails/guardrails.service.ts': 'export class GuardrailsService {}\n',
  });
  assert.deepEqual(
    found,
    [],
    'a Nest module must be able to import the provider classes it registers',
  );
});

test('a half-module cycle is NOT composition', () => {
  // The boundary that matters: this is the shape `tasks ⟷ guardrails` had, and
  // exempting it would have let the cycle this change inverted stand.
  const found = scan({
    'tasks/tasks.module.ts': "import { G } from '@/guardrails/guardrails.service';\n",
    'guardrails/guardrails.service.ts': "import { T } from '@/tasks/tasks.service';\n",
    'tasks/tasks.service.ts': 'export class T {}\n',
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'directory-cycle');
  assert.match(found[0].detail, /guardrails\.service\.ts/);
});

test('a dynamic import() forms a cycle too', () => {
  // Several references in this codebase were `import('...')` expressions, which
  // a from-clause-only scan would miss.
  const found = scan({
    'tasks/tasks.service.ts':
      "const g = await import('@/guardrails/guardrails.service');\n",
    'guardrails/guardrails.service.ts': "import { t } from '@/tasks/tasks.service';\n",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'directory-cycle');
});

test('an admitted cycle can be exempted through data', () => {
  const files = {
    'tasks/tasks.service.ts': "import { g } from '@/guardrails/guardrails.service';\n",
    'guardrails/guardrails.service.ts': "import { t } from '@/tasks/tasks.service';\n",
  };
  assert.equal(scan(files).length, 1, 'unexempted, it must fire');
  assert.deepEqual(
    scan(files, {
      allowed: [{ pair: ['tasks', 'guardrails'], reason: 'fixture' }],
    }),
    [],
    'the exemption must be honoured, and must be data rather than an inline disable',
  );
});

test('tests and typecheck fixtures are not scanned', () => {
  // A spec may reach across directories freely; a compile-fail fixture exists to
  // import things it should not be able to use.
  const found = scan({
    'tasks/tasks.spec.ts': "import { x } from '../guardrails/thing';\n",
    'tasks/parity.typecheck.ts': "import { y } from '../guardrails/thing';\n",
  });
  assert.deepEqual(found, []);
});

test('an absent package directory yields no phantom findings', () => {
  assert.deepEqual(scan({}), []);
});
