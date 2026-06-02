import { Module } from '@nestjs/common';
import { TerminalGateway } from './terminal.gateway';
import { WriteLockModule } from '../write-lock/write-lock.module';
import { TasksModule } from '../tasks/tasks.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';

/**
 * Realtime terminal feature module (Track 5).
 *
 * Provides the {@link TerminalGateway}, which streams a task's terminal over a
 * dual-channel WebSocket with application-layer backpressure, the ACK-based
 * pause/resume protocol, and snapshot + tail-replay reconnect.
 *
 * The gateway uses the raw `ws` adapter (not socket.io); the integration track
 * registers the `WsAdapter` in `main.ts` and imports this module into
 * `AppModule`. The integration track also wires the gateway's collaborators —
 * the {@link WriteLockModule} (lock-gated keystrokes, 7.5) and the `TasksModule`'s
 * `TaskTokenService` (runner dial-back handshake verifier, 8.2) — by importing
 * their modules here so NestJS can inject them into the gateway.
 *
 * VR.3 / VR.4: `GuardrailsModule` is imported so the gateway can inject
 * `GuardrailsService` to call `recordActivity()` from the PTY-output path and
 * `recordSuccess()` on a successful runner dial-back.
 */
@Module({
  imports: [WriteLockModule, TasksModule, GuardrailsModule],
  providers: [TerminalGateway],
  exports: [TerminalGateway],
})
export class TerminalModule {}
