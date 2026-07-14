/**
 * MCP tool definitions (remote-mcp-server, Track `mcp-endpoint-tools`, task 4.2).
 *
 * The exact advertised inventory and each tool's policy/schema metadata are
 * projected from `PUBLIC_V1_OPERATIONS`. Thin operation-id adapters delegate to
 * the EXISTING console services (one admission path, design D4); adding a mapped
 * registry entry without its adapter is a compile-time error.
 *
 * SCOPE GATING. Every `/mcp` request is first validated by the SDK
 * `requireBearerAuth` → `resolveMcpToken` (registered in `main.ts`, Track 7), which
 * attaches the resolved {@link import('@modelcontextprotocol/sdk/server/auth/types.js').AuthInfo}
 * (carrying the token's granted `scopes`) onto the request. The SDK threads that
 * `AuthInfo` into each tool callback as `extra.authInfo`, so a tool reads the
 * SAME scopes the resolved `mcp` principal carries and enforces its required scope
 * BEFORE acting. A missing scope yields an MCP error with 403-semantics
 * ({@link scopeError}) and performs NO state change — the parallel of the REST
 * controllers' `403 insufficient scope` (distinct from the 401 a missing bearer
 * gets at the transport boundary).
 *
 * NO FORK. The tools call the same {@link McpToolDeps} surface the console/`/v1`
 * use; there is no standalone provisioning path (no `start_sandbox`), and the raw
 * PTY/WebSocket terminal stream is NEVER exposed via a tool — only durable,
 * already-archived transcript text is read.
 *
 * This module is PURE registration logic: it takes an `McpServer` and a narrow
 * `McpToolDeps` port, so the verify-phase tests drive the tool callbacks directly
 * (fake deps + a synthesized `extra`) with no Nest DI container and no DB.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import {
  PUBLIC_V1_OPERATIONS,
  PublicErrorEnvelopeSchema,
  composePublicInputWireSchema,
  type CreateScheduleRequest,
  type CreateTaskBody,
  type DispatchScheduleRequest,
  type McpMappedOperation,
  type McpMappedOperationId,
  type PublicErrorCode,
  type PublicV1OperationById,
  type RepoResponse,
  type RuntimeModelCatalog,
  type RuntimeModelCatalogQuery,
  type ScheduleResponse,
  type Scope,
  type SessionHistory,
  type TaskResponse,
  type UpdateScheduleRequest,
  type V1ListQuery,
  type V1ListReposResponse,
  type V1ListSchedulesResponse,
  type V1ListScheduleRunsResponse,
  type V1ListTasksResponse,
  type V1ScheduleListQuery,
} from '@cap/contracts';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';
import {
  PublicSurfaceError,
  normalizePublicSurfaceFailure,
  projectPublicSurfaceErrorToMcp,
} from '../public-surface/public-surface-error';

/**
 * The NARROW slice of `McpServer.registerTool` the tools use. Declared as a local
 * structural interface — rather than referencing the SDK's `McpServer` generic —
 * deliberately: the SDK's `registerTool` overload (zod v3.25 + TS 5.9) trips
 * `TS2589 "type instantiation is excessively deep"` when its `ZodRawShape`/
 * `ToolCallback` conditional generics are instantiated inline for each tool. This
 * port describes the EXACT call shape with plain types, so registration type-checks
 * without that pathological inference; the real `McpServer` (structurally
 * compatible) is passed at the single call site in `mcp.server.ts`. Runtime
 * behaviour is identical — the real `registerTool` runs.
 */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: z.ZodRawShape | z.ZodTypeAny;
      outputSchema?: z.ZodRawShape | z.ZodTypeAny;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    },
    cb: (...args: never[]) => unknown,
  ): unknown;
}

