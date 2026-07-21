// Minimal ground-truth test for the runtime-model-catalog requirement:
// "Official upgrade seams keep the single-instance gate open across releases"
// (openspec/changes/automate-task-model-attestation-in-ci).
//
// Exercises, against the REAL generator + REAL gate/service code (no
// modification to evaluateTaskModelSelectionGate, verifyLocalProcess, or the
// contracts schema):
//   1. A single-instance deployment upgraded via an official seam serves the
//      catalog without a 503 (gate open, buildIdentity matches).
//   2. The next upgrade renews the attestation (new buildIdentity) and the
//      gate stays open with no manual re-attestation step.
//   3. A stale attestation from a bypassed seam (buildIdentity no longer
//      matches the running build) fails closed instead of opening the gate.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAttestation } from '../../../scripts/generate-task-model-attestation.mjs';
import {
  TASK_MODEL_SELECTION_ATTESTATION_ENV,
  TASK_MODEL_SELECTION_ENABLED_ENV,
  TaskModelCapabilityService,
} from '../dist/runtime-models/task-model-capability.service.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40); // bypassed-seam image, no matching attestation

function withEnv(values, run) {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('official upgrade seams keep the single-instance gate open across releases', () => {
  // --- Release vA is installed through an official seam (upgrade script / self-update) ---
  const attestationA = buildAttestation({
    version: 'v0.50.0',
    gitSha: SHA_A,
    compatVerified: true,
  });

  withEnv(
    {
      [TASK_MODEL_SELECTION_ENABLED_ENV]: '1',
      [TASK_MODEL_SELECTION_ATTESTATION_ENV]: JSON.stringify(attestationA),
      CAP_INSTANCE_ID: 'cap-api-1',
      GIT_SHA: SHA_A,
    },
    () => {
      const service = new TaskModelCapabilityService();
      const result = service.evaluate();
      assert.equal(result.open, true, 'scenario 1: gate must be open after vA official upgrade');
      assert.deepEqual(
        [...result.verifiedRoles].sort(),
        ['admission', 'api', 'runtime', 'scheduler'],
      );
      // "/v1/runtime-models/query does not recur to 503": assertOpen must not throw.
      assert.doesNotThrow(() => service.assertOpen());
    },
  );

  // --- Release vB is installed through an official seam: renewal rides the upgrade ---
  const attestationB = buildAttestation({
    version: 'v0.50.1',
    gitSha: SHA_B,
    compatVerified: true,
  });

  withEnv(
    {
      [TASK_MODEL_SELECTION_ENABLED_ENV]: '1',
      [TASK_MODEL_SELECTION_ATTESTATION_ENV]: JSON.stringify(attestationB),
      CAP_INSTANCE_ID: 'cap-api-1',
      GIT_SHA: SHA_B,
    },
    () => {
      const service = new TaskModelCapabilityService();
      const result = service.evaluate();
      assert.equal(
        result.open,
        true,
        'scenario 2: the next official upgrade must renew the gate without a manual re-attestation step',
      );
    },
  );

  // --- The api image is swapped OUTSIDE the official seams: the seam never renewed the attestation ---
  withEnv(
    {
      [TASK_MODEL_SELECTION_ENABLED_ENV]: '1',
      // Stale: still attestationB, but the running build is now SHA_C.
      [TASK_MODEL_SELECTION_ATTESTATION_ENV]: JSON.stringify(attestationB),
      CAP_INSTANCE_ID: 'cap-api-1',
      GIT_SHA: SHA_C,
    },
    () => {
      const service = new TaskModelCapabilityService();
      const result = service.evaluate();
      assert.equal(
        result.open,
        false,
        'scenario 3: a build-mismatched stale attestation must fail closed, not open the gate',
      );
      assert.equal(result.reason, 'worker_not_ready');
      assert.throws(() => service.assertOpen());
    },
  );
});
