import { Module } from '@nestjs/common';
import { TerminalGateway } from './terminal.gateway';
import { ApprovalsController } from './approvals.controller';
import { WriteLockModule } from '../write-lock/write-lock.module';
import { TasksModule } from '../tasks/tasks.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { AuthModule } from '../auth/auth.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TERMINAL_GATEWAY_TOKEN } from '../guardrails/guardrails.service';
import {
  SandboxApprovalEnforcer,
  type ApprovalRouter,
} from '../sandbox/sandbox-approval-enforcer';
import { ProviderTerminalStoryController } from './provider-terminal-story.controller';
import { ProviderTerminalStoryService } from './provider-terminal-story.service';
import { TerminalDiagnosticsMetricsModule } from '../metrics/terminal-diagnostics-metrics.module';

/**
 * DI token for a dormant fail-closed approval primitive. There is currently no
 * production `enforce`/`enforceThen` call site; registration MUST NOT be treated
 * as coverage of provider exec or interactive PTY activity.
 */
export const SANDBOX_APPROVAL_ENFORCER = Symbol('SandboxApprovalEnforcer');

/**
 * Realtime terminal feature module.
 *
 * Provides the {@link TerminalGateway}, which streams a task's terminal over a
 * dual-channel WebSocket with one fresh native viewer attachment per socket,
 * application-layer backpressure, and the ACK-based pause/resume protocol.
 *
 * The gateway uses the raw `ws` adapter (not socket.io); the integration track
 * registers the `WsAdapter` in `main.ts` and imports this module into
 * `AppModule`. It wires the gateway's collaborators — the {@link WriteLockModule}
 * (lock-gated keystrokes, 7.5) and the `GuardrailsModule`'s `GuardrailsService`
 * (idle-tracker activity + exit-outcome mapping) — by importing their modules
 * here so NestJS can inject them into the gateway.
 *
 * Under the connect-in model the orchestrator dials each per-task AIO sandbox by
 * container name on `cap-net`; there is no inbound runner dial-back, so the
 * `TasksModule` per-task `TASK_TOKEN` handshake verifier was removed (migrate-aio
 * 7.4). `TasksModule` is still imported for the lifecycle surface the gateway
 * shares with the rest of the app.
 *
 * {@link ApprovalsController} remains registered as an isolated compatibility
 * callback with its private-peer checks. Current bypass-mode images do not bake
 * or register a Codex hook that calls it.
 *
 * VR.3: `GuardrailsModule` is imported so the gateway can inject
 * `GuardrailsService` to call `recordActivity()` from the PTY-output path and
 * map a resolved sandbox exit status to `recordSuccess`/`recordFailure`.
 *
 * 4.2: the gateway is ALSO re-provided under `TERMINAL_GATEWAY_TOKEN` so
 * `GuardrailsService` can resolve it LAZILY by token (via `ModuleRef`) and hand
 * the provisioned `SandboxConnection` to `openSession()` — without a value
 * import of the gateway, which would re-form the `GuardrailsModule <->
 * TerminalModule` cycle.
 *
 * `AuthModule` is imported so the gateway can inject the exported
 * {@link AuthSessionService} and authenticate the operator's SESSION at connect
 * time (resolving the connect query param or `bearer.<token>` subprotocol),
 * closing unauthenticated/expired/revoked/disabled connections before they join
 * any task stream.
 */
@Module({
  imports: [
    WriteLockModule,
    TasksModule,
    GuardrailsModule,
    AuthModule,
    SandboxModule,
    TerminalDiagnosticsMetricsModule,
  ],
  controllers: [ApprovalsController, ProviderTerminalStoryController],
  providers: [
    TerminalGateway,
    ProviderTerminalStoryService,
    // Re-provide the gateway under the neutral token GuardrailsService resolves
    // by, so the guardrails->gateway `openSession` seam (4.2) needs no value
    // import of the concrete gateway class.
    { provide: TERMINAL_GATEWAY_TOKEN, useExisting: TerminalGateway },
    // Dormant compatibility binding. A future CAP-brokered action may inject this
    // token and MUST wrap the action with `enforceThen`; no production call site
    // does so today. Co-located here to avoid a provider->gateway module cycle.
    {
      provide: SANDBOX_APPROVAL_ENFORCER,
      useFactory: (gateway: ApprovalRouter): SandboxApprovalEnforcer =>
        new SandboxApprovalEnforcer(gateway),
      inject: [TerminalGateway],
    },
  ],
  exports: [TerminalGateway, SANDBOX_APPROVAL_ENFORCER, ProviderTerminalStoryService],
})
export class TerminalModule {}