/**
 * The narrow service surface the tools delegate to — every method is already
 * implemented by an EXISTING console service (no second admission path):
 *
 *   - `createTask` → `TasksService.create(repoId, body, userId?)` (the console
 *     path: persist the row then offer to the guardrails semaphore — it returns a
 *     handle WITHOUT waiting for the run to finish);
 *   - `getTask` / `listTasks` / `stopTask` → `TasksService.findById|list|stop`;
 *   - `getTranscript` → the durable session-history read (durable-first, container
 *     fallback) the `/v1` transcript + console session-history surfaces share;
 *   - `listRepos` / `getRepo` → the same repo reads and keyset page as `/v1`.
 *
 * Modelling the deps as this port (rather than the concrete Nest services) keeps
 * the registration pure and unit-testable; `McpServerFactory` binds it to the
 * real services.
 */
export interface McpToolDeps {
  createTask(
    repoId: string,
    body: CreateTaskBody,
    userId?: string,
  ): Promise<TaskResponse>;
  queryRuntimeModels(
    ownerUserId: string,
    query: RuntimeModelCatalogQuery,
  ): Promise<RuntimeModelCatalog>;
  getTask(id: string): Promise<TaskResponse>;
  listTasks(query: V1ListQuery): Promise<V1ListTasksResponse>;
  stopTask(id: string, userId?: string): Promise<TaskResponse>;
  getTranscript(id: string): Promise<SessionHistory>;
  listRepos(query: V1ListQuery): Promise<V1ListReposResponse>;
  getRepo(id: string): Promise<RepoResponse>;
  createSchedule(
    ownerUserId: string,
    body: CreateScheduleRequest,
  ): Promise<ScheduleResponse>;
  listSchedules(
    ownerUserId: string,
    query: V1ScheduleListQuery,
  ): Promise<V1ListSchedulesResponse>;
  getSchedule(ownerUserId: string, id: string): Promise<ScheduleResponse>;
  updateSchedule(
    ownerUserId: string,
    id: string,
    body: UpdateScheduleRequest,
  ): Promise<ScheduleResponse>;
  pauseSchedule(ownerUserId: string, id: string): Promise<ScheduleResponse>;
  resumeSchedule(ownerUserId: string, id: string): Promise<ScheduleResponse>;
  dispatchSchedule(
    ownerUserId: string,
    id: string,
    body: DispatchScheduleRequest,
  ): Promise<ScheduleResponse>;
  deleteSchedule(ownerUserId: string, id: string): Promise<void>;
  listScheduleRuns(
    ownerUserId: string,
    id: string,
    query: V1ScheduleListQuery,
  ): Promise<V1ListScheduleRunsResponse>;
}

/**
 * The slice of the SDK request-handler `extra` a tool reads: the resolved
 * `authInfo` (present on every `/mcp` request because `requireBearerAuth` ran
 * first). Narrowed so the tests can synthesize it without the full SDK extra.
 */
export interface ToolExtra {
  readonly authInfo?: AuthInfo;
}

