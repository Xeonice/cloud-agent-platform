/**
 * Guards the provider contract parity gate.
 *
 * A gate that cannot be shown to fail is decoration. These cases point the real
 * implementation at throwaway trees so both detectors are exercised in both
 * directions — the duplicate-spelling shape that actually shipped
 * (`lifecycle.readopt` / `lifecycle.readoption`), and a provider suite that
 * builds conformance without consulting the participation ledger.
 *
 * Run: node --test scripts/provider-contract-parity-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { findProviderContractViolations } from './provider-contract-parity-check.mjs';

const VOCABULARY = 'packages/sandbox-core/src/capabilities.ts';

/** Build a throwaway tree and scan it with the real implementation. */
function scan({ files, providerTestDirs = [], knownDistinctPairs = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'provider-parity-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return findProviderContractViolations({ root, providerTestDirs, knownDistinctPairs });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const vocabulary = (...names) =>
  `export type SandboxProviderCapability =\n${names
    .map((name) => `  | '${name}'`)
    .join('\n')};\n`;

test('the shipped duplicate-spelling pair is caught', () => {
  // This is the exact pair the change removed. If the gate cannot see it, the
  // gate would not have prevented the thing that happened.
  const found = scan({
    files: {
      [VOCABULARY]: vocabulary(
        'terminal.websocket',
        'lifecycle.readopt',
        'lifecycle.readoption',
      ),
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'duplicate-spelling');
  assert.match(found[0].detail, /lifecycle\.readopt.*lifecycle\.readoption/);
});

test('genuinely distinct capabilities in one namespace are not flagged', () => {
  // A gate that fires on every capability sharing a namespace would be
  // suppressed within a week, and a suppressed gate is no gate.
  const found = scan({
    files: {
      [VOCABULARY]: vocabulary(
        'workspace.git.materialize',
        'workspace.git.deliver',
        'workspace.source.volume',
        'workspace.source.git',
        'transcript.retained-read',
        'transcript.retained-source',
      ),
    },
  });
  assert.deepEqual(found, []);
});

test('an admitted pair can be exempted through data', () => {
  const files = {
    [VOCABULARY]: vocabulary('lifecycle.readopt', 'lifecycle.readoption'),
  };
  assert.equal(scan({ files }).length, 1, 'unexempted, it must fire');
  assert.deepEqual(
    scan({ files, knownDistinctPairs: [['lifecycle.readopt', 'lifecycle.readoption']] }),
    [],
    'the exemption must be honoured, and must be data rather than an inline disable',
  );
});

test('a provider suite built without the participation ledger is reported', () => {
  const found = scan({
    files: {
      [VOCABULARY]: vocabulary('terminal.websocket'),
      'packages/p/test/p-conformance.test.mjs':
        'const scenarios = conformance.createSandboxProviderConformanceScenarios({}, assert);\n',
    },
    providerTestDirs: ['packages/p/test'],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unledgered-conformance');
  assert.equal(found[0].file, 'packages/p/test/p-conformance.test.mjs');
});

test('a ledgered provider suite is not reported', () => {
  const found = scan({
    files: {
      [VOCABULARY]: vocabulary('terminal.websocket'),
      'packages/p/test/p-conformance.test.mjs': [
        'const participation = conformance.createConformanceParticipationLedger({});',
        "participation.ran('provider');",
        'const scenarios = conformance.createSandboxProviderConformanceScenarios({}, assert);',
      ].join('\n'),
    },
    providerTestDirs: ['packages/p/test'],
  });
  assert.deepEqual(found, []);
});

test('a provider test that builds no conformance suite is not required to have a ledger', () => {
  // Most provider test files are ordinary unit tests. Demanding a ledger from
  // them would make the requirement meaningless by making it universal.
  const found = scan({
    files: {
      [VOCABULARY]: vocabulary('terminal.websocket'),
      'packages/p/test/p-client.test.mjs': 'assert.equal(1, 1);\n',
    },
    providerTestDirs: ['packages/p/test'],
  });
  assert.deepEqual(found, []);
});

test('a missing vocabulary file yields no phantom findings', () => {
  const found = scan({ files: {}, providerTestDirs: ['packages/absent/test'] });
  assert.deepEqual(found, []);
});
