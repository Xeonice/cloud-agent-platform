#!/usr/bin/env node
/**
 * Contracts shared-export gate.
 *
 * `packages/contracts` is the one package both the api and the console depend
 * on, and it is about to become a published npm package. The property that makes
 * it that package rather than a junk drawer is: **everything in it is shared.**
 * This fails the build on an export no consumer imports, naming each one.
 *
 * It exists because nothing else could see the failure. `turbo typecheck lint`,
 * the contracts suite, the package-boundary tests and
 * `provider-contract-parity-check.mjs` were all green on a tree with six dead
 * modules and thirteen types a consumer had re-declared locally. Three of those
 * six were dead precisely BECAUSE a consumer restated them — which is why the
 * ordering matters and is written into the change that added this gate: converge
 * first, re-measure, and only then delete. Deleting first ratifies the
 * duplication and the shape regrows under a third name.
 *
 * Two granularities, one scan:
 *   - EXPORTS   an exported name nothing can reach            → the gate
 *   - MODULES   a module no consumer can reach, even
 *               transitively through another contracts module → the measurement
 *
 * "Nothing can reach" is three rules, not one, and the difference is 364 versus
 * 8. A literal "no consumer imports it" flags 42% of this package, because two
 * things are alive without being imported:
 *
 *   1. COMPOSITION. `AvailableGithubRepoSchema` is not imported by anyone; it is
 *      what `ListAvailableGithubReposResponseSchema` is built from, and that IS
 *      imported. An export another export is made of is live.
 *   2. THE SCHEMA/TYPE PAIR. `export type X = z.infer<typeof XSchema>` is this
 *      package's documented pattern — "zod schemas plus the types inferred from
 *      them" — so `X` and `XSchema` are one unit. The api imports the schema to
 *      validate with and never names the type; deleting the type would leave the
 *      next consumer that wants it re-declaring it locally, which is the exact
 *      defect this gate exists to prevent.
 *
 * The only way to keep an export past all three is to list it in EXCEPTIONS with
 * a reason, so the exception is visible in review rather than invisible by
 * omission.
 *
 * Run: node scripts/contracts-shared-export-check.mjs [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONTRACTS_SRC = path.join(ROOT, 'packages/contracts/src');

/**
 * Exports that are deliberately unreachable.
 * Every entry needs a reason. An empty list is the healthy state.
 *
 * @type {ReadonlyArray<{ export: string, reason: string }>}
 */
const EXCEPTIONS = [
  // `notifications.ts` in full. Not dead scaffolding — the declaration side of a
  // requirement nobody has implemented yet:
  //
  //   agent-events-and-approvals — "Two-capability notification adapter port"
  //   "The system SHALL define a notification adapter port exposing two
  //    capabilities: `notify` for one-way push … and `request-decision` for a
  //    round-trip approval …"
  //
  // No adapter exists anywhere in the repository (a search for ntfy / Bark /
  // request-decision finds only these declarations), and no consumer re-declares
  // these shapes, so this is not the "converge before deleting" case. Deleting
  // them would delete the only part of that SHALL that exists today. They stay,
  // named here so the unmet requirement is visible rather than inferred from an
  // unreferenced file.
  { export: 'NotifyLevel', reason: 'agent-events-and-approvals SHALL, unimplemented' },
  { export: 'NotifyLevelSchema', reason: 'agent-events-and-approvals SHALL, unimplemented' },
  { export: 'NotifyPayload', reason: 'agent-events-and-approvals SHALL, unimplemented' },
  { export: 'NotifyPayloadSchema', reason: 'agent-events-and-approvals SHALL, unimplemented' },
  { export: 'RequestDecisionPayload', reason: 'agent-events-and-approvals SHALL, unimplemented' },
  { export: 'RequestDecisionPayloadSchema', reason: 'agent-events-and-approvals SHALL, unimplemented' },
  { export: 'NotificationCapability', reason: 'agent-events-and-approvals SHALL, unimplemented' },
  { export: 'NotificationCapabilitySchema', reason: 'agent-events-and-approvals SHALL, unimplemented' },

  // ── Restated by consumers as INLINE LITERALS ──────────────────────────────
  //
  // Not dead: the value is used everywhere, just not through the constant. The
  // name-based re-declaration audit that preceded this gate could not see this
  // class at all — there is no second *declaration* to match on, only a copied
  // string. Per design D3 the rule is converge first, never delete first, and
  // converging these is its own change: it touches auth handling across both
  // apps and is not what this one scoped.
  {
    export: 'OPERATOR_AUTH_SCHEME',
    reason: "value 'Bearer' inlined at ~30 consumer sites; converge before deleting (D3)",
  },
  {
    export: 'AUTH_TOKEN_ENV_VAR',
    reason: "value 'AUTH_TOKEN' read from process.env by name across both apps; converge before deleting (D3)",
  },
  {
    export: 'AUTH_TOKEN_PUBLIC_ENV_VAR',
    reason: "value 'NEXT_PUBLIC_AUTH_TOKEN' likewise; converge with its sibling (D3)",
  },
  {
    export: 'WS_AUTH_QUERY_PARAM',
    reason: "value 'token' inlined in WebSocket URL construction; converge before deleting (D3)",
  },
  {
    export: 'AuthTokenConfig',
    reason: 'the inferred type of the auth config the four constants above describe; moves with them',
  },
  {
    export: 'startsWithReservedPrefix',
    reason: 'apps/api/src/auth/operator-principal.test.mjs:116 reimplements it inline and :42 rebuilds RESERVED_CREDENTIAL_PREFIXES — a test that re-derives what it should import passes even when the contract changes; converge before deleting (D3)',
  },
  {
    export: 'ReservedCredentialPrefix',
    reason: 'the element type of RESERVED_CREDENTIAL_PREFIXES, which apps/api/src/main.ts:108 does import; the type moves with the helper above',
  },

  // ── Declared, and executed only by this package's own tests ───────────────
  //
  // Weaker than dead and weaker than shared. The gate reports the whole
  // test-only set on every run (35 exports today); these two are here because
  // they are ALSO unreachable from anywhere else, so without an entry they would
  // fail the build, and deleting them would remove stated intent rather than
  // dead weight.
  {
    export: 'TASK_PROVISIONING_PROGRESS_CAPABILITY',
    reason: 'the capability id for the rollout gate whose env-var sibling IS used, so the gate is read by env and never by name; unify the pair rather than delete the id',
  },
  {
    export: 'PublicRestErrorProjectorKind',
    reason: 'public-surface vocabulary with no consumer yet; belongs to the /v1 surface work, not to contracts convergence',
  },
];

