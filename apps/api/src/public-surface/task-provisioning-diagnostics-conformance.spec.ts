import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import {
  PUBLIC_V1_OPERATIONS,
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticsResponseSchema,
  TaskResponseSchema,
  type PublicErrorCode,
  type TaskProvisioningDiagnosticsQuery,
  type TaskProvisioningDiagnosticsResponse,
} from '@cap/contracts';
import { firstValueFrom, from } from 'rxjs';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import {
  registerMcpTools,
  type McpToolDeps,
  type ToolExtra,
  type ToolRegistrar,
} from '../mcp/mcp-tools';
import { McpServerFactory } from '../mcp/mcp.server';
import type { PrismaService } from '../prisma/prisma.service';
import { MCP_PUBLIC_ERROR_MAP } from './public-error-mappings';
import { normalizePublicSurfaceFailure } from './public-surface-error';
import {
  PublicV1ContractInterceptor,
  PublicV1OperationGuard,
  publicV1RequestContext,
  type PublicV1Handler,
} from './public-v1-operation';
import type { TaskProvisioningDiagnosticsCapabilityGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-deployment-gate.port';
import { TaskProvisioningDiagnosticsPublicQueryService } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-public-query.service';
import { TaskProvisioningDiagnosticsService } from '../task-provisioning-diagnostics/task-provisioning-diagnostics.service';
import { V1TaskProvisioningDiagnosticsController } from '../v1/v1-task-provisioning-diagnostics.controller';

const OWNER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000002';
const NOT_STARTED_TASK_ID = '20000000-0000-4000-8000-000000000001';
const PARTIAL_TASK_ID = '20000000-0000-4000-8000-000000000002';
const COMPLETE_TASK_ID = '20000000-0000-4000-8000-000000000003';
const UNAVAILABLE_TASK_ID = '20000000-0000-4000-8000-000000000004';
const CROSS_OWNER_TASK_ID = '20000000-0000-4000-8000-000000000005';
const OWNERLESS_TASK_ID = '20000000-0000-4000-8000-000000000006';
const UNKNOWN_TASK_ID = '20000000-0000-4000-8000-000000000007';
const ATTEMPT_ID = '30000000-0000-4000-8000-000000000001';
const PRIMARY_OPERATION_ID = '40000000-0000-4000-8000-000000000001';
const CLEANUP_OPERATION_ID = '40000000-0000-4000-8000-000000000002';
const OBSERVED_AT = new Date('2026-07-18T02:00:00.000Z');
const STARTED_AT = new Date('2026-07-18T01:59:59.000Z');
const INTERNAL_CANARY = 'diagnostics-internal-secret-canary';

const OWNER_PRINCIPAL: OperatorPrincipal = {
  kind: 'api-key',
  user: {
    id: OWNER_ID,
    githubId: null,
    login: null,
    name: 'Diagnostics conformance owner',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
  scopes: ['tasks:diagnostics'],
  keyId: 'diagnostics-conformance-key',
};

// Prisma delegates intentionally expose dynamic argument/result bags. This
// read-only fake models the actual Task/attempt/event ledger queries, including
// the compound keyset predicate used by the production projection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface FixtureTask extends Row {
  id: string;
  ownerUserId: string | null;
  status: string;
  provisioningDiagnosticSchemaVersion: number | null;
  provisioningDiagnosticNextAttempt: number | null;
  admissionWork: { state: string } | null;
}

class ReadableDiagnosticPrisma {
  readonly tasks = new Map<string, FixtureTask>();
  readonly attempts: Row[] = [];
  readonly events: Row[] = [];
  taskReadCount = 0;
  evidenceReadCount = 0;

  constructor() {
    this.seed();
  }

  readonly client = {
    task: {
      findFirst: async ({ where }: Row) => {
        this.taskReadCount += 1;
        const task = this.tasks.get(where.id as string);
        return task?.ownerUserId === where.ownerUserId ? { ...task } : null;
      },
      findUnique: async ({ where }: Row) => {
        this.taskReadCount += 1;
        const task = this.tasks.get(where.id as string);
        return task ? { ...task } : null;
      },
    },
    taskProvisioningDiagnosticAttempt: {
      findMany: async ({ where, orderBy, take }: Row) => {
        this.evidenceReadCount += 1;
        const rows = this.attempts
          .filter((row) => row.taskId === where.taskId)
          .map((row) => ({ ...row }));
        sortRows(rows, orderBy);
        return typeof take === 'number' ? rows.slice(0, take) : rows;
      },
    },
    taskProvisioningDiagnosticEvent: {
      findMany: async ({ where, orderBy, take }: Row) => {
        this.evidenceReadCount += 1;
        const rows = this.events
          .filter((row) => eventMatches(row, where))
          .map((row) => ({
            ...row,
            attempt: {
              attempt:
                this.attempts.find(
                  (attempt) => attempt.id === row.attemptId,
                )?.attempt ?? 0,
            },
          }));
        sortRows(rows, orderBy);
        return typeof take === 'number' ? rows.slice(0, take) : rows;
      },
    },
    taskProvisioningDiagnosticCompaction: {
      findUnique: async () => {
        this.evidenceReadCount += 1;
        return null;
      },
    },
  };

  prisma(): PrismaService {
    return this.client as unknown as PrismaService;
  }

  resetReads(): void {
    this.taskReadCount = 0;
    this.evidenceReadCount = 0;
  }

  private seed(): void {
    this.addTask(NOT_STARTED_TASK_ID, OWNER_ID, 'pending', 1, 1, 'accepted');
    this.addTask(PARTIAL_TASK_ID, OWNER_ID, 'running', 1, 2, 'running');
    this.addTask(COMPLETE_TASK_ID, OWNER_ID, 'failed', 1, 2, 'failed');
    this.addTask(UNAVAILABLE_TASK_ID, OWNER_ID, 'pending', null, null, 'accepted');
    this.addTask(CROSS_OWNER_TASK_ID, OTHER_OWNER_ID, 'pending', 1, 1, 'accepted');
    this.addTask(OWNERLESS_TASK_ID, null, 'pending', 1, 1, 'accepted');

    this.attempts.push(
      attemptRow({
        id: '30000000-0000-4000-8000-000000000002',
        taskId: PARTIAL_TASK_ID,
        attempt: 1,
        state: 'active',
        stage: 'provider_selection',
        coverage: 'partial',
      }),
      attemptRow({
        id: ATTEMPT_ID,
        taskId: COMPLETE_TASK_ID,
        attempt: 1,
        state: 'failed',
        stage: 'runtime_setup',
        coverage: 'complete',
        primaryOutcome: 'failed',
        primaryCause: 'command_failed',
        primaryRetryable: false,
        primaryExitCode: 9,
        primaryObservedAt: OBSERVED_AT,
        cleanupState: 'failed',
        cleanupCause: 'cleanup_failed',
        cleanupAttemptCount: 1,
        cleanupLastAttemptOutcome: 'failed',
        cleanupObservedAt: OBSERVED_AT,
        eventCount: 4,
        finishedAt: OBSERVED_AT,
        completenessMarkedAt: OBSERVED_AT,
      }),
    );

    this.events.push(
      eventRow({
        id: '50000000-0000-4000-8000-000000000001',
        sequence: 1,
        operationId: PRIMARY_OPERATION_ID,
        channel: 'primary',
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        commandKind: 'runtime_setup',
        outcome: 'started',
      }),
      eventRow({
        id: '50000000-0000-4000-8000-000000000002',
        sequence: 2,
        operationId: PRIMARY_OPERATION_ID,
        channel: 'primary',
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        commandKind: 'runtime_setup',
        outcome: 'failed',
        durationMs: 10,
        cause: 'command_failed',
        retryable: false,
        nativeState: 'failed',
        exitCode: 9,
      }),
      eventRow({
        id: '50000000-0000-4000-8000-000000000003',
        sequence: 3,
        operationId: CLEANUP_OPERATION_ID,
        channel: 'cleanup',
        stage: 'cleanup',
        operation: 'sandbox_delete',
        commandKind: 'sandbox_cleanup',
        outcome: 'started',
      }),
      eventRow({
        id: '50000000-0000-4000-8000-000000000004',
        sequence: 4,
        operationId: CLEANUP_OPERATION_ID,
        channel: 'cleanup',
        stage: 'cleanup',
        operation: 'sandbox_delete',
        commandKind: 'sandbox_cleanup',
        outcome: 'failed',
        durationMs: 5,
        cause: 'cleanup_failed',
        retryable: true,
        nativeState: 'failed',
      }),
    );
  }

  private addTask(
    id: string,
    ownerUserId: string | null,
    status: string,
    schemaVersion: number | null,
    nextAttempt: number | null,
    admissionState: string,
  ): void {
    this.tasks.set(id, {
      id,
      ownerUserId,
      status,
      provisioningDiagnosticSchemaVersion: schemaVersion,
      provisioningDiagnosticNextAttempt: nextAttempt,
      admissionWork: { state: admissionState },
      internalCanary: INTERNAL_CANARY,
    });
  }
}

function attemptRow(input: Row): Row {
  return {
    id: input.id,
    taskId: input.taskId,
    schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    attempt: input.attempt,
    admissionMode: 'durable',
    providerFamily: 'boxlite',
    state: input.state,
    stage: input.stage,
    coverage: input.coverage,
    primaryOutcome: input.primaryOutcome ?? null,
    primaryCause: input.primaryCause ?? null,
    primaryRetryable: input.primaryRetryable ?? null,
    primaryExitCode: input.primaryExitCode ?? null,
    primaryObservedAt: input.primaryObservedAt ?? null,
    cleanupState: input.cleanupState ?? 'not_required',
    cleanupCause: input.cleanupCause ?? null,
    cleanupAttemptCount: input.cleanupAttemptCount ?? 0,
    cleanupLastAttemptOutcome: input.cleanupLastAttemptOutcome ?? null,
    cleanupObservedAt: input.cleanupObservedAt ?? null,
    eventCount: input.eventCount ?? 0,
    truncated: false,
    startedAt: STARTED_AT,
    finishedAt: input.finishedAt ?? null,
    completenessMarkedAt: input.completenessMarkedAt ?? null,
  };
}

function eventRow(input: Row): Row {
  return {
    id: input.id,
    attemptId: ATTEMPT_ID,
    taskId: COMPLETE_TASK_ID,
    schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    idempotencyKey: `conformance:${input.sequence}`,
    sequence: input.sequence,
    operationId: input.operationId,
    admissionMode: 'durable',
    providerFamily: 'boxlite',
    stage: input.stage,
    operation: input.operation,
    channel: input.channel,
    commandKind: input.commandKind,
    outcome: input.outcome,
    observedAt: OBSERVED_AT,
    durationMs: input.durationMs ?? null,
    cause: input.cause ?? null,
    retryable: input.retryable ?? null,
    httpStatusClass: null,
    nativeState: input.nativeState ?? null,
    anomaly: input.anomaly ?? null,
    exitCode: input.exitCode ?? null,
    timeoutMs: null,
  };
}

function eventMatches(row: Row, where: Row): boolean {
  if (row.taskId !== where.taskId) return false;
  if (
    where.schemaVersion !== undefined &&
    row.schemaVersion !== where.schemaVersion
  ) {
    return false;
  }
  if (!Array.isArray(where.OR)) return true;
  return where.OR.some((candidate: Row) => {
    const afterTime = candidate.observedAt?.gt as Date | undefined;
    if (afterTime) return row.observedAt.getTime() > afterTime.getTime();
    const atTime = candidate.observedAt as Date | undefined;
    const afterId = candidate.id?.gt as string | undefined;
    return Boolean(
      atTime &&
        afterId &&
        row.observedAt.getTime() === atTime.getTime() &&
        row.id > afterId,
    );
  });
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): void {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  rows.sort((left, right) => {
    for (const clause of clauses) {
      const [field, direction] = Object.entries(clause)[0]!;
      const leftValue = comparable(left[field]);
      const rightValue = comparable(right[field]);
      if (leftValue === rightValue) continue;
      const comparison = leftValue < rightValue ? -1 : 1;
      return direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
}

function comparable(value: unknown): string | number {
  return value instanceof Date ? value.getTime() : (value as string | number);
}

class MutableDiagnosticsGate
  implements TaskProvisioningDiagnosticsCapabilityGatePort
{
  open = true;
  readChecks = 0;

  assertReadOpen(): void {
    this.readChecks += 1;
    if (!this.open) throw new Error('internal attestation detail');
  }

  assertScopesGrantable(): void {}
}

interface FixtureSurfaces {
  readonly db: ReadableDiagnosticPrisma;
  readonly gate: MutableDiagnosticsGate;
  readonly controller: V1TaskProvisioningDiagnosticsController;
  readonly tools: Map<string, ToolCallback>;
}

type ToolCallback = (
  args: Record<string, unknown>,
  extra: ToolExtra,
) => Promise<unknown>;

function fixtureSurfaces(): FixtureSurfaces {
  const db = new ReadableDiagnosticPrisma();
  const gate = new MutableDiagnosticsGate();
  const service = new TaskProvisioningDiagnosticsService(db.prisma());
  const facade = new TaskProvisioningDiagnosticsPublicQueryService(service, gate);
  const controller = new V1TaskProvisioningDiagnosticsController(facade);
  const factory = new McpServerFactory(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    db.prisma(),
    {} as never,
    {} as never,
    {} as never,
    facade,
  );
  const tools = new Map<string, ToolCallback>();
  const registrar: ToolRegistrar = {
    registerTool(name, _config, callback) {
      tools.set(name, callback as unknown as ToolCallback);
    },
  };
  registerMcpTools(registrar, factory as McpToolDeps);
  return { db, gate, controller, tools };
}

function ownerExtra(scopes = ['tasks:diagnostics']): ToolExtra {
  return {
    authInfo: {
      token: 'diagnostics-conformance-token',
      clientId: 'diagnostics-conformance',
      scopes,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      extra: { userId: OWNER_ID },
    },
  };
}

function fixtureRequest(
  taskId: string,
  query: Record<string, unknown> = {},
  principal: OperatorPrincipal = OWNER_PRINCIPAL,
): AuthenticatedRequest {
  return {
    operatorPrincipal: principal,
    params: { id: taskId },
    query,
    headers: {},
  } as unknown as AuthenticatedRequest;
}

function fixtureContext(
  handler: PublicV1Handler,
  request: AuthenticatedRequest,
): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader() {} }),
    }),
  } as unknown as ExecutionContext;
}

