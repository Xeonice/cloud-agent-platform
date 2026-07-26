#!/usr/bin/env node

import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import {
  AioTerminalTransport,
  createAioHttpCommandExecutor,
  currentAioTerminalProcessFingerprint,
  deleteAioTerminalOwnershipRecordFilesExact,
  releaseAioTerminalGuestPairExact,
  sweepAioStaleTerminalSessions,
} from '../packages/sandbox-provider-aio/dist/index.js';
import { deleteAioShellSessionExact } from '../packages/sandbox-provider-aio/dist/aio-shell-exec.js';

const ENDPOINT_ENV = 'CAP_AIO_PAIR_CANARY_ENDPOINT';
const SCOPE_ENV = 'CAP_AIO_PAIR_CANARY_SCOPE';
const WORKER_MODE = '--pair-owner-worker';
const FOCUSED_MODE = '--focused-release';
const WAIT_TIMEOUT_MS = 15_000;
const TRANSPORT_CLEANUP_TIMEOUT_MS = 35_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TTY_PATTERN = /^\/dev\/pts\/[0-9]+$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,18}$/u;
const JOURNAL_PATH_PATTERN =
  /^\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner$/u;

export class PairCanaryError extends Error {
  constructor(code) {
    super('AIO pair canary failed');
    this.code = code;
  }
}

export function normalizePairCanaryEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PairCanaryError('endpoint-unavailable');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PairCanaryError('endpoint-invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PairCanaryError('endpoint-invalid');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

export function validatePairCanaryEvidence(evidence) {
  const required = [
    'ownerSigkillObserved',
    'stalePairSwept',
    'oldGuestFingerprintsAbsent',
    'oldTaskClientAbsent',
    'unrelatedTerminalResponsive',
    'unrelatedClientStable',
    'businessPaneStable',
    'newAttachResponsive',
    'providerMetadataAbsent',
    'journalRecordAbsent',
    'journalMaterialOpaque',
    'temporaryTransportsCleaned',
    'canaryResourcesCleaned',
  ];
  for (const field of required) {
    if (evidence?.[field] !== true) {
      throw new PairCanaryError(`evidence-${field}`);
    }
  }
  if (!Number.isSafeInteger(evidence.sweepMs) || evidence.sweepMs < 0) {
    throw new PairCanaryError('evidence-sweep-timing');
  }
  return Object.freeze({
    result: 'PASS',
    ownerSigkillObserved: true,
    stalePairSwept: true,
    oldGuestFingerprintsAbsent: true,
    oldTaskClientAbsent: true,
    unrelatedTerminalResponsive: true,
    unrelatedClientStable: true,
    businessPaneStable: true,
    newAttachResponsive: true,
    providerMetadataAbsent: true,
    journalRecordAbsent: true,
    journalMaterialOpaque: true,
    temporaryTransportsCleaned: true,
    canaryResourcesCleaned: true,
    sweepMs: evidence.sweepMs,
  });
}

export function safePairCanaryFailure(error) {
  return Object.freeze({
    result: 'FAIL',
    stage: error instanceof PairCanaryError ? error.code : 'unexpected',
  });
}

export function safePairCanarySignalResult(signal, resourcesCleaned) {
  if (
    (signal !== 'SIGINT' && signal !== 'SIGTERM') ||
    typeof resourcesCleaned !== 'boolean'
  ) {
    throw new TypeError('invalid pair canary signal result');
  }
  return Object.freeze({
    result: 'INTERRUPTED',
    signal,
    resourcesCleaned,
  });
}

export function installPairCanarySignalCleanup({ cleanup, target = process }) {
  if (typeof cleanup !== 'function') {
    throw new TypeError('pair canary signal cleanup requires a function');
  }
  let cleanupPromise;
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (cleanupPromise) return;
      const exitCode = signal === 'SIGINT' ? 130 : 143;
      cleanupPromise = Promise.resolve()
        .then(() => cleanup(signal))
        .catch(() => false)
        .finally(() => target.exit(exitCode));
    };
    handlers.set(signal, handler);
    target.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      target.removeListener(signal, handler);
    }
  };
}

async function cleanupWorker(state) {
  if (state.ownershipObserver) {
    clearInterval(state.ownershipObserver);
    state.ownershipObserver = undefined;
  }
  if (!state.transport) return true;
  const transport = state.transport;
  state.transport = null;
  return closeTransportExact(transport).catch(() => false);
}

async function runWorker(state) {
  let transport;
  let pairPublished = false;
  let recordPathPublished = false;
  try {
    const endpoint = normalizePairCanaryEndpoint(process.env[ENDPOINT_ENV]);
    const scope = JSON.parse(process.env[SCOPE_ENV] ?? 'null');
    assertScope(scope);
    const executor = createExecutor(endpoint, scope.taskId);
    transport = new AioTerminalTransport(
      scope.taskId,
      terminalWebSocketUrl(endpoint),
      {
        baseUrl: endpoint,
        enableOpaqueInput: true,
        ownershipScope: scope,
        handshakeTimeoutMs: WAIT_TIMEOUT_MS,
      },
    );
    state.transport = transport;
    state.ownershipObserver = setInterval(() => {
      try {
        if (!pairPublished && transport?.cleanupPair) {
          assertPair(transport.cleanupPair);
          process.send?.({ type: 'pair', pair: transport.cleanupPair });
          pairPublished = true;
        }
        if (!recordPathPublished && transport?.ownershipRecordPath) {
          assert(
            JOURNAL_PATH_PATTERN.test(transport.ownershipRecordPath),
            'worker-journal-path',
          );
          process.send?.({
            type: 'journal',
            recordPath: transport.ownershipRecordPath,
          });
          recordPathPublished = true;
        }
      } catch {
        // The transport failure path below owns shutdown and bounded reporting.
      }
    }, 5);
    await waitForTransportReady(transport);
    const pair = transport.cleanupPair;
    const recordPath = transport.ownershipRecordPath;
    assertPair(pair);
    assert(JOURNAL_PATH_PATTERN.test(recordPath), 'worker-journal-path');
    process.send?.({ type: 'ownership', pair, recordPath });
    pairPublished = true;
    recordPathPublished = true;
    clearInterval(state.ownershipObserver);
    state.ownershipObserver = undefined;
    assert(
      transport.sendInput(
        `tmux attach-session -t '=task${scope.taskId}'\n`,
      ),
      'worker-attach-write',
    );
    await waitForClientCount(executor, `task${scope.taskId}`, 1);
    process.send?.({ type: 'ready' });
    await new Promise(() => undefined);
  } catch (error) {
    await cleanupWorker(state);
    process.send?.({
      type: 'failed',
      code: error instanceof PairCanaryError ? error.code : 'worker-unexpected',
    });
    process.exitCode = 1;
  }
}

