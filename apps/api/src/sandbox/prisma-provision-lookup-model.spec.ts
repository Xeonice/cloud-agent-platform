import assert from 'node:assert/strict';
import test from 'node:test';

import { SandboxRuntimeModelSetupError } from '@cap/sandbox';
import type { PrismaService } from '../prisma/prisma.service';
import { buildRuntimeExecutionEnvironmentSnapshot } from '../runtime-models/runtime-model-snapshot';
import { PrismaProvisionLookup } from './prisma-provision-lookup';

const OWNER = '00000000-0000-4000-a000-000000000101';

const SNAPSHOT = buildRuntimeExecutionEnvironmentSnapshot({
  schemaVersion: 1,
  kind: 'managed',
  managedEnvironmentId: '00000000-0000-4000-a000-000000000201',
  validationId: '00000000-0000-4000-a000-000000000301',
  validationContractVersion: 'v2',
  provider: 'aio-managed:env-a',
  providerFamily: 'aio',
  source: {
    kind: 'aio-docker-image',
    locator: 'registry.example/cap/aio@sha256:image-a',
    digest: 'sha256:image-a',
    checksum: null,
  },
  immutableIdentity: 'sha256:image-a',
  sandboxMetadata: {
    schemaVersion: 1,
    sandboxVersion: '1.2.3',
    dependencies: { codex: '0.144.1', 'claude-code': '2.1.207' },
  },
  cliVersion: '0.144.1',
  cliArtifactChecksum: `sha256:${'a'.repeat(64)}`,
  resolvedAt: '2026-07-14T00:00:00.000Z',
});

function lookupReturning(row: unknown): PrismaProvisionLookup {
  return new PrismaProvisionLookup({
    task: { findUnique: async () => row },
  } as unknown as PrismaService);
}

function setupErrorAt(phase: SandboxRuntimeModelSetupError['phase']) {
  return (error: unknown) =>
    error instanceof SandboxRuntimeModelSetupError && error.phase === phase;
}

test('legacy/null model rows resolve the byte-compatible runtime-default intent without a snapshot', async () => {
  const lookup = lookupReturning({
    model: null,
    ownerUserId: null,
    executionEnvironmentSnapshot: null,
    runtime: null,
    executionMode: null,
  });
  assert.deepEqual(await lookup.getTaskLaunchContext('task-legacy'), {
    modelIntent: { kind: 'runtime-default' },
    ownerUserId: null,
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
  });
});

test('explicit model rows return one atomic owner/runtime/mode/immutable environment context', async () => {
  const lookup = lookupReturning({
    model: 'provider/model:v1',
    ownerUserId: OWNER,
    executionEnvironmentSnapshot: SNAPSHOT,
    runtime: 'codex',
    executionMode: 'headless-exec',
  });
  const context = await lookup.getTaskLaunchContext('task-explicit');
  assert.equal(context.modelIntent.kind, 'explicit');
  if (context.modelIntent.kind !== 'explicit' || context.environment === undefined) {
    assert.fail('expected explicit model launch context');
  }
  assert.equal(context.modelIntent.selector, 'provider/model:v1');
  assert.equal(context.ownerUserId, OWNER);
  assert.equal(context.runtimeId, 'codex');
  assert.equal(context.executionMode, 'headless-exec');
  assert.equal(context.environment.providerId, SNAPSHOT.provider);
  assert.equal(
    context.environment.metadata?.fingerprint,
    SNAPSHOT.fingerprint,
  );
  assert.equal(
    context.environment.runtimeArtifactChecksums?.codex,
    SNAPSHOT.cliArtifactChecksum,
  );
});

test('explicit model rows fail closed for missing owners, bad selectors and tampered snapshots', async () => {
  await assert.rejects(
    lookupReturning({
      model: 'provider/model:v1',
      ownerUserId: null,
      executionEnvironmentSnapshot: SNAPSHOT,
      runtime: 'codex',
      executionMode: null,
    }).getTaskLaunchContext('missing-owner'),
    setupErrorAt('launch-context'),
  );
  await assert.rejects(
    lookupReturning({
      model: 'bad\u0000selector',
      ownerUserId: OWNER,
      executionEnvironmentSnapshot: SNAPSHOT,
      runtime: 'codex',
      executionMode: null,
    }).getTaskLaunchContext('bad-selector'),
    setupErrorAt('launch-context'),
  );
  await assert.rejects(
    lookupReturning({
      model: 'provider/model:v1',
      ownerUserId: OWNER,
      executionEnvironmentSnapshot: { ...SNAPSHOT, cliVersion: 'forged' },
      runtime: 'codex',
      executionMode: null,
    }).getTaskLaunchContext('tampered'),
    setupErrorAt('snapshot'),
  );
});

test('lookup errors, missing rows and invalid persisted launch enums never default', async () => {
  const throwing = new PrismaProvisionLookup({
    task: { findUnique: async () => Promise.reject(new Error('private db detail')) },
  } as unknown as PrismaService);
  await assert.rejects(
    throwing.getTaskLaunchContext('db-error'),
    setupErrorAt('lookup'),
  );
  await assert.rejects(
    lookupReturning(null).getTaskLaunchContext('missing'),
    setupErrorAt('lookup'),
  );
  await assert.rejects(
    lookupReturning({
      model: null,
      ownerUserId: OWNER,
      executionEnvironmentSnapshot: null,
      runtime: 'unknown-runtime',
      executionMode: null,
    }).getTaskLaunchContext('bad-runtime'),
    setupErrorAt('launch-context'),
  );
});