/**
 * Modules every one of whose exports is excepted, so the module-level report
 * does not re-raise what the export-level exceptions already answered.
 */
const EXCEPTED_MODULES = new Set(['notifications']);

/** Directory names never descended into. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.vercel',
]);

/** Source extensions scanned for imports. */
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'];

/** The package name consumers import from. */
const PACKAGE = '@cap-console/contracts';

// ---------------------------------------------------------------------------

/** Every file under `dir` with a scanned extension. */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(abs, out);
    else if (SOURCE_EXTS.includes(path.extname(entry))) out.push(abs);
  }
  return out;
}

/**
 * Names a module exports.
 *
 * Deliberately source-text matching rather than a TypeScript program: the gate
 * has to run before anything is built, and the declaration forms in this package
 * are uniform (`export const|type|interface|function|class|enum NAME`) plus
 * `export { a, b as c }` re-export lists.
 */
export function readModuleExports(source) {
  const names = new Set();
  const declaration =
    /^export\s+(?:declare\s+)?(?:const|let|var|type|interface|function|async function|class|enum|abstract class)\s+([A-Za-z_$][\w$]*)/gmu;
  for (const match of source.matchAll(declaration)) names.add(match[1]);

  // `export { a, b as c }` — the exported name is what follows `as`, else the
  // local name. `export * from` carries no names of its own.
  const list = /^export\s*\{([^}]*)\}/gmu;
  for (const match of source.matchAll(list)) {
    for (const piece of match[1].split(',')) {
      const trimmed = piece.trim().replace(/^type\s+/u, '');
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/u);
      const name = (parts[1] ?? parts[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Names a source file imports from `@cap-console/contracts`.
 *
 * Returns `{ names, namespace }` — a namespace import (`import * as c from …`)
 * reaches every export, so it is reported separately rather than folded in as if
 * it named nothing.
 */
export function readContractImports(source, pkg = PACKAGE) {
  const names = new Set();
  let namespace = false;

  const from = String.raw`from\s*['"]${pkg.replace('/', '\\/')}['"]`;
  const braced = new RegExp(
    String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s*${from}`,
    'gu',
  );
  for (const match of source.matchAll(braced)) {
    for (const piece of match[1].split(',')) {
      const trimmed = piece.trim().replace(/^type\s+/u, '');
      if (!trimmed) continue;
      const local = trimmed.split(/\s+as\s+/u)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(local)) names.add(local);
    }
  }

  const star = new RegExp(String.raw`import\s+\*\s+as\s+[\w$]+\s*${from}`, 'u');
  if (star.test(source)) namespace = true;

  // `require('@cap-console/contracts')` destructuring, used by the .mjs suites.
  const required = new RegExp(
    String.raw`const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]${pkg.replace('/', '\\/')}['"]`,
    'gu',
  );
  for (const match of source.matchAll(required)) {
    for (const piece of match[1].split(',')) {
      const local = piece.trim().split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(local)) names.add(local);
    }
  }

  return { names, namespace };
}

/**
 * Whether `name` is referenced anywhere in the package other than by its own
 * declaration — i.e. whether some other export is built out of it.
 *
 * Comment lines are skipped: this package documents heavily, and a name that
 * appears only in prose is not a use. That distinction is load-bearing —
 * counting comments would make the gate green on a genuinely dead export whose
 * doc block mentions it.
 */
export function isComposedInto(name, owner, sources) {
  const declaration = new RegExp(
    `^export\\s+(?:declare\\s+)?(?:const|let|var|type|interface|function|async function|class|enum|abstract class)\\s+${name}\\b`,
    'u',
  );
  const reference = new RegExp(`\\b${name}\\b`, 'u');
  for (const [module, source] of sources) {
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith('*') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*')
      ) {
        continue;
      }
      if (module === owner && declaration.test(trimmed)) continue;
      if (reference.test(line)) return true;
    }
  }
  return false;
}

