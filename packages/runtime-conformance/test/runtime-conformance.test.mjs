/**
 * The suite run: every declared runtime participates through its harness maker,
 * every owed scenario family runs, and the per-runtime report artifact is total
 * over runtimes × families — a skip is always a reasoned row, never silence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { loadApiRuntimeSeedBridge } from './support/api-runtime-seed-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPORT_PATH = join(
  PACKAGE_ROOT,
  'reports',
  'runtime-conformance-report.json',
);

const suite = await import(new URL('../dist/index.js', import.meta.url).href);

let seed;
let savedCodexArgvOverride;

before(async () => {
  // The codex golden launch fixture pins the DEFAULT argv; a stray operator
  // override in the environment must not reach the suite.
  savedCodexArgvOverride = process.env.CODEX_LAUNCH_ARGV;
  delete process.env.CODEX_LAUNCH_ARGV;
  seed = await loadApiRuntimeSeedBridge();
});

after(() => {
  seed?.dispose();
  if (savedCodexArgvOverride !== undefined) {
    process.env.CODEX_LAUNCH_ARGV = savedCodexArgvOverride;
  }
});

test('every declared runtime passes its owed scenario families and the report is total', async () => {
  const report = await suite.runRuntimeConformance({
    bridge: seed.bridge,
    reportPath: REPORT_PATH,
  });

  // Total over runtimes × families (assertReportTotal already ran inside; this
  // re-derives the shape from the artifact the run wrote to disk).
  const artifact = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  assert.deepEqual(artifact.rows, report.rows);
  assert.equal(
    report.rows.length,
    report.runtimes.length * report.families.length,
  );
  for (const row of report.rows) {
    assert.ok(
      row.status === 'pass' || row.status === 'skip',
      `row (${row.runtime}, ${row.family}) has a status`,
    );
    assert.ok(
      row.reason.length > 0,
      `row (${row.runtime}, ${row.family}) carries a reason`,
    );
  }

  // Both shipped runtimes declare interactive-pty AND headless-exec, so every
  // family must have RUN for both — zero skips in the shipped matrix.
  assert.deepEqual(
    report.rows.filter((row) => row.status !== 'pass'),
    [],
    'both shipped runtimes pass all five families',
  );

  console.log(`\n${suite.renderReport(report)}\n`);
});

test('an undeclared execution mode yields a reasoned skip row, never silence', async () => {
  const maker = suite.RUNTIME_CONFORMANCE_HARNESSES['claude-code'];
  const harness = await maker.make(seed.bridge);
  // The same real runtime, minus its `headless-exec` declaration: the headless
  // family must become an explicit reasoned skip row (not run, not silent).
  const withoutHeadless = {
    runtime: new Proxy(harness.runtime, {
      get(target, property, receiver) {
        if (property === 'executionModes') return new Set(['interactive-pty']);
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    hooks: harness.hooks,
  };

  const rows = await suite.runFamiliesFor(withoutHeadless);
  assert.equal(rows.length, suite.RUNTIME_CONFORMANCE_FAMILIES.length);
  const headlessRow = rows.find((row) => row.family === 'headless');
  assert.equal(headlessRow.status, 'skip');
  assert.match(
    headlessRow.reason,
    /does not declare the "headless-exec" execution mode/,
    'the skip reason names the missing declaration',
  );
  for (const row of rows.filter((r) => r.family !== 'headless')) {
    assert.equal(row.status, 'pass', `${row.family} still runs`);
  }
});

test('a declared execution mode whose family cannot run fails loudly, not silently', async () => {
  const maker = suite.RUNTIME_CONFORMANCE_HARNESSES.codex;
  const harness = await maker.make(seed.bridge);
  // The runtime DECLARES headless-exec, but the harness supplies no headless
  // hooks: the reconciliation must fail naming the capability — a runtime may
  // not declare a mode its conformance does not exercise.
  const withoutHooks = {
    runtime: harness.runtime,
    hooks: { ...harness.hooks, headless: undefined },
  };
  await assert.rejects(
    () => suite.runFamiliesFor(withoutHooks),
    (error) => {
      assert.match(String(error.cause ?? error), /headless-exec/);
      assert.match(String(error.cause ?? error), /conformance participation/);
      return true;
    },
  );
});
