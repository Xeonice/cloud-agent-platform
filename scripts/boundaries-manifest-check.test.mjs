/**
 * Guards the boundaries manifest interpreter.
 *
 * The interpreter's whole reason to exist is that it sees what the ESLint layer
 * cannot: a dynamic `import('…')`, an egress spelling nobody wrote a selector
 * for, and a violation wearing an `eslint-disable` comment. Each of those is a
 * case below, run against committed fixture trees under
 * `scripts/fixtures/boundaries-manifest-check/` — the real tree is never
 * modified, and no case depends on the repository manifest existing.
 *
 * Two red paths matter as much as the violations themselves: a manifest the
 * gate cannot enforce (missing provenance, unknown rule kind, an exemption with
 * no owner) and a scan that resolves to zero files. Both are the shapes in
 * which a gate goes quietly green.
 *
 * Run: node --test scripts/boundaries-manifest-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  maskSource,
  readClause,
  readImports,
  readEgress,
  matchesPattern,
  normalizeManifest,
  sourceFilesUnder,
  tsconfigAliases,
  runCheck,
} from './boundaries-manifest-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'boundaries-manifest-check.mjs');
const FIXTURES = path.join(HERE, 'fixtures', 'boundaries-manifest-check');

/** Scan a fixture tree with the real implementation, in process. */
function scan(fixture, manifest = 'boundaries-manifest.json') {
  const root = path.join(FIXTURES, fixture);
  return runCheck({ root, manifestPath: path.join(root, manifest) });
}

