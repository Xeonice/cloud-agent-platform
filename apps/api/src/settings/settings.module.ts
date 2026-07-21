import {
  MiddlewareConsumer,
  Module,
  RequestMethod,
  type NestModule,
} from '@nestjs/common';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ModelDiscoveryClient } from './model-discovery.client';
import { ClaudeCredentialProbe } from './claude-credential-probe';
import { CodexDeviceLoginService } from './codex-device-login.service';
import { ForgeCredentialService } from './forge-credential.service';
import { ForgeModule } from '../forge/forge.module';
import { CODEX_DEVICE_LOGIN_RUNNER } from './codex-device-login-runner';
import { DockerCodexDeviceLoginRunner } from './docker-codex-device-login-runner';
import { DeviceLoginNoStoreMiddleware } from './device-login-no-store.middleware';

/**
 * Account-settings feature module (account-settings, tasks 7.2–7.6).
 *
 * Wires:
 *  - {@link SettingsController} (`/settings*`, session-gated by the global
 *    `AuthGuard`);
 *  - {@link SettingsService} which composes per-account-scoped Prisma
 *    persistence with the pure logic + AES-256-GCM encryption-at-rest; and
 *  - {@link ModelDiscoveryClient}, the compatible-provider model-discovery HTTP
 *    boundary (validate a candidate before persisting).
 *
 * Imports {@link GuardrailsModule} (acyclic — precedent: `MetricsModule`) for
 * the `GuardrailsService` so a successful save of the SYSTEM-LEVEL
 * `maxConcurrentTasks` is pushed synchronously into the live concurrency
 * semaphore and takes effect without a restart (configurable-task-slots 5.3).
 *
 * Relies on the global `PrismaModule` for DB access. Registered in
 * `app.module.ts` alongside the other feature modules.
 */
@Module({
  imports: [GuardrailsModule, ForgeModule],
  controllers: [SettingsController],
  providers: [
    SettingsService,
    ModelDiscoveryClient,
    ClaudeCredentialProbe,
    DockerCodexDeviceLoginRunner,
    {
      provide: CODEX_DEVICE_LOGIN_RUNNER,
      useExisting: DockerCodexDeviceLoginRunner,
    },
    CodexDeviceLoginService,
    ForgeCredentialService,
  ],
  exports: [SettingsService, ForgeCredentialService],
})
export class SettingsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DeviceLoginNoStoreMiddleware).forRoutes(
      {
        path: 'settings/codex/device-login',
        method: RequestMethod.ALL,
      },
      {
        path: 'settings/codex/device-login/:sessionId',
        method: RequestMethod.ALL,
      },
    );
  }
}
