/**
 * fix-codex-headless-subscription-auth — the codex runtime's emitted config.toml MUST set
 * cli_auth_credentials_store="file" so codex loads the injected auth.json in the keyring-less
 * sandbox (otherwise: 401 "Missing bearer"). Pure: decodes the base64 config.toml out of the
 * setup command and asserts the key is present + correctly placed (a top-level key before any [table]).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

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

/** Decode the config.toml written by the runtime's first setup command. */
function configTomlOf(material: AuthMaterial | null): string {
  const plan = new CodexRuntime().sandboxSetupCommands(CTX, material);
  assert.ok(plan.ok, 'codex setup plan must be ok');
  const cmd = plan.commands.find((c) => c.command.includes('config.toml'));
  assert.ok(cmd, 'a config.toml setup command must exist');
  const m = cmd!.command.match(
    /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > [^ ]*config\.toml/,
  );
  assert.ok(m, 'config.toml base64 payload must be extractable');
  return Buffer.from(m![1], 'base64').toString('utf8');
}

test('codex config.toml sets cli_auth_credentials_store="file" for official ChatGPT auth', () => {
  const toml = configTomlOf({ authJson: '{"auth_mode":"chatgpt"}' });
  assert.match(toml, /cli_auth_credentials_store = "file"/);
  // it is a TOP-LEVEL key — must precede any [table] header (TOML requirement)
  assert.ok(
    toml.indexOf('cli_auth_credentials_store') < toml.indexOf('['),
    'the file-store key must come before any [table]',
  );
});

test('codex config.toml sets the file store even with no credential (degraded run)', () => {
  assert.match(configTomlOf(null), /cli_auth_credentials_store = "file"/);
});

test('codex config.toml keeps the file store + valid ordering for the compatible-provider path', () => {
  const toml = configTomlOf({
    codexCompatible: {
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-x',
    },
  });
  assert.match(toml, /cli_auth_credentials_store = "file"/);
  // all top-level keys (file-store + model/model_provider) precede the first [table]
  assert.ok(toml.indexOf('cli_auth_credentials_store') < toml.indexOf('['));
  assert.ok(toml.indexOf('model_provider') < toml.indexOf('['));
});