async function runParent(endpoint, state) {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const taskId = `pair-${nonce}`;
  const unrelatedTaskId = `peer-${nonce}`;
  const taskSessionName = `task${taskId}`;
  const unrelatedSessionName = `task${unrelatedTaskId}`;
  const scope = {
    taskId,
    providerSandboxId: `canary-${randomUUID()}`,
    ownership: {
      ownerGeneration: randomUUID(),
      resourceGeneration: randomUUID(),
    },
  };
  Object.assign(state, {
    endpoint,
    scope,
    taskId,
    unrelatedTaskId,
    taskSessionName,
    unrelatedSessionName,
  });
  const executor = createExecutor(endpoint, taskId);
  state.executor = executor;

  await createBusinessSession(executor, taskSessionName);
  await createBusinessSession(executor, unrelatedSessionName);
  const businessPaneBefore = await readPaneIdentity(
    executor,
    taskSessionName,
  );

  state.unrelatedTransport = await openAttachedTransport({
    endpoint,
    taskId: unrelatedTaskId,
    sessionName: unrelatedSessionName,
    executor,
    onCreated: (transport) => {
      state.unrelatedTransport = transport;
    },
    onPair: (pair) => {
      state.unrelatedPair = pair;
    },
  });
  const unrelatedPair = state.unrelatedPair;
  assertPair(unrelatedPair);
  await assertPairFingerprintsPresent(executor, unrelatedPair);
  const unrelatedClientBefore = await readSingleClientIdentity(
    executor,
    unrelatedSessionName,
  );

  state.worker = fork(fileURLToPath(import.meta.url), [WORKER_MODE], {
    env: {
      ...process.env,
      [ENDPOINT_ENV]: endpoint,
      [SCOPE_ENV]: JSON.stringify(scope),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await waitForWorkerReady(state.worker, state);
  assertPair(state.workerPair);
  assert(
    JOURNAL_PATH_PATTERN.test(state.recordPath),
    'parent-journal-path',
  );
  await waitForClientCount(executor, taskSessionName, 1);
  await assertPairFingerprintsPresent(executor, state.workerPair);
  const journalContent = await execOutput(
    executor,
    `cat '${state.recordPath}'`,
    'journal-read',
  );
  const journalMaterialOpaque = journalDoesNotExposeMaterial({
    endpoint,
    pair: state.workerPair,
    content: journalContent.trim(),
  });
  assert(journalMaterialOpaque, 'journal-material');

  const workerExit = waitForChildExit(state.worker, WAIT_TIMEOUT_MS);
  state.worker.kill('SIGKILL');
  const exit = await workerExit;
  state.worker = null;
  assert(exit.signal === 'SIGKILL', 'worker-sigkill');
  await waitForClientCount(executor, taskSessionName, 1);
  await waitForClientCount(executor, unrelatedSessionName, 1);
  await assertPairFingerprintsPresent(executor, state.workerPair);

  const sweepStartedAt = Date.now();
  state.releaseTrace = [];
  state.releaseNonces = [];
  const sweep = await sweepAioStaleTerminalSessions({
    fetch,
    baseUrl: endpoint,
    scope,
    processFingerprint: currentAioTerminalProcessFingerprint(),
    timing: {
      exactReleaseTimeoutMs: 20_000,
      reconnectOutputMaxBytes: 4 * 1024 * 1024,
      cleanupAttemptTimeoutMs: 3_000,
      cleanupRetryDelayMs: 25,
      requestTimeoutMs: 3_000,
    },
    reconnectSocketFactory: createCanaryReconnectSocketFactory(state),
    releaseMarkerFactory: () => {
      const nonce = randomUUID().replaceAll('-', '');
      state.releaseNonces.push(nonce);
      return nonce;
    },
    guestPairReleaser: async (releaseArgs) => {
      const settlement = await releaseAioTerminalGuestPairExact(releaseArgs);
      state.sweepReleaseSettlement = settlement;
      return settlement;
    },
  });
  const sweepMs = Date.now() - sweepStartedAt;
  assertConfirmedSweep(
    sweep,
    state.sweepReleaseSettlement,
    summarizeReleaseTrace(state.releaseTrace),
  );

  await waitForClientCount(executor, taskSessionName, 0);
  await assertPairFingerprintsAbsent(executor, state.workerPair);
  const metadataProofs = await Promise.all([
    deleteAioShellSessionExact(
      fetch,
      endpoint,
      state.workerPair.mainSessionId,
      { retryDelayMs: 25 },
    ),
    deleteAioShellSessionExact(
      fetch,
      endpoint,
      state.workerPair.injectorSessionId,
      { retryDelayMs: 25 },
    ),
  ]);
  const providerMetadataAbsent = metadataProofs.every(
    (proof) => proof === 'already-absent',
  );
  assert(providerMetadataAbsent, 'metadata-survived');
  const journalRecordAbsent = await fileAbsent(
    executor,
    state.recordPath,
  );
  assert(journalRecordAbsent, 'journal-survived');
  state.pairCleanupConfirmed = true;

  const businessPaneAfterSweep = await readPaneIdentity(
    executor,
    taskSessionName,
  );
  const businessPaneStable = businessPaneAfterSweep === businessPaneBefore;
  assert(businessPaneStable, 'business-pane-changed');
  await waitForClientCount(executor, unrelatedSessionName, 1);
  const unrelatedClientAfter = await readSingleClientIdentity(
    executor,
    unrelatedSessionName,
  );
  const unrelatedClientStable =
    unrelatedClientAfter === unrelatedClientBefore;
  assert(unrelatedClientStable, 'peer-client-changed');
  await assertPairFingerprintsPresent(executor, unrelatedPair);
  const unrelatedTerminalResponsive = await sendTransportMarker(
    state.unrelatedTransport,
    `CAP_AIO_PAIR_PEER_${nonce}`,
  );
  assert(unrelatedTerminalResponsive, 'peer-terminal-unresponsive');

  state.newTransport = await openAttachedTransport({
    endpoint,
    taskId,
    sessionName: taskSessionName,
    executor,
    onCreated: (transport) => {
      state.newTransport = transport;
    },
    onPair: (pair) => {
      state.newPair = pair;
    },
  });
  const newAttachResponsive = await sendTransportMarker(
    state.newTransport,
    `CAP_AIO_PAIR_NEW_${nonce}`,
  );
  assert(newAttachResponsive, 'new-terminal-unresponsive');
  const businessPaneAfterAttach = await readPaneIdentity(
    executor,
    taskSessionName,
  );
  assert(businessPaneAfterAttach === businessPaneBefore, 'business-pane-replaced');

  const newCleanup = await closeTransportExact(state.newTransport);
  state.newTransport = null;
  const peerCleanup = await closeTransportExact(state.unrelatedTransport);
  state.unrelatedTransport = null;
  const temporaryTransportsCleaned = newCleanup && peerCleanup;
  assert(temporaryTransportsCleaned, 'temporary-transport-cleanup');
  await assertPairFingerprintsAbsent(executor, unrelatedPair);

  return {
    ownerSigkillObserved: true,
    stalePairSwept: true,
    oldGuestFingerprintsAbsent: true,
    oldTaskClientAbsent: true,
    unrelatedTerminalResponsive,
    unrelatedClientStable,
    businessPaneStable,
    newAttachResponsive,
    providerMetadataAbsent,
    journalRecordAbsent,
    journalMaterialOpaque,
    temporaryTransportsCleaned,
    canaryResourcesCleaned: false,
    sweepMs,
  };
}

async function runFocusedRelease(endpoint, state) {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const taskId = `focus-${nonce}`;
  const taskSessionName = `task${taskId}`;
  const scope = {
    taskId,
    providerSandboxId: `canary-${randomUUID()}`,
    ownership: {
      ownerGeneration: randomUUID(),
      resourceGeneration: randomUUID(),
    },
  };
  Object.assign(state, {
    endpoint,
    scope,
    taskId,
    taskSessionName,
  });
  const executor = createExecutor(endpoint, taskId);
  state.executor = executor;
  await createBusinessSession(executor, taskSessionName);
  state.worker = fork(fileURLToPath(import.meta.url), [WORKER_MODE], {
    env: {
      ...process.env,
      [ENDPOINT_ENV]: endpoint,
      [SCOPE_ENV]: JSON.stringify(scope),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await waitForWorkerReady(state.worker, state);
  assertPair(state.workerPair);
  await waitForClientCount(executor, taskSessionName, 1);
  await assertPairFingerprintsPresent(executor, state.workerPair);

  const workerExit = waitForChildExit(state.worker, WAIT_TIMEOUT_MS);
  state.worker.kill('SIGKILL');
  const exit = await workerExit;
  state.worker = null;
  assert(exit.signal === 'SIGKILL', 'worker-sigkill');
  await waitForClientCount(executor, taskSessionName, 1);
  await assertPairFingerprintsPresent(executor, state.workerPair);

  state.releaseTrace = [];
  state.releaseNonces = [];
  state.releaseHttpTrace = [];
  const release = await releaseAioTerminalGuestPairExact({
    fetch: createCanaryReleaseFetch(state),
    baseUrl: endpoint,
    taskId,
    pair: state.workerPair,
    timeoutMs: 20_000,
    maxOutputBytes: 4 * 1024 * 1024,
    socketFactory: createCanaryReconnectSocketFactory(state),
    markerFactory: () => {
      const releaseNonce = randomUUID().replaceAll('-', '');
      state.releaseNonces.push(releaseNonce);
      return releaseNonce;
    },
  });
  if (release.kind === 'confirmed') {
    await waitForClientCount(executor, taskSessionName, 0);
    await assertPairFingerprintsAbsent(executor, state.workerPair);
    const metadataProofs = await Promise.all([
      deleteAioShellSessionExact(
        fetch,
        endpoint,
        state.workerPair.mainSessionId,
      ),
      deleteAioShellSessionExact(
        fetch,
        endpoint,
        state.workerPair.injectorSessionId,
      ),
    ]);
    assert(
      metadataProofs.every(
        (proof) => proof === 'deleted' || proof === 'already-absent',
      ),
      'focused-metadata-survived',
    );
    await deleteAioTerminalOwnershipRecordFilesExact({
      fetch,
      baseUrl: endpoint,
      paths: [state.recordPath],
    });
    state.pairCleanupConfirmed = true;
  }
  return release;
}

async function cleanupCanary(state) {
  if (state.worker) {
    const exit = waitForChildExit(state.worker, 2_000).catch(() => null);
    state.worker.kill('SIGKILL');
    await exit;
    state.worker = null;
  }
  for (const key of ['newTransport', 'unrelatedTransport']) {
    const transport = state[key];
    if (!transport) continue;
    await closeTransportExact(transport).catch(() => false);
    state[key] = null;
  }

  if (state.executor) {
    for (const name of [state.taskSessionName, state.unrelatedSessionName]) {
      if (!name) continue;
      await killBusinessSessionExact(state.executor, name).catch(() => false);
    }
  }
  await cleanupKnownPairs(state).catch(() => false);
  await cleanupKnownScope(state).catch(() => false);
  return verifyCanaryResourcesAbsent(state).catch(() => false);
}

async function cleanupKnownPairs(state) {
  const pairs = [
    {
      pair: state.workerPair,
      taskId: state.scope?.taskId,
      recordPath: state.recordPath,
    },
    { pair: state.newPair, taskId: state.taskId },
    { pair: state.unrelatedPair, taskId: state.unrelatedTaskId },
  ].filter((entry) => entry.pair && entry.taskId);
  let confirmed = true;
  for (const entry of pairs) {
    confirmed =
      (await ensurePairResourcesAbsent(state, entry).catch(() => false)) &&
      confirmed;
  }
  return confirmed;
}

async function ensurePairResourcesAbsent(state, entry) {
  let fingerprintsAbsent = await pairFingerprintsAbsent(
    state.executor,
    entry.pair,
  );
  if (!fingerprintsAbsent) {
    const release = await releaseAioTerminalGuestPairExact({
      fetch,
      baseUrl: state.endpoint,
      taskId: entry.taskId,
      pair: entry.pair,
      timeoutMs: 20_000,
    });
    if (release.kind !== 'confirmed') {
      await terminateCanaryPairExact(state.executor, entry.pair);
    }
    fingerprintsAbsent = await pairFingerprintsAbsent(
      state.executor,
      entry.pair,
    );
  }
  if (!fingerprintsAbsent) return false;
  await Promise.all([
    deleteAioShellSessionExact(fetch, state.endpoint, entry.pair.mainSessionId),
    deleteAioShellSessionExact(
      fetch,
      state.endpoint,
      entry.pair.injectorSessionId,
    ),
  ]);
  if (entry.recordPath) {
    await deleteAioTerminalOwnershipRecordFilesExact({
      fetch,
      baseUrl: state.endpoint,
      paths: [entry.recordPath],
    });
  }
  return true;
}

async function terminateCanaryPairExact(executor, pair) {
  assertPair(pair);
  const marker = '__cap_pair_cleanup_hup__';
  const command = [
    `cap_boot=$(cat /proc/sys/kernel/random/boot_id)`,
    `[ "$cap_boot" = '${pair.main.bootId}' ]`,
    `[ "$cap_boot" = '${pair.injector.bootId}' ]`,
    fingerprintHupShell(pair.main, 'cap_main'),
    fingerprintHupShell(pair.injector, 'cap_injector'),
    `printf '${marker}\n'`,
  ].join(' && ');
  const output = await execOutput(executor, command, 'pair-cleanup-hup');
  assert(output.trim() === marker, 'pair-cleanup-hup');
  await waitForCondition(() => pairFingerprintsAbsent(executor, pair));
}

function fingerprintHupShell(fingerprint, prefix) {
  return (
    `if [ -e '/proc/${fingerprint.pid}/stat' ]; then ` +
    `${prefix}_stat=$(cat '/proc/${fingerprint.pid}/stat') || exit 74; ` +
    `${prefix}_tail=\${${prefix}_stat##*) }; set -- $${prefix}_tail; ` +
    `${prefix}_tty=$(readlink '/proc/${fingerprint.pid}/fd/0' 2>/dev/null || true); ` +
    `if [ "\${3}" = '${fingerprint.pgid}' ] && [ "\${4}" = '${fingerprint.sid}' ] && ` +
    `[ "\${20}" = '${fingerprint.startTime}' ] && [ "$${prefix}_tty" = '${fingerprint.tty}' ]; then ` +
    `[ ! -s '/proc/${fingerprint.pid}/task/${fingerprint.pid}/children' ] || exit 75; ` +
    `kill -HUP '${fingerprint.pid}' || exit 76; fi; fi`
  );
}

async function cleanupKnownScope(state) {
  if (!state.endpoint || !state.scope) return true;
  const settlement = await sweepAioStaleTerminalSessions({
    fetch,
    baseUrl: state.endpoint,
    scope: state.scope,
    processFingerprint: currentAioTerminalProcessFingerprint(),
    timing: {
      exactReleaseTimeoutMs: 20_000,
      reconnectOutputMaxBytes: 4 * 1024 * 1024,
      cleanupAttemptTimeoutMs: 3_000,
      cleanupRetryDelayMs: 25,
      requestTimeoutMs: 3_000,
    },
  });
  return settlement.kind === 'confirmed';
}

async function verifyCanaryResourcesAbsent(state) {
  if (state.worker) return false;
  if (state.executor) {
    for (const name of [state.taskSessionName, state.unrelatedSessionName]) {
      if (name && !(await businessSessionAbsent(state.executor, name))) {
        return false;
      }
    }
    for (const pair of [state.workerPair, state.newPair, state.unrelatedPair]) {
      if (pair && !(await pairFingerprintsAbsent(state.executor, pair))) {
        return false;
      }
    }
  }
  if (state.recordPath && !(await fileAbsent(state.executor, state.recordPath))) {
    return false;
  }
  const scopeCleanup = await cleanupKnownScope(state);
  return scopeCleanup;
}

function createExecutor(endpoint, taskId) {
  return createAioHttpCommandExecutor({ baseUrl: endpoint, taskId });
}

function terminalWebSocketUrl(endpoint) {
  const url = new URL(endpoint);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/shell/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function createCanaryReleaseFetch(state) {
  return async (input, init) => {
    const requestUrl = new URL(String(input));
    const category = classifyReleaseProbeRequest(requestUrl, init);
    const response = await fetch(input, init);
    if (category) {
      const body = await response.clone().json().catch(() => undefined);
      state.releaseHttpTrace.push(
        Object.freeze({
          category,
          httpOk: response.ok,
          status: response.status,
          success: body?.success === true,
          executionStatus:
            typeof body?.data?.status === 'string'
              ? body.data.status
              : 'invalid',
          exitCode: Number.isSafeInteger(body?.data?.exit_code)
            ? body.data.exit_code
            : null,
          result: classifyReleaseProbeResult(body),
        }),
      );
    }
    return response;
  };
}

function classifyReleaseProbeRequest(url, init) {
  if (url.pathname !== '/v1/shell/exec' || init?.method !== 'POST') return null;
  let command = '';
  try {
    command = JSON.parse(String(init.body)).command ?? '';
  } catch {
    return 'invalid';
  }
  if (command.includes('__cap_exact_owner_tty_absent__')) return 'owner-release';
  if (
    command.includes('__cap_exact_guest_present__') &&
    command.includes('__cap_exact_guest_absent__')
  ) {
    return 'classify';
  }
  if (command.includes('__cap_exact_guest_absent__')) return 'absence';
  return 'other';
}

function classifyReleaseProbeResult(body) {
  const values = [body?.data?.stdout, body?.data?.output, body?.data?.stderr]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim());
  if (values.includes('__cap_exact_guest_present__')) return 'present';
  if (values.includes('__cap_exact_guest_absent__')) return 'absent';
  if (values.includes('__cap_exact_owner_tty_absent__')) return 'owner-released';
  return 'other';
}

function createCanaryReconnectSocketFactory(state) {
  return (url, role) => {
    const socket = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 });
    const expectedNonce = state.releaseNonces.at(-1);
    const expectedMarker =
      typeof expectedNonce === 'string'
        ? `CAP_AIO_${role === 'main' ? 'MAIN' : 'INJECTOR'}_EXIT_${expectedNonce}`
        : '';
    const diagnosticPattern =
      role === 'injector' && typeof expectedNonce === 'string'
        ? new RegExp(
            `CAP_AIO_INJECTOR_DIAG_([A-Z_]{2,32})_${expectedNonce}(?:\\r?\\n|\\r)`,
            'u',
          )
        : null;
    const trace = {
      role,
      open: false,
      restored: false,
      sessionId: false,
      sent: false,
      outputAfterSend: false,
      loopReleased: false,
      loopFailed: false,
      shellError: false,
      promptLike: false,
      marker: false,
      failureStage: null,
      close: false,
      error: false,
      buffer: '',
    };
    state.releaseTrace.push(trace);
    socket.on('open', () => {
      trace.open = true;
    });
    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        return;
      }
      if (frame?.type === 'terminal_restored') trace.restored = true;
      if (frame?.type === 'session_id') trace.sessionId = true;
      if (
        trace.sent &&
        (frame?.type === 'output' || frame?.type === 'restore_output') &&
        typeof frame.data === 'string'
      ) {
        trace.outputAfterSend = true;
        trace.buffer = (trace.buffer + frame.data).slice(-4_096);
        const diagnosticMatch = diagnosticPattern?.exec(trace.buffer);
        if (diagnosticMatch?.[1]) trace.failureStage = diagnosticMatch[1];
        if (
          typeof state.workerPair?.releaseMarker === 'string' &&
          trace.buffer.includes(state.workerPair.releaseMarker)
        ) {
          trace.loopReleased = true;
        }
        if (trace.buffer.includes('CAP_AIO_INJECTOR_FAILED_')) {
          trace.loopFailed = true;
        }
        if (
          /command not found|syntax error|bad file descriptor|permission denied|No such file/iu.test(
            trace.buffer,
          )
        ) {
          trace.shellError = true;
        }
        if (/(?:^|\r?\n)[^\r\n]{0,160}[$#] ?$/u.test(trace.buffer)) {
          trace.promptLike = true;
        }
        const normalized = trace.buffer.replace(/\r\n|\r/gu, '\n');
        if (
          expectedMarker.length > 0 &&
          normalized.includes(`\n${expectedMarker}\n`)
        ) {
          trace.marker = true;
        }
      }
    });
    socket.on('close', () => {
      trace.close = true;
    });
    socket.on('error', () => {
      trace.error = true;
    });
    return {
      get readyState() {
        return socket.readyState;
      },
      on(event, listener) {
        socket.on(event, listener);
      },
      send(data, callback) {
        trace.sent = true;
        socket.send(data, callback);
      },
      close() {
        socket.close();
      },
      terminate() {
        socket.terminate();
      },
    };
  };
}

function summarizeReleaseTrace(traces) {
  if (!Array.isArray(traces) || traces.length === 0) return 'none';
  return traces
    .slice(0, 2)
    .map(
      (trace) =>
        `${trace.role === 'main' ? 'm' : 'i'}` +
        `${trace.open ? 'o' : 'x'}` +
        `${trace.restored ? 'r' : 'x'}` +
        `${trace.sessionId ? 'n' : 'x'}` +
        `${trace.sent ? 's' : 'x'}` +
        `${trace.outputAfterSend ? 'd' : 'x'}` +
        `${trace.loopReleased ? 'l' : 'x'}` +
        `${trace.loopFailed ? 'f' : 'x'}` +
        `${trace.shellError ? 'h' : 'x'}` +
        `${trace.promptLike ? 'p' : 'x'}` +
        `${trace.marker ? 'k' : 'x'}` +
        `${trace.close ? 'c' : 'x'}` +
        `${trace.error ? 'e' : 'x'}`,
    )
    .join('-');
}

async function createBusinessSession(executor, sessionName) {
  const result = await executor.exec({
    command:
      `tmux kill-session -t '=${sessionName}' 2>/dev/null || true; ` +
      `tmux new-session -d -s '${sessionName}' 'exec bash --noprofile --norc'`,
    timeoutMs: 5_000,
  });
  assertResult(result, 'business-session-create');
}

async function killBusinessSessionExact(executor, sessionName) {
  const result = await executor.exec({
    command:
      `if tmux has-session -t '=${sessionName}' 2>/dev/null; then ` +
      `tmux kill-session -t '=${sessionName}' || exit 70; fi; ` +
      strictTmuxSessionAbsentShell(sessionName, '__cap_tmux_absent__'),
    timeoutMs: 5_000,
  });
  assertResult(result, 'business-session-cleanup');
  assert(
    (result.stdout || result.output).trim() === '__cap_tmux_absent__',
    'business-session-cleanup',
  );
}

async function businessSessionAbsent(executor, sessionName) {
  const marker = '__cap_tmux_absent__';
  const result = await executor.exec({
    command: strictTmuxSessionAbsentShell(sessionName, marker),
    timeoutMs: 5_000,
  });
  return (
    !result.timedOut &&
    result.exitCode === 0 &&
    (result.stdout || result.output).trim() === marker
  );
}

function strictTmuxSessionAbsentShell(sessionName, marker) {
  return (
    `cap_sessions=$(LC_ALL=C tmux list-sessions -F '#{session_name}' 2>&1); ` +
    `cap_tmux_status=$?; ` +
    `if [ "$cap_tmux_status" -eq 0 ]; then ` +
    `if printf '%s\n' "$cap_sessions" | grep -Fqx -- '${sessionName}'; then exit 71; fi; ` +
    `elif [ "$cap_tmux_status" -eq 1 ]; then ` +
    `case "$cap_sessions" in 'no server running on '*) ;; *) exit 72 ;; esac; ` +
    `else exit 73; fi; printf '${marker}\n'`
  );
}

async function openAttachedTransport(args) {
  const transport = new AioTerminalTransport(
    args.taskId,
    terminalWebSocketUrl(args.endpoint),
    {
      baseUrl: args.endpoint,
      enableOpaqueInput: true,
      handshakeTimeoutMs: WAIT_TIMEOUT_MS,
    },
  );
  args.onCreated?.(transport);
  try {
    await waitForTransportReady(transport);
    const pair = transport.cleanupPair;
    assertPair(pair);
    args.onPair?.(pair);
    assert(
      transport.sendInput(`tmux attach-session -t '=${args.sessionName}'\n`),
      'transport-attach-write',
    );
    await waitForClientCount(args.executor, args.sessionName, 1);
    return transport;
  } catch (error) {
    await closeTransportExact(transport).catch(() => false);
    throw error;
  }
}

function waitForTransportReady(transport) {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => settle(() => reject(new PairCanaryError('transport-ready-timeout'))),
      WAIT_TIMEOUT_MS,
    );
    const settle = (continuation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      continuation();
    };
    transport.onFrame((frame) => {
      if (frame.type === 'ready') settle(resolveReady);
    });
    transport.onError(() =>
      settle(() => reject(new PairCanaryError('transport-error'))),
    );
    transport.onClose(() =>
      settle(() => reject(new PairCanaryError('transport-close'))),
    );
  });
}

