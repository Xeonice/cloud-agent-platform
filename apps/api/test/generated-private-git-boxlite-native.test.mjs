import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  BoxLiteRestClient,
  BoxLiteSandboxProvider,
  InMemorySandboxRunOwnerStore,
  SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
  SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  SandboxProviderRouter,
  classifySandboxRuntimeCommandExecution,
  createBoxLiteRuntimePreflight,
  createExactHostGitCredential,
  createSandboxProvisioningDiagnosticEmitter,
  defineLocalSandboxProvider,
  deleteBoxLiteSandboxAndConfirm,
  materializeSandboxGitWorkspaceStaged,
  readBoxLiteProviderConfig,
} from '@cap/sandbox';
import { createGeneratedPrivateGitFixture } from '@cap/sandbox-conformance';

const LIVE_GATE = 'BOXLITE_NATIVE_PRIVATE_GIT_E2E';
const LIVE_ENABLED = process.env[LIVE_GATE] === '1';
const FIXTURE_HOST_ENV = 'BOXLITE_NATIVE_PRIVATE_GIT_FIXTURE_HOST';
const DEFAULT_FIXTURE_HOST = 'host.boxlite.internal';
const STORY_TIMEOUT_MS = 10 * 60_000;
const BOUNDARY_WATCHDOG_MS = 2 * 60_000;
const REQUIRED_CAPABILITIES = [
  'command.exec',
  'resource.disk-size-gb',
  'workspace.archive.transfer',
  'workspace.git.materialize',
];

class ObservedBoxLiteRestClient extends BoxLiteRestClient {
  constructor(config, forbiddenValues) {
    super({
      baseUrl: config.endpoint,
      apiToken: config.apiToken,
      timeoutMs: config.timeoutMs,
      protocolMode: config.protocolMode,
      pathPrefix: config.pathPrefix,
    });
    this.forbiddenValues = forbiddenValues;
    this.createRequests = [];
    this.execObservations = [];
    this.execObservationFailures = [];
    this.activeExecSettlements = new Set();
  }

  async createSandbox(request) {
    this.createRequests.push({
      taskId: request.taskId,
      sandboxId: request.sandboxId,
      diskSizeGb: request.diskSizeGb,
      source: request.rootfsPath ? 'rootfs' : 'image',
    });
    assertForbiddenValuesAbsent(
      JSON.stringify(this.createRequests.at(-1)),
      this.forbiddenValues,
      'BoxLite create request observation',
    );
    return super.createSandbox(request);
  }

  async exec(request) {
    assertForbiddenValuesAbsent(
      JSON.stringify({
        command: request.command,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
      }),
      this.forbiddenValues,
      'BoxLite exec request',
    );
    let settleExec;
    const settled = new Promise((resolve) => {
      settleExec = resolve;
    });
    this.activeExecSettlements.add(settled);
    try {
      const result = await super.exec(request);
      try {
        assertForbiddenValuesAbsent(
          JSON.stringify(result),
          this.forbiddenValues,
          'BoxLite exec result',
        );
      } catch (error) {
        this.execObservationFailures.push(error);
        throw error;
      }
      this.execObservations.push({
        command: request.command,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut === true,
      });
      return result;
    } finally {
      this.activeExecSettlements.delete(settled);
      settleExec();
    }
  }

  async waitForExecDrain() {
    await Promise.all([...this.activeExecSettlements]);
    assert.equal(this.activeExecSettlements.size, 0);
    assert.deepEqual(
      this.execObservationFailures,
      [],
      'late BoxLite execution results remain secret-free',
    );
  }
}

test(
  'gated native BoxLite settles cancel/runtime failure/retry diagnostics and durably reconciles a generated private Git workspace without leaks',
  { timeout: STORY_TIMEOUT_MS },
  async (t) => {
    if (!LIVE_ENABLED) {
      t.skip(
        `set ${LIVE_GATE}=1 with a disposable local/native BoxLite BOXLITE_* configuration`,
      );
      return;
    }

    const state = {
      fixture: null,
      client: null,
      provider: null,
      router: null,
      ownerStore: null,
      taskId: randomUUID(),
      storyPrefix: null,
      ownedSandboxIds: new Set(),
      baselineSandboxIds: new Set(),
      diagnosticHarnesses: [],
      forbiddenValues: [],
      rawProviderIds: new Set(),
      retainedSandboxId: null,
      retainedRun: false,
      retainedDiagnostics: null,
    };
    let storyFailure = null;

    try {
      await runLiveStory(t, state);
    } catch (error) {
      storyFailure = error;
    }

    let cleanupFailure = null;
    try {
      await cleanupLiveStory(state);
    } catch (error) {
      cleanupFailure = error;
    }

    if (storyFailure && cleanupFailure) {
      throw new AggregateError(
        [storyFailure, cleanupFailure],
        'Native BoxLite private Git story and cleanup both failed',
      );
    }
    if (storyFailure) throw storyFailure;
    if (cleanupFailure) throw cleanupFailure;
  },
);

