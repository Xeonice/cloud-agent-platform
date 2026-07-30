/**
 * Guards the contracts shared-export gate.
 *
 * The first version of this gate was green on a throwaway unimported export —
 * it asked whether the export's schema/type twin was reachable without checking
 * the twin EXISTED, and a name that does not exist is not in the unimported set,
 * so it read as reachable and vouched for its partner. Every export without a
 * twin was waved through. These cases pin each liveness rule separately so that
 * cannot recur silently.
 *
 * Run: node --test scripts/contracts-shared-export-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readModuleExports,
  readContractImports,
  readIntraPackageImports,
  isComposedInto,
  pairedName,
  scan,
} from './contracts-shared-export-check.mjs';

// ---- export extraction -----------------------------------------------------

test('every declaration form this package uses is seen', () => {
  const source = [
    'export const A = 1;',
    'export type B = string;',
    'export interface C { x: number }',
    'export function D() {}',
    'export class E {}',
    'export enum F { G }',
    'export declare const H: number;',
    'export { I, J as K };',
    "export * from './elsewhere.js';",
    'const NotExported = 2;',
  ].join('\n');
  const names = readModuleExports(source);
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'H', 'I', 'K']) {
    assert.ok(names.has(name), `${name} not seen`);
  }
  assert.equal(names.has('NotExported'), false);
  assert.equal(names.has('J'), false, 'the LOCAL side of `J as K` is not exported');
});

// ---- import extraction -----------------------------------------------------

test('value, type, aliased and require imports all count as uses', () => {
  const source = [
    'import { A, type B } from "@cap-console/contracts";',
    'import type { C as Renamed } from "@cap-console/contracts";',
    'const { D } = require("@cap-console/contracts");',
    'import { Unrelated } from "./local.js";',
  ].join('\n');
  const { names, namespace } = readContractImports(source);
  for (const name of ['A', 'B', 'C', 'D']) {
    assert.ok(names.has(name), `${name} not counted as imported`);
  }
  assert.equal(
    names.has('Renamed'),
    false,
    'the LOCAL alias is not the contract export name',
  );
  assert.equal(names.has('Unrelated'), false);
  assert.equal(namespace, false);
});

test('a namespace import is reported, not silently treated as importing nothing', () => {
  // `import * as c` reaches every export, so it would make the gate vacuous.
  const { namespace } = readContractImports(
    'import * as contracts from "@cap-console/contracts";',
  );
  assert.equal(namespace, true);
});

// ---- liveness rules --------------------------------------------------------

test('composition counts as a use, but a mention in a comment does not', () => {
  const sources = new Map([
    ['a', 'export const Inner = 1;\n'],
    ['b', 'export const Outer = z.object({ x: Inner });\n'],
  ]);
  assert.equal(isComposedInto('Inner', 'a', sources), true);

  const onlyProse = new Map([
    ['a', 'export const Inner = 1;\n'],
    ['b', '/** Related to Inner, which we no longer use. */\nexport const Outer = 2;\n'],
  ]);
  assert.equal(
    isComposedInto('Inner', 'a', onlyProse),
    false,
    'a doc block naming a dead export would otherwise keep it alive forever',
  );
});

test('the schema/type pairing is symmetric', () => {
  assert.equal(pairedName('TaskResponse'), 'TaskResponseSchema');
  assert.equal(pairedName('TaskResponseSchema'), 'TaskResponse');
});

// ---- the real tree ---------------------------------------------------------

test('the repository is clean under the gate', () => {
  const result = scan();
  assert.deepEqual(
    result.dead,
    [],
    `unreachable exports: ${result.dead.join(', ')}`,
  );
  assert.deepEqual(
    result.namespaceImporters,
    [],
    'a namespace import would make this gate unable to see a dead export',
  );
});

test('the scan actually looked at something', () => {
  // A scan that found no consumers, no modules or no exports would report a
  // clean tree for the wrong reason. These are floors, not exact counts, so the
  // assertion does not turn ordinary growth into a failure.
  const result = scan();
  assert.ok(result.consumers.length >= 4, 'consumer packages');
  assert.ok(result.modules >= 30, 'contracts modules');
  assert.ok(result.exports >= 300, 'contracts exports');
  assert.ok(result.importedExports >= 100, 'exports a consumer imports');
});
