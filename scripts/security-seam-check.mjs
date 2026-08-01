#!/usr/bin/env node
/**
 * R9 — security seam assertion gate.
 *
 * 工件02 D 表 registers the "single computation" seams: origin computation,
 * session validation, the SSRF gate, and the credential decryption helper. The
 * table's own rule is that moving a seam must update the table in the same
 * change, and that a gate asserts "the declared seam file exists, and is the
 * only implementation".
 *
 * This script is that gate, and it holds NO copy of the seam list. Every path
 * and every uniqueness predicate is read from the `securitySeams` entries of
 * `docs/refactor/boundaries-manifest.json` — one list, not two. Adding, moving
 * or retiring a seam is therefore a manifest edit (an architecture decision
 * with change 留痕), never an edit here.
 *
 * A uniqueness predicate is a literal source pattern written the way the
 * DEFINITION is written (`export function decryptStored`), so a consumer that
 * imports and calls the seam never counts as a second implementation.
 *
 * Fail-closed, in every direction a vacuous pass could hide:
 *   - manifest missing or unparsable                → red
 *   - zero D-table entries                          → red (not "nothing to check")
 *   - entry missing `provenance` / `change`         → red naming the entry and field
 *   - declared seam file absent                     → red naming seam and path
 *   - scan roots resolving to zero files            → red (an empty scan is a failing scan)
 *   - more implementations than declared            → red naming canonical and duplicates
 *   - fewer, or the one found is not at the declared path → red
 *
 * Run: node scripts/security-seam-check.mjs
 *      node scripts/security-seam-check.mjs --root <dir> --manifest <file>
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** The single declaration source. The seam data lives there, not here. */
export const MANIFEST_RELATIVE_PATH = 'docs/refactor/boundaries-manifest.json';

/** Fields every manifest entry carries, per the manifest's own conventions. */
const PROVENANCE_FIELDS = ['provenance', 'change'];

const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage', '.git']);

/** `**` spans directories, `*` stays inside one segment. Nothing else is special. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function isExcluded(relPath, excludes) {
  return excludes.some((glob) => globToRegExp(glob).test(relPath));
}

function sourceFiles(absDir, relDir, out) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) sourceFiles(abs, rel, out);
    else if (SOURCE_FILE.test(entry.name)) out.push({ abs, rel });
  }
  return out;
}

function countOccurrences(text, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * @returns {Array<{ kind: string, seam: string, detail: string }>} empty when the tree is healthy
 */
