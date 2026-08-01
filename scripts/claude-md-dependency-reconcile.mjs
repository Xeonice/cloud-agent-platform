#!/usr/bin/env node
/**
 * R10 — CLAUDE.md ⇄ boundaries-manifest reconciliation gate.
 *
 * 工件02 E 节 fixes the arrangement: the manifest is the single declaration
 * source, and the four subtree CLAUDE.md files keep their prose — but the
 * dependency whitelist inside that prose is reconciled against the manifest's A
 * table rather than trusted. Agent-facing docs that quietly disagree with the
 * enforced rules are worse than no docs: they are a confident wrong answer.
 *
 * What is read where, and why the split is not arbitrary:
 *   - WHICH files carry the section is doc inventory (工件02 E 节 names the four
 *     subtrees) and lives in GOVERNED_SUBTREES below;
 *   - WHAT those files may declare is rule data, and is read from the
 *     `packageRules` entries of `docs/refactor/boundaries-manifest.json`. No
 *     dependency rule is restated here.
 *
 * The section's parse contract, so prose and gate cannot drift over what counts:
 *   - the heading is exactly "What this subtree may depend on";
 *   - its FIRST paragraph is the declaration; anything after it is commentary
 *     the gate does not read;
 *   - the declaration is either a list of `@cap-console/*` package names, or a
 *     paragraph beginning "None" for a subtree that may depend on no internal
 *     package. A first paragraph that is neither is not "empty" — it is
 *     unparseable, and unparseable is red.
 *
 * Fail-closed, in every direction a vacuous pass could hide:
 *   - manifest missing / unparsable / zero A-table entries   → red
 *   - A-table entry missing `provenance` / `change`          → red naming entry and field
 *   - a governed CLAUDE.md absent                            → red naming the file
 *   - zero governed files resolved                           → red (the empty set is reported)
 *   - section missing or unparseable                         → red naming the file, never skipped
 *   - a subtree no A-table entry governs                     → red (nothing to reconcile against)
 *   - a declared dependency the manifest forbids             → red naming file and entry
 *
 * Run: node scripts/claude-md-dependency-reconcile.mjs
 *      node scripts/claude-md-dependency-reconcile.mjs --root <dir> \
 *        --manifest <file> --governed apps/web,packages/contracts
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** The single declaration source for the dependency rules themselves. */
export const MANIFEST_RELATIVE_PATH = 'docs/refactor/boundaries-manifest.json';

/**
 * The subtrees whose CLAUDE.md carries a dependency section — 工件02 E 节's
 * list, and doc inventory rather than rule data: it says which files are
 * governed, never what they may depend on.
 */
export const GOVERNED_SUBTREES = [
  'apps/api',
  'apps/web',
  'packages/contracts',
  'packages/sandbox',
];

export const SECTION_HEADING = 'What this subtree may depend on';

/** Fields every manifest entry carries, per the manifest's own conventions. */
const PROVENANCE_FIELDS = ['provenance', 'change'];

const HEADING_LINE = /^#{1,6}\s+/;
const SECTION_HEADING_LINE = new RegExp(`^#{1,6}\\s+${SECTION_HEADING}\\s*$`, 'i');
const PACKAGE_TOKEN = /@cap-console\/[a-z0-9][a-z0-9-]*/g;
const NONE_DECLARATION = /^(none|无)\b/i;

/** `*` matches one package-name segment; nothing else in a pattern is special. */
function patternToRegExp(pattern) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`);
}

/**
 * Is `root` (a manifest `appliesTo` scan root, possibly containing `*`) inside
 * `subtree`? `packages/*\/src` is inside `packages/contracts`; `apps/api/src`
 * is not inside `apps/web`.
 */
export function rootIsInsideSubtree(root, subtree) {
  const rootParts = root.split('/');
  const subtreeParts = subtree.split('/');
  if (rootParts.length < subtreeParts.length) return false;
  return subtreeParts.every(
    (part, index) => rootParts[index] === part || rootParts[index] === '*',
  );
}

/**
 * The declaration a governed CLAUDE.md makes, or why it cannot be read.
 *
 * @returns {{ packages: string[] } | { problem: 'missing-section' | 'unparseable-section' | 'ambiguous-declaration', detail: string }}
 */
