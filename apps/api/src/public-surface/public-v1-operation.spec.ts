import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';
import { PublicSurfaceError } from './public-surface-error';
import {
  PUBLIC_V1_OPERATION_ID_METADATA,
  PublicV1ContractInterceptor,
  PublicV1Operation,
  PublicV1OperationGuard,
  publicV1OperationById,
  publicV1RequestContext,
  type PublicV1Handler,
} from './public-v1-operation';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';

const OWNER_PRINCIPAL: OperatorPrincipal = {
  kind: 'api-key',
  user: {
    id: 'owner-1',
    githubId: null,
    login: null,
    name: 'Boundary owner',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
  scopes: ['tasks:read', 'tasks:write', 'repos:read'],
  keyId: 'boundary-key',
};

class BoundHandlers {
  @PublicV1Operation('tasks.list')
  tasksList(): undefined {
    return undefined;
  }

  @PublicV1Operation('tasks.get')
  taskGet(): undefined {
    return undefined;
  }

  @PublicV1Operation('tasks.create')
  taskCreate(): undefined {
    return undefined;
  }

  @PublicV1Operation('tasks.events')
  taskEvents(): undefined {
    return undefined;
  }

  @PublicV1Operation('schedules.create')
  scheduleCreate(): undefined {
    return undefined;
  }

  @PublicV1Operation('schedules.runs')
  scheduleRuns(): undefined {
    return undefined;
  }

  @PublicV1Operation('schedules.delete')
  scheduleDelete(): undefined {
    return undefined;
  }

  @PublicV1Operation('runtimeModels.query')
  runtimeModelsQuery(): undefined {
    return undefined;
  }
}

interface FixtureRequestFields {
  readonly operatorPrincipal?: OperatorPrincipal;
  readonly params?: unknown;
  readonly query?: unknown;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

function fixtureRequest(
  fields: FixtureRequestFields = {},
): AuthenticatedRequest {
  return {
    operatorPrincipal: OWNER_PRINCIPAL,
    params: {},
    query: {},
    headers: {},
    ...fields,
  } as unknown as AuthenticatedRequest;
}

function fixtureContext(
  handler: PublicV1Handler,
  request: AuthenticatedRequest,
  response: object = {},
): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function captureHttpFailure(run: () => unknown): HttpException {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HttpException, 'expected an HttpException');
  return caught;
}

async function captureAsyncHttpFailure(
  promise: Promise<unknown>,
): Promise<HttpException> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HttpException, 'expected an HttpException');
  return caught;
}

function seedBoundary(
  handler: PublicV1Handler,
  request: AuthenticatedRequest,
  response: object = {},
): ExecutionContext {
  const context = fixtureContext(handler, request, response);
  assert.equal(new PublicV1OperationGuard().canActivate(context), true);
  return context;
}