/** Run the gate the way CI runs it, so exit codes are proved, not assumed. */
function runCli(fixture, manifest = 'boundaries-manifest.json') {
  const root = path.join(FIXTURES, fixture);
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--root', root, '--manifest', path.join(root, manifest)],
    { encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const at = (violations, file) => violations.filter((v) => v.file.endsWith(file));

// ---- P1–P8: package boundaries --------------------------------------------

test('a forbidden static import is reported with its file and line', () => {
  const { violations, errors } = scan('forbidden-imports');
  assert.deepEqual(errors, []);
  const found = at(violations, 'components/task-panel.tsx');
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, 'P1');
  assert.equal(found[0].kind, 'forbidden-import');
  assert.equal(found[0].line, 1);
  assert.match(found[0].detail, /@cap-console\/api/);
});

test('a dynamic import of a forbidden package is reported — the form ESLint does not see', () => {
  const { violations } = scan('forbidden-imports');
  const found = at(violations, 'routes/loader.ts');
  const dynamic = found.filter((v) => /dynamic import/.test(v.detail));
  assert.equal(dynamic.length, 2, 'both dynamic imports are caught');
  assert.match(dynamic[0].detail, /@cap-console\/sandbox-core/);
});

test('a relative specifier is judged by where it lands, not how it is spelled', () => {
  const { violations } = scan('forbidden-imports');
  const traversal = at(violations, 'routes/loader.ts').find((v) =>
    /tasks\.service/.test(v.detail),
  );
  assert.ok(traversal, "'../../../api/src/…' is matched against the apps/api/* pattern");
  assert.equal(traversal.line, 7);
});

test('legal imports, and forbidden package names inside strings, are left alone', () => {
  const { violations } = scan('forbidden-imports');
  assert.deepEqual(at(violations, 'components/allowed.tsx'), []);
});

test('an entry that defers to a landed gate is not enforced a second time', () => {
  const { rules, errors } = normalizeManifest({
    packageRules: [
      {
        id: 'P3',
        enforcement: 'existing-gate',
        provenance: '02#A P3',
        change: 'close-gate-blindspots-and-ci-hygiene',
        enforcedBy: 'packages/sandbox/test/facade-surface.gate.mjs',
      },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(rules[0].kind, 'reference');
  assert.equal(rules[0].enforcedBy, 'packages/sandbox/test/facade-surface.gate.mjs');
});

test('a landed rule that names no enforcer is rejected — otherwise nothing enforces it', () => {
  const { errors } = normalizeManifest({
    packageRules: [
      { id: 'P3', enforcement: 'existing-gate', provenance: '02#A P3', change: 'x' },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /enforcedBy/);
});

// ---- P6: import kind -------------------------------------------------------

test('a value import from a type-only-permitted package is red, a type import is not', () => {
  const { violations, errors } = scan('type-only');
  assert.deepEqual(errors, []);
  assert.deepEqual(at(violations, 'src/types.ts'), [], '`import type` is permitted');

  const value = at(violations, 'src/runtime.ts');
  assert.equal(value.length, 1);
  assert.equal(value[0].rule, 'P6');
  assert.match(value[0].detail, /only import it as a type/);
});

test('a mixed clause is a value import — one runtime binding is enough', () => {
  const { violations } = scan('type-only');
  assert.equal(at(violations, 'src/mixed.ts').length, 1);
});

test('import kinds are read per binding', () => {
  assert.equal(readClause(' type { A } ').typeOnly, true);
  assert.equal(readClause(' { type A, type B } ').typeOnly, true);
  assert.equal(readClause(' { type A, B } ').typeOnly, false);
  assert.equal(readClause(' Default ').typeOnly, false);
  assert.equal(readClause(' type Default ').typeOnly, true);
  assert.equal(readClause(' * as ns ').typeOnly, false);
  assert.equal(
    readClause(' typeahead ').typeOnly,
    false,
    'a binding whose name starts with "type" is not a type import',
  );
});

// ---- disable comments ------------------------------------------------------

test('an eslint-disable comment does not exempt a violation', () => {
  const { violations, errors } = scan('disable-comment');
  assert.deepEqual(errors, []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 3, 'the import line, not the comment line');
});

test('a committed eslint-suppressions entry does not silence the interpreter', () => {
  // The fixture ships a decoy suppressions file naming exactly this violation.
  // The interpreter's inputs are the manifest and the source; if it grew a
  // taste for ESLint's ledger the two loops would stop being independent.
  const { violations } = scan('disable-comment');
  assert.equal(violations.length, 1);
  assert.match(violations[0].file, /silenced\.tsx$/);
});

test('comments and strings cannot fake an import', () => {
  const source = [
    "// import { x } from '@cap-console/api';",
    "/* import { y } from '@cap-console/api'; */",
    'const spec = "@cap-console/api";',
    "import { real } from '@cap-console/ui';",
  ].join('\n');
  const found = readImports(source);
  assert.deepEqual(
    found.map((entry) => entry.specifier),
    ['@cap-console/ui'],
  );
  assert.equal(found[0].line, 4);
});

test('every import form the repository writes is seen', () => {
  const source = [
    "import Default from 'a';",
    "import * as ns from 'b';",
    "import { named } from 'c';",
    "import type { T } from 'd';",
    "import 'e';",
    "export { re } from 'f';",
    "export * from 'g';",
    "const lazy = await import('h');",
    "const cjs = require('i');",
  ].join('\n');
  const specifiers = readImports(source).map((entry) => entry.specifier);
  for (const spec of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
    assert.ok(specifiers.includes(spec), `${spec} not seen`);
  }
});

test('a side-effect import does not swallow the statement after it', () => {
  const source = ["import './styles.css'", "import { a } from '@cap-console/api'"].join('\n');
  const found = readImports(source);
  const api = found.find((entry) => entry.specifier === '@cap-console/api');
  assert.equal(api.line, 2, 'the second statement keeps its own line');
});

// ---- S1: egress spellings --------------------------------------------------

test('egress variants outside the seam are red, in every spelling', () => {
  const { violations, errors } = scan('egress');
  assert.deepEqual(errors, []);

  const spellings = at(violations, 'components/spellings.tsx');
  const detail = spellings.map((v) => v.detail).join('\n');
  assert.match(detail, /window\.fetch/);
  assert.match(detail, /globalThis\.fetch/);
  assert.match(detail, /WebSocket/);
  assert.ok(
    spellings.some((v) => v.line === 10),
    'the local alias binding `const send = fetch` is reported',
  );
  assert.ok(
    spellings.some((v) => v.line === 15),
    'the destructured alias `const { fetch: call } = window` is reported',
  );
});

test('the declared transport files are the seam and are not reported', () => {
  const { violations } = scan('egress');
  assert.deepEqual(at(violations, 'lib/api/real.ts'), []);
  assert.deepEqual(at(violations, 'lib/ws-client.ts'), []);
});

test('refetch, a method named fetch on something else, and the word in a string are not egress', () => {
  const { violations } = scan('egress');
  assert.deepEqual(at(violations, 'components/quiet.tsx'), []);
});

test('egress detection classifies how the global is reached', () => {
  const found = readEgress(
    [
      'const a = fetch(url);',
      'const b = window.fetch(url);',
      'const c = globalThis.fetch(url);',
      'const d = fetch;',
      'const socket = new WebSocket(url);',
      'const e = client.fetch(url);',
      'const f = query.refetch();',
      'type Deps = { fetch: typeof globalThis.fetch };',
    ].join('\n'),
    ['fetch', 'WebSocket'],
  );
  const byLine = new Map(found.map((entry) => [entry.line, entry]));
  assert.equal(byLine.get(1).form, 'call');
  assert.equal(byLine.get(2).spelling, 'window.fetch');
  assert.equal(byLine.get(3).spelling, 'globalThis.fetch');
  assert.equal(byLine.get(4).form, 'reference');
  assert.equal(byLine.get(5).form, 'construction');
  assert.equal(byLine.has(6), false, 'client.fetch is a method on something else');
  assert.equal(byLine.has(7), false, 'refetch is a different identifier');
});

test('a template literal expression is still code to the scanner', () => {
  const found = readEgress('const url = `${await fetch(base)}`;', ['fetch']);
  assert.equal(found.length, 1);
});

test('masking keeps every byte offset so line numbers stay true', () => {
  const source = "const a = 1; // fetch(x)\nconst b = 'fetch';\nfetch(y);\n";
  const { code, bare } = maskSource(source);
  assert.equal(code.length, source.length);
  assert.equal(bare.length, source.length);
  assert.equal(code.split('\n').length, source.split('\n').length);
  assert.match(code, /'fetch'/, 'the code view keeps string bodies — specifiers live there');
  assert.doesNotMatch(bare.split('\n')[1], /fetch/, 'the bare view blanks string bodies');
  assert.doesNotMatch(code.split('\n')[0], /fetch/, 'both views blank comments');
});

// ---- S2: the capabilities seam --------------------------------------------

test('a component importing a data-fetching value from the transport is red', () => {
  const { violations, errors } = scan('seam-import');
  assert.deepEqual(errors, []);
  const found = at(violations, 'components/stream-panel.tsx');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'seam-bypass');
  assert.match(found[0].detail, /fetchTaskStream/);
});

test('a type import and a registered allowNames entry are not a bypass', () => {
  const { violations } = scan('seam-import');
  assert.deepEqual(at(violations, 'components/classified.tsx'), []);
});

test('an import written with the tsconfig alias is judged like any other', () => {
  // Every intra-app import in this repository is spelled `@/lib/api/real`. A
  // resolver blind to the alias reports a clean tree instead of the bypasses.
  const { violations } = scan('seam-import');
  const aliased = at(violations, 'components/aliased-panel.tsx');
  assert.equal(aliased.length, 1, 'the value import is seen through the alias');
  assert.match(aliased[0].detail, /listTasks/);
  assert.doesNotMatch(aliased[0].detail, /TaskRow/, 'the type import is still fine');
});

test('aliases come from the nearest tsconfig, and are inherited by subdirectories', () => {
  const root = path.join(FIXTURES, 'seam-import');
  const deep = tsconfigAliases(root, 'apps/web/src/components/aliased-panel.tsx');
  assert.deepEqual(deep, [{ prefix: '@/', target: 'apps/web/src/' }]);

  const outside = tsconfigAliases(path.join(FIXTURES, 'clean'), 'apps/web/src/x.ts');
  assert.deepEqual(outside, [], 'no tsconfig, no aliases invented');
});

test('an allowlist entry is three-field data like any other tolerance', () => {
  const { errors } = normalizeManifest({
    seamRules: [
      {
        id: 'S2',
        enforcement: 'manifest',
        provenance: '02#C S2',
        change: 'enforce-boundaries-from-manifest',
        appliesTo: ['apps/web/src/components'],
        target: { path: 'apps/web/src/lib/api/real.ts' },
        allowNames: ['ApiError'],
      },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /allowNames\[0\]/);
  assert.match(errors[0], /reason, owner, change/);
});

// ---- exemptions ------------------------------------------------------------

test('an exemption that covers nothing is reported as a stale ledger entry', () => {
  // The manifest is the single ledger for the pre-existing S1/S2 sites (the CI
  // interpreter may not read ESLint's suppression file), so the shrink-only
  // property has to live here: fix the site, delete the entry, same change.
  const { errors } = scan('exemptions', 'manifest-stale-exemption.json');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /already-fixed\.tsx/);
  assert.match(errors[0], /covers no violation/);
});

test('an import resolving back inside its own package crosses no boundary', () => {
  // P5/P8 forbid the directories their own consumers live under. Matching the
  // resolved path without asking whether a package was crossed would report
  // every relative import a package makes to itself.
  const { violations, errors } = scan('clean', 'manifest-own-package-paths.json');
  assert.deepEqual(errors, []);
  assert.deepEqual(
    violations,
    [],
    "apps/web's own '../lib/api/real' resolves under `apps` and is still not a violation",
  );
});

test('a complete three-field exemption is honored', () => {
  const { violations, errors } = scan('exemptions');
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, [], 'the exempted file is the only egress site here');
});

test('an exemption written next to its rule is honored the same way', () => {
  // The first cut validated rule-scoped exemptions and then filtered with the
  // top-level list only, so a tolerance declared beside its rule was reviewed
  // and ignored — red on a site the manifest had already dispositioned.
  const { violations, errors } = scan('exemptions', 'manifest-rule-scoped.json');
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
});

test('an exemption missing one of its three fields fails closed, naming entry and field', () => {
  const { violations, errors } = scan('exemptions', 'manifest-missing-owner.json');
  assert.equal(violations.length, 0, 'nothing is judged until the declaration is sound');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /exemptions\[0\]/);
  assert.match(errors[0], /missing owner/);
});

test('an exemption is scoped to its rule and its path', () => {
  const exemption = {
    rule: 'S1',
    path: 'apps/web/src/lib/mock-session.ts',
    reason: 'r',
    owner: 'o',
    change: 'c',
  };
  const { errors } = normalizeManifest({
    seamRules: [
      {
        id: 'S1',
        enforcement: 'manifest',
        provenance: 'p',
        change: 'c',
        appliesTo: ['apps/web/src'],
        egress: { calls: ['fetch'] },
      },
    ],
    exemptions: [exemption],
  });
  assert.deepEqual(errors, []);
});

// ---- fail-closed loading ---------------------------------------------------

test('a rule without provenance or change is rejected by name', () => {
  const { errors } = scan('clean', '../malformed/manifest-missing-provenance.json');
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /rule P1: missing provenance/);
  assert.match(errors.join('\n'), /rule P1: missing change/);
});

test('a rule kind this interpreter does not implement is rejected, not skipped', () => {
  const { errors } = scan('clean', '../malformed/manifest-unknown-kind.json');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rule P9/);
  assert.match(errors[0], /forbid \/ egress \/ target/);
});

test('an empty rule set is a failure', () => {
  const { errors } = scan('clean', '../malformed/manifest-empty-rules.json');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no boundary rules/);
});

test('a missing manifest fails closed rather than passing with nothing to check', () => {
  const { errors } = scan('clean', 'no-such-manifest.json');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not readable/);
});

