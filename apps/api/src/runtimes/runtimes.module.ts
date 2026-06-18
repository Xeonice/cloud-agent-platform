import { Module } from '@nestjs/common';

import { RuntimesController } from './runtimes.controller';
import { RuntimesService } from './runtimes.service';

/**
 * Runtime-readiness module (add-claude-code-runtime Track 3, task 3.3).
 *
 * Wires the operator-guarded `GET /runtimes` controller + its
 * {@link RuntimesService}, which reports per-runtime readiness as booleans ONLY,
 * backed by the deployment auth sources. The {@link ClaudeAuthSource} the service
 * injects (`CLAUDE_AUTH_SOURCE`) is bound + exported by the `@Global()`
 * `SandboxModule` (Track 2 binds the source; Track 3 exports it for `/runtimes`),
 * so this module needs no re-import to resolve it — and the injection is OPTIONAL,
 * so the endpoint still answers (reporting `claude-code` not ready) if the source
 * is not yet wired. The endpoint is auth-gated by the GLOBAL `APP_GUARD`
 * (auth.module), exactly like `/update-status` and `/metrics`.
 */
@Module({
  controllers: [RuntimesController],
  providers: [RuntimesService],
})
export class RuntimesModule {}
