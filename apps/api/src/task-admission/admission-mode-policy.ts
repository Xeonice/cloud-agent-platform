/**
 * Which admission pipeline an acceptance takes, and why.
 *
 * This used to be one ternary at the acceptance point:
 *
 *   const admissionMode = (this.taskAdmissionGate?.isEnabled() ?? false)
 *     ? 'durable-v2'
 *     : 'legacy';
 *
 * That flattened a twelve-valued situation into a boolean. The gate distinguishes
 * ten closed reasons; the optional-provider coalesce silently added an eleventh
 * (no gate wired at all) that the reason enum does not model; and `open` is the
 * twelfth. All twelve produced the same bare string, so nothing downstream could
 * say why a task took the path it took without reading deployment state a second
 * time — and two reads of one state can disagree.
 *
 * The mapping below is TOTAL over {@link AdmissionCapabilityOutcome}. Adding a
 * closed reason to the gate without deciding its consequence here stops the
 * project compiling rather than letting the new reason inherit an unstated
 * fallback. This is the same shape as `SANDBOX_PROVIDER_CAPABILITY_CLASSES` in
 * `@cap/sandbox-core` and the registration-derived runtime guard in
 * `AgentRuntimeRegistry`: the compiler, not a reviewer, is what notices the gap.
 *
 * What this file deliberately does NOT do is change the answer. Every outcome
 * other than `open` still resolves to the legacy pipeline, exactly as before. The
 * refusal outcome is now *expressible* — one entry would express it — but it is
 * not registered, because deciding it needs deployment evidence this change does
 * not have (see the proposal's Non-Goals).
 */

import {
  TASK_ADMISSION_V2_CAPABILITY,
  TaskAdmissionV2GateClosedReasonSchema,
  type TaskAdmissionV2GateResult,
} from '@cap/contracts';

/**
 * No gate provider is wired.
 *
 * Kept distinct from every reason a present gate can report, because a
 * dependency-injection regression and a legitimately closed gate are different
 * facts about a deployment and only one of them is an operator's doing.
 */
export const ADMISSION_GATE_ABSENT = 'gate-provider-absent' as const;

/** Every situation the acceptance path can find the capability gate in. */
export type AdmissionCapabilityOutcome =
  | 'open'
  | (typeof TaskAdmissionV2GateClosedReasonSchema.options)[number]
  | typeof ADMISSION_GATE_ABSENT;

/** The admission pipeline an acceptance is routed to. */
export type AdmissionMode = 'durable-v2' | 'legacy';

/** The resolved decision, carrying the outcome that produced it. */
export interface AdmissionModeDecision {
  readonly mode: AdmissionMode;
  readonly outcome: AdmissionCapabilityOutcome;
  /** The capability that had to be proven for the durable pipeline. */
  readonly capability: typeof TASK_ADMISSION_V2_CAPABILITY;
}

/**
 * Total mapping from outcome to pipeline.
 *
 * Every key states its own consequence. There is no `default` arm and no
 * catch-all, because a catch-all is precisely the silent inheritance this file
 * exists to remove.
 */
export const ADMISSION_MODE_BY_OUTCOME: Readonly<
  Record<AdmissionCapabilityOutcome, AdmissionMode>
> = {
  open: 'durable-v2',

  // The operator has not asked for the durable pipeline.
  disabled: 'legacy',

  // The deployment roster is absent, unparseable, or no longer current, so
  // membership and build agreement cannot be established.
  deployment_attestation_missing: 'legacy',
  deployment_attestation_invalid: 'legacy',
  deployment_attestation_expired: 'legacy',

  // The roster and the processes reporting against it do not agree.
  worker_report_missing: 'legacy',
  worker_report_unexpected: 'legacy',
  worker_capability_missing: 'legacy',
  worker_not_ready: 'legacy',

  // Members disagree about which build they are, which is the mixed-version
  // hazard the durable work rows cannot survive.
  mixed_build_identity: 'legacy',

  // Nothing is wired to answer the question.
  [ADMISSION_GATE_ABSENT]: 'legacy',
};

/** Reduce a gate reading — or its absence — to exactly one outcome. */
export function admissionCapabilityOutcome(
  gate: TaskAdmissionV2GateResult | undefined,
): AdmissionCapabilityOutcome {
  if (gate === undefined) return ADMISSION_GATE_ABSENT;
  return gate.open ? 'open' : gate.reason;
}

/**
 * Resolve the admission mode for one acceptance.
 *
 * Callers read the gate exactly once and freeze what this returns; every later
 * decision, including the transaction write, consumes the frozen decision rather
 * than re-reading mutable deployment state.
 */
export function resolveAdmissionMode(
  gate: TaskAdmissionV2GateResult | undefined,
): AdmissionModeDecision {
  const outcome = admissionCapabilityOutcome(gate);
  return {
    mode: ADMISSION_MODE_BY_OUTCOME[outcome],
    outcome,
    capability: TASK_ADMISSION_V2_CAPABILITY,
  };
}

/** True when the durable pipeline was not reachable and the reason is worth stating. */
export function isDegradedAdmission(decision: AdmissionModeDecision): boolean {
  return decision.outcome !== 'open';
}
