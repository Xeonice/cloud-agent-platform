import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ModelDiscoveryClient } from './model-discovery.client';
import { CodexDeviceLoginService } from './codex-device-login.service';

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
 * Relies on the global `PrismaModule` for DB access. Registered in
 * `app.module.ts` alongside the other feature modules.
 */
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, ModelDiscoveryClient, CodexDeviceLoginService],
  exports: [SettingsService],
})
export class SettingsModule {}
