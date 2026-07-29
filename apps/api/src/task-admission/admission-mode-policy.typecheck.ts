import type {
  AdmissionCapabilityOutcome,
  AdmissionMode,
} from '@/task-admission/admission-mode-policy';

/**
 * Compile-fail fixtures for the total admission-mode mapping.
 *
 * The runtime spec can prove the mapping matches today's gate schema. Only the
 * compiler can prove that TOMORROW's closed reason cannot slip through: the whole
 * point of `Record<AdmissionCapabilityOutcome, AdmissionMode>` is that adding a
 * reason to `TaskAdmissionV2GateClosedReasonSchema` breaks the build until
 * someone writes down what that reason should do.
 *
 * These assignments deliberately remain behind `@ts-expect-error`. If the mapping
 * is ever weakened to a partial or string-indexed shape — which would restore the
 * silent-default behaviour this change removed — the directives become unused and
 * the normal API typecheck fails. The fixture cannot be defeated by relaxing the
 * thing it guards.
 */

type AdmissionModeMap = Readonly<Record<AdmissionCapabilityOutcome, AdmissionMode>>;

declare const mappingWithEveryOutcomeRemoved: Omit<
  AdmissionModeMap,
  keyof AdmissionModeMap
>;

// @ts-expect-error Every capability outcome requires a stated admission mode.
const incompleteAdmissionModeMap: AdmissionModeMap =
  mappingWithEveryOutcomeRemoved;
void incompleteAdmissionModeMap;

declare const mappingMissingGateAbsent: Omit<
  AdmissionModeMap,
  'gate-provider-absent'
>;

// @ts-expect-error An absent gate provider must have its own stated consequence.
const admissionModeMapWithoutAbsentGate: AdmissionModeMap =
  mappingMissingGateAbsent;
void admissionModeMapWithoutAbsentGate;

declare const mappingMissingExpiredAttestation: Omit<
  AdmissionModeMap,
  'deployment_attestation_expired'
>;

// @ts-expect-error A closed reason cannot inherit an unstated fallback.
const admissionModeMapWithoutExpiredReason: AdmissionModeMap =
  mappingMissingExpiredAttestation;
void admissionModeMapWithoutExpiredReason;

/**
 * The outcome union must stay derived from the gate schema rather than re-listed.
 * A hand-written union would drift, so assigning an arbitrary string must fail.
 */
declare const arbitraryOutcome: string;

// @ts-expect-error Outcomes come from the gate schema, not from free strings.
const unmodelledOutcome: AdmissionCapabilityOutcome = arbitraryOutcome;
void unmodelledOutcome;