test('a manifest that is not JSON fails closed', () => {
  const result = runCheck({
    root: path.join(FIXTURES, 'clean'),
    manifestPath: path.join(FIXTURES, 'clean', 'apps/web/src/lib/api/real.ts'),
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /not parsable JSON/);
});

test('a scan that resolves to zero files is a failure, not a pass', () => {
  const { errors, violations } = scan('empty-scan');
  assert.deepEqual(violations, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /zero source files/);
  assert.match(errors[0], /apps\/web-that-moved/);
});

test('a manifest whose every rule defers elsewhere does not pass vacuously', () => {
  const { violations, errors } = scan('clean', '../malformed/manifest-only-references.json');
  assert.deepEqual(violations, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no enforceable rule/);
});

test('a manifest mixing enforceable and deferred rules enforces the enforceable ones', () => {
  const { errors, rules, scanned } = scan('clean');
  assert.deepEqual(errors, []);
  assert.equal(rules, 4, 'the deferred P7 entry is counted and not enforced twice');
  assert.ok(scanned > 0, 'and the enforceable rules did look at files');
});

// ---- scanning mechanics ----------------------------------------------------

test('tests, generated files and build output are not the governed population', () => {
  const files = sourceFilesUnder(path.join(FIXTURES, 'clean'), 'apps/web');
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => !/\.(test|spec)\./.test(file)));
  assert.ok(files.every((file) => file.startsWith('apps/web/')));
});

