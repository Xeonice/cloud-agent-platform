import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ReposModule } from './repos/repos.module';
import { TasksModule } from './tasks/tasks.module';
import { TerminalModule } from './terminal/terminal.module';
import { WriteLockModule } from './write-lock/write-lock.module';
import { CredsModule } from './creds/creds.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { GuardrailsModule } from './guardrails/guardrails.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';

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
 *  - auth: `AuthModule` registers the operator-auth guard GLOBALLY on all REST
 *    endpoints (exempting `/health`), 11.2b. The refuse-to-boot check on an unset
 *    `AUTH_TOKEN` (11.3b) and CORS/WS-origin allow-listing (10.1b) live in the
 *    bootstrap (`main.ts`).
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
    AuthModule,
  ],
})
export class AppModule {}
