import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';

import { PrismaService } from '@/prisma/prisma.service';
import {
  SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
  SandboxEnvironmentsService,
} from './sandbox-environments.service';
import type { SandboxEnvironmentValidationRunner } from './sandbox-environments.validator';

/**
 * Minimal ground-truth test for the simplify-sandbox-image-model requirement
 * "Environment validation gates task selection", scenario
 * "Failed validation blocks selection":
 *
 *   WHEN validation fails because the image is missing, unreachable,
 *   incompatible, or lacks required runtime tools
 *   THEN the environment status becomes failed
 *   AND task creation rejects that environment before sandbox provisioning
 *
 * This test deliberately makes the environment's provider family and
 * runtime id MATCH what the task requests -- the only thing wrong with the
 * environment is that its status is 'failed'. If the gate is doing its job,
 * that alone must be enough to reject task creation.
 */

const ENV_ID = '00000000-0000-4000-a000-000000009001';

function buildMinimalService(status: string) {
  const row = {
    id: ENV_ID,
    name: 'Failed env',
    source: { kind: 'aio-docker-image', image: 'cap/aio:missing' },
    status,
    resources: null,
    envVars: {},
    secretEnvVars: {},
    providerFamilies: ['aio'],
    runtimeIds: ['codex'],
    isDefault: false,
    lastValidationId: null,
    contractVersion: SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  const prisma = {
    sandboxEnvironment: {
      findUnique: async (args: { where: { id: string }; include?: unknown }) => {
        if (args.where.id !== ENV_ID) return null;
        return args.include ? { ...row, validations: [] } : row;
      },
    },
  } as unknown as PrismaService;

  const runner: SandboxEnvironmentValidationRunner = {
    async validate() {
      throw new Error('not used in this test');
    },
  };

  return new SandboxEnvironmentsService(prisma, runner);
}

test('ground truth: a failed-status environment is rejected for task creation even though provider/runtime match', async () => {
  const service = buildMinimalService('failed');

  await assert.rejects(
    () =>
      service.resolveForTask({
        selection: { kind: 'managed', environmentId: ENV_ID },
        runtimeId: 'codex',
        providerFamily: 'aio',
      }),
    (err: unknown) => {
      assert.ok(err instanceof BadRequestException, 'expected BadRequestException');
      return true;
    },
  );
});

test('ground truth: a ready-status environment with matching provider/runtime is selectable', async () => {
  const service = buildMinimalService('ready');

  const resolved = await service.resolveForTask({
    selection: { kind: 'managed', environmentId: ENV_ID },
    runtimeId: 'codex',
    providerFamily: 'aio',
  });

  assert.ok(resolved, 'expected a resolved environment when status is ready');
});
