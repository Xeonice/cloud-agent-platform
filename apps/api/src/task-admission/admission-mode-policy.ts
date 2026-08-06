/**
 * Which admission pipeline an acceptance takes, and why.
 *
 * There is only one pipeline left. The synchronous in-request admission
 * pipeline was retired whole, so the mapping below is total over twelve
 * outcomes onto a ONE-member union: the branch was REMOVED, not widened. There
 * is deliberately no refusal outcome and no `503` — an unproven capability
 * (attestation missing/invalid/expired, mixed build identity, no gate provider
 * wired) admits durably exactly as an open gate does.
 *
 * What that gives up is recorded rather than glossed: the policy's own reason
 * for degrading — that a mixed-version deployment may not be able to honour
 * durable admission — is abandoned, and this landed WITHOUT attestation renewal
 * being automated, so a deployment whose attestation expired now runs durable
 * rather than degrading. That is acceptable only because admission never
 * refuses; under a refusing design it would not be.
 *
 * The outcome is still resolved, still total, and still carried on the decision.
 * The gate distinguishes ten closed reasons; the optional-provider coalesce adds
 * an eleventh (no gate wired at all) that the reason enum does not model; `open`
 * is the twelfth. Keeping all twelve distinct is what lets the acceptance path
 * SAY why a deployment is degraded without reading deployment state a second
 * time — and two reads of one state can disagree.
 *
 * The mapping below stays TOTAL over {@link AdmissionCapabilityOutcome}. Adding
 * a closed reason to the gate without deciding its consequence here stops the
 * project compiling rather than letting the new reason inherit an unstated
 * fallback. This is the same shape as `SANDBOX_PROVIDER_CAPABILITY_CLASSES` in
 * `@cap-console/sandbox-core` and the registration-derived runtime guard in
 * `AgentRuntimeRegistry`: the compiler, not a reviewer, is what notices the gap.
 */

import {
  TASK_ADMISSION_V2_CAPABILITY,
  TaskAdmissionV2GateClosedReasonSchema,
  type TaskAdmissionV2GateResult,
} from '@cap-console/contracts';

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

/**
 * The admission pipeline an acceptance is routed to.
 *
 * Exactly one member, and it stays a named union rather than collapsing into a
 * bare literal so that a future second pipeline is added HERE — where the total
 * mapping below forces every outcome to state which one it takes — instead of
 * being reintroduced as an inline ternary at an acceptance site.
 */
export type AdmissionMode = 'durable-v2';

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

  // The operator has not asked for the durable pipeline. There is no other
  // pipeline to give them, so this reports as degraded and admits durably.
  disabled: 'durable-v2',

  // The deployment roster is absent, unparseable, or no longer current, so
  // membership and build agreement cannot be established. Admission still
  // proceeds: refusing here would make an expired attestation — which nothing
  // in this repository renews — an outage.
  deployment_attestation_missing: 'durable-v2',
  deployment_attestation_invalid: 'durable-v2',
  deployment_attestation_expired: 'durable-v2',

  // The roster and the processes reporting against it do not agree.
  worker_report_missing: 'durable-v2',
  worker_report_unexpected: 'durable-v2',
  worker_capability_missing: 'durable-v2',
  worker_not_ready: 'durable-v2',

  // Members disagree about which build they are. This is the one outcome the
  // retired pipeline genuinely covered — the mixed-version hazard the durable
  // work rows were not designed to survive — and the consistency it bought is
  // what this mapping gives up in exchange for never refusing an acceptance.
  mixed_build_identity: 'durable-v2',

  // Nothing is wired to answer the question.
  [ADMISSION_GATE_ABSENT]: 'durable-v2',
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

/**
 * True when the capability the durable pipeline wanted proven was NOT proven.
 *
 * It no longer changes which pipeline runs — nothing does. It is attribution:
 * the acceptance path says which capability was unproven and why, at the point
 * the consequence is taken, so an operator can tell a healthy deployment from
 * one that is running durable admission on an unproven capability.
 */
export function isDegradedAdmission(decision: AdmissionModeDecision): boolean {
  return decision.outcome !== 'open';
}