test('guard parses canonical params, query, declared headers, and body from registry pairs', () => {
  const guard = new PublicV1OperationGuard();

  const listRequest = fixtureRequest({
    query: { limit: '7', cursor: 'next', internalFlag: 'must-strip' },
  });
  guard.canActivate(
    fixtureContext(BoundHandlers.prototype.tasksList, listRequest),
  );
  assert.deepEqual(publicV1RequestContext(listRequest)?.input.query, {
    limit: 7,
    cursor: 'next',
  });
  assert.deepEqual(listRequest.query, { limit: 7, cursor: 'next' });

  const eventRequest = fixtureRequest({
    params: { id: TASK_ID },
    headers: {
      authorization: 'Bearer must-not-enter-canonical-input',
      'last-event-id': '  event-123  ',
      'x-forwarded-for': '127.0.0.1',
    },
  });
  guard.canActivate(
    fixtureContext(BoundHandlers.prototype.taskEvents, eventRequest),
  );
  assert.deepEqual(publicV1RequestContext(eventRequest)?.input, {
    params: { id: TASK_ID },
    headers: { 'Last-Event-ID': 'event-123' },
  });
  assert.deepEqual(eventRequest.params, { id: TASK_ID });
  assert.deepEqual(eventRequest.headers, {
    authorization: 'Bearer must-not-enter-canonical-input',
    'last-event-id': 'event-123',
    'x-forwarded-for': '127.0.0.1',
  });

  const runsRequest = fixtureRequest({
    params: { id: TASK_ID },
    query: { limit: '3' },
  });
  guard.canActivate(
    fixtureContext(BoundHandlers.prototype.scheduleRuns, runsRequest),
  );
  assert.deepEqual(publicV1RequestContext(runsRequest)?.input, {
    params: { id: TASK_ID },
    query: { limit: 3 },
  });

  const createRequest = fixtureRequest({
    body: {
      recurrence: {
        kind: 'hourly',
        minuteOfHour: 15,
        timezone: 'Asia/Shanghai',
      },
      taskTemplate: { repoId: REPO_ID, prompt: 'run canonical fixture' },
      internalFlag: 'must-strip',
    },
  });
  guard.canActivate(
    fixtureContext(BoundHandlers.prototype.scheduleCreate, createRequest),
  );
  assert.deepEqual(publicV1RequestContext(createRequest)?.input.body, {
    recurrence: {
      kind: 'hourly',
      minuteOfHour: 15,
      timezone: 'Asia/Shanghai',
    },
    taskTemplate: { repoId: REPO_ID, prompt: 'run canonical fixture' },
    overlapPolicy: 'skip',
    misfirePolicy: 'fire-once',
    cronExpression: '15 * * * *',
    timezone: 'Asia/Shanghai',
  });
  assert.deepEqual(
    createRequest.body,
    publicV1RequestContext(createRequest)?.input.body,
  );
});

test('authorization and validation fail closed before a write can run', () => {
  const guard = new PublicV1OperationGuard();
  let writeCalls = 0;
  const attemptWrite = (request: AuthenticatedRequest): HttpException => {
    const failure = captureHttpFailure(() => {
      guard.canActivate(
        fixtureContext(BoundHandlers.prototype.taskCreate, request),
      );
      writeCalls += 1;
    });
    assert.equal(writeCalls, 0);
    return failure;
  };

  const missingPrincipal = attemptWrite(
    fixtureRequest({ operatorPrincipal: undefined }),
  );
  assert.ok(missingPrincipal instanceof ForbiddenException);
  assert.deepEqual(missingPrincipal.getResponse(), {
    message: 'Missing operator principal',
    error: 'Forbidden',
    statusCode: 403,
  });

  const missingScope = attemptWrite(
    fixtureRequest({
      operatorPrincipal: {
        ...OWNER_PRINCIPAL,
        scopes: ['tasks:read'],
      },
    }),
  );
  assert.ok(missingScope instanceof ForbiddenException);
  assert.deepEqual(missingScope.getResponse(), {
    message: 'Insufficient scope: tasks:write required',
    error: 'Forbidden',
    statusCode: 403,
  });

  const invalidBody = attemptWrite(
    fixtureRequest({ body: { repoId: REPO_ID, prompt: '' } }),
  );
  assert.ok(invalidBody instanceof BadRequestException);
  assert.equal(invalidBody.getStatus(), 400);
});

