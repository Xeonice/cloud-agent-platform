import {
  Controller,
  createParamDecorator,
  BadRequestException,
  ForbiddenException,
  HttpCode,
  HttpException,
  Injectable,
  InternalServerErrorException,
  SetMetadata,
  UseGuards,
  UseInterceptors,
  applyDecorators,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import {
  PUBLIC_V1_OPERATIONS,
  type PublicErrorCode,
  type PublicV1Operation,
  type PublicV1OperationById,
  type PublicV1OperationId,
  type PublicV1OperationShape,
} from '@cap/contracts';
import type { Observable } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { throwError } from 'rxjs';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import {
  hasScope,
  type OperatorPrincipal,
} from '../auth/operator-principal';
import { parseZodValue } from '../repos/zod-validation.pipe';
import {
  normalizePublicSurfaceFailure,
  projectPublicV1SurfaceErrorToRest,
  projectPublicSurfaceErrorToRest,
  PublicSurfaceError,
} from './public-surface-error';

export const PUBLIC_V1_OPERATION_ID_METADATA =
  'cap:public-v1-operation-id';
export const PUBLIC_V1_DATA_CONTROLLER_METADATA =
  'cap:public-v1-data-controller';

const OPERATION_BY_ID = new Map<string, PublicV1OperationShape>(
  PUBLIC_V1_OPERATIONS.map((operation) => [operation.id, operation]),
);

type PublicV1InputSource = keyof PublicV1OperationShape['input'];
export type PublicV1Handler = (...args: never[]) => unknown;

export interface ParsedPublicV1Input {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
}

export interface PublicV1RequestContext {
  readonly operation: PublicV1OperationShape;
  readonly principal: OperatorPrincipal;
  readonly input: ParsedPublicV1Input;
}

type PublicV1HttpRequest = AuthenticatedRequest & {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly headers: Readonly<Record<string, unknown>>;
};

const REQUEST_CONTEXT = new WeakMap<object, PublicV1RequestContext>();

/** Resolve one exact registry entry without widening its per-id type. */
export function publicV1OperationById<Id extends PublicV1OperationId>(
  id: Id,
): PublicV1OperationById<Id> {
  const operation = OPERATION_BY_ID.get(id);
  if (!operation) throw new TypeError(`Unknown Public V1 operation id: ${id}`);
  return operation as PublicV1OperationById<Id>;
}

/** Read the typed operation id attached to a real Nest handler. */
export function publicV1OperationIdForHandler(
  handler: PublicV1Handler,
): PublicV1OperationId | undefined {
  const id = Reflect.getOwnMetadata(
    PUBLIC_V1_OPERATION_ID_METADATA,
    handler,
  ) as unknown;
  return typeof id === 'string' && OPERATION_BY_ID.has(id)
    ? (id as PublicV1OperationId)
    : undefined;
}

export function publicV1OperationForHandler(
  handler: PublicV1Handler,
): PublicV1Operation | undefined {
  const id = publicV1OperationIdForHandler(handler);
  return id === undefined
    ? undefined
    : (OPERATION_BY_ID.get(id) as PublicV1Operation);
}

/**
 * Bind exactly one registry operation to a handler and derive its success code.
 * A second binding on the same method is rejected while decorators are applied.
 */
export function PublicV1Operation<Id extends PublicV1OperationId>(
  id: Id,
): MethodDecorator {
  const operation = publicV1OperationById(id);
  return (target, propertyKey, descriptor): void => {
    const handler = descriptor?.value;
    if (typeof handler !== 'function') {
      throw new TypeError(
        `@PublicV1Operation(${id}) must decorate a method`,
      );
    }
    if (
      Reflect.hasOwnMetadata(PUBLIC_V1_OPERATION_ID_METADATA, handler)
    ) {
      throw new TypeError(
        `${String(propertyKey)} has more than one Public V1 operation binding`,
      );
    }
    Reflect.defineMetadata(PUBLIC_V1_OPERATION_ID_METADATA, id, handler);
    HttpCode(operation.successStatus)(target, propertyKey, descriptor);
  };
}

/**
 * Mark a class as a Public V1 data controller and apply the central boundary to
 * every route. A route missing `@PublicV1Operation` therefore fails closed.
 */
export function PublicV1Controller(path: string): ClassDecorator {
  return applyDecorators(
    Controller(path),
    SetMetadata(PUBLIC_V1_DATA_CONTROLLER_METADATA, true),
    UseGuards(PublicV1OperationGuard),
    UseInterceptors(PublicV1ContractInterceptor),
  );
}

interface PublicV1ParameterSelection {
  readonly source: PublicV1InputSource;
  readonly field?: string;
}

const publicV1InputParameter = createParamDecorator<
  PublicV1ParameterSelection
>((selection, context) => {
  const request = context
    .switchToHttp()
    .getRequest() as PublicV1HttpRequest;
  const requestContext = REQUEST_CONTEXT.get(request);
  if (!requestContext) {
    throw failClosedHttpException(
      'insufficient_scope',
      'Missing public operation request context',
    );
  }
  const value = requestContext.input[selection.source];
  if (selection.field === undefined) return value;
  if (value === null || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[selection.field];
});

/** Read one canonical parsed input section (or field) populated by the guard. */
export function PublicV1Input(
  source: PublicV1InputSource,
  field?: string,
): ParameterDecorator {
  return publicV1InputParameter({ source, ...(field ? { field } : {}) });
}

/**
 * Authorize a request from registry metadata. Controllers use this helper only
 * when they need the principal for owner attribution; the guard calls the same
 * function for every HTTP handler.
 */
export function requirePublicV1Principal(
  request: AuthenticatedRequest,
  handler: PublicV1Handler,
): OperatorPrincipal {
  const existing = REQUEST_CONTEXT.get(request);
  const boundId = publicV1OperationIdForHandler(handler);
  if (
    existing &&
    boundId !== undefined &&
    existing.operation.id === boundId
  ) {
    return existing.principal;
  }
  const operation = requireBoundOperation(handler);
  try {
    return authorizePublicV1Request(request, handler).principal;
  } catch (failure) {
    throw publicV1HttpException(operation, failure);
  }
}

/** Resolve a registry-required owner without repeating policy in a controller. */
export function requirePublicV1OwnerId(
  request: AuthenticatedRequest,
  handler: PublicV1Handler,
): string {
  const principal = requirePublicV1Principal(request, handler);
  if (!principal.user?.id) {
    const operation = requireBoundOperation(handler);
    throw publicV1HttpException(operation, ownerRequiredError(operation));
  }
  return principal.user.id;
}

/** Test/conformance seam for the normalized request produced by the real guard. */
export function publicV1RequestContext(
  request: object,
): PublicV1RequestContext | undefined {
  return REQUEST_CONTEXT.get(request);
}

@Injectable()
export class PublicV1OperationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler() as PublicV1Handler;
    const request = context
      .switchToHttp()
      .getRequest() as PublicV1HttpRequest;
    const operation = requireBoundOperation(handler);
    try {
      const authorized = authorizePublicV1Request(request, handler);
      const input = parsePublicV1Input(authorized.operation, request);
      materializeCanonicalInput(authorized.operation, request, input);
      REQUEST_CONTEXT.set(request, { ...authorized, input });
      return true;
    } catch (failure) {
      throw publicV1HttpException(
        operation,
        failure,
        context.switchToHttp().getResponse(),
      );
    }
  }
}