async function restRead(
  controller: V1TaskProvisioningDiagnosticsController,
  taskId: string,
  query: Record<string, unknown> = {},
  principal: OperatorPrincipal = OWNER_PRINCIPAL,
): Promise<TaskProvisioningDiagnosticsResponse> {
  const request = fixtureRequest(taskId, query, principal);
  const handler = controller.read;
  const context = fixtureContext(handler, request);
  assert.equal(new PublicV1OperationGuard().canActivate(context), true);
  const input = publicV1RequestContext(request)?.input;
  assert.ok(input);
  return firstValueFrom(
    new PublicV1ContractInterceptor().intercept(context, {
      handle: () =>
        from(
          controller.read(
            (input.params as { id: string }).id,
            input.query as TaskProvisioningDiagnosticsQuery,
            request,
          ),
        ),
    } as CallHandler),
  ) as Promise<TaskProvisioningDiagnosticsResponse>;
}

async function mcpRead(
  surfaces: FixtureSurfaces,
  taskId: string,
  query: Record<string, unknown> = {},
  extra: ToolExtra = ownerExtra(),
): Promise<unknown> {
  const tool = surfaces.tools.get('get_task_provisioning_diagnostics');
  assert.ok(tool);
  return tool({ id: taskId, ...query }, extra);
}

