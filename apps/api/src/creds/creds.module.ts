import { Global, Module } from '@nestjs/common';
import { SessionCredentialsService } from './session-credentials.service';

/**
 * Global module exposing the ephemeral {@link SessionCredentialsService} to the
 * whole application (track runner-dialback-and-creds, 8.4).
 *
 * It is global because the session-end teardown call sites that destroy
 * credentials live in the tasks lifecycle and guardrails paths (wired in track
 * 14), and those feature modules inject the provider without re-importing it.
 */
@Global()
@Module({
  providers: [SessionCredentialsService],
  exports: [SessionCredentialsService],
})
export class CredsModule {}
