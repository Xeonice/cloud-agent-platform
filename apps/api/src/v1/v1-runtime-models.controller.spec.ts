import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  RuntimeModelCatalogSchema,
  type RuntimeModelCatalogQuery,
} from '@cap/contracts';
import type { OperatorPrincipal } from '../auth/operator-principal';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { RuntimeModelCatalogService } from '../runtime-models/runtime-model-catalog.service';
import { RuntimeModelHttpExceptionFilter } from '../runtime-models/runtime-model-http.filter';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';
import { TaskModelCapabilityService } from '../runtime-models/task-model-capability.service';
import { V1RuntimeModelsController } from './v1-runtime-models.controller';

const OWNER_ID = 'owner-runtime-models';
const MANAGED_ID = '00000000-0000-4000-8000-000000000321';
const OWNER_DEFAULT_ID = '00000000-0000-4000-8000-000000000322';

const SESSION_PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: OWNER_ID,
    githubId: null,
    login: null,
    name: 'Model Owner',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
};

const READ_ONLY_PRINCIPAL: OperatorPrincipal = {
  ...SESSION_PRINCIPAL,
  kind: 'api-key',
  scopes: ['tasks:read'],
  keyId: 'read-only-key',
};

let principal: OperatorPrincipal = SESSION_PRINCIPAL;
let catalogCalls: Array<{
  ownerUserId: string;
  query: RuntimeModelCatalogQuery;
}> = [];
let gateCalls = 0;
let gateFailureAt: number | null = null;
let app: INestApplication;
let port = 0;

const CLOSED_ERROR = {
  code: 'runtime_model_catalog_unavailable' as const,
  message: 'Runtime model selection is temporarily unavailable.',
  retryable: true as const,
};

@Injectable()
class MutablePrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<AuthenticatedRequest>().operatorPrincipal =
      principal;
    return true;
  }
}

before(async () => {
  const catalogs = {
    async query(ownerUserId: string, query: RuntimeModelCatalogQuery) {
      catalogCalls.push({ ownerUserId, query });
      const explicitEnvironment = query.sandboxEnvironmentId;
      const managedId =
        explicitEnvironment === undefined
          ? OWNER_DEFAULT_ID
          : explicitEnvironment === null
            ? null
            : explicitEnvironment;
      return {
        ok: true as const,
        value: RuntimeModelCatalogSchema.parse({
          runtime: query.runtime,
          effectiveEnvironment:
            managedId === null
              ? {
                  kind: 'deployment-default',
                  id: null,
                  name: 'Deployment default',
                  provider: 'aio',
                  fingerprint: 'deployment-fingerprint',
                }
              : {
                  kind: 'managed',
                  id: managedId,
                  name: 'Managed environment',
                  provider: 'boxlite',
                  fingerprint: `managed-${managedId}`,
                },
          cliVersion: 'test-cli-version',
          source:
            query.runtime === 'codex'
              ? 'codex-app-server'
              : 'versioned-cli-capabilities',
          completeness:
            query.runtime === 'codex' ? 'complete' : 'supported-subset',
          revision: 'sha256:test-catalog-revision',
          defaultModel: null,
          models: [],
        }),
      };
    },
  };
  const capability = {
    assertOpen() {
      gateCalls += 1;
      if (gateFailureAt === gateCalls) {
        throw new RuntimeModelPreflightError(CLOSED_ERROR);
      }
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [V1RuntimeModelsController],
    providers: [
      { provide: APP_GUARD, useClass: MutablePrincipalGuard },
      { provide: APP_FILTER, useClass: RuntimeModelHttpExceptionFilter },
      { provide: RuntimeModelCatalogService, useValue: catalogs },
      { provide: TaskModelCapabilityService, useValue: capability },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number } | null;
  port = address?.port ?? 0;
  assert.ok(port > 0);
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  principal = SESSION_PRINCIPAL;
  catalogCalls = [];
  gateCalls = 0;
  gateFailureAt = null;
});

async function query(body: unknown): Promise<{
  response: Response;
  json: unknown;
}> {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/runtime-models/query`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { response, json: await response.json() };
}

test('V1 catalog preserves omitted, null, and UUID intent and derives the owner from the principal', async () => {
  const cases = [
    {
      body: { runtime: 'codex' },
      expectedEnvironment: { kind: 'managed', id: OWNER_DEFAULT_ID },
    },
    {
      body: { runtime: 'codex', sandboxEnvironmentId: null },
      expectedEnvironment: { kind: 'deployment-default', id: null },
    },
    {
      body: { runtime: 'claude-code', sandboxEnvironmentId: MANAGED_ID },
      expectedEnvironment: { kind: 'managed', id: MANAGED_ID },
    },
  ] as const;

  for (const { body, expectedEnvironment } of cases) {
    catalogCalls = [];
    gateCalls = 0;
    const { response, json } = await query(body);
    assert.equal(response.status, 200);
    const catalog = RuntimeModelCatalogSchema.parse(json);
    assert.deepEqual(
      {
        kind: catalog.effectiveEnvironment.kind,
        id: catalog.effectiveEnvironment.id,
      },
      expectedEnvironment,
    );
    assert.deepEqual(catalogCalls, [{ ownerUserId: OWNER_ID, query: body }]);
    assert.equal(gateCalls, 2, 'gate is checked before and after discovery');
  }
});

test('V1 catalog rejects client-supplied owner fields before gate or discovery', async () => {
  const { response } = await query({
    runtime: 'codex',
    ownerUserId: 'attacker',
  });
  assert.equal(response.status, 400);
  assert.equal(gateCalls, 0);
  assert.deepEqual(catalogCalls, []);
});

test('V1 catalog denies missing write scope and missing account owner before discovery', async () => {
  principal = READ_ONLY_PRINCIPAL;
  let result = await query({ runtime: 'codex' });
  assert.equal(result.response.status, 403);
  assert.equal(gateCalls, 0);
  assert.deepEqual(catalogCalls, []);

  principal = { kind: 'legacy-token', user: null };
  result = await query({ runtime: 'codex' });
  assert.equal(result.response.status, 403);
  assert.equal(gateCalls, 0);
  assert.deepEqual(catalogCalls, []);
});

test('V1 catalog fails closed before discovery when the deployment gate is closed', async () => {
  gateFailureAt = 1;
  const { response, json } = await query({ runtime: 'codex' });
  assert.equal(response.status, 503);
  assert.deepEqual(json, CLOSED_ERROR);
  assert.deepEqual(catalogCalls, []);
});

test('V1 catalog withholds a result when attestation closes during discovery', async () => {
  gateFailureAt = 2;
  const { response, json } = await query({ runtime: 'codex' });
  assert.equal(response.status, 503);
  assert.deepEqual(json, CLOSED_ERROR);
  assert.equal(catalogCalls.length, 1);
  assert.equal(gateCalls, 2);
});
