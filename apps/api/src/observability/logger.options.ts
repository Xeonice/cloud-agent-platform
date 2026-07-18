import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  TaskProvisioningDiagnosticCauseSchema,
  TaskProvisioningDiagnosticCommandKindSchema,
} from '@cap/contracts';
import type { Params } from 'nestjs-pino';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { getTaskLogContext } from './log-context';

/**
 * nestjs-pino configuration for the structured-logging foundation (Tier 0).
 *
 * The app emits single-line JSON to stdout ONLY (no file/network sink — that is
 * the opt-in observability-stack's job). This module pins the field vocabulary
 * downstream collection relies on: `level`, `reqId`, `taskId`, `userId`.
 *
 * SECURITY: `redact` is load-bearing — pino-http logs request headers by default,
 * so without redaction structured logging would PERSIST credentials. The paths
 * below blank the session cookie, bearer/Authorization, and any key-named secret;
 * whole `process.env`/config objects must never be passed to the logger (which
 * would expose `CODEX_CRED_ENC_KEY` / the OAuth client secret).
 */

const REDACTION_CENSOR = '[Redacted]' as const;
const MAX_LOG_REDACTION_DEPTH = 12;
const MAX_LOG_REDACTION_NODES = 1_024;
const MAX_LOG_REDACTION_OBJECT_KEYS = 128;
const MAX_LOG_REDACTION_ARRAY_LENGTH = 128;
const LOG_REDACTION_FAILURE_LINE =
  '{"level":50,"event":"log_redaction_failed"}\n';

/**
 * Unsafe field names accepted by ordinary log call sites are defense-in-depth
 * only. Provisioning diagnostics still reject unknown fields at their strict
 * schema boundary instead of relying on this key-name policy.
 */
const SENSITIVE_LOG_FIELDS = [
  'command',
  'commands',
  'commandText',
  'shellCommand',
  'argv',
  'args',
  'arguments',
  'stdout',
  'stderr',
  'output',
  'outputs',
  'combinedOutput',
  'prompt',
  'prompts',
  'body',
  'bodies',
  'requestBody',
  'responseBody',
  'payload',
  'request',
  'response',
  'responses',
  'providerRequest',
  'providerResponse',
  'rawResponse',
  'rawProviderResponse',
  'providerRequestBody',
  'providerResponseBody',
  'url',
  'uri',
  'endpoint',
  'endpoints',
  'connectionUrl',
  'repositoryUrl',
  'requestUrl',
  'originalUrl',
  'requestPath',
  'providerEndpoint',
  'providerRequestPath',
  'header',
  'headers',
  'requestHeaders',
  'responseHeaders',
  'authorization',
  'cookie',
  'setCookie',
  'environment',
  'environments',
  'environmentVariables',
  'env',
  'processEnv',
  'config',
  'configuration',
  'credential',
  'credentials',
  'credentialPath',
  'credentialFile',
  'tempCredentialPath',
  'temporaryCredentialPath',
  'secret',
  'secrets',
  'secretPath',
  'secretFile',
  'token',
  'tokens',
  'accessToken',
  'refreshToken',
  'apiKey',
  'api_key',
  'password',
  'passphrase',
  'path',
  'paths',
  'cwd',
  'directory',
  'workingDir',
  'workingDirectory',
  'hostPath',
  'guestPath',
  'tempPath',
  'temporaryPath',
  'providerId',
  'rawProviderId',
  'rawProviderSandboxId',
  'rawProviderResourceId',
  'rawProviderExecutionId',
  'rawProviderConnectionId',
  'providerSandboxId',
  'providerResourceId',
  'providerExecutionId',
  'providerConnectionId',
  'resourceId',
  'executionId',
  'nativeResourceId',
  'nativeExecutionId',
  'sandboxId',
  'connectionId',
  'providerSandbox',
  'providerResource',
  'providerExecution',
  'providerConnection',
  'connectionMetadata',
  'resource',
  'execution',
  'connection',
  'leaseOwner',
  'leaseToken',
  'error',
  'errors',
  'err',
  'rawError',
  'providerError',
  'rawProviderError',
  'errorMessage',
  'message',
  'cause',
  'stack',
  'reason',
  'wsReason',
  'websocketReason',
] as const;

