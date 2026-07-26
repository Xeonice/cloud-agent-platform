import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createCurrentTerminalAttachFrame,
  negotiateTerminalAttach,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
} from '../packages/contracts/dist/index.js';
import {
  N_MINUS_ONE_TERMINAL_BUILD,
  createNMinusOneTerminalAttachFrame,
  negotiateNMinusOneTerminalAttach,
  parseNMinusOneTerminalAttachFrame,
} from './fixtures/terminal-coordinated-rollback/n-minus-one-adapter.mjs';
import { runTerminalCoordinatedRollbackCanary } from './terminal-coordinated-rollback-canary.mjs';

test('versioned N-1 fixture is canonical, independent, and never claims historical provenance', () => {
  const profile = N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(profile.descriptor))
    .digest('hex');
  assert.equal(profile.fingerprint, fingerprint);
  assert.equal(
    profile.id,
    `xterm-response-v1-sha256-${fingerprint}`,
  );
  assert.equal(
    N_MINUS_ONE_TERMINAL_BUILD.provenance.kind,
    'versioned-compatibility-fixture',
  );
  assert.equal(
    N_MINUS_ONE_TERMINAL_BUILD.provenance.historicalReleaseArtifact,
    false,
  );
  assert.notEqual(profile.id, XTERM_5_5_0_RESPONSE_PROFILE_ID);
});

test('current and N-1 wire adapters negotiate independently and fail drift closed', () => {
  const current = createCurrentTerminalAttachFrame(100, 30);
  const prior = createNMinusOneTerminalAttachFrame(100, 30);

  assert.equal(negotiateTerminalAttach(current).ok, true);
  assert.equal(negotiateNMinusOneTerminalAttach(prior).ok, true);

  const priorAgainstCurrent = negotiateTerminalAttach(prior);
  assert.equal(priorAgainstCurrent.ok, false);
  assert.equal(priorAgainstCurrent.frame.reason, 'response_profile_mismatch');
  assert.equal(priorAgainstCurrent.frame.reloadRequired, true);

  const currentAgainstPrior = negotiateNMinusOneTerminalAttach(current);
  assert.equal(currentAgainstPrior.ok, false);
  assert.equal(currentAgainstPrior.frame.reason, 'response_profile_mismatch');
  assert.equal(currentAgainstPrior.frame.reloadRequired, true);

  const protocolDrift = negotiateNMinusOneTerminalAttach({
    ...prior,
    protocolVersion: 2,
  });
  assert.equal(protocolDrift.ok, false);
  assert.equal(protocolDrift.frame.reason, 'protocol_mismatch');
  assert.equal(protocolDrift.frame.reloadRequired, true);

  for (const descriptor of [
    {
      ...N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile.descriptor,
      xtermVersion: '5.4.1',
    },
    {
      ...N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile.descriptor,
      windowOptions: {
        ...N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile.descriptor.windowOptions,
        getWinSizeChars: true,
      },
    },
    {
      ...N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile.descriptor,
      responseAffectingAddons: [
        {
          ...N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile.descriptor
            .responseAffectingAddons[0],
          version: '0.7.1',
        },
      ],
    },
  ]) {
    const driftFingerprint = createHash('sha256')
      .update(JSON.stringify(descriptor))
      .digest('hex');
    const profileDrift = negotiateNMinusOneTerminalAttach({
      ...prior,
      responseProfileId: `xterm-response-v1-sha256-${driftFingerprint}`,
    });
    assert.equal(profileDrift.ok, false);
    assert.equal(profileDrift.frame.reason, 'response_profile_mismatch');
    assert.equal(profileDrift.frame.reloadRequired, true);
  }

  assert.throws(() => parseNMinusOneTerminalAttachFrame({ ...prior, extra: true }));
});

test(
  'real Gateway/session-engine coordinated rollback preserves detached tmux identity',
  { skip: process.env.CAP_TERMINAL_ROLLBACK_CANARY !== '1', timeout: 30_000 },
  async () => {
    const evidence = await runTerminalCoordinatedRollbackCanary({ enabled: true });
    assert.equal(evidence.result, 'passed');
    assert.deepEqual(evidence.phases, [
      'current-n-attached',
      'current-api-old-web-reload-required',
      'prior-api-current-web-reload-required',
      'coordinated-n-minus-one-attach-only',
      'current-restored-attach-only',
    ]);
    assert.ok(evidence.taskIdentity.panePid > 1);
    assert.ok(evidence.taskIdentity.cliPid > 1);
    assert.match(evidence.taskIdentity.cliSelfStartTicks, /^\d+$/u);
    if (process.platform === 'linux') {
      assert.match(evidence.taskIdentity.cliKernelStartTicks, /^\d+$/u);
    } else {
      assert.equal(evidence.taskIdentity.cliKernelStartTicks, null);
    }
    assert.equal(evidence.buildCleanups.length, 3);
    assert.ok(evidence.buildCleanups.every((cleanup) => cleanup.kind === 'confirmed'));
    assert.deepEqual(
      {
        cliPidGone: evidence.taskCleanup.cliPidGone,
        panePidGone: evidence.taskCleanup.panePidGone,
        sessionAbsent: evidence.taskCleanup.sessionAbsent,
        socketAbsent: evidence.taskCleanup.socketAbsent,
      },
      {
      cliPidGone: true,
      panePidGone: true,
      sessionAbsent: true,
      socketAbsent: true,
      },
    );
    assert.equal(typeof evidence.taskCleanup.staleSocketRemoved, 'boolean');
  },
);
