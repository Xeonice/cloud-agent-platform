import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import pino from 'pino';
import {
  runWithTaskProvisioningAttemptLog,
  runWithTaskProvisioningOperationLog,
} from './log-context';
import { buildLoggerOptions } from './logger.options';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const REDACTED = '[Redacted]';

interface CanaryVariants {
  readonly raw: string;
  readonly urlEncoded: string;
  readonly base64: string;
  readonly base64url: string;
  readonly hex: string;
  readonly buffer: Buffer;
  readonly uint8Array: Uint8Array;
  readonly arrayBuffer: ArrayBuffer;
  readonly dataView: DataView;
  readonly subarray: Uint8Array;
  readonly bufferLike: { readonly type: 'Buffer'; readonly data: readonly number[] };
}

interface SerializedLog {
  readonly json: Record<string, unknown>;
  readonly line: string;
}

class MemorySink extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const REDACTION_CATEGORIES = [
  { name: 'command and argv', fields: ['command', 'argv'] },
  { name: 'stdout stderr and output', fields: ['stdout', 'stderr', 'output'] },
  { name: 'prompt', fields: ['prompt'] },
  {
    name: 'body and response',
    fields: [
      'body',
      'requestBody',
      'providerRequestBody',
      'response',
      'responseBody',
      'providerResponse',
      'providerResponseBody',
      'rawProviderResponse',
    ],
  },
  {
    name: 'URL and endpoint',
    fields: ['url', 'endpoint', 'connectionUrl', 'repositoryUrl', 'requestUrl'],
  },
  {
    name: 'headers',
    fields: ['headers', 'requestHeaders', 'responseHeaders', 'authorization', 'cookie'],
  },
  { name: 'environment and config', fields: ['environment', 'env', 'config', 'configuration'] },
  {
    name: 'credential secret and path',
    fields: [
      'credential',
      'credentials',
      'credentialPath',
      'secret',
      'secrets',
      'secretPath',
      'token',
      'apiKey',
      'password',
      'path',
      'cwd',
      'workingDirectory',
      'tempPath',
    ],
  },
  {
    name: 'raw provider identifiers',
    fields: [
      'providerId',
      'rawProviderId',
      'providerResourceId',
      'rawProviderResourceId',
      'providerExecutionId',
      'rawProviderExecutionId',
      'providerSandboxId',
      'rawProviderSandboxId',
      'providerConnectionId',
      'rawProviderConnectionId',
      'resourceId',
      'executionId',
      'sandboxId',
      'connectionId',
    ],
  },
  {
    name: 'provider error cause stack and reason',
    fields: [
      'error',
      'err',
      'rawError',
      'providerError',
      'rawProviderError',
      'errorMessage',
      'cause',
      'stack',
      'reason',
    ],
  },
] as const;

function canaries(label: string): CanaryVariants {
  const arrayBufferBytes = Uint8Array.from(Buffer.from(`arraybuffer:${label}:secret`, 'utf8'));
  const dataViewBytes = Uint8Array.from(Buffer.from(`dataview:${label}:secret`, 'utf8'));
  const subarrayBytes = Uint8Array.from(Buffer.from(`!subarray:${label}:secret!`, 'utf8'));
  const bufferLikeBytes = Buffer.from(`bufferlike:${label}:secret`, 'utf8');
  return {
    raw: `raw://${label}/credential?token=raw-secret`,
    urlEncoded: encodeURIComponent(`url://${label}/credential?token=url-secret`),
    base64: Buffer.from(`base64:${label}:secret`, 'utf8').toString('base64'),
    base64url: Buffer.from(`base64url:${label}:secret`, 'utf8').toString('base64url'),
    hex: Buffer.from(`hex:${label}:secret`, 'utf8').toString('hex'),
    buffer: Buffer.from(`buffer:${label}:secret`, 'utf8'),
    uint8Array: new Uint8Array(Buffer.from(`uint8array:${label}:secret`, 'utf8')),
    arrayBuffer: arrayBufferBytes.buffer,
    dataView: new DataView(dataViewBytes.buffer),
    subarray: subarrayBytes.subarray(1, subarrayBytes.length - 1),
    bufferLike: { type: 'Buffer', data: [...bufferLikeBytes] },
  };
}