test('owner and operation binding failures reject before business invocation', () => {
  const guard = new PublicV1OperationGuard();
  let writeCalls = 0;
  const ownerless = fixtureRequest({
    operatorPrincipal: { kind: 'legacy-token', user: null },
    body: {
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      taskTemplate: { repoId: REPO_ID, prompt: 'must not run' },
    },
  });
  const ownerFailure = captureHttpFailure(() => {
    guard.canActivate(
      fixtureContext(BoundHandlers.prototype.scheduleCreate, ownerless),
    );
    writeCalls += 1;
  });
  assert.ok(ownerFailure instanceof BadRequestException);
  assert.deepEqual(ownerFailure.getResponse(), {
    error: 'schedule_owner_required',
    message: 'Schedules require an authenticated account owner.',
  });
  assert.equal(writeCalls, 0);

  const ownerlessRuntime = fixtureRequest({
    operatorPrincipal: { kind: 'legacy-token', user: null },
    body: { runtime: 'codex' },
  });
  const runtimeOwnerFailure = captureHttpFailure(() => {
    guard.canActivate(
      fixtureContext(
        BoundHandlers.prototype.runtimeModelsQuery,
        ownerlessRuntime,
      ),
    );
    writeCalls += 1;
  });
  assert.ok(runtimeOwnerFailure instanceof ForbiddenException);
  assert.deepEqual(runtimeOwnerFailure.getResponse(), {
    message: 'Runtime model catalogs require an authenticated account owner',
    error: 'Forbidden',
    statusCode: 403,
  });
  assert.equal(writeCalls, 0);

  const missingBinding = captureHttpFailure(() => {
    guard.canActivate(fixtureContext(() => undefined, fixtureRequest()));
    writeCalls += 1;
  });
  assert.ok(missingBinding instanceof ForbiddenException);
  assert.match(String(missingBinding.message), /missing public operation binding/i);
  assert.equal(writeCalls, 0);

  const unknownHandler = (): undefined => undefined;
  Reflect.defineMetadata(
    PUBLIC_V1_OPERATION_ID_METADATA,
    'future.unknown-operation',
    unknownHandler,
  );
  const unknownBinding = captureHttpFailure(() => {
    guard.canActivate(fixtureContext(unknownHandler, fixtureRequest()));
    writeCalls += 1;
  });
  assert.ok(unknownBinding instanceof ForbiddenException);
  assert.match(String(unknownBinding.message), /unknown public operation binding/i);
  assert.equal(writeCalls, 0);
});

test('interceptor validates ordinary output and enforces the declared 204 projection', async () => {
  const interceptor = new PublicV1ContractInterceptor();
  const listRequest = fixtureRequest({ query: {} });
  const listContext = seedBoundary(
    BoundHandlers.prototype.tasksList,
    listRequest,
  );
  const validPage = {
    items: [],
    nextCursor: null,
    legacyExtension: 'preserved without response rewriting',
  };
  const projectedPage = await firstValueFrom(
    interceptor.intercept(listContext, {
      handle: () => of(validPage),
    } as CallHandler),
  );
  assert.equal(projectedPage, validPage);

  const invalidOutput = await captureAsyncHttpFailure(
    firstValueFrom(
      interceptor.intercept(listContext, {
        handle: () => of({ items: 'not-an-array', nextCursor: null }),
      } as CallHandler),
    ),
  );
  assert.ok(invalidOutput instanceof InternalServerErrorException || invalidOutput.getStatus() === 500);
  assert.equal(invalidOutput.getStatus(), 500);

  const deleteRequest = fixtureRequest({ params: { id: TASK_ID } });
  const deleteContext = seedBoundary(
    BoundHandlers.prototype.scheduleDelete,
    deleteRequest,
  );
  assert.equal(
    await firstValueFrom(
      interceptor.intercept(deleteContext, {
        handle: () => of(undefined),
      } as CallHandler),
    ),
    undefined,
  );
  const unexpectedDeleteBody = await captureAsyncHttpFailure(
    firstValueFrom(
      interceptor.intercept(deleteContext, {
        handle: () => of({ deleted: true }),
      } as CallHandler),
    ),
  );
  assert.equal(unexpectedDeleteBody.getStatus(), 500);
});