function parseMcpSuccess(result: unknown): {
  structured: TaskProvisioningDiagnosticsResponse;
  rawStructured: unknown;
  rawText: string;
} {
  assert.ok(result && typeof result === 'object');
  const value = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  assert.notEqual(value.isError, true);
  assert.equal(value.content?.length, 1);
  assert.equal(value.content?.[0]?.type, 'text');
  assert.equal(typeof value.content?.[0]?.text, 'string');
  return {
    structured: TaskProvisioningDiagnosticsResponseSchema.parse(
      value.structuredContent,
    ),
    rawStructured: value.structuredContent,
    rawText: value.content![0]!.text!,
  };
}

function assertExactTransportParity(
  rest: TaskProvisioningDiagnosticsResponse,
  mcpResult: unknown,
): TaskProvisioningDiagnosticsResponse {
  const restWire = JSON.parse(JSON.stringify(rest)) as unknown;
  const mcp = parseMcpSuccess(mcpResult);
  const structuredWire = JSON.parse(
    JSON.stringify(mcp.rawStructured),
  ) as unknown;
  assert.deepEqual(structuredWire, restWire);
  assert.equal(JSON.stringify(structuredWire), JSON.stringify(restWire));
  assert.equal(mcp.rawText, JSON.stringify(structuredWire, null, 2));
  assert.deepEqual(JSON.parse(mcp.rawText), structuredWire);
  return mcp.structured;
}

function captureSyncFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected a synchronous boundary failure');
}

async function captureAsyncFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail('expected an asynchronous boundary failure');
}

function assertRestFailure(failure: unknown, code: PublicErrorCode): void {
  assert.ok(failure instanceof HttpException);
  assert.equal(
    normalizePublicSurfaceFailure(
      failure,
      code === 'owner_required' ? { code: 'owner_required' } : undefined,
    ).code,
    code,
  );
}

function assertMcpFailure(result: unknown, code: PublicErrorCode): void {
  assert.ok(result && typeof result === 'object');
  const value = result as {
    isError?: boolean;
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
  };
  assert.equal(value.isError, true);
  assert.equal(value.structuredContent, undefined);
  const envelope = value._meta?.['com.cloud-agent-platform/public-error'] as
    | { code?: string; retryable?: boolean }
    | undefined;
  assert.equal(envelope?.code, code);
  assert.equal(envelope?.retryable, MCP_PUBLIC_ERROR_MAP[code].retryable);
}

function restErrorBody(failure: unknown): unknown {
  assert.ok(failure instanceof HttpException);
  return failure.getResponse();
}

function mcpErrorEnvelope(result: unknown): unknown {
  assert.ok(result && typeof result === 'object');
  return (result as { _meta?: Record<string, unknown> })._meta?.[
    'com.cloud-agent-platform/public-error'
  ];
}

