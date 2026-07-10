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

/**
 * DI token for the cap-controlled approval enforcement FALLBACK (6.9). Cap-owned
 * tool-affecting call sites at the `/v1/shell/exec` boundary inject this to gate
 * a command through the existing approval round-trip BEFORE running it, so a
 * non-firing codex hook (codex#16732) cannot let a gated tool call proceed
 * unapproved.
 */
export const SANDBOX_APPROVAL_ENFORCER = Symbol('SandboxApprovalEnforcer');

/**
 * Realtime terminal feature module.
 *
 * Provides the {@link TerminalGateway}, which streams a task's terminal over a
 * dual-channel WebSocket with application-layer backpressure, the ACK-based
 * pause/resume protocol, and snapshot + tail-replay reconnect.
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
 * 5.5: {@link ApprovalsController} is registered here so the sandbox's Codex
 * hooks can call BACK IN over `cap-net` (an OUTBOUND HTTP POST to
 * `/internal/sandbox/approvals`)
 * and have the approval round-trip routed through the gateway's existing
 * `onPermissionRequest` -> operator decision -> `onDecision` logic (transport-only
 * change; approval semantics unchanged).
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
  imports: [WriteLockModule, TasksModule, GuardrailsModule, AuthModule, SandboxModule],
  controllers: [ApprovalsController, ProviderTerminalStoryController],
  providers: [
    TerminalGateway,
    ProviderTerminalStoryService,
    // Re-provide the gateway under the neutral token GuardrailsService resolves
    // by, so the guardrails->gateway `openSession` seam (4.2) needs no value
    // import of the concrete gateway class.
    { provide: TERMINAL_GATEWAY_TOKEN, useExisting: TerminalGateway },
    // 6.9 — the cap-controlled approval enforcement FALLBACK. Bound to the
    // gateway as its ApprovalRouter so it routes a gate through the SAME
    // `requestApproval` -> operator decision path the codex-hook callback uses;
    // only the TRIGGER differs (cap-initiated at the exec boundary). Co-located
    // here (not in SandboxModule) so the provider->gateway approval dependency
    // does not re-form a module cycle. Cap-owned `/v1/shell/exec` call sites
    // inject {@link SANDBOX_APPROVAL_ENFORCER} and `enforceThen(...)` before running
    // a gated command, so approval never depends solely on codex firing a hook.
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
