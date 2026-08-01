#!/usr/bin/env node
/**
 * Context layout gate, v2 — the DDD-boundary report.
 *
 * v1 (`scripts/api-module-layout-check.mjs`) enforces two package-mechanical
 * rules: alias imports and acyclic directories. It is untouched by this script
 * and keeps running on its own CI step. v2 is a SEPARATE, parallel gate asking
 * the architectural questions v1 cannot: does an import cross a bounded context
 * in a legal form, does it point the wrong way through the layers, and does
 * Prisma appear outside the store layer.
 *
 * EVERY rule this script applies is DATA, read from
 * `docs/refactor/contexts-manifest.json` (工件01):
 *
 *   - `contexts[*].directories`      — which top-level directory belongs to
 *                                      which bounded context;
 *   - `layers.fileClassification`    — the file→layer mapping (the ONLY
 *                                      declaration; this script holds no copy);
 *   - `layers.allowedImports`        — which layer may import which layer;
 *   - `crossContextRules.machineReadable` — port suffix, DI-composition
 *                                      exemption, shared-kernel directories,
 *                                      and the domain-event-subscription
 *                                      ATTRIBUTION block (it names the bus
 *                                      directory and its port file so a
 *                                      subscriber's cross-context import is
 *                                      scored as a domain-event subscription
 *                                      instead of guessed at — it grants no
 *                                      legal form the port suffix did not
 *                                      already grant, and the gate asserts
 *                                      that);
 *   - `prismaPlacement`              — store-file suffix, Prisma symbols,
 *                                      exempt directories.
 *
 * There is no fallback: a missing manifest, a missing declaration block, a
 * scope that resolves to zero source files, or a directory under the scope that
 * no context claims is a gate FAILURE, never a silent pass — each of those is a
 * way for a check class to switch itself off and still print green. Adding a
 * rule means editing the manifest, which the manifest's own `$comment` binds to
 * an OpenSpec change.
 *
 * Three finding classes plus the classification escape hatch:
 *
 *   cross-context-import  — a governed file imports another context's internals
 *                           in a form `crossContextRules` does not allow;
 *   layer-direction       — an intra-context import runs against
 *                           `layers.allowedImports`;
 *   prisma-outside-store  — `@prisma/client` / `PrismaService` reached from a
 *                           file that is not `*.store.ts` and not shared kernel;
 *   unclassified-file     — a governed file matching no file→layer rule. It is
 *                           REPORTED, never silently skipped: an unclassified
 *                           file is a file whose layer direction nobody can
 *                           judge, so it is debt like any other finding.
 *
 * REPORT MODE (阶段3): the measured counts are compared against the committed
 * baseline `scripts/ratchets/r7.json` through the shared comparator — imported,
 * never re-implemented. Within baseline the gate exits zero and prints the
 * per-class counts; above baseline (or below it — a stale entry) it exits
 * non-zero. 阶段6 flips this same script to blocking by burning the baseline
 * down to nothing and deleting the file.
 *
 * Run (canon pairing): node scripts/context-layout-check-v2.mjs
 *                   && node --test scripts/context-layout-check-v2.test.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { compareToBaseline, readBaseline } from './ratchets/comparator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 工件01, the single declaration of contexts, layers and legal import forms. */
export const MANIFEST_REL = 'docs/refactor/contexts-manifest.json';

/** The committed ratchet baseline this gate owns (R7). */
export const BASELINE_REL = 'scripts/ratchets/r7.json';

