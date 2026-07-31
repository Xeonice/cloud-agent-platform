/**
 * Guards the agent-identity branch gate.
 *
 * The gate is what stops "shared code must not branch on which agent is running"
 * from going back to depending on review, so it has to be provably able to fail —
 * and provably able to STAY QUIET where naming a runtime is legitimate. A gate
 * that fires on a runtime's own implementation would be suppressed within a week,
 * and a suppressed gate is no gate.
 *
 * The scan is a COMPLEMENT — everything in scope minus an explicit exemption
 * list — so these cases pin the semantics that make the complement safe: an
 * unlisted new file is covered with no registration, a malformed exemption
 * fails the audit, and a scan that resolves to nothing fails rather than
 * passing vacuously.
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
function scan({ files, scanRoots, exemptions = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'identity-gate-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return findAgentIdentityBranches({ root, scanRoots, exemptions });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const exemption = (file) => ({
  file,
  reason: 'a runtime implementation necessarily names its own id',
  change: 'fail-loud-on-unknown-runtime',
});

test('an identity branch in an unlisted file is reported with its location', () => {
  // The complement's core promise: a NEW file is covered the moment it exists,
  // with no list to remember to extend.
  const found = scan({
    files: {
      'shared/brand-new-wiring.ts': [
        'export function pick(runtime: string) {',
        "  if (runtime === 'codex') return codexThing;",
        '  return other;',
        '}',
      ].join('\n'),
    },
    scanRoots: ['shared'],
  });
  assert.equal(found.length, 1, 'the branch must be reported');
  assert.equal(found[0].kind, 'identity-branch');
  assert.equal(found[0].file, 'shared/brand-new-wiring.ts');
  assert.equal(found[0].line, 2, 'the line must be precise enough to act on');
  assert.match(found[0].text, /runtime === 'codex'/);
});

test('an exempt runtime implementation naming its own id is not reported', () => {
  // This is the case that would force suppressions if it fired.
  const found = scan({
    files: {
      'shared/codex-runtime.ts': "export const id = 'codex';\nif (x === 'codex') {}\n",
      'shared/other.ts': 'export const ok = true;\n',
    },
    scanRoots: ['shared'],
    exemptions: [exemption('shared/codex-runtime.ts')],
  });
  assert.deepEqual(found, [], 'an exempt implementation must stay silent');
});

test('an exemption entry missing a field fails the audit naming the entry', () => {
  const found = scan({
    files: {
      'shared/clean.ts': 'export const ok = true;\n',
      'shared/keeps-scan-nonempty.ts': 'export const also = true;\n',
    },
    scanRoots: ['shared'],
    exemptions: [{ file: 'shared/clean.ts', reason: 'no owning change recorded' }],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'malformed-exemption');
  assert.equal(found[0].file, 'shared/clean.ts');
  assert.match(found[0].detail, /change/);
});

test('an exemption naming a file that does not exist is stale and fails', () => {
  const found = scan({
    files: { 'shared/clean.ts': 'export const ok = true;\n' },
    scanRoots: ['shared'],
    exemptions: [exemption('shared/deleted-runtime.ts')],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'stale-exemption');
  assert.equal(found[0].file, 'shared/deleted-runtime.ts');
});

test('a scan that resolves to zero files fails instead of passing vacuously', () => {
  const found = scan({
    files: { 'elsewhere/untouched.ts': "if (r === 'codex') {}\n" },
    scanRoots: ['moved-or-mistyped'],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'empty-scan');
});

test('a directory root covers its whole subtree', () => {
  const found = scan({
    files: {
      'shared/a.ts': "if (r === 'claude-code') {}\n",
      'shared/nested/b.ts': "if (r !== 'codex') {}\n",
      'shared/nested/c.ts': 'const fine = true;\n',
    },
    scanRoots: ['shared'],
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
    scanRoots: ['shared'],
  });
  assert.deepEqual(found, [], 'comments and messages are not branches');
});

test('test files and test directories stay out of the branch scan', () => {
  const found = scan({
    files: {
      'shared/thing.spec.ts': "assert(r === 'codex');\n",
      'shared/test/helper.mjs': "if (r === 'claude-code') {}\n",
      'shared/keeps-scan-nonempty.ts': 'export const ok = true;\n',
    },
    scanRoots: ['shared'],
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
    scanRoots: ['shared'],
  });
  assert.equal(found.length, 3, 'no operator or quote style may slip through');
});

test('a clean scaffolding tree reports nothing', () => {
  const found = scan({
    files: { 'shared/clean.ts': 'export const value = runtime.terminalStartup;\n' },
    scanRoots: ['shared'],
  });
  assert.deepEqual(found, []);
});

test('the real tree is green through the committed exemptions', () => {
  // The complement scan with its committed data must hold on the actual
  // repository: every current hit is either removed or carried by a
  // three-field exemption, and the scan is provably non-empty.
  assert.deepEqual(findAgentIdentityBranches(), []);
});