async function sendTransportMarker(transport, marker) {
  const seen = waitForTransportMarker(transport, marker);
  const boundary = marker.lastIndexOf('_');
  const prefix = marker.slice(0, boundary + 1);
  const nonce = marker.slice(boundary + 1);
  if (
    !transport.sendInput(
      `printf '\\r\\n${prefix}%s\\r\\n' '${nonce}'\n`,
    )
  ) {
    return false;
  }
  return seen;
}

function waitForTransportMarker(transport, marker) {
  return new Promise((resolveMarker, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new PairCanaryError('marker-timeout')),
      WAIT_TIMEOUT_MS,
    );
    transport.onFrame((frame) => {
      if (frame.type !== 'output' || typeof frame.data !== 'string') return;
      buffer = (buffer + frame.data).slice(-16_384);
      const normalized = buffer.replace(/\r\n|\r/gu, '\n');
      if (!normalized.includes(`\n${marker}\n`)) return;
      clearTimeout(timer);
      resolveMarker(true);
    });
  });
}

async function closeTransportExact(transport) {
  transport.close();
  const settlement = await withTimeout(
    transport.cleanupDecision,
    TRANSPORT_CLEANUP_TIMEOUT_MS,
    'transport-cleanup-timeout',
  );
  return settlement.kind === 'confirmed';
}

