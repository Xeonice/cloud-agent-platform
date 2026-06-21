import { Module } from '@nestjs/common';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ModelDiscoveryClient } from './model-discovery.client';
import { CodexDeviceLoginService } from './codex-device-login.service';
import { ForgeCredentialService } from './forge-credential.service';
import { ForgeModule } from '../forge/forge.module';

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
    CodexDeviceLoginService,
    ForgeCredentialService,
  ],
  exports: [SettingsService, ForgeCredentialService],
})
export class SettingsModule {}
