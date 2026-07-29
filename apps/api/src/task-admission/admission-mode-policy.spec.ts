/**
 * Guards the admission-mode policy.
 *
 * The property that matters is not "closed means legacy" — that was already true
 * of the ternary this replaced. It is that the reason survives the decision, that
 * a missing gate provider is its own fact rather than a coerced `false`, and that
 * the mapping is total: a closed reason added to the gate cannot reach the
 * acceptance path without someone having written down its consequence. The last
 * one is enforced by the compiler; the check here is the runtime mirror of it, so
 * a mapping that drifts from the schema is caught even if a cast hides it.
 *
 * Run: node --test dist/task-admission/admission-mode-policy.spec.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TASK_ADMISSION_V2_CAPABILITY,
  TaskAdmissionV2GateClosedReasonSchema,
  type TaskAdmissionV2GateResult,
} from '@cap/contracts';

import {
  ADMISSION_GATE_ABSENT,
  ADMISSION_MODE_BY_OUTCOME,
  admissionCapabilityOutcome,
  isDegradedAdmission,
  resolveAdmissionMode,
} from '@/task-admission/admission-mode-policy';

const OPEN: TaskAdmissionV2GateResult = {
  capability: TASK_ADMISSION_V2_CAPABILITY,
  open: true,
  verifiedRoles: ['api', 'worker'],
};

function closed(
  reason: (typeof TaskAdmissionV2GateClosedReasonSchema.options)[number],
): TaskAdmissionV2GateResult {
  return {
    capability: TASK_ADMISSION_V2_CAPABILITY,
    open: false,
    reason,
    missingRoles: [],
  };
}

test('an open gate resolves to the durable pipeline', () => {
  const decision = resolveAdmissionMode(OPEN);
  assert.equal(decision.mode, 'durable-v2');
  assert.equal(decision.outcome, 'open');
  assert.equal(decision.capability, TASK_ADMISSION_V2_CAPABILITY);
  assert.equal(isDegradedAdmission(decision), false);
});

test('a closed gate resolves to legacy and carries the reason that closed it', () => {
  const decision = resolveAdmissionMode(closed('deployment_attestation_expired'));
  assert.equal(decision.mode, 'legacy');
  assert.equal(
    decision.outcome,
    'deployment_attestation_expired',
    'the reason must survive the decision — recovering it by reading the gate a second time is what this policy exists to avoid',
  );
  assert.equal(isDegradedAdmission(decision), true);
});

test('an absent gate provider is its own outcome, not a closed gate', () => {
  const decision = resolveAdmissionMode(undefined);
  assert.equal(decision.mode, 'legacy');
  assert.equal(decision.outcome, ADMISSION_GATE_ABSENT);
  assert.equal(
    TaskAdmissionV2GateClosedReasonSchema.options.includes(
      decision.outcome as never,
    ),
    false,
    'a dependency-injection regression must stay distinguishable from a gate the operator legitimately closed',
  );
});

test('every closed reason the gate can report resolves to legacy', () => {
  for (const reason of TaskAdmissionV2GateClosedReasonSchema.options) {
    const decision = resolveAdmissionMode(closed(reason));
    assert.equal(decision.mode, 'legacy', `reason ${reason} must resolve`);
    assert.equal(decision.outcome, reason);
  }
});

test('the mapping is total over the outcome union', () => {
  const expected = new Set<string>([
    'open',
    ADMISSION_GATE_ABSENT,
    ...TaskAdmissionV2GateClosedReasonSchema.options,
  ]);
  const actual = new Set(Object.keys(ADMISSION_MODE_BY_OUTCOME));
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    'the mapping and the gate schema must not drift: an unmapped reason would inherit an unstated consequence, and a mapped non-reason is dead',
  );
});

test('the outcome reduction is a pure reading of the gate result', () => {
  assert.equal(admissionCapabilityOutcome(OPEN), 'open');
  assert.equal(admissionCapabilityOutcome(closed('disabled')), 'disabled');
  assert.equal(admissionCapabilityOutcome(undefined), ADMISSION_GATE_ABSENT);
});

test('only the open outcome is undegraded', () => {
  const degraded = [
    ADMISSION_GATE_ABSENT,
    ...TaskAdmissionV2GateClosedReasonSchema.options,
  ];
  for (const outcome of degraded) {
    assert.equal(
      isDegradedAdmission({
        mode: ADMISSION_MODE_BY_OUTCOME[outcome],
        outcome,
        capability: TASK_ADMISSION_V2_CAPABILITY,
      }),
      true,
      `${outcome} is a degradation and must be attributable`,
    );
  }
});