const NORMALIZED_SENSITIVE_LOG_FIELDS = new Set(
  SENSITIVE_LOG_FIELDS.map(normalizeLogFieldName),
);

/**
 * These names contain an unsafe category word but are closed, bounded facts.
 * Their values are validated separately before they are allowed through.
 */
const SAFE_CLASSIFIED_LOG_FIELDS = new Set(['commandkind', 'responsetime']);

const SENSITIVE_LOG_FIELD_FRAGMENTS = [
  'command',
  'argument',
  'stdout',
  'stderr',
  'output',
  'prompt',
  'body',
  'payload',
  'response',
  'endpoint',
  'header',
  'environment',
  'config',
  'credential',
  'secret',
  'token',
  'password',
  'passphrase',
  'authorization',
  'cookie',
  'path',
  'directory',
  'providerid',
  'resourceid',
  'executionid',
  'sandboxid',
  'connectionid',
  'leaseowner',
  'leasetoken',
  'error',
  'exception',
  'failure',
  'stack',
  'cause',
  'reason',
  'message',
] as const;

const SENSITIVE_SHORT_LOG_FIELD_TOKENS = new Set([
  'arg',
  'args',
  'argv',
  'cwd',
  'env',
  'uri',
  'url',
]);

/**
 * Pino has no recursive `**` path. Root fields are declared explicitly, while
 * bounded wildcard paths let one key-aware censor cover nested objects and
 * arrays without maintaining every possible parent path.
 */
const REDACT_PATHS = [
  // Root wildcard is intentionally type-only: Pino exposes an internal symbol
  // rather than the real key to the censor here. It still lets us remove Error
  // and binary values before child bindings can invoke toJSON/stringification.
  '*',
  'req.url',
  'req.originalUrl',
  'req.headers',
  'res.headers',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_LOG_FIELDS,
  ...Array.from({ length: MAX_LOG_REDACTION_DEPTH - 1 }, (_, index) =>
    Array.from({ length: index + 2 }, () => '*').join('.'),
  ),
];

function normalizeLogFieldName(field: string): string {
  return field
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '');
}