async function runLiveStory(t, state) {
  const baseConfig = requireLiveConfig();
  const fixtureHost =
    process.env[FIXTURE_HOST_ENV]?.trim() || DEFAULT_FIXTURE_HOST;
  const storyPrefix = `cap-native-git-${randomUUID().slice(0, 8)}-`;
  state.storyPrefix = storyPrefix;
  const config = Object.freeze({
    ...baseConfig,
    providerId: `boxlite-native-git-${randomUUID().slice(0, 8)}`,
    sandboxIdPrefix: storyPrefix,
  });

  const fixture = await createGeneratedPrivateGitFixture({
    advertisedHost: fixtureHost,
  });
  state.fixture = fixture;
  const authorizationValue = fixture.basicAuth.authorizationHeader.replace(
    /^Authorization: /u,
    '',
  );
  const forbiddenValues = [
    fixture.basicAuth.password,
    authorizationValue,
    fixture.basicAuth.authorizationHeader,
  ];
  state.forbiddenValues = forbiddenValues;
  state.rawProviderIds.add(config.providerId);
  const client = new ObservedBoxLiteRestClient(config, forbiddenValues);
  state.client = client;
  for (const sandbox of await requireSandboxList(client)) {
    state.baselineSandboxIds.add(sandbox.id);
  }

  let failNextRuntimeSetup = true;
  const provider = new BoxLiteSandboxProvider({
    config,
    client,
    preflight: createBoxLiteRuntimePreflight({
      requiredTools: [
        'awk',
        'chmod',
        'chown',
        'df',
        'find',
        'git',
        'id',
        'sha256sum',
        'sh',
        'stat',
        'wc',
      ],
      commandTimeoutMs: config.timeoutMs,
    }),
    workspaceMaterialization: materializeSandboxGitWorkspaceStaged,
    runtimeSetup: async ({ executor, workspacePath }) => {
      const shouldFail = failNextRuntimeSetup;
      const classification = await classifySandboxRuntimeCommandExecution({
        executor,
        request: {
          command: shouldFail
            ? "sh -lc 'exit 23'"
            : "sh -lc 'test -d .git'",
          cwd: workspacePath,
          timeoutMs: config.timeoutMs,
        },
        descriptor: { commandKind: 'runtime_setup', ordinal: 1 },
      });
      if (shouldFail) {
        failNextRuntimeSetup = false;
        assert.deepEqual(
          {
            settlement: classification.settlement,
            outcome: classification.outcome,
            cause: classification.cause,
            exitCode: classification.exitCode,
          },
          {
            settlement: 'exit',
            outcome: 'failed',
            cause: 'command_failed',
            exitCode: 23,
          },
        );
        throw new Error('controlled native runtime setup failure');
      }
      assert.equal(classification.outcome, 'succeeded');
      assert.equal(classification.exitCode, 0);
    },
  });
  state.provider = provider;
  const ownerStore = new InMemorySandboxRunOwnerStore();
  const router = new SandboxProviderRouter(
    [
      defineLocalSandboxProvider({
        id: config.providerId,
        provider,
        capabilities: config.capabilities,
      }),
    ],
    { ownerStore },
  );
  state.ownerStore = ownerStore;
  state.router = router;

  const resources = Object.freeze({ diskSizeGb: config.diskSizeGb });
  const workspace = Object.freeze({
    repositoryUrl: fixture.rootUrl,
    callerBranch: null,
    resolvedBranch: fixture.defaultBranch,
    deadlineMs: config.gitCloneTimeoutMs,
    credential: createExactHostGitCredential(
      fixture.rootUrl,
      fixture.basicAuth.authorizationHeader,
    ),
  });
  assert.ok(
    workspace.deadlineMs > config.timeoutMs,
    'the Git workspace deadline must remain separate from the short BoxLite control timeout',
  );

  const cancelledTiming = createStageTimingRecorder('cancelled-attempt');
  const cancelledDisk = [];
  const cancelledDiagnostics = createLiveDiagnosticHarness(
    state.taskId,
    1,
    'cancelled-attempt',
  );
  state.diagnosticHarnesses.push(cancelledDiagnostics);
  const cancelledOwnership = createOwnershipFence();
  const sandboxIdsBeforeCancellation = new Set(state.ownedSandboxIds);
  const cancellation = new AbortController();
  fixture.transferBarrier.arm();
  const firstProvision = router.provision(
    createProvisionContext({
      state,
      resources,
      workspace,
      diagnostics: cancelledDiagnostics.diagnostics,
      ownership: cancelledOwnership,
      cancellationSignal: cancellation.signal,
      timing: cancelledTiming,
      diskSamples: cancelledDisk,
      attempt: 'cancelled-attempt',
    }),
  );

  await waitForTransferBarrierOrFailure(
    fixture,
    firstProvision,
    cancelledTiming,
  );
  const blockedDiagnostics = fixture.diagnostics();
  assert.equal(blockedDiagnostics.barrierState, 'blocked');
  assert.ok(blockedDiagnostics.rootUploadPackRequests.lsRefs >= 1);
  assert.ok(blockedDiagnostics.rootUploadPackRequests.fetch >= 1);
  assert.equal(cancelledDisk.length, 1, 'pre-transfer free space was recorded');
  cancellation.abort(
    new DOMException('cancel generated private Git transfer', 'AbortError'),
  );

  const firstFailure = await rejectedWithin(
    firstProvision,
    BOUNDARY_WATCHDOG_MS,
    'cancelled BoxLite provision did not settle',
  );
  await cancelledDiagnostics.diagnostics.flush();
  assert.equal(firstFailure?.name, 'AbortError');
  assert.ok(
    cancelledTiming.events.some(
      (event) =>
        event.stage === 'workspace_transfer' && event.status === 'cancelled',
    ),
    'workspace progress retains the typed cancellation stage',
  );
  const cancelledSandboxIds = new Set(
    [...state.ownedSandboxIds].filter(
      (sandboxId) => !sandboxIdsBeforeCancellation.has(sandboxId),
    ),
  );
  assert.ok(cancelledSandboxIds.size > 0, 'cancellation created one owned box');
  for (const sandboxId of cancelledSandboxIds) {
    state.rawProviderIds.add(sandboxId);
    assert.equal(
      await client.getSandbox(sandboxId),
      null,
      'cancellation fences and confirms the first sandbox absent',
    );
  }
  assertDiagnosticHarness(cancelledDiagnostics, {
    forbiddenValues,
    rawProviderIds: state.rawProviderIds,
  });
  assertDiagnosticTerminal(
    cancelledDiagnostics.events,
    (event) =>
      event.operation === 'repository_transfer' &&
      event.outcome === 'cancelled' &&
      event.cause === 'cancelled',
    'the slow repository transfer has one controlled cancellation outcome',
  );
  assertSeparateSuccessfulCleanup(cancelledDiagnostics.events);
  await assertDurableAttemptRemoved(router, ownerStore, state.taskId);
  fixture.transferBarrier.release();

  const runtimeFailureTiming = createStageTimingRecorder(
    'runtime-setup-failure',
  );
  const runtimeFailureDisk = [];
  const runtimeFailureDiagnostics = createLiveDiagnosticHarness(
    state.taskId,
    2,
    'runtime-setup-failure',
  );
  state.diagnosticHarnesses.push(runtimeFailureDiagnostics);
  const runtimeFailureOwnership = createOwnershipFence();
  const sandboxIdsBeforeRuntimeFailure = new Set(state.ownedSandboxIds);
  const runtimeFailure = await rejectedWithin(
    router.provision(
      createProvisionContext({
        state,
        resources,
        workspace,
        diagnostics: runtimeFailureDiagnostics.diagnostics,
        ownership: runtimeFailureOwnership,
        timing: runtimeFailureTiming,
        diskSamples: runtimeFailureDisk,
        attempt: 'runtime-setup-failure',
      }),
    ),
    BOUNDARY_WATCHDOG_MS,
    'controlled BoxLite runtime setup failure did not settle',
  );
  await runtimeFailureDiagnostics.diagnostics.flush();
  assert.deepEqual(
    {
      code: runtimeFailure?.code,
      stage: runtimeFailure?.stage,
      message: runtimeFailure?.message,
    },
    {
      code: 'sandbox_provisioning_stage_error',
      stage: 'runtime_setup',
      message: 'Sandbox provisioning failed during runtime_setup',
    },
  );
  assert.equal(
    JSON.stringify(runtimeFailure).includes('controlled native runtime setup failure'),
    false,
    'the provider-private runtime error does not cross the redaction boundary',
  );
  assert.equal(
    runtimeFailureDisk.length,
    1,
    'runtime-failure attempt records pre-transfer free space',
  );
  const runtimeFailureSandboxIds = new Set(
    [...state.ownedSandboxIds].filter(
      (sandboxId) => !sandboxIdsBeforeRuntimeFailure.has(sandboxId),
    ),
  );
  assert.ok(
    runtimeFailureSandboxIds.size > 0,
    'runtime setup failure created one owned box',
  );
  for (const sandboxId of runtimeFailureSandboxIds) {
    state.rawProviderIds.add(sandboxId);
    assert.equal(
      await client.getSandbox(sandboxId),
      null,
      'runtime failure cleanup confirms the owned box absent',
    );
  }
  assertDiagnosticHarness(runtimeFailureDiagnostics, {
    forbiddenValues,
    rawProviderIds: state.rawProviderIds,
  });
  const runtimeSettlement = assertDiagnosticTerminal(
    runtimeFailureDiagnostics.events,
    (event) =>
      event.operation === 'native_exec_settlement' &&
      event.commandKind === 'runtime_setup' &&
      event.outcome === 'failed',
    'native runtime setup has one proven failed settlement',
  );
  assert.deepEqual(
    {
      cause: runtimeSettlement.cause,
      exitCode: runtimeSettlement.exitCode,
    },
    { cause: 'command_failed', exitCode: 23 },
  );
  assertDiagnosticTerminal(
    runtimeFailureDiagnostics.events,
    (event) =>
      event.operation === 'runtime_setup' && event.outcome === 'failed',
    'the outer runtime setup operation remains the primary failure',
  );
  assertSeparateSuccessfulCleanup(runtimeFailureDiagnostics.events);
  await assertDurableAttemptRemoved(router, ownerStore, state.taskId);

  const successfulTiming = createStageTimingRecorder('successful-retry');
  const successfulDisk = [];
  const successfulDiagnostics = createLiveDiagnosticHarness(
    state.taskId,
    3,
    'successful-retry',
  );
  state.diagnosticHarnesses.push(successfulDiagnostics);
  const connection = await withinDeadline(
    router.provision(
      createProvisionContext({
        state,
        resources,
        workspace,
        diagnostics: successfulDiagnostics.diagnostics,
        ownership: createOwnershipFence(),
        timing: successfulTiming,
        diskSamples: successfulDisk,
        attempt: 'successful-retry',
      }),
    ),
    STORY_TIMEOUT_MS - 30_000,
    'BoxLite retry did not settle within the story deadline',
  );
  await successfulDiagnostics.diagnostics.flush();
  assert.equal(connection.taskId, state.taskId);
  state.retainedRun = true;
  state.retainedDiagnostics = successfulDiagnostics;

  const selected = await router.getSelectedSandboxRun(state.taskId);
  assert.ok(selected?.providerSandboxId, 'retry retains one selected sandbox');
  state.retainedSandboxId = selected.providerSandboxId;
  state.ownedSandboxIds.add(selected.providerSandboxId);
  state.rawProviderIds.add(selected.providerSandboxId);
  assert.equal(selected.providerId, config.providerId);
  assert.equal(selected.preflight?.status, 'passed');
  assert.equal(selected.workspace?.git.materialized, true);
  const retainedSandbox = await client.getSandbox(selected.providerSandboxId);
  assert.ok(retainedSandbox, 'selected BoxLite sandbox remains inspectable');
  if (retainedSandbox.diskSizeGb !== undefined) {
    assert.equal(retainedSandbox.diskSizeGb, resources.diskSizeGb);
  }

  const postDisk = await filesystemStats(client, selected.providerSandboxId);
  assert.equal(successfulDisk.length, 1, 'retry pre-transfer free space was recorded');
  assert.ok(
    successfulDisk[0].totalKiB >= minimumDiskKiB(resources.diskSizeGb),
    'created root filesystem is consistent with the requested disk before materialization',
  );
  assert.ok(postDisk.totalKiB >= minimumDiskKiB(resources.diskSizeGb));
  assert.ok(postDisk.availableKiB >= 0);

  assert.equal(
    client.createRequests.length,
    3,
    'cancel, runtime failure, and successful retry each create one box',
  );
  assert.ok(
    client.createRequests.every(
      (request) => request.diskSizeGb === resources.diskSizeGb,
    ),
    'native create receives the immutable resolved disk on every attempt',
  );

  await assertGeneratedWorkspace(
    client,
    selected.providerSandboxId,
    config.workspacePath,
    fixture,
  );
  await assertCredentialFilesAbsent(
    client,
    selected.providerSandboxId,
  );
  assertSuccessfulStageTimings(successfulTiming);
  assertDiagnosticHarness(successfulDiagnostics, {
    forbiddenValues,
    rawProviderIds: state.rawProviderIds,
  });
  const successfulRuntimeSettlement = assertDiagnosticTerminal(
    successfulDiagnostics.events,
    (event) =>
      event.operation === 'native_exec_settlement' &&
      event.commandKind === 'runtime_setup' &&
      event.outcome === 'succeeded',
    'successful retry records a proven native runtime settlement',
  );
  assert.equal(successfulRuntimeSettlement.exitCode, 0);
  assertAuthorizationIsolation(fixture);
  assert.equal(fixture.diagnostics().crossOriginAuthorizationLeakCount, 0);
  assertForbiddenValuesAbsent(
    JSON.stringify({
      progress: [
        cancelledTiming.events,
        runtimeFailureTiming.events,
        successfulTiming.events,
      ],
      diagnostics: state.diagnosticHarnesses.map((harness) => harness.events),
      createRequests: client.createRequests,
      execObservations: client.execObservations,
    }),
    forbiddenValues,
    'safe native BoxLite story observations',
  );

  t.diagnostic(
    JSON.stringify({
      requestedDiskSizeGb: resources.diskSizeGb,
      cancelledPreFreeKiB: cancelledDisk[0].availableKiB,
      runtimeFailurePreFreeKiB: runtimeFailureDisk[0].availableKiB,
      retryPreFreeKiB: successfulDisk[0].availableKiB,
      retryPostFreeKiB: postDisk.availableKiB,
      stageTimingsMs: successfulTiming.durations(),
    }),
  );
}