function waitForWorkerReady(child, state) {
  return withTimeout(
    new Promise((resolveReady, reject) => {
      child.on('message', (message) => {
        try {
          if (message?.type === 'pair' || message?.type === 'ownership') {
            assertPair(message.pair);
            state.workerPair = message.pair;
          }
          if (message?.type === 'journal' || message?.type === 'ownership') {
            assert(
              JOURNAL_PATH_PATTERN.test(message.recordPath),
              'worker-journal-path',
            );
            state.recordPath = message.recordPath;
          }
          if (message?.type === 'ready') {
            assertPair(state.workerPair);
            assert(
              JOURNAL_PATH_PATTERN.test(state.recordPath),
              'worker-journal-path',
            );
            resolveReady();
          }
          if (message?.type === 'failed') {
            reject(new PairCanaryError(message.code ?? 'worker-failed'));
          }
        } catch {
          reject(new PairCanaryError('worker-evidence-invalid'));
        }
      });
      child.once('exit', () =>
        reject(new PairCanaryError('worker-exited-before-ready')),
      );
      child.once('error', () =>
        reject(new PairCanaryError('worker-start-failed')),
      );
    }),
    WAIT_TIMEOUT_MS,
    'worker-ready-timeout',
  );
}

function waitForChildExit(child, timeoutMs) {
  return withTimeout(
    new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    }),
    timeoutMs,
    'worker-exit-timeout',
  );
}

