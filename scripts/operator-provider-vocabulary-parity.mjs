#!/usr/bin/env node
/**
 * R8 — operator provider vocabulary parity gate.
 *
 * The operator vocabulary (`CONFIGURED_SANDBOX_PROVIDER_FAMILIES`, what a
 * deployment may write into `CAP_SANDBOX_PROVIDER`) is a DELIBERATE independent
 * declaration, not a derivation from the selectable provider families — the
 * recorded D14 ruling: `auto` and `control-plane` are operator selections that
 * are not provider families. Independence without reconciliation is how
 * `cloud-http` spent months selectable-but-unnameable, so this gate holds the
 * two ends together mechanically:
 *
 *   1. **Every selectable family is nameable.** The operator vocabulary must be
 *      a superset of the selectable provider-family vocabulary
 *      (`SANDBOX_PROVIDER_FAMILIES`) union the two operator-only selections
 *      `{auto, control-plane}`. A family that becomes selectable while the
 *      operator cannot spell it turns this gate red naming the missing member.
 *   2. **The terminal-story vocabulary cannot drift.** The fifth provider
 *      vocabulary, `SandboxTerminalStoryProvider`, is a deliberate SUBSET of
 *      the operator vocabulary (terminal stories exist only for families that
 *      have one). A member there that the operator vocabulary does not know is
 *      a violation naming the stray member.
 *
 * Like the other parity gates, the declarations this runs against are
 * DISCOVERED, never hand-maintained: the walk is recursive over the workspace
 * with no path list, so a file move cannot silently drop a vocabulary — and a
 * scan that finds ZERO declarations for any role exits non-zero instead of
 * passing on an empty set. No new analysis tool is involved; this follows the
 * `provider-contract-parity-check.mjs` canon.
 *
 * Run: node scripts/operator-provider-vocabulary-parity.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Directory names never descended into while discovering declarations. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  '.turbo',
  'coverage',
]);

/**
 * Operator-only selections that are NOT provider families (the reason the
 * vocabulary is independent at all). Rule data, reviewed with the gate.
 */
const OPERATOR_ONLY_SELECTIONS = ['auto', 'control-plane'];

/**
 * The vocabularies reconciled, addressed by DECLARATION rather than by path so
 * moving a file never drops one from the gate's sight.
 */
const VOCABULARY_ROLES = [
  {
    role: 'provider-families',
    name: 'SANDBOX_PROVIDER_FAMILIES',
    kind: 'const-array',
  },
  {
    role: 'operator-vocabulary',
    name: 'CONFIGURED_SANDBOX_PROVIDER_FAMILIES',
    kind: 'const-array',
  },
  {
    role: 'terminal-story',
    name: 'SandboxTerminalStoryProvider',
    kind: 'type-union',
  },
];

function walkSourceFiles(root) {
  const files = [];
  const walk = (dirAbs) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(abs);
      }
    }
  };
  walk(root);
  return files;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Members of `const <name> = [ ... ]` in `source`, resolving one file's own
 * `...SPREAD` references recursively. Returns null when the declaration cannot
 * be parsed — the gate treats that as a violation, never as an empty set.
 */
export function extractConstArrayMembers(source, name, seen = new Set()) {
  const match = source.match(
    new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`),
  );
  if (!match) return null;
  const members = [];
  const body = stripComments(match[1]);
  for (const token of body
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    if (token.startsWith('...')) {
      const ref = token.slice(3).trim();
      if (seen.has(ref)) return null;
      seen.add(ref);
      const nested = extractConstArrayMembers(source, ref, seen);
      if (nested === null) return null;
      members.push(...nested);
      continue;
    }
    const literal = token.match(/^'([^']+)'$/);
    if (!literal) return null;
    members.push(literal[1]);
  }
  return members;
}

/** Members of `type <name> = 'a' | 'b';` in `source`, or null. */
export function extractTypeUnionMembers(source, name) {
  const start = source.search(new RegExp(`type\\s+${name}\\s*=`));
  if (start === -1) return null;
  const declaration = source.slice(start, source.indexOf(';', start));
  const members = [...stripComments(declaration).matchAll(/'([^']+)'/g)].map(
    (match) => match[1],
  );
  return members.length > 0 ? members : null;
}

/**
 * Discover every role's declaration site(s) across the workspace.
 *
 * @returns {Record<string, Array<{ file: string, members: string[] | null }>>}
 *   keyed by role; files relative to `root`.
 */
export function discoverVocabularyDeclarations({ root = ROOT } = {}) {
  const found = Object.fromEntries(VOCABULARY_ROLES.map((r) => [r.role, []]));
  for (const abs of walkSourceFiles(root)) {
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const { role, name, kind } of VOCABULARY_ROLES) {
      const declares =
        kind === 'const-array'
          ? new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*\\[`).test(source)
          : new RegExp(`export\\s+type\\s+${name}\\s*=`).test(source);
      if (!declares) continue;
      const members =
        kind === 'const-array'
          ? extractConstArrayMembers(source, name)
          : extractTypeUnionMembers(source, name);
      found[role].push({ file: path.relative(root, abs), members });
    }
  }
  return found;
}