function createProvisionContext(args) {
  let sampled = false;
  return {
    taskId: args.state.taskId,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'headless-exec',
    ownership: args.ownership,
    diagnostics: args.diagnostics,
    resources: args.resources,
    workspace: args.workspace,
    cloneSpec: null,
    ...(args.cancellationSignal
      ? { cancellationSignal: args.cancellationSignal }
      : {}),
    onSandboxCreateObserved: async (observation) => {
      if (observation.kind !== 'created') return;
      args.state.ownedSandboxIds.add(observation.providerSandboxId);
      args.state.retainedSandboxId = observation.providerSandboxId;
    },
    onWorkspaceProgress: args.timing.report,
    beforeWorkspaceBoundary: async (event) => {
      if (
        sampled ||
        event.stage !== 'credential_setup' ||
        event.position !== 'before'
      ) {
        return;
      }
      const sandboxId = args.state.retainedSandboxId;
      assert.ok(sandboxId, `${args.attempt} must observe create before workspace`);
      args.diskSamples.push(await filesystemStats(args.state.client, sandboxId));
      sampled = true;
    },
  };
}

function createOwnershipFence() {
  return Object.freeze({
    ownerGeneration: randomUUID(),
    resourceGeneration: randomUUID(),
  });
}

function createLiveDiagnosticHarness(taskId, attempt, label) {
  const events = [];
  const diagnostics = createSandboxProvisioningDiagnosticEmitter({
    attemptContext: {
      schemaVersion: SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      taskId,
      attemptId: randomUUID(),
      attempt,
      admissionMode: 'durable',
      providerFamily: 'unknown',
    },
    record: async (event) => {
      events.push(event);
      return { kind: 'recorded', sequence: event.sequence };
    },
  });
  return { label, diagnostics, events };
}

