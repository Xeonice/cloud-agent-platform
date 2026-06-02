/**
 * Minimal test for "Any-deny-wins resolution" requirement (agent-control-platform, task 6.2).
 *
 * Rule: deny if ANY contributing decision is deny; allow only when ALL are allow.
 * Edge case: empty set resolves to deny (fail-closed).
 */

import { resolveDecisions } from './apps/runner/dist/hooks/resolve-decision.js';

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const behaviorOk = actual.behavior === expected.behavior;
  const messageOk =
    expected.message === undefined
      ? actual.message === undefined
      : actual.message === expected.message;

  if (behaviorOk && messageOk) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
    failed++;
  }
}

// ── Scenario 1: single allow ──────────────────────────────────────────────────
assert(
  'single allow → allow',
  resolveDecisions([{ behavior: 'allow' }]),
  { behavior: 'allow' }
);

// ── Scenario 2: single deny ───────────────────────────────────────────────────
assert(
  'single deny → deny',
  resolveDecisions([{ behavior: 'deny' }]),
  { behavior: 'deny' }
);

// ── Scenario 3: all allow → allow ─────────────────────────────────────────────
assert(
  'all allow → allow',
  resolveDecisions([{ behavior: 'allow' }, { behavior: 'allow' }, { behavior: 'allow' }]),
  { behavior: 'allow' }
);

// ── Scenario 4 (core): any deny wins over majority allow ──────────────────────
assert(
  'one deny among many allows → deny  (any-deny-wins)',
  resolveDecisions([{ behavior: 'allow' }, { behavior: 'deny' }, { behavior: 'allow' }]),
  { behavior: 'deny' }
);

// ── Scenario 5: all deny → deny ───────────────────────────────────────────────
assert(
  'all deny → deny',
  resolveDecisions([{ behavior: 'deny' }, { behavior: 'deny' }]),
  { behavior: 'deny' }
);

// ── Scenario 6: empty set → deny (fail-closed) ────────────────────────────────
assert(
  'empty decisions → deny  (fail-closed)',
  resolveDecisions([]),
  { behavior: 'deny' }
);

// ── Scenario 7: deny message is preserved on resolved deny ───────────────────
assert(
  'deny message propagates to resolved decision',
  resolveDecisions([
    { behavior: 'allow' },
    { behavior: 'deny', message: 'dangerous shell command' },
    { behavior: 'allow' },
  ]),
  { behavior: 'deny', message: 'dangerous shell command' }
);

// ── Scenario 8: allow message propagates when all allow ──────────────────────
assert(
  'allow message propagates when all allow',
  resolveDecisions([
    { behavior: 'allow', message: 'looks safe' },
    { behavior: 'allow' },
  ]),
  { behavior: 'allow', message: 'looks safe' }
);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
