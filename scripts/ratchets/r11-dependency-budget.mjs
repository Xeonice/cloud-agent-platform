#!/usr/bin/env node
/**
 * R11 — the guardrails dependency-budget ratchet.
 *
 * 阶段 4 turns five cross-cutting concerns that `GuardrailsService` calls
 * DIRECTLY (audit, metrics projection, provisioning diagnostics, transcript
 * finalisation, runner-minute billing) into domain-event subscribers, one
 * change at a time. This gate is the burn-down meter for that: it counts, per
 * collaborator, how many times `guardrails.service.ts` still names it, and
 * compares those counts against the committed baseline
 * `scripts/ratchets/r11.json` through the SHARED comparator — imported, never
 * re-implemented.
 *
 * Fail-closed in BOTH directions (the comparator's semantics, restated here so
 * the intent is not lost):
 *
 *   - a count ABOVE the baseline is red — a migration change that was supposed
 *     to remove call sites added one instead;
 *   - a count BELOW the baseline is EQUALLY red — the baseline shrink lands in
 *     the same commit as the removal, so a burned-down collaborator can never
 *     silently regrow up to a stale ceiling. That is the whole reason this is a
 *     ratchet and not a "current count" report.
 *
 * ENDGAME: a collaborator burned to zero has its ENTRY deleted from the
 * baseline (the comparator says so). This gate keeps MEASURING it afterwards —
 * the declaration below is the gate's, not the baseline's — so a re-introduced
 * call site is red as "violations with no baseline entry" rather than passing
 * unmeasured. When the last entry goes, the baseline FILE is deleted and R11
 * becomes an ordinary prohibition.
 *
 * COUNTING CONVENTION — per SYMBOL REFERENCE, not per call site: every textual
 * occurrence of the collaborator's symbol inside the measured file counts as
 * one, including the constructor parameter that injects it, a pass-through into
 * a helper, and a type annotation. That convention is deliberate and stricter
 * than counting calls: 阶段 4 is done with a collaborator when guardrails stops
 * NAMING it at all, not merely when the last `await` disappears. The entry keys
 * carry the convention (`guardrails-symbol-reference:…`) so a reader of the
 * baseline file alone cannot mistake it for a call-site count.
 *
 * Run (canon pairing):
 *   node scripts/ratchets/r11-dependency-budget.mjs
 *   && node --test scripts/ratchets/r11-dependency-budget.test.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { compareToBaseline, readBaseline } from './comparator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/** The single file whose dependency budget R11 governs. */
export const SOURCE_REL = 'apps/api/src/guardrails/guardrails.service.ts';

/** The committed ratchet baseline this gate owns. */
export const BASELINE_REL = 'scripts/ratchets/r11.json';

/** Prefix that carries the counting convention into every entry key. */
export const KEY_PREFIX = 'guardrails-symbol-reference';

/**
 * The six collaborator symbols the five 阶段 4 concerns reach guardrails
 * through. THIS is the declaration — the baseline file holds tolerated counts
 * only, exactly as `r7.json` holds counts for keys the layout gate produces.
 * Keeping the list here is what makes a burned-down entry still measured.
 *
 * @type {ReadonlyArray<{ collaborator: string, symbol: string, concern: string }>}
 */
export const COLLABORATORS = Object.freeze([
  {
    collaborator: 'this.audit',
    symbol: 'this.audit',
    concern: 'audit（普通路径改订阅；terminal detail 的回执型调用按非事件准入规则留作 CALL）',
  },
  {
    collaborator: 'this.runnerMinutes',
    symbol: 'this.runnerMinutes',
    concern: 'runner 计费（recordStart/recordEnd 改订阅）',
  },
  {
    collaborator: 'provisioningDiagnosticRecorder',
    symbol: 'provisioningDiagnosticRecorder',
    concern: 'diagnostics（开通诊断记录改订阅）',
  },
  {
    collaborator: 'provisioningDiagnosticWriteGate',
    symbol: 'provisioningDiagnosticWriteGate',
    concern: 'diagnostics（写闸门 isEnabled(): boolean 是回执型协作，燃尽方式随 recorder 一并重议）',
  },
  {
    collaborator: 'this.transcripts',
    symbol: 'this.transcripts',
    concern: 'transcript 收尾（capture 改订阅）',
  },
  {
    collaborator: 'metrics-projection',
    symbol: 'SemaphoreProjectionSource',
    concern: 'metrics（投影源类型；guardrails 停止导出投影即归零）',
  },
]);