function assertDiagnosticHarness(harness, options) {
  assert.ok(harness.events.length > 0, `${harness.label} records diagnostics`);
  assert.ok(
    harness.events.length <=
      SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT,
    `${harness.label} stays within the attempt-local diagnostic ceiling`,
  );
  assert.deepEqual(
    harness.events.map((event) => event.sequence),
    harness.events.map((_, index) => index + 1),
    `${harness.label} preserves one contiguous canonical sequence`,
  );

  const byOperationId = new Map();
  for (const event of harness.events) {
    const retained = byOperationId.get(event.operationId) ?? [];
    retained.push(event);
    byOperationId.set(event.operationId, retained);
  }
  for (const [operationId, events] of byOperationId) {
    assert.equal(
      events.filter((event) => event.outcome === 'started').length,
      1,
      `${harness.label}/${operationId} has exactly one start`,
    );
    assert.equal(
      events.filter((event) => event.outcome !== 'started').length,
      1,
      `${harness.label}/${operationId} has exactly one terminal`,
    );
  }

  const serialized = JSON.stringify(harness.events);
  assertForbiddenValuesAbsent(
    serialized,
    [...options.forbiddenValues, ...options.rawProviderIds],
    `${harness.label} diagnostic ledger`,
  );
  for (const forbiddenField of [
    'sandboxId',
    'resourceId',
    'providerId',
    'providerSandboxId',
    'executionId',
    'command',
    'args',
    'argv',
    'cwd',
    'stdout',
    'stderr',
    'output',
    'prompt',
    'path',
    'endpoint',
    'url',
    'body',
    'response',
    'error',
    'message',
    'stack',
    'headers',
  ]) {
    assert.equal(
      serialized.includes(`"${forbiddenField}":`),
      false,
      `${harness.label} excludes forbidden field ${forbiddenField}`,
    );
  }
}