async function waitForClientCount(executor, sessionName, expected) {
  await waitForCondition(async () => {
    const output = await execOutput(
      executor,
      `cap_clients=$(tmux list-clients -t '=${sessionName}' -F '#{client_tty}') || exit 71; ` +
        `printf '%s\\n' "$cap_clients" | awk 'NF { count += 1 } END { print count + 0 }'`,
      'client-count',
    );
    return Number.parseInt(output.trim(), 10) === expected;
  });
}

async function readPaneIdentity(executor, sessionName) {
  const output = await execOutput(
    executor,
    `tmux display-message -p -t '=${sessionName}:' '#{pane_id}|#{pane_pid}|#{pane_start_command}'`,
    'pane-identity',
  );
  const value = output.trim();
  assert(value.length > 5 && value.length < 2_048, 'pane-identity-invalid');
  return value;
}

async function readSingleClientIdentity(executor, sessionName) {
  const output = await execOutput(
    executor,
    `tmux list-clients -t '=${sessionName}' -F '#{client_tty}|#{client_pid}|#{client_session}'`,
    'client-identity',
  );
  const identities = output
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  assert(identities.length === 1, 'client-identity-count');
  const [tty, pid, attachedSession, ...extra] = identities[0].split('|');
  assert(
    TTY_PATTERN.test(tty) &&
      POSITIVE_INTEGER_PATTERN.test(pid) &&
      attachedSession === sessionName &&
      extra.length === 0,
    'client-identity-invalid',
  );
  return identities[0];
}

