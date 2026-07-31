/**
 * Guards the provider contract parity gate.
 *
 * A gate that cannot be shown to fail is decoration. These cases point the real
 * implementation at throwaway trees so both detectors are exercised in both
 * directions — the duplicate-spelling shape that actually shipped
 * (`lifecycle.readopt` / `lifecycle.readoption`), and a provider suite that
 * builds conformance without consulting the participation ledger — and pin the
 * discovery semantics: participation is DISCOVERED from what a package's
 * sources build (recursively, with no directory list and no name glob), the
 * real tree keeps `packages/sandbox-cloud-http` in the set alongside the
 * `sandbox-provider-*` packages, and a scan that discovers nothing is a
 * failure, not a vacuous pass.
 *
 * Run: node --test scripts/provider-contract-parity-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  discoverConformanceParticipants,
  findProviderContractViolations,
} from './provider-contract-parity-check.mjs';

const VOCABULARY = 'packages/sandbox-core/src/capabilities.ts';

/** Build a throwaway tree and scan it with the real implementation. */
function inThrowawayTree(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'provider-parity-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scan({ files, knownDistinctPairs = [], sharedCoverage = [] }) {
  return inThrowawayTree(files, (root) =>
    findProviderContractViolations({ root, knownDistinctPairs, sharedCoverage }),
  );
}

const vocabulary = (...names) =>
  `export type SandboxProviderCapability =\n${names
    .map((name) => `  | '${name}'`)
    .join('\n')};\n`;

const LEDGERED_SUITE = [
  'const participation = conformance.createConformanceParticipationLedger({});',
  "participation.ran('provider');",
  'const scenarios = conformance.createSandboxProviderConformanceScenarios({}, assert);',
].join('\n');

const UNLEDGERED_SUITE =
  'const scenarios = conformance.createSandboxProviderConformanceScenarios({}, assert);\n';

/**
 * A minimal participating package, so fixtures asserting "no violations" do
 * not trip the zero-participants failure instead.
 */
const PARTICIPANT = {
  'packages/p/package.json': '{"name":"p"}\n',
  'packages/p/test/p-conformance.test.mjs': LEDGERED_SUITE,
};

test('the shipped duplicate-spelling pair is caught', () => {
  // This is the exact pair the change removed. If the gate cannot see it, the
  // gate would not have prevented the thing that happened.
  const found = scan({
    files: {
      ...PARTICIPANT,
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
      ...PARTICIPANT,
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
    ...PARTICIPANT,
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
      'packages/p/package.json': '{"name":"p"}\n',
      'packages/p/test/p-conformance.test.mjs': UNLEDGERED_SUITE,
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unledgered-conformance');
  assert.equal(found[0].file, 'packages/p/test/p-conformance.test.mjs');
  assert.match(found[0].detail, /packages\/p/, 'the package must be named');
});

test('a ledgered provider suite is not reported', () => {
  const found = scan({
    files: {
      ...PARTICIPANT,
      [VOCABULARY]: vocabulary('terminal.websocket'),
    },
  });
  assert.deepEqual(found, []);
});

test('a provider test that builds no conformance suite is not required to have a ledger', () => {
  // Most provider test files are ordinary unit tests. Demanding a ledger from
  // them would make the requirement meaningless by making it universal.
  const found = scan({
    files: {
      ...PARTICIPANT,
      [VOCABULARY]: vocabulary('terminal.websocket'),
      'packages/p/test/p-client.test.mjs': 'assert.equal(1, 1);\n',
    },
  });
  assert.deepEqual(found, []);
});

test('discovery is recursive: a nested test file in a participant is found', () => {
  // The previous listTestFiles was a single-level readdir, so a suite moved
  // into a subdirectory silently left the gate's sight.
  const found = scan({
    files: {
      [VOCABULARY]: vocabulary('terminal.websocket'),
      'packages/p/package.json': '{"name":"p"}\n',
      'packages/p/test/nested/deep/p-conformance.test.mjs': UNLEDGERED_SUITE,
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unledgered-conformance');
  assert.equal(found[0].file, 'packages/p/test/nested/deep/p-conformance.test.mjs');
});

test('discovery carries no name glob: an arbitrarily named package participates', () => {
  // A literal `sandbox-provider-*` pattern would have silently dropped
  // `sandbox-cloud-http`. The predicate is what the package's sources BUILD.
  const participants = inThrowawayTree(
    {
      [VOCABULARY]: vocabulary('terminal.websocket'),
      'packages/anything-at-all/package.json': '{"name":"anything-at-all"}\n',
      'packages/anything-at-all/test/x.test.mjs': LEDGERED_SUITE,
    },
    (root) => discoverConformanceParticipants({ root }),
  );
  assert.deepEqual(participants, ['packages/anything-at-all']);
});

test('the real tree discovers sandbox-cloud-http alongside the provider packages', () => {
  // Pin the predicate against the real workspace: the non-conforming name must
  // stay in the set, and the provider packages must be there with it.
  const participants = discoverConformanceParticipants();
  for (const expected of [
    'packages/sandbox-cloud-http',
    'packages/sandbox-provider-aio',
    'packages/sandbox-provider-boxlite',
  ]) {
    assert.ok(
      participants.includes(expected),
      `${expected} must be discovered; got: ${participants.join(', ')}`,
    );
  }
});

test('a discovery pass that matches zero packages fails instead of passing vacuously', () => {
  const found = scan({
    files: {
      [VOCABULARY]: vocabulary('terminal.websocket'),
      'packages/p/package.json': '{"name":"p"}\n',
      'packages/p/test/p-client.test.mjs': 'assert.equal(1, 1);\n',
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'no-participants');
});

test('stated shared coverage exempts an unledgered suite through data', () => {
  const files = {
    [VOCABULARY]: vocabulary('terminal.websocket'),
    'packages/p/package.json': '{"name":"p"}\n',
    'packages/p/test/shared-impl-conformance.test.mjs': UNLEDGERED_SUITE,
  };
  assert.equal(scan({ files }).length, 1, 'uncovered, it must fire');
  assert.deepEqual(
    scan({
      files,
      sharedCoverage: [
        {
          file: 'packages/p/test/shared-impl-conformance.test.mjs',
          reason: 'exercises the shared implementation providers delegate to',
          change: 'close-gate-blindspots-and-ci-hygiene',
        },
      ],
    }),
    [],
    'stated coverage must be honoured, and must be data rather than an inline disable',
  );
});

test('a shared-coverage entry missing a field fails the audit naming the entry', () => {
  const found = scan({
    files: {
      ...PARTICIPANT,
      [VOCABULARY]: vocabulary('terminal.websocket'),
    },
    sharedCoverage: [
      { file: 'packages/p/test/x.test.mjs', reason: 'no owning change recorded' },
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'malformed-shared-coverage');
  assert.match(found[0].detail, /change/);
  assert.equal(found[0].file, 'packages/p/test/x.test.mjs');
});

test('a missing vocabulary file yields no phantom duplicate findings', () => {
  const found = scan({ files: { ...PARTICIPANT } });
  assert.deepEqual(found, []);
});