function serializeOne(argument: Record<string, unknown> | Error): SerializedLog {
  const pinoHttp = buildLoggerOptions().pinoHttp;
  assert.equal(typeof pinoHttp, 'object');
  assert.notEqual(pinoHttp, null);

  const options = pinoHttp as {
    readonly mixin?: () => Record<string, unknown>;
    readonly mixinMergeStrategy?: pino.LoggerOptions['mixinMergeStrategy'];
    readonly hooks?: pino.LoggerOptions['hooks'];
    readonly redact?: pino.LoggerOptions['redact'];
  };
  assert.notEqual(options.redact, undefined, 'logger redaction must be configured');

  const sink = new MemorySink();
  const logger = pino(
    {
      level: 'info',
      hooks: options.hooks,
      mixin: options.mixin,
      mixinMergeStrategy: options.mixinMergeStrategy,
      redact: options.redact,
      timestamp: false,
      base: undefined,
    },
    sink,
  );
  logger.info(argument as Record<string, unknown>);

  const lines = sink.text().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'Pino must emit exactly one JSON line');
  const line = lines[0];
  if (line === undefined) assert.fail('Pino did not emit a JSON line');
  return { json: JSON.parse(line) as Record<string, unknown>, line };
}

function serializeChild(
  bindings: Record<string, unknown>,
  argument: Record<string, unknown>,
): SerializedLog {
  const pinoHttp = buildLoggerOptions().pinoHttp;
  assert.equal(typeof pinoHttp, 'object');
  assert.notEqual(pinoHttp, null);

  const options = pinoHttp as {
    readonly mixin?: () => Record<string, unknown>;
    readonly mixinMergeStrategy?: pino.LoggerOptions['mixinMergeStrategy'];
    readonly hooks?: pino.LoggerOptions['hooks'];
    readonly redact?: pino.LoggerOptions['redact'];
  };
  const sink = new MemorySink();
  const logger = pino(
    {
      level: 'info',
      hooks: options.hooks,
      mixin: options.mixin,
      mixinMergeStrategy: options.mixinMergeStrategy,
      redact: options.redact,
      timestamp: false,
      base: undefined,
    },
    sink,
  ).child(bindings);
  logger.info(argument);

  const lines = sink.text().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'Pino child must emit exactly one JSON line');
  const line = lines[0];
  if (line === undefined) assert.fail('Pino child did not emit a JSON line');
  return { json: JSON.parse(line) as Record<string, unknown>, line };
}

function assertCanariesAbsent(line: string, variants: CanaryVariants): void {
  const forbidden = [
    variants.raw,
    variants.urlEncoded,
    variants.base64,
    variants.base64url,
    variants.hex,
    JSON.stringify(variants.buffer),
    JSON.stringify(variants.uint8Array),
    JSON.stringify(variants.subarray),
    JSON.stringify(variants.bufferLike),
  ];
  for (const fragment of forbidden) {
    assert.equal(line.includes(fragment), false, `serialized log leaked ${fragment}`);
  }
  for (const variantName of Object.keys(variants)) {
    assert.equal(
      line.includes(`"${variantName}":`),
      false,
      `serialized log retained ${variantName}`,
    );
  }
}

function nestedRecord(
  path: readonly (string | number)[],
  value: unknown,
): Record<string, unknown> {
  let nested: unknown = value;
  for (const segment of [...path].reverse()) {
    nested = typeof segment === 'number' ? [nested] : { [segment]: nested };
  }
  assert.equal(Array.isArray(nested), false);
  return nested as Record<string, unknown>;
}