async function assertPairFingerprintsPresent(executor, pair) {
  const marker = '__cap_pair_fingerprints_present__';
  const command = [
    `cap_boot=$(cat /proc/sys/kernel/random/boot_id)`,
    `[ "$cap_boot" = '${pair.main.bootId}' ]`,
    `[ "$cap_boot" = '${pair.injector.bootId}' ]`,
    fingerprintPresentShell(pair.main, 'cap_main'),
    fingerprintPresentShell(pair.injector, 'cap_injector'),
    `printf '${marker}\\n'`,
  ].join(' && ');
  const output = await execOutput(executor, command, 'fingerprints-present');
  assert(output.trim() === marker, 'fingerprints-not-present');
}

async function assertPairFingerprintsAbsent(executor, pair) {
  const marker = '__cap_pair_fingerprints_absent__';
  const command = [
    `cap_boot=$(cat /proc/sys/kernel/random/boot_id)`,
    `[ "$cap_boot" = '${pair.main.bootId}' ]`,
    `[ "$cap_boot" = '${pair.injector.bootId}' ]`,
    fingerprintAbsentShell(pair.main, 'cap_main'),
    fingerprintAbsentShell(pair.injector, 'cap_injector'),
    `printf '${marker}\\n'`,
  ].join(' && ');
  const output = await execOutput(executor, command, 'fingerprints-absent');
  assert(output.trim() === marker, 'fingerprints-still-present');
}

