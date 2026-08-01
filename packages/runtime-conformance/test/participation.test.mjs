/**
 * Participation ledger mechanics — pure, no api seed compile needed: the
 * mode→family derivation, the reasoned skip vocabulary, ledger totality at
 * runtime (the compile-time guards live in
 * `src/runtime-participation.typecheck.ts`), and report totality enforcement.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const suite = await import(new URL('../dist/index.js', import.meta.url).href);
const contracts = await import(
  new URL('../../contracts/dist/index.js', import.meta.url).href
);

test('declared execution modes derive exactly the owed families', () => {
  const both = suite.requiredConformanceFamilies(
    new Set(['interactive-pty', 'headless-exec']),
  );
  assert.deepEqual(
    [...both],
    ['launch', 'lifecycle', 'transcript', 'headless', 'secret-canary'],
  );

  const interactiveOnly = suite.requiredConformanceFamilies(
    new Set(['interactive-pty']),
  );
  assert.deepEqual(
    [...interactiveOnly],
    ['launch', 'lifecycle', 'transcript', 'secret-canary'],
    'no headless-exec declaration → the headless family is not owed',
  );

  const headlessOnly = suite.requiredConformanceFamilies(
    new Set(['headless-exec']),
  );
  assert.deepEqual(
    [...headlessOnly],
    ['transcript', 'headless', 'secret-canary'],
    'the unconditional families are owed regardless of declared modes',
  );
});

test('a skip reason names the missing declaration; owed families have none', () => {
  const reason = suite.familySkipReason(
    'headless',
    'claude-code',
    new Set(['interactive-pty']),
  );
  assert.match(reason, /"claude-code"/);
  assert.match(reason, /"headless-exec"/);
  assert.match(reason, /"headless"/);

  assert.equal(
    suite.familySkipReason(
      'headless',
      'codex',
      new Set(['interactive-pty', 'headless-exec']),
    ),
    null,
  );
  assert.equal(
    suite.familySkipReason('secret-canary', 'codex', new Set()),
    null,
    'unconditional families are always owed',
  );
});

test('the runtime-keyed ledger is total over the contracts declaration', () => {
  assert.deepEqual(
    Object.keys(suite.RUNTIME_CONFORMANCE_HARNESSES).sort(),
    [...contracts.AGENT_RUNTIME_IDS].sort(),
  );
  for (const [id, maker] of Object.entries(suite.RUNTIME_CONFORMANCE_HARNESSES)) {
    assert.equal(maker.runtimeId, id, `harness maker for "${id}" names itself`);
  }
});

test('the family-keyed ledger is total over the family vocabulary', () => {
  assert.deepEqual(
    Object.keys(suite.RUNTIME_FAMILY_OBLIGATIONS).sort(),
    [...suite.RUNTIME_CONFORMANCE_FAMILIES].sort(),
  );
  assert.deepEqual(
    Object.keys(suite.SCENARIO_FAMILIES).sort(),
    [...suite.RUNTIME_CONFORMANCE_FAMILIES].sort(),
    'every family has a suite-owned scenario',
  );
});

test('a report missing a (runtime, family) row is refused', () => {
  const families = suite.RUNTIME_CONFORMANCE_FAMILIES;
  const runtimes = contracts.AGENT_RUNTIME_IDS;
  const fullRows = runtimes.flatMap((runtime) =>
    families.map((family) => ({
      runtime,
      family,
      status: 'pass',
      reason: 'x',
    })),
  );
  assert.doesNotThrow(() =>
    suite.assertReportTotal({
      generatedAt: 'now',
      runtimes: [...runtimes],
      families: [...families],
      rows: fullRows,
    }),
  );
  assert.throws(
    () =>
      suite.assertReportTotal({
        generatedAt: 'now',
        runtimes: [...runtimes],
        families: [...families],
        rows: fullRows.slice(1),
      }),
    /not total/,
  );
});