/** The four finding classes, in report order. */
export const FINDING_KINDS = Object.freeze([
  'cross-context-import',
  'layer-direction',
  'prisma-outside-store',
  'unclassified-file',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

function isTestFile(name) {
  return /\.(test|spec)\.[a-z]+$/.test(name) || name.endsWith('.typecheck.ts');
}

/**
 * Reads and validates the manifest. Fail-closed: every block this gate
 * interprets must be present and non-empty, because a missing block would
 * silently switch a whole check class off.
 *
 * @param {string} root repository root
 * @returns {object} parsed manifest
 */
export function loadManifest(root = ROOT) {
  const abs = path.join(root, MANIFEST_REL);
  if (!existsSync(abs)) {
    throw new Error(
      `contexts manifest missing: ${MANIFEST_REL} — this gate is a pure interpreter and has no built-in rule copy`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (error) {
    throw new Error(`${MANIFEST_REL}: not valid JSON — ${error.message}`);
  }
  assertManifestShape(manifest);
  return manifest;
}

/**
 * Names every declaration block the gate consumes, so a manifest edit that
 * drops one fails loudly instead of disabling a check.
 *
 * @param {unknown} manifest
 */
export function assertManifestShape(manifest) {
  const missing = [];
  const need = (ok, what) => {
    if (!ok) missing.push(what);
  };
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

  need(isObject(manifest), 'manifest must be a JSON object');
  if (!isObject(manifest)) throw new Error(`${MANIFEST_REL}: ${missing.join('; ')}`);

  need(typeof manifest.scope === 'string' && manifest.scope.trim() !== '', '`scope`');
  need(
    typeof manifest.scopeAlias === 'string' && manifest.scopeAlias.trim() !== '',
    '`scopeAlias`',
  );
  need(
    isObject(manifest.contexts) && Object.keys(manifest.contexts).length > 0,
    '`contexts` (non-empty)',
  );
  const layers = isObject(manifest.layers) ? manifest.layers : null;
  need(layers !== null, '`layers`');
  need(Array.isArray(layers?.order) && layers.order.length > 0, '`layers.order`');
  need(isObject(layers?.allowedImports), '`layers.allowedImports`');
  const classification = isObject(layers?.fileClassification)
    ? layers.fileClassification
    : null;
  need(classification !== null, '`layers.fileClassification`');
  need(
    Array.isArray(classification?.rules) && classification.rules.length > 0,
    '`layers.fileClassification.rules` (non-empty)',
  );
  need(
    typeof classification?.unclassifiedLayer === 'string',
    '`layers.fileClassification.unclassifiedLayer`',
  );
  need(
    typeof classification?.compositionLayer === 'string',
    '`layers.fileClassification.compositionLayer`',
  );
  const cross = isObject(manifest.crossContextRules?.machineReadable)
    ? manifest.crossContextRules.machineReadable
    : null;
  need(cross !== null, '`crossContextRules.machineReadable`');
  need(typeof cross?.portFileSuffix === 'string', '`crossContextRules.machineReadable.portFileSuffix`');
  need(
    typeof cross?.compositionFileSuffix === 'string',
    '`crossContextRules.machineReadable.compositionFileSuffix`',
  );
  need(
    Array.isArray(cross?.compositionRootFiles),
    '`crossContextRules.machineReadable.compositionRootFiles`',
  );
  need(
    Array.isArray(cross?.sharedKernelDirectories),
    '`crossContextRules.machineReadable.sharedKernelDirectories`',
  );
  const subscription = isObject(cross?.domainEventSubscription)
    ? cross.domainEventSubscription
    : null;
  need(
    subscription !== null,
    '`crossContextRules.machineReadable.domainEventSubscription`',
  );
  need(
    typeof subscription?.busDirectory === 'string' &&
      subscription.busDirectory.trim() !== '',
    '`crossContextRules.machineReadable.domainEventSubscription.busDirectory`',
  );
  need(
    Array.isArray(subscription?.busPortFiles) && subscription.busPortFiles.length > 0,
    '`crossContextRules.machineReadable.domainEventSubscription.busPortFiles` (non-empty)',
  );
  const prisma = isObject(manifest.prismaPlacement) ? manifest.prismaPlacement : null;
  need(prisma !== null, '`prismaPlacement`');
  need(typeof prisma?.storeFileSuffix === 'string', '`prismaPlacement.storeFileSuffix`');
  need(
    Array.isArray(prisma?.symbols) && prisma.symbols.length > 0,
    '`prismaPlacement.symbols` (non-empty)',
  );
  need(Array.isArray(prisma?.exemptDirectories), '`prismaPlacement.exemptDirectories`');

  if (missing.length > 0) {
    throw new Error(
      `${MANIFEST_REL}: missing declaration(s) ${missing.join(', ')} — ` +
        'the gate refuses to run with a check class silently switched off',
    );
  }

  // The domain-event-subscription block is ATTRIBUTION, never permission: each
  // bus port file it names must already be legal under the port-suffix rule, so
  // declaring them widens nothing. A bus whose entry point needed a new legal
  // form would be a placement error to fix at the bus, not a reason to loosen
  // the manifest.
  const widened = manifest.crossContextRules.machineReadable.domainEventSubscription.busPortFiles.filter(
    (file) =>
      typeof file !== 'string' ||
      !file.endsWith(manifest.crossContextRules.machineReadable.portFileSuffix),
  );
  if (widened.length > 0) {
    throw new Error(
      `${MANIFEST_REL}: domainEventSubscription.busPortFiles must each end with ` +
        `'${manifest.crossContextRules.machineReadable.portFileSuffix}' — the encoding attributes a form, ` +
        `it never grants one; offending: ${widened.join(', ')}`,
    );
  }
}

/** Every non-test `.ts`/`.tsx` file under a directory, scope-relative. */
export function sourceFiles(absDir, rel = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(abs, relPath));
    } else if (/\.tsx?$/.test(entry.name) && !isTestFile(entry.name)) {
      out.push({ abs, rel: relPath });
    }
  }
  return out;
}

/**
 * Applies the manifest's file→layer rules — first matching suffix wins, in
 * declared order. Returns the manifest's `unclassifiedLayer` when nothing
 * matches; the caller reports that, it is never a skip.
 *
 * @param {string} scopeRel path relative to the manifest scope
 * @param {object} manifest
 * @returns {string} layer name
 */
export function classifyLayer(scopeRel, manifest) {
  const { rules, unclassifiedLayer } = manifest.layers.fileClassification;
  const probe = `/${scopeRel}`;
  for (const rule of rules) {
    if (probe.endsWith(rule.suffix)) return rule.layer;
  }
  return unclassifiedLayer;
}

/**
 * Import edges of a TypeScript source, without executing or type-checking it:
 * static `import`/`export ... from`, side-effect imports, and dynamic
 * `import('…')`. Imported names are captured so `PrismaService` is visible
 * regardless of which module it is pulled from.
 *
 * @param {string} source
 * @returns {Array<{ specifier: string, names: string[], line: number }>}
 */
export function collectImports(source) {
  const found = [];
  // The statement patterns anchor on the PRECEDING newline, so a match that
  // starts with one begins on the next line — counting from `m.index` itself
  // would report every import one line early.
  const at = (match) =>
    source.slice(0, match.index + (match[0].startsWith('\n') ? 1 : 0)).split('\n').length;
  const names = (clause) =>
    (clause ?? '')
      .replace(/^type\s+/, '')
      .replace(/[{}]/g, ' ')
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter((part) => part !== '' && part !== '*' && /^[A-Za-z_$][\w$]*$/.test(part));

  for (const m of source.matchAll(
    /(?:^|\n)[ \t]*(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    found.push({ specifier: m[2], names: names(m[1]), line: at(m) });
  }
  for (const m of source.matchAll(/(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g)) {
    found.push({ specifier: m[1], names: [], line: at(m) });
  }
  for (const m of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ specifier: m[1], names: [], line: at(m) });
  }
  return found;
}

/** top-level directory of a scope-relative path (`''` for a scope-root file). */
function topDir(scopeRel) {
  const parts = scopeRel.split('/');
  return parts.length > 1 ? parts[0] : '';
}

/**
 * Resolves an import specifier to a governed file (scope-relative), or null
 * when it points outside the manifest scope (a package, a node builtin, an
 * asset). Only governed→governed edges carry context/layer verdicts.
 */
function resolveGoverned(specifier, fromScopeRel, alias, governedSet) {
  let target = null;
  if (specifier.startsWith(alias)) {
    target = specifier.slice(alias.length);
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    target = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromScopeRel), specifier),
    );
    if (target.startsWith('..')) return null;
  } else {
    return null;
  }
  for (const candidate of [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}/index.ts`,
    `${target}/index.tsx`,
  ]) {
    if (governedSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The whole analysis: classify every governed file, then judge every governed
 * import edge. Returns findings plus the scan census — zero scanned files is
 * the caller's failure signal (an empty scan must never read as green) — and
 * the directories the manifest maps to no context, which are the other way this
 * gate could go quietly blind.
 *
 * @param {{root?: string, manifest?: object}} options
 * @returns {{ scanned: number, findings: Array<{kind: string, file: string, detail: string, line?: number}>, counts: Record<string, number>, unmappedDirectories: string[] }}
 */
export function analyzeLayout({ root = ROOT, manifest = loadManifest(root) } = {}) {
  assertManifestShape(manifest);

  const scopeAbs = path.join(root, manifest.scope);
  let scopeIsDir = false;
  try {
    scopeIsDir = statSync(scopeAbs).isDirectory();
  } catch {
    scopeIsDir = false;
  }
  const files = scopeIsDir ? sourceFiles(scopeAbs) : [];
  const findings = [];

  const alias = manifest.scopeAlias;
  const { compositionLayer, unclassifiedLayer } = manifest.layers.fileClassification;
  const allowedImports = manifest.layers.allowedImports;
  const cross = manifest.crossContextRules.machineReadable;
  const prismaRules = manifest.prismaPlacement;

  /** top-level directory → context name */
  const contextOf = new Map();
  for (const [name, context] of Object.entries(manifest.contexts)) {
    for (const dir of context.directories ?? []) contextOf.set(dir, name);
  }
  const sharedKernel = new Set(cross.sharedKernelDirectories);
  const busDirectory = cross.domainEventSubscription.busDirectory;
  const busPortFiles = cross.domainEventSubscription.busPortFiles;
  const compositionRoots = new Set(cross.compositionRootFiles);
  const prismaExempt = new Set(prismaRules.exemptDirectories);

  // A directory nobody claims has no context to cross, so every cross-context
  // verdict about it would be a silent pass. The manifest owns the mapping;
  // this is the gate refusing to grade an unmapped directory.
  const unmappedDirectories = [
    ...new Set(
      files
        .map((file) => topDir(file.rel))
        .filter((dir) => dir !== '' && !contextOf.has(dir)),
    ),
  ].sort();

  const governedSet = new Set(files.map((f) => f.rel));
  const layerOf = new Map();
  for (const file of files) {
    const layer = classifyLayer(file.rel, manifest);
    layerOf.set(file.rel, layer);
    if (layer === unclassifiedLayer) {
      findings.push({
        kind: 'unclassified-file',
        file: `${manifest.scope}/${file.rel}`,
        detail:
          'matches no file→layer rule in the manifest — its layer direction cannot be judged; ' +
          'name it by its role or declare the rule in contexts-manifest.json',
      });
    }
  }

  for (const file of files) {
    let source;
    try {
      source = readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    const rel = file.rel;
    const shown = `${manifest.scope}/${rel}`;
    const dir = topDir(rel);
    const ownContext = contextOf.get(dir) ?? null;
    const ownLayer = layerOf.get(rel);
    const isComposition =
      ownLayer === compositionLayer ||
      rel.endsWith(cross.compositionFileSuffix) ||
      compositionRoots.has(rel);
    const isStoreFile = rel.endsWith(prismaRules.storeFileSuffix);
    const prismaExemptFile = isStoreFile || prismaExempt.has(dir);

    for (const edge of collectImports(source)) {
      // (3) Prisma placement — judged on the specifier/symbol, so a Prisma
      // reach from a package import is caught the same as a local one.
      if (!prismaExemptFile) {
        const hit = prismaRules.symbols.find(
          (symbol) => edge.specifier === symbol || edge.names.includes(symbol),
        );
        if (hit) {
          findings.push({
            kind: 'prisma-outside-store',
            file: shown,
            line: edge.line,
            detail: `reaches '${hit}' outside a '${prismaRules.storeFileSuffix}' file (and outside the declared shared kernel)`,
          });
        }
      }

      const target = resolveGoverned(edge.specifier, rel, alias, governedSet);
      if (target === null || target === rel) continue;
      const targetDir = topDir(target);
      const targetContext = contextOf.get(targetDir) ?? null;

      if (ownContext !== null && targetContext !== null && ownContext !== targetContext) {
        // (1) cross-context — legal forms come from the manifest, nothing else.
        const legal =
          target.endsWith(cross.portFileSuffix) ||
          isComposition ||
          sharedKernel.has(targetDir);
        if (!legal) {
          const legalForms = `a '${cross.portFileSuffix}' interface, DI composition, or the shared kernel`;
          // Attribution, not permission: an illegal reach INTO the declared bus
          // directory is a domain-event subscription that bypassed the bus
          // port, and saying so is what the reserved manifest slot buys. The
          // legal set is unchanged either way.
          findings.push({
            kind: 'cross-context-import',
            file: shown,
            line: edge.line,
            detail:
              targetDir === busDirectory
                ? `imports '${edge.specifier}' — a domain-event subscription reaching '${targetContext}' past the declared bus port(s) ${busPortFiles.join(', ')}; legal forms are still ${legalForms}`
                : `imports '${edge.specifier}' — context '${ownContext}' reaching into '${targetContext}' internals; legal forms are ${legalForms}`,
          });
        }
        continue;
      }

      // (2) layer direction — an intra-context concern, per the manifest.
      if (isComposition) continue;
      const targetLayer = layerOf.get(target);
      if (targetLayer === compositionLayer) continue;
      // An unclassified endpoint has no layer to compare, so the direction
      // verdict is DEFERRED, not dropped: the file is already carrying an
      // `unclassified-file` finding of its own, and classifying it is what
      // makes its edges judgeable.
      if (ownLayer === unclassifiedLayer || targetLayer === unclassifiedLayer) continue;
      const allowed = allowedImports[ownLayer] ?? [];
      if (!allowed.includes(targetLayer)) {
        findings.push({
          kind: 'layer-direction',
          file: shown,
          line: edge.line,
          detail: `'${ownLayer}' imports '${edge.specifier}' which is '${targetLayer}'; ${ownLayer} may import ${allowed.length > 0 ? allowed.join(', ') : 'nothing'}`,
        });
      }
    }
  }

  const counts = Object.fromEntries(FINDING_KINDS.map((kind) => [kind, 0]));
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;

  return { scanned: files.length, findings, counts, unmappedDirectories };
}

/**
 * The measurement handed to the shared comparator, keyed `<kind>:<file>`.
 *
 * Per-file-per-class keys, not per-class totals: a total would let a fix in one
 * file silently pay for a new violation in another, and the comparator could
 * only ever say "the count went up" instead of naming the file. The key carries
 * the class as well as the path because one file can owe debt in two classes
 * independently.
 *
 * @param {Array<{kind: string, file: string}>} findings
 * @returns {Record<string, number>}
 */
export function measurementFrom(findings) {
  const measured = {};
  for (const finding of findings) {
    const key = entryKey(finding);
    measured[key] = (measured[key] ?? 0) + 1;
  }
  return measured;
}

/** The baseline entry key a finding belongs to. */
export function entryKey(finding) {
  return `${finding.kind}:${finding.file}`;
}

/**
 * Runs the gate end to end and reports what a process exit would be, so the
 * paired self-test can prove the red paths without spawning processes.
 *
 * @param {{root?: string, manifest?: object, baselinePath?: string}} options
 * @returns {{ exitCode: number, output: string[], problems: string[], findings: Array<object>, counts: Record<string, number>, scanned: number }}
 */
export function runGate({ root = ROOT, manifest, baselinePath } = {}) {
  const output = [];
  let loaded;
  try {
    loaded = manifest ?? loadManifest(root);
    assertManifestShape(loaded);
  } catch (error) {
    return {
      exitCode: 1,
      output,
      problems: [error.message],
      findings: [],
      counts: {},
      scanned: 0,
    };
  }

  const { scanned, findings, counts, unmappedDirectories } = analyzeLayout({
    root,
    manifest: loaded,
  });
  if (scanned === 0) {
    return {
      exitCode: 1,
      output,
      problems: [
        `empty scan — '${loaded.scope}' resolved to zero source files; a gate that measures nothing is not green, it is blind`,
      ],
      findings,
      counts,
      scanned,
    };
  }

  if (unmappedDirectories.length > 0) {
    return {
      exitCode: 1,
      output,
      problems: unmappedDirectories.map(
        (dir) =>
          `${loaded.scope}/${dir}: belongs to no context in the manifest — every cross-context verdict about it would be a silent pass; declare it in contexts-manifest.json`,
      ),
      findings,
      counts,
      scanned,
    };
  }

  output.push(`context-layout-v2: scanned ${scanned} file(s) under ${loaded.scope}`);
  for (const kind of FINDING_KINDS) output.push(`  ${kind}: ${counts[kind] ?? 0}`);

  const baselineAbs = baselinePath ?? path.join(root, BASELINE_REL);
  const measured = measurementFrom(findings);
  let problems;
  if (existsSync(baselineAbs)) {
    let baseline;
    try {
      baseline = readBaseline(baselineAbs);
    } catch (error) {
      return {
        exitCode: 1,
        output,
        problems: [`${path.relative(root, baselineAbs)}: not valid JSON — ${error.message}`],
        findings,
        counts,
        scanned,
      };
    }
    problems = compareToBaseline(measured, baseline);
  } else {
    problems = Object.entries(measured).map(
      ([key, count]) =>
        `${key}: ${count} measured violation(s) with no baseline file — add ${BASELINE_REL} or fix them`,
    );
  }

  return { exitCode: problems.length > 0 ? 1 : 0, output, problems, findings, counts, scanned };
}

function main() {
  const result = runGate();
  for (const line of result.output) console.log(line);
  if (result.problems.length === 0) {
    console.log(
      'context-layout-v2: every class within its committed baseline (report mode — 阶段6 flips this to blocking)',
    );
    return;
  }
  console.error(`\ncontext-layout-v2: ${result.problems.length} problem(s):\n`);
  for (const problem of result.problems) console.error(`  ${problem}`);
  // Only the findings the problems actually name — the tolerated 存量 is
  // already accounted for and printing all of it would bury the new violation.
  const named = result.findings.filter((finding) =>
    result.problems.some((problem) => problem.startsWith(`${entryKey(finding)}: `)),
  );
  if (named.length > 0) {
    console.error('\nthe findings behind those problems:\n');
    for (const finding of named) {
      const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`  [${finding.kind}] ${where}`);
      console.error(`    ${finding.detail}`);
    }
  }
  console.error(
    `\nThe rules live in ${MANIFEST_REL} and the tolerated debt in ${BASELINE_REL} —`,
  );
  console.error(
    'change either one in an OpenSpec change, and shrink the baseline in the same PR as the fix.',
  );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
