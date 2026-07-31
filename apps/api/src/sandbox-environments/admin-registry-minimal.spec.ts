import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/prisma/prisma.service';
import { SandboxEnvironmentsService } from './sandbox-environments.service';

/**
 * Minimal, standalone exercise of the "Admin-managed sandbox environment
 * registry" requirement's primary scenario:
 *
 *   WHEN an admin registers a sandbox environment with provider `aio` or
 *   `boxlite` and a non-empty pinned image reference
 *   THEN the system stores the environment with a stable id and an initial
 *   non-ready status
 *   AND the source descriptor contains no provider credentials or task
 *   secrets
 *
 * This uses a bare-bones fake PrismaService (only the surface `create()`
 * touches) rather than the full fixture in sandbox-environments.service.spec.ts,
 * to keep the exercised path minimal and easy to audit.
 */
test('admin creates a BoxLite-image environment: stable id, non-ready status, secret-free descriptor', async () => {
  let persisted: Record<string, unknown> | null = null;

  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    sandboxEnvironment: {
      create: async (args: {
        data: Record<string, unknown>;
        include?: unknown;
      }) => {
        const row = {
          id: '11111111-1111-4111-a111-111111111111',
          ...args.data,
          // Prisma stores the DbNull sentinel as JSON null; mirror that here.
          resources:
            args.data.resources === Prisma.DbNull ? null : args.data.resources,
          createdAt: new Date('2026-07-31T00:00:00.000Z'),
          updatedAt: new Date('2026-07-31T00:00:00.000Z'),
        };
        persisted = row;
        return row;
      },
    },
  } as unknown as PrismaService;

  const service = new SandboxEnvironmentsService(prisma);

  const created = await service.create({
    name: 'Custom BoxLite image',
    source: { kind: 'boxlite-image', image: 'cap/boxlite:custom-v1' },
  });

  // A stable id was assigned and the row was actually persisted.
  assert.equal(typeof created.id, 'string');
  assert.ok(created.id.length > 0);
  assert.ok(persisted, 'expected the environment row to be persisted');

  // Newly created managed environments start in a non-ready status; the
  // registry never treats an unvalidated image as immediately selectable.
  assert.notEqual(created.status, 'ready');

  // The stored source descriptor is exactly the provider-aware image
  // reference shape -- no provider API tokens, forge tokens, or other task
  // secrets can ride along with it.
  assert.deepEqual(Object.keys(created.source).sort(), ['image', 'kind']);
  assert.equal(created.source.kind, 'boxlite-image');
  for (const forbiddenKey of ['token', 'secret', 'credential', 'apiKey', 'password']) {
    assert.equal(forbiddenKey in created.source, false);
  }
});