/** The other half of a schema/type pair: `X` ⇄ `XSchema`. */
export const pairedName = (name) =>
  name.endsWith('Schema') ? name.slice(0, -'Schema'.length) : `${name}Schema`;

/** Contracts modules a contracts module imports (relative `./x.js` specifiers). */
export function readIntraPackageImports(source) {
  const out = new Set();
  for (const match of source.matchAll(
    /from\s*['"]\.\/([\w.-]+)\.js['"]/gu,
  )) {
    out.add(match[1]);
  }
  return out;
}

/** Consumer roots: every workspace package that declares a dep on contracts. */
function consumerRoots() {
  const roots = [];
  for (const group of ['apps', 'packages']) {
    const base = path.join(ROOT, group);
    let entries;
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(base, entry);
      const manifest = path.join(dir, 'package.json');
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      } catch {
        continue;
      }
      if (pkg.name === PACKAGE) continue;
      const declares =
        pkg.dependencies?.[PACKAGE] ??
        pkg.devDependencies?.[PACKAGE] ??
        pkg.peerDependencies?.[PACKAGE];
      if (declares) roots.push(dir);
    }
  }
  return roots;
}

/** The full scan. */
export function scan() {
  // 1. contracts modules → their exports, and their intra-package imports.
  const moduleExports = new Map();
  const moduleImports = new Map();
  const sources = new Map();
  for (const file of readdirSync(CONTRACTS_SRC)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const name = file.replace(/\.ts$/u, '');
    if (name === 'index') continue;
    // `*.typecheck.ts` are compile-fail fixtures whose whole job is to NOT be
    // imported — they assert that a given misuse fails to compile. Counting one
    // as an unreachable module would report a fixture doing its job as a defect.
    if (name.endsWith('.typecheck')) continue;
    const source = readFileSync(path.join(CONTRACTS_SRC, file), 'utf8');
    moduleExports.set(name, readModuleExports(source));
    moduleImports.set(name, readIntraPackageImports(source));
    sources.set(name, source);
  }

  const owner = new Map();
  for (const [module, names] of moduleExports) {
    for (const name of names) if (!owner.has(name)) owner.set(name, module);
  }

  // 2. what consumers import.
  const imported = new Set();
  const namespaceImporters = [];
  const roots = consumerRoots();
  for (const root of roots) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(PACKAGE)) continue;
      const { names, namespace } = readContractImports(source);
      for (const name of names) imported.add(name);
      if (namespace) namespaceImporters.push(path.relative(ROOT, file));
    }
  }

  // 2b. This package's OWN tests, which `require('../dist/index.js')` rather
  //     than importing the package name — so the consumer walk above cannot see
  //     them, and neither can `isComposedInto`, which reads only `src/*.ts`.
  //
  //     That blind spot is not hypothetical: without this, the gate reported
  //     `ProvisioningSummarySchema` as unreachable while `task-provisioning.test.mjs`
  //     was calling it, and acting on that report broke the suite. An export used
  //     only from here is reported separately — it is not shared, but it is also
  //     not unreferenced, and the two need different answers.
  const consumerImported = new Set(imported);
  const testOnly = new Set();
  for (const file of walk(CONTRACTS_SRC)) {
    if (!file.endsWith('.test.mjs')) continue;
    const source = readFileSync(file, 'utf8');
    const destructured = /const\s*\{([\s\S]*?)\}\s*=\s*require\(/gu;
    for (const match of source.matchAll(destructured)) {
      for (const piece of match[1].split(',')) {
        const local = piece.trim().split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/u.test(local)) testOnly.add(local);
      }
    }
    for (const match of source.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*(?:dist|index)[^'"]*['"]/gu,
    )) {
      for (const piece of match[1].split(',')) {
        const local = piece.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/u.test(local)) testOnly.add(local);
      }
    }
  }
  for (const name of testOnly) imported.add(name);

  // 3. exports nothing can reach: not imported, not composed into another
  //    export, and whose schema/type twin is equally unreachable.
  const excepted = new Set(EXCEPTIONS.map((e) => e.export));
  const unimported = [...owner.keys()]
    .filter((name) => !imported.has(name) && !excepted.has(name))
    .sort();
  const composed = new Set(
    unimported.filter((name) => isComposedInto(name, owner.get(name), sources)),
  );
  const unimportedSet = new Set(unimported);
  /**
   * Whether an export is reachable. The pair rule only applies to a pair that
   * EXISTS — an earlier version asked this of `pairedName(x)` without checking
   * the twin was declared, and a name that does not exist is not in `unimported`,
   * so it read as reachable and vouched for its partner. Every export without a
   * twin was therefore waved through, which the task-4.4 probe caught: a
   * throwaway unimported export did not fail the gate.
   */
  const reachableExport = (name) =>
    owner.has(name) && (!unimportedSet.has(name) || composed.has(name));
  const dead = unimported
    .filter((name) => !composed.has(name))
    .filter((name) => !reachableExport(pairedName(name)));

  // 4. modules nobody can reach — directly, or through a reached module.
  const reached = new Set();
  const queue = [];
  for (const name of imported) {
    const module = owner.get(name);
    if (module && !reached.has(module)) {
      reached.add(module);
      queue.push(module);
    }
  }
  while (queue.length > 0) {
    const module = queue.pop();
    for (const next of moduleImports.get(module) ?? []) {
      if (moduleExports.has(next) && !reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  const unreachable = [...moduleExports.keys()]
    .filter((module) => !reached.has(module) && !EXCEPTED_MODULES.has(module))
    .sort();

  return {
    consumers: roots.map((r) => path.relative(ROOT, r)).sort(),
    modules: moduleExports.size,
    exports: owner.size,
    importedExports: [...owner.keys()].filter((n) => imported.has(n)).length,
    testOnly: [...owner.keys()]
      .filter((n) => testOnly.has(n) && !consumerImported.has(n))
      .sort(),
    unimported,
    composed: [...composed].sort(),
    dead,
    reachedModules: reached.size,
    unreachable,
    namespaceImporters,
    ownerOf: (name) => owner.get(name),
  };
}

function main() {
  const result = scan();

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          consumers: result.consumers,
          modules: result.modules,
          exports: result.exports,
          importedExports: result.importedExports,
          unimported: result.unimported,
          composed: result.composed,
          testOnly: result.testOnly,
          dead: result.dead,
          reachedModules: result.reachedModules,
          unreachable: result.unreachable,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `contracts-shared-export-check: ${result.exports} exports across ${result.modules} modules, ` +
      `${result.importedExports} imported by ${result.consumers.length} consumers, ` +
      `${result.composed.length} more reached by composition or their schema/type twin`,
  );
  if (result.testOnly.length > 0) {
    // Not a failure. Reported because "used only by this package's own tests"
    // and "shared" are different facts, and collapsing them is what let a
    // deletion look safe.
    console.log(
      `  ${result.testOnly.length} reachable ONLY from this package's own tests: ${result.testOnly.join(' · ')}`,
    );
  }
  if (result.unreachable.length > 0) {
    console.log(
      `  unreachable modules (${result.unreachable.length}): ${result.unreachable.join(' · ')}`,
    );
  }

  if (result.namespaceImporters.length > 0) {
    // A namespace import reaches every export, so it would make this gate
    // vacuous. Say so rather than reporting a clean sweep the method cannot
    // support.
    console.error(
      `\ncontracts-shared-export-check: ${result.namespaceImporters.length} file(s) import the package as a NAMESPACE,`,
    );
    console.error(
      'which reaches every export and makes this gate unable to see a dead one:',
    );
    for (const file of result.namespaceImporters) console.error(`  ${file}`);
    process.exitCode = 1;
    return;
  }

  if (result.dead.length === 0) {
    console.log('  every export is reachable');
    return;
  }

  console.error(
    `\ncontracts-shared-export-check: ${result.dead.length} export(s) nothing can reach:\n`,
  );
  for (const name of result.dead) {
    console.error(`  ${name}  (packages/contracts/src/${result.ownerOf(name)}.ts)`);
  }
  console.error(
    '\nAn export nothing imports is not shared, and this package is defined by being shared.',
  );
  console.error(
    'Either a consumer re-declared it locally — converge that first, never delete first —',
  );
  console.error(
    'or it is genuinely dead and should go. If it must stay, add it to EXCEPTIONS with a reason.',
  );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