test('real REST and MCP adapters return the same canonical state projections', async () => {
  const surfaces = fixtureSurfaces();
  const cases = [
    [NOT_STARTED_TASK_ID, 'not_started'],
    [PARTIAL_TASK_ID, 'partial'],
    [COMPLETE_TASK_ID, 'complete'],
    [UNAVAILABLE_TASK_ID, 'unavailable'],
  ] as const;

  for (const [taskId, coverage] of cases) {
    const rest = await restRead(surfaces.controller, taskId);
    const mcp = await mcpRead(surfaces, taskId);
    const structured = assertExactTransportParity(rest, mcp);
    assert.equal(rest.coverage, coverage);
    assert.equal(structured.coverage, coverage);
  }

  assert.equal(
    surfaces.gate.readChecks,
    cases.length * 4,
    'each real facade read is gated before and after its ledger lookup',
  );
});

test('real keyset pagination preserves same-timestamp primary and cleanup evidence without gaps', async () => {
  const surfaces = fixtureSurfaces();
  const restFirst = await restRead(surfaces.controller, COMPLETE_TASK_ID, {
    limit: '2',
  });
  const mcpFirstResult = await mcpRead(surfaces, COMPLETE_TASK_ID, { limit: 2 });
  const mcpFirst = assertExactTransportParity(restFirst, mcpFirstResult);
  assert.equal(restFirst.coverage, 'complete');
  assert.equal(restFirst.events.length, 2);
  assert.ok(restFirst.nextCursor);

  const restSecond = await restRead(surfaces.controller, COMPLETE_TASK_ID, {
    limit: '2',
    cursor: restFirst.nextCursor,
  });
  const mcpSecondResult = await mcpRead(surfaces, COMPLETE_TASK_ID, {
    limit: 2,
    cursor: mcpFirst.nextCursor,
  });
  const mcpSecond = assertExactTransportParity(restSecond, mcpSecondResult);

  const eventIds = [...restFirst.events, ...restSecond.events].map(
    (event) => event.eventId,
  );
  assert.deepEqual(eventIds, [
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000004',
  ]);
  assert.equal(new Set(eventIds).size, 4);
  assert.equal(restSecond.nextCursor, null);
  assert.equal(mcpSecond.nextCursor, null);
  assert.deepEqual(
    restFirst.attempts[0]?.primary,
    {
      outcome: 'failed',
      cause: 'command_failed',
      retryable: false,
      exitCode: 9,
      observedAt: OBSERVED_AT,
    },
  );
  assert.deepEqual(restFirst.attempts[0]?.cleanup, {
    state: 'failed',
    cause: 'cleanup_failed',
    attemptCount: 1,
    lastAttemptOutcome: 'failed',
    observedAt: OBSERVED_AT,
  });
  assert.deepEqual(
    [...restFirst.events, ...restSecond.events].map((event) => event.channel),
    ['primary', 'primary', 'cleanup', 'cleanup'],
  );
});