function assertDiagnosticTerminal(events, predicate, message) {
  const matches = events.filter(
    (event) => event.outcome !== 'started' && predicate(event),
  );
  assert.equal(matches.length, 1, message);
  return matches[0];
}

function assertSeparateSuccessfulCleanup(events) {
  const cleanupTerminals = events.filter(
    (event) => event.channel === 'cleanup' && event.outcome !== 'started',
  );
  assert.ok(cleanupTerminals.length > 0, 'cleanup has its own diagnostic channel');
  assert.ok(
    cleanupTerminals.some(
      (event) =>
        (event.operation === 'sandbox_delete' ||
          event.operation === 'sandbox_absence_confirm') &&
        event.outcome === 'succeeded',
    ),
    'cleanup records confirmed physical settlement independently',
  );
}

async function assertDurableAttemptRemoved(router, ownerStore, taskId) {
  assert.equal(
    await ownerStore.getSandboxRunOwner(taskId),
    null,
    'failed attempt leaves no active durable owner',
  );
  const authority = await router.getSandboxCleanupAuthority(taskId);
  assert.equal(authority.state, 'succeeded');
  assert.equal(authority.status, 'removed');
  assert.equal(authority.lastAttemptOutcome, 'succeeded');
}

async function assertGeneratedWorkspace(client, sandboxId, workspacePath, fixture) {
  assert.equal(
    await execText(client, sandboxId, `git -C ${shellQuote(workspacePath)} branch --show-current`),
    fixture.defaultBranch,
  );
  assert.equal(
    await execText(
      client,
      sandboxId,
      `git -C ${shellQuote(workspacePath)} rev-parse --is-shallow-repository`,
    ),
    'false',
  );

  const mainRef = await client.exec({
    sandboxId,
    command: `git -C ${shellQuote(workspacePath)} show-ref --verify refs/heads/main`,
    timeoutMs: 30_000,
  });
  assert.notEqual(mainRef.exitCode, 0, 'the fixture must not fabricate main');
  assert.equal(
    await execText(client, sandboxId, `git -C ${shellQuote(workspacePath)} rev-parse HEAD`),
    fixture.headCommitSha,
  );
  await execChecked(
    client,
    sandboxId,
    `git -C ${shellQuote(workspacePath)} merge-base --is-ancestor ` +
      `${shellQuote(fixture.firstCommitSha)} HEAD`,
  );
  assert.ok(
    Number(
      await execText(
        client,
        sandboxId,
        `git -C ${shellQuote(workspacePath)} rev-list --count HEAD`,
      ),
    ) >= 3,
  );

  const blobPath = `${workspacePath}/${fixture.largeBlob.path}`;
  assert.equal(
    Number(await execText(client, sandboxId, `wc -c < ${shellQuote(blobPath)}`)),
    fixture.largeBlob.bytes,
  );
  assert.equal(
    await execText(
      client,
      sandboxId,
      `sha256sum -- ${shellQuote(blobPath)} | awk '{ print $1 }'`,
    ),
    fixture.largeBlob.sha256,
  );

  for (const submodulePath of [
    fixture.submodules.sameOriginPath,
    fixture.submodules.crossOriginPath,
  ]) {
    assert.equal(
      await execText(
        client,
        sandboxId,
        `git -C ${shellQuote(`${workspacePath}/${submodulePath}`)} ` +
          'rev-parse --is-inside-work-tree',
      ),
      'true',
    );
  }
}

