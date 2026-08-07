#!/usr/bin/env node
/**
 * The tasks<->guardrails composition edge carries no `forwardRef`.
 *
 * WHY THIS EXISTS. `monorepo-foundation`'s acyclic requirement exempts imports made
 * BY a `*.module.ts` file, and that exemption is correct: a framework whose
 * composition model requires such imports would otherwise be satisfied by
 * indirection that hides the same cycle rather than removing it. But the exemption
 * means a `forwardRef` between two module files is invisible to `layout v2` BY
 * CONSTRUCTION, not by oversight — so the one place a module cycle can still be
 * declared is the one place nothing reads.
 *
 * That blind spot kept a vestige alive. `collapse-three-collaborator-groups` removed
 * the `GuardrailsModule -> TasksModule` edge; `guardrails.module.ts` has declared
 * `imports: []` ever since, and no non-test file under `apps/api/src/guardrails/`
 * imports `@/tasks`. The `forwardRef(() => GuardrailsModule)` in `tasks.module.ts`
 * outlived the cycle it wrapped by two changes, inside a doc comment that
 * simultaneously said the cycle was broken (the N3 paragraph) and that the
 * forwardRef existed to break it. Three sibling modules — metrics, settings,
 * terminal — already imported GuardrailsModule plainly the whole time.
 *
 * A vestigial forwardRef is not inert. It reads as evidence that a cycle exists, so
 * the next author who needs to move either module budgets for breaking one that was
 * broken long ago; and the next author who introduces a REAL cycle finds the tool
 * that would have flagged it already sitting there and assumes it was deliberate.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not re-litigate the `*.module.ts`
 * exemption, and it does not generalise to every module pair. It reads exactly two
 * files, because exactly one edge was ever adjudicated — phase 4's acceptance
 * criterion (d) names these two files by name. Widening it without an adjudication
 * would be inventing policy under cover of a gate.
 *
 * WHY COMMENTS DO NOT COUNT. Prose that names the retired forwardRef is the record
 * this gate wants KEPT — both files carry a paragraph explaining what went and why.
 * A check that counted those would push a future author to delete the explanation in
 * order to make the number zero, which is the opposite of the point.
 *
 * FAIL-CLOSED IN BOTH DIRECTIONS. A `forwardRef` naming the other module fails it.
 * So does losing its subject: if either file is missing from the path below, this
 * exits non-zero rather than reporting success over a file it never opened. A check
 * that passes because it found nothing to check is a failure this repository has
 * paid for before, and the cheapest way to reintroduce it is a rename.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/**
 * The adjudicated edge: each file, and the module symbol it must not wrap.
 * `guardrails.module.ts` is listed even though it imports nothing today — the gate
 * has to notice a cycle being declared from either end, not only the end that once
 * had one.
 */
export const EDGE = Object.freeze([
  Object.freeze({
    file: 'apps/api/src/tasks/tasks.module.ts',
    forbids: 'GuardrailsModule',
  }),
  Object.freeze({
    file: 'apps/api/src/guardrails/guardrails.module.ts',
    forbids: 'TasksModule',
  }),
]);

/** A line whose first non-space characters begin a comment carries no code. */
function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

/**
 * Violations in one file's text. Exported so the self-test can drive it without a
 * filesystem, and so a caller cannot accidentally test a different matcher than the
 * one that runs.
 */
export function findForwardRefViolations(text, forbids) {
  const pattern = new RegExp(`forwardRef\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*${forbids}\\b`, 'u');
  const bare = /forwardRef\s*\(/u;
  const hits = [];
  text.split('\n').forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (pattern.test(line) || (bare.test(line) && line.includes(forbids))) {
      hits.push({ line: index + 1, text: line.trim() });
    }
  });
  return hits;
}

export function checkEdge({ root = ROOT, read = readFileSync, exists = existsSync } = {}) {
  const missing = [];
  const violations = [];
  for (const { file, forbids } of EDGE) {
    const absolute = path.join(root, file);
    if (!exists(absolute)) {
      missing.push(file);
      continue;
    }
    for (const hit of findForwardRefViolations(read(absolute, 'utf8'), forbids)) {
      violations.push({ file, forbids, ...hit });
    }
  }
  return { missing, violations };
}

export function main({ root = ROOT } = {}) {
  const { missing, violations } = checkEdge({ root });

  if (missing.length > 0) {
    console.error(
      `module composition cycle check lost its subject: ${missing.length} of ${EDGE.length} ` +
        'adjudicated file(s) are not where this gate reads them.\n\n' +
        'This is a FAILURE, not a pass. A renamed or moved module leaves the gate\n' +
        'reading nothing and reporting success, which is how a check quietly stops\n' +
        'checking. Update EDGE in this file with the new path, in the same commit as\n' +
        'the move, and say in that commit why the edge is still the adjudicated one.\n',
    );
    for (const file of missing) console.error(`  missing: ${file}`);
    return 1;
  }

  if (violations.length > 0) {
    console.error(
      `${violations.length} forwardRef(s) on the tasks<->guardrails composition edge.\n\n` +
        'Phase 4 acceptance criterion (d) is that these two modules do not wrap each\n' +
        'other. If a real cycle has reappeared, the fix is the cycle, not the wrapper:\n' +
        'a forwardRef makes the cycle compile without making it go away, and layout v2\n' +
        'cannot see it because module-composition imports are exempt there.\n',
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} wraps ${v.forbids}\n    ${v.text}`);
    }
    return 1;
  }

  console.log(
    `module composition: neither of the ${EDGE.length} adjudicated module files wraps ` +
      'the other in forwardRef (comments naming the retired one are kept on purpose).',
  );
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  process.exit(main());
}