test('interceptor preserves SSE ownership and centralizes every handler failure', async () => {
  const interceptor = new PublicV1ContractInterceptor();

  const eventRequest = fixtureRequest({
    params: { id: TASK_ID },
    headers: {},
  });
  const eventContext = seedBoundary(
    BoundHandlers.prototype.taskEvents,
    eventRequest,
  );
  assert.equal(
    await firstValueFrom(
      interceptor.intercept(eventContext, {
        handle: () => of(undefined),
      } as CallHandler),
    ),
    undefined,
  );

  const getRequest = fixtureRequest({ params: { id: TASK_ID } });
  const getContext = seedBoundary(BoundHandlers.prototype.taskGet, getRequest);
  const notFound = await captureAsyncHttpFailure(
    firstValueFrom(
      interceptor.intercept(getContext, {
        handle: () => throwError(() => new NotFoundException('Task not found')),
      } as CallHandler),
    ),
  );
  assert.equal(notFound.getStatus(), 404);
  assert.deepEqual(notFound.getResponse(), {
    message: 'Task not found',
    error: 'Not Found',
    statusCode: 404,
  });

  const undeclaredConflict = await captureAsyncHttpFailure(
    firstValueFrom(
      interceptor.intercept(getContext, {
        handle: () =>
          throwError(
            () =>
              new PublicSurfaceError({
                code: 'conflict',
                message: 'Task state conflicts with this request',
              }),
          ),
      } as CallHandler),
    ),
  );
  assert.equal(undeclaredConflict.getStatus(), 500);
  assert.deepEqual(undeclaredConflict.getResponse(), {
    message: 'Undeclared public error for tasks.get',
    error: 'Internal Server Error',
    statusCode: 500,
  });

  const createRequest = fixtureRequest({
    headers: {},
    body: { repoId: REPO_ID, prompt: 'conflict fixture' },
  });
  const createContext = seedBoundary(
    BoundHandlers.prototype.taskCreate,
    createRequest,
  );
  const declaredConflict = await captureAsyncHttpFailure(
    firstValueFrom(
      interceptor.intercept(createContext, {
        handle: () =>
          throwError(
            () =>
              new PublicSurfaceError({
                code: 'conflict',
                message: 'Task state conflicts with this request',
              }),
          ),
      } as CallHandler),
    ),
  );
  assert.equal(declaredConflict.getStatus(), 409);
  assert.deepEqual(declaredConflict.getResponse(), {
    message: 'Task state conflicts with this request',
    error: 'Conflict',
    statusCode: 409,
  });

  const runtimeRequest = fixtureRequest({ body: { runtime: 'codex' } });
  const runtimeHeaders = new Map<string, string>();
  const runtimeResponse = {
    setHeader(name: string, value: string) {
      runtimeHeaders.set(name, value);
    },
  };
  const runtimeContext = seedBoundary(
    BoundHandlers.prototype.runtimeModelsQuery,
    runtimeRequest,
    runtimeResponse,
  );
  const domainFailure = new RuntimeModelPreflightError({
    code: 'runtime_model_catalog_unavailable',
    message: 'Runtime model selection is temporarily unavailable.',
    retryable: true,
  });
  const projectedDomainFailure = await captureAsyncHttpFailure(
    firstValueFrom(
      interceptor.intercept(runtimeContext, {
        handle: () => throwError(() => domainFailure),
      } as CallHandler),
    ),
  );
  assert.notEqual(projectedDomainFailure, domainFailure);
  assert.equal(projectedDomainFailure.getStatus(), 503);
  assert.deepEqual(projectedDomainFailure.getResponse(), domainFailure.domainError);
  assert.equal(runtimeHeaders.size, 0);

  const throttled = new RuntimeModelPreflightError({
    code: 'runtime_model_catalog_unavailable',
    message: 'Runtime model catalog request capacity is temporarily exhausted.',
    retryable: true,
    capacity: { scope: 'principal', retryAfterMs: 1_501 },
  });
  const projectedThrottle = await captureAsyncHttpFailure(
    firstValueFrom(
      interceptor.intercept(runtimeContext, {
        handle: () => throwError(() => throttled),
      } as CallHandler),
    ),
  );
  assert.equal(projectedThrottle.getStatus(), 429);
  assert.deepEqual(projectedThrottle.getResponse(), throttled.domainError);
  assert.equal(runtimeHeaders.get('Retry-After'), '2');

  const undeclaredRuntimeFailure = await captureAsyncHttpFailure(
    firstValueFrom(
      interceptor.intercept(getContext, {
        handle: () => throwError(() => domainFailure),
      } as CallHandler),
    ),
  );
  assert.equal(undeclaredRuntimeFailure.getStatus(), 500);
  assert.deepEqual(undeclaredRuntimeFailure.getResponse(), {
    message: 'Undeclared public error for tasks.get',
    error: 'Internal Server Error',
    statusCode: 500,
  });
});

test('typed decorator resolves the exact registry object', () => {
  const request = fixtureRequest({ query: {} });
  new PublicV1OperationGuard().canActivate(
    fixtureContext(BoundHandlers.prototype.tasksList, request),
  );
  assert.equal(
    publicV1RequestContext(request)?.operation,
    publicV1OperationById('tasks.list'),
  );
});