async function assertCredentialFilesAbsent(client, sandboxId) {
  const scanCommand =
    "find / -xdev -type f -name 'cap-git-credential-*.config' " +
    '-print 2>/dev/null || :';
  const result = await execChecked(
    client,
    sandboxId,
    scanCommand,
  );
  assert.equal(result.stdout.trim(), '', 'retained sandbox has no Git credential file');
  const repeated = await execChecked(
    client,
    sandboxId,
    scanCommand,
  );
  assert.equal(
    repeated.stdout.trim(),
    '',
    'repeated retained-sandbox inspection confirms credential absence',
  );
}

function assertAuthorizationIsolation(fixture) {
  const evidence = fixture.authorizationEvidence();
  for (const repository of ['root-private', 'same-origin-private']) {
    const entries = evidence.filter((entry) => entry.repository === repository);
    assert.ok(entries.length > 0, `${repository} received authenticated Git traffic`);
    assert.ok(
      entries.every(
        (entry) => entry.authorizationReceived === true && entry.authorized === true,
      ),
      `${repository} accepts only the exact fixture credential`,
    );
  }
  const crossOrigin = evidence.filter(
    (entry) => entry.repository === 'cross-origin-public',
  );
  assert.ok(crossOrigin.length > 0, 'cross-origin submodule was fetched');
  assert.ok(
    crossOrigin.every(
      (entry) =>
        entry.authorizationReceived === false && entry.authorized === true,
    ),
    'parent credential never reaches the different-origin submodule',
  );
}

function createStageTimingRecorder(attempt) {
  const starts = new Map();
  const events = [];
  return {
    events,
    report(event) {
      const atMs = performance.now();
      const key = event.stage;
      if (event.status === 'started') starts.set(key, atMs);
      events.push({
        attempt,
        stage: event.stage,
        status: event.status,
        atMs,
        ...(starts.has(key) && event.status !== 'started'
          ? { durationMs: Math.max(0, atMs - starts.get(key)) }
          : {}),
      });
    },
    durations() {
      return events
        .filter((event) => event.durationMs !== undefined)
        .map((event) => ({
          stage: event.stage,
          status: event.status,
          durationMs: Math.round(event.durationMs),
        }));
    },
  };
}

function assertSuccessfulStageTimings(timing) {
  for (const stage of [
    'credential_setup',
    'remote_ref_resolution',
    'workspace_transfer',
    'checkout',
    'submodules',
    'credential_cleanup',
  ]) {
    assert.ok(
      timing.events.some(
        (event) => event.stage === stage && event.status === 'started',
      ),
      `${stage} has a start timing`,
    );
    assert.ok(
      timing.events.some(
        (event) =>
          event.stage === stage &&
          event.status === 'succeeded' &&
          Number.isFinite(event.durationMs),
      ),
      `${stage} has a successful duration`,
    );
  }
  assert.ok(
    timing.events.some(
      (event) => event.stage === 'complete' && event.status === 'succeeded',
    ),
    'successful retry reports completion',
  );
}

async function filesystemStats(client, sandboxId) {
  const output = await execText(
    client,
    sandboxId,
    "df -Pk / | awk 'NR == 2 { print $2, $4; found = 1 } " +
      "END { if (!found) exit 1 }'",
  );
  const [totalKiB, availableKiB, ...extra] = output.split(/\s+/u).map(Number);
  assert.equal(extra.length, 0, 'df returns exactly total and available KiB');
  assert.ok(Number.isSafeInteger(totalKiB) && totalKiB > 0);
  assert.ok(Number.isSafeInteger(availableKiB) && availableKiB >= 0);
  return { totalKiB, availableKiB };
}

