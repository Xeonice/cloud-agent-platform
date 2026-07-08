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