function tokenizeLogFieldName(field: string): readonly string[] {
  return field
    .normalize('NFKC')
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function isSensitiveLogFieldName(field: string): boolean {
  const normalized = normalizeLogFieldName(field);
  // Closed safe exceptions still enter the classifier so their values are
  // validated by `redactUnsafeLogField`; the name alone never grants trust.
  if (SAFE_CLASSIFIED_LOG_FIELDS.has(normalized)) return true;
  if (NORMALIZED_SENSITIVE_LOG_FIELDS.has(normalized)) return true;
  if (SENSITIVE_LOG_FIELD_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
    return true;
  }
  return tokenizeLogFieldName(field).some((token) =>
    SENSITIVE_SHORT_LOG_FIELD_TOKENS.has(token),
  );
}

function redactUnsafeLogField(
  value: unknown,
  path: readonly (string | number | symbol)[],
): unknown {
  // The last configured wildcard is an explicit fail-closed boundary. Any
  // still-nested subtree is removed wholesale rather than escaping at N + 1.
  if (path.length >= MAX_LOG_REDACTION_DEPTH) return REDACTION_CENSOR;
  if (
    typeof value === 'object' &&
    value !== null &&
    (value instanceof Error || isBinaryLogValue(value))
  ) {
    return REDACTION_CENSOR;
  }

  const last = path.at(-1);
  if (typeof last !== 'string') return value;
  const normalized = normalizeLogFieldName(last);
  if (!isSensitiveLogFieldName(last)) return value;

  // Preserve the existing access-log request path. Provisioning diagnostic
  // records have no req object and therefore cannot use this exception.
  if (
    path.length === 2 &&
    path[0] === 'req' &&
    (normalized === 'url' ||
      normalized === 'requesturl' ||
      normalized === 'originalurl')
  ) {
    return value;
  }

  // The canonical diagnostic cause is a closed enum, not a provider error.
  if (
    normalized === 'cause' &&
    (value === null || TaskProvisioningDiagnosticCauseSchema.safeParse(value).success)
  ) {
    return value;
  }

  if (
    normalized === 'commandkind' &&
    (value === null ||
      TaskProvisioningDiagnosticCommandKindSchema.safeParse(value).success)
  ) {
    return value;
  }

  if (
    normalized === 'responsetime' &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  ) {
    return value;
  }

  return REDACTION_CENSOR;
}

interface LogSanitizationState {
  readonly active: WeakSet<object>;
  nodes: number;
}

function isBinaryLogValue(value: object): boolean {
  return (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function isBufferLikeLogValue(value: Record<string, unknown>): boolean {
  const type = Object.getOwnPropertyDescriptor(value, 'type');
  const data = Object.getOwnPropertyDescriptor(value, 'data');
  return (
    type !== undefined &&
    'value' in type &&
    type.value === 'Buffer' &&
    data !== undefined &&
    'value' in data &&
    Array.isArray(data.value)
  );
}

function isPlainLogObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function sanitizeLogValue(
  value: unknown,
  path: readonly (string | number | symbol)[],
  state: LogSanitizationState,
): unknown {
  try {
    if (path.length >= MAX_LOG_REDACTION_DEPTH) return REDACTION_CENSOR;
    state.nodes += 1;
    if (state.nodes > MAX_LOG_REDACTION_NODES) return REDACTION_CENSOR;

    const last = path.at(-1);
    if (typeof last === 'string' && isSensitiveLogFieldName(last)) {
      const classified = redactUnsafeLogField(value, path);
      if (classified === REDACTION_CENSOR) return classified;
      value = classified;
    }

    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      value === undefined
    ) {
      return value;
    }
    if (typeof value === 'symbol' || typeof value === 'function') {
      return REDACTION_CENSOR;
    }

    if (value instanceof Error || isBinaryLogValue(value)) {
      return REDACTION_CENSOR;
    }
    if (value instanceof Date) {
      const epochMs = value.getTime();
      return Number.isFinite(epochMs) ? new Date(epochMs) : REDACTION_CENSOR;
    }

    // pino-http owns serialization of the real request/response instances. Its
    // resulting plain JSON is sanitized again by streamWrite below.
    if (
      path.length === 1 &&
      typeof last === 'string' &&
      (normalizeLogFieldName(last) === 'req' ||
        normalizeLogFieldName(last) === 'res') &&
      !isPlainLogObject(value)
    ) {
      return value;
    }

    if (state.active.has(value)) return REDACTION_CENSOR;
    state.active.add(value);
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
          string,
          PropertyDescriptor | undefined
        >;
        const lengthDescriptor = descriptors['length'];
        if (
          lengthDescriptor === undefined ||
          !('value' in lengthDescriptor) ||
          typeof lengthDescriptor.value !== 'number' ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > MAX_LOG_REDACTION_ARRAY_LENGTH
        ) {
          return REDACTION_CENSOR;
        }
        const sanitized = new Array<unknown>(lengthDescriptor.value);
        for (let index = 0; index < lengthDescriptor.value; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined) continue;
          sanitized[index] =
            'value' in descriptor
              ? sanitizeLogValue(descriptor.value, [...path, index], state)
              : REDACTION_CENSOR;
        }
        return sanitized;
      }
      if (!isPlainLogObject(value)) return REDACTION_CENSOR;
      if (isBufferLikeLogValue(value)) return REDACTION_CENSOR;

      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).filter(
        (key) => descriptors[key]?.enumerable === true,
      );
      if (keys.length > MAX_LOG_REDACTION_OBJECT_KEYS) {
        return REDACTION_CENSOR;
      }

      const sanitized: Record<string, unknown> = {};
      for (const key of keys) {
        const descriptor = descriptors[key];
        const sanitizedValue =
          descriptor !== undefined && 'value' in descriptor
            ? sanitizeLogValue(descriptor.value, [...path, key], state)
            : REDACTION_CENSOR;
        Object.defineProperty(sanitized, key, {
          configurable: true,
          enumerable: true,
          value: sanitizedValue,
          writable: true,
        });
      }
      return sanitized;
    } finally {
      state.active.delete(value);
    }
  } catch {
    return REDACTION_CENSOR;
  }
}

