// Minimal ground-truth test for the openspec requirement
// "Environment resolution produces immutable provisioning metadata"
// (simplify-sandbox-image-model / specs/sandbox-environments/spec.md).
//
// Exercises the "Explicit environment resolves for a task" scenario:
// a ready, compatible sandboxEnvironmentId resolves to immutable metadata
// (environment id, source kind, provider family, runtime id, resolved image
// reference/digest, and validation id/version) derived from the pinned
// validation snapshot rather than a re-read of the mutable source tag.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PrismaService } from '@/prisma/prisma.service';
import { SandboxEnvironmentsService } from './sandbox-environments.service';

const ENV_ID = '00000000-0000-4000-a000-000000009001';
const VALIDATION_ID = '00000000-0000-4000-a000-000000009002';
const CONTRACT_VERSION = 'sandbox-environment-v3';

const environmentRow = {
  id: ENV_ID,
  name: 'Ground truth image',
  source: { kind: 'aio-docker-image', image: 'cap/aio:mutable-tag' },
  status: 'ready',
  resources: null,
  providerFamilies: ['aio'],
  runtimeIds: ['codex'],
  isDefault: false,
  lastValidationId: VALIDATION_ID,
  contractVersion: CONTRACT_VERSION,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
};

const validationRow = {
  id: VALIDATION_ID,
  environmentId: ENV_ID,
  status: 'passed',
  providerFamily: 'aio',
  runtimeId: null,
  sourceKind: 'aio-docker-image',
  resolvedLocator: 'cap/aio@sha256:pinned-immutable-digest',
  resolvedDigest: 'sha256:pinned-immutable-digest',
  resolvedChecksum: null,
  runtimeArtifactChecksums: { codex: 'cli-checksum-codex' },
  cliArtifactChecksum: null,
  sandboxMetadata: {
    schemaVersion: 1,
    sandboxVersion: 'v1.2.3',
    dependencies: { codex: '0.132.0' },
  },
  resourceSnapshot: {},
  contractVersion: CONTRACT_VERSION,
  checkedAt: new Date('2026-07-01T00:05:00.000Z'),
};

const prisma = {
  sandboxEnvironment: {
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id === ENV_ID ? environmentRow : null,
  },
  sandboxEnvironmentValidation: {
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id === VALIDATION_ID ? validationRow : null,
  },
} as unknown as PrismaService;

test('explicit ready environment resolves to immutable provisioning metadata, not the mutable tag', async () => {
  const service = new SandboxEnvironmentsService(prisma);

  const resolved = await service.resolveImmutableForTask({
    selection: { kind: 'managed', environmentId: ENV_ID },
    runtimeId: 'codex',
    providerFamily: 'aio',
  });

  assert.ok(resolved, 'expected a resolved environment');
  assert.equal(resolved?.environmentId, ENV_ID);
  assert.equal(resolved?.sourceKind, 'aio-docker-image');
  assert.equal(resolved?.providerFamily, 'aio');
  assert.equal(resolved?.runtimeId, 'codex');
  // Immutable: resolution must surface the validation-pinned digest locator,
  // not the mutable tag stored on the source descriptor.
  assert.equal(resolved?.sourceRef, 'cap/aio@sha256:pinned-immutable-digest');
  assert.equal(resolved?.digest, 'sha256:pinned-immutable-digest');
  assert.equal(resolved?.validationId, VALIDATION_ID);
  assert.equal(resolved?.validationVersion, CONTRACT_VERSION);
});
