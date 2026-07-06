import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';

import type { CreateSandboxEnvironmentRequest } from '@cap/contracts';
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
  calls: { create: CreateSandboxEnvironmentRequest[]; list: number };
} {
  const calls = {
    create: [] as CreateSandboxEnvironmentRequest[],
    list: 0,
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
