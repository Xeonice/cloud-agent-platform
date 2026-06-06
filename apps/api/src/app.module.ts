import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ReposModule } from './repos/repos.module';
import { TasksModule } from './tasks/tasks.module';
import { TerminalModule } from './terminal/terminal.module';
import { WriteLockModule } from './write-lock/write-lock.module';
import { CredsModule } from './creds/creds.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { GuardrailsModule } from './guardrails/guardrails.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { SettingsModule } from './settings/settings.module';

/**
 * Root application module.
 *
 * Composes the full orchestrator after integration:
 *  - data plane: `PrismaModule`, `ReposModule`, `TasksModule` (incl. per-task
 *    `TASK_TOKEN` issuance, 8.3);
 *  - realtime: `TerminalModule` (dual-channel gateway with the integration-track
 *    wiring for connect-auth 11.4, dial-back verify 8.2, keystroke gating 7.5,
 *    and approval routing 6.5) + `WriteLockModule`;
 *  - safety: `CredsModule` (global ephemeral session credentials), `SandboxModule`
 *    (the `SandboxProvider` port bound by token, 9.1b), `GuardrailsModule`
 *    (semaphore / deadline / idle / circuit-breaker wired into the lifecycle +
 *    teardown, 12.1b);
 *  - observability: `MetricsModule` exposes the session-gated `GET /metrics`
 *    composing the exact semaphore-derived capacity block with the cached
 *    sampled CPU/memory block (be-metrics 5.1–5.5);
 *  - auth: `AuthModule` registers the operator-auth guard GLOBALLY on all REST
 *    endpoints (exempting `/health`), 11.2b. The refuse-to-boot check on an unset
 *    `AUTH_TOKEN` (11.3b) and CORS/WS-origin allow-listing (10.1b) live in the
 *    bootstrap (`main.ts`).
 *  - audit/approvals: `AuditModule` (be-audit-approvals 6.2–6.5) is the single
 *    place the recorder is registered. It is `@Global()` and aliases the concrete
 *    `AuditService` under the `AUDIT_RECORDER_TOKEN`, so the lifecycle services
 *    (`TasksService`, `GuardrailsService`) pick up the best-effort recorder by
 *    token (`@Optional()`) WITHOUT importing `AuditModule` — which is what avoids
 *    the cycle `TasksModule -> AuditModule -> TerminalModule -> TasksModule`.
 *  - settings: `SettingsModule` (account-settings 7.2–7.6) exposes the session-
 *    gated `/settings*` surface, the per-account-scoped preferences + the
 *    AES-256-GCM-encrypted-at-rest compatible-provider Codex credential, and the
 *    candidate model-discovery boundary.
 */
@Module({
  imports: [
    PrismaModule,
    CredsModule,
    SandboxModule,
    HealthModule,
    ReposModule,
    TasksModule,
    WriteLockModule,
    TerminalModule,
    GuardrailsModule,
    MetricsModule,
    AuthModule,
    AuditModule,
    SettingsModule,
  ],
})
export class AppModule {}
