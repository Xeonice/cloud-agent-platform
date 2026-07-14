import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import {
  Controller,
  Get,
  Module,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  CreateScheduleRequestSchema,
  DispatchScheduleRequestSchema,
  PUBLIC_V1_OPERATIONS,
  UpdateScheduleRequestSchema,
} from '@cap/contracts';

import { AppModule } from '../app.module';
import { OpenApiController } from '../openapi/openapi.controller';
import {
  PUBLIC_V1_DATA_CONTROLLER_METADATA,
  publicV1OperationForHandler,
  publicV1OperationIdForHandler,
  type PublicV1Handler,
} from '../public-surface/public-v1-operation';
import { V1Module } from './v1.module';

/**
 * `/internal/sandbox/approvals` is a sandbox hook callback, not the public
 * operator API. It is owned by TerminalModule and intentionally excluded from
 * both V1Module and the public operation manifest.
 */
const INTERNAL_ROUTE_KEYS = new Set([
  'POST /internal/sandbox/approvals',
]);

const PUBLIC_V1_METADATA_ROUTE_BY_HANDLER = new Map<PublicV1Handler, string>([
  [OpenApiController.prototype.openapi, 'GET /v1/openapi.json'],
  [OpenApiController.prototype.docs, 'GET /v1/docs'],
]);

const REQUEST_METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.SEARCH]: 'SEARCH',
};

const PUBLIC_V1_PARAMETER_DECORATORS = new Set([
  'PublicV1Input',
  'Req',
  'Res',
]);
const RAW_REQUEST_AUTH_HELPERS = new Set([
  'requirePublicV1Principal',
  'requirePublicV1OwnerId',
]);

function expressionTerminalIdentifier(
  expression: ts.Expression,
): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function decoratorIdentifier(
  decorator: ts.Decorator,
): string | undefined {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  return expressionTerminalIdentifier(expression);
}

function nodeDecoratorNames(node: ts.Node): string[] {
  return (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined)
    ?.map((decorator) => decoratorIdentifier(decorator) ?? '<unknown>') ?? [];
}

function rawRequestUseIsAuthorized(node: ts.Identifier): boolean {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== node) return false;
  const helper = expressionTerminalIdentifier(call.expression);
  return helper !== undefined && RAW_REQUEST_AUTH_HELPERS.has(helper);
}

interface PublicV1SourcePolicyAudit {
  readonly operationIds: readonly string[];
  readonly violations: readonly string[];
}

function publicV1OperationIdFromDecorator(
  decorator: ts.Decorator,
): string | undefined {
  if (!ts.isCallExpression(decorator.expression)) return undefined;
  const [argument] = decorator.expression.arguments;
  return argument && ts.isStringLiteralLike(argument)
    ? argument.text
    : undefined;
}