test('closed deployment gate returns one unavailable contract before any task or evidence read', async () => {
  const surfaces = fixtureSurfaces();
  surfaces.gate.open = false;

  const restFailure = await captureAsyncFailure(() =>
    restRead(surfaces.controller, COMPLETE_TASK_ID),
  );
  assertRestFailure(restFailure, 'task_provisioning_diagnostics_unavailable');
  assert.equal((restFailure as HttpException).getStatus(), 503);
  assert.deepEqual(restErrorBody(restFailure), {
    code: 'task_provisioning_diagnostics_unavailable',
    message: 'Task provisioning diagnostics are temporarily unavailable.',
    retryable: true,
  });
  assert.equal(surfaces.db.taskReadCount, 0);
  assert.equal(surfaces.db.evidenceReadCount, 0);

  const mcpFailure = await mcpRead(surfaces, COMPLETE_TASK_ID);
  assertMcpFailure(mcpFailure, 'task_provisioning_diagnostics_unavailable');
  assert.deepEqual(mcpErrorEnvelope(mcpFailure), {
    code: 'task_provisioning_diagnostics_unavailable',
    message: 'Task provisioning diagnostics are temporarily unavailable.',
    retryable: true,
  });
  assert.equal(surfaces.db.taskReadCount, 0);
  assert.equal(surfaces.db.evidenceReadCount, 0);
  const unavailableWire = JSON.stringify({
    rest: restErrorBody(restFailure),
    mcp: mcpFailure,
  });
  assert.equal(unavailableWire.includes(COMPLETE_TASK_ID), false);
  assert.equal(unavailableWire.includes(INTERNAL_CANARY), false);
});

test('scope and owner boundaries reject REST and MCP before the real facade', async () => {
  const surfaces = fixtureSurfaces();
  const handler = surfaces.controller.read;
  const insufficientPrincipal: OperatorPrincipal = {
    ...OWNER_PRINCIPAL,
    scopes: ['tasks:read'],
  };
  const ownerlessPrincipal: OperatorPrincipal = {
    kind: 'legacy-token',
    user: null,
  };
  const ownerlessExtra = ownerExtra();
  delete (ownerlessExtra.authInfo?.extra as { userId?: string }).userId;

  for (const fixture of [
    {
      code: 'insufficient_scope' as const,
      request: fixtureRequest(COMPLETE_TASK_ID, {}, insufficientPrincipal),
      extra: ownerExtra(['tasks:read']),
    },
    {
      code: 'owner_required' as const,
      request: fixtureRequest(COMPLETE_TASK_ID, {}, ownerlessPrincipal),
      extra: ownerlessExtra,
    },
  ]) {
    const restFailure = captureSyncFailure(() =>
      new PublicV1OperationGuard().canActivate(
        fixtureContext(handler, fixture.request),
      ),
    );
    assertRestFailure(restFailure, fixture.code);
    assert.equal((restFailure as HttpException).getStatus(), 403, fixture.code);
    assertMcpFailure(
      await mcpRead(surfaces, COMPLETE_TASK_ID, {}, fixture.extra),
      fixture.code,
    );
  }

  assert.equal(surfaces.db.taskReadCount, 0);
  assert.equal(surfaces.db.evidenceReadCount, 0);
  assert.equal(surfaces.gate.readChecks, 0);
});