/** Resolve the MCP token owner's account primary key from SDK request metadata. */
export function userIdFromExtra(extra: ToolExtra): string | undefined {
  const raw = (extra.authInfo?.extra as { userId?: unknown } | undefined)?.userId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

type SchemaPairOutput<Value> = Value extends {
  readonly parse: infer Schema extends z.ZodTypeAny;
}
  ? z.output<Schema>
  : Record<never, never>;

type InputSectionOutput<
  Operation extends McpMappedOperation,
  Source extends 'params' | 'query' | 'body',
> = Operation['input'] extends infer Input
  ? Source extends keyof Input
    ? SchemaPairOutput<Input[Source]>
    : Record<never, never>
  : never;

export type McpAdapterInput<Operation extends McpMappedOperation> =
  InputSectionOutput<Operation, 'params'> &
    InputSectionOutput<Operation, 'query'> &
    InputSectionOutput<Operation, 'body'>;

type McpAdapterOutputSchema<Operation extends McpMappedOperation> =
  Operation['mcp']['outputProjection'] extends {
    readonly schema: infer Schema extends z.ZodTypeAny;
  }
    ? Schema
    : Operation['responseSchema'] extends z.ZodTypeAny
      ? Operation['responseSchema']
      : never;

export type McpAdapterOutput<Operation extends McpMappedOperation> = z.output<
  McpAdapterOutputSchema<Operation>
>;

type McpAdapterContext<Operation extends McpMappedOperation> = {
  readonly deps: McpToolDeps;
  readonly actorUserId: string | undefined;
} & (Operation['ownerPolicy'] extends 'required'
  ? { readonly ownerUserId: string }
  : { readonly ownerUserId: string | undefined });

type McpCompatibilityTextProjection<Operation extends McpMappedOperation> =
  Extract<
    Operation['mcp']['differences'][number],
    { readonly kind: 'mcp-compatibility-text' }
  > extends never
    ? { readonly textProjection?: never }
    : {
        /** Registry-declared compatibility text; structured output stays canonical. */
        readonly textProjection: (
          output: McpAdapterOutput<Operation>,
        ) => unknown;
      };

export type McpAdapter<Operation extends McpMappedOperation> = {
  readonly execute: (
    input: McpAdapterInput<Operation>,
    context: McpAdapterContext<Operation>,
  ) => Promise<McpAdapterOutput<Operation>>;
} & McpCompatibilityTextProjection<Operation>;

export type McpAdapterMap = {
  readonly [Id in McpMappedOperationId]: McpAdapter<
    Extract<PublicV1OperationById<Id>, McpMappedOperation>
  >;
};

/**
 * Behavior only. Tool names, policies, schemas, descriptions, annotations, and
 * declared errors all come from `PUBLIC_V1_OPERATIONS` in the common pipeline.
 */
export const MCP_ADAPTERS: McpAdapterMap = {
  'tasks.create': {
    async execute(input, { deps, actorUserId }) {
      const { repoId, ...body } = input;
      return deps.createTask(repoId, body, actorUserId);
    },
    textProjection(task) {
      return { id: task.id, status: task.status, task };
    },
  },
  'runtimeModels.query': {
    async execute(input, { deps, ownerUserId }) {
      return deps.queryRuntimeModels(ownerUserId, input);
    },
  },
  'tasks.list': {
    async execute(input, { deps }) {
      return deps.listTasks(input);
    },
  },
  'tasks.get': {
    async execute({ id }, { deps }) {
      return deps.getTask(id);
    },
  },
  'tasks.stop': {
    async execute({ id }, { deps, actorUserId }) {
      return deps.stopTask(id, actorUserId);
    },
  },
  'tasks.transcript': {
    async execute({ id }, { deps }) {
      return deps.getTranscript(id);
    },
  },
  'repos.list': {
    async execute(input, { deps }) {
      return deps.listRepos(input);
    },
  },
  'repos.get': {
    async execute({ id }, { deps }) {
      return deps.getRepo(id);
    },
  },
  'schedules.list': {
    async execute(input, { deps, ownerUserId }) {
      return deps.listSchedules(ownerUserId, input);
    },
  },
  'schedules.create': {
    async execute(input, { deps, ownerUserId }) {
      return deps.createSchedule(ownerUserId, input);
    },
  },
  'schedules.get': {
    async execute({ id }, { deps, ownerUserId }) {
      return deps.getSchedule(ownerUserId, id);
    },
  },
  'schedules.update': {
    async execute({ id, ...body }, { deps, ownerUserId }) {
      return deps.updateSchedule(ownerUserId, id, body);
    },
  },
  'schedules.pause': {
    async execute({ id }, { deps, ownerUserId }) {
      return deps.pauseSchedule(ownerUserId, id);
    },
  },
  'schedules.resume': {
    async execute({ id }, { deps, ownerUserId }) {
      return deps.resumeSchedule(ownerUserId, id);
    },
  },
  'schedules.dispatch': {
    async execute({ id, ...body }, { deps, ownerUserId }) {
      return deps.dispatchSchedule(ownerUserId, id, body);
    },
  },
  'schedules.delete': {
    async execute({ id }, { deps, ownerUserId }) {
      await deps.deleteSchedule(ownerUserId, id);
      return { id, deleted: true };
    },
  },
  'schedules.runs': {
    async execute({ id, ...query }, { deps, ownerUserId }) {
      return deps.listScheduleRuns(ownerUserId, id, query);
    },
  },
} satisfies McpAdapterMap;

interface RuntimeMcpAdapter {
  readonly execute: (
    input: Record<string, unknown>,
    context: {
      readonly deps: McpToolDeps;
      readonly actorUserId: string | undefined;
      readonly ownerUserId: string | undefined;
    },
  ) => Promise<unknown>;
  readonly textProjection?: (output: unknown) => unknown;
}

/** Fail closed against the registry-derived scope before parsing or acting. */
export function requireScope(extra: ToolExtra, required: Scope): void {
  const scopes = extra.authInfo?.scopes;
  if (!Array.isArray(scopes) || !scopes.includes(required)) {
    throw scopeError(required);
  }
}

export function scopeError(required: Scope): McpError {
  return publicSurfaceMcpError(
    new PublicSurfaceError({
      code: 'insufficient_scope',
      message: `Insufficient scope: ${required} required (403)`,
    }),
  );
}

function ownerError(): McpError {
  return publicSurfaceMcpError(
    new PublicSurfaceError({
      code: 'owner_required',
      message: 'Schedule tools require an authenticated account owner (403)',
    }),
  );
}

function jsonResult(value: unknown, structuredValue: unknown = value) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: jsonObject(structuredValue),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== 'object'
  ) {
    throw new TypeError('MCP structured content must be a JSON object');
  }
  return normalized as Record<string, unknown>;
}