export function readDependencySection(markdown) {
  const lines = markdown.split('\n');
  const headingAt = lines.findIndex((line) => SECTION_HEADING_LINE.test(line));
  if (headingAt === -1) {
    return {
      problem: 'missing-section',
      detail: `no "## ${SECTION_HEADING}" section — a governed file without the section is rejected, not skipped`,
    };
  }

  const body = [];
  for (let i = headingAt + 1; i < lines.length; i += 1) {
    if (HEADING_LINE.test(lines[i])) break;
    body.push(lines[i]);
  }

  let start = 0;
  while (start < body.length && body[start].trim() === '') start += 1;
  const paragraph = [];
  for (let i = start; i < body.length && body[i].trim() !== ''; i += 1) {
    paragraph.push(body[i].trim());
  }
  const declaration = paragraph.join(' ').trim();

  if (declaration === '') {
    return {
      problem: 'unparseable-section',
      detail: `the "${SECTION_HEADING}" section is empty — it declares nothing, which is not the same as declaring "None"`,
    };
  }

  const packages = [...new Set(declaration.match(PACKAGE_TOKEN) ?? [])];
  const declaresNone = NONE_DECLARATION.test(declaration.replace(/^[*_`\s]+/, ''));

  if (declaresNone && packages.length > 0) {
    return {
      problem: 'ambiguous-declaration',
      detail: `the declaration says "None" and then names ${packages.join(', ')} — one of the two is wrong`,
    };
  }
  if (declaresNone) return { packages: [] };
  if (packages.length === 0) {
    return {
      problem: 'unparseable-section',
      detail:
        `the first paragraph of "${SECTION_HEADING}" names no \`@cap-console/*\` package ` +
        'and does not begin with "None", so no dependency set can be read from it',
    };
  }
  return { packages };
}

/**
 * @returns {Array<{ kind: string, file: string, detail: string }>} empty when docs and manifest agree
 */
export function findDependencyMismatches({
  root = ROOT,
  manifestPath,
  governed = GOVERNED_SUBTREES,
} = {}) {
  const manifestFile = manifestPath ?? path.join(root, MANIFEST_RELATIVE_PATH);
  const manifestLabel = path.relative(root, manifestFile) || manifestFile;

  if (!existsSync(manifestFile)) {
    return [
      {
        kind: 'manifest-missing',
        file: manifestLabel,
        detail: 'the dependency rules are manifest data and this gate keeps no fallback copy of them',
      },
    ];
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return [
      {
        kind: 'manifest-unparsable',
        file: manifestLabel,
        detail: `not parsable JSON: ${error.message}`,
      },
    ];
  }

  const rules = manifest.packageRules;
  if (!Array.isArray(rules) || rules.length === 0) {
    return [
      {
        kind: 'empty-a-table',
        file: manifestLabel,
        detail: 'zero A-table package rules — reconciling prose against nothing would pass every file vacuously',
      },
    ];
  }

  const violations = [];
  for (const [index, rule] of rules.entries()) {
    const name = rule?.id ?? `packageRules[${index}]`;
    for (const field of PROVENANCE_FIELDS) {
      if (typeof rule?.[field] !== 'string' || rule[field].trim() === '') {
        violations.push({
          kind: 'malformed-entry',
          file: manifestLabel,
          detail: `A-table entry ${name} is missing \`${field}\` — every rule entry carries provenance and its owning change`,
        });
      }
    }
  }
  if (violations.length > 0) return violations;

  const resolved = [];
  for (const subtree of governed) {
    const relative = `${subtree}/CLAUDE.md`;
    const abs = path.join(root, relative);
    if (!existsSync(abs)) {
      violations.push({
        kind: 'missing-doc',
        file: relative,
        detail: 'governed subtree has no CLAUDE.md — the reconciliation cannot be performed for it',
      });
      continue;
    }
    resolved.push({ subtree, relative, abs });
  }

  if (resolved.length === 0) {
    violations.push({
      kind: 'empty-governed-set',
      file: '(governed set)',
      detail:
        `zero governed CLAUDE.md files resolved under ${path.resolve(root)} ` +
        `(looked for ${governed.map((subtree) => `${subtree}/CLAUDE.md`).join(', ')}) — ` +
        'a reconciliation that examines no file is a failure, not a pass',
    });
    return violations;
  }

  for (const doc of resolved) {
    // Rules that carry rule DATA. Entries registered by reference (P3, P7 —
    // enforcement "existing-gate") deliberately hold none, so they govern
    // nothing here; re-deriving them would be the second implementation the
    // manifest forbids.
    const governing = rules.filter(
      (rule) =>
        rule.enforcement !== 'existing-gate' &&
        Array.isArray(rule.appliesTo) &&
        rule.appliesTo.some((scanRoot) => rootIsInsideSubtree(scanRoot, doc.subtree)),
    );

    if (governing.length === 0) {
      violations.push({
        kind: 'no-governing-rule',
        file: doc.relative,
        detail: `no A-table entry in ${manifestLabel} applies to ${doc.subtree} — its prose has nothing to be reconciled against`,
      });
      continue;
    }

    const section = readDependencySection(readFileSync(doc.abs, 'utf8'));
    if ('problem' in section) {
      violations.push({ kind: section.problem, file: doc.relative, detail: section.detail });
      continue;
    }

    for (const declared of section.packages) {
      for (const rule of governing) {
        const patterns = rule.forbid?.packagePatterns ?? [];
        const hit = patterns.find((pattern) => patternToRegExp(pattern).test(declared));
        if (!hit) continue;
        violations.push({
          kind: 'contradicting-declaration',
          file: doc.relative,
          detail:
            `declares \`${declared}\`, which A-table entry ${rule.id} forbids for ${doc.subtree} ` +
            `(pattern \`${hit}\`, ${rule.provenance})`,
        });
      }
    }
  }

  return violations;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') options.root = path.resolve(argv[++i]);
    else if (argv[i] === '--manifest') options.manifestPath = path.resolve(argv[++i]);
    else if (argv[i] === '--governed') {
      options.governed = argv[++i]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const violations = findDependencyMismatches(options);
  if (violations.length === 0) {
    const governed = options.governed ?? GOVERNED_SUBTREES;
    console.log(
      `claude-md-dependency: ${governed.length} governed CLAUDE.md dependency section(s) agree with the boundaries manifest ` +
        `(${governed.join(', ')})`,
    );
    return;
  }
  console.error(`claude-md-dependency: ${violations.length} violation(s):\n`);
  for (const violation of violations) {
    console.error(`  [${violation.kind}] ${violation.file}`);
    console.error(`    ${violation.detail}`);
  }
  console.error(
    '\nThe manifest is the single declaration source; these sections are what an agent reads',
  );
  console.error(
    'instead. A section that disagrees with the enforced rules will be believed — which is why',
  );
  console.error('disagreement is a build failure rather than a docs chore.');
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
