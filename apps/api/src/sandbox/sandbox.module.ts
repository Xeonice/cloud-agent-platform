import { Global, Module } from '@nestjs/common';
import {
  SandboxProviderRouter,
  defineHttpCloudSandboxProvider,
  defineBoxLiteSandboxProvider,
  defineLocalSandboxProvider,
  readBoxLiteProviderConfig,
  type RoutableSandboxProvider,
  type SandboxProviderDescriptor,
} from '@cap/sandbox';
import { AioSandboxProvider } from './aio-sandbox.provider';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox-provider.port';
import { CODEX_AUTH_SOURCE } from './codex-auth-source.port';
import { PrismaCodexAuthSource } from './prisma-codex-auth-source';
import { PROVISION_LOOKUP } from './provision-lookup.port';
import { PrismaProvisionLookup } from './prisma-provision-lookup';
import type { RuntimeId } from '../agent-runtime/agent-runtime.port';
import { ForgeModule } from '../forge/forge.module';
import type { TranscriptSource } from './transcript-source';
import type { CloneSpec } from './provision-lookup.port';
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
} from '../agent-runtime/agent-runtime.integration';
import {
  CLAUDE_AUTH_SOURCE,
  type ClaudeAuthSource,
} from './claude-auth-source.port';
import { PrismaClaudeAuthSource } from './prisma-claude-auth-source';
import {
  DEFAULT_CLOUD_HTTP_CAPABILITIES,
  readNumberEnv,
  readOptionalEnv,
  readSandboxLocationEnv,
  readSandboxProviderCapabilitiesEnv,
} from './sandbox-provider-config';
import { SandboxRunOwnerService } from './sandbox-run-owner.service';
import {
  RUNTIME_MATERIAL_RESOLVER_REGISTRY,
  createDefaultRuntimeMaterialResolverRegistry,
} from './runtime-material-resolver';

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
 * The exported implementation is a {@link SandboxProviderRouter}: a single
 * provider-shaped facade over local/cloud candidates. Local AIO is always
 * registered; the HTTP cloud provider is registered when
 * `CAP_SANDBOX_CLOUD_HTTP_BASE_URL` is configured. Consumers still inject one
 * port and remain unaware of the chosen backend.
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
    AioSandboxProvider,
    SandboxRunOwnerService,
    {
      provide: SANDBOX_PROVIDER,
      useFactory: (
        aio: AioSandboxProvider,
        ownerStore: SandboxRunOwnerService,
      ): SandboxProvider => buildConfiguredSandboxProvider(aio, ownerStore),
      inject: [AioSandboxProvider, SandboxRunOwnerService],
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

type ApiRoutableSandboxProvider = RoutableSandboxProvider<
  CloneSpec,
  RuntimeId,
  TranscriptSource
>;

function buildConfiguredSandboxProvider(
  aio: AioSandboxProvider,
  ownerStore: SandboxRunOwnerService,
): SandboxProvider {
  const providers: SandboxProviderDescriptor<ApiRoutableSandboxProvider>[] = [
    defineLocalSandboxProvider({
      id: 'aio-local',
      provider: aio,
      priority: readNumberEnv('CAP_SANDBOX_LOCAL_PRIORITY', 10),
    }),
  ];

  const cloudBaseUrl = readOptionalEnv('CAP_SANDBOX_CLOUD_HTTP_BASE_URL');
  if (cloudBaseUrl) {
    providers.push(
      defineHttpCloudSandboxProvider<CloneSpec, RuntimeId, TranscriptSource>({
        id: readOptionalEnv('CAP_SANDBOX_CLOUD_HTTP_ID') ?? 'cloud-http',
        baseUrl: cloudBaseUrl,
        apiToken: readOptionalEnv('CAP_SANDBOX_CLOUD_HTTP_TOKEN'),
        capabilities: readSandboxProviderCapabilitiesEnv(
          'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
          DEFAULT_CLOUD_HTTP_CAPABILITIES,
        ),
        priority: readNumberEnv('CAP_SANDBOX_CLOUD_HTTP_PRIORITY', 50),
      }),
    );
  }

  const boxlite = readBoxLiteProviderConfig();
  if (boxlite.status === 'valid') {
    providers.push(
      defineBoxLiteSandboxProvider<CloneSpec, RuntimeId, TranscriptSource>({
        config: boxlite.config,
      }),
    );
  }

  return new SandboxProviderRouter<CloneSpec, RuntimeId, TranscriptSource>(
    providers,
    {
      preferLocation: readSandboxLocationEnv('CAP_SANDBOX_PREFER_LOCATION'),
      ownerStore,
    },
  );
}
