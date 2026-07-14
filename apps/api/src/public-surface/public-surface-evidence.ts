import 'reflect-metadata';

import {
  MODULE_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  PUBLIC_V1_OPERATIONS,
  type McpMappedOperation,
  type PublicV1Operation,
} from '@cap/contracts';

import {
  MCP_ADAPTERS,
  registerMcpTools,
  type McpAdapterMap,
  type McpToolDeps,
  type ToolRegistrar,
} from '../mcp/mcp-tools';
import {
  publicV1OperationForHandler,
  type PublicV1Handler,
} from './public-v1-operation';
import { V1Module } from '../v1/v1.module';

type InputSource = 'params' | 'query' | 'headers' | 'body';

interface CapturedToolConfig {
  readonly inputSchema?: unknown;
}

export interface PublicSurfaceOperationEvidence {
  readonly id: string;
  readonly registry: {
    readonly rest: { readonly inputFields: readonly string[] };
    readonly mcp:
      | {
          readonly status: 'mapped';
          readonly tool: string;
          readonly inputFields: readonly string[];
        }
      | { readonly status: 'excluded'; readonly inputFields: readonly string[] };
  };
  readonly rest: {
    readonly present: boolean;
    readonly inputFields: readonly string[];
    readonly forwardedInputFields: readonly string[];
  };
  readonly mcp:
    | {
        readonly present: true;
        readonly tool: string;
        readonly inputFields: readonly string[];
        readonly forwardedInputFields: readonly string[];
      }
    | { readonly present: false };
}

export interface PublicSurfaceRuntimeEvidence {
  readonly version: 1;
  readonly collector: 'api-focused-public-surface';
  readonly operations: readonly PublicSurfaceOperationEvidence[];
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function inputPairFields(
  operation: PublicV1Operation,
  source: InputSource,
): string[] {
  const pair = (
    operation.input as Partial<
      Record<InputSource, { readonly wire: { readonly shape: object } }>
    >
  )[source];
  if (!pair) return [];
  return Object.keys(pair.wire.shape);
}

function isMcpMappedOperation(
  operation: PublicV1Operation,
): operation is McpMappedOperation {
  return 'tool' in operation.mcp;
}

function restInputFields(operation: PublicV1Operation): string[] {
  return sorted(
    (['params', 'query', 'headers', 'body'] as const).flatMap((source) =>
      inputPairFields(operation, source),
    ),
  );
}

function mcpInputFields(operation: McpMappedOperation): string[] {
  return sorted(
    operation.mcp.inputProjection.sources.flatMap((source) =>
      inputPairFields(operation, source),
    ),
  );
}

function advertisedInputFields(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== 'object') return [];
  const schema = inputSchema as { shape?: unknown; properties?: unknown };
  const actual =
    schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : schema.shape && typeof schema.shape === 'object'
        ? schema.shape
        : inputSchema;
  return sorted(Object.keys(actual));
}

async function officialMcpSdkMetadata(): Promise<
  ReadonlyMap<string, CapturedToolConfig>
> {
  const deps = new Proxy({} as McpToolDeps, {
    get() {
      return async (): Promise<unknown> => ({});
    },
  });
  const server = new McpServer({
    name: 'public-surface-evidence-server',
    version: '1.0.0',
  });
  registerMcpTools(server as unknown as ToolRegistrar, deps);
  const client = new Client({
    name: 'public-surface-evidence-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = await client.listTools();
    return new Map(
      advertised.tools.map((tool) => [
        tool.name,
        { inputSchema: tool.inputSchema },
      ]),
    );
  } finally {
    await client.close();
    await server.close();
  }
}

function reflectedRestEvidence(): ReadonlyMap<
  string,
  { readonly inputFields: readonly string[]; readonly forwardedInputFields: readonly string[] }
> {
  const controllers = Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    V1Module,
  ) as readonly (new (...args: never[]) => unknown)[] | undefined;
  if (!controllers) throw new Error('V1Module has no reflected controllers');

  const evidence = new Map<
    string,
    { readonly inputFields: readonly string[]; readonly forwardedInputFields: readonly string[] }
  >();
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    for (const propertyName of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[propertyName];
      if (typeof handler !== 'function') continue;
      const operation = publicV1OperationForHandler(
        handler as PublicV1Handler,
      );
      if (!operation) continue;
      if (evidence.has(operation.id)) {
        throw new Error(`Duplicate reflected REST operation ${operation.id}`);
      }

      const routeArgs = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        controller,
        propertyName,
      ) as
        | Readonly<
            Record<
              string,
              { readonly data?: { readonly source?: unknown; readonly field?: unknown } }
            >
          >
        | undefined;
      const forwarded = new Set<string>();
      for (const argument of Object.values(routeArgs ?? {})) {
        const source = argument.data?.source;
        if (!(['params', 'query', 'headers', 'body'] as const).includes(
          source as InputSource,
        )) {
          continue;
        }
        const field = argument.data?.field;
        if (typeof field === 'string') forwarded.add(field);
        else {
          for (const name of inputPairFields(operation, source as InputSource)) {
            forwarded.add(name);
          }
        }
      }
      evidence.set(operation.id, {
        inputFields: restInputFields(operation),
        forwardedInputFields: sorted(forwarded),
      });
    }
  }
  return evidence;
}