test('a scan root naming one file governs exactly that file', () => {
  const files = sourceFilesUnder(
    path.join(FIXTURES, 'clean'),
    'apps/web/src/lib/api/real.ts',
  );
  assert.deepEqual(files, ['apps/web/src/lib/api/real.ts']);
});

test('an exact package pattern covers its subpaths, and a wildcard covers its family', () => {
  assert.equal(matchesPattern('@cap-console/api', '@cap-console/api'), true);
  assert.equal(matchesPattern('@cap-console/api/tasks', '@cap-console/api'), true);
  assert.equal(matchesPattern('@cap-console/api-client', '@cap-console/api'), false);
  assert.equal(matchesPattern('@cap-console/sandbox-core', '@cap-console/sandbox*'), true);
  assert.equal(matchesPattern('apps/api/src/main.ts', 'apps/api/*'), true);
});

// ---- exit codes ------------------------------------------------------------

test('the clean fixture exits zero and says what it scanned', () => {
  const { status, stdout } = runCli('clean');
  assert.equal(status, 0, stdout);
  assert.match(stdout, /no boundary violations/);
  assert.match(stdout, /file\(s\)/);
});

for (const [name, fixture, manifest] of [
  ['a forbidden static import', 'forbidden-imports', 'boundaries-manifest.json'],
  ['a forbidden dynamic import', 'forbidden-imports', 'boundaries-manifest.json'],
  ['a P6 value import', 'type-only', 'boundaries-manifest.json'],
  ['a disable-commented violation', 'disable-comment', 'boundaries-manifest.json'],
  ['an egress variant spelling', 'egress', 'boundaries-manifest.json'],
  ['an exemption missing a field', 'exemptions', 'manifest-missing-owner.json'],
  ['an empty scan', 'empty-scan', 'boundaries-manifest.json'],
]) {
  test(`${name} exits non-zero`, () => {
    const { status, stderr } = runCli(fixture, manifest);
    assert.equal(status, 1, `expected a red exit for ${name}`);
    assert.ok(stderr.trim().length > 0, 'the failure says what was wrong');
  });
}