function publicV1SourcePolicyAudit(
  sourceText: string,
  fileName: string,
): PublicV1SourcePolicyAudit {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const operationIds: string[] = [];

  const inspect = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const operationDecorators = (
        ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined
      )?.filter(
        (decorator) => decoratorIdentifier(decorator) === 'PublicV1Operation',
      ) ?? [];
      if (operationDecorators.length === 0) {
        ts.forEachChild(node, inspect);
        return;
      }
      const methodName = node.name.getText(source);
      if (operationDecorators.length !== 1) {
        violations.push(
          `${fileName}:${methodName} must declare exactly one @PublicV1Operation`,
        );
      }
      const operationId = publicV1OperationIdFromDecorator(
        operationDecorators[0],
      );
      const operation = operationId === undefined
        ? undefined
        : PUBLIC_V1_OPERATIONS.find((entry) => entry.id === operationId);
      if (operationId === undefined) {
        violations.push(
          `${fileName}:${methodName} uses a non-literal @PublicV1Operation id`,
        );
      } else {
        operationIds.push(operationId);
        if (!operation) {
          violations.push(
            `${fileName}:${methodName} references unknown Public V1 operation ${operationId}`,
          );
        }
      }
      if (node.body) {
        const rejectArgumentsAccess = (candidate: ts.Node): void => {
          if (ts.isIdentifier(candidate) && candidate.text === 'arguments') {
            violations.push(
              `${fileName}:${methodName} reads raw method arguments`,
            );
          }
          ts.forEachChild(candidate, rejectArgumentsAccess);
        };
        ts.forEachChild(node.body, rejectArgumentsAccess);
      }
      for (const parameter of node.parameters) {
        const decorators = nodeDecoratorNames(parameter);
        for (const decorator of decorators) {
          if (!PUBLIC_V1_PARAMETER_DECORATORS.has(decorator)) {
            violations.push(
              `${fileName}:${methodName} uses non-canonical @${decorator} input`,
            );
          }
          if (decorator === 'Res' && operation?.streaming !== true) {
            violations.push(
              `${fileName}:${methodName} injects @Res for a non-streaming Public V1 operation`,
            );
          }
        }
        if (!decorators.includes('Req')) continue;
        if (!ts.isIdentifier(parameter.name)) {
          violations.push(
            `${fileName}:${methodName} destructures the raw request`,
          );
          continue;
        }
        const requestName = parameter.name.text;
        let authorizedUses = 0;
        const inspectRequestUse = (candidate: ts.Node): void => {
          if (
            ts.isIdentifier(candidate) &&
            candidate.text === requestName
          ) {
            if (rawRequestUseIsAuthorized(candidate)) {
              authorizedUses += 1;
            } else {
              violations.push(
                `${fileName}:${methodName} consumes raw @Req data outside registry authorization`,
              );
            }
          }
          ts.forEachChild(candidate, inspectRequestUse);
        };
        if (node.body) ts.forEachChild(node.body, inspectRequestUse);
        if (authorizedUses === 0) {
          violations.push(
            `${fileName}:${methodName} injects @Req without registry authorization`,
          );
        }
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return {
    operationIds,
    violations: [...new Set(violations)],
  };
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(absolutePath);
      }
    }
  };
  visit(root);
  return files.sort();
}

function metadataPaths(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [''];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(metadataPaths);
  throw new TypeError(`Unsupported Nest path metadata: ${String(value)}`);
}

function joinRoutePath(controllerPath: string, handlerPath: string): string {
  const segments = [controllerPath, handlerPath]
    .flatMap((value) => value.split('/'))
    .filter(Boolean);
  return `/${segments.join('/')}`.replace(/:([^/]+)/g, '{$1}');
}

interface ReflectedPublicRoute {
  readonly controller: Type<unknown>;
  readonly propertyName: string;
  readonly handler: PublicV1Handler;
  readonly method: string;
  readonly path: string;
}

function reflectedControllerRoutes(
  controllers: readonly Type<unknown>[],
): ReflectedPublicRoute[] {
  const routes: ReflectedPublicRoute[] = [];

  for (const controller of controllers) {
    const controllerPaths = metadataPaths(
      Reflect.getMetadata(PATH_METADATA, controller),
    );
    const prototype = controller.prototype as Record<string, unknown>;

    for (const propertyName of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[propertyName];
      if (typeof handler !== 'function') continue;

      const requestMethod = Reflect.getMetadata(
        METHOD_METADATA,
        handler,
      ) as RequestMethod | undefined;
      if (requestMethod === undefined) continue;

      const methodName = REQUEST_METHOD_NAMES[requestMethod];
      assert.ok(
        methodName,
        `${controller.name}.${propertyName} uses an unsupported public HTTP method`,
      );
      const handlerPaths = metadataPaths(
        Reflect.getMetadata(PATH_METADATA, handler),
      );

      for (const controllerPath of controllerPaths) {
        for (const handlerPath of handlerPaths) {
          routes.push({
            controller,
            propertyName,
            handler: handler as PublicV1Handler,
            method: methodName,
            path: joinRoutePath(controllerPath, handlerPath),
          });
        }
      }
    }
  }

  return routes;
}

function reflectedPublicRoutes(
  controllers: readonly Type<unknown>[],
): ReflectedPublicRoute[] {
  for (const controller of controllers) {
    assert.equal(
      Reflect.getMetadata(PUBLIC_V1_DATA_CONTROLLER_METADATA, controller),
      true,
      `${controller.name} must use @PublicV1Controller`,
    );
  }
  return reflectedControllerRoutes(controllers);
}