export function findOperatorVocabularyViolations({ root = ROOT } = {}) {
  const violations = [];
  const declarations = discoverVocabularyDeclarations({ root });
  const resolved = {};

  for (const { role, name } of VOCABULARY_ROLES) {
    const sites = declarations[role];
    if (sites.length === 0) {
      violations.push({
        kind: 'missing-declaration',
        detail:
          `discovery found ZERO declarations of ${name} — a rename or deletion ` +
          'would look exactly like this, so an empty scan fails instead of ' +
          'passing vacuously',
        file: '(workspace)',
      });
      continue;
    }
    if (sites.length > 1) {
      violations.push({
        kind: 'ambiguous-declaration',
        detail: `${name} is declared in ${sites.length} files (${sites
          .map((site) => site.file)
          .join(', ')}) — a vocabulary has ONE declaration`,
        file: sites[0].file,
      });
      continue;
    }
    const [site] = sites;
    if (site.members === null) {
      violations.push({
        kind: 'unparseable-declaration',
        detail: `${name} in ${site.file} could not be parsed into string-literal members`,
        file: site.file,
      });
      continue;
    }
    resolved[role] = site;
  }

  const families = resolved['provider-families'];
  const operator = resolved['operator-vocabulary'];
  const terminalStory = resolved['terminal-story'];

  if (families && operator) {
    const required = [...families.members, ...OPERATOR_ONLY_SELECTIONS];
    for (const member of required) {
      if (!operator.members.includes(member)) {
        violations.push({
          kind: 'unnameable-family',
          detail:
            `"${member}" is selectable (or an operator-only selection) but the ` +
            `operator vocabulary CONFIGURED_SANDBOX_PROVIDER_FAMILIES cannot name it`,
          file: operator.file,
        });
      }
    }
  }

  if (terminalStory && operator) {
    for (const member of terminalStory.members) {
      if (!operator.members.includes(member)) {
        violations.push({
          kind: 'terminal-story-drift',
          detail:
            `SandboxTerminalStoryProvider member "${member}" is not in the ` +
            'operator vocabulary — the terminal-story vocabulary is a declared ' +
            'subset and may not drift past it',
          file: terminalStory.file,
        });
      }
    }
  }

  return violations;
}

function main() {
  const violations = findOperatorVocabularyViolations();
  if (violations.length === 0) {
    const declarations = discoverVocabularyDeclarations();
    console.log(
      'operator-provider-vocabulary-parity: the operator vocabulary names every ' +
        'selectable family, and the terminal-story vocabulary stays inside it',
    );
    for (const { role, name } of VOCABULARY_ROLES) {
      const [site] = declarations[role];
      console.log(`  ${name} (${site.file}): ${site.members.join(', ')}`);
    }
    return;
  }
  console.error(
    `operator-provider-vocabulary-parity: ${violations.length} violation(s):\n`,
  );
  for (const violation of violations) {
    console.error(`  [${violation.kind}] ${violation.file}`);
    console.error(`    ${violation.detail}`);
  }
  console.error(
    '\nThe operator vocabulary must be a superset of the selectable provider',
  );
  console.error(
    'families union {auto, control-plane}, and SandboxTerminalStoryProvider a',
  );
  console.error('subset of the operator vocabulary. Reconcile the declarations.');
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
