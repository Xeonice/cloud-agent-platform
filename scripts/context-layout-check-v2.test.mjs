/**
 * Guards the v2 context layout gate.
 *
 * Every red path is proven on a throwaway FIXTURE TREE built in a temp dir and
 * scanned by the real implementation — the committed baseline
 * (`scripts/ratchets/r7.json`) and the real `apps/api/src` are never touched by
 * these tests, so a fixture can never quietly become the tree's verdict.
 *
 * What is easy to get wrong, and therefore pinned here:
 *   - a check class silently switching OFF when its manifest block disappears
 *     (a gate that measures nothing must be red, not green);
 *   - an unclassified file being SKIPPED instead of reported — that is exactly
 *     how a layer check turns vacuous;
 *   - the file→layer rules drifting into a second copy inside the script;
 *   - the baseline comparison growing a private second implementation instead
 *     of importing the shared comparator.
 *
 * Run: node --test scripts/context-layout-check-v2.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeLayout,
  classifyLayer,
  collectImports,
  loadManifest,
  runGate,
  MANIFEST_REL,
  BASELINE_REL,
} from './context-layout-check-v2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SCOPE = 'apps/api/src';

/** A manifest with the same shape as 工件01, small enough to reason about. */
function fixtureManifest(overrides = {}) {
  return {
    version: 1,
    scope: SCOPE,
    scopeAlias: '@/',
    layers: {
      order: ['interface', 'application', 'domain', 'store'],
      allowedImports: {
        interface: ['interface', 'application', 'domain'],
        application: ['application', 'domain', 'store'],
        domain: ['domain'],
        store: ['store'],
      },
      fileClassification: {
        unclassifiedLayer: 'unclassified',
        compositionLayer: 'composition',
        rules: [
          { suffix: '.module.ts', layer: 'composition' },
          { suffix: '.controller.ts', layer: 'interface' },
          { suffix: '.service.ts', layer: 'application' },
          { suffix: '.port.ts', layer: 'domain' },
          { suffix: '.store.ts', layer: 'store' },
        ],
      },
    },
    contexts: {
      'task-execution': { directories: ['tasks'] },
      'sandbox-provisioning': { directories: ['sandbox'] },
      'platform-ops': { directories: ['prisma', 'domain-events'] },
    },
    crossContextRules: {
      machineReadable: {
        portFileSuffix: '.port.ts',
        compositionFileSuffix: '.module.ts',
        compositionRootFiles: ['main.ts', 'app.module.ts'],
        sharedKernelDirectories: ['prisma'],
        domainEventSubscription: {
          busDirectory: 'domain-events',
          busPortFiles: ['domain-events/domain-event-bus.port.ts'],
        },
      },
    },
    prismaPlacement: {
      storeFileSuffix: '.store.ts',
      symbols: ['@prisma/client', 'PrismaService'],
      exemptDirectories: ['prisma'],
    },
    ...overrides,
  };
}