function reflectedModuleGraphControllers(root: Type<unknown>): Type<unknown>[] {
  const controllers = new Set<Type<unknown>>();
  const visitedModules = new Set<Type<unknown>>();
  const visitedDynamicModules = new Set<object>();

  const addControllers = (values: unknown): void => {
    if (!Array.isArray(values)) return;
    for (const controller of values) {
      assert.equal(
        typeof controller,
        'function',
        'Nest module controller metadata must contain classes',
      );
      controllers.add(controller as Type<unknown>);
    }
  };

  const visit = (reference: unknown): void => {
    if (Array.isArray(reference)) {
      for (const nested of reference) visit(nested);
      return;
    }
    if (typeof reference === 'function') {
      const moduleType = reference as Type<unknown>;
      if (visitedModules.has(moduleType)) return;
      visitedModules.add(moduleType);
      addControllers(
        Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleType),
      );
      visit(Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleType));
      return;
    }
    if (!reference || typeof reference !== 'object') return;
    if (reference instanceof Promise) {
      assert.fail('Async Nest module references cannot be reflected synchronously');
    }

    const candidate = reference as {
      readonly forwardRef?: () => unknown;
      readonly module?: unknown;
      readonly controllers?: unknown;
      readonly imports?: unknown;
    };
    if (typeof candidate.forwardRef === 'function') {
      visit(candidate.forwardRef());
      return;
    }
    if (candidate.module !== undefined) {
      if (visitedDynamicModules.has(reference)) return;
      visitedDynamicModules.add(reference);
      addControllers(candidate.controllers);
      visit(candidate.module);
      visit(candidate.imports);
    }
  };

  visit(root);
  return [...controllers];
}