async function pairFingerprintsAbsent(executor, pair) {
  if (!executor) return false;
  try {
    await assertPairFingerprintsAbsent(executor, pair);
    return true;
  } catch {
    return false;
  }
}

function fingerprintPresentShell(fingerprint, prefix) {
  return [
    `[ -e '/proc/${fingerprint.pid}/stat' ]`,
    `${prefix}_stat=$(cat '/proc/${fingerprint.pid}/stat')`,
    `${prefix}_tail=\${${prefix}_stat##*) }`,
    `set -- $${prefix}_tail`,
    `[ "\${3}" = '${fingerprint.pgid}' ]`,
    `[ "\${4}" = '${fingerprint.sid}' ]`,
    `[ "\${20}" = '${fingerprint.startTime}' ]`,
    `${prefix}_tty=$(readlink '/proc/${fingerprint.pid}/fd/0')`,
    `[ "$${prefix}_tty" = '${fingerprint.tty}' ]`,
  ].join(' && ');
}

function fingerprintAbsentShell(fingerprint, prefix) {
  return (
    `if [ -e '/proc/${fingerprint.pid}/stat' ]; then ` +
    `${prefix}_stat=$(cat '/proc/${fingerprint.pid}/stat') || exit 72; ` +
    `${prefix}_tail=\${${prefix}_stat##*) }; set -- $${prefix}_tail; ` +
    `${prefix}_tty=$(readlink '/proc/${fingerprint.pid}/fd/0' 2>/dev/null || true); ` +
    `if [ "\${3}" = '${fingerprint.pgid}' ] && [ "\${4}" = '${fingerprint.sid}' ] && ` +
    `[ "\${20}" = '${fingerprint.startTime}' ] && [ "$${prefix}_tty" = '${fingerprint.tty}' ]; then exit 73; fi; ` +
    'fi'
  );
}

function assertConfirmedSweep(settlement, releaseSettlement, trace) {
  if (settlement.kind !== 'confirmed') {
    const releaseCause =
      releaseSettlement?.kind === 'indeterminate'
        ? releaseSettlement.cause
        : releaseSettlement?.kind === 'confirmed'
          ? 'confirmed'
          : 'unobserved';
    throw new PairCanaryError(
      `sweep-${settlement.cause}-release-${releaseCause}-trace-${trace}`,
    );
  }
  assert(settlement.staleRecords === 1, 'sweep-stale-count');
  assert(settlement.confirmedIdentities === 2, 'sweep-identity-count');
  assert(settlement.removedRecords === 1, 'sweep-record-count');
}

function journalDoesNotExposeMaterial({ endpoint, pair, content }) {
  if (!/^cap-aio-terminal-v2:/u.test(content)) return false;
  const candidates = [
    pair.mainSessionId,
    pair.injectorSessionId,
    pair.closeToken,
    pair.releaseMarker,
    ...endpointCredentialCanaries(endpoint),
  ];
  return candidates.every(
    (candidate) => candidate.length < 8 || !content.includes(candidate),
  );
}