/**
 * Pino derives `msg` from a first-argument Error/err object before path
 * redaction. Sanitize those arguments, plus normalized root sensitive keys,
 * before Pino can synthesize an unredacted message.
 */
function sanitizeLogArgument(argument: unknown, index: number): unknown {
  if (argument instanceof Error) {
    return index === 0 ? { err: REDACTION_CENSOR } : REDACTION_CENSOR;
  }
  return sanitizeLogValue(argument, [], {
    active: new WeakSet<object>(),
    nodes: 0,
  });
}

/**
 * Child bindings are serialized before `logMethod`, so every final Pino line is
 * parsed and sanitized once more immediately before write. A malformed or
 * unsupported record becomes one fixed safe line instead of reaching stdout.
 */
function sanitizeSerializedLogLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as unknown;
    const sanitized = sanitizeLogValue(parsed, [], {
      active: new WeakSet<object>(),
      nodes: 0,
    });
    if (!isPlainLogObject(sanitized)) return LOG_REDACTION_FAILURE_LINE;
    return `${JSON.stringify(sanitized)}\n`;
  } catch {
    return LOG_REDACTION_FAILURE_LINE;
  }
}

/** Resolve a human log identity for the authenticated operator, if any. */
function userIdFor(req: IncomingMessage): string | undefined {
  const principal = (req as AuthenticatedRequest).operatorPrincipal;
  if (!principal) return undefined;
  return principal.user?.login ?? (principal.kind === 'legacy-token' ? 'legacy' : undefined);
}

/** Build the nestjs-pino params (structured JSON stdout + correlation + redaction). */
export function buildLoggerOptions(): Params {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Stable per-request id; honour an upstream X-Request-Id when present.
      genReqId: (req: IncomingMessage): string =>
        (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      // Stamp only the closed async-local correlation vocabulary onto each line.
      // Explicit projection is defense in depth if a caller passes a larger
      // orchestration object to one of the context wrappers.
      mixin(): Record<string, unknown> {
        const ctx = getTaskLogContext();
        return ctx
          ? {
              taskId: ctx.taskId,
              ...(ctx.attemptId === undefined ? {} : { attemptId: ctx.attemptId }),
              ...(ctx.attempt === undefined ? {} : { attempt: ctx.attempt }),
              ...(ctx.stage === undefined ? {} : { stage: ctx.stage }),
              ...(ctx.operationId === undefined
                ? {}
                : { operationId: ctx.operationId }),
            }
          : {};
      },
      // Async-local CAP correlation is authoritative. A caller cannot replace
      // it by attaching provider-controlled lookalike fields to a log object.
      mixinMergeStrategy(
        mergeObject: object,
        mixinObject: object,
      ): object {
        return { ...mergeObject, ...mixinObject };
      },
      // One structured access line per request, carrying the operator identity.
      customProps: (req: IncomingMessage): Record<string, unknown> => {
        const userId = userIdFor(req);
        return userId ? { userId } : {};
      },
      hooks: {
        logMethod(inputArgs, method) {
          const sanitizedArgs = inputArgs.map((argument, index) =>
            sanitizeLogArgument(argument, index),
          ) as [obj: unknown, msg?: string, ...args: unknown[]];
          return method.apply(this, sanitizedArgs);
        },
        streamWrite(line) {
          return sanitizeSerializedLogLine(line);
        },
      },
      redact: { paths: REDACT_PATHS, censor: redactUnsafeLogField },
      // Raw JSON in prod (machine-parseable for the collector); pretty in dev.
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:standard' },
          },
    },
  };
}
