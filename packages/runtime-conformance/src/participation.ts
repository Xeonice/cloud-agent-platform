/**
 * Conformance participation, derived from what a runtime DECLARES.
 *
 * Structurally copied from the provider suite's
 * `packages/sandbox-conformance/src/required-participation.ts`: participation is
 * a PAIR of total Records — one keyed by runtime identifier (the harness-maker
 * ledger in `./registry.ts`), one keyed by scenario family (the obligation table
 * below). The set of families a runtime MUST run is computed from the runtime's
 * declared `executionModes` alone (a runtime declaring `headless-exec` owes the
 * headless family); the caller never chooses which families to run.
 *
 * A declared runtime missing from the runtime-keyed Record, or a scenario
 * family missing from the family-keyed Record, fails TYPECHECK — never a
 * runtime detection, never a silent skip (the self-invalidating guards live in
 * `runtime-participation.typecheck.ts`). A family a runtime does not owe is
 * reported as an explicit reasoned `skip` row, never as silence.
 */
import type { AgentRuntimeId, ExecutionMode } from '@cap-console/contracts';

/** The five scenario families this suite owns (unlock-extension-axes D7). */
export const RUNTIME_CONFORMANCE_FAMILIES = [
  'launch',
  'lifecycle',
  'transcript',
  'headless',
  'secret-canary',
] as const;

export type RuntimeConformanceFamily =
  (typeof RUNTIME_CONFORMANCE_FAMILIES)[number];

/**
 * Why a family is owed.
 *
 * - `unconditional` — every declared runtime owes it (every runtime persists a
 *   transcript and injects credential material).
 * - `implied-by-execution-mode` — owed exactly when the runtime declares the
 *   named execution mode; otherwise the run reports a reasoned skip row naming
 *   the missing declaration.
 */
export type RuntimeFamilyObligation =
  | { readonly kind: 'unconditional' }
  | { readonly kind: 'implied-by-execution-mode'; readonly mode: ExecutionMode };

/**
 * Obligation for every family. TOTAL over the family vocabulary: a family added
 * without an entry here is a compile error, so a new family cannot enter the
 * suite both unowed and unrecorded.
 */
export const RUNTIME_FAMILY_OBLIGATIONS: Readonly<
  Record<RuntimeConformanceFamily, RuntimeFamilyObligation>
> = {
  // The interactive launch line + startup/exit policy exist for the resident
  // TUI path, so both are implied by the interactive execution mode.
  launch: { kind: 'implied-by-execution-mode', mode: 'interactive-pty' },
  lifecycle: { kind: 'implied-by-execution-mode', mode: 'interactive-pty' },
  transcript: { kind: 'unconditional' },
  headless: { kind: 'implied-by-execution-mode', mode: 'headless-exec' },
  'secret-canary': { kind: 'unconditional' },
};

/** The families a runtime owes, given the execution modes it declares. */
export function requiredConformanceFamilies(
  declaredModes: ReadonlySet<ExecutionMode>,
): readonly RuntimeConformanceFamily[] {
  return RUNTIME_CONFORMANCE_FAMILIES.filter((family) => {
    const obligation = RUNTIME_FAMILY_OBLIGATIONS[family];
    return (
      obligation.kind === 'unconditional' || declaredModes.has(obligation.mode)
    );
  });
}

/**
 * The reasoned skip for a family a runtime does not owe, or `null` when the
 * family is required. The reason NAMES the missing declaration so a skip row is
 * attributable, never silence.
 */
export function familySkipReason(
  family: RuntimeConformanceFamily,
  runtimeId: AgentRuntimeId,
  declaredModes: ReadonlySet<ExecutionMode>,
): string | null {
  const obligation = RUNTIME_FAMILY_OBLIGATIONS[family];
  if (obligation.kind === 'unconditional' || declaredModes.has(obligation.mode)) {
    return null;
  }
  return (
    `runtime "${runtimeId}" does not declare the "${obligation.mode}" execution mode ` +
    `that implies the "${family}" family`
  );
}

/**
 * The loud failure for a REQUIRED family the harness cannot exercise (e.g. a
 * runtime declaring `headless-exec` whose harness supplies no headless hooks).
 * Mirrors the provider suite's participation wording: declaring a capability
 * the conformance does not exercise is an error, not a smaller run.
 */
export class ConformanceParticipationError extends Error {
  constructor(
    runtimeId: AgentRuntimeId,
    family: RuntimeConformanceFamily,
    detail: string,
  ) {
    const obligation = RUNTIME_FAMILY_OBLIGATIONS[family];
    const cause =
      obligation.kind === 'implied-by-execution-mode'
        ? `declares "${obligation.mode}", which the "${family}" family exercises`
        : `owes the unconditional "${family}" family`;
    super(
      `conformance participation: runtime "${runtimeId}" ${cause}, but ${detail}. ` +
        'A runtime may not declare a capability its conformance does not exercise.',
    );
    this.name = 'ConformanceParticipationError';
  }
}
