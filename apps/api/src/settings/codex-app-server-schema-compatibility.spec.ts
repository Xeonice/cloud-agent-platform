import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import schemaFixture from './fixtures/codex-app-server-login-schema-0.144.1.json';
import { CODEX_APP_SERVER_ARGV } from './docker-codex-device-login-runner';

const PIN_PATTERN = /ARG CODEX_VERSION=([^\s]+)/;

async function codexPinIn(path: string): Promise<string> {
  const source = await readFile(path, 'utf8');
  const match = source.match(PIN_PATTERN);
  assert.ok(match, `${path} must pin CODEX_VERSION`);
  return match[1];
}

test('checked App Server fixture retains every consumed 0.144.1 login shape', () => {
  assert.equal(schemaFixture.generatedBy, 'codex app-server generate-json-schema --out <dir>');
  assert.deepEqual(schemaFixture.initialize, {
    requestMethod: 'initialize',
    paramsRequired: ['clientInfo'],
    clientInfoRequired: ['name', 'version'],
    responseRequired: ['codexHome', 'platformFamily', 'platformOs', 'userAgent'],
    initializedNotificationMethod: 'initialized',
  });
  assert.deepEqual(schemaFixture.deviceLogin, {
    startMethod: 'account/login/start',
    startType: 'chatgptDeviceCode',
    responseRequired: ['loginId', 'type', 'userCode', 'verificationUrl'],
    cancelMethod: 'account/login/cancel',
    cancelParamsRequired: ['loginId'],
    cancelStatuses: ['canceled', 'notFound'],
    completedNotificationMethod: 'account/login/completed',
    completedRequired: ['success'],
    completedProperties: ['error', 'loginId', 'success'],
  });
  assert.deepEqual(CODEX_APP_SERVER_ARGV, [
    'codex',
    'app-server',
    '--stdio',
    '-c',
    'cli_auth_credentials_store="file"',
  ]);
});

test('AIO and BoxLite Codex pins must match the checked login schema fixture', async () => {
  const repoRoot = resolve(__dirname, '../../../..');
  const [aioPin, boxlitePin] = await Promise.all([
    codexPinIn(resolve(repoRoot, 'docker/aio-sandbox.Dockerfile')),
    codexPinIn(resolve(repoRoot, 'docker/boxlite-sandbox.Dockerfile')),
  ]);
  assert.equal(
    aioPin,
    schemaFixture.codexVersion,
    'regenerate the App Server schema fixture before changing the AIO Codex pin',
  );
  assert.equal(
    boxlitePin,
    schemaFixture.codexVersion,
    'the BoxLite and checked App Server Codex versions must not drift',
  );
});