function valueAtPath(root: unknown, path: readonly (string | number)[]): unknown {
  let value = root;
  for (const segment of path) {
    assert.equal(typeof value, 'object');
    assert.notEqual(value, null);
    value = (value as Record<string | number, unknown>)[segment];
  }
  return value;
}

for (const category of REDACTION_CATEGORIES) {
  test(`real Pino JSON redacts ${category.name} with every encoded and binary variant`, () => {
    const variantsByField = Object.fromEntries(
      category.fields.map((field) => [field, canaries(`${category.name}:${field}`)]),
    ) as Record<string, CanaryVariants>;
    const { json, line } = serializeOne(variantsByField);

    for (const field of category.fields) {
      assert.equal(json[field], REDACTED, `${field} was not censored as a whole`);
      const variants = variantsByField[field];
      if (variants === undefined) assert.fail(`missing variants for ${field}`);
      assertCanariesAbsent(line, variants);
    }
  });
}

test('real Pino JSON redacts sensitive values through the bounded nested object and array depth', () => {
  // Twelve path segments is the deliberate policy boundary in logger.options.
  const path = ['layer1', 0, 'layer3', 0, 'layer5', 0, 'layer7', 0, 'layer9', 0, 'layer11', 'command'] as const;
  const variants = canaries('depth-12-object-array');
  const { json, line } = serializeOne(nestedRecord(path, variants));

  assert.equal(valueAtPath(json, path), REDACTED);
  assertCanariesAbsent(line, variants);
});

test('real Pino JSON fails closed on a sensitive subtree beyond the bounded depth', () => {
  const path = [
    'layer1',
    0,
    'layer3',
    0,
    'layer5',
    0,
    'layer7',
    0,
    'layer9',
    0,
    'layer11',
    'layer12',
    'command',
  ] as const;
  const variants = canaries('depth-13-fail-closed-subtree');
  const { json, line } = serializeOne(nestedRecord(path, variants));

  assert.equal(valueAtPath(json, path.slice(0, 12)), REDACTED);
  assertCanariesAbsent(line, variants);
});

test('real Pino hooks prevent Error serializers from copying provider text into msg', () => {
  const raw = 'provider-error-message-canary-must-never-reach-json';
  const stack = `Error: ${raw}\n    at provider-secret-stack`;
  const directError = Object.assign(new Error(raw), {
    cause: 'provider-private-cause',
    stack,
  });
  const cases: readonly (readonly [string, Record<string, unknown> | Error])[] = [
    ['direct Error', directError],
    ['err Error property', { err: directError }],
    [
      'err-shaped object',
      {
        err: {
          message: raw,
          cause: 'provider-private-cause',
          stack,
        },
      },
    ],
  ];

  for (const [name, argument] of cases) {
    const { json, line } = serializeOne(argument);
    assert.equal(json.err, REDACTED, `${name} was not redacted`);
    assert.equal('msg' in json, false, `${name} copied a provider message into msg`);
    assert.equal(line.includes(raw), false, `${name} leaked the Error message`);
    assert.equal(line.includes('provider-private-cause'), false, `${name} leaked the cause`);
    assert.equal(line.includes('provider-secret-stack'), false, `${name} leaked the stack`);
  }
});

