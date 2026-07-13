import assert from 'node:assert/strict';
import test from 'node:test';

import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import { CODEX_DEVICE_LOGIN_RUNNER } from './codex-device-login-runner';
import { CodexDeviceLoginService } from './codex-device-login.service';
import { DockerCodexDeviceLoginRunner } from './docker-codex-device-login-runner';
import { SettingsModule } from './settings.module';
import { SettingsService } from './settings.service';

test('SettingsModule binds the runner token to the concrete Docker runner', async () => {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    SettingsModule,
  ) as unknown[];
  assert.ok(providers.includes(DockerCodexDeviceLoginRunner));
  assert.ok(
    providers.some(
      (provider) =>
        provider !== null &&
        typeof provider === 'object' &&
        'provide' in provider &&
        provider.provide === CODEX_DEVICE_LOGIN_RUNNER &&
        'useExisting' in provider &&
        provider.useExisting === DockerCodexDeviceLoginRunner,
    ),
  );

  // Compile the exact dependency trio as a smoke test so a token/class mismatch
  // fails before a real application bootstrap reaches SettingsModule.
  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: SettingsService, useValue: {} },
      DockerCodexDeviceLoginRunner,
      {
        provide: CODEX_DEVICE_LOGIN_RUNNER,
        useExisting: DockerCodexDeviceLoginRunner,
      },
      CodexDeviceLoginService,
    ],
  }).compile();
  try {
    assert.ok(moduleRef.get(CodexDeviceLoginService));
    assert.equal(
      moduleRef.get(CODEX_DEVICE_LOGIN_RUNNER),
      moduleRef.get(DockerCodexDeviceLoginRunner),
    );
  } finally {
    await moduleRef.close();
  }
});
