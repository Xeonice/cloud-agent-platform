/**
 * Schema validation for managed sandbox environment sources. Drives the REAL
 * compiled zod schemas from dist/ so api + web share the same simplified image
 * model.
 *
 * Requires `pnpm --filter @cap/contracts build` first.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  CreateSandboxEnvironmentRequestSchema,
  SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MAX,
  SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MIN,
  SandboxEnvironmentSchema,
  SandboxEnvironmentValidationSchema,
  SandboxEnvironmentSourceKindSchema,
  SandboxEnvironmentSourceSchema,
} = require(path.join(here, '..', 'dist', 'sandbox-environment.js'));

test('source kind schema exposes only managed AIO and BoxLite image sources', () => {
  assert.deepEqual(SandboxEnvironmentSourceKindSchema.options, [
    'aio-docker-image',
    'boxlite-image',
  ]);
});

test('source schema accepts AIO and BoxLite image references', () => {
  assert.deepEqual(
    SandboxEnvironmentSourceSchema.parse({
      kind: 'aio-docker-image',
      image: 'ghcr.io/example/cap-aio-sandbox:v1',
      digest: 'sha256:aio',
    }),
    {
      kind: 'aio-docker-image',
      image: 'ghcr.io/example/cap-aio-sandbox:v1',
      digest: 'sha256:aio',
    },
  );
  assert.deepEqual(
    SandboxEnvironmentSourceSchema.parse({
      kind: 'boxlite-image',
      image: 'ghcr.io/example/cap-boxlite-sandbox:v1',
    }),
    {
      kind: 'boxlite-image',
      image: 'ghcr.io/example/cap-boxlite-sandbox:v1',
    },
  );
});

test('source schema rejects removed delivery-specific source kinds', () => {
  for (const source of [
    {
      kind: 'aio-loaded-docker-image',
      image: 'cap-aio-custom:v1',
      imageId: 'sha256:loaded',
    },
    {
      kind: 'boxlite-rootfs',
      rootfsPath: '/var/lib/cap/rootfs/custom',
    },
    {
      kind: 'provider-template',
      providerFamily: 'cloud-http',
      templateId: 'template-a',
    },
    {
      kind: 'oci-upload',
      uploadId: 'upload-a',
    },
  ]) {
    assert.throws(
      () => SandboxEnvironmentSourceSchema.parse(source),
      `expected ${source.kind} to be rejected`,
    );
  }
});

test('create request rejects removed delivery-specific source kinds', () => {
  assert.throws(() =>
    CreateSandboxEnvironmentRequestSchema.parse({
      name: 'Loaded AIO',
      source: {
        kind: 'aio-loaded-docker-image',
        image: 'cap-aio-custom:v1',
      },
    }),
  );
});

test('create request accepts image parameters and validates env names', () => {
  assert.deepEqual(
    CreateSandboxEnvironmentRequestSchema.parse({
      name: 'BoxLite gcode',
      source: { kind: 'boxlite-image', image: 'registry.example/cap-boxlite:gcode' },
      parameters: [
        { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5' },
        { name: 'GCODE_TOKEN', value: 'secret', secret: true },
      ],
    }).parameters,
    [
      { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5' },
      { name: 'GCODE_TOKEN', value: 'secret', secret: true },
    ],
  );

  assert.throws(() =>
    CreateSandboxEnvironmentRequestSchema.parse({
      name: 'bad',
      source: { kind: 'aio-docker-image', image: 'cap/aio:v1' },
      parameters: [{ name: 'bad-name', value: 'x' }],
    }),
  );
});

test('create/read contracts validate bounded resources independently of image parameters', () => {
  assert.equal(SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MIN, 1);
  assert.equal(SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MAX, 1024);

  const request = CreateSandboxEnvironmentRequestSchema.parse({
    name: 'BoxLite large workspace',
    source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
    resources: { diskSizeGb: 5 },
    parameters: [{ name: 'GCODE_TOKEN', value: 'secret', secret: true }],
  });
  assert.deepEqual(request.resources, { diskSizeGb: 5 });
  assert.deepEqual(request.parameters, [
    { name: 'GCODE_TOKEN', value: 'secret', secret: true },
  ]);

  for (const diskSizeGb of [0, 1.5, 1025]) {
    assert.throws(() =>
      CreateSandboxEnvironmentRequestSchema.parse({
        name: 'Invalid disk',
        source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
        resources: { diskSizeGb },
      }),
    );
  }
  assert.throws(() =>
    CreateSandboxEnvironmentRequestSchema.parse({
      name: 'Unknown resource',
      source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
      resources: { diskSizeGb: 5, memorySizeGb: 8 },
    }),
  );
  assert.throws(() =>
    CreateSandboxEnvironmentRequestSchema.parse({
      name: 'Resource disguised as a guest parameter field',
      source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
      parameters: [{ name: 'GCODE_TOKEN', value: 'secret', diskSizeGb: 5 }],
    }),
  );
});

test('resource contracts preserve nullable and omitted legacy representations', () => {
  const base = {
    id: '00000000-0000-4000-a000-000000000001',
    name: 'Legacy BoxLite',
    status: 'ready',
    source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
    compatibility: { providerFamilies: ['boxlite'] },
    isDefault: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  assert.equal(SandboxEnvironmentSchema.parse(base).resources, undefined);
  assert.equal(
    SandboxEnvironmentSchema.parse({ ...base, resources: null }).resources,
    null,
  );
});

test('validation history carries an additive nullable resource snapshot', () => {
  const validation = {
    id: '00000000-0000-4000-a000-000000000101',
    environmentId: '00000000-0000-4000-a000-000000000001',
    status: 'passed',
    providerFamily: 'boxlite',
    sourceKind: 'boxlite-image',
    resourceSnapshot: { diskSizeGb: 9 },
    checkedAt: new Date('2026-07-01T00:00:00.000Z'),
  };
  assert.deepEqual(
    SandboxEnvironmentValidationSchema.parse(validation).resourceSnapshot,
    { diskSizeGb: 9 },
  );
  assert.equal(
    SandboxEnvironmentValidationSchema.parse({
      ...validation,
      resourceSnapshot: null,
    }).resourceSnapshot,
    null,
  );
  const { resourceSnapshot: _resourceSnapshot, ...legacy } = validation;
  assert.equal(
    SandboxEnvironmentValidationSchema.parse(legacy).resourceSnapshot,
    undefined,
  );
});

test('environment response can expose secret parameter keys without values', () => {
  const parsed = SandboxEnvironmentSchema.parse({
    id: '00000000-0000-4000-a000-000000000001',
    name: 'BoxLite gcode',
    status: 'ready',
    source: { kind: 'boxlite-image', image: 'cap/boxlite:gcode' },
    compatibility: { providerFamilies: ['boxlite'] },
    parameters: [
      { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5', secret: false },
      { name: 'GCODE_TOKEN', secret: true },
    ],
    isDefault: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  });
  assert.equal(parsed.parameters[1].value, undefined);
});
