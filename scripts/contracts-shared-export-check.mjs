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
  //
  // `NotifyLevel` / `NotifyLevelSchema` were listed here too and are not, because
  // `NotifyPayloadSchema` is composed from them. An exception nothing needs reads
  // as a finding that was adjudicated when it never arose.
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
    export: 'WS_AUTH_QUERY_PARAM',
    reason: "value 'token' inlined in WebSocket URL construction; converge before deleting (D3)",
  },
  {
    export: 'AuthTokenConfig',
    reason: 'the inferred type of the auth config the three constants above describe; moves with them',
  },
  // `startsWithReservedPrefix` stood here, kept on the stated ground that
  // "apps/api/src/auth/operator-principal.test.mjs:116 reimplements it inline".
  // The reason was FALSE, and false about a file the scan could not see:
  // `scripts/legacy-token-prefix-collision.test.mjs:18` imports it properly from
  // `packages/contracts/dist/credential-prefix.js`. Once `scripts/` joined the
  // consumer walk the export stopped being unreachable and the exception stopped
  // being needed. Removed rather than reworded — the reason is the whole content
  // of an exception, and one that measurement contradicts is not a weaker
  // exception, it is not one.
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

  // ── Path-param schemas the routes deliberately do not enforce ─────────────
  //
  // Each is `{ id: z.string().uuid() }` for a route that takes `@Param('id')` as
  // a raw string. Wiring them in is a one-liner and would be WRONG: today a
  // malformed id falls through to a lookup that finds nothing and answers 404,
  // identical to a well-formed id for a row that does not exist. Validating the
  // param would make the two distinguishable — a 400 for "malformed" against a
  // 404 for "absent" — which is strictly more information to an enumerating
  // caller than the routes give now. The declaration is a description of the id
  // space, not a rule the boundary is meant to apply.
  { export: 'AdminAccountParams', reason: 'path-param shape; route answers by lookup, see above' },
  { export: 'AdminAccountParamsSchema', reason: 'path-param shape; route answers by lookup, see above' },
  { export: 'ApiKeyRevokeParams', reason: 'path-param shape; route answers by lookup, see above' },
  { export: 'ApiKeyRevokeParamsSchema', reason: 'path-param shape; route answers by lookup, see above' },
  { export: 'McpTokenRevokeParams', reason: 'path-param shape; route answers by lookup, see above' },
  { export: 'McpTokenRevokeParamsSchema', reason: 'path-param shape; route answers by lookup, see above' },

  // ── The inline-literal class, which this change scopes OUT ────────────────
  //
  // Same shape as `OPERATOR_AUTH_SCHEME` above: the value is used, the constant
  // is not. Converging them is the follow-up change, and deleting them now would
  // ratify the restatement, which design D3 forbids.
  {
    export: 'IdentityProvider',
    reason: "value 'password' written as a literal at admin-seed.service.ts:274/298/300 and as a LOCAL constant PASSWORD_IDENTITY_PROVIDER at password.service.ts:77; converge before deleting (D3)",
  },
  {
    export: 'IdentityProviderSchema',
    reason: 'moves with IdentityProvider',
  },
  {
    export: 'TaskFailureAction',
    reason: "apps/web/src/components/runtime-credential-alert.tsx:13,20 compares against the literal 'reconnect_runtime' rather than the enum; converge before deleting (D3)",
  },
  {
    export: 'TaskFailureActionSchema',
    reason: 'moves with TaskFailureAction',
  },

  // ── A shape declared for a rollout that has not happened ──────────────────
  {
    export: 'TaskProvisioningDiagnosticExpectation',
    reason: 'pins `schemaVersion` + `nextAttempt` for a diagnostics-expectation exchange nothing implements; it is the declaration half of unbuilt work, like notifications.ts above',
  },
  {
    export: 'TaskProvisioningDiagnosticExpectationSchema',
    reason: 'moves with TaskProvisioningDiagnosticExpectation',
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
 * Remove `//` and block comments so a documented example is not read as code.
 *
 * Deliberately simple: it does not track string literals, so a `//` inside a
 * string is treated as a comment. That direction is safe here — the worst case
 * is that an import written after such a string is missed, which reports an
 * export dead and gets adjudicated, rather than silently marking one live.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
    .join('\n');
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
  // Prose is not code. `isComposedInto` has always skipped comments; this did
  // not, and the omission bit immediately once `scripts/` joined the walk — the
  // paragraph in THIS file explaining namespace imports contains one as an
  // example, and the gate read its own explanation as a real import and reported
  // itself as the offender.
  source = stripComments(source);

  // Two ways in, and the second is why this takes a pattern rather than a
  // literal: the package name, and a relative path into the built package.
  // Repository scripts use the latter (`'../packages/contracts/dist/credential-prefix.js'`)
  // because they run without the workspace resolution an app gets, and a scan
  // that matched only the package name reported their imports as non-existent.
  const specifier = String.raw`(?:${pkg.replace('/', '\\/')}|[^'"]*packages\/contracts\/dist\/[^'"]*)`;
  const from = String.raw`from\s*['"]${specifier}['"]`;
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
    String.raw`const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]${specifier}['"]`,
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

/** The other half of a schema/type pair: `X` ⇄ `XSchema`. */
export const pairedName = (name) =>
  name.endsWith('Schema') ? name.slice(0, -'Schema'.length) : `${name}Schema`;

/** Matches a top-level declaration, exported or not. */
const DECLARATION_LINE =
  /^(?:export\s+)?(?:declare\s+)?(?:const|let|var|type|interface|function|async function|class|enum|abstract class)\s+([A-Za-z_$][\w$]*)/u;

/**
 * Split a module into its top-level declaration blocks.
 *
 * Block-level, not line-level, and that is the whole point. A schema/type pair is
 * routinely written across three lines —
 *
 *     export type AdminCreateAccountRequest = z.infer<
 *       typeof AdminCreateAccountRequestSchema
 *     >;
 *
 * — so the reference sits on a CONTINUATION line, not on the declaration line.
 * A scan that skipped only the declaration line still saw the continuation and
 * counted the pair as composition.
 *
 * Lines before the first declaration (imports, the file's doc block) are dropped:
 * an import is not composition, and neither is prose.
 */
export function readDeclarationBlocks(source) {
  const blocks = [];
  let current = null;
  for (const line of source.split('\n')) {
    const match = DECLARATION_LINE.exec(line);
    if (match) {
      current = { name: match[1], lines: [line] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return blocks;
}

/**
 * Whether some OTHER export is built out of `name` — i.e. whether `name` is
 * composed into something rather than merely mentioned.
 *
 * Two things deliberately do not count:
 *
 *   - **Its own declaration**, obviously.
 *   - **Its schema/type twin's declaration.** `export type X = z.infer<typeof XSchema>`
 *     is the PAIR, not a use of it. Counting it made every schema in this package
 *     that has an inferred type read as composed, which meant the pair rule below
 *     was never reached and the gate silently stopped checking the commonest
 *     declaration form in the package. A probe pair that nothing anywhere used
 *     passed with exit 0.
 *
 * Comment lines are skipped too: this package documents heavily, and a name that
 * appears only in prose is not a use. Counting comments would keep a genuinely
 * dead export alive forever on the strength of its own doc block.
 */
export function isComposedInto(name, owner, sources) {
  const twin = pairedName(name);
  const reference = new RegExp(`\\b${name}\\b`, 'u');
  for (const [module, source] of sources) {
    for (const block of readDeclarationBlocks(source)) {
      if (module === owner && (block.name === name || block.name === twin)) {
        continue;
      }
      for (const line of block.lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('*') ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('/*')
        ) {
          continue;
        }
        if (reference.test(line)) return true;
      }
    }
  }
  return false;
}

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

/**
 * Directories that import the contracts package WITHOUT being a workspace
 * package — repository-level tooling, whose dependency comes from the root
 * manifest rather than one of its own.
 *
 * Sixteen files under `scripts/` reference contracts, several of them importing
 * a deep `dist/` path. Nothing here declares a manifest dependency, so the walk
 * below could not see any of it — and the consequence was not hypothetical: this
 * gate shipped carrying an exception that kept `startsWithReservedPrefix` on the
 * stated ground that "a test reimplements it inline", while
 * `scripts/legacy-token-prefix-collision.test.mjs:18` imports it properly from
 * `packages/contracts/dist/credential-prefix.js`. The reason was falsified by a
 * file the scan was structurally unable to look at.
 *
 * Same shape as `test-discovery-check.mjs`'s `REPOSITORY_TEST_DIRS`, which exists
 * because the identical blind spot bit the identical way there.
 */
const REPOSITORY_CONSUMER_DIRS = ['scripts'];

/**
 * Files inside those directories whose import-looking text is NOT an import.
 *
 * This gate's own test file builds fixtures out of import statements —
 * `'import * as contracts from "@cap-console/contracts";'` is a string it hands
 * to `readContractImports` to prove namespace detection works. Once `scripts/`
 * joined the consumer walk, the gate read its own examples as real imports and
 * reported itself as a namespace importer, which by its own rule makes it
 * unable to see a dead export.
 *
 * A text scan cannot distinguish a fixture from an import, and any file that
 * tests import scanning will contain both. So the exclusion is by name, with the
 * reason attached, rather than by a heuristic that would also drop
 * `legacy-token-prefix-collision.test.mjs` — whose imports are real, and finding
 * them is why `scripts/` was added.
 */
const NOT_REALLY_IMPORTS = new Set([
  'scripts/contracts-shared-export-check.test.mjs',
]);

/** Consumer roots: every workspace package that declares a dep on contracts. */
function consumerRoots() {
  const roots = REPOSITORY_CONSUMER_DIRS.map((dir) => path.join(ROOT, dir));
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
      if (NOT_REALLY_IMPORTS.has(path.relative(ROOT, file))) continue;
      const source = readFileSync(file, 'utf8');
      // Either way in — the package name, or a relative path into its build.
      if (
        !source.includes(PACKAGE) &&
        !source.includes('packages/contracts/dist')
      ) {
        continue;
      }
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
