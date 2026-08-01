/**
 * Guards the sandbox-core ↔ contracts vocabulary parity gate.
 *
 * A gate accepted on a green run has not been shown to do anything. These cases
 * drive the real implementation with throwaway inputs so it is exercised in both
 * directions — a member added on the sandbox side, a member added on the contract
 * side, a rename, and the order difference that exists today and must NOT fail.
 *
 * Run: node --test scripts/sandbox-core-vocabulary-parity.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAIRS,
  readArrayMembers,
  findVocabularyDisagreements,
  schemaEnumMembers,
} from './sandbox-core-vocabulary-parity.mjs';

const PAIR = [{ file: 'src/v.ts', array: 'VOCAB', schema: 'VocabSchema' }];

/** Run the real implementation against in-memory sides. */
const check = (sandboxMembers, contractMembers, pairs = PAIR) =>
  findVocabularyDisagreements({
    pairs,
    readSource: () =>
      sandboxMembers == null
        ? null
        : `export const VOCAB = [\n${sandboxMembers
            .map((m) => `  '${m}',`)
            .join('\n')}\n] as const;\n`,
    readSchema: () => contractMembers,
  });

test('agreeing sides produce no problems', () => {
  assert.deepEqual(check(['a', 'b'], ['a', 'b']), []);
});

test('a member added on the sandbox side fails, naming it', () => {
  const problems = check(['a', 'b', 'c'], ['a', 'b']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /VOCAB: has 'c', VocabSchema does not/);
});

test('a member added on the contract side fails, naming it', () => {
  const problems = check(['a'], ['a', 'b']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /VocabSchema: has 'b', VOCAB does not/);
});

test('member ORDER is deliberately not asserted', () => {
  // This is the difference that exists today between
  // SANDBOX_PROVISIONING_DIAGNOSTIC_PROVIDER_FAMILIES and its contract enum.
  // Every consumer uses these arrays for membership, so failing on order would
  // be a gate that fires on nothing.
  assert.deepEqual(check(['aio', 'cloud-http', 'boxlite'], ['aio', 'boxlite', 'cloud-http']), []);
});

test('a declared widening is permitted on the side that carries it', () => {
  const pairs = [{ ...PAIR[0], extraInSandbox: ['unknown'] }];
  assert.deepEqual(check(['a', 'unknown'], ['a'], pairs), []);
});

test('a widening that only one side may carry does not excuse the other side', () => {
  const pairs = [{ ...PAIR[0], extraInSandbox: ['unknown'] }];
  const problems = check(['a'], ['a', 'unknown'], pairs);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /VocabSchema: has 'unknown', VOCAB does not/);
  assert.match(problems[1], /'unknown' is declared an allowed widening but is not in the array/);
});

test('a renamed array fails rather than silently checking nothing', () => {
  const problems = findVocabularyDisagreements({
    pairs: PAIR,
    readSource: () => `export const RENAMED = ['a'] as const;\n`,
    readSchema: () => ['a'],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /VOCAB: not found/);
});

test('a moved file fails rather than silently checking nothing', () => {
  const problems = check(null, ['a']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/v\.ts: not readable/);
});

test('a contract export that is not an enum fails', () => {
  const problems = findVocabularyDisagreements({
    pairs: PAIR,
    readSource: () => `export const VOCAB = ['a'] as const;\n`,
    readSchema: () => null,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /VocabSchema: not an enum export/);
});

test('readArrayMembers reads a real declaration shape', () => {
  const source = [
    '/** doc comment mentioning \'decoy\' */',
    "export const SANDBOX_EXECUTION_MODES = ['sandbox', 'host'] as const;",
    '',
    "export const OTHER = ['x'] as const;",
  ].join('\n');
  assert.deepEqual(readArrayMembers(source, 'SANDBOX_EXECUTION_MODES'), [
    'sandbox',
    'host',
  ]);
  assert.equal(readArrayMembers(source, 'ABSENT'), null);
});

test('every pair names a distinct array', () => {
  // Two entries pointing at the same array would report a passing check twice
  // and leave a vocabulary unguarded.
  const arrays = PAIRS.flatMap((p) => p.arrays ?? [p.array]);
  assert.equal(new Set(arrays).size, arrays.length);
});

// ---------------------------------------------------------------------------
// unlock-extension-axes 7.5: the merged source-kind pair rides three gate
// mechanics that did not exist before — multi-array declarations (`arrays`,
// members unioned), a non-sandbox-core `root`, and a discriminated-union
// schema side. Each is exercised red and green.
// ---------------------------------------------------------------------------

const TIERED_PAIR = [
  {
    root: 'packages/contracts',
    file: 'src/decl.ts',
    arrays: ['MANAGED', 'EXTENSION'],
    schema: 'DerivedSchema',
  },
];

const tieredSource = (managed, extension) =>
  `export const MANAGED = [\n${managed.map((m) => `  '${m}',`).join('\n')}\n] as const;\n` +
  `export const EXTENSION = [\n${extension.map((m) => `  '${m}',`).join('\n')}\n] as const;\n`;

test('a multi-array pair unions its declared tiers before comparing', () => {
  const problems = findVocabularyDisagreements({
    pairs: TIERED_PAIR,
    readSource: () => tieredSource(['a', 'b'], ['x', 'y']),
    readSchema: () => ['a', 'b', 'x', 'y'],
  });
  assert.deepEqual(problems, []);
});

test('a member missing from every tier fails, naming the union', () => {
  const problems = findVocabularyDisagreements({
    pairs: TIERED_PAIR,
    readSource: () => tieredSource(['a'], ['x']),
    readSchema: () => ['a', 'x', 'y'],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /DerivedSchema: has 'y', MANAGED ∪ EXTENSION does not/);
});

test('a tier declared on the pair but absent from the file fails loudly', () => {
  const problems = findVocabularyDisagreements({
    pairs: TIERED_PAIR,
    readSource: () => `export const MANAGED = ['a'] as const;\n`,
    readSchema: () => ['a'],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /EXTENSION: not found in packages\/contracts\/src\/decl\.ts/);
});

test('the pair root is forwarded to readSource', () => {
  const roots = [];
  findVocabularyDisagreements({
    pairs: TIERED_PAIR,
    readSource: (rel, root) => {
      roots.push(root);
      return tieredSource(['a'], ['x']);
    },
    readSchema: () => ['a', 'x'],
  });
  assert.deepEqual(roots, ['packages/contracts']);
});

test('schemaEnumMembers reads enums, discriminated unions, and rejects the rest', () => {
  assert.deepEqual(schemaEnumMembers({ options: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(
    schemaEnumMembers({
      options: [
        { shape: { kind: { value: 'a' } } },
        { shape: { kind: { value: 'x' } } },
      ],
    }),
    ['a', 'x'],
  );
  assert.equal(schemaEnumMembers(undefined), null);
  assert.equal(schemaEnumMembers({ options: [{ shape: {} }] }), null);
  assert.equal(schemaEnumMembers({ parse: () => undefined }), null);
});
