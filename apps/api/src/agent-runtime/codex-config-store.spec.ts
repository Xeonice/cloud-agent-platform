/**
 * fix-codex-headless-subscription-auth — the codex runtime's emitted config.toml MUST set
 * cli_auth_credentials_store="file" so codex loads the injected auth.json in the keyring-less
 * sandbox (otherwise: 401 "Missing bearer"). The config is delivered through the same opaque,
 * one-shot provider-private file port used in production; the verification command itself must
 * contain neither config contents nor credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxRuntimePrivateFilePort } from '@cap/sandbox';
import { CodexRuntime } from './codex-runtime';
import type {
  AuthMaterial,
  SandboxSetupContext,
} from './agent-runtime.port';

const CTX: SandboxSetupContext = {
  taskId: 't1',
  workspaceDir: '/home/gem/workspace',
  prompt: null,
};

/** Consume the opaque setup handles through the provider-private port. */
async function configTomlOf(
  material: AuthMaterial | null,
  expectedPaths: readonly string[],
  forbiddenValues: readonly string[] = [],
): Promise<string> {
  const plan = new CodexRuntime().sandboxSetupCommands(CTX, material);
  assert.ok(plan.ok, 'codex setup plan must be ok');
  const cmd = plan.commands.find((c) => c.command.includes('config.toml'));
  assert.ok(cmd, 'a config.toml setup command must exist');
  assert.deepEqual(cmd.descriptor, {
    commandKind: 'credential_setup',
    ordinal: 1,
  });
  assert.equal(cmd.tolerateUnresolvedExit, false);
  assert.doesNotMatch(
    cmd.command,
    /printf|base64|cli_auth_credentials_store|experimental_bearer_token/u,
  );
  const serializedPlan = JSON.stringify(plan);
  for (const value of forbiddenValues) {
    for (const variant of [
      value,
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('base64url'),
      Buffer.from(value).toString('hex'),
    ]) {
      assert.equal(serializedPlan.includes(variant), false);
      assert.equal(cmd.command.includes(variant), false);
    }
  }

  const writes = new Map<string, { content: string; mode: number }>();
  const providerBuffers: Uint8Array[] = [];
  const port = createSandboxRuntimePrivateFilePort({
    rootDirectory: '/home/gem',
    transport: {
      async writeFile(request) {
        providerBuffers.push(request.content);
        writes.set(request.path, {
          content: Buffer.from(request.content).toString('utf8'),
          mode: request.mode,
        });
      },
      async deleteFile() {},
    },
  });
  for (const file of cmd.privateFiles ?? []) await port.writeFile(file);
  assert.deepEqual([...writes.keys()].sort(), [...expectedPaths].sort());
  for (const write of writes.values()) assert.equal(write.mode, 0o600);
  for (const bytes of providerBuffers) {
    assert.equal(bytes.every((byte) => byte === 0), true);
  }

  const config = writes.get('/home/gem/.codex/config.toml');
  assert.ok(config, 'config.toml must be delivered through the private-file port');
  return config.content;
}

test('codex config.toml sets cli_auth_credentials_store="file" for official ChatGPT auth', async () => {
  const authJson = '{"auth_mode":"chatgpt-fixture"}';
  const toml = await configTomlOf(
    { authJson },
    ['/home/gem/.codex/config.toml', '/home/gem/.codex/auth.json'],
    [authJson],
  );
  assert.match(toml, /cli_auth_credentials_store = "file"/);
  // it is a TOP-LEVEL key — must precede any [table] header (TOML requirement)
  assert.ok(
    toml.indexOf('cli_auth_credentials_store') < toml.indexOf('['),
    'the file-store key must come before any [table]',
  );
});

test('codex config.toml sets the file store even with no credential (degraded run)', async () => {
  assert.match(
    await configTomlOf(null, ['/home/gem/.codex/config.toml']),
    /cli_auth_credentials_store = "file"/,
  );
});

test('codex config.toml keeps the file store + valid ordering for the compatible-provider path', async () => {
  const material = {
    codexCompatible: {
      baseUrl: 'https://example.com/v1',
      apiKey: 'compatible-provider-fixture-secret',
      model: 'gpt-x',
    },
  };
  const toml = await configTomlOf(
    material,
    ['/home/gem/.codex/config.toml'],
    [material.codexCompatible.apiKey],
  );
  assert.match(toml, /cli_auth_credentials_store = "file"/);
  // all top-level keys (file-store + model/model_provider) precede the first [table]
  assert.ok(toml.indexOf('cli_auth_credentials_store') < toml.indexOf('['));
  assert.ok(toml.indexOf('model_provider') < toml.indexOf('['));
});