@Injectable()
export class PublicV1ContractInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest() as PublicV1HttpRequest;
    const requestContext = REQUEST_CONTEXT.get(request);
    if (!requestContext) {
      throw failClosedHttpException(
        'insufficient_scope',
        'Missing public operation request context',
      );
    }

    return next.handle().pipe(
      map((value) => validatePublicV1Output(requestContext.operation, value)),
      catchError((failure: unknown) => {
        return throwError(
          () => publicV1HttpException(
            requestContext.operation,
            failure,
            context.switchToHttp().getResponse(),
          ),
        );
      }),
    );
  }
}

function authorizePublicV1Request(
  request: AuthenticatedRequest,
  handler: PublicV1Handler,
): Omit<PublicV1RequestContext, 'input'> {
  const operation = requireBoundOperation(handler);
  const principal = request.operatorPrincipal;
  if (!principal) {
    throw publicSurfaceError(
      'insufficient_scope',
      'Missing operator principal',
      operation,
    );
  }
  if (!hasScope(principal, operation.scope)) {
    throw publicSurfaceError(
      'insufficient_scope',
      `Insufficient scope: ${operation.scope} required`,
      operation,
    );
  }
  if (operation.ownerPolicy === 'required' && !principal.user?.id) {
    throw ownerRequiredError(operation);
  }
  return { operation, principal };
}

