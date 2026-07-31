#!/usr/bin/env node
/**
 * Facade surface gate (R6) — proves the public entry of `@cap-console/sandbox`
 * matches the committed, reviewed surface data.
 *
 * Gate shape (design D4): the facade surface is an open list of several hundred
 * symbol names, NOT a closed vocabulary, so this is a runtime snapshot gate
 * rather than a type-level total map.
 *
 * Independence invariant (the converge-contracts blind spot): the MEASURED side
 * is derived from the facade entry module (`src/index.ts`); the EXPECTED side is
 * the committed JSON (`test/expected-facade-surface.json`). The check NEVER
 * regenerates the expected data from the module — a deliberate surface change
 * must update the JSON in the same PR (use `--print-measured` to produce the
 * new data for review).
 *
 * The gate exits non-zero when:
 *   - the facade entry contains a wildcard re-export (`export *`) — banned;
 *   - an export exists in the module but not in the committed data (named);
 *   - the committed data names a symbol the module no longer exports (named);
 *   - a symbol changed kind (value <-> type);
 *   - the committed data is malformed.
 *
 * Usage:
 *   node test/facade-surface.gate.mjs [entryPath] [expectedJsonPath]
 *   node test/facade-surface.gate.mjs --print-measured
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--print-measured');
const printMeasured = process.argv.includes('--print-measured');
const entryPath = args[0] ?? join(here, '../src/index.ts');
const expectedPath = args[1] ?? join(here, 'expected-facade-surface.json');

export function measureSurface(sourceText, fileName) {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const values = [];
  const types = [];
  const errors = [];
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (!stmt.exportClause || ts.isNamespaceExport(stmt.exportClause)) {
        const { line } = sf.getLineAndCharacterOfPosition(stmt.getStart());
        errors.push(
          `wildcard re-export (\`export *\`) at ${fileName}:${line + 1} — the facade entry must enumerate exports by name`,
        );
        continue;
      }
      for (const el of stmt.exportClause.elements) {
        const name = el.name.text;
        if (stmt.isTypeOnly || el.isTypeOnly) types.push(name);
        else values.push(name);
      }
      continue;
    }
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const isExported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      types.push(stmt.name.text);
    } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      if (stmt.name) values.push(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) values.push(decl.name.text);
      }
    }
  }
  return { values: values.sort(), types: types.sort(), errors };
}

export function auditExpected(data) {
  const problems = [];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['expected-surface data must be an object with `values` and `types` arrays'];
  }
  for (const key of ['values', 'types']) {
    if (!Array.isArray(data[key])) {
      problems.push(`expected-surface data is missing the \`${key}\` array`);
      continue;
    }
    for (const entry of data[key]) {
      if (typeof entry !== 'string' || entry.length === 0) {
        problems.push(`\`${key}\` contains a non-string entry: ${JSON.stringify(entry)}`);
      }
    }
    const dupes = data[key].filter((n, i) => data[key].indexOf(n) !== i);
    for (const d of [...new Set(dupes)]) problems.push(`\`${key}\` lists "${d}" more than once`);
  }
  const unknownKeys = Object.keys(data).filter((k) => !['values', 'types'].includes(k));
  for (const k of unknownKeys) problems.push(`unknown key \`${k}\` in expected-surface data`);
  return problems;
}

export function compareSurface(measured, expected) {
  const failures = [];
  for (const kind of ['values', 'types']) {
    const m = new Set(measured[kind]);
    const e = new Set(expected[kind]);
    for (const name of m) {
      if (!e.has(name)) {
        failures.push(
          `UNREVIEWED EXPORT: \`${name}\` (${kind.slice(0, -1)}) is exported by the facade but absent from the committed surface data — update test/expected-facade-surface.json in the same PR`,
        );
      }
    }
    for (const name of e) {
      if (!m.has(name)) {
        failures.push(
          `STALE SURFACE ENTRY: \`${name}\` (${kind.slice(0, -1)}) is in the committed surface data but the facade no longer exports it — remove it from test/expected-facade-surface.json`,
        );
      }
    }
  }
  return failures;
}

function main() {
  let sourceText;
  try {
    sourceText = readFileSync(entryPath, 'utf8');
  } catch (err) {
    console.error(`facade-surface gate: cannot read entry module ${entryPath}: ${err.message}`);
    process.exit(1);
  }
  const measured = measureSurface(sourceText, entryPath);

  if (printMeasured) {
    console.log(JSON.stringify({ values: measured.values, types: measured.types }, null, 2));
    if (measured.errors.length) {
      for (const e of measured.errors) console.error(`facade-surface gate: ${e}`);
      process.exit(1);
    }
    return;
  }

  const failures = [...measured.errors];

  let expected;
  try {
    expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  } catch (err) {
    console.error(`facade-surface gate: cannot load expected surface data ${expectedPath}: ${err.message}`);
    process.exit(1);
  }
  const audit = auditExpected(expected);
  if (audit.length) {
    for (const p of audit) console.error(`facade-surface gate: malformed expected-surface data: ${p}`);
    process.exit(1);
  }

  failures.push(...compareSurface(measured, expected));

  if (failures.length) {
    for (const f of failures) console.error(`facade-surface gate: ${f}`);
    console.error(`facade-surface gate: FAIL (${failures.length} problem(s))`);
    process.exit(1);
  }
  console.log(
    `facade-surface gate: OK (${measured.values.length} value exports, ${measured.types.length} type exports match the reviewed surface)`,
  );
}

main();