async function execText(client, sandboxId, command) {
  const result = await execChecked(client, sandboxId, command);
  return result.stdout.trim();
}

async function execChecked(client, sandboxId, command) {
  const result = await client.exec({ sandboxId, command, timeoutMs: 30_000 });
  assert.equal(result.timedOut, false, 'BoxLite verification command did not time out');
  assert.equal(result.exitCode, 0, result.stderr || result.output);
  return result;
}

async function waitForTransferBarrierOrFailure(fixture, operation, timing) {
  const barrierAbort = new AbortController();
  const earlySettlement = operation.then(
    () => {
      throw new Error('BoxLite provision succeeded before the transfer barrier');
    },
    (error) => {
      throw new Error(
        `BoxLite provision failed before the transfer barrier: ${safeProvisionFailureSummary(
          error,
          timing,
        )}; fixture=${JSON.stringify(fixture.diagnostics())}`,
      );
    },
  );
  try {
    await withinDeadline(
      Promise.race([
        fixture.transferBarrier.waitUntilBlocked(barrierAbort.signal),
        earlySettlement,
      ]),
      BOUNDARY_WATCHDOG_MS,
      'generated Git transfer did not reach its controlled barrier',
    );
  } finally {
    barrierAbort.abort(new Error('barrier wait settled'));
  }
}

async function rejectedWithin(operation, timeoutMs, message) {
  const outcome = await withinDeadline(
    operation.then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error }),
    ),
    timeoutMs,
    message,
  );
  assert.equal(outcome.kind, 'rejected', 'operation must reject');
  return outcome.error;
}

function withinDeadline(operation, timeoutMs, message) {
  let timeout;
  const watchdog = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
  });
  return Promise.race([operation, watchdog]).finally(() => clearTimeout(timeout));
}

