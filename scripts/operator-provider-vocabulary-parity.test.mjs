/**
 * Guards the R8 operator provider vocabulary parity gate.
 *
 * A gate that cannot be shown to fail is decoration. These cases point the
 * real implementation at throwaway trees so every detector fires in both
 * directions — the exact shape that shipped (a family selectable while the
 * operator vocabulary could not name it, which is how `cloud-http` stayed
 * unnameable), terminal-story drift past the operator vocabulary, and the
 * discovery semantics: declarations are DISCOVERED recursively with no path
 * list, a scan that finds nothing fails instead of passing vacuously, and the
 * real tree reconciles clean.
 *
 * Run: node --test scripts/operator-provider-vocabulary-parity.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  discoverVocabularyDeclarations,
  extractConstArrayMembers,
  findOperatorVocabularyViolations,
} from './operator-provider-vocabulary-parity.mjs';

/** Build a throwaway tree and scan it with the real implementation. */
function inThrowawayTree(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'operator-vocab-parity-'));
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

function scan(files) {
  return inThrowawayTree(files, (root) =>
    findOperatorVocabularyViolations({ root }),
  );
}

const familiesDeclaration = (...members) =>
  `export const SANDBOX_PROVIDER_FAMILIES = [\n${members
    .map((member) => `  '${member}',`)
    .join('\n')}\n] as const;\n`;

const operatorDeclaration = (...members) =>
  `export const CONFIGURED_SANDBOX_PROVIDER_FAMILIES = [\n${members
    .map((member) => `  '${member}',`)
    .join('\n')}\n] as const;\n`;

const terminalStoryDeclaration = (...members) =>
  `export type SandboxTerminalStoryProvider = ${members
    .map((member) => `'${member}'`)
    .join(' | ')};\n`;

/** A tree in full parity, mirroring the real declarations. */
const RECONCILED = {
  'packages/contracts/src/provider-family.ts': familiesDeclaration(
    'aio',
    'boxlite',
    'cloud-http',
  ),
  'packages/sandbox/src/host-harness/config.ts': operatorDeclaration(
    'auto',
    'aio',
    'boxlite',
    'cloud-http',
    'control-plane',
  ),
  'packages/sandbox/src/host-harness/provider-terminal-story.ts':
    terminalStoryDeclaration('auto', 'aio', 'boxlite'),
};

test('a reconciled tree passes', () => {
  assert.deepEqual(scan(RECONCILED), []);
});

test('a selectable family the operator cannot name turns the gate red naming it', () => {
  // The exact shipped shape: cloud-http was selectable while
  // ConfiguredSandboxProviderFamily could not spell it.
  const found = scan({
    ...RECONCILED,
    'packages/contracts/src/provider-family.ts': familiesDeclaration(
      'aio',
      'boxlite',
      'cloud-http',
      'firecracker',
    ),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unnameable-family');
  assert.match(found[0].detail, /"firecracker"/, 'the missing member is named');
});

test('a missing operator-only selection is reported too', () => {
  const found = scan({
    ...RECONCILED,
    'packages/sandbox/src/host-harness/config.ts': operatorDeclaration(
      'auto',
      'aio',
      'boxlite',
      'cloud-http',
    ),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unnameable-family');
  assert.match(found[0].detail, /"control-plane"/);
});

test('a terminal-story member outside the operator vocabulary is drift, named', () => {
  const found = scan({
    ...RECONCILED,
    'packages/sandbox/src/host-harness/provider-terminal-story.ts':
      terminalStoryDeclaration('auto', 'aio', 'boxlite', 'cloud-http-tunnel'),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'terminal-story-drift');
  assert.match(found[0].detail, /"cloud-http-tunnel"/);
});

test('a scan that discovers zero declarations fails instead of passing vacuously', () => {
  const found = scan({
    'packages/p/src/unrelated.ts': 'export const nothing = [];\n',
  });
  assert.equal(found.length, 3, 'every missing vocabulary is reported');
  for (const violation of found) {
    assert.equal(violation.kind, 'missing-declaration');
  }
});

test('discovery is recursive and path-free: moved declarations are still reconciled', () => {
  const found = scan({
    'somewhere/else/entirely/families.ts': RECONCILED[
      'packages/contracts/src/provider-family.ts'
    ],
    'a/b/c/d/operator.ts': RECONCILED[
      'packages/sandbox/src/host-harness/config.ts'
    ],
    'x/story.ts': RECONCILED[
      'packages/sandbox/src/host-harness/provider-terminal-story.ts'
    ],
  });
  assert.deepEqual(found, []);
});

test('a duplicated declaration is ambiguity, not a silent pick', () => {
  const found = scan({
    ...RECONCILED,
    'packages/other/src/copy.ts': familiesDeclaration('aio', 'boxlite'),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'ambiguous-declaration');
  assert.match(found[0].detail, /2 files/);
});

test('spread members in the operator declaration are resolved within the file', () => {
  const source = [
    "const SELECTABLE = ['aio', 'boxlite', 'cloud-http'] as const satisfies readonly X[];",
    'export const CONFIGURED_SANDBOX_PROVIDER_FAMILIES = [',
    "  'auto',",
    '  ...SELECTABLE,',
    "  'control-plane',",
    '] as const;',
    '',
  ].join('\n');
  assert.deepEqual(
    extractConstArrayMembers(source, 'CONFIGURED_SANDBOX_PROVIDER_FAMILIES'),
    ['auto', 'aio', 'boxlite', 'cloud-http', 'control-plane'],
  );
  const found = scan({
    ...RECONCILED,
    'packages/sandbox/src/host-harness/config.ts': source,
  });
  assert.deepEqual(found, []);
});

test('an unparseable declaration is a violation, never an empty vocabulary', () => {
  const found = scan({
    ...RECONCILED,
    'packages/sandbox/src/host-harness/config.ts':
      'export const CONFIGURED_SANDBOX_PROVIDER_FAMILIES = [...IMPORTED_FROM_ELSEWHERE] as const;\n',
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unparseable-declaration');
});

test('the real tree reconciles clean and declares all three vocabularies where expected', () => {
  assert.deepEqual(findOperatorVocabularyViolations(), []);
  const declarations = discoverVocabularyDeclarations();
  assert.deepEqual(
    declarations['provider-families'].map((site) => site.file),
    ['packages/contracts/src/provider-family.ts'],
  );
  assert.deepEqual(
    declarations['operator-vocabulary'].map((site) => site.file),
    ['packages/sandbox/src/host-harness/config.ts'],
  );
  assert.deepEqual(
    declarations['terminal-story'].map((site) => site.file),
    ['packages/sandbox/src/host-harness/provider-terminal-story.ts'],
  );
  assert.deepEqual(declarations['operator-vocabulary'][0].members, [
    'auto',
    'aio',
    'boxlite',
    'cloud-http',
    'control-plane',
  ]);
});
