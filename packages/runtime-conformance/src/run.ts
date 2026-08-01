/**
 * The suite runner: resolves every declared runtime's harness through the
 * ledger, computes the families it OWES from its declared execution modes, runs
 * each owed family's suite-owned scenario, and emits the total per-runtime
 * report. The caller never chooses which families run — it supplies the seed
 * bridge and this decides (the shape the provider suite's participation module
 * documented as "stronger": a partial run is unexpressible).
 */
import { AGENT_RUNTIME_IDS } from '@cap-console/contracts';

import type { RuntimeHarness, RuntimeSeedBridge } from './harness.js';
import {
  RUNTIME_CONFORMANCE_FAMILIES,
  familySkipReason,
  type RuntimeConformanceFamily,
} from './participation.js';
import { RUNTIME_CONFORMANCE_HARNESSES } from './registry.js';
import {
  assertReportTotal,
  writeReportArtifact,
  type RuntimeConformanceReport,
  type RuntimeConformanceReportRow,
} from './report.js';
import { runHeadlessFamily } from './scenarios/headless.js';
import { runLaunchFamily } from './scenarios/launch.js';
import { runLifecycleFamily } from './scenarios/lifecycle.js';
import { runSecretCanaryFamily } from './scenarios/secret-canary.js';
import { runTranscriptFamily } from './scenarios/transcript.js';

/**
 * The suite-owned scenario for every family. TOTAL over the family vocabulary
 * (a family added without a scenario is a compile error). Runtimes never appear
 * here — they participate only through their harness makers.
 */
export const SCENARIO_FAMILIES: Readonly<
  Record<RuntimeConformanceFamily, (harness: RuntimeHarness) => Promise<void>>
> = {
  launch: runLaunchFamily,
  lifecycle: runLifecycleFamily,
  transcript: runTranscriptFamily,
  headless: runHeadlessFamily,
  'secret-canary': runSecretCanaryFamily,
};

export interface RuntimeConformanceRunOptions {
  readonly bridge: RuntimeSeedBridge;
  /** When set, the JSON report artifact is written here. */
  readonly reportPath?: string;
}

export async function runRuntimeConformance(
  options: RuntimeConformanceRunOptions,
): Promise<RuntimeConformanceReport> {
  const rows: RuntimeConformanceReportRow[] = [];

  for (const runtimeId of AGENT_RUNTIME_IDS) {
    const maker = RUNTIME_CONFORMANCE_HARNESSES[runtimeId];
    const harness = await maker.make(options.bridge);
    if (harness.runtime.id !== runtimeId) {
      throw new Error(
        `conformance harness for "${runtimeId}" constructed a runtime ` +
          `identifying as "${harness.runtime.id}"`,
      );
    }
    rows.push(...(await runFamiliesFor(harness)));
  }

  const report: RuntimeConformanceReport = {
    generatedAt: new Date().toISOString(),
    runtimes: [...AGENT_RUNTIME_IDS],
    families: [...RUNTIME_CONFORMANCE_FAMILIES],
    rows,
  };
  assertReportTotal(report);
  if (options.reportPath) writeReportArtifact(report, options.reportPath);
  return report;
}

/**
 * Run every family for one harness: owed families run (a failure throws with
 * the failing runtime/family named); families whose implying declaration is
 * absent yield a reasoned `skip` row. Exported for the suite's own unit tests
 * (proving the skip path with a stub harness never requires a real runtime).
 */
export async function runFamiliesFor(
  harness: RuntimeHarness,
): Promise<readonly RuntimeConformanceReportRow[]> {
  const { runtime } = harness;
  const rows: RuntimeConformanceReportRow[] = [];
  for (const family of RUNTIME_CONFORMANCE_FAMILIES) {
    const skipReason = familySkipReason(
      family,
      runtime.id,
      runtime.executionModes,
    );
    if (skipReason !== null) {
      rows.push({ runtime: runtime.id, family, status: 'skip', reason: skipReason });
      continue;
    }
    try {
      await SCENARIO_FAMILIES[family](harness);
    } catch (error) {
      throw new Error(
        `runtime-conformance: runtime "${runtime.id}" failed the "${family}" family`,
        { cause: error },
      );
    }
    rows.push({
      runtime: runtime.id,
      family,
      status: 'pass',
      reason: `ran the suite-owned ${family} scenario`,
    });
  }
  return rows;
}
