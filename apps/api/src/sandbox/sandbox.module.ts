import { Global, Module } from '@nestjs/common';
import { DockerSandboxProvider } from './docker-sandbox.provider';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox-provider.port';

/**
 * Sandbox-provider DI wiring (sandbox-provider-port 9.1, integration 9.1b).
 *
 * 9.1b — the orchestrator/runner execution-provisioning call sites depend on the
 * {@link SandboxProvider} PORT, injected by the {@link SANDBOX_PROVIDER} token,
 * rather than on the concrete {@link DockerSandboxProvider}. Swapping in a future
 * OS-isolating implementation is then a single binding change here, with NO
 * consumer changes: every consumer asks for the port by token and honours
 * whatever `getSandboxMode()` it reports.
 *
 * Global so any feature module that provisions execution (terminal-execution /
 * agent-events / runner-dialback / guardrails call sites) can inject the port
 * without re-importing this module.
 */
@Global()
@Module({
  providers: [
    {
      provide: SANDBOX_PROVIDER,
      useClass: DockerSandboxProvider,
    },
  ],
  exports: [SANDBOX_PROVIDER],
})
export class SandboxModule {}

/** Re-export the port token + type for consumers that inject the provider. */
export { SANDBOX_PROVIDER };
export type { SandboxProvider };
