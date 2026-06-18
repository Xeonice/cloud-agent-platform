import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerOptions } from './observability/logger.options';
import { PrismaModule } from './prisma/prisma.module';
import { ReposModule } from './repos/repos.module';
import { TasksModule } from './tasks/tasks.module';
import { TerminalModule } from './terminal/terminal.module';
import { WriteLockModule } from './write-lock/write-lock.module';
import { CredsModule } from './creds/creds.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { GuardrailsModule } from './guardrails/guardrails.module';
import { MetricsModule } from './metrics/metrics.module';
import { UpdateStatusModule } from './update-status/update-status.module';
import { SelfUpdateModule } from './self-update/self-update.module';
import { RuntimesModule } from './runtimes/runtimes.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { SettingsModule } from './settings/settings.module';

/**
 * Root application module.
 *
 * Composes the full orchestrator after integration:
 *  - data plane: `PrismaModule`, `ReposModule`, `TasksModule`;
 *  - realtime: `TerminalModule` (dual-channel gateway with connect-auth 11.4,
 *    keystroke gating 7.5, and approval routing 6.5 — the latter re-homed onto
 *    the `/v1/approvals` HTTP callback under connect-in) + `WriteLockModule`;
 *  - safety: `CredsModule` (global ephemeral session credentials), `SandboxModule`
 *    (the `SandboxProvider` port bound by token, 9.1b), `GuardrailsModule`
 *    (semaphore / deadline / idle / circuit-breaker wired into the lifecycle +
 *    teardown, 12.1b);
 *  - observability: `MetricsModule` exposes the session-gated `GET /metrics`
 *    composing the exact semaphore-derived capacity block with the cached
 *    sampled CPU/memory block (be-metrics 5.1–5.5); `UpdateStatusModule` exposes
 *    the operator-guarded `GET /update-status` (update-availability-check,
 *    Phase 2) — a cached, best-effort GitHub-Release comparison against the
 *    running `CAP_VERSION` that degrades honestly to `updateAvailable: false`.
 *    `SelfUpdateModule` (self-update-action, Phase 3) exposes the admin-gated,
 *    env-gated `POST /self-update` — the one-click host-root upgrade trigger.
 *    Default-OFF (`SELF_UPDATE_ENABLED` unset → the endpoint refuses) so merely
 *    composing it is INERT: no live upgrade capability exists until an operator
 *    deliberately enables it. `RuntimesModule` (add-claude-code-runtime Track 3)
 *    exposes the operator-guarded `GET /runtimes` — per-runtime readiness booleans
 *    (codex always ready; `claude-code` ready iff a Claude OAuth token is
 *    configured), backed by the deployment auth sources and leaking no secret, so
 *    the create dialog can disable an un-configured runtime before task creation;
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
    // structured-logging: pino-backed JSON stdout logging + reqId/taskId
    // correlation + secret redaction. First so it backs every other module's
    // Logger; main.ts promotes it to the app logger via `useLogger`.
    LoggerModule.forRoot(buildLoggerOptions()),
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
    UpdateStatusModule,
    SelfUpdateModule,
    RuntimesModule,
    AuthModule,
    AuditModule,
    SettingsModule,
  ],
})
export class AppModule {}