const PUBLIC_ERROR_META_KEY = 'com.cloud-agent-platform/public-error';

/** Preserve the already-public model-domain error without violating outputSchema. */
function runtimeModelErrorResult(error: RuntimeModelPreflightError) {
  const safeError = jsonObject(error.domainError);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(safeError, null, 2),
      },
    ],
    // `structuredContent` is reserved for the advertised success outputSchema.
    // MCP result metadata remains machine-readable without being validated as a
    // successful catalog/task/schedule response by clients after `tools/list`.
    _meta: {
      [PUBLIC_ERROR_META_KEY]: safeError,
    },
    isError: true as const,
  };
}

function mappedOperations(): readonly McpMappedOperation[] {
  return PUBLIC_V1_OPERATIONS.filter(
    (operation): operation is McpMappedOperation => 'tool' in operation.mcp,
  );
}

function inputPairForSource(
  operation: McpMappedOperation,
  source: 'params' | 'query' | 'body',
) {
  switch (source) {
    case 'params':
      return 'params' in operation.input
        ? operation.input.params
        : undefined;
    case 'query':
      return 'query' in operation.input ? operation.input.query : undefined;
    case 'body':
      return 'body' in operation.input ? operation.input.body : undefined;
  }
}

function projectedInputSchema(
  operation: McpMappedOperation,
): z.AnyZodObject {
  const wireSchemas = operation.mcp.inputProjection.sources.map((source) => {
    const pair = inputPairForSource(operation, source);
    if (!pair) {
      throw new Error(
        `Missing ${source} schema for MCP operation ${operation.id}`,
      );
    }
    return pair.wire;
  });

  if (wireSchemas.length === 0) return z.object({}).strict();
  if (wireSchemas.length === 1) {
    return composePublicInputWireSchema(wireSchemas[0]!);
  }
  if (wireSchemas.length === 2) {
    return composePublicInputWireSchema(wireSchemas[0]!, wireSchemas[1]!);
  }
  return composePublicInputWireSchema(
    wireSchemas[0]!,
    wireSchemas[1]!,
    wireSchemas[2]!,
  );
}

function projectedOutputSchema(operation: McpMappedOperation): z.ZodTypeAny {
  const projection = operation.mcp.outputProjection;
  if (projection !== 'canonical') return projection.schema;
  if (!operation.responseSchema) {
    throw new Error(`Missing MCP output projection for ${operation.id}`);
  }
  return operation.responseSchema;
}

