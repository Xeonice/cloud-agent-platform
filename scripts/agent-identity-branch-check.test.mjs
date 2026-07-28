/**
 * Guards the agent-identity branch gate.
 *
 * The gate is what stops "shared code must not branch on which agent is running"
 * from going back to depending on review, so it has to be provably able to fail —
 * and provably able to STAY QUIET where naming a runtime is legitimate. A gate
 * that fires on a runtime's own implementation would be suppressed within a week,
 * and a suppressed gate is no gate.
 *
 * Run: node --test scripts/agent-identity-branch-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { findAgentIdentityBranches } from './agent-identity-branch-check.mjs';

/** Build a throwaway tree and scan it with the real implementation. */
function scan({ files, scaffolding, exempt = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'identity-gate-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return findAgentIdentityBranches({ root, scaffolding, exempt });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('an identity branch in shared scaffolding is reported with its location', () => {
  const found = scan({
    files: {
      'shared/wiring.ts': [
        'export function pick(runtime: string) {',
        "  if (runtime === 'codex') return codexThing;",
        '  return other;',
        '}',
      ].join('\n'),
    },
    scaffolding: ['shared/wiring.ts'],
  });
  assert.equal(found.length, 1, 'the branch must be reported');
  assert.equal(found[0].file, 'shared/wiring.ts');
  assert.equal(found[0].line, 2, 'the line must be precise enough to act on');
  assert.match(found[0].text, /runtime === 'codex'/);
});

test('a runtime implementation naming its own id is not reported', () => {
  // This is the case that would force suppressions if it fired.
  const found = scan({
    files: {
      'shared/codex-runtime.ts': "export const id = 'codex';\nif (x === 'codex') {}\n",
    },
    scaffolding: ['shared/codex-runtime.ts'],
    exempt: ['shared/codex-runtime.ts'],
  });
  assert.deepEqual(found, [], 'an exempt implementation must stay silent');
});

test('a directory entry covers its subtree', () => {
  const found = scan({
    files: {
      'shared/a.ts': "if (r === 'claude-code') {}\n",
      'shared/nested/b.ts': "if (r !== 'codex') {}\n",
      'shared/nested/c.ts': 'const fine = true;\n',
    },
    scaffolding: ['shared'],
  });
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((v) => v.file).sort(),
    ['shared/a.ts', 'shared/nested/b.ts'],
  );
});

test('prose naming a runtime does not trip the scan', () => {
  // A doc comment explaining WHY a policy exists, or a log message naming the
  // agent, must not be mistaken for a branch — otherwise the gate punishes the
  // very comments that make the rule understandable.
  const found = scan({
    files: {
      'shared/doc.ts': [
        '/**',
        " * Historically this branched on runtime === 'codex'; it now reads policy.",
        ' */',
        "// if (runtime === 'codex') — removed, see above",
        "logger.warn(`runtime codex is deprecated`);",
        'export const ok = true;',
      ].join('\n'),
    },
    scaffolding: ['shared/doc.ts'],
  });
  assert.deepEqual(found, [], 'comments and messages are not branches');
});

test('a test file may name a runtime freely', () => {
  const found = scan({
    files: { 'shared/thing.spec.ts': "assert(r === 'codex');\n" },
    scaffolding: ['shared'],
  });
  assert.deepEqual(found, []);
});

test('both comparison operators and both quote styles are caught', () => {
  const found = scan({
    files: {
      'shared/x.ts': [
        'if (a === "codex") {}',
        "if (b !== 'claude-code') {}",
        'if (c === "claude") {}',
      ].join('\n'),
    },
    scaffolding: ['shared/x.ts'],
  });
  assert.equal(found.length, 3, 'no operator or quote style may slip through');
});

test('a clean scaffolding tree reports nothing', () => {
  const found = scan({
    files: { 'shared/clean.ts': 'export const value = runtime.terminalStartup;\n' },
    scaffolding: ['shared'],
  });
  assert.deepEqual(found, []);
});
