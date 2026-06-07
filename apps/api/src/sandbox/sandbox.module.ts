import { Global, Module } from '@nestjs/common';
import { AioSandboxProvider } from './aio-sandbox.provider';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox-provider.port';
import { CODEX_AUTH_SOURCE } from './codex-auth-source.port';
import { PrismaCodexAuthSource } from './prisma-codex-auth-source';
import { PROVISION_LOOKUP } from './provision-lookup.port';
import { PrismaProvisionLookup } from './prisma-provision-lookup';

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
    // Settings-backed codex auth source the provider injects into each sandbox:
    // resolves the OFFICIAL ChatGPT login the operator connected via the Settings
    // page (encrypted at rest), falling back to the legacy deployment env var
    // (CODEX_CHATGPT_AUTH_JSON_B64) when none is stored. Bound by token so the
    // provider stays a pure port consumer.
    {
      provide: CODEX_AUTH_SOURCE,
      useClass: PrismaCodexAuthSource,
    },
    // Prisma-backed per-task clone-URL lookup (task → repo.gitSource + operator
    // token). Behind a token so the provider never depends on PrismaService.
    {
      provide: PROVISION_LOOKUP,
      useClass: PrismaProvisionLookup,
    },
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
