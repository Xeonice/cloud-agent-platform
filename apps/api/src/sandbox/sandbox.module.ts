import { Global, Module } from '@nestjs/common';
import { AioSandboxProvider } from './aio-sandbox.provider';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox-provider.port';

/**
 * Sandbox-provider DI wiring (sandbox-provider-port 9.1, integration 9.1b).
 *
 * 9.1b — the orchestrator execution-provisioning call sites depend on the
 * {@link SandboxProvider} PORT, injected by the {@link SANDBOX_PROVIDER} token,
 * rather than on a concrete class. Swapping the bound implementation is then a
 * single binding change here, with NO consumer changes: every consumer asks for
 * the port by token, consumes the returned {@link SandboxConnection} handle, and
 * honours whatever `getSandboxMode()` it reports.
 *
 * The bound implementation is {@link AioSandboxProvider} — the connect-in AIO
 * Sandbox provider. Under connect-in the orchestrator is the WebSocket *client*:
 * `provision()` dockerode-creates a per-task `cap-aio-<taskId>` container on the
 * private `cap-net` network (no host port) and returns a `SandboxConnection`
 * handle the gateway dials by container name to open the sandbox terminal WS —
 * there is no dial-back to authenticate. A future OS-isolating implementation can
 * replace this binding by satisfying the same port, with no consumer changes.
 *
 * Global so any feature module that provisions execution (terminal-execution /
 * agent-events / guardrails call sites) can inject the port without re-importing
 * this module.
 */
@Global()
@Module({
  providers: [
    {
      provide: SANDBOX_PROVIDER,
      useClass: AioSandboxProvider,
    },
  ],
  exports: [SANDBOX_PROVIDER],
})
export class SandboxModule {}

/** Re-export the port token + type for consumers that inject the provider. */
export { SANDBOX_PROVIDER };
export type { SandboxProvider };