test('real Pino hooks normalize sensitive root field spelling before redaction', () => {
  const raw = 'normalized-root-provider-id-canary';
  const { json, line } = serializeOne({
    RAW_PROVIDER_EXECUTION_ID: raw,
    'Provider-Resource-Id': raw,
    provider_url: raw,
    workspace_path: raw,
    http_headers: raw,
    response_text: raw,
    client_secret: raw,
    provider_native_resource_id: raw,
    api_response: raw,
    environment_dump: raw,
    config_dump: raw,
    stdout_text: raw,
    stderr_bytes: raw,
    output_chunk: raw,
    prompt_text: raw,
    url_value: raw,
    request_payload: raw,
    nested: {
      'Provider-URL': raw,
      items: [{ 'Workspace-Path': raw, api_response: raw }],
    },
  });

  assert.equal(json.RAW_PROVIDER_EXECUTION_ID, REDACTED);
  assert.equal(json['Provider-Resource-Id'], REDACTED);
  assert.equal(json.provider_url, REDACTED);
  assert.equal(json.workspace_path, REDACTED);
  assert.equal(json.http_headers, REDACTED);
  assert.equal(json.response_text, REDACTED);
  assert.equal(json.client_secret, REDACTED);
  assert.equal(json.provider_native_resource_id, REDACTED);
  assert.equal(json.api_response, REDACTED);
  assert.equal(json.environment_dump, REDACTED);
  assert.equal(json.config_dump, REDACTED);
  assert.equal(json.stdout_text, REDACTED);
  assert.equal(json.stderr_bytes, REDACTED);
  assert.equal(json.output_chunk, REDACTED);
  assert.equal(json.prompt_text, REDACTED);
  assert.equal(json.url_value, REDACTED);
  assert.equal(json.request_payload, REDACTED);
  assert.deepEqual(json.nested, {
    'Provider-URL': REDACTED,
    items: [{ 'Workspace-Path': REDACTED, api_response: REDACTED }],
  });
  assert.equal(line.includes(raw), false);
});

test('real Pino redacts an Error value nested below a non-sensitive key', () => {
  const raw = 'nested-custom-error-to-json-canary';
  const error = Object.assign(new Error(raw), {
    toJSON: () => ({ providerResponse: raw, detail: raw }),
  });
  const { json, line } = serializeOne({ nested: { items: [{ unexpected: error }] } });

  assert.deepEqual(json.nested, { items: [{ unexpected: REDACTED }] });
  assert.equal(line.includes(raw), false);
});

test('real Pino final write gate redacts unsafe child bindings', () => {
  const raw = 'child-binding-provider-canary';
  const error = Object.assign(new Error(raw), {
    toJSON: () => ({ providerResponse: raw, detail: raw }),
  });
  const { json, line } = serializeChild(
    {
      provider_url: raw,
      client_secret: raw,
      nested: { api_response: raw, failure: error },
    },
    { safe: true },
  );

  assert.equal(json.provider_url, REDACTED);
  assert.equal(json.client_secret, REDACTED);
  assert.deepEqual(json.nested, {
    api_response: REDACTED,
    failure: REDACTED,
  });
  assert.equal(json.safe, true);
  assert.equal(line.includes(raw), false);
});

test('real Pino censors child Error and binary bindings before serialization', () => {
  const raw = 'child-pre-serialization-error-canary';
  const variants = canaries('child-pre-serialization-binary-canary');
  const error = Object.assign(new Error(raw), {
    toJSON: () => raw,
  });
  const { json, line } = serializeChild(
    {
      unexpected: error,
      alpha: variants.buffer,
      beta: variants.uint8Array,
      gamma: variants.arrayBuffer,
      delta: variants.dataView,
      epsilon: variants.subarray,
      zeta: variants.bufferLike,
    },
    { safe: true },
  );

  for (const key of [
    'unexpected',
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
  ]) {
    assert.equal(json[key], REDACTED, `${key} escaped child binding redaction`);
  }
  assert.equal(line.includes(raw), false);
  assertCanariesAbsent(line, variants);
});

test('real Pino sanitizer never invokes getters and fails closed on cycles', () => {
  const raw = 'getter-cycle-provider-canary';
  const nested: Record<string, unknown> = { safe: true };
  nested.self = nested;
  Object.defineProperty(nested, 'providerResponse', {
    enumerable: true,
    get(): never {
      throw new Error(raw);
    },
  });

  const { json, line } = serializeOne({ nested });
  assert.deepEqual(json.nested, {
    safe: true,
    self: REDACTED,
    providerResponse: REDACTED,
  });
  assert.equal(line.includes(raw), false);
});

