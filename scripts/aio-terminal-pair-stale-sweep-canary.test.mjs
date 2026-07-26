import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import {
  PairCanaryError,
  installPairCanarySignalCleanup,
  normalizePairCanaryEndpoint,
  safePairCanaryFailure,
  safePairCanarySignalResult,
  validatePairCanaryEvidence,
} from './aio-terminal-pair-stale-sweep-canary.mjs';

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'aio-terminal-pair-stale-sweep-canary.mjs',
);

const VALID_EVIDENCE = Object.freeze({
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
  sweepMs: 123,
});

test('canary script passes Node syntax validation', () => {
  const result = spawnSync(process.execPath, ['--check', SCRIPT_PATH], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('endpoint normalization accepts only HTTP(S) endpoints', () => {
  assert.equal(
    normalizePairCanaryEndpoint('http://127.0.0.1:18084///#ignored'),
    'http://127.0.0.1:18084',
  );
  assert.equal(
    normalizePairCanaryEndpoint('https://sandbox.example.test/base/'),
    'https://sandbox.example.test/base',
  );
  for (const endpoint of ['', 'not-a-url', 'file:///tmp/aio']) {
    assert.throws(
      () => normalizePairCanaryEndpoint(endpoint),
      PairCanaryError,
    );
  }
});

test('complete evidence produces a bounded PASS document', () => {
  assert.deepEqual(validatePairCanaryEvidence(VALID_EVIDENCE), {
    result: 'PASS',
    ...VALID_EVIDENCE,
  });
});

test('every required proof is fail-closed', () => {
  for (const field of Object.keys(VALID_EVIDENCE).filter(
    (field) => field !== 'sweepMs',
  )) {
    assert.throws(
      () =>
        validatePairCanaryEvidence({
          ...VALID_EVIDENCE,
          [field]: false,
        }),
      (error) =>
        error instanceof PairCanaryError &&
        error.code === `evidence-${field}`,
      field,
    );
  }
  for (const sweepMs of [-1, 1.25, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validatePairCanaryEvidence({ ...VALID_EVIDENCE, sweepMs }),
      (error) =>
        error instanceof PairCanaryError &&
        error.code === 'evidence-sweep-timing',
    );
  }
});

test('failure output exposes only a bounded stage code', () => {
  const secret = 'provider-secret-2d46c48a';
  const providerId = '04f7b86f-621a-449f-aa8e-21d4a4058fc0';
  const unexpected = safePairCanaryFailure(
    new Error(`${secret}:${providerId}`),
  );
  assert.deepEqual(unexpected, { result: 'FAIL', stage: 'unexpected' });
  const serialized = JSON.stringify(unexpected);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(providerId), false);

  assert.deepEqual(
    safePairCanaryFailure(new PairCanaryError('journal-survived')),
    { result: 'FAIL', stage: 'journal-survived' },
  );
});

test('SIGINT and SIGTERM share one awaited cleanup before the signal exit', async () => {
  const target = new EventEmitter();
  let cleanupCalls = 0;
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const exited = new Promise((resolve) => {
    target.exit = resolve;
  });
  const remove = installPairCanarySignalCleanup({
    target,
    cleanup: async (signal) => {
      cleanupCalls += 1;
      assert.equal(signal, 'SIGTERM');
      await cleanupGate;
    },
  });

  target.emit('SIGTERM');
  target.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 1);
  releaseCleanup();
  assert.equal(await exited, 143);
  remove();
});

test('signal output carries only the bounded cleanup proof', () => {
  assert.deepEqual(safePairCanarySignalResult('SIGINT', true), {
    result: 'INTERRUPTED',
    signal: 'SIGINT',
    resourcesCleaned: true,
  });
  assert.throws(() => safePairCanarySignalResult('SIGHUP', true), TypeError);
  assert.throws(
    () => safePairCanarySignalResult('SIGTERM', 'yes'),
    TypeError,
  );
});

test('direct execution without endpoint fails safely and does not start work', () => {
  const env = { ...process.env };
  delete env.CAP_AIO_PAIR_CANARY_ENDPOINT;
  delete env.CAP_AIO_PAIR_CANARY_SCOPE;
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    env,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    result: 'FAIL',
    stage: 'endpoint-unavailable',
    resourcesCleaned: true,
  });
  assert.equal(result.stderr, '');
});
