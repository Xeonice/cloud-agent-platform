#!/usr/bin/env node
/**
 * R12 — deterministic spec assertions.
 *
 * WHY THIS EXISTS. Verification cost in this repo is O(requirements x lenses x
 * rounds) because every requirement is routed through an LLM adversarial pass.
 * Measured on `extract-runner-minutes-ledger`: 8 of its 14 requirements were
 * decidable by a command, 45 of its 74 scenarios likewise, and every real defect
 * the three verify rounds caught was caught by a command rather than by a lens.
 * Paying an LLM to re-derive `grep | wc -l` is the single largest avoidable line
 * item, so a requirement that a command can decide SHALL be decided by that
 * command and SHALL NOT enter the adversarial path at all.
 *
 * THE CONTRACT. A change may carry `assertions.json` next to its `tasks.md`:
 *
 *   {
 *     "version": 1,
 *     "change": "<change-name>",
 *     "assertions": [
 *       {
 *         "id": "r11-runner-minutes-at-floor",
 *         "requirements": ["domain-event-bus/the-runner-minutes-budget-entry-..."],
 *         "describe": "R11 records this.runnerMinutes at its adjudicated floor",
 *         "run": ["node", "scripts/ratchets/r11-dependency-budget.mjs"],
 *         "expect": { "exitCode": 0 }
 *       }
 *     ]
 *   }
 *
 * `expect` takes exactly one of:
 *   exitCode       number   — the process must exit with it
 *   stdoutEquals   string   — trimmed stdout must equal it exactly
 *   stdoutMatches  string   — trimmed stdout must match this regex
 *   stdoutAbsent   string   — this regex must NOT appear in stdout (zero-match checks)
 *
 * A REQUIREMENT IS ONLY "DECIDED" WHEN EVERY ASSERTION NAMING IT PASSES. A
 * requirement with zero assertions is NOT decided — it is reported as `undecided`
 * and stays in the adversarial path. That asymmetry is the whole safety property:
 * forgetting to write an assertion costs LLM budget, never a false green.
 *
 * NO SHELL. `run` is argv, executed without a shell, so an assertion cannot grow
 * a pipeline whose exit code is the last stage's. If you need `grep | wc -l`,
 * express the intent as `stdoutAbsent` over the grep's own output instead — a
 * zero-match check that reads as what it means and cannot be defeated by a
 * pipeline swallowing a non-zero status.
 *
 * Usage:
 *   node scripts/spec-assert.mjs <change-name> [--json]
 * Exit 0 when every assertion passes, 1 otherwise. Exit 0 with an empty report
 * when the change carries no assertions.json (opt-in, never a new obligation on
 * changes that predate it).
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** The single `expect` shapes an assertion may declare. */
export const EXPECT_KINDS = Object.freeze([
  'exitCode',
  'stdoutEquals',
  'stdoutMatches',
  'stdoutAbsent',
]);

export function assertionsPathFor(changeName) {
  return path.join(ROOT, 'openspec', 'changes', changeName, 'assertions.json');
}

/**
 * Structural validation. Returns the parsed document or throws with a message
 * naming the offending assertion — a malformed file must fail loudly rather than
 * silently deciding nothing, because "no assertions" and "broken assertions" have
 * opposite meanings for the budget this gate is protecting.
 */
export function parseAssertions(text, shownPath = 'assertions.json') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`${shownPath}: not valid JSON — ${error.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${shownPath}: top level must be an object`);
  }
  if (doc.version !== 1) {
    throw new Error(`${shownPath}: unsupported version ${JSON.stringify(doc.version)} (expected 1)`);
  }
  if (!Array.isArray(doc.assertions)) {
    throw new Error(`${shownPath}: "assertions" must be an array`);
  }
  const seen = new Set();
  for (const [index, entry] of doc.assertions.entries()) {
    const at = `${shownPath}: assertions[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${at} must be an object`);
    if (typeof entry.id !== 'string' || !entry.id.trim()) throw new Error(`${at} needs a non-empty "id"`);
    if (seen.has(entry.id)) throw new Error(`${at} duplicates id "${entry.id}"`);
    seen.add(entry.id);
    if (!Array.isArray(entry.requirements) || entry.requirements.length === 0) {
      throw new Error(`${at} ("${entry.id}") must name at least one requirement id`);
    }
    if (!Array.isArray(entry.run) || entry.run.length === 0 || entry.run.some((a) => typeof a !== 'string')) {
      throw new Error(`${at} ("${entry.id}") needs "run" as a non-empty argv array of strings`);
    }
    const expect = entry.expect;
    if (!expect || typeof expect !== 'object') {
      throw new Error(`${at} ("${entry.id}") needs an "expect" object`);
    }
    const declared = EXPECT_KINDS.filter((kind) => Object.hasOwn(expect, kind));
    if (declared.length !== 1) {
      throw new Error(
        `${at} ("${entry.id}") must declare exactly one of ${EXPECT_KINDS.join(', ')} — found ${declared.length}`,
      );
    }
  }
  return doc;
}