test('real Pino validates closed safe exception values instead of trusting their names', () => {
  const valid = serializeOne({ commandKind: 'runtime_setup', responseTime: 12 });
  assert.equal(valid.json.commandKind, 'runtime_setup');
  assert.equal(valid.json.responseTime, 12);

  const invalid = serializeOne({
    commandKind: 'shell --token provider-canary',
    responseTime: Number.POSITIVE_INFINITY,
  });
  assert.equal(invalid.json.commandKind, REDACTED);
  assert.equal(invalid.json.responseTime, REDACTED);
  assert.equal(invalid.line.includes('provider-canary'), false);
});

test('real Pino JSON keeps only bounded CAP correlation and the two explicit safe exceptions', () => {
  const { json, line } = runWithTaskProvisioningAttemptLog(
    { taskId: TASK_ID, attemptId: ATTEMPT_ID, attempt: 4 },
    () =>
      runWithTaskProvisioningOperationLog(
        { stage: 'runtime_setup', operationId: OPERATION_ID },
        () =>
          serializeOne({
            event: 'task_provisioning_diagnostic_event',
            eventId: EVENT_ID,
            cause: 'command_failed',
            req: {
              url: '/v1/tasks?cursor=safe-access-path',
              headers: { authorization: 'Bearer access-header-canary' },
            },
            res: { headers: { 'set-cookie': 'session=response-header-canary' } },
            providerResourceId: 'provider-resource-must-be-redacted',
          }),
      ),
  );

  assert.equal(json.taskId, TASK_ID);
  assert.equal(json.attemptId, ATTEMPT_ID);
  assert.equal(json.attempt, 4);
  assert.equal(json.stage, 'runtime_setup');
  assert.equal(json.operationId, OPERATION_ID);
  assert.equal(json.eventId, EVENT_ID);
  assert.equal(json.cause, 'command_failed');
  assert.deepEqual(json.req, {
    url: '/v1/tasks?cursor=safe-access-path',
    headers: REDACTED,
  });
  assert.deepEqual(json.res, { headers: REDACTED });
  assert.equal(json.providerResourceId, REDACTED);
  assert.equal(line.includes('provider-resource-must-be-redacted'), false);
  assert.equal(line.includes('access-header-canary'), false);
  assert.equal(line.includes('response-header-canary'), false);
});

test('real Pino keeps async-local CAP correlation authoritative over caller fields', () => {
  const { json, line } = runWithTaskProvisioningAttemptLog(
    { taskId: TASK_ID, attemptId: ATTEMPT_ID, attempt: 4 },
    () =>
      runWithTaskProvisioningOperationLog(
        { stage: 'runtime_setup', operationId: OPERATION_ID },
        () =>
          serializeOne({
            taskId: 'provider-task-id-canary',
            attemptId: 'provider-attempt-id-canary',
            attempt: 999,
            stage: 'provider-stage-canary',
            operationId: 'provider-operation-id-canary',
          }),
      ),
  );

  assert.equal(json.taskId, TASK_ID);
  assert.equal(json.attemptId, ATTEMPT_ID);
  assert.equal(json.attempt, 4);
  assert.equal(json.stage, 'runtime_setup');
  assert.equal(json.operationId, OPERATION_ID);
  assert.equal(line.includes('provider-'), false);
});

test('real Pino JSON redacts a free-form cause while retaining a canonical null cause', () => {
  const rawCause = 'provider cause with arbitrary private diagnostics';
  const redacted = serializeOne({ cause: rawCause });
  assert.equal(redacted.json.cause, REDACTED);
  assert.equal(redacted.line.includes(rawCause), false);

  const canonicalNull = serializeOne({ cause: null });
  assert.equal(canonicalNull.json.cause, null);
});