test('cross-owner, ownerless, and unknown ids share one non-enumerating result with zero evidence reads', async () => {
  const surfaces = fixtureSurfaces();
  const restBodies: unknown[] = [];
  const mcpEnvelopes: unknown[] = [];
  const deniedIds = [
    CROSS_OWNER_TASK_ID,
    OWNERLESS_TASK_ID,
    UNKNOWN_TASK_ID,
  ] as const;

  for (const taskId of deniedIds) {
    surfaces.db.resetReads();
    const restFailure = await captureAsyncFailure(() =>
      restRead(surfaces.controller, taskId),
    );
    assertRestFailure(restFailure, 'not_found');
    restBodies.push(restErrorBody(restFailure));
    assert.equal(surfaces.db.taskReadCount, 1, taskId);
    assert.equal(surfaces.db.evidenceReadCount, 0, taskId);

    surfaces.db.resetReads();
    const mcpFailure = await mcpRead(surfaces, taskId);
    assertMcpFailure(mcpFailure, 'not_found');
    mcpEnvelopes.push(mcpErrorEnvelope(mcpFailure));
    assert.equal(surfaces.db.taskReadCount, 1, taskId);
    assert.equal(surfaces.db.evidenceReadCount, 0, taskId);
  }

  assert.deepEqual(restBodies, [restBodies[0], restBodies[0], restBodies[0]]);
  assert.deepEqual(mcpEnvelopes, [
    mcpEnvelopes[0],
    mcpEnvelopes[0],
    mcpEnvelopes[0],
  ]);
  const deniedWire = JSON.stringify({ restBodies, mcpEnvelopes });
  for (const id of deniedIds) assert.equal(deniedWire.includes(id), false, id);
  assert.equal(deniedWire.includes(INTERNAL_CANARY), false);
});

test('malformed limits and cursors fail identically without reading ledger evidence', async () => {
  const fixtures = [
    { rest: { limit: '0' }, mcp: { limit: 0 } },
    { rest: { limit: '201' }, mcp: { limit: 201 } },
    { rest: { limit: '1.5' }, mcp: { limit: 1.5 } },
    { rest: { cursor: 'not-a-diagnostic-cursor' }, mcp: { cursor: 'not-a-diagnostic-cursor' } },
  ] as const;

  for (const fixture of fixtures) {
    const surfaces = fixtureSurfaces();
    const restFailure = await captureAsyncFailure(() =>
      restRead(surfaces.controller, COMPLETE_TASK_ID, fixture.rest),
    );
    assertRestFailure(restFailure, 'validation_failed');
    assert.equal(surfaces.db.taskReadCount, 0);
    assert.equal(surfaces.db.evidenceReadCount, 0);

    surfaces.db.resetReads();
    const mcpFailure = await mcpRead(
      surfaces,
      COMPLETE_TASK_ID,
      fixture.mcp,
    );
    assertMcpFailure(mcpFailure, 'validation_failed');
    assert.equal(surfaces.db.taskReadCount, 0);
    assert.equal(surfaces.db.evidenceReadCount, 0);
  }
});

test('diagnostics remain additive and do not expand the ordinary Task response', () => {
  const taskOperation = PUBLIC_V1_OPERATIONS.find(
    (operation) => operation.id === 'tasks.get',
  );
  const diagnosticsOperation = PUBLIC_V1_OPERATIONS.find(
    (operation) => operation.id === 'tasks.provisioningDiagnostics',
  );
  assert.ok(taskOperation?.responseSchema === TaskResponseSchema);
  assert.ok(
    diagnosticsOperation?.responseSchema ===
      TaskProvisioningDiagnosticsResponseSchema,
  );
  for (const field of ['coverage', 'attempts', 'events', 'compaction', 'nextCursor']) {
    assert.equal(field in TaskResponseSchema.shape, false, field);
  }
  assert.equal('provisioningDiagnostics' in TaskResponseSchema.shape, false);
});