/**
 * The MCP SDK high-level registrar normalizes only root object schemas before
 * exposing `tools/list`. A canonical object union therefore needs the explicit
 * registry difference below. Its wider object is derived solely from the union
 * options (no copied field names), while callback output is still parsed by the
 * untouched canonical schema before it reaches `structuredContent`.
 */
function sdkOutputObjectSchema(
  operation: McpMappedOperation,
  schema: z.ZodTypeAny,
): z.AnyZodObject {
  const relaxationCount = operation.mcp.differences.filter(
    (difference) => difference.kind === 'mcp-output-schema-relaxation',
  ).length;
  if ('shape' in schema && schema.shape) {
    if (relaxationCount !== 0) {
      throw new Error(
        `Unnecessary MCP output schema relaxation for ${operation.id}`,
      );
    }
    return schema as z.AnyZodObject;
  }

  if (relaxationCount !== 1) {
    throw new Error(
      `MCP output schema for ${operation.id} is not a root object and has no exact relaxation decision`,
    );
  }

  const options = (
    schema as unknown as { options?: readonly z.AnyZodObject[] }
  ).options;
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(
      `MCP output schema relaxation for ${operation.id} requires an object union`,
    );
  }

  const fieldNames = new Set(
    options.flatMap((option) => Object.keys(option.shape)),
  );
  const shape: z.ZodRawShape = {};
  for (const fieldName of fieldNames) {
    const variants = options.flatMap((option) => {
      const field = option.shape[fieldName] as z.ZodTypeAny | undefined;
      return field ? [field] : [];
    });
    const uniqueVariants = [...new Set(variants)];
    let fieldSchema: z.ZodTypeAny;
    if (uniqueVariants.length === 1) {
      fieldSchema = uniqueVariants[0]!;
    } else {
      fieldSchema = z.union([
        uniqueVariants[0]!,
        uniqueVariants[1]!,
        ...uniqueVariants.slice(2),
      ]);
    }
    shape[fieldName] =
      variants.length === options.length ? fieldSchema : fieldSchema.optional();
  }
  return z.object(shape);
}

function pickSchemaFields(
  value: Record<string, unknown>,
  schema: z.AnyZodObject,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(schema.shape)
      .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
      .map((field) => [field, value[field]]),
  );
}

function parseProjectedInput(
  operation: McpMappedOperation,
  inputSchema: z.AnyZodObject,
  rawInput: unknown,
): Record<string, unknown> {
  const wireInput = inputSchema.parse(rawInput) as Record<string, unknown>;
  const canonicalInput: Record<string, unknown> = {};
  for (const source of operation.mcp.inputProjection.sources) {
    const pair = inputPairForSource(operation, source);
    if (!pair) {
      throw new Error(
        `Missing ${source} parser for MCP operation ${operation.id}`,
      );
    }
    Object.assign(
      canonicalInput,
      pair.parse.parse(pickSchemaFields(wireInput, pair.wire)),
    );
  }
  return canonicalInput;
}

function assertDeclaredError(
  operation: McpMappedOperation,
  code: PublicErrorCode,
): void {
  if (!(operation.errors as readonly PublicErrorCode[]).includes(code)) {
    throw new McpError(
      ErrorCode.InternalError,
      `Undeclared public error for ${operation.id}`,
    );
  }
}

function publicErrorResult(error: McpError, legacyText = error.message) {
  const parsed = PublicErrorEnvelopeSchema.safeParse(error.data);
  if (!parsed.success) throw error;
  const safeError = jsonObject(parsed.data);
  return {
    content: [
      {
        type: 'text' as const,
        // Keep the pre-existing human text while adding machine-readable
        // metadata. Scope/owner were McpErrors (with the SDK prefix); ordinary
        // domain and validation failures previously exposed their safe message.
        text: legacyText,
      },
    ],
    _meta: {
      [PUBLIC_ERROR_META_KEY]: safeError,
    },
    isError: true as const,
  };
}