/** Materialises a fixture tree and scans it with the real implementation. */
function scan(files, manifest = fixtureManifest()) {
  const root = mkdtempSync(join(tmpdir(), 'context-layout-v2-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, SCOPE, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return analyzeLayout({ root, manifest });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Same fixture tree, but taken all the way through the ratchet comparison. */
function gate(files, { manifest = fixtureManifest(), baseline } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'context-layout-v2-gate-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, SCOPE, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    let baselinePath;
    if (baseline !== undefined) {
      baselinePath = join(root, 'fixture-baseline.json');
      writeFileSync(baselinePath, JSON.stringify(baseline));
    } else {
      baselinePath = join(root, 'no-such-baseline.json');
    }
    return runGate({ root, manifest, baselinePath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const kinds = (result, kind) => result.findings.filter((f) => f.kind === kind);

// ---------------------------------------------------------------- red path 1
test('a cross-context import of another context internals is reported', () => {
  const found = scan({
    'tasks/tasks.service.ts': "import { boot } from '@/sandbox/sandbox.service';\n",
    'sandbox/sandbox.service.ts': 'export const boot = 1;\n',
  });
  const violations = kinds(found, 'cross-context-import');
  assert.equal(violations.length, 1);
  assert.match(violations[0].file, /tasks\/tasks\.service\.ts$/);
  assert.match(violations[0].detail, /@\/sandbox\/sandbox\.service/);
  assert.equal(violations[0].line, 1);
});

// ------------------------------------------- domain-event subscription (归因)
test('a subscriber reaching the bus through its declared port is legal and unreported', () => {
  const found = scan({
    'tasks/tasks.service.ts':
      "import { DOMAIN_EVENT_BUS } from '@/domain-events/domain-event-bus.port';\n",
    'domain-events/domain-event-bus.port.ts': 'export const DOMAIN_EVENT_BUS = 1;\n',
  });
  assert.deepEqual(kinds(found, 'cross-context-import'), []);
});

test('a subscriber bypassing the bus port is attributed as a domain-event subscription', () => {
  const found = scan({
    'tasks/tasks.service.ts':
      "import { Bus } from '@/domain-events/domain-event-bus.service';\n",
    'domain-events/domain-event-bus.service.ts': 'export const Bus = 1;\n',
  });
  const violations = kinds(found, 'cross-context-import');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /domain-event subscription/);
  assert.match(violations[0].detail, /domain-events\/domain-event-bus\.port\.ts/);
  // Attribution never widens the legal set: this is still a violation, and the
  // legal forms it names are the same three.
  assert.match(violations[0].detail, /legal forms are still/);
});

test('the subscription encoding is attribution only — a port file that widens the rule is rejected', () => {
  const widened = fixtureManifest();
  widened.crossContextRules.machineReadable.domainEventSubscription.busPortFiles = [
    'domain-events/domain-event-bus.ts',
  ];
  const result = gate({ 'tasks/tasks.service.ts': 'export const S = 1;\n' }, {
    manifest: widened,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /busPortFiles must each end with/);
});

test('the three legal cross-context forms are not reported', () => {
  const found = scan({
    // a declared port interface
    'tasks/tasks.service.ts': "import type { P } from '@/sandbox/sandbox.port';\n",
    // DI composition
    'tasks/tasks.module.ts': "import { S } from '@/sandbox/sandbox.service';\n",
    // the shared kernel
    'tasks/tasks.controller.ts': "import { PrismaService } from '@/prisma/prisma.service';\n",
    'sandbox/sandbox.port.ts': 'export type P = 1;\n',
    'sandbox/sandbox.service.ts': 'export const S = 1;\n',
    'prisma/prisma.service.ts': 'export class PrismaService {}\n',
  });
  assert.deepEqual(kinds(found, 'cross-context-import'), []);
});

// ---------------------------------------------------------------- red path 2
test('an upward layer import inside one context is reported', () => {
  const found = scan({
    'tasks/tasks.service.ts': "import { T } from './tasks.controller';\n",
    'tasks/tasks.controller.ts': 'export const T = 1;\n',
  });
  const violations = kinds(found, 'layer-direction');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /'application' imports '\.\/tasks\.controller'/);
  assert.match(violations[0].detail, /which is 'interface'/);
});

test('interface may import application, and store is not reachable from interface', () => {
  const legal = scan({
    'tasks/tasks.controller.ts': "import { S } from './tasks.service';\n",
    'tasks/tasks.service.ts': 'export const S = 1;\n',
  });
  assert.deepEqual(kinds(legal, 'layer-direction'), []);

  const illegal = scan({
    'tasks/tasks.controller.ts': "import { R } from './task.store';\n",
    'tasks/task.store.ts': 'export const R = 1;\n',
  });
  assert.equal(kinds(illegal, 'layer-direction').length, 1);
});

test('DI composition files are exempt from the layer direction check', () => {
  const found = scan({
    'tasks/tasks.module.ts': [
      "import { C } from './tasks.controller';",
      "import { S } from './tasks.service';",
    ].join('\n'),
    'tasks/tasks.controller.ts': 'export const C = 1;\n',
    'tasks/tasks.service.ts': 'export const S = 1;\n',
  });
  assert.deepEqual(kinds(found, 'layer-direction'), []);
});

// ---------------------------------------------------------------- red path 3
test('Prisma reached outside a store file is reported, by package and by symbol', () => {
  const found = scan({
    'tasks/tasks.service.ts': "import { Prisma } from '@prisma/client';\n",
    'tasks/tasks.controller.ts': "import { PrismaService } from '@/prisma/prisma.service';\n",
    'prisma/prisma.service.ts': 'export class PrismaService {}\n',
  });
  const violations = kinds(found, 'prisma-outside-store');
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.file).sort(),
    [`${SCOPE}/tasks/tasks.controller.ts`, `${SCOPE}/tasks/tasks.service.ts`],
  );
});

test('a store file and the declared shared kernel may reach Prisma', () => {
  const found = scan({
    'tasks/task.store.ts': "import { PrismaService } from '@/prisma/prisma.service';\n",
    'prisma/prisma.service.ts': "import { PrismaClient } from '@prisma/client';\nexport class PrismaService {}\n",
  });
  assert.deepEqual(kinds(found, 'prisma-outside-store'), []);
});

// ---------------------------------------------------------------- red path 4
test('a file matching no layer rule is reported as unclassified, not skipped', () => {
  const found = scan({
    'tasks/helper.ts': "import { S } from './tasks.service';\n",
    'tasks/tasks.service.ts': 'export const S = 1;\n',
  });
  const violations = kinds(found, 'unclassified-file');
  assert.equal(violations.length, 1);
  assert.match(violations[0].file, /tasks\/helper\.ts$/);
  assert.equal(found.scanned, 2);
  assert.equal(found.counts['unclassified-file'], 1);
});

test('classification consumes the manifest rules in declared order', () => {
  const manifest = fixtureManifest();
  assert.equal(classifyLayer('tasks/tasks.controller.ts', manifest), 'interface');
  assert.equal(classifyLayer('tasks/tasks.service.ts', manifest), 'application');
  assert.equal(classifyLayer('tasks/task.store.ts', manifest), 'store');
  assert.equal(classifyLayer('tasks/tasks.module.ts', manifest), 'composition');
  assert.equal(classifyLayer('tasks/whatever.ts', manifest), 'unclassified');
});

// ------------------------------------------------------------- fail-closed
test('an empty scan is a failure, never a green run', () => {
  const result = gate({});
  assert.equal(result.exitCode, 1);
  assert.equal(result.scanned, 0);
  assert.match(result.problems.join('\n'), /empty scan/);
});

test('a manifest missing a declaration block fails closed rather than dropping a check', () => {
  const withoutPrisma = fixtureManifest();
  delete withoutPrisma.prismaPlacement;
  const result = gate(
    { 'tasks/tasks.service.ts': "import { Prisma } from '@prisma/client';\n" },
    { manifest: withoutPrisma },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /prismaPlacement/);

  const withoutClassification = fixtureManifest();
  delete withoutClassification.layers.fileClassification;
  const second = gate({ 'tasks/tasks.service.ts': 'export const S = 1;\n' }, {
    manifest: withoutClassification,
  });
  assert.equal(second.exitCode, 1);
  assert.match(second.problems.join('\n'), /fileClassification/);

  // The reserved slot, once filled, is a declaration like any other: dropping
  // it must be loud, not a quietly unattributed subscription.
  const withoutSubscription = fixtureManifest();
  delete withoutSubscription.crossContextRules.machineReadable.domainEventSubscription;
  const third = gate({ 'tasks/tasks.service.ts': 'export const S = 1;\n' }, {
    manifest: withoutSubscription,
  });
  assert.equal(third.exitCode, 1);
  assert.match(third.problems.join('\n'), /domainEventSubscription/);
});

test('a directory belonging to no context fails closed instead of grading as clean', () => {
  const result = gate({
    'orphan/orphan.service.ts': "import { boot } from '@/sandbox/sandbox.service';\n",
    'sandbox/sandbox.service.ts': 'export const boot = 1;\n',
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /orphan: belongs to no context in the manifest/);
});

test('every directory under the real scope is claimed by a context', () => {
  const { unmappedDirectories } = analyzeLayout({ root: REPO_ROOT });
  assert.deepEqual(unmappedDirectories, []);
});

// ------------------------------------------------------------- the ratchet
const seed = (key, count = 1) => ({
  [key]: { count, samples: ['seed'], change: 'fixture' },
});
const CROSS_SERVICE = `cross-context-import:${SCOPE}/tasks/tasks.service.ts`;

test('a count above baseline is red and names the offending file, not just the class', () => {
  const red = gate(
    {
      // the same file reaches twice where the baseline tolerates one reach
      'tasks/tasks.service.ts': [
        "import { boot } from '@/sandbox/sandbox.service';",
        "import { stop } from '@/sandbox/sandbox-runtime.service';",
      ].join('\n'),
      'sandbox/sandbox.service.ts': 'export const boot = 1;\n',
      'sandbox/sandbox-runtime.service.ts': 'export const stop = 1;\n',
    },
    { baseline: seed(CROSS_SERVICE) },
  );
  assert.equal(red.exitCode, 1);
  assert.match(
    red.problems.join('\n'),
    new RegExp(`${CROSS_SERVICE}: measured 2 exceeds the baselined 1`),
  );
});

test('a file with no baseline entry at all is red on its first violation', () => {
  const red = gate(
    {
      'tasks/tasks.service.ts': "import { boot } from '@/sandbox/sandbox.service';\n",
      'tasks/helper.ts': 'export const h = 1;\n',
      'sandbox/sandbox.service.ts': 'export const boot = 1;\n',
    },
    { baseline: seed(CROSS_SERVICE) },
  );
  assert.equal(red.exitCode, 1);
  assert.match(
    red.problems.join('\n'),
    new RegExp(
      `unclassified-file:${SCOPE}/tasks/helper\\.ts: 1 measured violation\\(s\\) with no baseline entry`,
    ),
  );
});

test('a measurement equal to the baseline exits zero and prints the per-class counts', () => {
  const result = gate(
    {
      'tasks/tasks.service.ts': "import { boot } from '@/sandbox/sandbox.service';\n",
      'sandbox/sandbox.service.ts': 'export const boot = 1;\n',
    },
    { baseline: seed(CROSS_SERVICE) },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.problems, []);
  assert.match(result.output.join('\n'), /cross-context-import: 1/);
  assert.match(result.output.join('\n'), /layer-direction: 0/);
  assert.match(result.output.join('\n'), /scanned 2 file\(s\)/);
});

test('a stale baseline entry is red too — the shrink lands with the fix', () => {
  const result = gate(
    {
      'tasks/tasks.controller.ts': "import { S } from './tasks.service';\n",
      'tasks/tasks.service.ts': 'export const S = 1;\n',
    },
    { baseline: seed(`layer-direction:${SCOPE}/tasks/tasks.service.ts`, 2) },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /stale entry/);
});

test('measured violations with no baseline file at all are red', () => {
  const result = gate({
    'tasks/tasks.service.ts': "import { boot } from '@/sandbox/sandbox.service';\n",
    'sandbox/sandbox.service.ts': 'export const boot = 1;\n',
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /no baseline file/);
});

// ------------------------------------------------ single declaration & seams
test('the file→layer rules live only in the manifest, never a second copy in the script', () => {
  const source = readFileSync(join(HERE, 'context-layout-check-v2.mjs'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const literal of ['.controller', '.service.ts', '.gateway', '.port.ts', '.store.ts']) {
    assert.equal(
      code.includes(literal),
      false,
      `the gate hardcodes '${literal}' — the file→layer mapping has exactly one declaration, in ${MANIFEST_REL}`,
    );
  }
});

test('baseline handling is the shared comparator, imported, with no second implementation', () => {
  const source = readFileSync(join(HERE, 'context-layout-check-v2.mjs'), 'utf8');
  assert.match(source, /import \{[^}]*compareToBaseline[^}]*\} from '\.\/ratchets\/comparator\.mjs'/);
  assert.equal(
    /function\s+\w*[Cc]ompareToBaseline/.test(source),
    false,
    'the comparison semantics have one implementation — scripts/ratchets/comparator.mjs',
  );
});

test('the real manifest carries every block this gate interprets', () => {
  const manifest = loadManifest(REPO_ROOT);
  assert.equal(manifest.scope, SCOPE);
  assert.ok(manifest.layers.fileClassification.rules.length > 0);
  assert.ok(manifest.crossContextRules.machineReadable.sharedKernelDirectories.length > 0);
  assert.ok(manifest.prismaPlacement.symbols.includes('@prisma/client'));
  const subscription = manifest.crossContextRules.machineReadable.domainEventSubscription;
  assert.ok(subscription.busPortFiles.length > 0);
  // The bus directory is claimed by a context in the SAME manifest — an
  // attribution pointing at an unmapped directory would attribute nothing.
  const claimed = Object.values(manifest.contexts).some((context) =>
    (context.directories ?? []).includes(subscription.busDirectory),
  );
  assert.equal(claimed, true, 'the declared bus directory must belong to a context');
});

test('v1 is neither wrapped nor replaced, and keeps its own paired script and CI step', () => {
  const source = readFileSync(join(HERE, 'context-layout-check-v2.mjs'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.equal(
    code.includes('api-module-layout-check'),
    false,
    'v2 runs in parallel with v1 — it does not import, wrap or alter the v1 gate (prose may name it, code may not)',
  );
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:module-layout'], /api-module-layout-check\.mjs/);
  const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run: pnpm test:module-layout/);
});

test('the committed baseline this gate owns is named, and fixtures never touch it', () => {
  assert.equal(BASELINE_REL, 'scripts/ratchets/r7.json');
  const before = readFileSync(join(REPO_ROOT, BASELINE_REL), 'utf8');
  gate({ 'tasks/helper.ts': 'export const x = 1;\n' });
  assert.equal(readFileSync(join(REPO_ROOT, BASELINE_REL), 'utf8'), before);
});

// ------------------------------------------------------------ import parsing
test('a reported line points at the import statement, not the line above it', () => {
  const edges = collectImports(
    ['// a header comment', '', "import { A } from './a';", '', "import './b';"].join('\n'),
  );
  assert.equal(edges.find((e) => e.specifier === './a').line, 3);
  assert.equal(edges.find((e) => e.specifier === './b').line, 5);

  const found = scan({
    'tasks/tasks.service.ts': [
      '// two lines of preamble',
      '',
      "import { boot } from '@/sandbox/sandbox.service';",
    ].join('\n'),
    'sandbox/sandbox.service.ts': 'export const boot = 1;\n',
  });
  assert.equal(kinds(found, 'cross-context-import')[0].line, 3);
});

test('import spellings the layer check depends on are all collected', () => {
  const edges = collectImports(
    [
      "import A from './a';",
      "import type { B } from './b';",
      "import * as c from './c';",
      "import './d';",
      "export { E } from './e';",
      "const f = await import('./f');",
      'const notAnImport = "from \'./g\'";',
    ].join('\n'),
  );
  const specifiers = edges.map((e) => e.specifier).sort();
  assert.deepEqual(specifiers, ['./a', './b', './c', './d', './e', './f']);
  assert.deepEqual(
    edges.find((e) => e.specifier === './b').names,
    ['B'],
  );
});

test('a dynamic import across contexts is caught like a static one', () => {
  const found = scan({
    'tasks/tasks.service.ts': "const s = await import('@/sandbox/sandbox.service');\n",
    'sandbox/sandbox.service.ts': 'export const boot = 1;\n',
  });
  assert.equal(kinds(found, 'cross-context-import').length, 1);
});
