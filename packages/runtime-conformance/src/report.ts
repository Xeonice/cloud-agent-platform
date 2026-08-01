/**
 * Per-runtime conformance report artifact (unlock-extension-axes D7): every
 * suite run maps EVERY (declared runtime, scenario family) pair to `pass` or
 * `skip` with a reason. A family skipped because the runtime does not declare
 * the implying capability appears as an explicit reasoned `skip` row — never as
 * silence (Gateway API GEP-1709 refinement of the provider suite's gap
 * reporting).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AGENT_RUNTIME_IDS, type AgentRuntimeId } from '@cap-console/contracts';

import {
  RUNTIME_CONFORMANCE_FAMILIES,
  type RuntimeConformanceFamily,
} from './participation.js';

export interface RuntimeConformanceReportRow {
  readonly runtime: AgentRuntimeId;
  readonly family: RuntimeConformanceFamily;
  readonly status: 'pass' | 'skip';
  /** Always present: what ran, or which missing declaration caused the skip. */
  readonly reason: string;
}

export interface RuntimeConformanceReport {
  readonly generatedAt: string;
  readonly runtimes: readonly AgentRuntimeId[];
  readonly families: readonly RuntimeConformanceFamily[];
  readonly rows: readonly RuntimeConformanceReportRow[];
}

/**
 * The report must be TOTAL over runtimes × families: one row per pair, each
 * `pass` or `skip` with a non-empty reason — no absent rows. Throws naming the
 * first missing/duplicate pair, so a partial run can never masquerade as a
 * report.
 */
export function assertReportTotal(report: RuntimeConformanceReport): void {
  for (const runtime of AGENT_RUNTIME_IDS) {
    for (const family of RUNTIME_CONFORMANCE_FAMILIES) {
      const rows = report.rows.filter(
        (row) => row.runtime === runtime && row.family === family,
      );
      if (rows.length !== 1) {
        throw new Error(
          `conformance report is not total: expected exactly one row for ` +
            `(${runtime}, ${family}), found ${rows.length}`,
        );
      }
      const row = rows[0];
      if (row && row.reason.trim().length === 0) {
        throw new Error(
          `conformance report row (${runtime}, ${family}) carries no reason — ` +
            'a skip or pass must always be attributable',
        );
      }
    }
  }
}

/** Write the JSON report artifact, creating the target directory. */
export function writeReportArtifact(
  report: RuntimeConformanceReport,
  path: string,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

/** Human-readable rendering, one line per (runtime, family) row. */
export function renderReport(report: RuntimeConformanceReport): string {
  const lines = report.rows.map(
    (row) =>
      `${row.status.toUpperCase().padEnd(4)} ${row.runtime} × ${row.family}: ${row.reason}`,
  );
  return lines.join('\n');
}