export function findSeamViolations({ root = ROOT, manifestPath } = {}) {
  const manifestFile = manifestPath ?? path.join(root, MANIFEST_RELATIVE_PATH);
  const manifestLabel = path.relative(root, manifestFile) || manifestFile;

  if (!existsSync(manifestFile)) {
    return [
      {
        kind: 'manifest-missing',
        seam: '(manifest)',
        detail: `${manifestLabel} is absent — the seam list is manifest data and this gate has no fallback copy of it`,
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
        seam: '(manifest)',
        detail: `${manifestLabel} is not parsable JSON: ${error.message}`,
      },
    ];
  }

  const seams = manifest.securitySeams;
  if (!Array.isArray(seams) || seams.length === 0) {
    return [
      {
        kind: 'empty-seam-set',
        seam: '(manifest)',
        detail: `${manifestLabel} yields zero D-table security seams — a gate with nothing to assert passes vacuously, so this is a failure`,
      },
    ];
  }

  const violations = [];

  for (const [index, seam] of seams.entries()) {
    const name = seam?.id ?? seam?.seam ?? `securitySeams[${index}]`;

    for (const field of PROVENANCE_FIELDS) {
      if (typeof seam?.[field] !== 'string' || seam[field].trim() === '') {
        violations.push({
          kind: 'malformed-entry',
          seam: name,
          detail: `manifest entry is missing \`${field}\` — every rule entry carries provenance and its owning change`,
        });
      }
    }

    const declaredPath = seam?.path;
    if (typeof declaredPath !== 'string' || declaredPath.trim() === '') {
      violations.push({
        kind: 'malformed-entry',
        seam: name,
        detail: 'manifest entry is missing `path` — the seam has no declared location to assert',
      });
      continue;
    }

    const uniqueness = seam?.uniqueness;
    const pattern = uniqueness?.pattern;
    const scanRoots = uniqueness?.scanRoots;
    const expectedCount = uniqueness?.expectedCount;
    if (
      typeof pattern !== 'string' ||
      pattern.trim() === '' ||
      !Array.isArray(scanRoots) ||
      scanRoots.length === 0 ||
      !Number.isInteger(expectedCount)
    ) {
      violations.push({
        kind: 'malformed-entry',
        seam: name,
        detail:
          'manifest entry is missing a usable `uniqueness` predicate ' +
          '(`pattern`, non-empty `scanRoots`, integer `expectedCount`)',
      });
      continue;
    }

    if (!existsSync(path.join(root, declaredPath))) {
      violations.push({
        kind: 'missing-seam',
        seam: name,
        detail: `declared seam file is absent: ${declaredPath} — a seam that moves must move in the manifest too`,
      });
      continue;
    }

    const excludes = Array.isArray(uniqueness.excludes) ? uniqueness.excludes : [];
    const scanned = [];
    for (const scanRoot of scanRoots) {
      const abs = path.join(root, scanRoot);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      sourceFiles(abs, scanRoot, scanned);
    }
    const candidates = scanned.filter((file) => !isExcluded(file.rel, excludes));

    if (candidates.length === 0) {
      violations.push({
        kind: 'empty-scan',
        seam: name,
        detail: `uniqueness scan over ${scanRoots.join(', ')} matched zero files — an empty scan is a failing scan, not a passing one`,
      });
      continue;
    }

    const sites = [];
    for (const file of candidates) {
      let text;
      try {
        text = readFileSync(file.abs, 'utf8');
      } catch {
        continue;
      }
      const hits = countOccurrences(text, pattern);
      for (let i = 0; i < hits; i += 1) sites.push(file.rel);
    }

    if (sites.length > expectedCount) {
      const extras = sites.filter((site) => site !== declaredPath);
      violations.push({
        kind: 'duplicate-implementation',
        seam: name,
        detail:
          `\`${pattern}\` has ${sites.length} implementation(s), expected ${expectedCount}; ` +
          `canonical ${declaredPath}, also in ${[...new Set(extras)].join(', ') || declaredPath} — ` +
          'a registered seam is a single computation, and a second one is the defect the register exists to prevent',
      });
      continue;
    }

    if (sites.length < expectedCount) {
      violations.push({
        kind: 'missing-implementation',
        seam: name,
        detail: `\`${pattern}\` has ${sites.length} implementation(s), expected ${expectedCount} — the seam's declared predicate no longer matches its implementation`,
      });
      continue;
    }

    if (expectedCount > 0 && !sites.includes(declaredPath)) {
      violations.push({
        kind: 'relocated-implementation',
        seam: name,
        detail: `\`${pattern}\` is implemented in ${[...new Set(sites)].join(', ')} rather than at the declared path ${declaredPath}`,
      });
    }
  }

  return violations;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') options.root = path.resolve(argv[++i]);
    else if (argv[i] === '--manifest') options.manifestPath = path.resolve(argv[++i]);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const violations = findSeamViolations(options);
  if (violations.length === 0) {
    const root = options.root ?? ROOT;
    const manifestFile = options.manifestPath ?? path.join(root, MANIFEST_RELATIVE_PATH);
    const { securitySeams } = JSON.parse(readFileSync(manifestFile, 'utf8'));
    console.log(
      `security-seam: ${securitySeams.length} registered seam(s) exist and each has exactly one implementation ` +
        `(${securitySeams.map((seam) => seam.id ?? seam.seam).join(', ')})`,
    );
    return;
  }
  console.error(`security-seam: ${violations.length} violation(s):\n`);
  for (const violation of violations) {
    console.error(`  [${violation.kind}] ${violation.seam}`);
    console.error(`    ${violation.detail}`);
  }
  console.error(
    '\nThe D-table seams are the places where one computation decides a security question.',
  );
  console.error(
    'Moving one is allowed; moving one without updating docs/refactor/boundaries-manifest.json',
  );
  console.error('in the same change is what this gate refuses.');
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
