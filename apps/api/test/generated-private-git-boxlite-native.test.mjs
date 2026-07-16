import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  BoxLiteRestClient,
  BoxLiteSandboxProvider,
  createBoxLiteRuntimePreflight,
  createExactHostGitCredential,
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
  'gated native BoxLite cancels and retries a generated large private Git workspace without leaks',
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
      taskId: `private-git-${randomUUID().slice(0, 8)}`,
      storyPrefix: null,
      ownedSandboxIds: new Set(),
      baselineSandboxIds: new Set(),
      retainedSandboxId: null,
      retainedRun: false,
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
  const client = new ObservedBoxLiteRestClient(config, forbiddenValues);
  state.client = client;
  for (const sandbox of await requireSandboxList(client)) {
    state.baselineSandboxIds.add(sandbox.id);
  }

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
  });
  state.provider = provider;

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
  const cancellation = new AbortController();
  fixture.transferBarrier.arm();
  const firstProvision = provider.provision(
    createProvisionContext({
      state,
      resources,
      workspace,
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
  assert.equal(firstFailure?.name, 'AbortError');
  assert.ok(
    cancelledTiming.events.some(
      (event) =>
        event.stage === 'workspace_transfer' && event.status === 'cancelled',
    ),
    'workspace progress retains the typed cancellation stage',
  );
  const cancelledSandboxIds = new Set(state.ownedSandboxIds);
  for (const sandboxId of cancelledSandboxIds) {
    assert.equal(
      await client.getSandbox(sandboxId),
      null,
      'cancellation fences and confirms the first sandbox absent',
    );
  }
  fixture.transferBarrier.release();

  const successfulTiming = createStageTimingRecorder('successful-retry');
  const successfulDisk = [];
  const connection = await withinDeadline(
    provider.provision(
      createProvisionContext({
        state,
        resources,
        workspace,
        timing: successfulTiming,
        diskSamples: successfulDisk,
        attempt: 'successful-retry',
      }),
    ),
    STORY_TIMEOUT_MS - 30_000,
    'BoxLite retry did not settle within the story deadline',
  );
  assert.equal(connection.taskId, state.taskId);
  state.retainedRun = true;

  const selected = await provider.getSelectedSandboxRun(state.taskId);
  assert.ok(selected?.providerSandboxId, 'retry retains one selected sandbox');
  state.retainedSandboxId = selected.providerSandboxId;
  state.ownedSandboxIds.add(selected.providerSandboxId);
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

  assert.equal(client.createRequests.length, 2, 'cancel and retry each create one box');
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
  assertAuthorizationIsolation(fixture);
  assert.equal(fixture.diagnostics().crossOriginAuthorizationLeakCount, 0);
  assertForbiddenValuesAbsent(
    JSON.stringify({
      progress: [cancelledTiming.events, successfulTiming.events],
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

  if (state.provider && state.retainedRun) {
    await collectCleanupFailure(failures, 'provider teardown', async () => {
      const first = await state.provider.teardownSandbox(state.taskId, {
        ...(state.retainedSandboxId
          ? { providerSandboxId: state.retainedSandboxId }
          : {}),
      });
      assert.equal(first.kind, 'found-and-cleaned');
      const repeated = await state.provider.teardownSandbox(state.taskId, {
        ...(state.retainedSandboxId
          ? { providerSandboxId: state.retainedSandboxId }
          : {}),
      });
      assert.equal(repeated.kind, 'already-absent');
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
