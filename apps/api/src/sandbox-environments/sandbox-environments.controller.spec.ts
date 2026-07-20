import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import type {
  CreateSandboxEnvironmentRequest,
  UpdateSandboxEnvironmentParametersRequest,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxEnvironmentsController } from './sandbox-environments.controller';
import type { SandboxEnvironmentsService } from './sandbox-environments.service';

const ADMIN_USER_ID = 'user-admin';
const MEMBER_USER_ID = 'user-member';

function requestFor(userId: string | null): AuthenticatedRequest {
  return {
    operatorPrincipal: userId
      ? {
          kind: 'session',
          user: {
            id: userId,
            login: userId,
            name: userId,
            avatarUrl: '',
            allowed: true,
            role: userId === ADMIN_USER_ID ? 'admin' : 'member',
            mustChangePassword: false,
          },
        }
      : undefined,
  } as unknown as AuthenticatedRequest;
}

function buildController(): {
  controller: SandboxEnvironmentsController;
  calls: {
    create: CreateSandboxEnvironmentRequest[];
    list: number;
    retire: string[];
    updateParameters: { id: string; body: UpdateSandboxEnvironmentParametersRequest }[];
  };
} {
  const calls = {
    create: [] as CreateSandboxEnvironmentRequest[],
    list: 0,
    retire: [] as string[],
    updateParameters: [] as {
      id: string;
      body: UpdateSandboxEnvironmentParametersRequest;
    }[],
  };
  const environments = {
    async list() {
      calls.list += 1;
      return [];
    },
    async create(input: CreateSandboxEnvironmentRequest) {
      calls.create.push(input);
      return {
        id: '00000000-0000-4000-a000-000000000901',
        name: input.name,
        status: 'draft',
        source: input.source,
        compatibility: { providerFamilies: ['aio'] },
        isDefault: false,
        lastValidationId: null,
        lastValidatedAt: null,
        contractVersion: 'sandbox-environment-v1',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      };
    },
    async updateParameters(id: string, body: UpdateSandboxEnvironmentParametersRequest) {
      calls.updateParameters.push({ id, body });
      if (id === 'env-missing') {
        throw new NotFoundException(`Sandbox environment not found: ${id}`);
      }
      if (id === 'env-retired') {
        throw new BadRequestException({ error: 'sandbox_environment_retired' });
      }
      return {
        id,
        name: 'BoxLite gcode',
        status: 'ready',
        source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
        compatibility: { providerFamilies: ['boxlite'] },
        parameters: [
          { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v6', secret: false },
          { name: 'GCODE_TOKEN', secret: true },
        ],
        isDefault: true,
        lastValidationId: null,
        lastValidatedAt: null,
        contractVersion: 'sandbox-environment-v2',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      };
    },
    async retire(id: string) {
      calls.retire.push(id);
      return {
        id,
        name: 'Retired image',
        status: 'disabled',
        source: { kind: 'aio-docker-image', image: 'cap/aio:latest' },
        compatibility: { providerFamilies: ['aio'] },
        isDefault: false,
        lastValidationId: null,
        lastValidatedAt: null,
        contractVersion: 'sandbox-environment-v1',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      };
    },
  } as unknown as SandboxEnvironmentsService;
  const prisma = {
    user: {
      findUnique: async (args: { where: { id?: string }; select: unknown }) => {
        if (args.where.id === ADMIN_USER_ID) {
          return { role: 'admin', allowed: true };
        }
        if (args.where.id === MEMBER_USER_ID) {
          return { role: 'member', allowed: true };
        }
        return null;
      },
    },
  } as unknown as PrismaService;
  return {
    controller: new SandboxEnvironmentsController(environments, prisma),
    calls,
  };
}

test('authenticated sessions can list sandbox environments', async () => {
  const { controller, calls } = buildController();

  const response = await controller.list();

  assert.deepEqual(response, { environments: [] });
  assert.equal(calls.list, 1);
});

test('non-admin sessions are rejected before sandbox environment mutations', async () => {
  const { controller, calls } = buildController();
  const body: CreateSandboxEnvironmentRequest = {
    name: 'AIO image',
    source: { kind: 'aio-docker-image', image: 'cap/aio:latest' },
  };

  await assert.rejects(
    () => controller.create(requestFor(MEMBER_USER_ID), body),
    (err: unknown) => err instanceof ForbiddenException,
  );
  assert.equal(calls.create.length, 0);
  await assert.rejects(
    () => controller.retire(requestFor(MEMBER_USER_ID), 'env-1'),
    (err: unknown) => err instanceof ForbiddenException,
  );
  assert.deepEqual(calls.retire, []);
});

test('admin sessions can create sandbox environments', async () => {
  const { controller, calls } = buildController();
  const body: CreateSandboxEnvironmentRequest = {
    name: 'AIO image',
    source: { kind: 'aio-docker-image', image: 'cap/aio:latest' },
  };

  const response = await controller.create(requestFor(ADMIN_USER_ID), body);

  assert.equal(response.name, 'AIO image');
  assert.deepEqual(calls.create, [body]);
});

test('admin sessions can retire sandbox environments', async () => {
  const { controller, calls } = buildController();

  const response = await controller.retire(requestFor(ADMIN_USER_ID), 'env-1');

  assert.equal(response.status, 'disabled');
  assert.deepEqual(calls.retire, ['env-1']);
});

test('non-admin sessions cannot edit image parameters', async () => {
  const { controller, calls } = buildController();

  await assert.rejects(
    () =>
      controller.updateParameters(requestFor(MEMBER_USER_ID), 'env-1', {
        parameters: [{ name: 'GCODE_TOKEN', keep: true }],
      }),
    (err: unknown) => err instanceof ForbiddenException,
  );
  assert.deepEqual(calls.updateParameters, []);
});

test('admin edits return the redacted environment read shape', async () => {
  const { controller, calls } = buildController();
  const body: UpdateSandboxEnvironmentParametersRequest = {
    parameters: [
      { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v6' },
      { name: 'GCODE_TOKEN', keep: true },
    ],
  };

  const response = await controller.updateParameters(
    requestFor(ADMIN_USER_ID),
    'env-1',
    body,
  );

  assert.deepEqual(calls.updateParameters, [{ id: 'env-1', body }]);
  assert.deepEqual(response.parameters, [
    { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v6', secret: false },
    { name: 'GCODE_TOKEN', secret: true },
  ]);
  assert.equal(JSON.stringify(response).includes('gcode-secret'), false);
});

test('unknown and retired environments propagate their service errors', async () => {
  const { controller } = buildController();
  const body: UpdateSandboxEnvironmentParametersRequest = {
    parameters: [{ name: 'GCODE_TOKEN', value: 'x', secret: true }],
  };

  await assert.rejects(
    () => controller.updateParameters(requestFor(ADMIN_USER_ID), 'env-missing', body),
    (err: unknown) => err instanceof NotFoundException,
  );
  await assert.rejects(
    () => controller.updateParameters(requestFor(ADMIN_USER_ID), 'env-retired', body),
    (err: unknown) => err instanceof BadRequestException,
  );
});