function evaluate(expect, result) {
  const stdout = (result.stdout ?? '').toString();
  const trimmed = stdout.trim();
  if (Object.hasOwn(expect, 'exitCode')) {
    return result.status === expect.exitCode
      ? { passed: true, actual: `exit ${result.status}` }
      : { passed: false, actual: `exit ${result.status}`, wanted: `exit ${expect.exitCode}` };
  }
  if (Object.hasOwn(expect, 'stdoutEquals')) {
    return trimmed === expect.stdoutEquals
      ? { passed: true, actual: trimmed }
      : { passed: false, actual: trimmed, wanted: expect.stdoutEquals };
  }
  if (Object.hasOwn(expect, 'stdoutMatches')) {
    const re = new RegExp(expect.stdoutMatches);
    return re.test(stdout)
      ? { passed: true, actual: trimmed.slice(0, 200) }
      : { passed: false, actual: trimmed.slice(0, 200), wanted: `match /${expect.stdoutMatches}/` };
  }
  const re = new RegExp(expect.stdoutAbsent);
  return re.test(stdout)
    ? { passed: false, actual: trimmed.slice(0, 200), wanted: `no match for /${expect.stdoutAbsent}/` }
    : { passed: true, actual: '(absent)' };
}

/**
 * Runs every assertion and rolls the results up per requirement.
 * `runner` is injectable so the gate's own test can drive it without spawning.
 */
export function runAssertions(doc, { cwd = ROOT, runner } = {}) {
  const exec =
    runner ??
    ((argv) =>
      spawnSync(argv[0], argv.slice(1), {
        cwd,
        encoding: 'utf8',
        shell: false,
        maxBuffer: 32 * 1024 * 1024,
      }));

  const results = [];
  for (const entry of doc.assertions) {
    const raw = exec(entry.run);
    const outcome = evaluate(entry.expect, raw);
    results.push({
      id: entry.id,
      describe: entry.describe ?? entry.id,
      requirements: [...entry.requirements],
      command: entry.run.join(' '),
      ...outcome,
    });
  }

  const byRequirement = new Map();
  for (const result of results) {
    for (const requirementId of result.requirements) {
      const bucket = byRequirement.get(requirementId) ?? { requirementId, assertions: [], decided: true };
      bucket.assertions.push(result.id);
      if (!result.passed) bucket.decided = false;
      byRequirement.set(requirementId, bucket);
    }
  }

  return {
    assertions: results,
    requirements: [...byRequirement.values()],
    decidedRequirements: [...byRequirement.values()].filter((r) => r.decided).map((r) => r.requirementId),
    failed: results.filter((r) => !r.passed).map((r) => r.id),
    passed: results.every((r) => r.passed),
  };
}

export function loadAndRun(changeName, options = {}) {
  const file = assertionsPathFor(changeName);
  if (!existsSync(file)) {
    return {
      changeName,
      present: false,
      passed: true,
      assertions: [],
      requirements: [],
      decidedRequirements: [],
      failed: [],
    };
  }
  const doc = parseAssertions(readFileSync(file, 'utf8'), path.relative(ROOT, file));
  return { changeName, present: true, ...runAssertions(doc, options) };
}

function main(argv) {
  const args = argv.filter((a) => a !== '--json');
  const asJson = argv.includes('--json');
  const changeName = args[0];
  if (!changeName) {
    console.error('Usage: node scripts/spec-assert.mjs <change-name> [--json]');
    return 2;
  }

  let report;
  try {
    report = loadAndRun(changeName);
  } catch (error) {
    if (asJson) console.log(JSON.stringify({ changeName, present: true, passed: false, error: error.message }, null, 2));
    else console.error(`R12 spec assertions: ${error.message}`);
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  }

  if (!report.present) {
    console.log(`R12 spec assertions: ${changeName} declares none — every requirement stays in the adversarial path.`);
    return 0;
  }

  for (const result of report.assertions) {
    console.log(`${result.passed ? 'ok  ' : 'FAIL'} ${result.id} — ${result.describe}`);
    if (!result.passed) {
      console.log(`       command: ${result.command}`);
      console.log(`       wanted:  ${result.wanted}`);
      console.log(`       actual:  ${result.actual}`);
    }
  }
  console.log(
    `\nR12 spec assertions: ${report.assertions.length - report.failed.length}/${report.assertions.length} passed; ` +
      `${report.decidedRequirements.length} requirement(s) decided without an LLM pass.`,
  );
  return report.passed ? 0 : 1;
}

// Both sides resolved, matching scripts/ratchets/r11-dependency-budget.mjs:262. A bare
// `file://${process.argv[1]}` comparison is silently false here: argv[1] arrives relative,
// and this checkout's path is non-ASCII so `import.meta.url` is percent-encoded.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