function requireBoundOperation(
  handler: PublicV1Handler,
): PublicV1OperationShape {
  const rawId = Reflect.getOwnMetadata(
    PUBLIC_V1_OPERATION_ID_METADATA,
    handler,
  ) as unknown;
  if (typeof rawId !== 'string') {
    throw failClosedHttpException(
      'insufficient_scope',
      'Missing public operation binding',
    );
  }
  const operation = OPERATION_BY_ID.get(rawId);
  if (!operation) {
    throw failClosedHttpException(
      'insufficient_scope',
      'Unknown public operation binding',
    );
  }
  return operation;
}

function ownerRequiredError(
  operation: PublicV1OperationShape,
): PublicSurfaceError {
  return new PublicSurfaceError({
    code: 'owner_required',
    details: { operationId: operation.id },
  });
}

function publicSurfaceError(
  code: PublicErrorCode,
  message: string,
  operation: PublicV1OperationShape,
): PublicSurfaceError {
  return new PublicSurfaceError({
    code,
    message,
    details: { operationId: operation.id },
  });
}

function failClosedHttpException(
  code: PublicErrorCode,
  message: string,
): HttpException {
  const error = new PublicSurfaceError({
    code,
    message,
  });
  return publicSurfaceHttpException(error);
}

interface PublicV1HttpResponse {
  setHeader?(name: string, value: string): unknown;
}

/** Project a framework/domain failure through one exact registry operation. */
export function publicV1HttpExceptionForOperation<
  Id extends PublicV1OperationId,
>(
  id: Id,
  failure: unknown,
  response?: PublicV1HttpResponse,
): HttpException {
  return publicV1HttpException(publicV1OperationById(id), failure, response);
}

function publicV1HttpException(
  operation: PublicV1OperationShape,
  failure: unknown,
  response?: PublicV1HttpResponse,
): HttpException {
  const normalized = normalizePublicSurfaceFailure(failure);
  if (!operation.errors.includes(normalized.code)) {
    return new InternalServerErrorException(
      `Undeclared public error for ${operation.id}`,
    );
  }

  let projected: ReturnType<typeof projectPublicV1SurfaceErrorToRest>;
  try {
    projected = projectPublicV1SurfaceErrorToRest(operation, normalized);
  } catch {
    return new InternalServerErrorException(
      `Invalid public error projection for ${operation.id}`,
    );
  }

  if (
    Object.keys(projected.headers).length > 0 &&
    typeof response?.setHeader !== 'function'
  ) {
    return new InternalServerErrorException(
      `Missing public error header boundary for ${operation.id}`,
    );
  }
  for (const [name, value] of Object.entries(projected.headers)) {
    response?.setHeader?.(name, value);
  }

  const body = projected.body as string | Record<string, unknown>;
  if (projected.status === 400) return new BadRequestException(body);
  if (projected.status === 403) return new ForbiddenException(body);
  return new HttpException(body, projected.status);
}

function publicSurfaceHttpException(error: PublicSurfaceError): HttpException {
  const projected = projectPublicSurfaceErrorToRest(error);
  const body = projected.body as string | Record<string, unknown>;
  if (projected.status === 400) return new BadRequestException(body);
  if (projected.status === 403) return new ForbiddenException(body);
  return new HttpException(body, projected.status);
}