async function cleanupLiveStory(state) {
  const failures = [];
  state.fixture?.transferBarrier.release();

  if (state.router && state.ownerStore && state.retainedRun) {
    await collectCleanupFailure(failures, 'durable router teardown', async () => {
      const claim = await state.router.claimSandboxCleanupOwnership(
        state.taskId,
        randomUUID(),
      );
      assert.equal(claim.kind, 'authorized');
      const first = await state.router.teardownSandbox(state.taskId, {
        cleanupAuthorization: claim.authorization,
        disposition: 'superseded-remove',
        ...(state.retainedDiagnostics
          ? { diagnostics: state.retainedDiagnostics.diagnostics }
          : {}),
      });
      assert.equal(first.outcome, 'succeeded');
      assert.ok(
        first.proof === 'found-and-cleaned' || first.proof === 'already-absent',
      );
      await state.retainedDiagnostics?.diagnostics.flush();
      const replay = await state.router.claimSandboxCleanupOwnership(
        state.taskId,
        randomUUID(),
      );
      assert.equal(replay.kind, 'settled');
      const authority = await state.router.getSandboxCleanupAuthority(
        state.taskId,
      );
      assert.equal(authority.state, 'succeeded');
      assert.equal(authority.status, 'removed');
      assert.equal(authority.lastAttemptOutcome, 'succeeded');
      assert.deepEqual(
        await state.ownerStore.listActiveSandboxRunOwners(),
        [],
        'durable reconciliation leaves no active owner',
      );
      if (state.retainedDiagnostics) {
        assertDiagnosticHarness(state.retainedDiagnostics, {
          forbiddenValues: state.forbiddenValues,
          rawProviderIds: state.rawProviderIds,
        });
        assertSeparateSuccessfulCleanup(state.retainedDiagnostics.events);
      }
      const repeated = await state.router.teardownSandbox(state.taskId, {
        cleanupAuthorization:
          claim.authorization,
        disposition: 'superseded-remove',
        ...(state.retainedDiagnostics
          ? { diagnostics: state.retainedDiagnostics.diagnostics }
          : {}),
      });
      assert.equal(repeated.outcome, 'succeeded');
      assert.ok(
        repeated.proof === 'found-and-cleaned' ||
          repeated.proof === 'already-absent',
      );
      state.retainedRun = false;
    });
  }

  if (state.client) {
    for (const sandboxId of state.ownedSandboxIds) {
      await collectCleanupFailure(
        failures,
        `tracked sandbox cleanup ${sandboxId}`,
        async () => {
          if ((await state.client.getSandbox(sandboxId)) !== null) {
            await deleteBoxLiteSandboxAndConfirm({
              client: state.client,
              sandboxId,
            });
          }
        },
      );
    }
    await collectCleanupFailure(
      failures,
      'story-prefix sandbox cleanup',
      async () => {
        assert.ok(state.storyPrefix, 'live story records its sandbox prefix');
        const candidates = (await requireSandboxList(state.client)).filter(
          (sandbox) =>
            !state.baselineSandboxIds.has(sandbox.id) &&
            sandbox.id.startsWith(state.storyPrefix),
        );
        for (const sandbox of candidates) {
          await deleteBoxLiteSandboxAndConfirm({
            client: state.client,
            sandboxId: sandbox.id,
          });
        }
      },
    );
    await collectCleanupFailure(failures, 'BoxLite execution drain', async () => {
      await withinDeadline(
        state.client.waitForExecDrain(),
        BOUNDARY_WATCHDOG_MS,
        'cancelled BoxLite execution did not drain after sandbox cleanup',
      );
    });
  }

  if (state.fixture) {
    await collectCleanupFailure(failures, 'fixture disposal', async () => {
      await state.fixture.dispose();
      const diagnostics = state.fixture.diagnostics();
      assert.equal(diagnostics.disposed, true);
      assert.equal(diagnostics.barrierState, 'disposed');
      assert.equal(diagnostics.activeRequests, 0);
      assert.equal(diagnostics.activeBackendProcesses, 0);
    });
  }

  if (state.client) {
    await collectCleanupFailure(failures, 'BoxLite baseline verification', async () => {
      const finalIds = new Set(
        (await requireSandboxList(state.client)).map((sandbox) => sandbox.id),
      );
      for (const baselineId of state.baselineSandboxIds) {
        assert.ok(finalIds.has(baselineId), 'story cleanup preserves baseline boxes');
      }
      const addedIds = [...finalIds].filter(
        (sandboxId) => !state.baselineSandboxIds.has(sandboxId),
      );
      assert.deepEqual(addedIds, [], 'story leaves zero new/probe BoxLite boxes');
    });
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Native BoxLite story cleanup failed: ${failures
        .map((failure) => failure.label)
        .join(', ')}`,
    );
  }
}

async function collectCleanupFailure(failures, label, cleanup) {
  try {
    await cleanup();
  } catch (error) {
    failures.push({ label, error });
  }
}

async function requireSandboxList(client) {
  assert.equal(
    typeof client.listSandboxes,
    'function',
    'native BoxLite story requires sandbox listing for baseline-safe cleanup',
  );
  return client.listSandboxes();
}

function requireLiveConfig() {
  const result = readBoxLiteProviderConfig(process.env);
  if (result.status === 'disabled') {
    throw new Error(`${LIVE_GATE}=1 requires BoxLite configuration: ${result.reason}`);
  }
  if (result.status === 'invalid') {
    throw new Error(
      `${LIVE_GATE}=1 has invalid BOXLITE_* configuration: ${result.errors.join('; ')}`,
    );
  }
  const config = result.config;
  if (config.protocolMode !== 'native') {
    throw new Error(`${LIVE_GATE}=1 requires BOXLITE_PROTOCOL_MODE=native`);
  }
  if (config.location !== 'local') {
    throw new Error(`${LIVE_GATE}=1 requires BOXLITE_PROVIDER_LOCATION=local`);
  }
  const endpointHost = new URL(config.endpoint).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpointHost)) {
    throw new Error(
      `${LIVE_GATE}=1 refuses a non-loopback BoxLite endpoint; use a disposable local daemon`,
    );
  }
  const missing = REQUIRED_CAPABILITIES.filter(
    (capability) => !config.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new Error(
      `${LIVE_GATE}=1 requires BOXLITE_CAPABILITIES to include: ${missing.join(', ')}`,
    );
  }
  if (config.gitCloneTimeoutMs <= config.timeoutMs) {
    throw new Error(
      `${LIVE_GATE}=1 requires BOXLITE_GIT_CLONE_TIMEOUT_MS greater than BOXLITE_TIMEOUT_MS`,
    );
  }
  return config;
}

function minimumDiskKiB(diskSizeGb) {
  return Math.floor(diskSizeGb * 1024 * 1024 * 0.9);
}

function assertForbiddenValuesAbsent(serialized, forbiddenValues, location) {
  for (const forbidden of forbiddenValues) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `${location} must not contain generated credential material`,
    );
  }
}

function safeErrorName(error) {
  if (!(error instanceof Error)) return 'NonError';
  return [
    'AbortError',
    'Error',
    'SandboxProviderConfigurationError',
    'SandboxWorkspaceMaterializationError',
    'TypeError',
  ].includes(error.name)
    ? error.name
    : 'Error';
}

function safeProvisionFailureSummary(error, timing) {
  const failure =
    error &&
    typeof error === 'object' &&
    error.failure &&
    typeof error.failure === 'object'
      ? error.failure
      : null;
  const typedFailure = failure
    ? {
        status: safeFailureField(failure.status),
        stage: safeFailureField(failure.stage),
        ...(failure.cause === undefined
          ? {}
          : { cause: safeFailureField(failure.cause) }),
        ...(typeof failure.retryable === 'boolean'
          ? { retryable: failure.retryable }
          : {}),
      }
    : { name: safeErrorName(error) };
  return JSON.stringify({
    failure: typedFailure,
    progress: timing.events.map((event) => ({
      stage: event.stage,
      status: event.status,
    })),
  });
}

function safeFailureField(value) {
  return typeof value === 'string' && /^[a-z_]+$/u.test(value)
    ? value
    : 'unknown';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}