function endpointCredentialCanaries(endpoint) {
  const url = new URL(endpoint);
  const values = [url.username, url.password];
  for (const value of url.searchParams.values()) values.push(value);
  return values.filter((value) => value.length > 0);
}

async function fileAbsent(executor, path) {
  const marker = '__cap_pair_journal_absent__';
  const output = await execOutput(
    executor,
    `[ ! -e '${path}' ] && printf '${marker}\\n'`,
    'journal-absence',
  );
  return output.trim() === marker;
}

async function execOutput(executor, command, code) {
  const result = await executor.exec({ command, timeoutMs: 5_000 });
  assertResult(result, code);
  return typeof result.stdout === 'string' && result.stdout.length > 0
    ? result.stdout
    : result.output;
}

function assertResult(result, code) {
  assert(!result.timedOut && result.exitCode === 0, code);
}

async function waitForCondition(condition) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(50);
  }
  throw new PairCanaryError('condition-timeout');
}

function withTimeout(promise, timeoutMs, code) {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new PairCanaryError(code)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      () => {
        clearTimeout(timer);
        reject(new PairCanaryError(code));
      },
    );
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assertScope(scope) {
  assert(
    scope &&
      typeof scope.taskId === 'string' &&
      /^[A-Za-z0-9_.-]+$/u.test(scope.taskId) &&
      typeof scope.providerSandboxId === 'string' &&
      typeof scope.ownership?.ownerGeneration === 'string' &&
      typeof scope.ownership?.resourceGeneration === 'string',
    'scope-invalid',
  );
}

function assertPair(pair) {
  assert(pair && typeof pair === 'object', 'pair-invalid');
  assert(UUID_PATTERN.test(pair.mainSessionId), 'pair-main-id');
  assert(UUID_PATTERN.test(pair.injectorSessionId), 'pair-injector-id');
  assert(
    pair.mainSessionId.slice(0, 8) !== pair.injectorSessionId.slice(0, 8),
    'pair-prefix-collision',
  );
  for (const fingerprint of [pair.main, pair.injector]) {
    assert(TTY_PATTERN.test(fingerprint?.tty), 'pair-tty');
    for (const field of ['pid', 'sid', 'pgid', 'startTime']) {
      assert(POSITIVE_INTEGER_PATTERN.test(fingerprint?.[field]), 'pair-process');
    }
    assert(UUID_PATTERN.test(fingerprint?.bootId), 'pair-boot');
  }
}

function sanitizedFocusedTrace(state) {
  return Object.freeze({
    trace: summarizeReleaseTrace(state.releaseTrace),
    releaseFailureStage:
      (state.releaseTrace ?? []).find((trace) => trace.failureStage)
        ?.failureStage ?? null,
    mainShellIsSessionLeader:
      state.workerPair?.main?.pid === state.workerPair?.main?.sid,
    injectorShellIsSessionLeader:
      state.workerPair?.injector?.pid === state.workerPair?.injector?.sid,
    releaseHttpTrace: Object.freeze([...(state.releaseHttpTrace ?? [])]),
  });
}

async function runFocusedMode(state) {
  let release;
  let failure;
  try {
    const endpoint = normalizePairCanaryEndpoint(process.env[ENDPOINT_ENV]);
    release = await runFocusedRelease(endpoint, state);
  } catch (error) {
    failure = error;
  }
  const trace = sanitizedFocusedTrace(state);
  const resourcesCleaned = await cleanupCanary(state).catch(() => false);
  if (state.signalExitCode) return;
  if (failure) {
    console.log(
      JSON.stringify({
        ...safePairCanaryFailure(failure),
        ...trace,
        resourcesCleaned,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const passed = release?.kind === 'confirmed' && resourcesCleaned;
  console.log(
    JSON.stringify({
      result: passed ? 'PASS' : 'FAIL',
      release: release?.kind,
      cause: release?.cause,
      ...trace,
      resourcesCleaned,
    }),
  );
  if (!passed) process.exitCode = 1;
}

function assert(condition, code) {
  if (!condition) throw new PairCanaryError(code);
}

async function main(state) {
  if (process.argv[2] === WORKER_MODE) {
    await runWorker(state);
    return;
  }
  if (process.argv[2] === FOCUSED_MODE) {
    await runFocusedMode(state);
    return;
  }
  let evidence;
  let failure;
  try {
    const endpoint = normalizePairCanaryEndpoint(process.env[ENDPOINT_ENV]);
    evidence = await runParent(endpoint, state);
  } catch (error) {
    failure = error;
  }
  const resourcesCleaned = await cleanupCanary(state).catch(() => false);
  if (state.signalExitCode) return;
  if (evidence) evidence.canaryResourcesCleaned = resourcesCleaned;
  if (!resourcesCleaned && !failure) {
    failure = new PairCanaryError('canary-resource-cleanup');
  }
  if (failure) {
    console.log(
      JSON.stringify({
        ...safePairCanaryFailure(failure),
        resourcesCleaned,
      }),
    );
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(validatePairCanaryEvidence(evidence)));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const state = {};
  let runPromise;
  const workerMode = process.argv[2] === WORKER_MODE;
  const removeSignalHandlers = installPairCanarySignalCleanup({
    cleanup: async (signal) => {
      state.signalExitCode = signal === 'SIGINT' ? 130 : 143;
      if (workerMode) return cleanupWorker(state);
      await runPromise?.catch(() => undefined);
      const resourcesCleaned = await cleanupCanary(state).catch(() => false);
      console.log(
        JSON.stringify(safePairCanarySignalResult(signal, resourcesCleaned)),
      );
      return resourcesCleaned;
    },
  });
  try {
    runPromise = main(state);
    await runPromise;
  } finally {
    if (!state.signalExitCode) removeSignalHandlers();
  }
}
