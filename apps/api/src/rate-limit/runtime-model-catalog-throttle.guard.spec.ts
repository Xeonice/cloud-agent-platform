import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, seconds } from '@nestjs/throttler';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { PublicV1Operation } from '../public-surface/public-v1-operation';
import { RuntimeModelCatalogThrottleGuard } from './runtime-model-catalog-throttle.guard';
import { RUNTIME_MODEL_CATALOG_THROTTLE_NAME } from './throttler.options';

const LIMIT = 2;
let principal: OperatorPrincipal;

@Controller('v1')
class ProbeController {
  @Post('runtime-models/query')
  @PublicV1Operation('runtimeModels.query')
  catalog(): { ok: true } {
    return { ok: true };
  }

  /** Proves limiter membership follows the typed binding, not a copied URL. */
  @Post('catalog-probe')
  @PublicV1Operation('runtimeModels.query')
  relocatedCatalog(): { ok: true } {
    return { ok: true };
  }

  @Post('tasks')
  @PublicV1Operation('tasks.create')
  tasks(): { ok: true } {
    return { ok: true };
  }
}

@Injectable()
class StubPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().operatorPrincipal = principal;
    return true;
  }
}

function sessionPrincipal(id: string): OperatorPrincipal {
  return {
    kind: 'session',
    user: {
      id,
      githubId: null,
      login: null,
      name: id,
      avatarUrl: null,
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
  };
}

test('runtime model catalog has an independent per-principal 429 tier', async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    imports: [
      ThrottlerModule.forRoot([
        {
          name: RUNTIME_MODEL_CATALOG_THROTTLE_NAME,
          ttl: seconds(60),
          limit: LIMIT,
        },
      ]),
    ],
    providers: [
      { provide: APP_GUARD, useClass: StubPrincipalGuard },
      { provide: APP_GUARD, useClass: RuntimeModelCatalogThrottleGuard },
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const post = (path: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });

  try {
    principal = sessionPrincipal('owner-a');
    for (let request = 0; request < LIMIT; request += 1) {
      const response = await post('/v1/runtime-models/query?source=test');
      assert.equal(response.status, 200);
      await response.text();
    }
    const limited = await post('/v1/runtime-models/query');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    const error = await limited.json();
    assert.equal(error.code, 'runtime_model_catalog_unavailable');
    assert.equal(error.retryable, true);
    assert.equal(error.capacity.scope, 'principal');

    principal = sessionPrincipal('owner-b');
    const independent = await post('/v1/runtime-models/query');
    assert.equal(independent.status, 200);
    await independent.text();

    principal = sessionPrincipal('owner-relocated');
    for (let request = 0; request < LIMIT; request += 1) {
      const response = await post('/v1/catalog-probe');
      assert.equal(response.status, 200);
      await response.text();
    }
    const relocatedLimited = await post('/v1/catalog-probe');
    assert.equal(
      relocatedLimited.status,
      429,
      'the typed runtimeModels.query binding remains throttled at a different Nest path',
    );
    await relocatedLimited.text();

    principal = sessionPrincipal('owner-a');
    for (let request = 0; request < LIMIT + 2; request += 1) {
      const unrelated = await post('/v1/tasks');
      assert.equal(unrelated.status, 201);
      await unrelated.text();
    }
  } finally {
    await app.close();
  }
});