function containsSentinel(value: unknown, sentinel: string, seen: Set<object>): boolean {
  if (value === sentinel) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsSentinel(entry, sentinel, seen));
  }
  return Object.values(value).some((entry) =>
    containsSentinel(entry, sentinel, seen),
  );
}

async function mcpForwardedInputFields(
  operation: McpMappedOperation,
  adapters: McpAdapterMap,
): Promise<string[]> {
  const expectedFields = mcpInputFields(operation);
  const sentinels = new Map(
    expectedFields.map((field) => [
      field,
      `__cap_public_surface_${operation.id}_${field}__`,
    ]),
  );
  const input = Object.fromEntries(sentinels);
  const calls: unknown[][] = [];
  const deps = new Proxy({} as McpToolDeps, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      return async (...args: unknown[]): Promise<unknown> => {
        calls.push(args);
        return {};
      };
    },
  });
  const adapter = adapters[operation.id];
  await (adapter.execute as (
    value: Record<string, unknown>,
    context: {
      readonly deps: McpToolDeps;
      readonly actorUserId: string;
      readonly ownerUserId: string;
    },
  ) => Promise<unknown>)(input, {
    deps,
    actorUserId: '__cap_actor__',
    ownerUserId: '__cap_owner__',
  });

  return expectedFields.filter((field) =>
    calls.some((args) =>
      containsSentinel(args, sentinels.get(field)!, new Set<object>()),
    ),
  );
}

/**
 * Collect machine-readable evidence from the real reflected handlers, actual
 * MCP registration metadata, and executable adapter map used by the focused
 * gate. Optional adapter injection exists only for mutation tests.
 */
export async function collectPublicSurfaceRuntimeEvidence(
  adapters: McpAdapterMap = MCP_ADAPTERS,
): Promise<PublicSurfaceRuntimeEvidence> {
  const rest = reflectedRestEvidence();
  const mcpConfigs = await officialMcpSdkMetadata();
  const operations: PublicSurfaceOperationEvidence[] = [];
  const expectedTools = sorted(
    PUBLIC_V1_OPERATIONS.flatMap((operation) =>
      isMcpMappedOperation(operation) ? [operation.mcp.tool] : [],
    ),
  );
  const actualTools = sorted(mcpConfigs.keys());
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(
      `Official MCP SDK inventory differs from registry: ${JSON.stringify({ expectedTools, actualTools })}`,
    );
  }

  for (const operation of PUBLIC_V1_OPERATIONS) {
    const reflectedRest = rest.get(operation.id);
    const expectedRest = restInputFields(operation);
    if (isMcpMappedOperation(operation)) {
      const config = mcpConfigs.get(operation.mcp.tool);
      const expectedMcp = mcpInputFields(operation);
      operations.push({
        id: operation.id,
        registry: {
          rest: { inputFields: expectedRest },
          mcp: {
            status: 'mapped',
            tool: operation.mcp.tool,
            inputFields: expectedMcp,
          },
        },
        rest: reflectedRest
          ? { present: true, ...reflectedRest }
          : { present: false, inputFields: [], forwardedInputFields: [] },
        mcp: config
          ? {
              present: true,
              tool: operation.mcp.tool,
              inputFields: advertisedInputFields(config.inputSchema),
              forwardedInputFields: await mcpForwardedInputFields(
                operation,
                adapters,
              ),
            }
          : { present: false },
      });
    } else {
      operations.push({
        id: operation.id,
        registry: {
          rest: { inputFields: expectedRest },
          mcp: { status: 'excluded', inputFields: [] },
        },
        rest: reflectedRest
          ? { present: true, ...reflectedRest }
          : { present: false, inputFields: [], forwardedInputFields: [] },
        mcp: { present: false },
      });
    }
  }

  return {
    version: 1,
    collector: 'api-focused-public-surface',
    operations,
  };
}
