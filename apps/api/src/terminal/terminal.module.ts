import { Module } from '@nestjs/common';
import { TerminalGateway } from './terminal.gateway';
import { WriteLockModule } from '../write-lock/write-lock.module';
import { TasksModule } from '../tasks/tasks.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { AuthModule } from '../auth/auth.module';

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
 *
 * be-oauth-allowlist 2.7: `AuthModule` is imported so the gateway can inject
 * the exported {@link AuthSessionService} and authenticate the operator's
 * GitHub-OAuth SESSION at connect time (resolving the connect query param or
 * `bearer.<token>` subprotocol), closing unauthenticated/expired/revoked/
 * non-allowlisted connections before they join any task stream.
 */
@Module({
  imports: [WriteLockModule, TasksModule, GuardrailsModule, AuthModule],
  providers: [TerminalGateway],
  exports: [TerminalGateway],
})
export class TerminalModule {}
