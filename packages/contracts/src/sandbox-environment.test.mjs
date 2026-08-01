/**
 * Schema validation for managed sandbox environment sources. Drives the REAL
 * compiled zod schemas from dist/ so api + web share the same simplified image
 * model.
 *
 * Requires `pnpm --filter @cap-console/contracts build` first.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  CreateSandboxEnvironmentRequestSchema,
  RuntimeArtifactChecksumsSchema,
  SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MAX,
  SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MIN,
  SandboxEnvironmentSchema,
  SandboxEnvironmentValidationSchema,
  SandboxEnvironmentSourceKindSchema,
  SandboxEnvironmentSourceSchema,
  UpdateSandboxEnvironmentParametersRequestSchema,
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

// --- Runtime artifact checksums (unlock-extension-axes D1): record keyed by ---
// --- the runtime vocabulary, with explicitly PARTIAL semantics.             ---

const CODEX_SUM = `sha256:${'a'.repeat(64)}`;
const CLAUDE_SUM = `sha256:${'b'.repeat(64)}`;

test('runtime artifact checksums: an attestation missing some declared runtime key parses (partial semantics)', () => {
  // A historical attestation persisted before a runtime was declared carries no
  // checksum for it. The record schema tolerates ANY missing declared key, so a
  // newly declared runtime cannot make old attestations unparseable.
  assert.deepEqual(
    RuntimeArtifactChecksumsSchema.parse({ codex: CODEX_SUM }),
    { codex: CODEX_SUM },
  );
  assert.deepEqual(
    RuntimeArtifactChecksumsSchema.parse({ 'claude-code': CLAUDE_SUM }),
    { 'claude-code': CLAUDE_SUM },
  );
  assert.deepEqual(RuntimeArtifactChecksumsSchema.parse({}), {});
});

test('runtime artifact checksums: pre-change attestation fixtures parse identically', () => {
  // The fixtures the strict literal-key object accepted (both keys, either key
  // alone) parse to byte-identical results; what it rejected (malformed
  // checksum values) stays rejected.
  const validation = {
    id: '00000000-0000-4000-a000-000000000102',
    environmentId: '00000000-0000-4000-a000-000000000001',
    status: 'passed',
    providerFamily: 'boxlite',
    sourceKind: 'boxlite-image',
    runtimeArtifactChecksums: { codex: CODEX_SUM, 'claude-code': CLAUDE_SUM },
    checkedAt: new Date('2026-07-01T00:00:00.000Z'),
  };
  assert.deepEqual(
    SandboxEnvironmentValidationSchema.parse(validation).runtimeArtifactChecksums,
    { codex: CODEX_SUM, 'claude-code': CLAUDE_SUM },
  );
  assert.equal(
    SandboxEnvironmentValidationSchema.parse({
      ...validation,
      runtimeArtifactChecksums: null,
    }).runtimeArtifactChecksums,
    null,
  );
  for (const malformed of [
    { codex: 'sha256:not-hex' },
    { codex: `sha256:${'a'.repeat(63)}` },
    { 'claude-code': `md5:${'b'.repeat(64)}` },
    { codex: 42 },
  ]) {
    assert.throws(
      () => RuntimeArtifactChecksumsSchema.parse(malformed),
      undefined,
      `expected malformed checksum ${JSON.stringify(malformed)} to be rejected`,
    );
  }
});

test('runtime artifact checksums: a non-vocabulary key is rejected', () => {
  assert.throws(() =>
    RuntimeArtifactChecksumsSchema.parse({ opencode: CODEX_SUM }),
  );
  assert.throws(() =>
    RuntimeArtifactChecksumsSchema.parse({
      codex: CODEX_SUM,
      'not-a-runtime': CLAUDE_SUM,
    }),
  );
});

test('no zod/v4 entrypoint import exists in contracts/api/web sources', () => {
  // Zod v4 flips enum-keyed z.record to EXHAUSTIVE, which would silently break
  // the partial checksum contract above (v4 migration path: z.partialRecord).
  // Pin the classic-v3-entrypoint constraint mechanically: scan every source of
  // the three constrained packages for a `zod/v4` subpath import.
  const repoRoot = path.join(here, '..', '..', '..');
  const roots = [
    path.join(repoRoot, 'packages', 'contracts', 'src'),
    path.join(repoRoot, 'apps', 'api', 'src'),
    path.join(repoRoot, 'apps', 'web', 'src'),
  ];
  const sourceExt = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  const offending = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.isFile() && sourceExt.test(entry.name)) {
        scanned += 1;
        if (/['"]zod\/v4/.test(fs.readFileSync(full, 'utf8'))) {
          offending.push(path.relative(repoRoot, full));
        }
      }
    }
  };
  for (const root of roots) walk(root);
  // An empty scan proves nothing — fail rather than pass vacuously.
  assert.ok(scanned > 100, `scan visited only ${scanned} files; scan roots look wrong`);
  assert.deepEqual(offending, []);
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

test('update-parameters request accepts set entries and keep entries', () => {
  const parsed = UpdateSandboxEnvironmentParametersRequestSchema.parse({
    parameters: [
      { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5' },
      { name: 'GCODE_TOKEN', keep: true },
      { name: 'GCODE_SECONDARY_TOKEN', value: 'rotated', secret: true },
    ],
  });
  assert.equal(parsed.parameters.length, 3);
  assert.equal(parsed.parameters[1].keep, true);
  assert.equal(parsed.parameters[1].value, undefined);
});

test('update-parameters request rejects a keep entry carrying a value', () => {
  assert.throws(() =>
    UpdateSandboxEnvironmentParametersRequestSchema.parse({
      parameters: [{ name: 'GCODE_TOKEN', keep: true, value: 'leak' }],
    }),
  );
});

test('update-parameters request rejects a set entry carrying keep', () => {
  assert.throws(() =>
    UpdateSandboxEnvironmentParametersRequestSchema.parse({
      parameters: [{ name: 'GCODE_TOKEN', value: 'v', secret: true, keep: true }],
    }),
  );
});

test('update-parameters request rejects duplicate parameter names', () => {
  assert.throws(() =>
    UpdateSandboxEnvironmentParametersRequestSchema.parse({
      parameters: [
        { name: 'GCODE_TOKEN', keep: true },
        { name: 'GCODE_TOKEN', value: 'again', secret: true },
      ],
    }),
  );
});

test('update-parameters request rejects unknown fields and invalid names', () => {
  assert.throws(() =>
    UpdateSandboxEnvironmentParametersRequestSchema.parse({
      parameters: [],
      extra: true,
    }),
  );
  assert.throws(() =>
    UpdateSandboxEnvironmentParametersRequestSchema.parse({
      parameters: [{ name: 'BAD NAME', value: 'x' }],
    }),
  );
  assert.throws(() =>
    UpdateSandboxEnvironmentParametersRequestSchema.parse({
      parameters: [{ name: 'GCODE_TOKEN', keep: false }],
    }),
  );
});
