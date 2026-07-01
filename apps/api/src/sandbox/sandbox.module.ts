import { Global, Logger, Module } from '@nestjs/common';
import { createConfiguredSandboxProvider } from '@cap/sandbox';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox-provider.port';
import { CODEX_AUTH_SOURCE, type CodexAuthSource } from './codex-auth-source.port';
import { PrismaCodexAuthSource } from './prisma-codex-auth-source';
import { PROVISION_LOOKUP } from './provision-lookup.port';
import { PrismaProvisionLookup } from './prisma-provision-lookup';
import type {
  AuthMaterial,
  RuntimeId,
} from '../agent-runtime/agent-runtime.port';
import { ForgeModule } from '../forge/forge.module';
import type { TranscriptSource } from './transcript-source';
import type { CloneSpec, ProvisionLookup } from './provision-lookup.port';
// add-claude-code-runtime — the cross-track shared wiring file (per the tasks
// partition note): Track 2 binds the ClaudeAuthSource + the AgentRuntime registry
// here; Track 3 (this edit) EXPORTS those tokens so the `/runtimes` readiness
// endpoint (RuntimesModule) and the terminal gateway can inject them from this
// `@Global()` module without re-importing it. The registry classes
// (`AgentRuntimeRegistry`, `EnvClaudeAuthSource`) live in Track 2's module; binding
// them here keeps a single DI surface so the provider's `@Inject(RUNTIME_REGISTRY)`
// (3.1) and the gateway's optional registry (3.2) resolve the SAME instance. The
// integration registry wraps Track 2's leaf `AgentRuntimeRegistry` + the two
// concrete runtimes and adapts the leaf port to the consumer-facing shape.
import {
  RUNTIME_REGISTRY,
  IntegrationRuntimeRegistry,
  sessionIdForTask,
  type RuntimeRegistry,
} from '../agent-runtime/agent-runtime.integration';
import {
  CLAUDE_AUTH_SOURCE,
  type ClaudeAuthSource,
} from './claude-auth-source.port';
import { PrismaClaudeAuthSource } from './prisma-claude-auth-source';
import { SandboxRunOwnerService } from './sandbox-run-owner.service';
import {
  RUNTIME_MATERIAL_RESOLVER_REGISTRY,
  createDefaultRuntimeMaterialResolverRegistry,
  type RuntimeMaterialResolverRegistry,
} from './runtime-material-resolver';
import { resolveSkillInstaller } from './skill-allowlist';

const sandboxHostHarnessLogger = new Logger('SandboxHostHarness');

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
 * The exported implementation is created by the `@cap/sandbox` host harness:
 * this module provides API-local ports (lookup/runtime/material/auth/skills), but
 * provider registration and concrete backend wiring stay inside the sandbox
 * package.
 *
 * Global so any feature module that provisions execution (terminal-execution /
 * agent-events / guardrails call sites) can inject the port without re-importing
 * this module.
 */
@Global()
@Module({
  imports: [ForgeModule],
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
    SandboxRunOwnerService,
    {
      provide: SANDBOX_PROVIDER,
      useFactory: (
        ownerStore: SandboxRunOwnerService,
        runtimes: RuntimeRegistry,
        materialResolvers: RuntimeMaterialResolverRegistry,
        lookup: ProvisionLookup,
        codexAuthSource: CodexAuthSource,
      ): SandboxProvider =>
        createConfiguredSandboxProvider<
          CloneSpec,
          RuntimeId,
          TranscriptSource,
          AuthMaterial
        >({
          ownerStore,
          runtimeRegistry: runtimes,
          materialResolvers,
          provisionLookup: lookup,
          codexAuthSource,
          skillInstallers: { resolveSkillInstaller },
          sessionIdForTask,
          logger: {
            debug: (message: string) => sandboxHostHarnessLogger.debug(message),
            log: (message: string) => sandboxHostHarnessLogger.log(message),
            warn: (message: string) => sandboxHostHarnessLogger.warn(message),
          },
        }),
      inject: [
        SandboxRunOwnerService,
        RUNTIME_REGISTRY,
        RUNTIME_MATERIAL_RESOLVER_REGISTRY,
        PROVISION_LOOKUP,
        CODEX_AUTH_SOURCE,
      ],
    },
    // add-claude-code-runtime Track 2/3 + pixel-restore-console-to-od Track 3 —
    // the Claude OAuth-token source. Now SETTINGS-BACKED (`PrismaClaudeAuthSource`,
    // mirroring the CODEX_AUTH_SOURCE binding): resolves the operator's stored
    // `claude setup-token` (encrypted at rest), falling back to the
    // `CLAUDE_CODE_OAUTH_TOKEN` env (`EnvClaudeAuthSource`) when none is stored.
    // Exposes only a `configured` boolean on the readiness path — NEVER the token.
    // Consumed by the `/runtimes` readiness endpoint (3.3) and, via the runtime
    // registry, by ClaudeCodeRuntime's launch-env injection.
    {
      provide: CLAUDE_AUTH_SOURCE,
      useClass: PrismaClaudeAuthSource,
    },
    {
      provide: RUNTIME_MATERIAL_RESOLVER_REGISTRY,
      useFactory: (
        codexAuthSource: PrismaCodexAuthSource,
        claudeAuthSource: PrismaClaudeAuthSource,
      ) =>
        createDefaultRuntimeMaterialResolverRegistry({
          codexAuthSource,
          claudeAuthSource,
        }),
      inject: [CODEX_AUTH_SOURCE, CLAUDE_AUTH_SOURCE],
    },
    // add-claude-code-runtime Track 2/3 — the AgentRuntime registry that resolves a
    // task's selected runtime (`codex` | `claude-code`) to its CodexRuntime /
    // ClaudeCodeRuntime implementation. Bound here (the shared sandbox DI surface) so
    // BOTH the provider (`@Inject(RUNTIME_REGISTRY)`, 3.1) and the terminal gateway
    // (optional, 3.2) resolve the SAME instance. The registry reads each task's
    // `runtime` column (via the same Prisma surface the provision lookup uses) to
    // dispatch by task.
    {
      provide: RUNTIME_REGISTRY,
      useClass: IntegrationRuntimeRegistry,
    },
  ],
  // Track 3 — export the runtime registry + the auth-source tokens so out-of-module
  // consumers resolve them from this `@Global()` module: the gateway (TerminalModule)
  // injects RUNTIME_REGISTRY, and the `/runtimes` endpoint (RuntimesModule) injects
  // CLAUDE_AUTH_SOURCE. SANDBOX_PROVIDER stays exported as before.
  exports: [
    SANDBOX_PROVIDER,
    PROVISION_LOOKUP,
    RUNTIME_REGISTRY,
    RUNTIME_MATERIAL_RESOLVER_REGISTRY,
    CLAUDE_AUTH_SOURCE,
    CODEX_AUTH_SOURCE,
    SandboxRunOwnerService,
  ],
})
export class SandboxModule {}

/** Re-export the port token + type for consumers that inject the provider. */
export { SANDBOX_PROVIDER };
export type { SandboxProvider };
/** Re-export the runtime/claude tokens + the claude source type for consumers. */
export { RUNTIME_REGISTRY };
export { CLAUDE_AUTH_SOURCE };
export type { ClaudeAuthSource };