function assertCompletePublicV1RouteGraph(root: Type<unknown>): void {
  const routes = reflectedControllerRoutes(
    reflectedModuleGraphControllers(root),
  ).filter(
    (route) => route.path === '/v1' || route.path.startsWith('/v1/'),
  );
  const routeKeys = routes.map((route) => `${route.method} ${route.path}`);

  assert.equal(
    new Set(routeKeys).size,
    routeKeys.length,
    'the application module graph must not expose duplicate /v1 routes',
  );

  for (const route of routes) {
    const routeKey = `${route.method} ${route.path}`;
    const operation = publicV1OperationForHandler(route.handler);
    if (operation) {
      assert.equal(
        Reflect.getMetadata(
          PUBLIC_V1_DATA_CONTROLLER_METADATA,
          route.controller,
        ),
        true,
        `${route.controller.name}.${route.propertyName} must use @PublicV1Controller`,
      );
      assert.equal(
        routeKey,
        `${operation.method.toUpperCase()} ${operation.path}`,
        `${operation.id} must expose the registry route`,
      );
      continue;
    }

    assert.equal(
      PUBLIC_V1_METADATA_ROUTE_BY_HANDLER.get(route.handler),
      routeKey,
      `${route.controller.name}.${route.propertyName} exposes an unbound /v1 route`,
    );
  }

  const expectedRouteKeys = [
    ...PUBLIC_V1_OPERATIONS.map(
      (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
    ),
    ...PUBLIC_V1_METADATA_ROUTE_BY_HANDLER.values(),
  ].sort();
  assert.deepEqual(
    [...routeKeys].sort(),
    expectedRouteKeys,
    'AppModule /v1 routes must exactly match the public registry plus explicit metadata routes',
  );
}

@Controller('v1/escape-fixture')
class EscapingV1Controller {
  @Get()
  get(): string {
    return 'escape fixture';
  }
}

@Module({ controllers: [EscapingV1Controller] })
class EscapingV1Module {}

@Module({ imports: [AppModule, EscapingV1Module] })
class AppModuleWithEscapingV1Route {}

test('typed Public V1 bindings form an exact registry/controller bijection', () => {
  const controllers = Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    V1Module,
  ) as Type<unknown>[] | undefined;
  assert.ok(controllers, 'V1Module declares its public controllers');

  const routes = reflectedPublicRoutes(controllers);
  const reflectedBindings = routes.map((route) => {
    const id = publicV1OperationIdForHandler(route.handler);
    assert.ok(
      id,
      `${route.controller.name}.${route.propertyName} is missing @PublicV1Operation`,
    );
    const operation = publicV1OperationForHandler(route.handler);
    assert.ok(operation, `${id} must resolve to the exact registry entry`);

    assert.equal(route.method, operation.method.toUpperCase(), `${id} method`);
    assert.equal(route.path, operation.path, `${id} path`);
    assert.equal(
      Reflect.getOwnMetadata(HTTP_CODE_METADATA, route.handler),
      operation.successStatus,
      `${id} success status must be derived from the registry`,
    );

    const registryOperation = PUBLIC_V1_OPERATIONS.find(
      (candidate) => candidate.id === id,
    );
    assert.ok(registryOperation, `${id} is absent from PUBLIC_V1_OPERATIONS`);
    assert.equal(
      operation,
      registryOperation,
      `${id} metadata must resolve the registry object without a copied policy`,
    );
    assert.equal(operation.input, registryOperation.input, `${id} input schemas`);
    assert.equal(operation.responseSchema, registryOperation.responseSchema, `${id} output schema`);
    assert.equal(operation.scope, registryOperation.scope, `${id} scope`);
    assert.equal(operation.ownerPolicy, registryOperation.ownerPolicy, `${id} owner policy`);

    return { id, routeKey: `${route.method} ${route.path}` };
  });

  const actualIds = reflectedBindings.map(({ id }) => id).sort();
  const expectedIds = PUBLIC_V1_OPERATIONS.map(({ id }) => id).sort();
  const actualRoutes = reflectedBindings.map(({ routeKey }) => routeKey).sort();
  const expectedRoutes = PUBLIC_V1_OPERATIONS.map(
    (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
  ).sort();

  assert.equal(new Set(expectedIds).size, expectedIds.length, 'registry ids are unique');
  assert.equal(new Set(actualIds).size, actualIds.length, 'handler ids are unique');
  assert.deepEqual(
    actualIds,
    expectedIds,
    'operation ids must be added or removed from registry and handlers together',
  );
  assert.equal(new Set(expectedRoutes).size, expectedRoutes.length, 'registry route keys are unique');
  assert.equal(new Set(actualRoutes).size, actualRoutes.length, 'controller route keys are unique');
  assert.deepEqual(
    actualRoutes,
    expectedRoutes,
    'a controller route and its public contract must be added or removed together',
  );

  for (const internalRoute of INTERNAL_ROUTE_KEYS) {
    assert.ok(
      !actualRoutes.includes(internalRoute),
      `${internalRoute} is internal and must not enter V1Module/public OpenAPI`,
    );
    assert.ok(
      !expectedRoutes.includes(internalRoute),
      `${internalRoute} is internal and must not enter PUBLIC_V1_OPERATIONS`,
    );
  }
});

test('the complete AppModule graph cannot expose an unbound Public V1 route', () => {
  assertCompletePublicV1RouteGraph(AppModule);
});

test('a Public V1 route added outside V1Module fails the whole-graph gate', () => {
  assert.throws(
    () => assertCompletePublicV1RouteGraph(AppModuleWithEscapingV1Route),
    /EscapingV1Controller\.get exposes an unbound \/v1 route/u,
  );
});

test('Public V1 handlers cannot consume inputs outside the registry boundary', () => {
  const sourceRoot = path.resolve(__dirname, '..', '..', 'src');
  const audits = productionTypeScriptFiles(sourceRoot).map((file) =>
    publicV1SourcePolicyAudit(
      readFileSync(file, 'utf8'),
      path.relative(sourceRoot, file).split(path.sep).join('/'),
    ),
  );
  assert.deepEqual(audits.flatMap((audit) => audit.violations), []);
  assert.deepEqual(
    audits.flatMap((audit) => audit.operationIds).sort(),
    PUBLIC_V1_OPERATIONS.map((operation) => operation.id).sort(),
    'the recursive production-source audit must see every registry operation exactly once',
  );
});

test('the source-policy gate rejects raw headers and standard Nest input decorators', () => {
  const rawRequestMutation = `
    class RawRequestEscape {
      @PublicV1Operation('tasks.get')
      get(@Req() req: AuthenticatedRequest) {
        requirePublicV1Principal(req, this.get);
        return req.headers['x-undeclared-mode'];
      }
    }
  `;
  assert.deepEqual(
    publicV1SourcePolicyAudit(rawRequestMutation, 'raw-mutation.ts').violations,
    [
      'raw-mutation.ts:get consumes raw @Req data outside registry authorization',
    ],
  );

  const decoratorMutation = `
    class DecoratorEscape {
      @PublicV1Operation('tasks.get')
      get(@Headers('x-undeclared-mode') mode: string) { return mode; }
    }
  `;
  assert.deepEqual(
    publicV1SourcePolicyAudit(decoratorMutation, 'decorator-mutation.ts').violations,
    ['decorator-mutation.ts:get uses non-canonical @Headers input'],
  );

  const argumentsMutation = `
    class ArgumentsEscape {
      @PublicV1Operation('tasks.get')
      get(@PublicV1Input('params', 'id') id: string) {
        return arguments[0] ?? id;
      }
    }
  `;
  assert.deepEqual(
    publicV1SourcePolicyAudit(argumentsMutation, 'arguments-mutation.ts').violations,
    ['arguments-mutation.ts:get reads raw method arguments'],
  );

  const rawResponseMutation = `
    class RawResponseEscape {
      @PublicV1Operation('tasks.get')
      get(@Res({ passthrough: false }) res: Response) {
        return res.status(201).json({ undeclared: true });
      }
    }
  `;
  assert.deepEqual(
    publicV1SourcePolicyAudit(rawResponseMutation, 'response-mutation.ts').violations,
    [
      'response-mutation.ts:get injects @Res for a non-streaming Public V1 operation',
    ],
  );

  const namespacedDecoratorMutation = `
    class NamespacedDecoratorEscape {
      @Surface.PublicV1Operation('tasks.get')
      get(@Nest.Headers('x-undeclared-mode') mode: string) { return mode; }
    }
  `;
  assert.deepEqual(
    publicV1SourcePolicyAudit(
      namespacedDecoratorMutation,
      'namespaced-mutation.ts',
    ).violations,
    ['namespaced-mutation.ts:get uses non-canonical @Headers input'],
  );

  const streamingResponse = `
    class StreamingResponse {
      @Surface.PublicV1Operation('tasks.events')
      events(@Nest.Res({ passthrough: false }) res: Response) {
        return res;
      }
    }
  `;
  assert.deepEqual(
    publicV1SourcePolicyAudit(streamingResponse, 'streaming.ts').violations,
    [],
  );
});

test('schedule dispatch declares the same period-consumption request contract as its controller and MCP tool', () => {
  const operation = PUBLIC_V1_OPERATIONS.find(
    (candidate) => candidate.id === 'schedules.dispatch',
  );

  assert.ok(operation);
  assert.equal(operation.requestSchema, DispatchScheduleRequestSchema);
  assert.match(operation.description, /consume the current schedule period/i);
  assert.ok('tool' in operation.mcp);
  assert.equal(operation.mcp.tool, 'dispatch_schedule');
});

test('schedule operation documentation names every recurrence-first preset', () => {
  const create = PUBLIC_V1_OPERATIONS.find(
    (candidate) => candidate.id === 'schedules.create',
  );
  const update = PUBLIC_V1_OPERATIONS.find(
    (candidate) => candidate.id === 'schedules.update',
  );

  assert.ok(create);
  assert.ok(update);
  assert.equal(create.requestSchema, CreateScheduleRequestSchema);
  assert.equal(update.requestSchema, UpdateScheduleRequestSchema);
  for (const operation of [create, update]) {
    assert.match(operation.description, /hourly/);
    assert.match(operation.description, /minuteInterval/);
    assert.match(operation.description, /cronExpression/);
  }
});