/** The baseline entry key for a declared collaborator. */
export function entryKey(collaborator) {
  return `${KEY_PREFIX}:${collaborator}`;
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Counts symbol references in one source text, returning both the measurement
 * the comparator consumes and the reviewer-facing sample lines.
 *
 * @param {string} source file text
 * @param {string} [shownPath] path used in sample strings
 * @returns {{ measured: Record<string, number>, samples: Record<string, string[]> }}
 */
export function measureSource(source, shownPath = SOURCE_REL) {
  const lines = source.split('\n');
  const measured = {};
  const samples = {};
  const shownName = shownPath.split('/').pop();
  for (const { collaborator, symbol } of COLLABORATORS) {
    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g');
    const key = entryKey(collaborator);
    let count = 0;
    const hits = [];
    lines.forEach((line, index) => {
      const occurrences = line.match(pattern)?.length ?? 0;
      if (occurrences === 0) return;
      count += occurrences;
      hits.push(`${shownName}:${index + 1} ${line.trim()}`);
    });
    measured[key] = count;
    samples[key] = hits;
  }
  return { measured, samples };
}

/**
 * Measures the governed file on disk. A missing or empty source is a FAILURE,
 * never a pass: every collaborator would measure zero and the gate would read
 * green while having looked at nothing.
 *
 * @param {{root?: string, sourcePath?: string}} options
 * @returns {{ measured: Record<string, number>, samples: Record<string, string[]>, problems: string[] }}
 */
export function measure({ root = ROOT, sourcePath } = {}) {
  const abs = sourcePath ?? path.join(root, SOURCE_REL);
  const shown = sourcePath ? path.relative(root, sourcePath) : SOURCE_REL;
  if (!existsSync(abs)) {
    return {
      measured: {},
      samples: {},
      problems: [
        `${shown}: the governed source is missing — a budget measured over no file is not zero debt, it is a blind gate`,
      ],
    };
  }
  const source = readFileSync(abs, 'utf8');
  if (source.trim() === '') {
    return {
      measured: {},
      samples: {},
      problems: [
        `${shown}: the governed source is empty — refusing to report a zero budget from an empty measurement`,
      ],
    };
  }
  const { measured, samples } = measureSource(source, shown);
  return { measured, samples, problems: [] };
}

/**
 * Runs the gate end to end and reports what a process exit would be, so the
 * paired self-test proves the red paths without spawning processes.
 *
 * @param {{root?: string, sourcePath?: string, baselinePath?: string}} options
 * @returns {{ exitCode: number, output: string[], problems: string[], measured: Record<string, number>, samples: Record<string, string[]> }}
 */
export function runGate({ root = ROOT, sourcePath, baselinePath } = {}) {
  const output = [];
  const { measured, samples, problems: measureProblems } = measure({ root, sourcePath });
  if (measureProblems.length > 0) {
    return { exitCode: 1, output, problems: measureProblems, measured, samples };
  }

  const shown = sourcePath ? path.relative(root, sourcePath) : SOURCE_REL;
  output.push(`r11 dependency budget: ${shown}`);
  for (const { collaborator, symbol } of COLLABORATORS) {
    output.push(`  ${collaborator} (${symbol}): ${measured[entryKey(collaborator)] ?? 0}`);
  }

  const baselineAbs = baselinePath ?? path.join(root, BASELINE_REL);
  if (!existsSync(baselineAbs)) {
    const outstanding = Object.entries(measured).filter(([, count]) => count > 0);
    return {
      exitCode: outstanding.length > 0 ? 1 : 0,
      output,
      problems: outstanding.map(
        ([key, count]) =>
          `${key}: ${count} reference(s) with no baseline file — add ${BASELINE_REL} or burn them down`,
      ),
      measured,
      samples,
    };
  }

  let baseline;
  try {
    baseline = readBaseline(baselineAbs);
  } catch (error) {
    return {
      exitCode: 1,
      output,
      problems: [`${path.relative(root, baselineAbs)}: not valid JSON — ${error.message}`],
      measured,
      samples,
    };
  }

  const problems = compareToBaseline(measured, baseline);
  // `symbol` / `concern` in an entry are documentation for whoever opens the
  // baseline alone. Documentation that can drift from the declaration silently
  // is a second declaration, so disagreement is red rather than tolerated.
  for (const { collaborator, symbol } of COLLABORATORS) {
    const entry = baseline?.[entryKey(collaborator)];
    if (entry && 'symbol' in entry && entry.symbol !== symbol) {
      problems.push(
        `${entryKey(collaborator)}: baseline records symbol '${entry.symbol}' but the gate measures '${symbol}' — the entry's documentation must not drift from the declaration`,
      );
    }
  }
  return { exitCode: problems.length > 0 ? 1 : 0, output, problems, measured, samples };
}

function main() {
  const result = runGate();
  for (const line of result.output) console.log(line);
  if (result.problems.length === 0) {
    console.log(
      'r11 dependency budget: every collaborator exactly at its baselined count (a ratchet ends by deleting its entries)',
    );
    return;
  }
  console.error(`\nr11 dependency budget: ${result.problems.length} problem(s):\n`);
  for (const problem of result.problems) console.error(`  ${problem}`);
  console.error(
    `\nThe collaborator list lives in ${path.relative(ROOT, fileURLToPath(import.meta.url))} and the tolerated debt in ${BASELINE_REL} —`,
  );
  console.error(
    'a removal shrinks the baseline in the SAME commit; an entry that reaches zero is deleted outright.',
  );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