function parsePublicV1Input(
  operation: PublicV1OperationShape,
  request: PublicV1HttpRequest,
): ParsedPublicV1Input {
  const parsed: {
    params?: unknown;
    query?: unknown;
    headers?: unknown;
    body?: unknown;
  } = {};
  if (operation.input.params) {
    parsed.params = parseZodValue(
      operation.input.params.parse,
      request.params,
    );
  }
  if (operation.input.query) {
    parsed.query = parseZodValue(
      operation.input.query.parse,
      request.query,
    );
  }
  if (operation.input.headers) {
    parsed.headers = parseZodValue(
      operation.input.headers.parse,
      declaredHeaderValues(operation, request.headers),
    );
  }
  if (operation.input.body) {
    parsed.body = parseZodValue(
      operation.input.body.parse,
      request.body,
    );
  }
  return parsed;
}

function declaredHeaderValues(
  operation: PublicV1OperationShape,
  headers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const fields = Object.keys(operation.input.headers?.wire.shape ?? {});
  for (const field of fields) {
    const lower = field.toLowerCase();
    const matchingKey = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === lower,
    );
    if (matchingKey !== undefined && headers[matchingKey] !== undefined) {
      result[field] = headers[matchingKey];
    }
  }
  return result;
}

/**
 * Materialize canonical params/query/body plus each declared header for Nest's
 * downstream parameter resolution. Authentication and ordinary HTTP headers
 * must remain on the raw request, so the focused source-policy gate separately
 * forbids Public V1 handlers from consuming raw request data: `@PublicV1Input`
 * is the only accepted data-input decorator and `@Req` may only feed the
 * registry authorization helpers.
 */
function materializeCanonicalInput(
  operation: PublicV1OperationShape,
  request: PublicV1HttpRequest,
  input: ParsedPublicV1Input,
): void {
  if (operation.input.params) {
    replaceRequestSection(request, 'params', input.params);
  }
  if (operation.input.query) {
    replaceRequestSection(request, 'query', input.query);
  }
  if (operation.input.body) {
    replaceRequestSection(request, 'body', input.body);
  }
  if (operation.input.headers) {
    const canonical = asRecord(input.headers, 'headers');
    const mutableHeaders = request.headers as Record<string, unknown>;
    for (const field of Object.keys(operation.input.headers.wire.shape)) {
      for (const key of Object.keys(mutableHeaders)) {
        if (key.toLowerCase() === field.toLowerCase()) {
          delete mutableHeaders[key];
        }
      }
      if (canonical[field] !== undefined) {
        // Node/Nest address request headers by their lower-case wire name.
        mutableHeaders[field.toLowerCase()] = canonical[field];
      }
    }
  }
}

function replaceRequestSection(
  request: PublicV1HttpRequest,
  source: 'params' | 'query' | 'body',
  canonicalValue: unknown,
): void {
  const mutableRequest = request as PublicV1HttpRequest &
    Record<'params' | 'query' | 'body', unknown>;
  const existing = mutableRequest[source];
  if (
    isRecord(existing) &&
    isRecord(canonicalValue) &&
    Object.isExtensible(existing) &&
    Object.keys(existing).every(
      (key) => Object.getOwnPropertyDescriptor(existing, key)?.configurable !== false,
    )
  ) {
    for (const key of Object.keys(existing)) delete existing[key];
    Object.assign(existing, canonicalValue);
    return;
  }
  mutableRequest[source] = canonicalValue;
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InternalServerErrorException(
      `Canonical Public V1 ${source} input must be an object`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePublicV1Output(
  operation: PublicV1OperationShape,
  value: unknown,
): unknown {
  if (operation.streaming) {
    // SSE owns the raw response and validates each data payload at serialization.
    return value;
  }
  if (operation.responseSchema === null) {
    if (value !== undefined) {
      throw new InternalServerErrorException(
        `Public operation ${operation.id} must return no body`,
      );
    }
    return undefined;
  }
  const result = operation.responseSchema.safeParse(value);
  if (!result.success) {
    throw new InternalServerErrorException(
      `Public response validation failed for ${operation.id}`,
    );
  }
  if (operation.restOutputProjection.kind === 'canonical') {
    return result.data;
  }
  // The legacy projection is an explicit per-operation registry decision, not
  // an accidental side effect of Zod's default object stripping.
  return value;
}