function projectFailureToMcpResult(
  operation: McpMappedOperation,
  failure: unknown,
) {
  if (failure instanceof McpError) {
    const parsed = PublicErrorEnvelopeSchema.safeParse(failure.data);
    if (!parsed.success) throw failure;
    assertDeclaredError(operation, parsed.data.code);
    return publicErrorResult(
      failure,
      parsed.data.code === 'validation_failed'
        ? parsed.data.message
        : failure.message,
    );
  }
  const normalized = normalizePublicSurfaceFailure(failure);
  assertDeclaredError(operation, normalized.code);
  return publicErrorResult(
    publicSurfaceMcpError(normalized),
    normalized.message,
  );
}

function publicSurfaceMcpError(error: PublicSurfaceError): McpError {
  const projected = projectPublicSurfaceErrorToMcp(error);
  return new McpError(
    projected.jsonRpcCode,
    projected.message,
    projected.data,
  );
}

function inputValidationError(failure: unknown): McpError {
  const message =
    failure instanceof Error && failure.message.trim().length > 0
      ? failure.message
      : 'Invalid input';
  try {
    return publicSurfaceMcpError(
      new PublicSurfaceError({ code: 'validation_failed', message }),
    );
  } catch {
    return publicSurfaceMcpError(
      new PublicSurfaceError({ code: 'validation_failed' }),
    );
  }
}

function registerOne(
  server: ToolRegistrar,
  operation: McpMappedOperation,
  adapter: RuntimeMcpAdapter,
  deps: McpToolDeps,
  userIdOf: (extra: ToolExtra) => string | undefined,
): void {
  const inputSchema = projectedInputSchema(operation);
  const canonicalOutputSchema = projectedOutputSchema(operation);
  const outputSchema = sdkOutputObjectSchema(
    operation,
    canonicalOutputSchema,
  );
  const description =
    'description' in operation.mcp &&
    typeof operation.mcp.description === 'string'
      ? operation.mcp.description
      : operation.description;
  server.registerTool(
    operation.mcp.tool,
    {
      title: operation.summary,
      description: `${description} Requires the ${operation.scope} scope.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: !operation.destructive,
        destructiveHint: operation.destructive,
        openWorldHint: false,
      },
    },
    async (rawInput: unknown, extra: ToolExtra) => {
      try {
        try {
          requireScope(extra, operation.scope);
        } catch (error) {
          assertDeclaredError(operation, 'insufficient_scope');
          throw error;
        }
        const actorUserId = userIdOf(extra);
        if (operation.ownerPolicy === 'required' && !actorUserId) {
          assertDeclaredError(operation, 'owner_required');
          throw ownerError();
        }
        let input: Record<string, unknown>;
        try {
          input = parseProjectedInput(operation, inputSchema, rawInput);
        } catch (error) {
          assertDeclaredError(operation, 'validation_failed');
          throw inputValidationError(error);
        }
        const output = await adapter.execute(input, {
          deps,
          actorUserId,
          ownerUserId: actorUserId,
        });
        let canonicalOutput: unknown;
        try {
          canonicalOutput = canonicalOutputSchema.parse(output);
        } catch {
          throw new McpError(
            ErrorCode.InternalError,
            `MCP result failed its contract for ${operation.id}`,
          );
        }
        const textValue = adapter.textProjection
          ? adapter.textProjection(canonicalOutput)
          : canonicalOutput;
        return jsonResult(textValue, canonicalOutput);
      } catch (error) {
        if (error instanceof RuntimeModelPreflightError) {
          assertDeclaredError(operation, error.domainError.code);
          return runtimeModelErrorResult(error);
        }
        return projectFailureToMcpResult(operation, error);
      }
    },
  );
}

/** Register every mapped capability from the exact registry and adapter map. */
export function registerMcpTools(
  server: ToolRegistrar,
  deps: McpToolDeps,
  userIdOf: (extra: ToolExtra) => string | undefined = userIdFromExtra,
): void {
  for (const operation of mappedOperations()) {
    // The exact map proves coverage; this is the single correlation cast needed
    // after iterating a runtime discriminated union.
    registerOne(
      server,
      operation,
      MCP_ADAPTERS[operation.id] as RuntimeMcpAdapter,
      deps,
      userIdOf,
    );
  }
}
